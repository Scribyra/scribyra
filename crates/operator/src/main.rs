use scribyra_operator::{Settings, leader, manifests, metrics::Metrics, tls, versions};
use std::process::ExitCode;
use std::sync::Arc;

const USAGE: &str = "usage: scribyra-operator run | crd | manifests [--namespace NS] [--image IMAGE] [--registry REGISTRY] | tls-proxy --cert FILE --key FILE --route LISTEN=UPSTREAM...";

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}
fn env(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.into())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("crd") => {
            print!("{}", manifests::yaml(&[manifests::crd()]));
            ExitCode::SUCCESS
        }
        Some("manifests") => {
            let install = manifests::Install {
                namespace: flag(&args, "--namespace").unwrap_or_else(|| manifests::DEFAULT_NAMESPACE.into()),
                image: flag(&args, "--image").unwrap_or_else(|| format!("ghcr.io/scribyra/scribyra-operator:{}", env!("CARGO_PKG_VERSION"))),
                registry: flag(&args, "--registry").unwrap_or_else(|| "ghcr.io/scribyra".into()),
            };
            print!("{}", manifests::yaml(&manifests::objects(&install)));
            ExitCode::SUCCESS
        }
        Some("tls-proxy") => {
            init_logs();
            let (Some(cert), Some(key)) = (flag(&args, "--cert"), flag(&args, "--key")) else {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            };
            let routes: Vec<(String, String)> = args.windows(2).filter(|w| w[0] == "--route").filter_map(|w| w[1].split_once('=').map(|(a, b)| (a.into(), b.into()))).collect();
            if routes.is_empty() {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
            let (Ok(cert), Ok(key)) = (std::fs::read(cert), std::fs::read(key)) else {
                tracing::error!("cannot read the certificate or key");
                return ExitCode::FAILURE;
            };
            let rt = tokio::runtime::Runtime::new().unwrap();
            match rt.block_on(tls::proxy(routes, &cert, &key)) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    tracing::error!(%error, "tls proxy");
                    ExitCode::FAILURE
                }
            }
        }
        Some("run") | None => {
            init_logs();
            tokio::runtime::Runtime::new().unwrap().block_on(run())
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn init_logs() {
    tracing_subscriber::fmt().json().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).with_current_span(false).init();
}

async fn run() -> ExitCode {
    let client = match kube::Client::try_default().await {
        Ok(c) => c,
        Err(error) => {
            tracing::error!(%error, "no Kubernetes client configuration");
            return ExitCode::FAILURE;
        }
    };
    let namespace = env("POD_NAMESPACE", manifests::DEFAULT_NAMESPACE);
    let identity = env("POD_NAME", &format!("scribyra-operator-{}", std::process::id()));
    let metrics = Arc::new(Metrics::default());
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], manifests::METRICS_PORT));
    tokio::spawn(scribyra_operator::metrics::serve(metrics.clone(), addr));
    let elector = leader::Elector::new(client.clone(), &namespace, manifests::LEASE, &identity);
    tracing::info!(%identity, "waiting for the leader lease");
    elector.acquire().await;
    metrics.set_leader(true);
    tracing::info!(%identity, "leading");
    let settings = Settings {
        registry: env("SCRIBYRA_OPERATOR_REGISTRY", "ghcr.io/scribyra"),
        operator_image: env("SCRIBYRA_OPERATOR_IMAGE", "ghcr.io/scribyra/scribyra-operator:latest"),
        operator_namespace: namespace,
        watch_namespace: std::env::var("WATCH_NAMESPACE").ok().filter(|v| !v.is_empty()),
        releases: versions::known(),
        garage_admin_url: Settings::garage_admin_url_default(),
        api_metrics_url: Settings::api_metrics_url_default(),
        identity,
    };
    tokio::select! {
        _ = scribyra_operator::run_controller(client, settings, metrics.clone()) => {
            tracing::info!("controller stopped");
            ExitCode::SUCCESS
        }
        _ = elector.hold() => {
            tracing::error!("lost the leader lease; exiting");
            metrics.set_leader(false);
            ExitCode::FAILURE
        }
    }
}

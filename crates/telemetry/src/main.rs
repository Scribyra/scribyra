use scribyra_telemetry::server::{Config, Ingress};
#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), &'static str> {
    if std::env::args().nth(1).as_deref() == Some("validate-run") {
        use std::io::Read;
        let mut input = Vec::new();
        std::io::stdin()
            .take((scribyra_core::telemetry::transport::runs::MAX_RUN_BYTES + 1) as u64)
            .read_to_end(&mut input)
            .map_err(|_| "Cannot read run evidence")?;
        let run = scribyra_core::telemetry::transport::runs::Run::parse(
            &input,
            scribyra_telemetry::server::unix_ms(),
        )?;
        println!(
            "{}",
            serde_json::to_string(&run).map_err(|_| "Cannot encode run evidence")?
        );
        return Ok(());
    }
    let alloy =
        std::env::var("SCRIBYRA_ALLOY_URL").unwrap_or_else(|_| "http://127.0.0.1:4318".into());
    let browser = std::env::var("SCRIBYRA_BROWSER_INGESTION").as_deref() == Ok("1");
    let allowed = std::env::var("SCRIBYRA_ALLOWED_ORIGINS");
    if browser && allowed.is_err() {
        return Err("Set explicit SCRIBYRA_ALLOWED_ORIGINS for browser ingestion");
    }
    let origins = allowed
        .unwrap_or_else(|_| "http://127.0.0.1:4173".into())
        .split(',')
        .map(|s| s.trim().to_owned())
        .collect();
    let config = if let Some(file) = std::env::var_os("SCRIBYRA_INGRESS_TOKEN_FILE") {
        let token = std::fs::read_to_string(file).map_err(|_| "Cannot read ingress token file")?;
        let config = Config::new(&alloy, origins, token.trim())?;
        if browser {
            config.with_browser_ingestion()
        } else {
            config
        }
    } else if browser {
        Config::browser(&alloy, origins)?
    } else {
        return Err("Set SCRIBYRA_INGRESS_TOKEN_FILE or SCRIBYRA_BROWSER_INGESTION=1");
    };
    let app = Ingress::new(config);
    let bind = std::env::var("SCRIBYRA_TELEMETRY_BIND").unwrap_or_else(|_| "127.0.0.1:8789".into());
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|_| "Cannot bind ingress listener")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Cannot read ingress address")?;
    println!(
        "{}",
        serde_json::json!({"event":"ready","url":format!("http://{address}")})
    );
    axum::serve(listener, app.router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|_| "Ingress server failed")?;
    Ok(())
}

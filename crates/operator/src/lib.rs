//! `scribyra-operator`: deploys Scribyra organisation deployments on Kubernetes from
//! `Scribyra` resources (`scribyra.com/v1alpha1`). See `docs/operator.md`.
pub mod controller;
pub mod crd;
pub mod garage;
pub mod leader;
pub mod manifests;
pub mod metrics;
pub mod resources;
pub mod service_config;
pub mod tls;
pub mod versions;

use std::sync::Arc;

/// Settings for [`run_controller`].
pub struct Settings {
    pub registry: String,
    pub operator_image: String,
    pub operator_namespace: String,
    /// Watch one namespace instead of the whole cluster.
    pub watch_namespace: Option<String>,
    pub releases: Vec<versions::Release>,
    pub garage_admin_url: String,
    pub api_metrics_url: String,
    pub identity: String,
}
impl Settings {
    pub fn garage_admin_url_default() -> String {
        format!("https://{{name}}-garage.{{namespace}}.svc:{}", service_config::GARAGE_ADMIN_PORT)
    }
    pub fn api_metrics_url_default() -> String {
        format!("http://{{name}}-api.{{namespace}}.svc:{}{}", scribyra_sync::deploy::METRICS_PORT, scribyra_sync::deploy::METRICS_PATH)
    }
}

/// Run the controller until shutdown (no leader election; see `main.rs`).
pub async fn run_controller(client: kube::Client, settings: Settings, metrics: Arc<metrics::Metrics>) {
    use futures::StreamExt;
    use k8s_openapi::api::{apps::v1::{Deployment, StatefulSet}, batch::v1::Job};
    use kube::runtime::{Controller, watcher};
    let reporter = kube::runtime::events::Reporter { controller: manifests::NAME.into(), instance: Some(settings.identity.clone()) };
    let ctx = Arc::new(controller::Context {
        client: client.clone(),
        registry: settings.registry,
        operator_image: settings.operator_image,
        operator_namespace: settings.operator_namespace,
        releases: settings.releases,
        recorder: kube::runtime::events::Recorder::new(client.clone(), reporter),
        metrics,
        garage_admin_url: settings.garage_admin_url,
        api_metrics_url: settings.api_metrics_url,
        capabilities: tokio::sync::Mutex::new(None),
    });
    let owned = watcher::Config::default().labels(&format!("app.kubernetes.io/managed-by={}", resources::MANAGED_BY));
    macro_rules! api {
        ($t:ty) => {
            match &settings.watch_namespace {
                Some(ns) => kube::Api::<$t>::namespaced(client.clone(), ns),
                None => kube::Api::<$t>::all(client.clone()),
            }
        };
    }
    Controller::new(api!(crd::Scribyra), watcher::Config::default())
        .owns(api!(Deployment), owned.clone())
        .owns(api!(StatefulSet), owned.clone())
        .owns(api!(Job), owned)
        .shutdown_on_signal()
        .run(controller::reconcile, controller::error_policy, ctx)
        .for_each(|result| async move {
            if let Err(error) = result {
                tracing::debug!(%error, "reconcile");
            }
        })
        .await;
}

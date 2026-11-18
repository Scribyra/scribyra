//! The deployment contract between `scribyra-sync` and the Kubernetes operator
//! (`crates/operator`): where the operator mounts the configuration and each secret, which
//! commands and ports the image offers, and the names of the metrics it scales on.
//!
//! The configuration keys themselves are the fields of [`crate::config::Config`] (documented
//! in `docs/service.md`); the operator serialises [`crate::config::Deployment`] directly. Only
//! what `docs/service.md` did not yet define lives here, so both sides use one definition.
//! Items marked *not yet served* are names the operator already relies on before the service
//! implements them (design section 10); the operator tolerates their absence.

/// Environment variable naming the configuration file (documented in `docs/service.md`).
pub const CONFIG_ENV: &str = "SCRIBYRA_SERVICE_CONFIG";
/// Prefix of the per-field overrides (`SCRIBYRA_SERVICE_<UPPERCASE_FIELD>`).
pub const OVERRIDE_PREFIX: &str = "SCRIBYRA_SERVICE_";
/// Directory of the generated configuration (a Secret, mounted read-only).
pub const CONFIG_DIR: &str = "/etc/scribyra/config";
/// Key of the generated configuration in its Secret, and its file name in [`CONFIG_DIR`].
pub const CONFIG_KEY: &str = "service.json";
/// The configuration file inside a pod.
pub const CONFIG_FILE: &str = "/etc/scribyra/config/service.json";
/// Directory where each referenced secret is mounted as its own read-only file.
pub const SECRETS_DIR: &str = "/etc/scribyra/secrets";
/// `database_url_file` inside a pod.
pub const DATABASE_URL_FILE: &str = "/etc/scribyra/secrets/database-url";
/// `s3_secret_access_key_file` inside a pod.
pub const S3_SECRET_ACCESS_KEY_FILE: &str = "/etc/scribyra/secrets/s3-secret-access-key";
/// `service_key_file` (the deployment's master key) inside a pod.
pub const MASTER_KEY_FILE: &str = "/etc/scribyra/secrets/master-key";
/// The S3 access key ID is not a secret file in the configuration but a plain field; the
/// operator sets it through this override, from the referenced Secret, so it never has to read
/// the Secret itself.
pub const S3_ACCESS_KEY_ID_ENV: &str = "SCRIBYRA_SERVICE_S3_ACCESS_KEY_ID";
/// `deployment.providers[].client_secret_file` for the provider `id` inside a pod.
pub fn provider_secret_file(id: &str) -> String {
    format!("{SECRETS_DIR}/oidc-{id}")
}

/// The HTTP listener (`bind`), API and sync.
pub const HTTP_PORT: u16 = 8787;
/// Liveness: answers while the process runs.
pub const HEALTH_PATH: &str = "/health";
/// Readiness: database, ownership and blob store reachable.
pub const READY_PATH: &str = "/ready";
/// Every API route is under this prefix; anything else on the deployment's domain is the
/// static web app.
pub const API_PREFIX: &str = "/v1";
/// Prometheus metrics on a separate port (*not yet served*, design section 10).
pub const METRICS_PORT: u16 = 9090;
pub const METRICS_PATH: &str = "/metrics";
/// Gauge of queued plus running server compiles (*not yet served*; slice 15).
pub const COMPILE_QUEUE_METRIC: &str = "scribyra_compile_queue_length";

/// `scribyra-sync serve`: the API and sync.
pub const COMMAND_SERVE: &str = "serve";
/// `scribyra-sync migrate`: apply pending migrations and exit (the operator's upgrade Job).
pub const COMMAND_MIGRATE: &str = "migrate";
/// `scribyra-sync compile-worker` (*not yet served*; slice 15).
pub const COMMAND_COMPILE_WORKER: &str = "compile-worker";

/// Where the compile worker image keeps its TeX Live tree (`deployment.texlive`); the worker
/// image is built per TeX Live variant (*not yet built*; slice 15).
pub const TEXLIVE_DIR: &str = "/opt/texlive";

/// The user and group the images run as.
pub const RUN_AS: i64 = 10001;

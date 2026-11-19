//! Reconciliation of `Scribyra` resources.
//!
//! One pass: check the spec with the service's own validation, make the generated secrets,
//! decide which release runs (refusing downgrades, unknown releases and skipped steps), apply
//! every owned object with server-side apply, wait for the database and storage, run the
//! migration Job of a new release to completion before any Deployment uses it, scale the compile
//! workers, prune objects that are no longer wanted, and report conditions. Deletion goes
//! through a finalizer that removes data only under `deletionPolicy: Delete`.

use crate::crd::{DeletionPolicy, Encryption, Scaler, Scribyra, ScribyraStatus, WorkerStatus};
use crate::resources::{self, Capabilities, Env, INSTANCE_LABEL, MANAGED_BY, Object, Plan};
use crate::versions::{self, Decision, Release};
use crate::{garage, metrics::Metrics, service_config};
use k8s_openapi::ByteString;
use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Pod, Secret};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{Condition, Time};
use kube::api::{Api, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams};
use kube::core::{ApiResource, GroupVersionKind};
use kube::runtime::controller::Action;
use kube::runtime::events::{Event, EventType, Recorder};
use kube::runtime::finalizer::{Event as Finalized, finalizer};
use kube::{Client, Resource, ResourceExt};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub const FIELD_MANAGER: &str = "scribyra-operator";
pub const FINALIZER: &str = "scribyra.com/cleanup";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("kubernetes: {0}")]
    Kube(#[from] kube::Error),
    #[error("finalizer: {0}")]
    Finalizer(#[source] Box<kube::runtime::finalizer::Error<Error>>),
    #[error("{0}")]
    Other(String),
}
pub type Result<T, E = Error> = std::result::Result<T, E>;

pub struct Context {
    pub client: Client,
    pub registry: String,
    pub operator_image: String,
    pub operator_namespace: String,
    pub releases: Vec<Release>,
    pub recorder: Recorder,
    pub metrics: Arc<Metrics>,
    /// Garage admin URL template (`{name}`, `{namespace}`); tests point it at a local Garage.
    pub garage_admin_url: String,
    /// Metrics URL template of the API the scaler reads.
    pub api_metrics_url: String,
    pub capabilities: Mutex<Option<(Instant, Capabilities)>>,
}
impl Context {
    async fn capabilities(&self) -> Capabilities {
        let mut cached = self.capabilities.lock().await;
        if let Some((at, caps)) = *cached
            && at.elapsed() < Duration::from_secs(60)
        {
            return caps;
        }
        let caps = discover(&self.client).await.unwrap_or_default();
        *cached = Some((Instant::now(), caps));
        caps
    }
}

/// Which optional APIs the cluster serves.
pub async fn discover(client: &Client) -> Result<Capabilities> {
    let groups = client.list_api_groups().await?;
    let has = |group: &str, version: &str| groups.groups.iter().any(|g| g.name == group && g.versions.iter().any(|v| v.version == version));
    Ok(Capabilities {
        cnpg: has("postgresql.cnpg.io", "v1"),
        keda: has("keda.sh", "v1alpha1"),
        gateway: has("gateway.networking.k8s.io", "v1"),
        cert_manager: has("cert-manager.io", "v1"),
    })
}

fn api_resource(api_version: &str, kind: &str) -> ApiResource {
    let (group, version) = api_version.rsplit_once('/').unwrap_or(("", api_version));
    ApiResource::from_gvk(&GroupVersionKind::gvk(group, version, kind))
}
fn dynamic_api(client: &Client, ns: &str, api_version: &str, kind: &str) -> Api<DynamicObject> {
    Api::namespaced_with(client.clone(), ns, &api_resource(api_version, kind))
}

/// Server-side apply of one generated object.
pub async fn apply(client: &Client, ns: &str, object: &Object) -> Result<DynamicObject> {
    let api = dynamic_api(client, ns, object.api_version(), object.kind());
    let mut value = object.value.clone();
    // `stringData` is write-only and would make every apply a change; send `data` instead.
    if let Some(strings) = value.as_object_mut().and_then(|o| o.remove("stringData")) {
        use base64::Engine;
        let data: serde_json::Map<String, serde_json::Value> = strings.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), base64::engine::general_purpose::STANDARD.encode(v.as_str().unwrap_or_default()).into())).collect();
        value["data"] = data.into();
    }
    Ok(api.patch(object.name(), &PatchParams::apply(FIELD_MANAGER).force(), &Patch::Apply(&value)).await?)
}

async fn get_opt<K>(api: &Api<K>, name: &str) -> Result<Option<K>>
where
    K: Clone + serde::de::DeserializeOwned + std::fmt::Debug,
{
    Ok(api.get_opt(name).await?)
}

pub async fn reconcile(cr: Arc<Scribyra>, ctx: Arc<Context>) -> Result<Action> {
    let started = Instant::now();
    let api: Api<Scribyra> = Api::namespaced(ctx.client.clone(), cr.namespace());
    let result = finalizer(&api, FINALIZER, cr, |event| async {
        match event {
            Finalized::Apply(cr) => apply_instance(&cr, &ctx).await,
            Finalized::Cleanup(cr) => cleanup(&cr, &ctx).await,
        }
    })
    .await
    .map_err(|e| Error::Finalizer(Box::new(e)));
    ctx.metrics.reconciled(result.is_ok(), started.elapsed());
    result
}

pub fn error_policy(cr: Arc<Scribyra>, error: &Error, ctx: Arc<Context>) -> Action {
    tracing::warn!(name = %cr.name_any(), namespace = %cr.namespace(), %error, "reconcile failed");
    let _ = ctx;
    Action::requeue(Duration::from_secs(30))
}

/// Conditions being built for this pass.
struct Conditions {
    generation: Option<i64>,
    old: Vec<Condition>,
    new: BTreeMap<&'static str, (bool, String, String)>,
}
impl Conditions {
    fn set(&mut self, kind: &'static str, status: bool, reason: &str, message: impl Into<String>) {
        self.new.insert(kind, (status, reason.into(), message.into()));
    }
    fn is(&self, kind: &str) -> bool {
        self.new.get(kind).is_some_and(|c| c.0)
    }
    fn build(&self) -> Vec<Condition> {
        let now = Time(jiff_now());
        self.new
            .iter()
            .map(|(kind, (status, reason, message))| {
                let status = if *status { "True" } else { "False" }.to_string();
                let previous = self.old.iter().find(|c| c.type_ == *kind);
                Condition {
                    type_: kind.to_string(),
                    last_transition_time: previous.filter(|p| p.status == status).map(|p| p.last_transition_time.clone()).unwrap_or_else(|| now.clone()),
                    status,
                    reason: reason.clone(),
                    message: message.clone(),
                    observed_generation: self.generation,
                }
            })
            .collect()
    }
}
fn jiff_now() -> k8s_openapi::jiff::Timestamp {
    k8s_openapi::jiff::Timestamp::now()
}

async fn publish(ctx: &Context, cr: &Scribyra, warning: bool, reason: &str, note: String) {
    let event = Event { type_: if warning { EventType::Warning } else { EventType::Normal }, reason: reason.into(), note: Some(note), action: "Reconcile".into(), secondary: None };
    if let Err(error) = ctx.recorder.publish(&event, &cr.object_ref(&())).await {
        tracing::debug!(%error, "event not published");
    }
}

async fn write_status(ctx: &Context, cr: &Scribyra, status: &ScribyraStatus) -> Result<()> {
    let api: Api<Scribyra> = Api::namespaced(ctx.client.clone(), cr.namespace());
    api.patch_status(&cr.name_any(), &PatchParams::default(), &Patch::Merge(json!({"status": status}))).await?;
    Ok(())
}

/// Create a Secret with generated values once; never overwrite it.
async fn ensure_secret(ctx: &Context, cr: &Scribyra, name: &str, component: &str, owned: bool, make: impl FnOnce() -> Result<BTreeMap<String, Vec<u8>>>) -> Result<bool> {
    let api: Api<Secret> = Api::namespaced(ctx.client.clone(), cr.namespace());
    if get_opt(&api, name).await?.is_some() {
        return Ok(false);
    }
    let mut metadata = json!({"name": name, "labels": resources::labels(cr, component)});
    if owned {
        metadata["ownerReferences"] = json!([resources::owner_reference(cr)]);
    }
    let data: BTreeMap<String, ByteString> = make()?.into_iter().map(|(k, v)| (k, ByteString(v))).collect();
    let secret: Secret = serde_json::from_value(json!({"metadata": metadata, "type": "Opaque", "data": data})).map_err(|e| Error::Other(e.to_string()))?;
    match api.create(&PostParams::default(), &secret).await {
        Ok(_) => Ok(true),
        Err(kube::Error::Api(e)) if e.code == 409 => Ok(false),
        Err(e) => Err(e.into()),
    }
}
fn random(n: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).map_err(|e| Error::Other(e.to_string()))?;
    Ok(bytes)
}

async fn secret_has(ctx: &Context, ns: &str, name: &str, keys: &[&str]) -> Result<Result<(), String>> {
    let api: Api<Secret> = Api::namespaced(ctx.client.clone(), ns);
    let Some(secret) = get_opt(&api, name).await? else { return Ok(Err(format!("Secret {name} does not exist"))) };
    let data = secret.data.unwrap_or_default();
    for key in keys {
        if !data.get(*key).is_some_and(|v| !v.0.is_empty()) {
            return Ok(Err(format!("Secret {name} has no key {key}")));
        }
    }
    Ok(Ok(()))
}

async fn apply_instance(cr: &Scribyra, ctx: &Context) -> Result<Action> {
    let ns = cr.namespace().to_string();
    let name = cr.name_any();
    let env = Env { registry: ctx.registry.clone(), operator_image: ctx.operator_image.clone(), operator_namespace: ctx.operator_namespace.clone(), capabilities: ctx.capabilities().await };
    let mut status = cr.status.clone().unwrap_or_default();
    let mut c = Conditions { generation: cr.metadata.generation, old: status.conditions.clone(), new: BTreeMap::new() };
    status.observed_generation = cr.metadata.generation;
    status.url = Some(service_config::origin(cr));
    let finish = |mut status: ScribyraStatus, c: &Conditions| {
        status.conditions = c.build();
        status
    };

    // The service's own validation, before anything is deployed.
    if let Err(message) = service_config::check(cr) {
        c.set("Ready", false, "InvalidSpec", &message);
        c.set("Degraded", true, "InvalidSpec", &message);
        c.set("Progressing", false, "InvalidSpec", "fix the spec");
        write_status(ctx, cr, &finish(status, &c)).await?;
        return Ok(Action::requeue(Duration::from_secs(300)));
    }

    // Generated secrets.
    if cr.spec.encryption == Encryption::ServerReadable && cr.spec.master_key_ref.is_none() {
        let (secret, key) = resources::master_key_secret(cr);
        if ensure_secret(ctx, cr, &secret, "master-key", false, || Ok(BTreeMap::from([(key, random(32)?)]))).await? {
            publish(ctx, cr, false, "MasterKeyGenerated", format!("generated the master key in Secret {secret}; back it up separately from the database")).await;
        }
    }
    if cr.spec.encryption == Encryption::ServerReadable {
        status.master_key_secret = Some(resources::master_key_secret(cr).0);
    }
    if cr.spec.storage.provisioned.is_some() {
        ensure_secret(ctx, cr, &resources::garage_internal_secret(cr), "garage", true, || {
            Ok(BTreeMap::from([("rpc-secret".into(), resources::hex(&random(32)?).into_bytes()), ("admin-token".into(), resources::hex(&random(32)?).into_bytes())]))
        })
        .await?;
        let names = crate::tls::garage_names(&name, &ns);
        ensure_secret(ctx, cr, &resources::garage_tls_secret(cr), "garage", true, || {
            let m = crate::tls::generate(&names).map_err(|e| Error::Other(e.to_string()))?;
            Ok(BTreeMap::from([("ca.crt".into(), m.ca_pem.into_bytes()), ("tls.crt".into(), m.cert_pem.into_bytes()), ("tls.key".into(), m.key_pem.into_bytes())]))
        })
        .await?;
    }

    // Which release runs.
    let allow_unknown = cr.annotations().get(versions::ALLOW_UNKNOWN).is_some_and(|v| v == "true");
    let running = status.version.clone();
    let running_release = running.as_deref().map(|v| ctx.releases.iter().find(|r| r.version == v).cloned().unwrap_or(Release { version: v.into(), upgrades_from: None, single_writer: true }));
    let target = match versions::decide(&ctx.releases, running.as_deref(), &cr.spec.version, allow_unknown) {
        Decision::Run(r) => {
            c.set("UpgradeBlocked", false, "None", "");
            r
        }
        Decision::Upgrade(r) => {
            c.set("UpgradeBlocked", false, "None", "");
            r
        }
        Decision::Blocked { reason, message } => {
            if !cr.status.as_ref().and_then(|s| s.conditions.iter().find(|c| c.type_ == "UpgradeBlocked")).is_some_and(|b| b.status == "True" && b.reason == reason) {
                publish(ctx, cr, true, "UpgradeBlocked", message.clone()).await;
            }
            c.set("UpgradeBlocked", true, reason, &message);
            match running_release.clone() {
                Some(r) => r,
                None => {
                    c.set("Ready", false, reason, &message);
                    c.set("Progressing", false, reason, "nothing is deployed until spec.version names a release this operator knows");
                    c.set("Degraded", true, reason, &message);
                    write_status(ctx, cr, &finish(status, &c)).await?;
                    return Ok(Action::requeue(Duration::from_secs(300)));
                }
            }
        }
    };
    let migrated = status.migrated_version.as_deref() == Some(target.version.as_str());
    let fresh = running.is_none();
    // Only a release whose API owns the database exclusively in every mode needs its pods stopped
    // before the migration Job runs; current releases migrate while the old release serves.
    let single_writer_now = running_release.as_ref().map(|r| r.single_writer).unwrap_or(false) || target.single_writer;
    // An end-to-end deployment's API takes the database exclusively: one replica, `Recreate`.
    let exclusive = cr.spec.encryption == Encryption::EndToEnd;

    // Compile worker replicas.
    let workers = if cr.compiles_on_server() { Some(scale_workers(cr, ctx, status.compile_workers.clone()).await) } else { None };
    status.compile_workers = workers.clone();

    let mut plan = Plan {
        version: if migrated { target.version.clone() } else { running.clone().unwrap_or_else(|| target.version.clone()) },
        single_writer: exclusive || if migrated { target.single_writer } else { running_release.as_ref().map(|r| r.single_writer).unwrap_or(target.single_writer) },
        stopped: !migrated && !fresh && single_writer_now,
        worker_replicas: workers.as_ref().map(|w| w.desired_replicas).unwrap_or(0),
    };

    // Dependencies.
    let db = database_ready(cr, ctx, &env).await?;
    match &db {
        Ok(()) => c.set("DatabaseReady", true, "Ready", "PostgreSQL is available"),
        Err((reason, message)) => c.set("DatabaseReady", false, reason, message),
    }
    let storage = storage_ready(cr, ctx, &mut status).await?;
    match &storage {
        Ok(()) => c.set("StorageReady", true, "Ready", "object storage is available"),
        Err((reason, message)) => c.set("StorageReady", false, reason, message),
    }

    // Apply everything for the plan. On a fresh install the API and workers wait for the first
    // migration; the migration Job is handled below.
    let mut wanted = resources::desired(cr, &env, &plan);
    if fresh && !migrated {
        wanted.retain(|o| !(matches!(o.kind(), "Deployment" | "HorizontalPodAutoscaler" | "ScaledObject") && matches!(component(o), "api" | "worker")));
    }
    for object in &wanted {
        apply(&ctx.client, &ns, object).await?;
    }
    let mut keep: BTreeSet<(String, String)> = wanted.iter().map(|o| (o.kind().to_string(), o.name().to_string())).collect();
    keep.insert(("Job".into(), resources::migrate_job(cr, &target.version)));

    let mut requeue = Duration::from_secs(if workers.is_some() { 15 } else { 60 });
    if !migrated {
        if let (Ok(()), Ok(())) = (&db, &storage) {
            match migrate(cr, ctx, &env, &target, &plan).await? {
                Migration::WaitingForStop(n) => {
                    c.set("Progressing", true, "StoppingSingleWriter", format!("waiting for {n} pod(s) of {} to stop before migrating to {}", plan.version, target.version));
                    requeue = Duration::from_secs(5);
                }
                Migration::Running => {
                    c.set("Progressing", true, "Migrating", format!("migration Job {} is running", resources::migrate_job(cr, &target.version)));
                    requeue = Duration::from_secs(5);
                }
                Migration::Failed(message) => {
                    c.set("Degraded", true, "MigrationFailed", &message);
                    c.set("UpgradeBlocked", true, "MigrationFailed", format!("{message}; delete the Job to retry"));
                    if plan.stopped {
                        // The failed migration rolled back; let the previous release serve again.
                        plan.stopped = false;
                        for object in resources::desired(cr, &env, &plan) {
                            apply(&ctx.client, &ns, &object).await?;
                        }
                    }
                    requeue = Duration::from_secs(60);
                }
                Migration::Done => {
                    publish(ctx, cr, false, "Migrated", format!("schema migrated for {}; rolling out", target.version)).await;
                    status.migrated_version = Some(target.version.clone());
                    write_status(ctx, cr, &finish(status, &c)).await?;
                    return Ok(Action::requeue(Duration::from_millis(500)));
                }
            }
        } else {
            c.set("Progressing", true, "WaitingForDependencies", "waiting for the database and storage before migrating");
            requeue = Duration::from_secs(10);
        }
    } else if running.as_deref() != Some(target.version.as_str()) {
        publish(ctx, cr, false, if fresh { "Installed" } else { "Upgraded" }, format!("Deployments run {}", target.version)).await;
        status.version = Some(target.version.clone());
    }

    // Readiness of what runs.
    if migrated {
        let (ready, rolling, message) = workloads_ready(cr, ctx).await?;
        if rolling {
            c.set("Progressing", true, "RollingOut", &message);
            requeue = requeue.min(Duration::from_secs(10));
        } else {
            c.set("Progressing", false, "Complete", format!("{} is rolled out", target.version));
        }
        let deps = c.is("DatabaseReady") && c.is("StorageReady");
        c.set("Ready", ready && deps, if ready && deps { "Ready" } else { "NotReady" }, if ready && deps { format!("https://{} serves {}", cr.spec.domain, target.version) } else { message.clone() });
    } else {
        c.set("Ready", false, "NotReady", "the release is not rolled out yet");
    }
    if !c.new.contains_key("Degraded") {
        c.set("Degraded", false, "None", "");
    }
    if cr.spec.autoscaling.is_some() && plan.single_writer {
        publish_once(ctx, cr, &status, "AutoscalingIgnored", if exclusive { "an end-to-end deployment runs a single API writer; autoscaling and replicas above 1 are ignored".to_string() } else { format!("release {} runs a single writer; autoscaling and replicas above 1 are ignored", plan.version) }).await;
    }

    prune(cr, ctx, &env, &keep).await?;
    write_status(ctx, cr, &finish(status, &c)).await?;
    Ok(Action::requeue(requeue))
}

async fn publish_once(ctx: &Context, cr: &Scribyra, status: &ScribyraStatus, reason: &str, note: String) {
    // Only on the first pass of a generation, to keep the event stream quiet.
    if status.observed_generation != cr.status.as_ref().and_then(|s| s.observed_generation) {
        publish(ctx, cr, true, reason, note).await;
    }
}

fn component(o: &Object) -> &str {
    o.value["metadata"]["labels"][resources::COMPONENT_LABEL].as_str().unwrap_or_default()
}

type NotReady = (&'static str, String);

async fn database_ready(cr: &Scribyra, ctx: &Context, env: &Env) -> Result<Result<(), NotReady>> {
    let ns = cr.namespace();
    if let Some(e) = &cr.spec.postgres.external {
        return Ok(secret_has(ctx, ns, &e.secret_ref.name, &[&e.secret_ref.key]).await?.map_err(|m| ("SecretMissing", m)));
    }
    if !env.capabilities.cnpg {
        return Ok(Err((
            "CloudNativePGMissing",
            "postgres.provisioned needs the CloudNativePG operator (postgresql.cnpg.io/v1), which this cluster does not serve; install it (docs/operator.md, quickstart) or use postgres.external".into(),
        )));
    }
    let api = dynamic_api(&ctx.client, ns, "postgresql.cnpg.io/v1", "Cluster");
    let Some(cluster) = api.get_opt(&resources::cnpg_cluster(cr)).await? else { return Ok(Err(("Provisioning", "the CloudNativePG Cluster is being created".into()))) };
    let ready = cluster.data["status"]["readyInstances"].as_i64().unwrap_or(0);
    if ready < 1 {
        let phase = cluster.data["status"]["phase"].as_str().unwrap_or("starting").to_string();
        return Ok(Err(("Provisioning", format!("CloudNativePG: {phase}"))));
    }
    let app = format!("{}-app", resources::cnpg_cluster(cr));
    Ok(secret_has(ctx, ns, &app, &["uri"]).await?.map_err(|m| ("Provisioning", m)))
}

async fn storage_ready(cr: &Scribyra, ctx: &Context, status: &mut ScribyraStatus) -> Result<Result<(), NotReady>> {
    let ns = cr.namespace();
    if let Some(s3) = &cr.spec.storage.s3 {
        return Ok(secret_has(ctx, ns, &s3.secret_ref.name, &[&s3.secret_ref.access_key_id_key, &s3.secret_ref.secret_access_key_key]).await?.map_err(|m| ("SecretMissing", m)));
    }
    let sts: Api<StatefulSet> = Api::namespaced(ctx.client.clone(), ns);
    let ready = get_opt(&sts, &resources::name(cr, "garage")).await?.and_then(|s| s.status).and_then(|s| s.ready_replicas).unwrap_or(0);
    let creds = resources::garage_s3_secret(cr);
    let have = secret_has(ctx, ns, &creds, &["access-key-id", "secret-access-key"]).await?.is_ok();
    if have && status.storage_bootstrapped == Some(true) {
        return Ok(Ok(()));
    }
    if ready < 1 {
        return Ok(Err(("Provisioning", "Garage is starting".into())));
    }
    // Bootstrap through the admin API (TLS, the operator's CA).
    let secrets: Api<Secret> = Api::namespaced(ctx.client.clone(), ns);
    let internal = secrets.get(&resources::garage_internal_secret(cr)).await?.data.unwrap_or_default();
    let tls = secrets.get(&resources::garage_tls_secret(cr)).await?.data.unwrap_or_default();
    let token = String::from_utf8_lossy(&internal.get("admin-token").map(|b| b.0.clone()).unwrap_or_default()).to_string();
    let ca = tls.get("ca.crt").map(|b| b.0.clone()).unwrap_or_default();
    let known = if have {
        let data = secrets.get(&creds).await?.data.unwrap_or_default();
        let text = |k: &str| String::from_utf8_lossy(&data.get(k).map(|b| b.0.clone()).unwrap_or_default()).to_string();
        Some(garage::Credentials { access_key_id: text("access-key-id"), secret_access_key: text("secret-access-key") })
    } else {
        None
    };
    let url = ctx.garage_admin_url.replace("{name}", cr.name()).replace("{namespace}", ns);
    let capacity = parse_quantity(&cr.spec.storage.provisioned.as_ref().unwrap().size).unwrap_or(1 << 30);
    let result = tokio::task::spawn_blocking(move || garage::Admin::new(&url, &token, &ca)?.bootstrap(service_config::GARAGE_BUCKET, capacity, known)).await.map_err(|e| Error::Other(e.to_string()))?;
    match result {
        Ok(c) => {
            if !have {
                let mut data = BTreeMap::new();
                data.insert("access-key-id".to_string(), c.access_key_id.into_bytes());
                data.insert("secret-access-key".to_string(), c.secret_access_key.into_bytes());
                // Retained with the data: without these the bucket's objects are unreachable.
                ensure_secret(ctx, cr, &creds, "garage", false, || Ok(data)).await?;
                publish(ctx, cr, false, "StorageBootstrapped", "Garage layout, bucket and access key are ready".into()).await;
            }
            status.storage_bootstrapped = Some(true);
            Ok(Ok(()))
        }
        Err(e) => Ok(Err(("Bootstrapping", e.to_string()))),
    }
}

/// Kubernetes quantity in bytes (binary and decimal suffixes).
pub fn parse_quantity(q: &str) -> Option<u64> {
    let units: [(&str, u64); 8] = [("Ki", 1 << 10), ("Mi", 1 << 20), ("Gi", 1 << 30), ("Ti", 1 << 40), ("k", 1000), ("M", 1_000_000), ("G", 1_000_000_000), ("T", 1_000_000_000_000)];
    for (suffix, factor) in units {
        if let Some(n) = q.strip_suffix(suffix) {
            return n.parse::<u64>().ok().map(|n| n * factor);
        }
    }
    q.parse().ok()
}

enum Migration {
    WaitingForStop(usize),
    Running,
    Failed(String),
    Done,
}

async fn migrate(cr: &Scribyra, ctx: &Context, env: &Env, target: &Release, plan: &Plan) -> Result<Migration> {
    let ns = cr.namespace();
    if plan.stopped {
        let pods: Api<Pod> = Api::namespaced(ctx.client.clone(), ns);
        let selector = format!("{INSTANCE_LABEL}={},{} in (api,worker)", cr.name(), resources::COMPONENT_LABEL);
        let n = pods.list(&ListParams::default().labels(&selector)).await?.items.len();
        if n > 0 {
            return Ok(Migration::WaitingForStop(n));
        }
    }
    let jobs: Api<Job> = Api::namespaced(ctx.client.clone(), ns);
    let job_name = resources::migrate_job(cr, &target.version);
    let Some(job) = get_opt(&jobs, &job_name).await? else {
        let job_plan = Plan { version: target.version.clone(), ..plan.clone() };
        apply(&ctx.client, ns, &resources::migration_job(cr, env, &job_plan)).await?;
        publish(ctx, cr, false, "MigrationStarted", format!("running migration Job {job_name} for {}", target.version)).await;
        return Ok(Migration::Running);
    };
    let conditions = job.status.and_then(|s| s.conditions).unwrap_or_default();
    let has = |t: &str| conditions.iter().any(|c| c.type_ == t && c.status == "True");
    if has("Complete") {
        Ok(Migration::Done)
    } else if has("Failed") {
        let message = conditions.iter().find(|c| c.type_ == "Failed").and_then(|c| c.message.clone()).unwrap_or_default();
        publish(ctx, cr, true, "MigrationFailed", format!("migration Job {job_name} failed: {message}")).await;
        Ok(Migration::Failed(format!("migration Job {job_name} failed: {message}")))
    } else {
        Ok(Migration::Running)
    }
}

/// (ready, still rolling out, message) of the API, web and worker Deployments.
async fn workloads_ready(cr: &Scribyra, ctx: &Context) -> Result<(bool, bool, String)> {
    let api: Api<Deployment> = Api::namespaced(ctx.client.clone(), cr.namespace());
    let mut ready = true;
    let mut rolling = false;
    let mut waiting = vec![];
    for component in ["api", "web"] {
        let name = resources::name(cr, component);
        let Some(d) = get_opt(&api, &name).await? else {
            ready = false;
            rolling = true;
            waiting.push(format!("{name} missing"));
            continue;
        };
        let want = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
        let s = d.status.clone().unwrap_or_default();
        let current = d.metadata.generation == s.observed_generation && s.updated_replicas.unwrap_or(0) >= want && s.replicas.unwrap_or(0) == want;
        if s.available_replicas.unwrap_or(0) < 1 {
            ready = false;
            waiting.push(format!("{name} has no available pod"));
        }
        if !current || s.available_replicas.unwrap_or(0) < want {
            rolling = true;
            waiting.push(format!("{name} {}/{} updated", s.updated_replicas.unwrap_or(0), want));
        }
    }
    Ok((ready, rolling, if waiting.is_empty() { "all Deployments are available".into() } else { waiting.join("; ") }))
}

/// The operator's own queue-based scaler: replicas = ceil(queue / concurrency) within
/// [min, max], scaling down only after five quiet minutes. With `scaler: keda` KEDA decides.
async fn scale_workers(cr: &Scribyra, ctx: &Context, previous: Option<WorkerStatus>) -> WorkerStatus {
    let w = &cr.spec.compile.workers;
    let previous = previous.unwrap_or(WorkerStatus { desired_replicas: w.min_replicas, queue_length: None, last_busy: None });
    if w.scaler == Scaler::Keda {
        return WorkerStatus { desired_replicas: w.min_replicas, queue_length: None, last_busy: None };
    }
    let url = ctx.api_metrics_url.replace("{name}", cr.name()).replace("{namespace}", cr.namespace());
    let queue = tokio::task::spawn_blocking(move || read_queue(&url)).await.ok().flatten();
    let now = jiff_now();
    let Some(queue) = queue else {
        let desired = previous.desired_replicas.clamp(w.min_replicas, w.max_replicas);
        return WorkerStatus { desired_replicas: desired, queue_length: None, ..previous };
    };
    let wanted = ((queue.max(0) as u64).div_ceil(w.concurrency as u64) as i32).clamp(w.min_replicas, w.max_replicas);
    let last_busy = if queue > 0 { Some(now.to_string()) } else { previous.last_busy.clone() };
    let quiet = last_busy.as_deref().and_then(|t| t.parse::<k8s_openapi::jiff::Timestamp>().ok()).is_none_or(|t| now.duration_since(t).as_secs() >= 300);
    let desired = if wanted >= previous.desired_replicas || quiet { wanted } else { previous.desired_replicas.clamp(w.min_replicas, w.max_replicas) };
    ctx.metrics.queue(cr.namespace(), cr.name(), queue);
    WorkerStatus { desired_replicas: desired, queue_length: Some(queue), last_busy }
}

/// `scribyra_compile_queue_length` from a Prometheus text endpoint.
pub fn read_queue(url: &str) -> Option<i64> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(2))).build().into();
    let text = agent.get(url).call().ok()?.body_mut().read_to_string().ok()?;
    parse_queue(&text)
}
pub fn parse_queue(text: &str) -> Option<i64> {
    let metric = scribyra_sync::deploy::COMPILE_QUEUE_METRIC;
    text.lines().filter(|l| !l.starts_with('#')).find_map(|l| {
        let rest = l.strip_prefix(metric)?;
        let rest = if rest.starts_with('{') { rest.split_once('}')?.1 } else { rest };
        rest.split_whitespace().next()?.parse::<f64>().ok().map(|v| v as i64)
    })
}

/// Delete owned objects of this instance that are no longer wanted.
async fn prune(cr: &Scribyra, ctx: &Context, env: &Env, keep: &BTreeSet<(String, String)>) -> Result<()> {
    let uid = cr.uid().unwrap_or_default();
    let selector = format!("{INSTANCE_LABEL}={},app.kubernetes.io/managed-by={MANAGED_BY}", cr.name());
    let caps = env.capabilities;
    let optional = resources::PRUNED_OPTIONAL.iter().filter(|(g, _, _)| match *g {
        "gateway.networking.k8s.io" => caps.gateway,
        "cert-manager.io" => caps.cert_manager,
        "keda.sh" => caps.keda,
        "postgresql.cnpg.io" => caps.cnpg,
        _ => false,
    });
    for (group, version, kind) in resources::PRUNED.iter().chain(optional) {
        let api_version = if group.is_empty() { version.to_string() } else { format!("{group}/{version}") };
        let api = dynamic_api(&ctx.client, cr.namespace(), &api_version, kind);
        for item in api.list(&ListParams::default().labels(&selector)).await?.items {
            let owned = item.metadata.owner_references.iter().flatten().any(|o| o.uid == uid);
            let name = item.name_any();
            if !owned || keep.contains(&(kind.to_string(), name.clone())) {
                continue;
            }
            tracing::info!(%kind, %name, "pruning");
            match api.delete(&name, &DeleteParams::background()).await {
                Ok(_) => {}
                Err(kube::Error::Api(e)) if e.code == 404 => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(())
}

async fn cleanup(cr: &Scribyra, ctx: &Context) -> Result<Action> {
    let ns = cr.namespace();
    if cr.spec.deletion_policy == DeletionPolicy::Retain {
        let mut kept = vec![];
        if cr.spec.postgres.provisioned.is_some() {
            kept.push(format!("CloudNativePG Cluster {}", resources::cnpg_cluster(cr)));
        }
        if cr.spec.storage.provisioned.is_some() {
            kept.push(format!("Garage volume data-{}-garage-0 and Secret {}", cr.name(), resources::garage_s3_secret(cr)));
        }
        if cr.spec.encryption == Encryption::ServerReadable && cr.spec.master_key_ref.is_none() {
            kept.push(format!("Secret {}", resources::master_key_secret(cr).0));
        }
        if !kept.is_empty() {
            publish(ctx, cr, false, "Retained", format!("deletionPolicy Retain kept: {}", kept.join(", "))).await;
        }
        return Ok(Action::await_change());
    }
    let ignore_missing = |r: Result<(), kube::Error>| match r {
        Err(kube::Error::Api(e)) if e.code == 404 => Ok(()),
        other => other,
    };
    if cr.spec.postgres.provisioned.is_some() && ctx.capabilities().await.cnpg {
        let api = dynamic_api(&ctx.client, ns, "postgresql.cnpg.io/v1", "Cluster");
        ignore_missing(api.delete(&resources::cnpg_cluster(cr), &DeleteParams::background()).await.map(|_| ()))?;
    }
    let secrets: Api<Secret> = Api::namespaced(ctx.client.clone(), ns);
    if cr.spec.master_key_ref.is_none() {
        ignore_missing(secrets.delete(&resources::master_key_secret(cr).0, &DeleteParams::default()).await.map(|_| ()))?;
    }
    ignore_missing(secrets.delete(&resources::garage_s3_secret(cr), &DeleteParams::default()).await.map(|_| ()))?;
    let pvcs: Api<PersistentVolumeClaim> = Api::namespaced(ctx.client.clone(), ns);
    let selector = format!("{INSTANCE_LABEL}={},{}=garage", cr.name(), resources::COMPONENT_LABEL);
    for pvc in pvcs.list(&ListParams::default().labels(&selector)).await?.items {
        ignore_missing(pvcs.delete(&pvc.name_any(), &DeleteParams::default()).await.map(|_| ()))?;
    }
    publish(ctx, cr, true, "DataDeleted", "deletionPolicy Delete: removed the database, the Garage volume and the generated secrets".into()).await;
    Ok(Action::await_change())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_metric_parsing() {
        assert_eq!(parse_queue("# HELP x\nscribyra_compile_queue_length 7\n"), Some(7));
        assert_eq!(parse_queue("scribyra_compile_queue_length{instance=\"a\"} 3.0\n"), Some(3));
        assert_eq!(parse_queue("scribyra_compile_queue_length_total 3\n"), None);
        assert_eq!(parse_queue("other 1\n"), None);
    }
    #[test]
    fn quantities() {
        assert_eq!(parse_quantity("50Gi"), Some(50 << 30));
        assert_eq!(parse_quantity("1G"), Some(1_000_000_000));
        assert_eq!(parse_quantity("123"), Some(123));
    }
}

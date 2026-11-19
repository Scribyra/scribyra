//! The Kubernetes objects one `Scribyra` resource stands for.
//!
//! Everything here is a pure function of the resource and the operator's environment, so the
//! generated manifests are snapshot-tested without a cluster. Objects are plain JSON (applied
//! with server-side apply as `DynamicObject`s); the API server validates them in the
//! integration tests.

use crate::crd::{CacheAccessMode, DeletionPolicy, Encryption, IssuerKind, Scaler, Scribyra};
use crate::service_config::{self, GARAGE_ADMIN_PORT, GARAGE_S3_PORT};
use scribyra_sync::deploy;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MANAGED_BY: &str = "scribyra-operator";
pub const INSTANCE_LABEL: &str = "scribyra.com/instance";
pub const COMPONENT_LABEL: &str = "app.kubernetes.io/component";
pub const CONFIG_HASH: &str = "scribyra.com/config-hash";
pub const WEB_PORT: u16 = 8080;
/// Tag of the Garage image; equals `garage_1.version` in the pinned nixpkgs (`nix/operator.nix`,
/// checked in CI). The operator uses Garage's v1 admin API.
pub const GARAGE_VERSION: &str = "1.3.1";

/// What the operator knows about its cluster and itself.
#[derive(Clone, Debug)]
pub struct Env {
    /// Prefix of the default images, for example `ghcr.io/scribyra`.
    pub registry: String,
    /// The operator's own image; the Garage TLS proxy runs from it.
    pub operator_image: String,
    pub operator_namespace: String,
    pub capabilities: Capabilities,
}
/// Optional APIs found by discovery.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub cnpg: bool,
    pub keda: bool,
    pub gateway: bool,
    pub cert_manager: bool,
}

/// One object to apply.
#[derive(Clone, Debug, PartialEq)]
pub struct Object {
    pub value: Value,
}
impl Object {
    pub fn api_version(&self) -> &str {
        self.value["apiVersion"].as_str().unwrap_or_default()
    }
    pub fn kind(&self) -> &str {
        self.value["kind"].as_str().unwrap_or_default()
    }
    pub fn name(&self) -> &str {
        self.value["metadata"]["name"].as_str().unwrap_or_default()
    }
}

/// What to run now: the release (image tag), whether the API is a single writer (one replica,
/// `Recreate`: an end-to-end deployment, or a release that predates shared ownership), and
/// whether the API and workers should be stopped (an upgrade from a release whose migration
/// needs the database to itself, while the migration Job runs).
#[derive(Clone, Debug)]
pub struct Plan {
    pub version: String,
    pub single_writer: bool,
    pub stopped: bool,
    /// Compile worker replicas the operator's scaler wants.
    pub worker_replicas: i32,
}

pub fn name(cr: &Scribyra, suffix: &str) -> String {
    format!("{}-{suffix}", cr.name())
}
pub fn config_secret(cr: &Scribyra) -> String {
    name(cr, "config")
}
pub fn master_key_secret(cr: &Scribyra) -> (String, String) {
    match &cr.spec.master_key_ref {
        Some(r) => (r.name.clone(), r.key.clone()),
        None => (name(cr, "master-key"), "key".into()),
    }
}
pub fn cnpg_cluster(cr: &Scribyra) -> String {
    name(cr, "db")
}
pub fn garage_internal_secret(cr: &Scribyra) -> String {
    name(cr, "garage-internal")
}
pub fn garage_tls_secret(cr: &Scribyra) -> String {
    name(cr, "garage-tls")
}
pub fn garage_s3_secret(cr: &Scribyra) -> String {
    name(cr, "garage-s3")
}
/// The migration Job of a release: one per release, never reused.
pub fn migrate_job(cr: &Scribyra, version: &str) -> String {
    let clean: String = version.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let base = format!("{}-migrate-{clean}", cr.name());
    if base.len() <= 63 {
        return base;
    }
    let hash = hex(&Sha256::digest(version.as_bytes())[..4]);
    format!("{}-migrate-{hash}", cr.name())
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn labels(cr: &Scribyra, component: &str) -> Value {
    json!({
        "app.kubernetes.io/name": "scribyra",
        "app.kubernetes.io/instance": cr.name(),
        "app.kubernetes.io/managed-by": MANAGED_BY,
        COMPONENT_LABEL: component,
        INSTANCE_LABEL: cr.name(),
    })
}
fn selector(cr: &Scribyra, component: &str) -> Value {
    json!({INSTANCE_LABEL: cr.name(), COMPONENT_LABEL: component})
}
pub fn owner_reference(cr: &Scribyra) -> Value {
    json!({
        "apiVersion": "scribyra.com/v1alpha1",
        "kind": "Scribyra",
        "name": cr.name(),
        "uid": cr.metadata.uid.clone().unwrap_or_default(),
        "controller": true,
        "blockOwnerDeletion": true,
    })
}
fn meta(cr: &Scribyra, name: &str, component: &str, owned: bool) -> Value {
    let mut m = json!({"name": name, "namespace": cr.namespace(), "labels": labels(cr, component)});
    if owned {
        m["ownerReferences"] = json!([owner_reference(cr)]);
    }
    m
}
fn object(api_version: &str, kind: &str, metadata: Value, rest: Value) -> Object {
    let mut value = json!({"apiVersion": api_version, "kind": kind, "metadata": metadata});
    for (k, v) in rest.as_object().unwrap() {
        value[k] = v.clone();
    }
    Object { value }
}

fn image(cr: &Scribyra, env: &Env, which: &str, version: &str) -> String {
    let images = cr.spec.images.clone().unwrap_or_default();
    let custom = match which {
        "api" => images.api,
        "web" => images.web,
        "worker" => images.worker,
        "garage" => images.garage,
        _ => None,
    };
    custom.unwrap_or_else(|| match which {
        "api" => format!("{}/scribyra-sync:{version}", env.registry),
        "web" => format!("{}/scribyra-web:{version}", env.registry),
        "worker" => format!("{}/scribyra-worker:{version}", env.registry),
        _ => format!("{}/scribyra-garage:{GARAGE_VERSION}", env.registry),
    })
}
fn pull_policy(cr: &Scribyra) -> Value {
    cr.spec.images.as_ref().and_then(|i| i.pull_policy.clone()).map(Value::from).unwrap_or(json!("IfNotPresent"))
}
fn pull_secrets(cr: &Scribyra) -> Value {
    let names = cr.spec.images.as_ref().map(|i| i.pull_secrets.clone()).unwrap_or_default();
    Value::Array(names.into_iter().map(|n| json!({"name": n})).collect())
}

/// PodSecurity `restricted`: non-root, no privilege escalation, all capabilities dropped,
/// RuntimeDefault seccomp, read-only root file system.
pub fn container_security() -> Value {
    json!({
        "runAsNonRoot": true,
        "allowPrivilegeEscalation": false,
        "readOnlyRootFilesystem": true,
        "capabilities": {"drop": ["ALL"]},
        "seccompProfile": {"type": "RuntimeDefault"},
    })
}
pub fn pod_security() -> Value {
    json!({
        "runAsNonRoot": true,
        "runAsUser": deploy::RUN_AS,
        "runAsGroup": deploy::RUN_AS,
        "fsGroup": deploy::RUN_AS,
        "seccompProfile": {"type": "RuntimeDefault"},
    })
}

/// SHA-256 of the generated configuration; changes roll the pods.
pub fn config_hash(cr: &Scribyra) -> String {
    hex(&Sha256::digest(serde_json::to_vec(&service_config::service_json(cr)).unwrap())[..8])
}

/// Volumes every pod running `scribyra-sync` mounts: the generated configuration and each
/// referenced secret as its own read-only file.
fn service_volumes(cr: &Scribyra) -> Value {
    let spec = &cr.spec;
    let mut sources = vec![];
    let (db_secret, db_key) = match &spec.postgres.external {
        Some(e) => (e.secret_ref.name.clone(), e.secret_ref.key.clone()),
        None => (format!("{}-app", cnpg_cluster(cr)), "uri".into()),
    };
    sources.push(json!({"secret": {"name": db_secret, "items": [{"key": db_key, "path": "database-url"}]}}));
    match &spec.storage.s3 {
        Some(s3) => sources.push(json!({"secret": {"name": s3.secret_ref.name, "items": [{"key": s3.secret_ref.secret_access_key_key, "path": "s3-secret-access-key"}]}})),
        None => {
            sources.push(json!({"secret": {"name": garage_s3_secret(cr), "items": [{"key": "secret-access-key", "path": "s3-secret-access-key"}]}}));
            sources.push(json!({"secret": {"name": garage_tls_secret(cr), "items": [{"key": "ca.crt", "path": "s3-ca.pem"}]}}));
        }
    }
    if spec.encryption == Encryption::ServerReadable {
        let (secret, key) = master_key_secret(cr);
        sources.push(json!({"secret": {"name": secret, "items": [{"key": key, "path": "master-key"}]}}));
    }
    for p in &spec.oidc.providers {
        sources.push(json!({"secret": {"name": p.client_secret_ref.name, "items": [{"key": p.client_secret_ref.key, "path": format!("oidc-{}", p.name)}]}}));
    }
    json!([
        {"name": "config", "secret": {"secretName": config_secret(cr), "defaultMode": 0o440}},
        {"name": "secrets", "projected": {"defaultMode": 0o440, "sources": sources}},
        {"name": "tmp", "emptyDir": {"sizeLimit": "64Mi"}},
    ])
}
fn service_mounts() -> Value {
    json!([
        {"name": "config", "mountPath": deploy::CONFIG_DIR, "readOnly": true},
        {"name": "secrets", "mountPath": deploy::SECRETS_DIR, "readOnly": true},
        {"name": "tmp", "mountPath": "/tmp"},
    ])
}
fn service_env(cr: &Scribyra) -> Value {
    let (secret, key) = match &cr.spec.storage.s3 {
        Some(s3) => (s3.secret_ref.name.clone(), s3.secret_ref.access_key_id_key.clone()),
        None => (garage_s3_secret(cr), "access-key-id".into()),
    };
    json!([
        {"name": deploy::CONFIG_ENV, "value": deploy::CONFIG_FILE},
        {"name": deploy::S3_ACCESS_KEY_ID_ENV, "valueFrom": {"secretKeyRef": {"name": secret, "key": key}}},
    ])
}
/// A per-pod configuration override (`SCRIBYRA_SERVICE_<FIELD>`): listeners only some pods have.
fn override_env(field: &str, value: &str) -> Value {
    json!({"name": format!("{}{}", deploy::OVERRIDE_PREFIX, field.to_uppercase()), "value": value})
}
/// A pod template running `scribyra-sync <command>`.
fn service_pod(cr: &Scribyra, env: &Env, plan: &Plan, component: &str, image_kind: &str, command: &str, extra: Value) -> Value {
    let mut container = json!({
        "name": component,
        "image": image(cr, env, image_kind, &plan.version),
        "imagePullPolicy": pull_policy(cr),
        "args": [command],
        "env": service_env(cr),
        "volumeMounts": service_mounts(),
        "securityContext": container_security(),
    });
    for (k, v) in extra.as_object().unwrap() {
        container[k] = v.clone();
    }
    let mut labels = labels(cr, component);
    labels["app.kubernetes.io/version"] = plan.version.clone().into();
    json!({
        "metadata": {"labels": labels, "annotations": {CONFIG_HASH: config_hash(cr)}},
        "spec": {
            "automountServiceAccountToken": false,
            "enableServiceLinks": false,
            "securityContext": pod_security(),
            "imagePullSecrets": pull_secrets(cr),
            "containers": [container],
            "volumes": service_volumes(cr),
        }
    })
}

/// Every object for `cr` under `plan`, in apply order. The migration Job is separate
/// ([`migration_job`]), because the controller creates it only when an upgrade needs it.
pub fn desired(cr: &Scribyra, env: &Env, plan: &Plan) -> Vec<Object> {
    let mut out = vec![config(cr)];
    out.extend(network_policies(cr, env));
    if cr.spec.postgres.provisioned.is_some() && env.capabilities.cnpg {
        out.extend(cnpg(cr));
    }
    if cr.spec.storage.provisioned.is_some() {
        out.extend(garage(cr, env));
    }
    out.extend(api(cr, env, plan));
    out.extend(web(cr, env, plan));
    if cr.compiles_on_server() {
        out.extend(workers(cr, env, plan));
    }
    out.extend(routing(cr, env));
    out
}

pub fn config(cr: &Scribyra) -> Object {
    let json = serde_json::to_string_pretty(&service_config::service_json(cr)).unwrap();
    object(
        "v1",
        "Secret",
        meta(cr, &config_secret(cr), "config", true),
        json!({"type": "Opaque", "stringData": {deploy::CONFIG_KEY: json}}),
    )
}

fn api(cr: &Scribyra, env: &Env, plan: &Plan) -> Vec<Object> {
    let spec = &cr.spec;
    let n = name(cr, "api");
    // Several replicas share the database (shared ownership lock) when the deployment is
    // server-readable and its blobs are in S3, which they always are here: external S3 or the
    // provisioned Garage. End-to-end deployments take the lock exclusively: one replica.
    let single_writer = plan.single_writer || spec.encryption == Encryption::EndToEnd;
    let autoscaled = spec.autoscaling.is_some() && !single_writer;
    let replicas = if plan.stopped {
        0
    } else if single_writer {
        1
    } else {
        spec.autoscaling.as_ref().map(|a| a.min_replicas).unwrap_or(spec.replicas)
    };
    let resources = spec.resources.as_ref().map(|r| serde_json::to_value(r).unwrap()).unwrap_or(json!({
        "requests": {"cpu": "100m", "memory": "128Mi"},
        "limits": {"memory": "1Gi"},
    }));
    let probe = |path: &str, period: i32| json!({"httpGet": {"path": path, "port": "http"}, "periodSeconds": period, "timeoutSeconds": 3, "failureThreshold": 3});
    let pod = service_pod(
        cr,
        env,
        plan,
        "api",
        "api",
        deploy::COMMAND_SERVE,
        json!({
            "ports": [{"name": "http", "containerPort": deploy::HTTP_PORT}, {"name": "metrics", "containerPort": deploy::METRICS_PORT}],
            "readinessProbe": probe(deploy::READY_PATH, 5),
            "livenessProbe": probe(deploy::HEALTH_PATH, 10),
            "startupProbe": {"httpGet": {"path": deploy::HEALTH_PATH, "port": "http"}, "periodSeconds": 2, "failureThreshold": 90},
            "resources": resources,
        }),
    );
    let mut pod = pod;
    pod["spec"]["containers"][0]["env"].as_array_mut().unwrap().push(override_env("metrics_bind", deploy::METRICS_BIND));
    // Long polls last at most 25 s; give them time to finish.
    pod["spec"]["terminationGracePeriodSeconds"] = json!(40);
    let strategy = if single_writer {
        // A second process cannot take the exclusive database lock; the old pod must stop first.
        json!({"type": "Recreate"})
    } else {
        json!({"type": "RollingUpdate", "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1}})
    };
    let mut deployment_spec = json!({
        "selector": {"matchLabels": selector(cr, "api")},
        "strategy": strategy,
        "revisionHistoryLimit": 5,
        "template": pod,
    });
    if !autoscaled || plan.stopped {
        deployment_spec["replicas"] = replicas.into();
    }
    let mut out = vec![
        object("apps/v1", "Deployment", meta(cr, &n, "api", true), json!({"spec": deployment_spec})),
        object(
            "v1",
            "Service",
            meta(cr, &n, "api", true),
            json!({"spec": {"selector": selector(cr, "api"), "ports": [
                {"name": "http", "port": deploy::HTTP_PORT, "targetPort": "http"},
                {"name": "metrics", "port": deploy::METRICS_PORT, "targetPort": "metrics"},
            ]}}),
        ),
        pdb(cr, "api"),
    ];
    if let Some(a) = spec.autoscaling.as_ref().filter(|_| autoscaled) {
        out.push(object(
            "autoscaling/v2",
            "HorizontalPodAutoscaler",
            meta(cr, &n, "api", true),
            json!({"spec": {
                "scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": n},
                "minReplicas": a.min_replicas,
                "maxReplicas": a.max_replicas,
                "metrics": [{"type": "Resource", "resource": {"name": "cpu", "target": {"type": "Utilization", "averageUtilization": a.target_cpu_utilization_percentage}}}],
            }}),
        ));
    }
    out
}

fn pdb(cr: &Scribyra, component: &str) -> Object {
    object(
        "policy/v1",
        "PodDisruptionBudget",
        meta(cr, &name(cr, component), component, true),
        json!({"spec": {"maxUnavailable": 1, "unhealthyPodEvictionPolicy": "AlwaysAllow", "selector": {"matchLabels": selector(cr, component)}}}),
    )
}

/// The static web app: a separate image (a static file server and the built app), on the same
/// origin as the API through path routing. See `docs/operator.md` for why it is not served by
/// the API image.
fn web(cr: &Scribyra, env: &Env, plan: &Plan) -> Vec<Object> {
    let n = name(cr, "web");
    let mut labels = labels(cr, "web");
    labels["app.kubernetes.io/version"] = plan.version.clone().into();
    let probe = json!({"httpGet": {"path": "/", "port": "http"}, "periodSeconds": 10});
    vec![
        object(
            "apps/v1",
            "Deployment",
            meta(cr, &n, "web", true),
            json!({"spec": {
                "replicas": if cr.spec.replicas > 1 || cr.spec.autoscaling.is_some() { 2 } else { 1 },
                "selector": {"matchLabels": selector(cr, "web")},
                "strategy": {"type": "RollingUpdate", "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1}},
                "revisionHistoryLimit": 5,
                "template": {
                    "metadata": {"labels": labels},
                    "spec": {
                        "automountServiceAccountToken": false,
                        "enableServiceLinks": false,
                        "securityContext": pod_security(),
                        "imagePullSecrets": pull_secrets(cr),
                        "containers": [{
                            "name": "web",
                            "image": image(cr, env, "web", &plan.version),
                            "imagePullPolicy": pull_policy(cr),
                            "ports": [{"name": "http", "containerPort": WEB_PORT}],
                            "readinessProbe": probe,
                            "livenessProbe": probe,
                            "resources": {"requests": {"cpu": "20m", "memory": "32Mi"}, "limits": {"memory": "128Mi"}},
                            "securityContext": container_security(),
                        }],
                    }
                }
            }}),
        ),
        object("v1", "Service", meta(cr, &n, "web", true), json!({"spec": {"selector": selector(cr, "web"), "ports": [{"name": "http", "port": WEB_PORT, "targetPort": "http"}]}})),
        pdb(cr, "web"),
    ]
}

/// Pod memory the WebAssembly engine typically uses per concurrent job (Node, the engine's heap
/// and the job's in-memory scratch: 0.5–0.9 GiB measured, docs/compile-engines.md).
const WORKER_REQUEST_MIB_PER_JOB: u64 = 1024;
/// The worker process itself and Node's start-up, besides the jobs.
const WORKER_OVERHEAD_MIB: u64 = 256;

/// The workers' shared, writable TeX package cache.
pub fn compile_cache_claim(cr: &Scribyra) -> String {
    name(cr, "compile-cache")
}
fn compile_cache(cr: &Scribyra) -> Object {
    let c = &cr.spec.compile.cache;
    let mut spec = json!({
        "accessModes": [match c.access_mode { CacheAccessMode::ReadWriteMany => "ReadWriteMany", CacheAccessMode::ReadWriteOnce => "ReadWriteOnce" }],
        "resources": {"requests": {"storage": c.size}},
    });
    if let Some(class) = &c.storage_class_name {
        spec["storageClassName"] = class.clone().into();
    }
    // Owned: a cache, rebuilt from the bundled archives and the mirror when lost.
    object("v1", "PersistentVolumeClaim", meta(cr, &compile_cache_claim(cr), "worker", true), json!({"spec": spec}))
}

/// Compile workers: `scribyra-sync compile-worker` from the worker image (Node 22 and the
/// WebAssembly compile runtime at [`deploy::COMPILE_RUNTIME_DIR`], no TeX Live), the shared
/// package cache at [`deploy::COMPILE_CACHE_DIR`], jobs confined in cgroups under the pod's own.
fn workers(cr: &Scribyra, env: &Env, plan: &Plan) -> Vec<Object> {
    let c = &cr.spec.compile;
    let n = name(cr, "worker");
    let jobs = c.workers.concurrency as u64;
    // A job is held to `memoryMiB` by its own cgroup; the pod's limit leaves room for every
    // running job to reach it, while the request is what jobs typically use.
    let request_mib = WORKER_REQUEST_MIB_PER_JOB * jobs + WORKER_OVERHEAD_MIB;
    let limit_mib = (c.limits.memory_mi_b as u64).max(WORKER_REQUEST_MIB_PER_JOB) * jobs + WORKER_OVERHEAD_MIB;
    let resources = c.resources.as_ref().map(|r| serde_json::to_value(r).unwrap()).unwrap_or(json!({
        "requests": {"cpu": format!("{}m", 500 * c.workers.concurrency), "memory": format!("{request_mib}Mi")},
        "limits": {"memory": format!("{limit_mib}Mi")},
    }));
    let probe = |path: &str, period: i32| json!({"httpGet": {"path": path, "port": "probes"}, "periodSeconds": period, "timeoutSeconds": 3, "failureThreshold": 3});
    let mut pod = service_pod(
        cr,
        env,
        plan,
        "worker",
        "worker",
        deploy::COMMAND_COMPILE_WORKER,
        json!({
            "resources": resources,
            "ports": [{"name": "probes", "containerPort": deploy::WORKER_PORT}, {"name": "metrics", "containerPort": deploy::METRICS_PORT}],
            "readinessProbe": probe(deploy::READYZ_PATH, 5),
            "livenessProbe": probe(deploy::HEALTHZ_PATH, 10),
        }),
    );
    let container = &mut pod["spec"]["containers"][0];
    for (field, value) in [
        ("compile_worker_bind", deploy::WORKER_BIND),
        ("metrics_bind", deploy::METRICS_BIND),
        ("compile_runtime", deploy::COMPILE_RUNTIME_DIR),
        ("compile_cache", deploy::COMPILE_CACHE_DIR),
    ] {
        container["env"].as_array_mut().unwrap().push(override_env(field, value));
    }
    container["env"].as_array_mut().unwrap().push(json!({"name": "SCRIBYRA_COMPILE_CGROUP", "value": deploy::COMPILE_CGROUP_DIR}));
    container["volumeMounts"].as_array_mut().unwrap().push(json!({"name": "compile-cache", "mountPath": deploy::COMPILE_CACHE_DIR}));
    pod["spec"]["volumes"].as_array_mut().unwrap().push(json!({"name": "compile-cache", "persistentVolumeClaim": {"claimName": compile_cache_claim(cr)}}));
    // User namespaces: bubblewrap creates its own namespaces without host privileges.
    pod["spec"]["hostUsers"] = json!(false);
    pod["spec"]["terminationGracePeriodSeconds"] = json!(c.limits.wall_seconds + 30);
    if let Some(rc) = &c.runtime_class_name {
        pod["spec"]["runtimeClassName"] = rc.clone().into();
    }
    let mut spec = json!({
        "selector": {"matchLabels": selector(cr, "worker")},
        "strategy": {"type": "RollingUpdate", "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1}},
        "revisionHistoryLimit": 5,
        "template": pod,
    });
    let keda = c.workers.scaler == Scaler::Keda && env.capabilities.keda && c.workers.prometheus_address.is_some();
    if plan.stopped {
        spec["replicas"] = 0.into();
    } else if !keda {
        spec["replicas"] = plan.worker_replicas.into();
    }
    let mut out = vec![compile_cache(cr), object("apps/v1", "Deployment", meta(cr, &n, "worker", true), json!({"spec": spec}))];
    if keda && !plan.stopped {
        out.push(object(
            "keda.sh/v1alpha1",
            "ScaledObject",
            meta(cr, &n, "worker", true),
            json!({"spec": {
                "scaleTargetRef": {"name": n},
                "minReplicaCount": c.workers.min_replicas,
                "maxReplicaCount": c.workers.max_replicas,
                "cooldownPeriod": 300,
                "triggers": [{"type": "prometheus", "metadata": {
                    "serverAddress": c.workers.prometheus_address,
                    "query": format!("sum({}{{namespace=\"{}\",service=\"{}\"}})", deploy::COMPILE_QUEUE_METRIC, cr.namespace(), name(cr, "api")),
                    "threshold": c.workers.concurrency.to_string(),
                }}],
            }}),
        ));
    }
    out
}

/// The migration Job for `plan.version`.
pub fn migration_job(cr: &Scribyra, env: &Env, plan: &Plan) -> Object {
    let mut pod = service_pod(cr, env, plan, "migrate", "api", deploy::COMMAND_MIGRATE, json!({"resources": {"requests": {"cpu": "50m", "memory": "64Mi"}, "limits": {"memory": "256Mi"}}}));
    pod["spec"]["restartPolicy"] = json!("Never");
    object(
        "batch/v1",
        "Job",
        meta(cr, &migrate_job(cr, &plan.version), "migrate", true),
        json!({"spec": {"backoffLimit": 2, "activeDeadlineSeconds": 1800, "template": pod}}),
    )
}

fn routing(cr: &Scribyra, env: &Env) -> Vec<Object> {
    let i = &cr.spec.ingress;
    let api = name(cr, "api");
    let web = name(cr, "web");
    if let Some(g) = &i.gateway {
        let mut parent = json!({"name": g.name});
        if let Some(ns) = &g.namespace {
            parent["namespace"] = ns.clone().into();
        }
        if let Some(s) = &g.section_name {
            parent["sectionName"] = s.clone().into();
        }
        let mut out = vec![object(
            "gateway.networking.k8s.io/v1",
            "HTTPRoute",
            meta(cr, cr.name(), "routing", true),
            json!({"spec": {
                "parentRefs": [parent],
                "hostnames": [cr.spec.domain],
                "rules": [
                    {"matches": [{"path": {"type": "PathPrefix", "value": deploy::API_PREFIX}}], "backendRefs": [{"name": api, "port": deploy::HTTP_PORT}], "timeouts": {"request": "60s"}},
                    {"matches": [{"path": {"type": "PathPrefix", "value": "/"}}], "backendRefs": [{"name": web, "port": WEB_PORT}]},
                ],
            }}),
        )];
        if let (Some(issuer), true) = (&i.issuer_ref, env.capabilities.cert_manager) {
            out.push(object(
                "cert-manager.io/v1",
                "Certificate",
                meta(cr, &tls_secret(cr), "routing", true),
                json!({"spec": {"secretName": tls_secret(cr), "dnsNames": [cr.spec.domain], "issuerRef": {"name": issuer.name, "kind": issuer_kind(issuer.kind), "group": "cert-manager.io"}}}),
            ));
        }
        return out;
    }
    let mut annotations = serde_json::Map::new();
    if let Some(issuer) = &i.issuer_ref {
        let key = match issuer.kind {
            IssuerKind::ClusterIssuer => "cert-manager.io/cluster-issuer",
            IssuerKind::Issuer => "cert-manager.io/issuer",
        };
        annotations.insert(key.into(), issuer.name.clone().into());
    }
    for (k, v) in &i.annotations {
        annotations.insert(k.clone(), v.clone().into());
    }
    let mut metadata = meta(cr, cr.name(), "routing", true);
    if !annotations.is_empty() {
        metadata["annotations"] = Value::Object(annotations);
    }
    let backend = |svc: &str, port: u16| json!({"service": {"name": svc, "port": {"number": port}}});
    let mut spec = json!({
        "tls": [{"hosts": [cr.spec.domain], "secretName": tls_secret(cr)}],
        "rules": [{"host": cr.spec.domain, "http": {"paths": [
            {"path": deploy::API_PREFIX, "pathType": "Prefix", "backend": backend(&api, deploy::HTTP_PORT)},
            {"path": "/", "pathType": "Prefix", "backend": backend(&web, WEB_PORT)},
        ]}}],
    });
    if let Some(class) = &i.class_name {
        spec["ingressClassName"] = class.clone().into();
    }
    vec![object("networking.k8s.io/v1", "Ingress", metadata, json!({"spec": spec}))]
}
fn tls_secret(cr: &Scribyra) -> String {
    cr.spec.ingress.tls_secret_name.clone().unwrap_or_else(|| name(cr, "tls"))
}
fn issuer_kind(kind: IssuerKind) -> &'static str {
    match kind {
        IssuerKind::ClusterIssuer => "ClusterIssuer",
        IssuerKind::Issuer => "Issuer",
    }
}

fn peers(cr: &Scribyra, components: &[&str]) -> Vec<Value> {
    components.iter().map(|c| json!({"podSelector": {"matchLabels": selector(cr, c)}})).collect()
}
fn ns_peer(ns: &str) -> Value {
    json!({"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": ns}}})
}
fn dns() -> Value {
    json!({"to": [{"namespaceSelector": {}, "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}}}], "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]})
}
fn to_cidrs(cidrs: &[String], port: i32) -> Value {
    let to: Vec<Value> = if cidrs.is_empty() { vec![json!({"ipBlock": {"cidr": "0.0.0.0/0"}}), json!({"ipBlock": {"cidr": "::/0"}})] } else { cidrs.iter().map(|c| json!({"ipBlock": {"cidr": c}})).collect() };
    json!({"to": to, "ports": [{"protocol": "TCP", "port": port}]})
}
fn postgres_egress(cr: &Scribyra) -> Value {
    match &cr.spec.postgres.external {
        Some(e) => to_cidrs(&e.cidrs, e.port),
        None => json!({"to": [{"podSelector": {"matchLabels": {"cnpg.io/cluster": cnpg_cluster(cr)}}}], "ports": [{"protocol": "TCP", "port": 5432}]}),
    }
}
fn storage_egress(cr: &Scribyra) -> Value {
    match &cr.spec.storage.s3 {
        Some(s3) => {
            let port = s3.endpoint.trim_start_matches("https://").split('/').next().and_then(|h| h.rsplit_once(':')).and_then(|(_, p)| p.parse().ok()).unwrap_or(443);
            to_cidrs(&s3.cidrs, port)
        }
        None => json!({"to": [{"podSelector": {"matchLabels": selector(cr, "garage")}}], "ports": [{"protocol": "TCP", "port": GARAGE_S3_PORT}]}),
    }
}
fn netpol(cr: &Scribyra, suffix: &str, pod_selector: Value, types: &[&str], ingress: Vec<Value>, egress: Vec<Value>) -> Object {
    let mut spec = json!({"podSelector": pod_selector, "policyTypes": types});
    if types.contains(&"Ingress") {
        spec["ingress"] = ingress.into();
    }
    if types.contains(&"Egress") {
        spec["egress"] = egress.into();
    }
    object("networking.k8s.io/v1", "NetworkPolicy", meta(cr, &name(cr, suffix), "network", true), json!({"spec": spec}))
}

/// Default deny for every pod of the instance, then one allow policy per component:
/// web: ingress from the ingress controller only, no egress at all; API: ingress from the
/// ingress controller (and metrics from the operator), egress to DNS, PostgreSQL, storage and
/// the OIDC issuers (HTTPS); compile workers: egress to DNS, PostgreSQL, storage and the TeX
/// mirror (HTTPS; none without a mirror); the migration Job: egress to DNS, PostgreSQL and storage
/// only; Garage: ingress from those components only, no egress.
fn network_policies(cr: &Scribyra, env: &Env) -> Vec<Object> {
    let np = &cr.spec.network_policy;
    let from_ingress = match &np.ingress_namespace_selector {
        Some(sel) => vec![json!({"namespaceSelector": sel})],
        None => vec![json!({"namespaceSelector": {}})],
    };
    let instance = json!({"matchLabels": {INSTANCE_LABEL: cr.name()}});
    let mut out = vec![
        netpol(cr, "default-deny", instance, &["Ingress", "Egress"], vec![], vec![]),
        netpol(
            cr,
            "web",
            json!({"matchLabels": selector(cr, "web")}),
            &["Ingress"],
            vec![json!({"from": from_ingress, "ports": [{"protocol": "TCP", "port": WEB_PORT}]})],
            vec![],
        ),
        netpol(
            cr,
            "api",
            json!({"matchLabels": selector(cr, "api")}),
            &["Ingress", "Egress"],
            vec![
                json!({"from": from_ingress, "ports": [{"protocol": "TCP", "port": deploy::HTTP_PORT}]}),
                json!({"from": [ns_peer(&env.operator_namespace)], "ports": [{"protocol": "TCP", "port": deploy::METRICS_PORT}]}),
            ],
            vec![dns(), postgres_egress(cr), storage_egress(cr), to_cidrs(&np.oidc_cidrs, 443)],
        ),
        netpol(cr, "migrate", json!({"matchLabels": selector(cr, "migrate")}), &["Egress"], vec![], vec![dns(), postgres_egress(cr), storage_egress(cr)]),
    ];
    if cr.compiles_on_server() {
        out.push(netpol(
            cr,
            "worker",
            json!({"matchLabels": selector(cr, "worker")}),
            &["Ingress", "Egress"],
            vec![json!({"from": [ns_peer(&env.operator_namespace)], "ports": [{"protocol": "TCP", "port": deploy::METRICS_PORT}]})],
            {
                let mut egress = vec![dns(), postgres_egress(cr), storage_egress(cr)];
                if let Some(mirror) = service_config::tex_mirror(cr) {
                    let port = mirror.trim_start_matches("https://").split('/').next().and_then(|h| h.rsplit_once(':')).and_then(|(_, p)| p.parse().ok()).unwrap_or(443);
                    egress.push(to_cidrs(&cr.spec.compile.mirror_cidrs, port));
                }
                egress
            },
        ));
    }
    if cr.spec.storage.provisioned.is_some() {
        out.push(netpol(
            cr,
            "garage",
            json!({"matchLabels": selector(cr, "garage")}),
            &["Ingress"],
            vec![
                json!({"from": peers(cr, &["api", "worker", "migrate"]), "ports": [{"protocol": "TCP", "port": GARAGE_S3_PORT}]}),
                json!({"from": [ns_peer(&env.operator_namespace)], "ports": [{"protocol": "TCP", "port": GARAGE_ADMIN_PORT}]}),
            ],
            vec![],
        ));
    }
    if cr.spec.postgres.provisioned.is_some() {
        // CloudNativePG pods are not under the instance's default deny (their operator, the
        // replicas and WAL archiving need their own paths); only who may connect is narrowed.
        let mut from = peers(cr, &["api", "worker", "migrate"]);
        from.push(json!({"podSelector": {"matchLabels": {"cnpg.io/cluster": cnpg_cluster(cr)}}}));
        out.push(netpol(
            cr,
            "db",
            json!({"matchLabels": {"cnpg.io/cluster": cnpg_cluster(cr)}}),
            &["Ingress"],
            vec![
                json!({"from": from, "ports": [{"protocol": "TCP", "port": 5432}]}),
                json!({"ports": [{"protocol": "TCP", "port": 8000}]}),
            ],
            vec![],
        ));
    }
    out
}

/// CloudNativePG `Cluster` (and its `ScheduledBackup`). The Cluster carries no owner
/// reference: deleting it would delete the database volumes, which only `deletionPolicy:
/// Delete` may do (the finalizer deletes it then).
fn cnpg(cr: &Scribyra) -> Vec<Object> {
    let p = cr.spec.postgres.provisioned.as_ref().unwrap();
    let mut storage = json!({"size": p.storage_size});
    if let Some(sc) = &p.storage_class_name {
        storage["storageClass"] = sc.clone().into();
    }
    let mut spec = json!({
        "instances": p.instances,
        "storage": storage,
        "enableSuperuserAccess": false,
        "bootstrap": {"initdb": {"database": "scribyra", "owner": "scribyra"}},
        "inheritedMetadata": {"labels": {"app.kubernetes.io/part-of": "scribyra", "scribyra.com/database-of": cr.name()}},
    });
    if let Some(image) = &p.image_name {
        spec["imageName"] = image.clone().into();
    }
    if let Some(b) = &cr.spec.backup {
        let mut store = json!({
            "destinationPath": b.destination.destination_path,
            "s3Credentials": {
                "accessKeyId": {"name": b.destination.secret_ref.name, "key": b.destination.secret_ref.access_key_id_key},
                "secretAccessKey": {"name": b.destination.secret_ref.name, "key": b.destination.secret_ref.secret_access_key_key},
            },
            "wal": {"compression": "gzip"},
            "data": {"compression": "gzip"},
        });
        if let Some(e) = &b.destination.endpoint_url {
            store["endpointURL"] = e.clone().into();
        }
        spec["backup"] = json!({"barmanObjectStore": store, "retentionPolicy": b.retention});
    }
    let mut out = vec![object("postgresql.cnpg.io/v1", "Cluster", meta(cr, &cnpg_cluster(cr), "database", false), json!({"spec": spec}))];
    if let Some(b) = &cr.spec.backup {
        out.push(object(
            "postgresql.cnpg.io/v1",
            "ScheduledBackup",
            meta(cr, &name(cr, "db-scheduled"), "database", true),
            json!({"spec": {"schedule": b.schedule, "cluster": {"name": cnpg_cluster(cr)}, "backupOwnerReference": "self", "method": "barmanObjectStore", "immediate": true}}),
        ));
    }
    out
}

pub fn garage_config(cr: &Scribyra) -> String {
    let _ = cr;
    format!(
        r#"metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "127.0.0.1:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret_file = "/etc/garage/secrets/rpc-secret"
# Kubernetes mounts secrets group-readable (fsGroup); the pod is the boundary.
allow_world_readable_secrets = true

[s3_api]
s3_region = "{region}"
api_bind_addr = "127.0.0.1:3900"
root_domain = ".s3.garage.localhost"

[admin]
api_bind_addr = "127.0.0.1:3903"
admin_token_file = "/etc/garage/secrets/admin-token"
"#,
        region = service_config::GARAGE_REGION
    )
}

/// Single-node Garage: a StatefulSet with one volume, plus a TLS proxy sidecar (from the
/// operator's image) so the S3 and admin APIs are reached only over TLS with the operator's
/// private CA. Garage itself listens on loopback.
fn garage(cr: &Scribyra, env: &Env) -> Vec<Object> {
    let p = cr.spec.storage.provisioned.as_ref().unwrap();
    let n = name(cr, "garage");
    let mut claim = json!({
        "metadata": {"name": "data", "labels": labels(cr, "garage")},
        "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": p.size}}},
    });
    if let Some(sc) = &p.storage_class_name {
        claim["spec"]["storageClassName"] = sc.clone().into();
    }
    let retention = match cr.spec.deletion_policy {
        DeletionPolicy::Retain => "Retain",
        DeletionPolicy::Delete => "Delete",
    };
    let tcp = |port: u16| json!({"tcpSocket": {"port": port}, "periodSeconds": 10});
    vec![
        object("v1", "ConfigMap", meta(cr, &name(cr, "garage-config"), "garage", true), json!({"data": {"garage.toml": garage_config(cr)}})),
        object(
            "v1",
            "Service",
            meta(cr, &n, "garage", true),
            json!({"spec": {"selector": selector(cr, "garage"), "ports": [
                {"name": "s3", "port": GARAGE_S3_PORT, "targetPort": "s3"},
                {"name": "admin", "port": GARAGE_ADMIN_PORT, "targetPort": "admin"},
            ]}}),
        ),
        object(
            "apps/v1",
            "StatefulSet",
            meta(cr, &n, "garage", true),
            json!({"spec": {
                "replicas": 1,
                "serviceName": n,
                "selector": {"matchLabels": selector(cr, "garage")},
                "persistentVolumeClaimRetentionPolicy": {"whenDeleted": retention, "whenScaled": "Retain"},
                "volumeClaimTemplates": [claim],
                "template": {
                    "metadata": {"labels": labels(cr, "garage"), "annotations": {CONFIG_HASH: hex(&Sha256::digest(garage_config(cr).as_bytes())[..8])}},
                    "spec": {
                        "automountServiceAccountToken": false,
                        "enableServiceLinks": false,
                        "securityContext": pod_security(),
                        "imagePullSecrets": pull_secrets(cr),
                        "containers": [
                            {
                                "name": "garage",
                                "image": image(cr, env, "garage", ""),
                                "imagePullPolicy": pull_policy(cr),
                                "args": ["server"],
                                "env": [{"name": "GARAGE_CONFIG_FILE", "value": "/etc/garage/garage.toml"}],
                                "volumeMounts": [
                                    {"name": "data", "mountPath": "/var/lib/garage"},
                                    {"name": "config", "mountPath": "/etc/garage/garage.toml", "subPath": "garage.toml", "readOnly": true},
                                    {"name": "internal", "mountPath": "/etc/garage/secrets", "readOnly": true},
                                ],
                                "resources": {"requests": {"cpu": "50m", "memory": "128Mi"}, "limits": {"memory": "1Gi"}},
                                "securityContext": container_security(),
                            },
                            {
                                "name": "tls",
                                "image": env.operator_image,
                                "imagePullPolicy": pull_policy(cr),
                                "args": ["tls-proxy", "--cert", "/tls/tls.crt", "--key", "/tls/tls.key",
                                    "--route", format!("0.0.0.0:{GARAGE_S3_PORT}=127.0.0.1:3900"),
                                    "--route", format!("0.0.0.0:{GARAGE_ADMIN_PORT}=127.0.0.1:3903")],
                                "ports": [{"name": "s3", "containerPort": GARAGE_S3_PORT}, {"name": "admin", "containerPort": GARAGE_ADMIN_PORT}],
                                "readinessProbe": tcp(GARAGE_S3_PORT),
                                "volumeMounts": [{"name": "tls", "mountPath": "/tls", "readOnly": true}],
                                "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "64Mi"}},
                                "securityContext": container_security(),
                            },
                        ],
                        "volumes": [
                            {"name": "config", "configMap": {"name": name(cr, "garage-config")}},
                            {"name": "internal", "secret": {"secretName": garage_internal_secret(cr), "defaultMode": 0o440}},
                            {"name": "tls", "secret": {"secretName": garage_tls_secret(cr), "defaultMode": 0o440, "items": [{"key": "tls.crt", "path": "tls.crt"}, {"key": "tls.key", "path": "tls.key"}]}},
                        ],
                    }
                }
            }}),
        ),
    ]
}

/// Kinds the operator owns and prunes when they are no longer desired.
pub const PRUNED: &[(&str, &str, &str)] = &[
    ("apps", "v1", "Deployment"),
    ("apps", "v1", "StatefulSet"),
    ("", "v1", "Service"),
    ("", "v1", "ConfigMap"),
    ("policy", "v1", "PodDisruptionBudget"),
    ("autoscaling", "v2", "HorizontalPodAutoscaler"),
    ("networking.k8s.io", "v1", "NetworkPolicy"),
    ("networking.k8s.io", "v1", "Ingress"),
    ("batch", "v1", "Job"),
    ("", "v1", "PersistentVolumeClaim"),
];
/// Optional kinds pruned only when their API exists.
pub const PRUNED_OPTIONAL: &[(&str, &str, &str)] = &[
    ("gateway.networking.k8s.io", "v1", "HTTPRoute"),
    ("cert-manager.io", "v1", "Certificate"),
    ("keda.sh", "v1alpha1", "ScaledObject"),
    ("postgresql.cnpg.io", "v1", "ScheduledBackup"),
];

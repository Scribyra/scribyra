//! Controller integration tests against a real kube-apiserver, etcd and controller manager
//! (see `support`). One control plane per run; the scenarios run concurrently, each in its own
//! namespace with its own controller instance watching only that namespace.
//!
//! Untested here (needs a real cluster): pods actually starting, images, scheduling,
//! networking and NetworkPolicy enforcement, CloudNativePG, Garage in a pod, ingress and TLS,
//! gVisor, KEDA, the operator's own Deployment and leader election across pods.

mod support;

use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Namespace, PersistentVolumeClaim, Pod, Secret};
use kube::api::{Api, DeleteParams, DynamicObject, ListParams, Patch, PatchParams, PostParams};
use kube::core::{ApiResource, GroupVersionKind};
use kube::{Client, ResourceExt};
use scribyra_operator::crd::Scribyra;
use scribyra_operator::versions::Release;
use scribyra_operator::{Settings, manifests, metrics::Metrics};
use serde_json::{Value, json};
use std::sync::Arc;
use support::{ControlPlane, eventually};

const OPERATOR_SA: &str = "system:serviceaccount:scribyra-system:scribyra-operator";

fn releases(single_writer: bool) -> Vec<Release> {
    vec![
        Release { version: "1.0.0".into(), upgrades_from: None, single_writer },
        Release { version: "1.1.0".into(), upgrades_from: Some(">=1.0.0, <1.1.0".into()), single_writer },
        Release { version: "1.2.0".into(), upgrades_from: Some(">=1.1.0, <1.2.0".into()), single_writer },
    ]
}

async fn apply_value(client: &Client, value: &Value) {
    let (group, version) = value["apiVersion"].as_str().unwrap().rsplit_once('/').unwrap_or(("", value["apiVersion"].as_str().unwrap()));
    let ar = ApiResource::from_gvk(&GroupVersionKind::gvk(group, version, value["kind"].as_str().unwrap()));
    let name = value["metadata"]["name"].as_str().unwrap();
    let api: Api<DynamicObject> = match value["metadata"]["namespace"].as_str() {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None if ["Namespace", "CustomResourceDefinition", "ClusterRole", "ClusterRoleBinding"].contains(&value["kind"].as_str().unwrap()) => Api::all_with(client.clone(), &ar),
        None => panic!("namespace missing"),
    };
    api.patch(name, &PatchParams::apply("envtest").force(), &Patch::Apply(value)).await.unwrap_or_else(|e| panic!("apply {name}: {e}"));
}

/// The CRD and the operator's RBAC from the generated installation (not its Deployment).
async fn install(admin: &Client) {
    let install = manifests::Install { namespace: manifests::DEFAULT_NAMESPACE.into(), image: "operator:test".into(), registry: "registry.test".into() };
    for object in manifests::objects(&install) {
        if object["kind"] != "Deployment" && object["kind"] != "Service" {
            apply_value(admin, &object).await;
        }
    }
    let crds: Api<DynamicObject> = Api::all_with(admin.clone(), &ApiResource::from_gvk(&GroupVersionKind::gvk("apiextensions.k8s.io", "v1", "CustomResourceDefinition")));
    eventually(30, "CRD established", || async {
        let crd = crds.get("scribyras.scribyra.com").await.ok()?;
        crd.data["status"]["conditions"].as_array()?.iter().any(|c| c["type"] == "Established" && c["status"] == "True").then_some(())
    })
    .await;
}

async fn namespace(admin: &Client, name: &str) {
    let api: Api<Namespace> = Api::all(admin.clone());
    api.create(&PostParams::default(), &serde_json::from_value(json!({"metadata": {"name": name}})).unwrap()).await.unwrap();
}

async fn secret(admin: &Client, ns: &str, name: &str, data: &[(&str, &str)]) {
    let api: Api<Secret> = Api::namespaced(admin.clone(), ns);
    let map: serde_json::Map<String, Value> = data.iter().map(|(k, v)| (k.to_string(), Value::from(*v))).collect();
    api.create(&PostParams::default(), &serde_json::from_value(json!({"metadata": {"name": name}, "stringData": map})).unwrap()).await.unwrap();
}

/// A controller watching only `ns`, acting as the operator's service account (so the RBAC in
/// `operator.yaml` is what is exercised).
fn controller(plane_client: Client, ns: &str, releases: Vec<Release>) -> tokio::task::JoinHandle<()> {
    let settings = Settings {
        registry: "registry.test/scribyra".into(),
        operator_image: "registry.test/scribyra/scribyra-operator:test".into(),
        operator_namespace: manifests::DEFAULT_NAMESPACE.into(),
        watch_namespace: Some(ns.into()),
        releases,
        garage_admin_url: "https://127.0.0.1:1".into(),
        api_metrics_url: "http://127.0.0.1:1/metrics".into(),
        identity: format!("envtest-{ns}"),
    };
    tokio::spawn(scribyra_operator::run_controller(plane_client, settings, Arc::new(Metrics::default())))
}

fn base_spec(version: &str) -> Value {
    json!({
        "version": version,
        "domain": "scribyra.test.example.org",
        "oidc": {"providers": [{"name": "idp", "issuer": "https://idp.example.org", "clientId": "scribyra", "clientSecretRef": {"name": "oidc", "key": "secret"}}]},
        "postgres": {"external": {"secretRef": {"name": "db", "key": "url"}}},
        "storage": {"s3": {"endpoint": "https://s3.example.org", "bucket": "scribyra", "secretRef": {"name": "s3"}}},
        "ingress": {"className": "traefik"},
        "replicas": 2,
    })
}

async fn create_cr(client: &Client, ns: &str, name: &str, spec: Value) -> Result<Scribyra, kube::Error> {
    let api: Api<Scribyra> = Api::namespaced(client.clone(), ns);
    api.create(&PostParams::default(), &serde_json::from_value(json!({"apiVersion": "scribyra.com/v1alpha1", "kind": "Scribyra", "metadata": {"name": name, "namespace": ns}, "spec": spec})).unwrap()).await
}

async fn patch_spec(client: &Client, ns: &str, name: &str, patch: Value) {
    let api: Api<Scribyra> = Api::namespaced(client.clone(), ns);
    api.patch(name, &PatchParams::default(), &Patch::Merge(json!({"spec": patch}))).await.unwrap();
}

async fn condition(client: &Client, ns: &str, name: &str, kind: &str) -> Option<(String, String, String)> {
    let api: Api<Scribyra> = Api::namespaced(client.clone(), ns);
    let cr = api.get(name).await.ok()?;
    let c = cr.status?.conditions.into_iter().find(|c| c.type_ == kind)?;
    Some((c.status, c.reason, c.message))
}

async fn wait_condition(client: &Client, ns: &str, name: &str, kind: &str, status: &str, reason: &str) -> String {
    eventually(60, &format!("{ns}/{name} {kind}={status} ({reason})"), || async {
        let (s, r, m) = condition(client, ns, name, kind).await?;
        (s == status && r == reason).then_some(m)
    })
    .await
}

async fn complete_job(admin: &Client, ns: &str, name: &str, succeeded: bool) {
    let api: Api<Job> = Api::namespaced(admin.clone(), ns);
    let now = k8s_openapi::jiff::Timestamp::now().to_string();
    let status = if succeeded {
        json!({"status": {"startTime": now, "completionTime": now, "succeeded": 1, "conditions": [
            {"type": "SuccessCriteriaMet", "status": "True", "reason": "CompletionsReached", "message": "", "lastProbeTime": now, "lastTransitionTime": now},
            {"type": "Complete", "status": "True", "reason": "CompletionsReached", "message": "", "lastProbeTime": now, "lastTransitionTime": now},
        ]}})
    } else {
        json!({"status": {"startTime": now, "failed": 3, "conditions": [
            {"type": "FailureTarget", "status": "True", "reason": "BackoffLimitExceeded", "message": "Job has reached the specified backoff limit", "lastProbeTime": now, "lastTransitionTime": now},
            {"type": "Failed", "status": "True", "reason": "BackoffLimitExceeded", "message": "Job has reached the specified backoff limit", "lastProbeTime": now, "lastTransitionTime": now},
        ]}})
    };
    api.patch_status(name, &PatchParams::default(), &Patch::Merge(status)).await.unwrap_or_else(|e| panic!("job status {name}: {e}"));
}

async fn api_image(client: &Client, ns: &str, name: &str) -> Option<String> {
    let api: Api<Deployment> = Api::namespaced(client.clone(), ns);
    api.get_opt(&format!("{name}-api")).await.ok()??.spec?.template.spec?.containers.first()?.image.clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn controller_against_a_real_api_server() {
    let Some(plane) = ControlPlane::start().await else { return };
    let admin = plane.client(None).await;
    install(&admin).await;
    let operator = plane.client(Some(OPERATOR_SA)).await;
    eprintln!("control plane up at {}", plane.url);

    // Each scenario in its own namespace; run them concurrently.
    let results = futures::future::join_all([
        tokio::spawn(schema_validation(admin.clone())),
        tokio::spawn(install_upgrade_and_blocking(admin.clone(), operator.clone())),
        tokio::spawn(single_writer_stops_before_migrating(admin.clone(), operator.clone())),
        tokio::spawn(failed_migration_keeps_the_old_release(admin.clone(), operator.clone())),
        tokio::spawn(deletion_policies(admin.clone(), operator.clone())),
        tokio::spawn(pruning_and_invalid_spec(admin.clone(), operator.clone())),
        tokio::spawn(leader_election(operator.clone())),
    ])
    .await;
    let mut failed = vec![];
    for (i, r) in results.into_iter().enumerate() {
        if let Err(e) = r {
            failed.push(format!("scenario {i}: {e}"));
        }
    }
    // Provisioned PostgreSQL: first without CloudNativePG, then with its CRDs installed (they
    // are cluster-wide, so this runs after the others).
    if failed.is_empty() {
        if let Err(e) = tokio::spawn(cloudnativepg(admin.clone(), operator.clone())).await {
            failed.push(format!("cloudnativepg: {e}"));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}\ncontrol plane logs: {}", plane.logs());
}

/// The API server enforces the CRD's OpenAPI bounds and CEL rules.
async fn schema_validation(admin: Client) {
    let ns = "schema";
    namespace(&admin, ns).await;
    for sample in ["quickstart", "external", "hosted"] {
        let text = std::fs::read_to_string(format!("{}/../../deploy/operator/samples/{sample}.yaml", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let mut value: Value = serde_yaml::from_str(&text).unwrap();
        value["metadata"]["namespace"] = ns.into();
        let api: Api<Scribyra> = Api::namespaced(admin.clone(), ns);
        api.create(&PostParams { dry_run: true, field_manager: None }, &serde_json::from_value(value).unwrap()).await.unwrap_or_else(|e| panic!("sample {sample} refused: {e}"));
    }
    let refused = |spec: Value, needle: &'static str| {
        let admin = admin.clone();
        async move {
            let err = create_cr(&admin, ns, "bad", spec).await.expect_err(needle);
            let text = err.to_string();
            assert!(text.contains(needle), "expected {needle:?} in {text}");
        }
    };
    let with = |patch: Value| {
        let mut spec = base_spec("1.0.0");
        json_patch(&mut spec, patch);
        spec
    };
    refused(with(json!({"postgres": {"provisioned": {"storageSize": "1Gi"}}})), "exactly one of external and provisioned").await;
    refused(with(json!({"storage": {"s3": null}})), "exactly one of s3 and provisioned").await;
    refused(with(json!({"compile": {"mode": "server"}, "encryption": "endToEnd"})), "server compile needs encryption").await;
    refused(with(json!({"domain": "Not A Domain"})), "spec.domain").await;
    refused(with(json!({"version": "latest"})), "spec.version").await;
    refused(with(json!({"oidc": {"providers": [{"name": "a", "issuer": "http://idp", "clientId": "x", "clientSecretRef": {"name": "s", "key": "k"}}]}})), "spec.oidc.providers[0].issuer").await;
    refused(with(json!({"oidc": {"providers": []}})), "spec.oidc.providers").await;
    let dup = json!({"name": "a", "issuer": "https://idp.example.org", "clientId": "x", "clientSecretRef": {"name": "s", "key": "k"}});
    refused(with(json!({"oidc": {"providers": [dup.clone(), dup]}})), "provider names must be unique").await;
    refused(with(json!({"autoscaling": {"minReplicas": 5, "maxReplicas": 2}})), "maxReplicas must be at least minReplicas").await;
    refused(with(json!({"backup": {"destination": {"destinationPath": "s3://b", "secretRef": {"name": "x"}}}})), "backup is for provisioned PostgreSQL").await;
    refused(with(json!({"ingress": {"className": "nginx", "gateway": {"name": "g"}}})), "either className").await;
    refused(with(json!({"oidc": {"providers": [{"name": "a", "issuer": "https://idp.example.org", "clientId": "x", "clientSecretRef": {"name": "s", "key": "k"}, "roleMapping": {"adminGroups": ["x"]}}]}})), "need groupsClaim").await;
    let long = create_cr(&admin, ns, &"x".repeat(41), base_spec("1.0.0")).await.unwrap_err().to_string();
    assert!(long.contains("at most 40 characters"), "{long}");
    // Transition rules: encryption and the database and storage sources are fixed.
    create_cr(&admin, ns, "fixed", base_spec("1.0.0")).await.unwrap();
    let api: Api<Scribyra> = Api::namespaced(admin.clone(), ns);
    for (patch, needle) in [
        (json!({"spec": {"encryption": "endToEnd"}}), "encryption is fixed after creation"),
        (json!({"spec": {"postgres": {"external": null, "provisioned": {"storageSize": "1Gi"}}}}), "cannot switch between external and provisioned"),
        (json!({"spec": {"storage": {"s3": null, "provisioned": {"size": "1Gi"}}}}), "cannot switch between s3 and provisioned"),
    ] {
        let err = api.patch("fixed", &PatchParams::default(), &Patch::Merge(patch)).await.unwrap_err().to_string();
        assert!(err.contains(needle), "expected {needle:?} in {err}");
    }
    // Defaults are applied by the API server.
    let stored = api.get("fixed").await.unwrap();
    assert_eq!(stored.spec.encryption, scribyra_operator::crd::Encryption::ServerReadable);
    assert_eq!(stored.spec.deletion_policy, scribyra_operator::crd::DeletionPolicy::Retain);
    eprintln!("schema validation: ok");
}

fn json_patch(target: &mut Value, patch: Value) {
    if let (Some(t), Some(p)) = (target.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            if v.is_null() {
                t.remove(k);
            } else if v.is_object() && t.get(k).is_some_and(Value::is_object) {
                json_patch(t.get_mut(k).unwrap(), v.clone());
            } else {
                t.insert(k.clone(), v.clone());
            }
        }
    }
}

async fn dependencies(admin: &Client, ns: &str) {
    secret(admin, ns, "db", &[("url", "postgres://u:p@db.example.org/scribyra?sslmode=verify-full")]).await;
    secret(admin, ns, "s3", &[("access-key-id", "AK"), ("secret-access-key", "SK")]).await;
    secret(admin, ns, "oidc", &[("secret", "client-secret")]).await;
}

/// Fresh install, upgrade with the migration Job before the rollout, and refused upgrades.
async fn install_upgrade_and_blocking(admin: Client, operator: Client) {
    let ns = "upgrade";
    namespace(&admin, ns).await;
    let _controller = controller(operator.clone(), ns, releases(false));
    // Without its Secrets the deployment waits and says why.
    create_cr(&admin, ns, "acme", base_spec("1.0.0")).await.unwrap();
    let message = wait_condition(&admin, ns, "acme", "DatabaseReady", "False", "SecretMissing").await;
    assert!(message.contains("Secret db does not exist"), "{message}");
    let jobs: Api<Job> = Api::namespaced(admin.clone(), ns);
    assert!(jobs.list(&ListParams::default()).await.unwrap().items.is_empty(), "no migration before the database exists");
    dependencies(&admin, ns).await;

    // Fresh install: the migration Job first, no API Deployment until it completes.
    wait_condition(&admin, ns, "acme", "Progressing", "True", "Migrating").await;
    assert!(api_image(&admin, ns, "acme").await.is_none(), "API waits for the first migration");
    let job = jobs.get("acme-migrate-1-0-0").await.unwrap();
    let pod = job.spec.unwrap().template;
    assert_eq!(pod.spec.as_ref().unwrap().containers[0].args.as_ref().unwrap()[0], "migrate");
    assert_eq!(pod.spec.as_ref().unwrap().containers[0].image.as_deref(), Some("registry.test/scribyra/scribyra-sync:1.0.0"));
    // Everything else is there already.
    let secrets: Api<Secret> = Api::namespaced(admin.clone(), ns);
    let config = secrets.get("acme-config").await.unwrap();
    let json: Value = serde_json::from_slice(&config.data.unwrap()["service.json"].0).unwrap();
    assert_eq!(json["public_url"], "https://scribyra.test.example.org");
    assert_eq!(config.metadata.owner_references.unwrap()[0].kind, "Scribyra");
    let master = secrets.get("acme-master-key").await.unwrap();
    assert_eq!(master.data.unwrap()["key"].0.len(), 32);
    assert!(master.metadata.owner_references.is_none(), "the master key outlives the resource");
    let netpols: Api<DynamicObject> = Api::namespaced_with(admin.clone(), ns, &ApiResource::from_gvk(&GroupVersionKind::gvk("networking.k8s.io", "v1", "NetworkPolicy")));
    let mut names: Vec<String> = netpols.list(&ListParams::default()).await.unwrap().items.iter().map(|n| n.name_any()).collect();
    names.sort();
    assert_eq!(names, ["acme-api", "acme-default-deny", "acme-migrate", "acme-web"]);

    complete_job(&admin, ns, "acme-migrate-1-0-0", true).await;
    eventually(60, "API at 1.0.0", || async { (api_image(&admin, ns, "acme").await? == "registry.test/scribyra/scribyra-sync:1.0.0").then_some(()) }).await;
    let api: Api<Scribyra> = Api::namespaced(admin.clone(), ns);
    eventually(30, "status.version 1.0.0", || async { (api.get("acme").await.ok()?.status?.version? == "1.0.0").then_some(()) }).await;
    // Pods exist (pending: no kubelet), so the rollout is not available and Ready is False.
    let pods: Api<Pod> = Api::namespaced(admin.clone(), ns);
    eventually(60, "API pods created by the ReplicaSet", || async { (pods.list(&ListParams::default().labels("app.kubernetes.io/component=api")).await.ok()?.items.len() == 2).then_some(()) }).await;
    let (ready, _, _) = condition(&admin, ns, "acme", "Ready").await.unwrap();
    assert_eq!(ready, "False");
    assert_eq!(condition(&admin, ns, "acme", "DatabaseReady").await.unwrap().0, "True");
    assert_eq!(condition(&admin, ns, "acme", "StorageReady").await.unwrap().0, "True");

    // Upgrade: the new Job runs while the API keeps the old image.
    patch_spec(&admin, ns, "acme", json!({"version": "1.1.0"})).await;
    eventually(60, "migration Job for 1.1.0", || async { jobs.get_opt("acme-migrate-1-1-0").await.ok()?.map(|_| ()) }).await;
    wait_condition(&admin, ns, "acme", "Progressing", "True", "Migrating").await;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert_eq!(api_image(&admin, ns, "acme").await.unwrap(), "registry.test/scribyra/scribyra-sync:1.0.0", "no rollout before the migration completes");
    complete_job(&admin, ns, "acme-migrate-1-1-0", true).await;
    eventually(60, "API at 1.1.0", || async { (api_image(&admin, ns, "acme").await? == "registry.test/scribyra/scribyra-sync:1.1.0").then_some(()) }).await;
    // The previous migration Job is pruned once the new release runs.
    eventually(60, "old Job pruned", || async { jobs.get_opt("acme-migrate-1-0-0").await.ok()?.is_none().then_some(()) }).await;

    // Downgrade: refused, nothing changes.
    patch_spec(&admin, ns, "acme", json!({"version": "1.0.0"})).await;
    let message = wait_condition(&admin, ns, "acme", "UpgradeBlocked", "True", "Downgrade").await;
    assert!(message.contains("never rolled back"), "{message}");
    assert_eq!(api_image(&admin, ns, "acme").await.unwrap(), "registry.test/scribyra/scribyra-sync:1.1.0");
    // Unknown release: refused.
    patch_spec(&admin, ns, "acme", json!({"version": "9.0.0"})).await;
    wait_condition(&admin, ns, "acme", "UpgradeBlocked", "True", "UnknownVersion").await;
    // Back to a valid step clears the block.
    patch_spec(&admin, ns, "acme", json!({"version": "1.2.0"})).await;
    wait_condition(&admin, ns, "acme", "UpgradeBlocked", "False", "None").await;
    eventually(60, "migration Job for 1.2.0", || async { jobs.get_opt("acme-migrate-1-2-0").await.ok()?.map(|_| ()) }).await;
    eprintln!("install, upgrade and blocking: ok");
}

/// A release that holds the single-writer lock: the old pods stop before the migration Job.
async fn single_writer_stops_before_migrating(admin: Client, operator: Client) {
    let ns = "single";
    namespace(&admin, ns).await;
    dependencies(&admin, ns).await;
    let _controller = controller(operator.clone(), ns, releases(true));
    create_cr(&admin, ns, "solo", base_spec("1.0.0")).await.unwrap();
    let jobs: Api<Job> = Api::namespaced(admin.clone(), ns);
    eventually(60, "first Job", || async { jobs.get_opt("solo-migrate-1-0-0").await.ok()?.map(|_| ()) }).await;
    complete_job(&admin, ns, "solo-migrate-1-0-0", true).await;
    let deployments: Api<Deployment> = Api::namespaced(admin.clone(), ns);
    let d = eventually(60, "API Deployment", || async { deployments.get_opt("solo-api").await.ok()? }).await;
    assert_eq!(d.spec.as_ref().unwrap().replicas, Some(1), "spec.replicas 2 is capped to one writer");
    assert_eq!(d.spec.as_ref().unwrap().strategy.as_ref().unwrap().type_.as_deref(), Some("Recreate"));
    let pods: Api<Pod> = Api::namespaced(admin.clone(), ns);
    let api_pods = || async { pods.list(&ListParams::default().labels("app.kubernetes.io/component=api")).await.unwrap().items.len() };
    eventually(60, "one API pod", || async { (api_pods().await == 1).then_some(()) }).await;

    patch_spec(&admin, ns, "solo", json!({"version": "1.1.0"})).await;
    // The operator scales the old release to zero and waits for its pod to go.
    eventually(60, "API scaled to zero", || async { (deployments.get("solo-api").await.ok()?.spec?.replicas? == 0).then_some(()) }).await;
    let job = eventually(90, "Job after the pods stopped", || async { jobs.get_opt("solo-migrate-1-1-0").await.ok()? }).await;
    assert_eq!(api_pods().await, 0, "the migration Job started while an old writer pod existed");
    assert_eq!(api_image(&admin, ns, "solo").await.unwrap(), "registry.test/scribyra/scribyra-sync:1.0.0");
    complete_job(&admin, ns, &job.name_any(), true).await;
    eventually(60, "1.1.0 rolled out with one replica", || async {
        let d = deployments.get("solo-api").await.ok()?;
        let image = d.spec.as_ref()?.template.spec.as_ref()?.containers[0].image.clone()?;
        (image.ends_with(":1.1.0") && d.spec?.replicas? == 1).then_some(())
    })
    .await;
    eprintln!("single writer: ok");
}

/// A failed migration leaves the running release serving and reports why.
async fn failed_migration_keeps_the_old_release(admin: Client, operator: Client) {
    let ns = "failing";
    namespace(&admin, ns).await;
    dependencies(&admin, ns).await;
    let _controller = controller(operator.clone(), ns, releases(true));
    create_cr(&admin, ns, "f", base_spec("1.0.0")).await.unwrap();
    let jobs: Api<Job> = Api::namespaced(admin.clone(), ns);
    eventually(60, "first Job", || async { jobs.get_opt("f-migrate-1-0-0").await.ok()?.map(|_| ()) }).await;
    complete_job(&admin, ns, "f-migrate-1-0-0", true).await;
    let deployments: Api<Deployment> = Api::namespaced(admin.clone(), ns);
    eventually(60, "API", || async { deployments.get_opt("f-api").await.ok()?.map(|_| ()) }).await;
    patch_spec(&admin, ns, "f", json!({"version": "1.1.0"})).await;
    eventually(90, "Job for 1.1.0", || async { jobs.get_opt("f-migrate-1-1-0").await.ok()?.map(|_| ()) }).await;
    complete_job(&admin, ns, "f-migrate-1-1-0", false).await;
    let message = wait_condition(&admin, ns, "f", "Degraded", "True", "MigrationFailed").await;
    assert!(message.contains("backoff limit"), "{message}");
    wait_condition(&admin, ns, "f", "UpgradeBlocked", "True", "MigrationFailed").await;
    eventually(60, "old release scaled back up", || async {
        let d = deployments.get("f-api").await.ok()?;
        (d.spec.as_ref()?.replicas? == 1 && d.spec?.template.spec?.containers[0].image.clone()?.ends_with(":1.0.0")).then_some(())
    })
    .await;
    let api: Api<Scribyra> = Api::namespaced(admin.clone(), ns);
    assert_eq!(api.get("f").await.unwrap().status.unwrap().version.as_deref(), Some("1.0.0"));
    eprintln!("failed migration: ok");
}

/// `Retain` keeps data and generated secrets; `Delete` removes them. Owned objects go with the
/// resource through owner references (the garbage collector runs).
async fn deletion_policies(admin: Client, operator: Client) {
    let ns = "deletion";
    namespace(&admin, ns).await;
    dependencies(&admin, ns).await;
    let _controller = controller(operator.clone(), ns, releases(false));
    let mut keep = base_spec("1.0.0");
    keep["storage"] = json!({"provisioned": {"size": "1Gi"}});
    create_cr(&admin, ns, "keep", keep.clone()).await.unwrap();
    let mut drop = keep.clone();
    drop["deletionPolicy"] = "Delete".into();
    create_cr(&admin, ns, "drop", drop).await.unwrap();
    let secrets: Api<Secret> = Api::namespaced(admin.clone(), ns);
    let pvcs: Api<PersistentVolumeClaim> = Api::namespaced(admin.clone(), ns);
    for name in ["keep", "drop"] {
        eventually(60, "generated secrets", || async {
            for s in ["master-key", "garage-internal", "garage-tls"] {
                secrets.get_opt(&format!("{name}-{s}")).await.ok()??;
            }
            Some(())
        })
        .await;
        // Garage never becomes ready without a kubelet: storage waits, no migration starts.
        wait_condition(&admin, ns, name, "StorageReady", "False", "Provisioning").await;
        let sts: Api<DynamicObject> = Api::namespaced_with(admin.clone(), ns, &ApiResource::from_gvk(&GroupVersionKind::gvk("apps", "v1", "StatefulSet")));
        sts.get(&format!("{name}-garage")).await.unwrap();
        // Stand-ins for what Garage's first start and bootstrap leave behind.
        eventually(60, "Garage volume claim from the StatefulSet controller", || async {
            (!pvcs.list(&ListParams::default().labels(&format!("scribyra.com/instance={name}"))).await.ok()?.items.is_empty()).then_some(())
        })
        .await;
        secret(&admin, ns, &format!("{name}-garage-s3"), &[("access-key-id", "GK"), ("secret-access-key", "x")]).await;
    }
    let tls = secrets.get("keep-garage-tls").await.unwrap().data.unwrap();
    assert!(String::from_utf8_lossy(&tls["ca.crt"].0).contains("BEGIN CERTIFICATE"));
    let api: Api<Scribyra> = Api::namespaced(admin.clone(), ns);
    for name in ["keep", "drop"] {
        assert!(api.get(name).await.unwrap().finalizers().iter().any(|f| f == "scribyra.com/cleanup"));
        api.delete(name, &DeleteParams::default()).await.unwrap();
    }
    for name in ["keep", "drop"] {
        eventually(60, "resource gone after its finalizer", || async { api.get_opt(name).await.ok()?.is_none().then_some(()) }).await;
        eventually(60, "owned config Secret collected", || async { secrets.get_opt(&format!("{name}-config")).await.ok()?.is_none().then_some(()) }).await;
    }
    assert!(secrets.get_opt("keep-master-key").await.unwrap().is_some(), "Retain keeps the master key");
    assert!(secrets.get_opt("keep-garage-s3").await.unwrap().is_some(), "Retain keeps the storage credentials");
    assert!(!pvcs.list(&ListParams::default().labels("scribyra.com/instance=keep")).await.unwrap().items.is_empty(), "Retain keeps the volume");
    assert!(secrets.get_opt("drop-master-key").await.unwrap().is_none(), "Delete removes the master key");
    assert!(secrets.get_opt("drop-garage-s3").await.unwrap().is_none(), "Delete removes the storage credentials");
    eventually(60, "Delete removes the volume claim", || async {
        let left = pvcs.list(&ListParams::default().labels("scribyra.com/instance=drop")).await.ok()?.items;
        left.iter().all(|p| p.metadata.deletion_timestamp.is_some()).then_some(())
    })
    .await;
    eprintln!("deletion policies: ok");
}

/// Turning a component off removes its objects; a spec the service would refuse deploys nothing.
async fn pruning_and_invalid_spec(admin: Client, operator: Client) {
    let ns = "prune";
    namespace(&admin, ns).await;
    dependencies(&admin, ns).await;
    let _controller = controller(operator.clone(), ns, releases(false));
    let mut spec = base_spec("1.0.0");
    spec["compile"] = json!({"mode": "both", "runtimeClassName": "gvisor", "workers": {"minReplicas": 1, "maxReplicas": 3}});
    create_cr(&admin, ns, "p", spec).await.unwrap();
    let jobs: Api<Job> = Api::namespaced(admin.clone(), ns);
    eventually(60, "Job", || async { jobs.get_opt("p-migrate-1-0-0").await.ok()?.map(|_| ()) }).await;
    complete_job(&admin, ns, "p-migrate-1-0-0", true).await;
    let deployments: Api<Deployment> = Api::namespaced(admin.clone(), ns);
    let worker = eventually(60, "worker Deployment", || async { deployments.get_opt("p-worker").await.ok()? }).await;
    assert_eq!(worker.spec.as_ref().unwrap().replicas, Some(1), "scaler keeps minReplicas when the queue metric is unreachable");
    let pod = worker.spec.unwrap().template.spec.unwrap();
    assert_eq!(pod.runtime_class_name.as_deref(), Some("gvisor"));
    assert_eq!(pod.host_users, Some(false));
    let api: Api<Scribyra> = Api::namespaced(admin.clone(), ns);
    eventually(30, "worker status", || async { (api.get("p").await.ok()?.status?.compile_workers?.desired_replicas == 1).then_some(()) }).await;
    patch_spec(&admin, ns, "p", json!({"compile": {"mode": "browser"}})).await;
    eventually(60, "worker pruned", || async { deployments.get_opt("p-worker").await.ok()?.is_none().then_some(()) }).await;
    let netpols: Api<DynamicObject> = Api::namespaced_with(admin.clone(), ns, &ApiResource::from_gvk(&GroupVersionKind::gvk("networking.k8s.io", "v1", "NetworkPolicy")));
    eventually(60, "worker policy pruned", || async { netpols.get_opt("p-worker").await.ok()?.is_none().then_some(()) }).await;
    // Autoscaling replaces the fixed replica count with an HPA.
    patch_spec(&admin, ns, "p", json!({"autoscaling": {"minReplicas": 2, "maxReplicas": 4}})).await;
    let hpas: Api<DynamicObject> = Api::namespaced_with(admin.clone(), ns, &ApiResource::from_gvk(&GroupVersionKind::gvk("autoscaling", "v2", "HorizontalPodAutoscaler")));
    eventually(60, "HPA", || async { hpas.get_opt("p-api").await.ok()?.map(|_| ()) }).await;
    patch_spec(&admin, ns, "p", json!({"autoscaling": null})).await;
    eventually(60, "HPA pruned", || async { hpas.get_opt("p-api").await.ok()?.is_none().then_some(()) }).await;

    // The schema admits it, the service would refuse it: reported, nothing deployed.
    let mut bad = base_spec("1.0.0");
    bad["policy"] = json!({"admins": ["Not An Email"]});
    create_cr(&admin, ns, "bad", bad).await.unwrap();
    let message = wait_condition(&admin, ns, "bad", "Degraded", "True", "InvalidSpec").await;
    assert!(message.contains("admins"), "{message}");
    let secrets: Api<Secret> = Api::namespaced(admin.clone(), ns);
    assert!(secrets.get_opt("bad-config").await.unwrap().is_none());
    eprintln!("pruning and invalid spec: ok");
}

/// Provisioned PostgreSQL: a clear condition without CloudNativePG; with its API, a `Cluster`
/// without an owner reference (deleting it would delete the database volumes).
async fn cloudnativepg(admin: Client, operator: Client) {
    let ns = "cnpg";
    namespace(&admin, ns).await;
    dependencies(&admin, ns).await;
    let mut spec = base_spec("1.0.0");
    spec["postgres"] = json!({"provisioned": {"storageSize": "5Gi", "instances": 1}});
    spec["backup"] = json!({"destination": {"destinationPath": "s3://backups/db", "endpointURL": "https://s3.example.org", "secretRef": {"name": "s3"}}});
    let first = controller(operator.clone(), ns, releases(false));
    create_cr(&admin, ns, "pg", spec).await.unwrap();
    let message = wait_condition(&admin, ns, "pg", "DatabaseReady", "False", "CloudNativePGMissing").await;
    assert!(message.contains("CloudNativePG"), "{message}");
    first.abort();
    // Minimal stand-ins for the CloudNativePG CRDs (schema not validated here).
    for (plural, kind) in [("clusters", "Cluster"), ("scheduledbackups", "ScheduledBackup")] {
        apply_value(&admin, &json!({
            "apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
            "metadata": {"name": format!("{plural}.postgresql.cnpg.io")},
            "spec": {"group": "postgresql.cnpg.io", "scope": "Namespaced", "names": {"plural": plural, "singular": kind.to_lowercase(), "kind": kind},
                "versions": [{"name": "v1", "served": true, "storage": true, "subresources": {"status": {}},
                    "schema": {"openAPIV3Schema": {"type": "object", "x-kubernetes-preserve-unknown-fields": true}}}]}
        }))
        .await;
    }
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let _second = controller(operator.clone(), ns, releases(false));
    let clusters: Api<DynamicObject> = Api::namespaced_with(admin.clone(), ns, &ApiResource::from_gvk(&GroupVersionKind::gvk("postgresql.cnpg.io", "v1", "Cluster")));
    let cluster = eventually(60, "CloudNativePG Cluster", || async { clusters.get_opt("pg-db").await.ok()? }).await;
    assert!(cluster.metadata.owner_references.is_none());
    assert_eq!(cluster.data["spec"]["backup"]["barmanObjectStore"]["destinationPath"], "s3://backups/db");
    wait_condition(&admin, ns, "pg", "DatabaseReady", "False", "Provisioning").await;
    // CloudNativePG reports a ready instance and creates the app Secret.
    clusters.patch_status("pg-db", &PatchParams::default(), &Patch::Merge(json!({"status": {"readyInstances": 1, "phase": "Cluster in healthy state"}}))).await.unwrap();
    secret(&admin, ns, "pg-db-app", &[("uri", "postgresql://scribyra:x@pg-db-rw.cnpg:5432/scribyra")]).await;
    wait_condition(&admin, ns, "pg", "DatabaseReady", "True", "Ready").await;
    let backups: Api<DynamicObject> = Api::namespaced_with(admin.clone(), ns, &ApiResource::from_gvk(&GroupVersionKind::gvk("postgresql.cnpg.io", "v1", "ScheduledBackup")));
    let scheduled = backups.get("pg-db-scheduled").await.unwrap();
    assert_eq!(scheduled.data["spec"]["cluster"]["name"], "pg-db");
    let jobs: Api<Job> = Api::namespaced(admin.clone(), ns);
    let job = eventually(60, "migration Job", || async { jobs.get_opt("pg-migrate-1-0-0").await.ok()? }).await;
    let volumes = serde_json::to_string(&job.spec.unwrap().template.spec.unwrap().volumes).unwrap();
    assert!(volumes.contains("pg-db-app"), "the Job reads the CloudNativePG URL Secret");
    eprintln!("cloudnativepg: ok");
}

/// Two replicas, one lease (with the operator's namespaced Role only).
async fn leader_election(operator: Client) {
    use scribyra_operator::leader::Elector;
    let a = Elector::new(operator.clone(), manifests::DEFAULT_NAMESPACE, manifests::LEASE, "replica-a");
    let b = Elector::new(operator.clone(), manifests::DEFAULT_NAMESPACE, manifests::LEASE, "replica-b");
    assert!(a.try_acquire().await.unwrap(), "first replica takes the lease");
    assert!(!b.try_acquire().await.unwrap(), "second replica stays standby");
    assert!(a.try_acquire().await.unwrap(), "holder renews");
    // Another lease name is outside the Role's resourceNames.
    let other = Elector::new(operator, manifests::DEFAULT_NAMESPACE, "someone-else", "replica-a");
    assert!(other.try_acquire().await.is_err(), "RBAC limits the operator to its own lease");
    eprintln!("leader election: ok");
}

//! Resource generation without a cluster: snapshots of every generated manifest for the sample
//! resources, the generated installation files, the service's own validation of the generated
//! configuration, and the security properties every pod and policy must keep.
//!
//! `UPDATE_SNAPSHOTS=1 cargo test -p scribyra-operator --test manifests` rewrites the snapshots
//! and the checked-in installation files; review the diff.

use scribyra_operator::crd::Scribyra;
use scribyra_operator::resources::{self, Capabilities, Env, Object, Plan};
use scribyra_operator::{manifests, service_config};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn sample(name: &str) -> Scribyra {
    let text = std::fs::read_to_string(root().join(format!("deploy/operator/samples/{name}.yaml"))).unwrap();
    let mut cr: Scribyra = serde_yaml::from_str(&text).unwrap();
    cr.metadata.uid = Some("00000000-0000-0000-0000-000000000001".into());
    cr
}
fn env(all: bool) -> Env {
    Env {
        registry: "registry.example/scribyra".into(),
        operator_image: "registry.example/scribyra/scribyra-operator:0.1.0".into(),
        operator_namespace: "scribyra-system".into(),
        capabilities: Capabilities { cnpg: true, keda: all, gateway: all, cert_manager: all },
    }
}
fn plan(cr: &Scribyra) -> Plan {
    Plan { version: cr.spec.version.clone(), single_writer: false, stopped: false, worker_replicas: 1 }
}
fn all_objects(cr: &Scribyra, env: &Env, plan: &Plan) -> Vec<Object> {
    let mut objects = resources::desired(cr, env, plan);
    objects.push(resources::migration_job(cr, env, plan));
    objects
}
fn check_file(path: &Path, actual: &str) {
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, actual).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(path).unwrap_or_default();
    assert!(expected == actual, "{} is out of date; rerun with UPDATE_SNAPSHOTS=1 and review the diff", path.display());
}

#[test]
fn snapshots_of_generated_manifests() {
    for name in ["quickstart", "external", "hosted"] {
        let cr = sample(name);
        let objects = all_objects(&cr, &env(true), &plan(&cr));
        let yaml = manifests::yaml(&objects.into_iter().map(|o| o.value).collect::<Vec<_>>());
        check_file(&root().join(format!("crates/operator/tests/snapshots/{name}.yaml")), &yaml);
    }
}

#[test]
fn installation_files_match_the_generator() {
    let install = manifests::Install { namespace: manifests::DEFAULT_NAMESPACE.into(), image: "ghcr.io/scribyra/scribyra-operator:0.1.0".into(), registry: "ghcr.io/scribyra".into() };
    check_file(&root().join("deploy/operator/operator.yaml"), &manifests::yaml(&manifests::objects(&install)));
    check_file(&root().join("deploy/helm/scribyra-operator/crds/scribyra.com_scribyras.yaml"), &manifests::yaml(&[manifests::crd()]));
    check_file(&root().join("deploy/helm/scribyra-operator/files/clusterrole-rules.yaml"), &serde_yaml::to_string(&manifests::cluster_rules()).unwrap());
}

#[test]
fn generated_configuration_passes_the_services_validation() {
    for name in ["quickstart", "external", "hosted"] {
        let cr = sample(name);
        service_config::check(&cr).unwrap_or_else(|e| panic!("{name}: {e}"));
        let json = service_config::service_json(&cr);
        // Strict parse: an unknown or renamed field fails here, as it would at service start.
        let _: scribyra_sync::config::Config = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(json["public_url"], format!("https://{}", cr.spec.domain));
        assert!(json.get("s3_access_key_id").is_none(), "the access key ID comes from the Secret through the environment");
    }
    let quick = service_config::service_json(&sample("quickstart"));
    assert_eq!(quick["s3_endpoint"], "https://lab-garage.lab.svc:3943");
    assert_eq!(quick["s3_ca_file"], service_config::S3_CA_FILE);
    // Identity is the providers' (presets, role names); the configuration names no administrators.
    let provider = &quick["deployment"]["providers"][0];
    assert_eq!(provider["preset"], "keycloak");
    assert_eq!(provider["roles"]["admin"][0], "scribyra-admin");
    assert!(quick["deployment"].get("admins").is_none());
    assert_eq!(quick["deployment"]["notify_on_admin_access"], true);
    // The migration Job migrates; serving pods never do.
    assert_eq!(quick["migrate_on_start"], false);
    let hosted = service_config::service_json(&sample("hosted"));
    let d = &hosted["deployment"];
    assert_eq!(d["providers"][0]["preset"], "google");
    assert_eq!(d["providers"][0]["hosted_domains"][0], "tenant42.example.com");
    assert_eq!(d["providers"][1]["claims"]["guest"]["path"], "$.acct");
    assert_eq!(d["providers"][1]["roles"]["guest"][0], "partners");
    assert_eq!(d["primary_organisation"]["provider"], "corp");
    // Server compile runs the browser's WebAssembly engine; no TeX Live anywhere.
    assert_eq!(d["compile_engine"], "wasm");
    assert!(d["texlive"].is_null());
    assert_eq!(d["tex_mirror"], scribyra_sync::config::DEFAULT_TEX_MIRROR);
    assert_eq!(d["compile_limits"]["cpu_seconds"], 300);
    // Listeners only some pods have are per-pod overrides, not in the shared configuration.
    assert!(hosted.get("metrics_bind").is_none() && hosted.get("compile_worker_bind").is_none());
    let external = service_config::service_json(&sample("external"));
    assert_eq!(external["deployment"]["encryption"], "e2ee");
    assert!(external.get("service_key_file").is_none(), "end-to-end deployments have no master key");
}

#[test]
fn the_services_validation_refuses_what_it_would_refuse_at_start() {
    let mut cr = sample("external");
    cr.spec.oidc.providers[0].issuer = "https://idp.example.org/?x=1".into();
    assert!(service_config::check(&cr).is_err());
    let mut cr = sample("external");
    cr.spec.compile.mode = scribyra_operator::crd::CompileMode::Server;
    assert!(service_config::check(&cr).unwrap_err().contains("compile"), "server compile with e2ee");
}

fn pods(objects: &[Object]) -> Vec<(String, Value)> {
    objects
        .iter()
        .filter_map(|o| match o.kind() {
            "Deployment" | "StatefulSet" | "Job" => Some((format!("{}/{}", o.kind(), o.name()), o.value["spec"]["template"].clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn every_pod_meets_the_restricted_pod_security_standard() {
    for name in ["quickstart", "external", "hosted"] {
        let cr = sample(name);
        for (what, pod) in pods(&all_objects(&cr, &env(true), &plan(&cr))) {
            let spec = &pod["spec"];
            assert_eq!(spec["securityContext"]["runAsNonRoot"], true, "{what}");
            assert_eq!(spec["securityContext"]["seccompProfile"]["type"], "RuntimeDefault", "{what}");
            assert_eq!(spec["automountServiceAccountToken"], false, "{what}");
            for c in spec["containers"].as_array().unwrap() {
                let sc = &c["securityContext"];
                assert_eq!(sc["allowPrivilegeEscalation"], false, "{what}");
                assert_eq!(sc["readOnlyRootFilesystem"], true, "{what}");
                assert_eq!(sc["capabilities"]["drop"][0], "ALL", "{what}");
                assert!(sc.get("privileged").is_none() && sc["capabilities"].get("add").is_none(), "{what}");
            }
            for v in spec["volumes"].as_array().into_iter().flatten() {
                assert!(v.get("hostPath").is_none(), "{what}");
            }
        }
    }
}

#[test]
fn secrets_are_mounted_as_files_and_never_inlined() {
    let cr = sample("hosted");
    let objects = all_objects(&cr, &env(true), &plan(&cr));
    let api = objects.iter().find(|o| o.kind() == "Deployment" && o.name() == "tenant-42-api").unwrap();
    let text = serde_json::to_string(&api.value).unwrap();
    for secret in ["tenant-42-google", "tenant-42-corp", "tenant-42-s3", "tenant-42-db-app", "tenant-42-master-key"] {
        assert!(text.contains(secret), "{secret}");
    }
    let config = objects.iter().find(|o| o.kind() == "Secret").unwrap();
    let json = config.value["stringData"]["service.json"].as_str().unwrap();
    assert!(json.contains("/etc/scribyra/secrets/oidc-google"));
    // Only paths: the operator never reads referenced secret values.
    assert!(!json.contains("client-secret\""));
}

#[test]
fn network_policies_isolate_each_component() {
    let cr = sample("hosted");
    let objects = all_objects(&cr, &env(true), &plan(&cr));
    let np = |n: &str| objects.iter().find(|o| o.kind() == "NetworkPolicy" && o.name() == format!("tenant-42-{n}")).unwrap_or_else(|| panic!("{n}")).value["spec"].clone();
    let deny = np("default-deny");
    assert_eq!(deny["policyTypes"], serde_json::json!(["Ingress", "Egress"]));
    assert!(deny.get("ingress").unwrap().as_array().unwrap().is_empty() && deny["egress"].as_array().unwrap().is_empty());
    // The web app has no egress rule at all (only the default deny applies).
    assert_eq!(np("web")["policyTypes"], serde_json::json!(["Ingress"]));
    // Workers: DNS, PostgreSQL, storage, and HTTPS for the TeX mirror (any address: no
    // mirrorCidrs); nothing else.
    let worker = np("worker");
    let egress = worker["egress"].as_array().unwrap();
    assert_eq!(egress.len(), 4);
    assert!(egress[1]["to"][0]["podSelector"]["matchLabels"]["cnpg.io/cluster"] == "tenant-42-db");
    assert_eq!(egress[3]["ports"][0]["port"], 443);
    // Without a mirror (bundled packages only) the workers reach no internet address at all.
    let mut offline = sample("hosted");
    offline.spec.compile.tex_mirror = Some(String::new());
    let objects = all_objects(&offline, &env(true), &plan(&offline));
    let worker = objects.iter().find(|o| o.kind() == "NetworkPolicy" && o.name() == "tenant-42-worker").unwrap();
    assert_eq!(worker.value["spec"]["egress"].as_array().unwrap().len(), 3);
    let migrate = objects.iter().find(|o| o.kind() == "NetworkPolicy" && o.name() == "tenant-42-migrate").unwrap();
    assert_eq!(worker.value["spec"]["egress"], migrate.value["spec"]["egress"], "only DNS, PostgreSQL and storage, as the migration Job");
    let mut narrowed = sample("hosted");
    narrowed.spec.compile.tex_mirror = Some("https://mirror.example.net:8443/tlnet".into());
    narrowed.spec.compile.mirror_cidrs = vec!["198.51.100.7/32".into()];
    let objects = all_objects(&narrowed, &env(true), &plan(&narrowed));
    let worker = objects.iter().find(|o| o.kind() == "NetworkPolicy" && o.name() == "tenant-42-worker").unwrap();
    assert_eq!(worker.value["spec"]["egress"][3], serde_json::json!({"to": [{"ipBlock": {"cidr": "198.51.100.7/32"}}], "ports": [{"protocol": "TCP", "port": 8443}]}));
    // API: DNS, PostgreSQL, storage, OIDC (443).
    assert_eq!(np("api")["egress"].as_array().unwrap().len(), 4);
    // Ingress restricted to the gateway namespace from the spec.
    assert_eq!(np("api")["ingress"][0]["from"][0]["namespaceSelector"]["matchLabels"]["kubernetes.io/metadata.name"], "gateway-system");
}

#[test]
fn data_objects_carry_no_owner_reference() {
    let cr = sample("quickstart");
    let objects = all_objects(&cr, &env(false), &plan(&cr));
    let cluster = objects.iter().find(|o| o.kind() == "Cluster").unwrap();
    assert!(cluster.value["metadata"].get("ownerReferences").is_none(), "deleting the Cluster would delete the database volumes");
    let sts = objects.iter().find(|o| o.kind() == "StatefulSet").unwrap();
    assert_eq!(sts.value["spec"]["persistentVolumeClaimRetentionPolicy"]["whenDeleted"], "Retain");
    let hosted = sample("hosted");
    let deleting = all_objects(&hosted, &env(false), &plan(&hosted));
    assert!(deleting.iter().all(|o| o.kind() != "StatefulSet"), "external storage: no Garage");
    for o in objects.iter().filter(|o| o.kind() != "Cluster") {
        assert!(o.value["metadata"]["ownerReferences"][0]["uid"] == "00000000-0000-0000-0000-000000000001", "{} {}", o.kind(), o.name());
    }
}

#[test]
fn server_readable_runs_several_api_replicas_and_end_to_end_one() {
    // The API's listener for Prometheus is a per-pod override.
    let cr = sample("quickstart");
    let objects = resources::desired(&cr, &env(false), &plan(&cr));
    let api = objects.iter().find(|o| o.kind() == "Deployment" && o.name() == "lab-api").unwrap();
    assert!(api.value["spec"]["template"]["spec"]["containers"][0]["env"].as_array().unwrap().iter().any(|e| e["name"] == "SCRIBYRA_SERVICE_METRICS_BIND" && e["value"] == "0.0.0.0:9090"));
    let mut cr = sample("quickstart");
    cr.spec.replicas = 3;
    let objects = resources::desired(&cr, &env(false), &plan(&cr));
    let api = objects.iter().find(|o| o.kind() == "Deployment" && o.name() == "lab-api").unwrap();
    assert_eq!(api.value["spec"]["replicas"], 3);
    assert_eq!(api.value["spec"]["strategy"]["type"], "RollingUpdate");
    assert_eq!(api.value["spec"]["strategy"]["rollingUpdate"]["maxUnavailable"], 0);
    // End to end: the API takes the database exclusively, so one replica, replaced not rolled.
    let mut cr = sample("external");
    cr.spec.replicas = 3;
    let objects = resources::desired(&cr, &env(false), &plan(&cr));
    let api = objects.iter().find(|o| o.kind() == "Deployment" && o.name() == "acme-api").unwrap();
    assert_eq!(api.value["spec"]["replicas"], 1);
    assert_eq!(api.value["spec"]["strategy"]["type"], "Recreate");
}

#[test]
fn single_writer_releases_run_one_replica_with_recreate() {
    let cr = sample("hosted");
    let p = Plan { single_writer: true, ..plan(&cr) };
    let objects = resources::desired(&cr, &env(true), &p);
    let api = objects.iter().find(|o| o.kind() == "Deployment" && o.name() == "tenant-42-api").unwrap();
    assert_eq!(api.value["spec"]["replicas"], 1);
    assert_eq!(api.value["spec"]["strategy"]["type"], "Recreate");
    assert!(objects.iter().all(|o| o.kind() != "HorizontalPodAutoscaler"));
    let stopped = resources::desired(&cr, &env(true), &Plan { stopped: true, ..p });
    let api = stopped.iter().find(|o| o.kind() == "Deployment" && o.name() == "tenant-42-api").unwrap();
    assert_eq!(api.value["spec"]["replicas"], 0);
    let worker = stopped.iter().find(|o| o.kind() == "Deployment" && o.name() == "tenant-42-worker").unwrap();
    assert_eq!(worker.value["spec"]["replicas"], 0);
}

#[test]
fn autoscaled_api_leaves_replicas_to_the_hpa() {
    let cr = sample("hosted");
    let objects = resources::desired(&cr, &env(true), &plan(&cr));
    let api = objects.iter().find(|o| o.kind() == "Deployment" && o.name() == "tenant-42-api").unwrap();
    assert!(api.value["spec"].get("replicas").is_none());
    let hpa = objects.iter().find(|o| o.kind() == "HorizontalPodAutoscaler").unwrap();
    assert_eq!(hpa.value["spec"]["maxReplicas"], 10);
}

#[test]
fn workers_are_sandbox_ready() {
    let cr = sample("hosted");
    let objects = resources::desired(&cr, &env(false), &plan(&cr));
    let worker = objects.iter().find(|o| o.name() == "tenant-42-worker" && o.kind() == "Deployment").unwrap();
    let pod = &worker.value["spec"]["template"]["spec"];
    assert_eq!(pod["runtimeClassName"], "gvisor");
    assert_eq!(pod["hostUsers"], false);
    let container = &pod["containers"][0];
    assert_eq!(container["args"][0], "compile-worker");
    // One worker image per release: Node 22 and the WebAssembly compile runtime, no TeX Live.
    assert_eq!(container["image"], "registry.example/scribyra/scribyra-worker:0.2.0");
    let env_of = |name: &str| container["env"].as_array().unwrap().iter().find(|e| e["name"] == name).and_then(|e| e["value"].as_str()).map(str::to_owned);
    assert_eq!(env_of("SCRIBYRA_SERVICE_COMPILE_WORKER_BIND").as_deref(), Some("0.0.0.0:8788"));
    assert_eq!(env_of("SCRIBYRA_SERVICE_METRICS_BIND").as_deref(), Some("0.0.0.0:9090"));
    assert_eq!(env_of("SCRIBYRA_SERVICE_COMPILE_RUNTIME").as_deref(), Some("/opt/scribyra/compile-runtime"));
    assert_eq!(env_of("SCRIBYRA_SERVICE_COMPILE_CACHE").as_deref(), Some("/var/cache/scribyra/tex"));
    assert_eq!(env_of("SCRIBYRA_COMPILE_CGROUP").as_deref(), Some("/sys/fs/cgroup"));
    assert_eq!(container["readinessProbe"]["httpGet"]["path"], "/readyz");
    assert_eq!(container["readinessProbe"]["httpGet"]["port"], "probes");
    // The shared package cache: a writable claim (the root file system stays read-only).
    assert!(container["volumeMounts"].as_array().unwrap().iter().any(|m| m["mountPath"] == "/var/cache/scribyra/tex" && m.get("readOnly").is_none()));
    assert!(pod["volumes"].as_array().unwrap().iter().any(|v| v["persistentVolumeClaim"]["claimName"] == "tenant-42-compile-cache"));
    let claim = objects.iter().find(|o| o.kind() == "PersistentVolumeClaim").unwrap();
    assert_eq!(claim.name(), "tenant-42-compile-cache");
    assert_eq!(claim.value["spec"]["accessModes"][0], "ReadWriteMany");
    assert_eq!(claim.value["spec"]["storageClassName"], "shared-files");
    assert_eq!(claim.value["spec"]["resources"]["requests"]["storage"], "10Gi");
    // About 1 GiB requested per concurrent job (two here) plus the worker; the limit lets each
    // job reach its own memoryMiB cap.
    assert_eq!(container["resources"]["requests"]["memory"], "2304Mi");
    assert_eq!(container["resources"]["limits"]["memory"], "4352Mi");
    assert_eq!(worker.value["spec"]["replicas"], 1, "operator scaler without KEDA");
    let keda = resources::desired(&cr, &env(true), &plan(&cr));
    assert!(keda.iter().all(|o| o.kind() != "ScaledObject"), "KEDA needs prometheusAddress");
}

#[test]
fn routing_sends_the_api_prefix_to_the_api_and_the_rest_to_the_web_app() {
    let cr = sample("quickstart");
    let objects = resources::desired(&cr, &env(false), &plan(&cr));
    let ingress = objects.iter().find(|o| o.kind() == "Ingress").unwrap();
    assert_eq!(ingress.value["metadata"]["annotations"]["cert-manager.io/cluster-issuer"], "letsencrypt");
    let paths = &ingress.value["spec"]["rules"][0]["http"]["paths"];
    assert_eq!(paths[0]["path"], "/v1");
    assert_eq!(paths[0]["backend"]["service"]["name"], "lab-api");
    assert_eq!(paths[1]["backend"]["service"]["name"], "lab-web");
    let hosted = sample("hosted");
    let objects = resources::desired(&hosted, &env(true), &plan(&hosted));
    assert!(objects.iter().any(|o| o.kind() == "HTTPRoute"));
    assert!(objects.iter().all(|o| o.kind() != "Ingress"));
}

#[test]
fn migration_jobs_are_named_per_release() {
    let cr = sample("quickstart");
    assert_eq!(resources::migrate_job(&cr, "1.4.0"), "lab-migrate-1-4-0");
    let long = resources::migrate_job(&cr, &format!("1.0.0-{}", "x".repeat(60)));
    assert!(long.len() <= 63 && long.starts_with("lab-migrate-"));
    let job = resources::migration_job(&cr, &env(false), &plan(&cr));
    assert_eq!(job.value["spec"]["template"]["spec"]["containers"][0]["args"][0], "migrate");
    assert_eq!(job.value["spec"]["template"]["spec"]["restartPolicy"], "Never");
}

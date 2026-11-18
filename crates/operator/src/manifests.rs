//! The operator's own installation: CRD, least-privilege RBAC and Deployment, generated so the
//! checked-in `deploy/operator/operator.yaml` and the Helm chart's CRD never drift from the
//! code (a test compares them).

use crate::crd::Scribyra;
use kube::CustomResourceExt;
use serde_json::{Value, json};

pub const DEFAULT_NAMESPACE: &str = "scribyra-system";
pub const NAME: &str = "scribyra-operator";
pub const LEASE: &str = "scribyra-operator";
pub const METRICS_PORT: u16 = 8080;

pub struct Install {
    pub namespace: String,
    pub image: String,
    pub registry: String,
}

pub fn crd() -> Value {
    serde_json::to_value(Scribyra::crd()).unwrap()
}

fn rule(groups: &[&str], resources: &[&str], verbs: &[&str]) -> Value {
    json!({"apiGroups": groups, "resources": resources, "verbs": verbs})
}
const MANAGE: &[&str] = &["get", "list", "watch", "create", "patch", "delete"];

/// Cluster-wide permissions: exactly the kinds the operator manages, and nothing it does not
/// write. It never needs `update` (server-side apply), `escalate`, `bind` or wildcards.
pub fn cluster_rules() -> Value {
    json!([
        rule(&["scribyra.com"], &["scribyras"], &["get", "list", "watch", "patch", "update"]),
        rule(&["scribyra.com"], &["scribyras/status"], &["get", "patch", "update"]),
        rule(&["scribyra.com"], &["scribyras/finalizers"], &["update"]),
        // Generated Secrets (configuration, master key, Garage credentials) and checks that
        // referenced Secrets exist. Referenced secret values are mounted into pods, never read
        // into the operator's configuration output.
        rule(&[""], &["secrets", "services", "configmaps"], MANAGE),
        rule(&[""], &["pods"], &["list"]),
        rule(&[""], &["persistentvolumeclaims"], &["list", "delete"]),
        rule(&["events.k8s.io"], &["events"], &["create", "patch"]),
        rule(&["apps"], &["deployments", "statefulsets"], MANAGE),
        rule(&["batch"], &["jobs"], MANAGE),
        rule(&["policy"], &["poddisruptionbudgets"], MANAGE),
        rule(&["autoscaling"], &["horizontalpodautoscalers"], MANAGE),
        rule(&["networking.k8s.io"], &["networkpolicies", "ingresses"], MANAGE),
        rule(&["gateway.networking.k8s.io"], &["httproutes"], MANAGE),
        rule(&["cert-manager.io"], &["certificates"], MANAGE),
        rule(&["keda.sh"], &["scaledobjects"], MANAGE),
        rule(&["postgresql.cnpg.io"], &["clusters", "scheduledbackups"], MANAGE),
    ])
}

pub fn objects(i: &Install) -> Vec<Value> {
    let ns = &i.namespace;
    let labels = json!({"app.kubernetes.io/name": NAME, "app.kubernetes.io/part-of": "scribyra"});
    let restricted = json!({
        "runAsNonRoot": true,
        "allowPrivilegeEscalation": false,
        "readOnlyRootFilesystem": true,
        "capabilities": {"drop": ["ALL"]},
        "seccompProfile": {"type": "RuntimeDefault"},
    });
    vec![
        json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ns, "labels": {
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "latest",
        }}}),
        crd(),
        json!({"apiVersion": "v1", "kind": "ServiceAccount", "metadata": {"name": NAME, "namespace": ns, "labels": labels}}),
        json!({"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole", "metadata": {"name": NAME, "labels": labels}, "rules": cluster_rules()}),
        json!({"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding", "metadata": {"name": NAME, "labels": labels},
            "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": NAME},
            "subjects": [{"kind": "ServiceAccount", "name": NAME, "namespace": ns}]}),
        // The lease lives in the operator's namespace only.
        json!({"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role", "metadata": {"name": NAME, "namespace": ns, "labels": labels}, "rules": [
            rule(&["coordination.k8s.io"], &["leases"], &["create"]),
            {"apiGroups": ["coordination.k8s.io"], "resources": ["leases"], "resourceNames": [LEASE], "verbs": ["get", "patch"]},
        ]}),
        json!({"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": {"name": NAME, "namespace": ns, "labels": labels},
            "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": NAME},
            "subjects": [{"kind": "ServiceAccount", "name": NAME, "namespace": ns}]}),
        json!({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": NAME, "namespace": ns, "labels": labels}, "spec": {
            "replicas": 1,
            "selector": {"matchLabels": {"app.kubernetes.io/name": NAME}},
            "strategy": {"type": "RollingUpdate", "rollingUpdate": {"maxUnavailable": 0, "maxSurge": 1}},
            "template": {"metadata": {"labels": labels}, "spec": {
                "serviceAccountName": NAME,
                "securityContext": {"runAsNonRoot": true, "runAsUser": 10001, "runAsGroup": 10001, "seccompProfile": {"type": "RuntimeDefault"}},
                "containers": [{
                    "name": "operator",
                    "image": i.image,
                    "args": ["run"],
                    "env": [
                        {"name": "POD_NAME", "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}}},
                        {"name": "POD_NAMESPACE", "valueFrom": {"fieldRef": {"fieldPath": "metadata.namespace"}}},
                        {"name": "SCRIBYRA_OPERATOR_IMAGE", "value": i.image},
                        {"name": "SCRIBYRA_OPERATOR_REGISTRY", "value": i.registry},
                        {"name": "RUST_LOG", "value": "info"},
                    ],
                    "ports": [{"name": "metrics", "containerPort": METRICS_PORT}],
                    "livenessProbe": {"httpGet": {"path": "/healthz", "port": "metrics"}, "periodSeconds": 10},
                    "readinessProbe": {"httpGet": {"path": "/readyz", "port": "metrics"}, "periodSeconds": 5},
                    "resources": {"requests": {"cpu": "20m", "memory": "64Mi"}, "limits": {"memory": "256Mi"}},
                    "securityContext": restricted,
                }],
            }},
        }}),
        json!({"apiVersion": "v1", "kind": "Service", "metadata": {"name": NAME, "namespace": ns, "labels": labels}, "spec": {
            "selector": {"app.kubernetes.io/name": NAME},
            "ports": [{"name": "metrics", "port": METRICS_PORT, "targetPort": "metrics"}],
        }}),
    ]
}

pub fn yaml(values: &[Value]) -> String {
    let mut out = String::from("# Generated by `scribyra-operator manifests`; do not edit.\n");
    for v in values {
        out.push_str("---\n");
        out.push_str(&serde_yaml::to_string(v).unwrap());
    }
    out
}

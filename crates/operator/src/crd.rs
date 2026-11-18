//! The `Scribyra` custom resource (`scribyra.com/v1alpha1`): one organisation deployment.
//!
//! Schema validation happens in the API server: OpenAPI bounds from these types plus CEL rules
//! (`x-kubernetes-validations`) for one-of choices, cross-field rules and immutable fields. The
//! reconciler additionally runs the service's own configuration validation
//! (`scribyra_sync::config::Config::validate`) on the generated configuration, so anything the
//! service would refuse at start is reported in status before a pod is created.

use k8s_openapi::api::core::v1::ResourceRequirements;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Condition;
use kube::{CustomResource, KubeSchema};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const GROUP: &str = "scribyra.com";
pub const VERSION: &str = "v1alpha1";
pub const KIND: &str = "Scribyra";

#[derive(CustomResource, KubeSchema, Deserialize, Serialize, Clone, Debug, PartialEq)]
#[kube(
    group = "scribyra.com",
    version = "v1alpha1",
    kind = "Scribyra",
    plural = "scribyras",
    shortname = "scr",
    namespaced,
    status = "ScribyraStatus",
    printcolumn = r#"{"name":"Domain","type":"string","jsonPath":".spec.domain"}"#,
    printcolumn = r#"{"name":"Version","type":"string","jsonPath":".status.version"}"#,
    printcolumn = r#"{"name":"Ready","type":"string","jsonPath":".status.conditions[?(@.type==\"Ready\")].status"}"#,
    printcolumn = r#"{"name":"Age","type":"date","jsonPath":".metadata.creationTimestamp"}"#,
    validation = Rule::new("self.metadata.name.size() <= 40").message("metadata.name must be at most 40 characters (it prefixes every generated object)")
)]
#[x_kube(
    validation = Rule::new("self.compile.mode == 'browser' || self.encryption == 'serverReadable'").message("server compile needs encryption: serverReadable (the server cannot compile what it cannot read)"),
    validation = Rule::new("!has(self.backup) || has(self.postgres.provisioned)").message("backup is for provisioned PostgreSQL (CloudNativePG); back up an external database with its own tooling"),
    validation = Rule::new("!has(self.autoscaling) || self.autoscaling.maxReplicas >= self.autoscaling.minReplicas").message("autoscaling.maxReplicas must be at least minReplicas")
)]
#[serde(rename_all = "camelCase")]
pub struct ScribyraSpec {
    /// Scribyra release to run (the image tag). Changing it starts an orchestrated upgrade:
    /// the migration Job runs to completion before the Deployments roll. Downgrades and
    /// upgrades that skip a required release are refused (`UpgradeBlocked`).
    #[schemars(length(min = 1, max = 64), regex(pattern = r"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$"))]
    pub version: String,
    /// The deployment's DNS name. The web app, the API and the OIDC callback share the origin
    /// `https://<domain>`.
    #[schemars(length(min = 1, max = 253), regex(pattern = r"^([a-z0-9]([-a-z0-9]*[a-z0-9])?\.)+[a-z]([-a-z0-9]*[a-z0-9])?$"))]
    pub domain: String,
    /// Shown in the app's sign-in and project list (`deployment.name`). Defaults to the
    /// resource's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 64))]
    pub display_name: Option<String>,
    /// What the server may read. Fixed after creation: moving between modes is an export and
    /// an import into a new deployment.
    #[serde(default)]
    #[x_kube(validation = Rule::new("self == oldSelf").message("encryption is fixed after creation"))]
    pub encryption: Encryption,
    pub oidc: OidcSpec,
    #[serde(default)]
    pub compile: CompileSpec,
    #[serde(default)]
    pub policy: PolicySpec,
    pub postgres: PostgresSpec,
    pub storage: StorageSpec,
    /// The deployment's 32-byte master key (server-readable mode). When absent the operator
    /// generates `<name>-master-key` once and never deletes it unless `deletionPolicy: Delete`.
    /// Back it up separately from the database: without it server-readable projects cannot be
    /// decrypted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master_key_ref: Option<SecretKeyRef>,
    /// API replicas when `autoscaling` is not set. Releases that still run a single writer
    /// (see `docs/operator.md`) always run one.
    #[serde(default = "two")]
    #[schemars(range(min = 1, max = 100))]
    pub replicas: i32,
    /// HorizontalPodAutoscaler for the API, on CPU utilisation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autoscaling: Option<AutoscalingSpec>,
    /// Resources for API pods.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "preserve_object")]
    pub resources: Option<ResourceRequirements>,
    pub ingress: IngressSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<BackupSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quotas: Option<QuotasSpec>,
    /// Days of audit log kept (30-3650).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 30, max = 3650))]
    pub audit_retention_days: Option<u32>,
    /// Further origins allowed by CORS besides `https://<domain>`, for example the public app.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 16), inner(length(max = 253)))]
    pub extra_origins: Vec<String>,
    #[serde(default)]
    pub network_policy: NetworkPolicySpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<ImagesSpec>,
    /// `Retain` (default) keeps the database, the bucket, their volumes and the master key when
    /// this resource is deleted; `Delete` removes them too.
    #[serde(default)]
    pub deletion_policy: DeletionPolicy,
}
fn two() -> i32 {
    2
}
fn preserve_object(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type": "object", "x-kubernetes-preserve-unknown-fields": true})
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Encryption {
    /// The server can read projects (stored encrypted at rest under the master key); enables
    /// server compile, administration and audit of content.
    #[default]
    ServerReadable,
    /// Clients encrypt; the server stores ciphertext only.
    EndToEnd,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
pub enum DeletionPolicy {
    #[default]
    Retain,
    Delete,
}

#[derive(KubeSchema, Deserialize, Serialize, Clone, Debug, PartialEq)]
#[x_kube(validation = Rule::new("self.providers.all(p, self.providers.filter(q, q.name == p.name).size() == 1)").message("provider names must be unique"))]
#[serde(rename_all = "camelCase")]
pub struct OidcSpec {
    /// Every way to sign in. People are identified only by these providers.
    #[schemars(length(min = 1, max = 16))]
    pub providers: Vec<OidcProvider>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OidcProvider {
    /// Short lowercase ID (`deployment.providers[].id`).
    #[schemars(length(min = 1, max = 32), regex(pattern = r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"))]
    pub name: String,
    /// Button label; defaults to the name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 64))]
    pub label: Option<String>,
    /// Issuer URL, exactly as in its discovery document.
    #[schemars(length(min = 9, max = 512), regex(pattern = r"^https://[^?#@\s]+$"))]
    pub issuer: String,
    #[schemars(length(min = 1, max = 255))]
    pub client_id: String,
    /// Secret holding the confidential client's secret; mounted as a file, never read by the
    /// operator.
    pub client_secret_ref: SecretKeyRef,
    /// Accept only verified emails in these domains.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32), inner(length(max = 253)))]
    pub email_domains: Vec<String>,
    /// Map provider groups to deployment roles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_mapping: Option<RoleMapping>,
    /// How this provider marks guest accounts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest: Option<GuestRule>,
    #[serde(default)]
    pub offline_access: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 720))]
    pub session_hours: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 1440))]
    pub recheck_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 16), inner(length(max = 128)))]
    pub scopes: Vec<String>,
}

#[derive(KubeSchema, Deserialize, Serialize, Clone, Debug, PartialEq)]
#[x_kube(validation = Rule::new("(size(self.adminGroups) == 0 && size(self.memberGroups) == 0) || size(self.groupsClaim) > 0").message("adminGroups and memberGroups need groupsClaim"))]
#[serde(rename_all = "camelCase")]
pub struct RoleMapping {
    /// The ID-token claim listing groups, for example `groups`.
    #[serde(default)]
    #[schemars(length(max = 128))]
    pub groups_claim: String,
    /// Members of these groups are deployment administrators.
    #[serde(default)]
    #[schemars(length(max = 64), inner(length(max = 256)))]
    pub admin_groups: Vec<String>,
    /// When non-empty, only members of these groups (or `adminGroups`) may sign in.
    #[serde(default)]
    #[schemars(length(max = 64), inner(length(max = 256)))]
    pub member_groups: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct GuestRule {
    #[schemars(length(min = 1, max = 128))]
    pub claim: String,
    #[schemars(length(min = 1, max = 256))]
    pub equals: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct SecretKeyRef {
    /// Secret in the resource's namespace.
    #[schemars(length(min = 1, max = 253))]
    pub name: String,
    #[schemars(length(min = 1, max = 253))]
    pub key: String,
}

#[derive(KubeSchema, Deserialize, Serialize, Clone, Debug, PartialEq)]
#[x_kube(validation = Rule::new("self.workers.maxReplicas >= self.workers.minReplicas").message("compile.workers.maxReplicas must be at least minReplicas"))]
#[serde(rename_all = "camelCase")]
pub struct CompileSpec {
    /// `browser` (BusyTeX in each browser only), `server` or `both` (each project chooses).
    #[serde(default)]
    pub mode: CompileMode,
    /// TeX Live variant baked into the worker image.
    #[serde(default)]
    pub texlive: TexLive,
    /// For example `gvisor`: the workers' system calls then reach gVisor, not the host kernel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 253))]
    pub runtime_class_name: Option<String>,
    #[serde(default)]
    pub workers: WorkersSpec,
    /// Per-job limits enforced inside the worker's sandbox (`deployment.compile_limits`).
    #[serde(default)]
    pub limits: CompileLimits,
    /// Resources of each worker pod; defaults derive from `limits` and `workers.concurrency`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "preserve_object")]
    pub resources: Option<ResourceRequirements>,
}
impl Default for CompileSpec {
    fn default() -> Self {
        Self { mode: CompileMode::Browser, texlive: TexLive::Small, runtime_class_name: None, workers: WorkersSpec::default(), limits: CompileLimits::default(), resources: None }
    }
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CompileMode {
    #[default]
    Browser,
    Server,
    Both,
}
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TexLive {
    #[default]
    Small,
    Medium,
    Full,
}
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Scaler {
    /// The operator reads the compile queue length from the API's metrics endpoint.
    #[default]
    Operator,
    /// A KEDA `ScaledObject` (Prometheus trigger); needs KEDA and `prometheusAddress`.
    Keda,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkersSpec {
    #[serde(default)]
    #[schemars(range(min = 0, max = 1000))]
    pub min_replicas: i32,
    #[serde(default = "eight")]
    #[schemars(range(min = 1, max = 1000))]
    pub max_replicas: i32,
    /// Jobs one worker runs at once (`compile_limits.concurrency`); also the queue length per
    /// worker the scaler aims for.
    #[serde(default = "two_u32")]
    #[schemars(range(min = 1, max = 64))]
    pub concurrency: u32,
    #[serde(default)]
    pub scaler: Scaler,
    /// Prometheus server KEDA queries (`scaler: keda`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512))]
    pub prometheus_address: Option<String>,
}
impl Default for WorkersSpec {
    fn default() -> Self {
        Self { min_replicas: 0, max_replicas: 8, concurrency: 2, scaler: Scaler::Operator, prometheus_address: None }
    }
}
fn eight() -> i32 {
    8
}
fn two_u32() -> u32 {
    2
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct CompileLimits {
    #[schemars(range(min = 1, max = 3600))]
    pub cpu_seconds: u32,
    #[schemars(range(min = 1, max = 3600))]
    pub wall_seconds: u32,
    #[schemars(range(min = 64, max = 65536))]
    pub memory_mi_b: u32,
    #[schemars(range(min = 16, max = 65536))]
    pub scratch_mi_b: u32,
    #[schemars(range(min = 1, max = 4096))]
    pub output_mi_b: u32,
    #[schemars(range(min = 1, max = 16))]
    pub passes: u32,
    #[schemars(range(min = 1, max = 10000))]
    pub queue: u32,
    #[schemars(range(min = 1, max = 100000))]
    pub per_member_per_hour: u32,
}
impl Default for CompileLimits {
    fn default() -> Self {
        Self { cpu_seconds: 60, wall_seconds: 120, memory_mi_b: 2048, scratch_mi_b: 512, output_mi_b: 64, passes: 4, queue: 32, per_member_per_hour: 120 }
    }
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct PolicySpec {
    /// `false` makes the deployment online-only: browsers keep no local copies.
    pub offline_allowed: bool,
    /// Whether editors may create share links (never anonymous).
    pub link_sharing: bool,
    pub guests: Guests,
    /// Verified emails (or `issuer#subject`) that are administrators whatever groups say; the
    /// bootstrap for a new deployment.
    #[schemars(length(max = 64), inner(length(max = 512)))]
    pub admins: Vec<String>,
}
impl Default for PolicySpec {
    fn default() -> Self {
        Self { offline_allowed: true, link_sharing: false, guests: Guests::Off, admins: vec![] }
    }
}
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Guests {
    #[default]
    Off,
    Shared,
}

#[derive(KubeSchema, Deserialize, Serialize, Clone, Debug, PartialEq)]
#[x_kube(
    validation = Rule::new("has(self.external) != has(self.provisioned)").message("postgres needs exactly one of external and provisioned"),
    validation = Rule::new("has(self.external) == has(oldSelf.external)").message("postgres cannot switch between external and provisioned (that would start from an empty database)")
)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<ExternalPostgres>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisioned: Option<ProvisionedPostgres>,
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPostgres {
    /// Secret key holding the PostgreSQL URL (`postgres://…?sslmode=verify-full`).
    pub secret_ref: SecretKeyRef,
    /// CIDRs the database is reached at, for the egress NetworkPolicy. Empty allows port
    /// `port` to any address.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32), inner(length(max = 64)))]
    pub cidrs: Vec<String>,
    #[serde(default = "pg_port")]
    #[schemars(range(min = 1, max = 65535))]
    pub port: i32,
}
fn pg_port() -> i32 {
    5432
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionedPostgres {
    /// Volume size of each instance, for example `20Gi`.
    #[serde(default = "pg_size")]
    #[schemars(length(min = 1, max = 32))]
    pub storage_size: String,
    #[serde(default = "one")]
    #[schemars(range(min = 1, max = 9))]
    pub instances: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 253))]
    pub storage_class_name: Option<String>,
    /// CloudNativePG operand image; CloudNativePG's default when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512))]
    pub image_name: Option<String>,
}
fn pg_size() -> String {
    "20Gi".into()
}
fn one() -> i32 {
    1
}

#[derive(KubeSchema, Deserialize, Serialize, Clone, Debug, PartialEq)]
#[x_kube(
    validation = Rule::new("has(self.s3) != has(self.provisioned)").message("storage needs exactly one of s3 and provisioned"),
    validation = Rule::new("has(self.s3) == has(oldSelf.s3)").message("storage cannot switch between s3 and provisioned (that would start from an empty bucket)")
)]
#[serde(rename_all = "camelCase")]
pub struct StorageSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3: Option<S3Storage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisioned: Option<ProvisionedStorage>,
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct S3Storage {
    /// `https://` endpoint, for example `https://s3.eu-west-1.amazonaws.com`.
    #[schemars(length(min = 9, max = 512), regex(pattern = r"^https://[^?#@\s]+$"))]
    pub endpoint: String,
    /// An existing bucket; the service never creates or lists buckets.
    #[schemars(length(min = 3, max = 63))]
    pub bucket: String,
    #[serde(default = "auto")]
    #[schemars(length(min = 1, max = 64))]
    pub region: String,
    /// Path-style URLs (Garage, MinIO, IP endpoints).
    #[serde(default)]
    pub path_style: bool,
    /// Secret with keys `access-key-id` and `secret-access-key` (names overridable).
    pub secret_ref: S3SecretRef,
    /// CIDRs the endpoint is reached at, for the egress NetworkPolicy. Empty allows 443 to any
    /// address.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(length(max = 32), inner(length(max = 64)))]
    pub cidrs: Vec<String>,
}
fn auto() -> String {
    "auto".into()
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct S3SecretRef {
    #[schemars(length(min = 1, max = 253))]
    pub name: String,
    #[serde(default = "access_key_id")]
    #[schemars(length(min = 1, max = 253))]
    pub access_key_id_key: String,
    #[serde(default = "secret_access_key")]
    #[schemars(length(min = 1, max = 253))]
    pub secret_access_key_key: String,
}
fn access_key_id() -> String {
    "access-key-id".into()
}
fn secret_access_key() -> String {
    "secret-access-key".into()
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionedStorage {
    /// Volume size of the single-node Garage store, for example `50Gi`.
    #[serde(default = "garage_size")]
    #[schemars(length(min = 1, max = 32))]
    pub size: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 253))]
    pub storage_class_name: Option<String>,
}
fn garage_size() -> String {
    "50Gi".into()
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutoscalingSpec {
    #[schemars(range(min = 1, max = 100))]
    pub min_replicas: i32,
    #[schemars(range(min = 1, max = 100))]
    pub max_replicas: i32,
    #[serde(default = "seventy")]
    #[schemars(range(min = 10, max = 100))]
    pub target_cpu_utilization_percentage: i32,
}
fn seventy() -> i32 {
    70
}

#[derive(KubeSchema, Deserialize, Serialize, Clone, Debug, PartialEq)]
#[x_kube(validation = Rule::new("!has(self.gateway) || !has(self.className)").message("ingress uses either className (Ingress) or gateway (HTTPRoute)"))]
#[serde(rename_all = "camelCase")]
pub struct IngressSpec {
    /// IngressClass, for example `traefik` (k3s) or `nginx`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 253))]
    pub class_name: Option<String>,
    /// cert-manager issuer for the TLS certificate. Without it, `tlsSecretName` must name an
    /// existing certificate Secret (Ingress) or the Gateway must terminate TLS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer_ref: Option<IssuerRef>,
    /// TLS Secret for the Ingress; defaults to `<name>-tls`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 253))]
    pub tls_secret_name: Option<String>,
    /// Use a Gateway API `HTTPRoute` attached to this Gateway instead of an Ingress. The
    /// Gateway's HTTPS listener terminates TLS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<GatewayRef>,
    /// Extra annotations on the Ingress (for example controller timeouts).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub annotations: std::collections::BTreeMap<String, String>,
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IssuerRef {
    #[schemars(length(min = 1, max = 253))]
    pub name: String,
    #[serde(default)]
    pub kind: IssuerKind,
}
#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, JsonSchema)]
pub enum IssuerKind {
    #[default]
    ClusterIssuer,
    Issuer,
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRef {
    #[schemars(length(min = 1, max = 253))]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 63))]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 253))]
    pub section_name: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackupSpec {
    /// Six-field cron (seconds first), as CloudNativePG `ScheduledBackup` expects.
    #[serde(default = "nightly")]
    #[schemars(length(min = 9, max = 64))]
    pub schedule: String,
    /// CloudNativePG retention policy, for example `30d`.
    #[serde(default = "thirty_days")]
    #[schemars(regex(pattern = r"^[1-9][0-9]*[dwm]$"))]
    pub retention: String,
    pub destination: BackupDestination,
}
fn nightly() -> String {
    "0 0 3 * * *".into()
}
fn thirty_days() -> String {
    "30d".into()
}
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BackupDestination {
    /// For example `s3://backups/acme`.
    #[schemars(length(min = 6, max = 512), regex(pattern = r"^s3://.+"))]
    pub destination_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512), regex(pattern = r"^https://[^?#@\s]+$"))]
    pub endpoint_url: Option<String>,
    pub secret_ref: S3SecretRef,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuotasSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_bytes: Option<u64>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkPolicySpec {
    /// Namespaces allowed to reach the web app and the API (the ingress controller's). Empty
    /// allows any namespace on those two ports.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(schema_with = "preserve_object")]
    pub ingress_namespace_selector: Option<k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector>,
    /// CIDRs of the OIDC issuers for the API's HTTPS egress. Empty allows 443 to any address
    /// (NetworkPolicy cannot select host names; use a CNI with FQDN policies to narrow it).
    #[schemars(length(max = 32), inner(length(max = 64)))]
    pub oidc_cidrs: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase", default)]
pub struct ImagesSpec {
    /// Overrides `<registry>/scribyra-sync:<version>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512))]
    pub api: Option<String>,
    /// Overrides `<registry>/scribyra-web:<version>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512))]
    pub web: Option<String>,
    /// Overrides `<registry>/scribyra-worker:<version>-<texlive>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512))]
    pub worker: Option<String>,
    /// Overrides `<registry>/scribyra-garage:<garage version>`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 512))]
    pub garage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(length(max = 16))]
    pub pull_policy: Option<String>,
    #[schemars(length(max = 8))]
    pub pull_secrets: Vec<String>,
}

/// Status written by the operator.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScribyraStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_generation: Option<i64>,
    /// `Ready`, `Progressing`, `Degraded`, `UpgradeBlocked`, `DatabaseReady`, `StorageReady`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schemars(schema_with = "conditions_schema")]
    pub conditions: Vec<Condition>,
    /// The release the Deployments run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The release whose migration Job completed last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migrated_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The Secret holding the master key; back it up separately from the database.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub master_key_secret: Option<String>,
    /// Whether the provisioned Garage store has its layout, key and bucket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_bootstrapped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compile_workers: Option<WorkerStatus>,
}
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStatus {
    pub desired_replicas: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_length: Option<i64>,
    /// When the queue last had work (RFC 3339), for scale-down stabilisation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_busy: Option<String>,
}
fn conditions_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": "array",
        "x-kubernetes-list-type": "map",
        "x-kubernetes-list-map-keys": ["type"],
        "items": {
            "type": "object",
            "required": ["type", "status", "lastTransitionTime", "reason", "message"],
            "properties": {
                "type": {"type": "string", "maxLength": 316},
                "status": {"type": "string", "enum": ["True", "False", "Unknown"]},
                "observedGeneration": {"type": "integer", "format": "int64"},
                "lastTransitionTime": {"type": "string", "format": "date-time"},
                "reason": {"type": "string", "maxLength": 1024},
                "message": {"type": "string", "maxLength": 32768}
            }
        }
    })
}

impl Scribyra {
    pub fn display_name(&self) -> String {
        self.spec.display_name.clone().unwrap_or_else(|| self.metadata.name.clone().unwrap_or_default())
    }
    pub fn name(&self) -> &str {
        self.metadata.name.as_deref().unwrap_or_default()
    }
    pub fn namespace(&self) -> &str {
        self.metadata.namespace.as_deref().unwrap_or_default()
    }
    pub fn compiles_on_server(&self) -> bool {
        self.spec.compile.mode != CompileMode::Browser
    }
}

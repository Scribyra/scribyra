//! The service configuration (`service.json`) the operator generates from a `Scribyra`.
//!
//! The `deployment` object is the service's own type, [`scribyra_sync::config::Deployment`], so
//! a field the service renames or drops fails this crate's build. Only the top-level fields the
//! operator sets are written; everything else keeps the service's defaults. The result is
//! checked with the service's own validation ([`check`]) before anything is deployed.

use crate::crd::{CompileMode, Encryption, Guests, Scribyra};
use scribyra_sync::config as svc;
use scribyra_sync::deploy;
use serde_json::{Value, json};

/// Path of the Garage CA inside API, worker and migration pods.
pub const S3_CA_FILE: &str = "/etc/scribyra/secrets/s3-ca.pem";
/// Region Garage signs with (`s3_region` in its configuration).
pub const GARAGE_REGION: &str = "garage";
pub const GARAGE_BUCKET: &str = "scribyra";
pub const GARAGE_S3_PORT: u16 = 3943;
pub const GARAGE_ADMIN_PORT: u16 = 3944;

pub fn origin(cr: &Scribyra) -> String {
    format!("https://{}", cr.spec.domain)
}

pub fn garage_endpoint(cr: &Scribyra) -> String {
    format!("https://{}-garage.{}.svc:{GARAGE_S3_PORT}", cr.name(), cr.namespace())
}

/// The service's `deployment` object.
pub fn deployment(cr: &Scribyra) -> svc::Deployment {
    let spec = &cr.spec;
    let limits = &spec.compile.limits;
    let defaults = svc::Quotas::default();
    let quotas = spec.quotas.clone().unwrap_or(crate::crd::QuotasSpec { deployment_bytes: None, project_bytes: None, member_bytes: None });
    svc::Deployment {
        name: cr.display_name(),
        encryption: match spec.encryption {
            Encryption::ServerReadable => svc::Encryption::Server,
            Encryption::EndToEnd => svc::Encryption::E2ee,
        },
        offline: spec.policy.offline_allowed,
        compile: match spec.compile.mode {
            CompileMode::Browser => svc::Compile::Browser,
            CompileMode::Server => svc::Compile::Server,
            CompileMode::Both => svc::Compile::Both,
        },
        link_sharing: spec.policy.link_sharing,
        guests: match spec.policy.guests {
            Guests::Off => svc::Guests::Off,
            Guests::Shared => svc::Guests::Shared,
        },
        admins: spec.policy.admins.clone(),
        providers: spec
            .oidc
            .providers
            .iter()
            .map(|p| {
                let mapping = p.role_mapping.clone().unwrap_or(crate::crd::RoleMapping { groups_claim: String::new(), admin_groups: vec![], member_groups: vec![] });
                svc::Provider {
                    id: p.name.clone(),
                    label: p.label.clone().unwrap_or_else(|| p.name.clone()),
                    issuer: p.issuer.clone(),
                    client_id: p.client_id.clone(),
                    client_secret_file: deploy::provider_secret_file(&p.name).into(),
                    email_domains: p.email_domains.clone(),
                    groups_claim: Some(mapping.groups_claim).filter(|c| !c.is_empty()),
                    admin_groups: mapping.admin_groups,
                    member_groups: mapping.member_groups,
                    guest: p.guest.as_ref().map(|g| svc::GuestRule { claim: g.claim.clone(), equals: g.equals.clone() }),
                    offline_access: p.offline_access,
                    session_hours: p.session_hours.unwrap_or(12),
                    recheck_minutes: p.recheck_minutes.unwrap_or(10),
                    scopes: p.scopes.clone(),
                }
            })
            .collect(),
        quotas: svc::Quotas {
            deployment_bytes: quotas.deployment_bytes.unwrap_or(defaults.deployment_bytes),
            project_bytes: quotas.project_bytes.unwrap_or(defaults.project_bytes),
            member_bytes: quotas.member_bytes.unwrap_or(defaults.member_bytes),
        },
        audit_retention_days: spec.audit_retention_days.unwrap_or(400),
        compile_limits: svc::CompileLimits {
            cpu_seconds: limits.cpu_seconds,
            wall_seconds: limits.wall_seconds,
            memory_mib: limits.memory_mi_b,
            scratch_mib: limits.scratch_mi_b,
            output_mib: limits.output_mi_b,
            passes: limits.passes,
            concurrency: spec.compile.workers.concurrency,
            queue: limits.queue,
            per_member_per_hour: limits.per_member_per_hour,
        },
        // The worker image carries its TeX Live tree at a fixed path.
        texlive: (spec.compile.mode != CompileMode::Browser).then(|| deploy::TEXLIVE_DIR.into()),
    }
}

/// `service.json`. The S3 access key ID is not in it: pods get it from the referenced Secret
/// through `SCRIBYRA_SERVICE_S3_ACCESS_KEY_ID`.
pub fn service_json(cr: &Scribyra) -> Value {
    let spec = &cr.spec;
    let mut origins = vec![origin(cr)];
    origins.extend(spec.extra_origins.iter().cloned());
    let mut config = json!({
        "bind": format!("0.0.0.0:{}", deploy::HTTP_PORT),
        "database_url_file": deploy::DATABASE_URL_FILE,
        "blob_store": "s3",
        "s3_secret_access_key_file": deploy::S3_SECRET_ACCESS_KEY_FILE,
        "public_url": origin(cr),
        "origins": origins,
        "deployment": deployment(cr),
    });
    let map = config.as_object_mut().unwrap();
    if let Some(s3) = &spec.storage.s3 {
        map.insert("s3_endpoint".into(), s3.endpoint.clone().into());
        map.insert("s3_region".into(), s3.region.clone().into());
        map.insert("s3_bucket".into(), s3.bucket.clone().into());
        map.insert("s3_path_style".into(), s3.path_style.into());
    } else {
        map.insert("s3_endpoint".into(), garage_endpoint(cr).into());
        map.insert("s3_region".into(), GARAGE_REGION.into());
        map.insert("s3_bucket".into(), GARAGE_BUCKET.into());
        map.insert("s3_path_style".into(), true.into());
        map.insert("s3_ca_file".into(), S3_CA_FILE.into());
    }
    if spec.encryption == Encryption::ServerReadable {
        map.insert("service_key_file".into(), deploy::MASTER_KEY_FILE.into());
    }
    config
}

/// The service's own checks on the generated configuration (with a placeholder access key ID,
/// which arrives through the environment). File contents are not checked here: the operator
/// never reads the referenced Secrets.
pub fn check(cr: &Scribyra) -> Result<(), String> {
    let mut value = service_json(cr);
    value["s3_access_key_id"] = "placeholder".into();
    let mut config: svc::Config = serde_json::from_value(value).map_err(|e| format!("generated configuration does not parse: {e}"))?;
    config.s3_access_key_id = Some("placeholder".into());
    config.validate().map_err(str::to_owned)
}

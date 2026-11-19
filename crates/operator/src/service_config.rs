//! The service configuration (`service.json`) the operator generates from a `Scribyra`.
//!
//! The `deployment` object is the service's own type, [`scribyra_sync::config::Deployment`], so
//! a field the service renames or drops fails this crate's build. Only the top-level fields the
//! operator sets are written; everything else keeps the service's defaults. The result is
//! checked with the service's own validation ([`check`]) before anything is deployed.

use crate::crd::{CompileMode, Encryption, Guests, OidcProvider, Preset, Scribyra, ZitadelForeign};
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
        notify_on_admin_access: spec.policy.notify_on_admin_access,
        providers: spec.oidc.providers.iter().map(provider).collect(),
        primary_organisation: spec.oidc.primary_organisation.as_ref().map(|p| svc::PrimaryOrganisation { provider: p.provider.clone(), organisation: p.organisation.clone() }),
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
            per_project_per_minute: limits.per_project_per_minute,
            active_per_member: limits.active_per_member,
            active_per_owner: limits.active_per_owner,
            retention_days: limits.retention_days,
        },
        // The workers run the browser's WebAssembly engine from their image's compile runtime;
        // the operator deploys no TeX Live (docs/compile-engines.md).
        texlive: None,
        compile_engine: svc::CompileEngine::Wasm,
        tex_mirror: spec.compile.tex_mirror.clone().unwrap_or_else(|| svc::DEFAULT_TEX_MIRROR.into()),
    }
}

/// The mirror the workers fetch packages from, if any (`deployment.tex_mirror`).
pub fn tex_mirror(cr: &Scribyra) -> Option<String> {
    Some(deployment(cr).tex_mirror).filter(|m| !m.is_empty())
}

/// One `deployment.providers[]` entry; the client secret is a mounted file.
fn provider(p: &OidcProvider) -> svc::Provider {
    let roles = p.roles.clone().unwrap_or_default();
    svc::Provider {
        id: p.name.clone(),
        label: p.label.clone().unwrap_or_else(|| p.name.clone()),
        issuer: p.issuer.clone(),
        client_id: p.client_id.clone(),
        client_secret_file: deploy::provider_secret_file(&p.name).into(),
        email_domains: p.email_domains.clone(),
        hosted_domains: p.hosted_domains.clone(),
        preset: p.preset.map(|preset| match preset {
            Preset::Zitadel => svc::Preset::Zitadel,
            Preset::Keycloak => svc::Preset::Keycloak,
            Preset::Entra => svc::Preset::Entra,
            Preset::Google => svc::Preset::Google,
        }),
        claims: p.claims.as_ref().map(|c| svc::ClaimRules {
            organisation: c.organisation.clone(),
            organisation_name: c.organisation_name.clone(),
            roles: c.roles.clone(),
            guest: c.guest.as_ref().map(|g| svc::GuestRule { path: g.path.clone(), equals: g.equals.clone() }),
        }),
        roles: svc::RoleNames { admin: roles.admin, member: roles.member, guest: roles.guest },
        zitadel_project_id: p.zitadel_project_id.clone(),
        zitadel_project_owner_org: p.zitadel_project_owner_org.clone(),
        zitadel_foreign_organisations: match p.zitadel_foreign_organisations {
            Some(ZitadelForeign::Organisations) => svc::ZitadelForeign::Organisations,
            Some(ZitadelForeign::Guests) | None => svc::ZitadelForeign::Guests,
        },
        keycloak_organizations: p.keycloak_organizations,
        entra_require_acct: p.entra_require_acct,
        roles_apply_to_all_organisations: p.roles_apply_to_all_organisations,
        admin_subjects: p.admin_subjects.clone(),
        offline_access: p.offline_access,
        session_hours: p.session_hours.unwrap_or(12),
        no_refresh_session_minutes: p.no_refresh_session_minutes.unwrap_or(60),
        recheck_minutes: p.recheck_minutes.unwrap_or(10),
        scopes: p.scopes.clone(),
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
        // The migration Job migrates before any pod of a release starts (docs/operator.md,
        // Upgrades), so serving pods never migrate (and a new pod waits for the Job's schema).
        "migrate_on_start": false,
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

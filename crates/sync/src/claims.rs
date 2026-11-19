//! Claims mapping (design section 3, "Identity, organisations and roles come from the provider"):
//! how one provider's verified ID token names the organisations a person belongs to, their
//! deployment role in each and whether they are a guest there. Only the claims of the token the
//! provider itself issued are read, and an organisation is always the pair (provider, claim
//! value), so one provider's claims can never name another's organisation.
//!
//! A provider maps its claims with a preset or with a generic mapping of [`ClaimPath`]s:
//!
//! | Preset | Organisation | Roles | Guest |
//! | --- | --- | --- | --- |
//! | `zitadel` | `zitadel_project_owner_org`; with `zitadel_foreign_organisations: organisations` each org ID keying the roles claim's maps (name: the map's value) | the role keys | a role keyed by another organisation than the owner (`guests`) or than `urn:zitadel:iam:user:resourceowner:id` (`organisations`), or a role mapped to guest |
//! | `keycloak` | `organization` (aliases) with `keycloak_organizations`, else the provider's one | `realm_access.roles`, `resource_access.{client_id}.roles`, `groups`; with several organisations only `<alias>:<role>` names count (in that one), unless `roles_apply_to_all_organisations` | a role mapped to guest |
//! | `entra` | `tid` | `roles` | `acct = 1`; without `acct`, an `idp` other than `https://sts.windows.net/{tid}/` (refused instead with `entra_require_acct`); or a role mapped to guest |
//! | `google` | `hd` (refused without, and unless in `hosted_domains`, else `email_domains`) | everyone a member, `admin_subjects` administrators | never |
//! | generic | `claims.organisation` (else the provider's one), `claims.organisation_name` | `claims.roles` | `claims.guest {path, equals}`, or a role mapped to guest |
//!
//! `roles` maps provider role names to deployment roles; the highest wins. A guest is never more
//! than a guest. Someone with no mapped role in any organisation is refused (`no_role`), guests
//! are refused when the deployment admits none (`guest`), and a token without the organisation
//! claim its mapping needs is refused (`no_organisation`).
use crate::{
    config::{Guests, Preset, Provider, ZitadelForeign},
    sso::Role,
};
use serde_json::{Map, Value};

/// Organisations taken from one token at most (further ones are ignored).
pub const MAX_ORGS: usize = 64;
const MAX_CLAIM_BYTES: usize = 255;
const MAX_NAME_BYTES: usize = 128;
const MAX_ROLE_NAMES: usize = 256;
const ZITADEL_ROLES: &str = "urn:zitadel:iam:org:project:roles";
const ZITADEL_OWNER: &str = "urn:zitadel:iam:user:resourceowner:id";

/// A path into a token's claims: `$` followed by `.key` segments (letters, digits, `_` and `-`)
/// or `["key"]` segments for names with other characters (such as `:` or `.`), for example
/// `$["urn:zitadel:iam:org:project:roles"]` or `$.resource_access.scribyra.roles`. Segments only
/// select object members: no wildcards, indexes, filters or evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimPath(Vec<String>);
impl ClaimPath {
    pub fn parse(text: &str) -> Option<Self> {
        if text.len() > 512 {
            return None;
        }
        let mut rest = text.strip_prefix('$')?;
        let mut segments = Vec::new();
        while !rest.is_empty() {
            let (key, next) = if let Some(r) = rest.strip_prefix('.') {
                let end = r.find(['.', '[']).unwrap_or(r.len());
                let key = &r[..end];
                if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                    return None;
                }
                (key, &r[end..])
            } else if let Some(r) = rest.strip_prefix("[\"") {
                let end = r.find("\"]")?;
                let key = &r[..end];
                if key.is_empty() || key.contains(['"', '\\']) || key.chars().any(char::is_control) {
                    return None;
                }
                (key, &r[end + 2..])
            } else {
                return None;
            };
            segments.push(key.to_owned());
            rest = next;
        }
        (!segments.is_empty() && segments.len() <= 16).then_some(Self(segments))
    }
    /// The value at this path, if every segment names a member of an object.
    pub fn get<'a>(&self, claims: &'a Map<String, Value>) -> Option<&'a Value> {
        let (first, rest) = self.0.split_first()?;
        rest.iter().try_fold(claims.get(first)?, |value, key| value.as_object()?.get(key))
    }
}

/// A person's place in one organisation, as a token states it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    /// The organisation claim's value; empty for a provider's one organisation.
    pub claim: String,
    /// The organisation's name, when the token gives one.
    pub name: Option<String>,
    pub role: Role,
    pub guest: bool,
}

/// Why a token gives no access. The codes are stable: the app shows a message for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No provider role maps to a deployment role in any organisation.
    NoRole,
    /// Only guest access, and the deployment admits no guests.
    Guest,
    /// The mapping needs an organisation claim the token lacks (Google without `hd`, Entra
    /// without `tid`, a configured organisation path or Keycloak organisations missing).
    NoOrganisation,
    /// The organisation the token names is not one this provider admits (a Google Workspace
    /// domain outside `hosted_domains`, or `email_domains` when that is not set).
    Domain,
    /// A claim the configuration requires is missing (Entra's `acct` with `entra_require_acct`).
    MissingClaim,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::NoRole => "no_role",
            Self::Guest => "guest",
            Self::NoOrganisation => "no_organisation",
            Self::Domain => "domain",
            Self::MissingClaim => "missing_claim",
        }
    }
}

fn rank(role: Role) -> u8 {
    match role {
        Role::Admin => 3,
        Role::Member => 2,
        Role::Guest => 1,
    }
}
/// The highest deployment role these provider role names map to.
fn mapped<'a>(provider: &Provider, names: impl IntoIterator<Item = &'a str>) -> Option<Role> {
    let r = &provider.roles;
    names
        .into_iter()
        .take(MAX_ROLE_NAMES)
        .filter_map(|n| {
            let has = |list: &[String]| list.iter().any(|l| l == n);
            if has(&r.admin) {
                Some(Role::Admin)
            } else if has(&r.member) {
                Some(Role::Member)
            } else if has(&r.guest) {
                Some(Role::Guest)
            } else {
                None
            }
        })
        .max_by_key(|r| rank(*r))
}
/// A string or a number as text (organisation IDs), within bounds.
fn scalar(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    (!text.is_empty() && text.len() <= MAX_CLAIM_BYTES && !text.chars().any(char::is_control)).then_some(text)
}
/// A display name, cut to [`MAX_NAME_BYTES`].
fn name(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() || text.chars().any(char::is_control) {
        return None;
    }
    let mut out = String::new();
    for c in text.chars() {
        if out.len() + c.len_utf8() > MAX_NAME_BYTES {
            break;
        }
        out.push(c);
    }
    Some(out)
}
/// A string or a list of strings.
fn strings(value: Option<&Value>) -> Vec<&str> {
    match value {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).take(MAX_ROLE_NAMES).collect(),
        _ => vec![],
    }
}
/// Whether a claim holds the value that marks a guest: the same string, number or boolean, or
/// a list containing it.
fn equals(value: Option<&Value>, want: &str) -> bool {
    match value {
        Some(Value::String(s)) => s == want,
        Some(Value::Number(n)) => n.to_string() == want,
        Some(Value::Bool(b)) => b.to_string() == want,
        Some(Value::Array(list)) => list.iter().any(|v| equals(Some(v), want)),
        _ => false,
    }
}
fn grant(claim: String, name: Option<String>, role: Option<Role>, guest: bool) -> Option<Grant> {
    let role = role?;
    let guest = guest || role == Role::Guest;
    Some(Grant { claim, name, role: if guest { Role::Guest } else { role }, guest })
}

/// The one organisation (its claim value) of a provider whose tokens never name one, so the
/// configuration alone fixes it; `None` when tokens name organisations.
pub fn fixed_organisation(provider: &Provider) -> Option<String> {
    match (provider.preset, &provider.claims) {
        (Some(Preset::Keycloak), _) if !provider.keycloak_organizations => Some(String::new()),
        (None, Some(rules)) if rules.organisation.is_none() => Some(String::new()),
        // With foreign roles making guests, the project's owner is Zitadel's only organisation.
        (Some(Preset::Zitadel), _) if provider.zitadel_foreign_organisations == ZitadelForeign::Guests => provider.zitadel_project_owner_org.clone(),
        _ => None,
    }
}
/// The organisations, roles and guest marks this provider's token gives `subject`, after the
/// deployment's guest policy; or why it gives none.
pub fn map(provider: &Provider, guests: Guests, claims: &Map<String, Value>, subject: &str) -> Result<Vec<Grant>, Refusal> {
    let mut grants: Vec<Grant> = Vec::new();
    match (provider.preset, &provider.claims) {
        (Some(Preset::Zitadel), _) => {
            let specific = provider.zitadel_project_id.as_ref().map(|id| format!("urn:zitadel:iam:org:project:{id}:roles"));
            let roles = specific.and_then(|k| claims.get(&k)).or_else(|| claims.get(ZITADEL_ROLES)).and_then(Value::as_object);
            let owner = claims.get(ZITADEL_OWNER).and_then(scalar);
            // org ID → (name, role names), in the token's order.
            let mut orgs: Vec<(String, Option<String>, Vec<&str>)> = Vec::new();
            for (role, by_org) in roles.into_iter().flatten().take(MAX_ROLE_NAMES) {
                for (org, domain) in by_org.as_object().into_iter().flatten() {
                    let Some(org) = scalar(&Value::String(org.clone())) else { continue };
                    match orgs.iter().position(|(o, ..)| *o == org) {
                        Some(i) => orgs[i].2.push(role),
                        None if orgs.len() < MAX_ORGS => orgs.push((org, name(Some(domain)), vec![role.as_str()])),
                        None => {}
                    }
                }
            }
            match (provider.zitadel_foreign_organisations, &provider.zitadel_project_owner_org) {
                // Review M5: one organisation, the project owner's. Only roles it keys make members
                // and administrators; a role keyed by another organisation (a project grant, whose
                // users that organisation manages) makes a guest of it.
                (ZitadelForeign::Guests, Some(project_owner)) => {
                    let (own, foreign): (Vec<_>, Vec<_>) = orgs.into_iter().partition(|(o, ..)| o == project_owner);
                    let own = own.into_iter().next();
                    let org_name = own.as_ref().and_then(|(_, n, _)| n.clone());
                    let role = own.and_then(|(_, _, names)| mapped(provider, names));
                    let guest = mapped(provider, foreign.into_iter().flat_map(|(_, _, names)| names));
                    grants.extend(grant(project_owner.clone(), org_name.clone(), role, false).or_else(|| grant(project_owner.clone(), org_name, guest, true)));
                }
                // Each organisation keying a role is its own; a role granted by an organisation
                // other than the person's own makes a guest there.
                _ => {
                    for (org, org_name, names) in orgs {
                        let foreign = owner.as_deref() != Some(org.as_str());
                        grants.extend(grant(org, org_name, mapped(provider, names), foreign));
                    }
                }
            }
        }
        (Some(Preset::Keycloak), _) => {
            let realm = claims.get("realm_access").and_then(|r| r.get("roles"));
            let client = claims.get("resource_access").and_then(|r| r.get(&provider.client_id)).and_then(|c| c.get("roles"));
            // Group names (a group membership mapper), without a full path's leading slash.
            let groups = strings(claims.get("groups")).into_iter().map(|g| g.strip_prefix('/').unwrap_or(g));
            let names: Vec<&str> = strings(realm).into_iter().chain(strings(client)).chain(groups).take(MAX_ROLE_NAMES).collect();
            let role = mapped(provider, names.iter().copied());
            if provider.keycloak_organizations {
                // Keycloak 26: a list of aliases, or an object keyed by alias (with attributes).
                let aliases: Vec<String> = match claims.get("organization") {
                    Some(Value::Array(list)) => list.iter().filter_map(scalar).collect(),
                    Some(Value::Object(map)) => map.keys().filter_map(|k| scalar(&Value::String(k.clone()))).collect(),
                    Some(Value::String(s)) => scalar(&Value::String(s.clone())).into_iter().collect(),
                    _ => vec![],
                };
                if aliases.is_empty() {
                    return Err(Refusal::NoOrganisation);
                }
                // Realm and client roles are not per organisation (review M4): they count in every
                // organisation only for someone in one, or with roles_apply_to_all_organisations;
                // otherwise only roles named `<alias>:<role>` count, in that organisation.
                let everywhere = aliases.len() == 1 || provider.roles_apply_to_all_organisations;
                for alias in aliases.into_iter().take(MAX_ORGS) {
                    let own = names.iter().filter_map(|n| n.strip_prefix(alias.as_str())?.strip_prefix(':'));
                    let own = mapped(provider, own);
                    let role = if everywhere { [role, own].into_iter().flatten().max_by_key(|r| rank(*r)) } else { own };
                    let org_name = Some(alias.clone());
                    grants.extend(grant(alias, org_name, role, false));
                }
            } else {
                grants.extend(grant(String::new(), None, role, false));
            }
        }
        (Some(Preset::Entra), _) => {
            let tenant = claims.get("tid").and_then(scalar).ok_or(Refusal::NoOrganisation)?;
            // `acct` is an optional claim the app registration must add (review M6). Without it, a
            // B2B guest still shows as an `idp` other than the tenant's own issuer.
            let guest = match claims.get("acct") {
                Some(acct) => equals(Some(acct), "1"),
                None if provider.entra_require_acct => return Err(Refusal::MissingClaim),
                None => claims.get("idp").is_some_and(|idp| idp.as_str() != Some(&format!("https://sts.windows.net/{tenant}/"))),
            };
            grants.extend(grant(tenant, None, mapped(provider, strings(claims.get("roles"))), guest));
        }
        (Some(Preset::Google), _) => {
            let domain = claims.get("hd").and_then(scalar).ok_or(Refusal::NoOrganisation)?;
            // Only the Workspace domains the configuration names (review H2).
            let allowed = if provider.hosted_domains.is_empty() { &provider.email_domains } else { &provider.hosted_domains };
            if !allowed.contains(&domain) {
                return Err(Refusal::Domain);
            }
            let role = if provider.admin_subjects.iter().any(|s| s == subject) { Role::Admin } else { Role::Member };
            grants.extend(grant(domain.clone(), Some(domain), Some(role), false));
        }
        (None, Some(rules)) => {
            let path = |p: &str| ClaimPath::parse(p).and_then(|p| p.get(claims).cloned());
            let org = match &rules.organisation {
                Some(p) => path(p).as_ref().and_then(scalar).ok_or(Refusal::NoOrganisation)?,
                None => String::new(),
            };
            let org_name = rules.organisation_name.as_deref().and_then(|p| name(path(p).as_ref()));
            let roles = path(&rules.roles);
            let guest = rules.guest.as_ref().is_some_and(|g| equals(path(&g.path).as_ref(), &g.equals));
            grants.extend(grant(org, org_name, mapped(provider, strings(roles.as_ref())), guest));
        }
        (None, None) => {}
    }
    let had = !grants.is_empty();
    if guests == Guests::Off {
        grants.retain(|g| !g.guest);
    }
    if grants.is_empty() {
        return Err(if had { Refusal::Guest } else { Refusal::NoRole });
    }
    Ok(grants)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(extra: Value) -> Provider {
        let mut p = json!({"id": "acme", "label": "Acme", "issuer": "https://id.acme.org", "client_id": "scribyra", "client_secret_file": "s",
                           "roles": {"admin": ["scribyra:admin"], "member": ["scribyra:member"], "guest": ["scribyra:guest"]}});
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        serde_json::from_value(p).unwrap()
    }
    fn claims(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }
    fn g(claim: &str, name: Option<&str>, role: Role, guest: bool) -> Grant {
        Grant { claim: claim.into(), name: name.map(str::to_owned), role, guest }
    }

    #[test]
    fn paths_select_members_only() {
        let c = claims(json!({"a": {"b.c": {"d": 1}}, "urn:x:roles": ["r"], "plain": "p"}));
        assert_eq!(ClaimPath::parse("$.a[\"b.c\"].d").unwrap().get(&c), Some(&json!(1)));
        assert_eq!(ClaimPath::parse("$[\"urn:x:roles\"]").unwrap().get(&c), Some(&json!(["r"])));
        assert_eq!(ClaimPath::parse("$.plain").unwrap().get(&c), Some(&json!("p")));
        assert_eq!(ClaimPath::parse("$.plain.x").unwrap().get(&c), None);
        assert_eq!(ClaimPath::parse("$.missing").unwrap().get(&c), None);
        for bad in ["", "$", "a", "$.", "$..a", "$.a.", "$[a]", "$['a']", "$[\"a\"", "$[\"\"]", "$[\"a\\\"b\"]", "$.a[0]", "$.a[*]", "$.*", "$.a b", "$.a$"] {
            assert!(ClaimPath::parse(bad).is_none(), "{bad}");
        }
        assert!(ClaimPath::parse(&format!("${}", ".a".repeat(17))).is_none());
    }

    #[test]
    fn zitadel_project_grants_make_guests_of_the_owner_organisation() {
        // Review M5: with a project grant to organisation 200, its users got roles keyed by their
        // own organisation and became members and administrators of a new organisation.
        let p = provider(json!({"preset": "zitadel", "zitadel_project_owner_org": "100"}));
        let partner = claims(json!({ZITADEL_OWNER: "200", ZITADEL_ROLES: {"scribyra:admin": {"200": "partner"}}}));
        assert_eq!(map(&p, Guests::Shared, &partner, "u"), Ok(vec![g("100", None, Role::Guest, true)]));
        assert_eq!(map(&p, Guests::Off, &partner, "u"), Err(Refusal::Guest));
        // Roles the owner keys make members and administrators, whoever's user it is; foreign
        // ones add nothing to them.
        let home = claims(json!({ZITADEL_OWNER: "100", ZITADEL_ROLES: {"scribyra:member": {"100": "acme", "200": "partner"}, "scribyra:admin": {"200": "partner"}}}));
        assert_eq!(map(&p, Guests::Off, &home, "u"), Ok(vec![g("100", Some("acme"), Role::Member, false)]));
        let invited = claims(json!({ZITADEL_OWNER: "300", ZITADEL_ROLES: {"scribyra:admin": {"100": "acme"}}}));
        assert_eq!(map(&p, Guests::Off, &invited, "u"), Ok(vec![g("100", Some("acme"), Role::Admin, false)]));
        // An unmapped foreign role makes nothing.
        assert_eq!(map(&p, Guests::Shared, &claims(json!({ZITADEL_OWNER: "200", ZITADEL_ROLES: {"x": {"200": "partner"}}})), "u"), Err(Refusal::NoRole));
        assert_eq!(fixed_organisation(&p), Some("100".into()));
    }

    #[test]
    fn zitadel_organisations_roles_and_cross_organisation_guests() {
        let p = provider(json!({"preset": "zitadel", "zitadel_project_owner_org": "100", "zitadel_foreign_organisations": "organisations"}));
        let token = claims(json!({
            ZITADEL_OWNER: "100",
            ZITADEL_ROLES: {"scribyra:admin": {"100": "acme.zitadel.cloud"}, "scribyra:member": {"100": "acme.zitadel.cloud", "200": "partner.zitadel.cloud"}, "unmapped": {"300": "other"}},
        }));
        // Home organisation: the highest role; the partner's grant makes a guest there; an org with
        // only unmapped roles is not one of theirs.
        assert_eq!(map(&p, Guests::Shared, &token, "u"), Ok(vec![g("100", Some("acme.zitadel.cloud"), Role::Admin, false), g("200", Some("partner.zitadel.cloud"), Role::Guest, true)]));
        assert_eq!(map(&p, Guests::Off, &token, "u"), Ok(vec![g("100", Some("acme.zitadel.cloud"), Role::Admin, false)]));
        // Only cross-organisation grants, guests off: refused as a guest.
        let foreign = claims(json!({ZITADEL_OWNER: "200", ZITADEL_ROLES: {"scribyra:admin": {"100": "acme"}}}));
        assert_eq!(map(&p, Guests::Off, &foreign, "u"), Err(Refusal::Guest));
        assert_eq!(map(&p, Guests::Shared, &foreign, "u"), Ok(vec![g("100", Some("acme"), Role::Guest, true)]));
        // A role mapped to guest.
        let guest = claims(json!({ZITADEL_OWNER: "100", ZITADEL_ROLES: {"scribyra:guest": {"100": "acme"}}}));
        assert_eq!(map(&p, Guests::Shared, &guest, "u"), Ok(vec![g("100", Some("acme"), Role::Guest, true)]));
        // No mapped role anywhere, or no roles claim at all.
        assert_eq!(map(&p, Guests::Shared, &claims(json!({ZITADEL_OWNER: "100", ZITADEL_ROLES: {"x": {"100": "acme"}}})), "u"), Err(Refusal::NoRole));
        assert_eq!(map(&p, Guests::Shared, &claims(json!({ZITADEL_OWNER: "100"})), "u"), Err(Refusal::NoRole));
        // Without a resource owner every grant is foreign: never an administrator by accident.
        assert_eq!(map(&p, Guests::Off, &claims(json!({ZITADEL_ROLES: {"scribyra:admin": {"100": "acme"}}})), "u"), Err(Refusal::Guest));
        // With a project ID, that project's claim counts first.
        let p = provider(json!({"preset": "zitadel", "zitadel_project_owner_org": "100", "zitadel_foreign_organisations": "organisations", "zitadel_project_id": "42"}));
        let both = claims(json!({ZITADEL_OWNER: "100", "urn:zitadel:iam:org:project:42:roles": {"scribyra:member": {"100": "acme"}}, ZITADEL_ROLES: {"scribyra:admin": {"100": "acme"}}}));
        assert_eq!(map(&p, Guests::Off, &both, "u"), Ok(vec![g("100", Some("acme"), Role::Member, false)]));
    }

    #[test]
    fn keycloak_realm_and_client_roles_and_organisations() {
        let p = provider(json!({"preset": "keycloak"}));
        let token = claims(json!({"realm_access": {"roles": ["offline_access", "scribyra:member"]}, "resource_access": {"scribyra": {"roles": ["scribyra:admin"]}, "other": {"roles": ["x"]}}}));
        assert_eq!(map(&p, Guests::Off, &token, "u"), Ok(vec![g("", None, Role::Admin, false)]));
        // Another client's roles do not count.
        let other = claims(json!({"resource_access": {"other": {"roles": ["scribyra:admin"]}}}));
        assert_eq!(map(&p, Guests::Off, &other, "u"), Err(Refusal::NoRole));
        let p = provider(json!({"preset": "keycloak", "keycloak_organizations": true}));
        let orgs = claims(json!({"realm_access": {"roles": ["acme:scribyra:member", "lab:scribyra:member"]}, "organization": {"acme": {"id": ["1"]}, "lab": {}}}));
        assert_eq!(map(&p, Guests::Off, &orgs, "u"), Ok(vec![g("acme", Some("acme"), Role::Member, false), g("lab", Some("lab"), Role::Member, false)]));
        let list = claims(json!({"realm_access": {"roles": ["scribyra:member"]}, "organization": ["acme"]}));
        assert_eq!(map(&p, Guests::Off, &list, "u"), Ok(vec![g("acme", Some("acme"), Role::Member, false)]));
        assert_eq!(map(&p, Guests::Off, &claims(json!({"realm_access": {"roles": ["scribyra:member"]}})), "u"), Err(Refusal::NoOrganisation));
        // Review M4: in several organisations, a realm or client role is no organisation's: an
        // administrator of one is not made one of all. Roles named `<alias>:<role>` (realm,
        // client or group names) count in that organisation only.
        let admin = claims(json!({"realm_access": {"roles": ["scribyra:admin"]}, "organization": ["acme", "lab"]}));
        assert_eq!(map(&p, Guests::Off, &admin, "u"), Err(Refusal::NoRole));
        let scoped = claims(json!({"realm_access": {"roles": ["scribyra:member", "lab:scribyra:member"]}, "resource_access": {"scribyra": {"roles": ["acme:scribyra:admin"]}}, "groups": ["/lab:scribyra:guest", "other:scribyra:admin"], "organization": ["acme", "lab"]}));
        assert_eq!(map(&p, Guests::Shared, &scoped, "u"), Ok(vec![g("acme", Some("acme"), Role::Admin, false), g("lab", Some("lab"), Role::Member, false)]));
        // In one organisation every role is that organisation's, prefixed or not.
        let one = claims(json!({"realm_access": {"roles": ["scribyra:admin"]}, "organization": ["acme"]}));
        assert_eq!(map(&p, Guests::Off, &one, "u"), Ok(vec![g("acme", Some("acme"), Role::Admin, false)]));
        // The configuration can say realm roles apply in every organisation.
        let mut all = p.clone();
        all.roles_apply_to_all_organisations = true;
        assert_eq!(map(&all, Guests::Off, &admin, "u"), Ok(vec![g("acme", Some("acme"), Role::Admin, false), g("lab", Some("lab"), Role::Admin, false)]));
        assert_eq!(map(&all, Guests::Off, &scoped, "u"), Ok(vec![g("acme", Some("acme"), Role::Admin, false), g("lab", Some("lab"), Role::Member, false)]));
    }

    #[test]
    fn entra_tenants_and_b2b_guests() {
        let p = provider(json!({"preset": "entra"}));
        assert_eq!(map(&p, Guests::Off, &claims(json!({"tid": "t-1", "roles": ["scribyra:member"], "acct": 0})), "u"), Ok(vec![g("t-1", None, Role::Member, false)]));
        let b2b = claims(json!({"tid": "t-1", "roles": ["scribyra:admin"], "acct": 1}));
        assert_eq!(map(&p, Guests::Off, &b2b, "u"), Err(Refusal::Guest));
        assert_eq!(map(&p, Guests::Shared, &b2b, "u"), Ok(vec![g("t-1", None, Role::Guest, true)]));
        assert_eq!(map(&p, Guests::Off, &claims(json!({"roles": ["scribyra:member"]})), "u"), Err(Refusal::NoOrganisation));
        assert_eq!(map(&p, Guests::Off, &claims(json!({"tid": "t-1"})), "u"), Err(Refusal::NoRole));
        // Review M6: without the optional `acct` claim, a B2B guest (signed in at another
        // identity provider than the tenant itself) is still a guest.
        let unmarked = claims(json!({"tid": "t-1", "roles": ["scribyra:admin"], "idp": "https://sts.windows.net/t-home/"}));
        assert_eq!(map(&p, Guests::Off, &unmarked, "u"), Err(Refusal::Guest));
        let msa = claims(json!({"tid": "t-1", "roles": ["scribyra:admin"], "idp": "live.com"}));
        assert_eq!(map(&p, Guests::Shared, &msa, "u"), Ok(vec![g("t-1", None, Role::Guest, true)]));
        let own = claims(json!({"tid": "t-1", "roles": ["scribyra:admin"], "idp": "https://sts.windows.net/t-1/"}));
        assert_eq!(map(&p, Guests::Off, &own, "u"), Ok(vec![g("t-1", None, Role::Admin, false)]));
        assert_eq!(map(&p, Guests::Off, &claims(json!({"tid": "t-1", "roles": ["scribyra:admin"]})), "u"), Ok(vec![g("t-1", None, Role::Admin, false)]));
        // The configuration can refuse tokens without `acct`.
        let mut strict = p.clone();
        strict.entra_require_acct = true;
        assert_eq!(map(&strict, Guests::Shared, &claims(json!({"tid": "t-1", "roles": ["scribyra:admin"]})), "u"), Err(Refusal::MissingClaim));
        assert_eq!(map(&strict, Guests::Off, &claims(json!({"tid": "t-1", "roles": ["scribyra:member"], "acct": 0})), "u"), Ok(vec![g("t-1", None, Role::Member, false)]));
    }

    #[test]
    fn google_workspace_domains_and_admin_subjects() {
        let mut p = provider(json!({"preset": "google", "hosted_domains": ["acme.org"]}));
        p.roles = Default::default();
        p.admin_subjects = vec!["1001".into()];
        // Review H2: another Workspace domain is refused, even for a listed subject.
        assert_eq!(map(&p, Guests::Off, &claims(json!({"hd": "evil.example"})), "1001"), Err(Refusal::Domain));
        let mut by_email = p.clone();
        (by_email.hosted_domains, by_email.email_domains) = (vec![], vec!["acme.org".into()]);
        assert_eq!(map(&by_email, Guests::Off, &claims(json!({"hd": "evil.example"})), "1002"), Err(Refusal::Domain));
        assert_eq!(map(&by_email, Guests::Off, &claims(json!({"hd": "acme.org"})), "1002"), Ok(vec![g("acme.org", Some("acme.org"), Role::Member, false)]));
        assert_eq!(map(&p, Guests::Off, &claims(json!({"hd": "acme.org"})), "1001"), Ok(vec![g("acme.org", Some("acme.org"), Role::Admin, false)]));
        assert_eq!(map(&p, Guests::Off, &claims(json!({"hd": "acme.org"})), "1002"), Ok(vec![g("acme.org", Some("acme.org"), Role::Member, false)]));
        // Consumer accounts (no hosted domain) are refused, even a listed subject.
        assert_eq!(map(&p, Guests::Off, &claims(json!({"email": "x@gmail.com"})), "1001"), Err(Refusal::NoOrganisation));
    }

    #[test]
    fn generic_paths_roles_organisations_and_guests() {
        let p = provider(json!({"claims": {"organisation": "$.org.id", "organisation_name": "$.org[\"display.name\"]", "roles": "$[\"urn:acme:roles\"]", "guest": {"path": "$.kind", "equals": "external"}}}));
        let token = claims(json!({"org": {"id": 7, "display.name": "Acme Lab"}, "urn:acme:roles": "scribyra:member"}));
        assert_eq!(map(&p, Guests::Off, &token, "u"), Ok(vec![g("7", Some("Acme Lab"), Role::Member, false)]));
        let external = claims(json!({"org": {"id": "7"}, "urn:acme:roles": ["scribyra:admin"], "kind": "external"}));
        assert_eq!(map(&p, Guests::Shared, &external, "u"), Ok(vec![g("7", None, Role::Guest, true)]));
        assert_eq!(map(&p, Guests::Off, &external, "u"), Err(Refusal::Guest));
        assert_eq!(map(&p, Guests::Off, &claims(json!({"urn:acme:roles": ["scribyra:member"]})), "u"), Err(Refusal::NoOrganisation));
        // Without an organisation path the provider has one organisation.
        let one = provider(json!({"claims": {"roles": "$.roles"}}));
        assert_eq!(map(&one, Guests::Off, &claims(json!({"roles": ["scribyra:admin", "scribyra:member"]})), "u"), Ok(vec![g("", None, Role::Admin, false)]));
        assert_eq!(map(&one, Guests::Off, &claims(json!({"roles": [1, {"x": 1}]})), "u"), Err(Refusal::NoRole));
        assert_eq!(map(&one, Guests::Off, &claims(json!({})), "u"), Err(Refusal::NoRole));
    }
}

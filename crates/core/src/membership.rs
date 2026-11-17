//! The organisation membership log: a hash-chained list of signed events that the service
//! and every client replay with this same code to reach the same answer about who belongs
//! to an organisation, with which role, which devices and recovery keys are theirs, and who
//! may open which project.
//!
//! The rules here are the whole authorisation model for content keys. The service enforces
//! them before appending (and adds checks only it can make: invitation expiry against its
//! clock, single sign-on); clients enforce them again on every event they receive.
use crate::orgsync::{Error, Result, canonical, ed25519_verify, hex, is_hex, is_uuid, person_id, sha256, valid_agreement_key};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_EVENTS: usize = 100_000;
pub const MAX_EVENT_BYTES: usize = 16 * 1024;
/// Encrypted names (nonce, ciphertext and tag, in hex) are at most this long.
pub const MAX_NAME_HEX: usize = 2 * (24 + 16 + 256);
pub const ORG_ROLES: &[&str] = &["owner", "admin", "member"];
pub const PROJECT_ROLES: &[&str] = &["editor", "reviewer", "viewer"];
pub const MODES: &[&str] = &["e2ee", "managed"];

const fn fail(message: &'static str) -> Error {
    Error(message)
}
fn without(value: &Value, field: &str) -> Value {
    let mut copy = value.clone();
    if let Some(map) = copy.as_object_mut() {
        map.remove(field);
    }
    copy
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub v: u32,
    pub org: String,
    pub prev: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub body: Value,
    pub signer: String,
    pub sig: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GenesisBody {
    pub person: String,
    pub device: String,
    pub agreement: String,
    pub enrol: String,
    pub enrol_sig: String,
    pub mode: String,
    pub admin_read: bool,
    /// The org's name, encrypted under the directory key (hex nonce ‖ ciphertext).
    pub name: String,
    /// Key commitment of the directory key (epoch 1).
    pub directory_commit: String,
    /// The owner's own display name, encrypted under the directory key.
    pub owner_name: String,
    /// Organisation-managed orgs only: the service's X25519 org key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_key: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryBody {
    person: String,
    signing: String,
    agreement: String,
    proof: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceBody {
    person: String,
    device: String,
    agreement: String,
    proof: String,
    /// Set when the device was linked with a one-time device link: the proof binds the link
    /// instead of the log head, and each link adds one device.
    #[serde(default)]
    link: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceRemoveBody {
    device: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProjectBody {
    project: String,
    epoch: u32,
    key_commit: String,
    #[serde(default)]
    name: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InviteBody {
    pub invite: String,
    pub invite_key: String,
    pub role: String,
    pub expires: u64,
    pub approval: bool,
    pub sso: bool,
    #[serde(default)]
    pub email_hash: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub project_role: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InviteRevokeBody {
    invite: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JoinBody {
    pub invite: String,
    pub person: String,
    pub device: String,
    pub agreement: String,
    pub proof: String,
    pub invite_sig: String,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestBody {
    pub person: String,
    pub device: String,
    pub agreement: String,
    pub proof: String,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersonRoleBody {
    person: String,
    role: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersonBody {
    person: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantBody {
    project: String,
    person: String,
    role: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokeBody {
    project: String,
    person: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    /// `owner`, `admin` or `member`.
    pub role: String,
    /// `active`, `pending` (joined or asked to join, waiting for an admin) or `removed`.
    pub state: String,
    /// How the person arrived: `genesis`, `invite` or `sso`.
    pub via: String,
    /// Display name encrypted under the directory key.
    pub name: Option<String>,
    pub recovery_signing: Option<String>,
    pub recovery_agreement: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub person: String,
    pub agreement: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub creator: String,
    pub epoch: u32,
    pub key_commit: String,
    /// Person → `editor`, `reviewer` or `viewer`.
    pub members: BTreeMap<String, String>,
    /// The project's name encrypted under its name key, if the creator published one.
    pub name: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub creator: String,
    pub key: String,
    pub role: String,
    pub expires: u64,
    pub approval: bool,
    pub sso: bool,
    pub email_hash: Option<String>,
    pub project: Option<String>,
    pub project_role: Option<String>,
    /// `open`, `used` or `revoked`.
    pub state: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrgState {
    pub org: String,
    /// Hash of the last applied event; the next event's `prev`. The org ID before genesis.
    pub head: String,
    pub count: u64,
    pub genesis: Option<String>,
    pub mode: Option<String>,
    pub admin_read: bool,
    pub enrol: Option<String>,
    pub name: Option<String>,
    pub directory_commit: Option<String>,
    pub service_key: Option<String>,
    pub persons: BTreeMap<String, Person>,
    pub devices: BTreeMap<String, Device>,
    pub projects: BTreeMap<String, Project>,
    pub invites: BTreeMap<String, Invite>,
    /// Device links already used (each adds one device).
    pub links: BTreeSet<String>,
    /// Keys that were removed and can never be registered again.
    pub retired: BTreeSet<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyRole {
    Device { person: String },
    Recovery { person: String },
}

pub fn event_signing_message(event: &Value) -> Result<Vec<u8>> {
    Ok(format!("scribyra-org-event/1\n{}", canonical(&without(event, "sig"))?).into_bytes())
}
pub fn event_hash(event: &Value) -> Result<String> {
    Ok(hex(&sha256(canonical(event)?.as_bytes())))
}
/// Signed by a new device's own key: binds it to its person, agreement key and the log
/// position it joins at (or the one-time link it was added with, `link:<id>`), so a proof
/// cannot be replayed later.
pub fn device_proof_message(org: &str, prev: &str, person: &str, device: &str, agreement: &str) -> Vec<u8> {
    format!("scribyra-device-proof/1\n{org}\n{prev}\n{person}\n{device}\n{agreement}").into_bytes()
}
/// Signed by a recovery signing key: proves the person who registers it holds the code.
pub fn recovery_proof_message(org: &str, prev: &str, person: &str, signing: &str, agreement: &str) -> Vec<u8> {
    format!("scribyra-recovery-proof/1\n{org}\n{prev}\n{person}\n{signing}\n{agreement}").into_bytes()
}
/// Signed by the invitation key (derived from the link's secret): proves the joiner holds the
/// link and binds the join to one log position, person and set of keys.
pub fn invite_message(org: &str, prev: &str, invite: &str, person: &str, device: &str, agreement: &str) -> Vec<u8> {
    format!("scribyra-invite/1\n{org}\n{prev}\n{invite}\n{person}\n{device}\n{agreement}").into_bytes()
}
/// Signed by a device link's key (derived from the link secret only the two devices know) over
/// the new device's keys, so the service cannot substitute other keys into a link request.
pub fn device_request_message(org: &str, link: &str, person: &str, device: &str, agreement: &str) -> Vec<u8> {
    format!("scribyra-device-request/1\n{org}\n{link}\n{person}\n{device}\n{agreement}").into_bytes()
}
/// The binding a linked device's proof uses in place of the log head.
pub fn link_binding(link: &str) -> String {
    format!("link:{link}")
}
fn valid_name(name: &str) -> bool {
    name.len() >= 2 * (24 + 16) && name.len() <= MAX_NAME_HEX && is_hex(name, name.len() / 2)
}

impl OrgState {
    pub fn new(org: &str) -> Result<Self> {
        if !is_hex(org, 32) {
            return Err(fail("invalid organisation ID"));
        }
        Ok(Self { org: org.into(), head: org.into(), ..Default::default() })
    }
    fn active(&self, person: &str) -> bool {
        self.persons.get(person).is_some_and(|p| p.state == "active")
    }
    fn role_of(&self, person: &str) -> Option<&str> {
        self.persons.get(person).filter(|p| p.state == "active").map(|p| p.role.as_str())
    }
    pub fn is_admin(&self, person: &str) -> bool {
        matches!(self.role_of(person), Some("owner" | "admin"))
    }
    /// The role a key acts with, if it belongs to an active person: one of their devices, or
    /// their recovery key.
    pub fn key_role(&self, key: &str) -> Option<KeyRole> {
        if let Some(device) = self.devices.get(key) {
            return self.active(&device.person).then(|| KeyRole::Device { person: device.person.clone() });
        }
        self.persons
            .iter()
            .find(|(_, p)| p.state == "active" && p.recovery_signing.as_deref() == Some(key))
            .map(|(id, _)| KeyRole::Recovery { person: id.clone() })
    }
    /// The person of an active device key.
    pub fn device_person(&self, key: &str) -> Option<&str> {
        self.devices.get(key).map(|d| d.person.as_str()).filter(|p| self.active(p))
    }
    /// The person's role on a project, if they are an active member of it.
    pub fn project_role(&self, person: &str, project: &str) -> Option<&str> {
        if !self.active(person) {
            return None;
        }
        self.projects.get(project).and_then(|p| p.members.get(person)).map(String::as_str)
    }
    /// Whether this person may read the project's log (any project role).
    pub fn can_access(&self, person: &str, project: &str) -> bool {
        self.project_role(person, project).is_some()
    }
    /// Whether this person may append to the project's log. Until receivers check role
    /// scopes (design slice 8), only editors write.
    pub fn can_write(&self, person: &str, project: &str) -> bool {
        self.project_role(person, project) == Some("editor")
    }
    fn person_keys(&self, person: &str, out: &mut BTreeSet<String>) {
        if !self.active(person) {
            return;
        }
        out.extend(self.devices.values().filter(|d| d.person == person).map(|d| d.agreement.clone()));
        if let Some(r) = self.persons.get(person).and_then(|p| p.recovery_agreement.clone()) {
            out.insert(r);
        }
    }
    /// X25519 keys entitled to a project's key (or, with `project == org`, the directory key):
    /// member devices and their recovery keys, admins' when admin read access is on, and the
    /// service's org key in an organisation-managed org.
    pub fn wrap_recipients(&self, project: &str) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        if project == self.org {
            for person in self.persons.keys() {
                self.person_keys(person, &mut out);
            }
        } else {
            let Some(p) = self.projects.get(project) else { return out };
            for person in p.members.keys() {
                self.person_keys(person, &mut out);
            }
            if self.admin_read {
                for (person, _) in self.persons.iter().filter(|(_, p)| matches!(p.role.as_str(), "owner" | "admin")) {
                    self.person_keys(person, &mut out);
                }
            }
        }
        if let Some(service) = &self.service_key {
            out.insert(service.clone());
        }
        out
    }
    /// Whether a device may hand out (wrap) this key: an active member device of the project
    /// (or any active member for the directory key).
    pub fn may_wrap(&self, sender_person: &str, project: &str) -> bool {
        if project == self.org {
            return self.active(sender_person);
        }
        self.can_access(sender_person, project) || (self.admin_read && self.is_admin(sender_person) && self.projects.contains_key(project))
    }
    /// The current epoch of a project's key, or 1 for the directory.
    pub fn key_epoch(&self, project: &str) -> Option<u32> {
        if project == self.org {
            return self.genesis.as_ref().map(|_| 1);
        }
        self.projects.get(project).map(|p| p.epoch)
    }
    /// Every X25519 key that may currently receive wraps: device and recovery agreement keys
    /// of active people, and the service key.
    pub fn agreement_keys(&self) -> BTreeSet<String> {
        let mut keys = BTreeSet::new();
        for person in self.persons.keys() {
            self.person_keys(person, &mut keys);
        }
        if let Some(service) = &self.service_key {
            keys.insert(service.clone());
        }
        keys
    }
    fn known_key(&self, key: &str) -> bool {
        self.retired.contains(key)
            || self.service_key.as_deref() == Some(key)
            || self.devices.contains_key(key)
            || self.devices.values().any(|d| d.agreement == key)
            || self.persons.values().any(|p| p.recovery_signing.as_deref() == Some(key) || p.recovery_agreement.as_deref() == Some(key))
            || self.invites.values().any(|i| i.key == key)
    }
    fn new_device_keys(&self, device: &str, agreement: &str) -> Result<()> {
        if !is_hex(device, 32) || !valid_agreement_key(agreement) || device == agreement {
            return Err(fail("invalid device keys"));
        }
        if self.known_key(device) || self.known_key(agreement) {
            return Err(fail("device keys must be new"));
        }
        Ok(())
    }
    fn active_owners(&self) -> usize {
        self.persons.values().filter(|p| p.state == "active" && p.role == "owner").count()
    }
    fn retire_person_keys(&mut self, person: &str) {
        let keys: Vec<(String, String)> = self.devices.iter().filter(|(_, d)| d.person == person).map(|(k, d)| (k.clone(), d.agreement.clone())).collect();
        for (key, agreement) in keys {
            self.devices.remove(&key);
            self.retired.insert(key);
            self.retired.insert(agreement);
        }
        if let Some(p) = self.persons.get_mut(person) {
            for key in [p.recovery_signing.take(), p.recovery_agreement.take()].into_iter().flatten() {
                self.retired.insert(key);
            }
        }
    }

    /// Validate and apply one event. `expected_enrol`, when given, is the enrolment
    /// key the verifier already trusts (the server's stored key, or the key the
    /// owner derived from their setup code); genesis must match it.
    pub fn apply(&mut self, raw: &str, expected_enrol: Option<&str>) -> Result<String> {
        if raw.len() > MAX_EVENT_BYTES {
            return Err(fail("membership event is too large"));
        }
        if self.count as usize >= MAX_EVENTS {
            return Err(fail("membership log is full"));
        }
        let value: Value = serde_json::from_str(raw).map_err(|_| fail("membership event is not JSON"))?;
        if canonical(&value)? != raw {
            return Err(fail("membership event is not in canonical form"));
        }
        let event: Event = serde_json::from_value(value.clone()).map_err(|_| fail("invalid membership event"))?;
        if event.v != 1 || event.org != self.org {
            return Err(fail("membership event belongs to another organisation or version"));
        }
        if event.prev != self.head {
            return Err(fail("membership event does not follow the current head"));
        }
        if !ed25519_verify(&event.signer, &event_signing_message(&value)?, &event.sig) {
            return Err(fail("membership event signature is invalid"));
        }
        let hash = event_hash(&value)?;
        // Apply to a copy, so a failing rule never leaves a half-applied event behind.
        let mut next = self.clone();
        next.apply_event(&event, expected_enrol)?;
        if event.kind == "genesis" {
            next.genesis = Some(hash.clone());
        }
        next.head = hash.clone();
        next.count += 1;
        *self = next;
        Ok(hash)
    }

    fn apply_event(&mut self, event: &Event, expected_enrol: Option<&str>) -> Result<()> {
        let body = event.body.clone();
        let parse = |_| fail("invalid membership event body");
        if self.genesis.is_none() {
            if event.kind != "genesis" {
                return Err(fail("the membership log must start with genesis"));
            }
            let b: GenesisBody = serde_json::from_value(body).map_err(parse)?;
            if !is_hex(&b.device, 32) || !is_hex(&b.enrol, 32) || !is_hex(&b.enrol_sig, 64) || !valid_agreement_key(&b.agreement) {
                return Err(fail("invalid genesis keys"));
            }
            if !MODES.contains(&b.mode.as_str()) {
                return Err(fail("unknown encryption mode"));
            }
            match (&b.mode[..], &b.service_key) {
                ("managed", Some(key)) if valid_agreement_key(key) => {}
                ("e2ee", None) => {}
                _ => return Err(fail("organisation-managed orgs need the service key, end-to-end encrypted ones must not have one")),
            }
            if !valid_name(&b.name) || !valid_name(&b.owner_name) || !is_hex(&b.directory_commit, 32) {
                return Err(fail("invalid genesis names or directory key"));
            }
            if event.signer != b.device || b.person != person_id(&self.org, &b.device)? {
                return Err(fail("genesis must be signed by the owner's first device"));
            }
            if expected_enrol.is_some_and(|k| k != b.enrol) {
                return Err(fail("genesis does not match the setup code"));
            }
            if !ed25519_verify(&b.enrol, &crate::orgsync::enrol_message(&self.org, &b), &b.enrol_sig) {
                return Err(fail("genesis enrolment signature is invalid"));
            }
            let keys = [&b.device, &b.agreement, &b.enrol];
            if keys.iter().enumerate().any(|(i, k)| keys[i + 1..].contains(k) || b.service_key.as_ref() == Some(*k)) {
                return Err(fail("genesis keys must be distinct"));
            }
            self.persons.insert(b.person.clone(), Person { role: "owner".into(), state: "active".into(), via: "genesis".into(), name: Some(b.owner_name), ..Default::default() });
            self.devices.insert(b.device.clone(), Device { person: b.person, agreement: b.agreement });
            self.mode = Some(b.mode);
            self.admin_read = b.admin_read;
            self.enrol = Some(b.enrol);
            self.name = Some(b.name);
            self.directory_commit = Some(b.directory_commit);
            self.service_key = b.service_key;
            return Ok(());
        }
        // The signer of every later event is an active device (or, for device.add, a
        // recovery key) — except joins and join requests, which the joining device signs.
        let signer = self.key_role(&event.signer);
        let signer_device = match &signer {
            Some(KeyRole::Device { person }) => Some(person.clone()),
            _ => None,
        };
        let device_signer = || signer_device.clone().ok_or(fail("this event must be signed by an active member device"));
        match event.kind.as_str() {
            "genesis" => return Err(fail("the organisation already has a genesis")),
            "recovery.set" => {
                let b: RecoveryBody = serde_json::from_value(body).map_err(parse)?;
                if !is_hex(&b.signing, 32) || !valid_agreement_key(&b.agreement) || b.signing == b.agreement {
                    return Err(fail("invalid recovery keys"));
                }
                if device_signer()? != b.person {
                    return Err(fail("only the person's own device can set their recovery key"));
                }
                if self.known_key(&b.signing) || self.known_key(&b.agreement) {
                    return Err(fail("recovery keys must be new"));
                }
                if !ed25519_verify(&b.signing, &recovery_proof_message(&self.org, &event.prev, &b.person, &b.signing, &b.agreement), &b.proof) {
                    return Err(fail("the recovery key was not proven"));
                }
                let person = self.persons.get_mut(&b.person).ok_or(fail("unknown person"))?;
                let old: Vec<String> = [person.recovery_signing.replace(b.signing), person.recovery_agreement.replace(b.agreement)].into_iter().flatten().collect();
                self.retired.extend(old);
            }
            "device.add" => {
                let b: DeviceBody = serde_json::from_value(body).map_err(parse)?;
                let certifier = match &signer {
                    Some(KeyRole::Device { person } | KeyRole::Recovery { person }) => person.clone(),
                    None => return Err(fail("unknown certifier")),
                };
                if certifier != b.person || !self.active(&b.person) {
                    return Err(fail("a device can only be added by the same person"));
                }
                // A device of the same person may come back with a new agreement key (its
                // browser lost the old one); its signing key stays. Anything else must be new.
                let rekey = self.devices.get(&b.device).is_some_and(|d| d.person == b.person);
                if rekey {
                    if !valid_agreement_key(&b.agreement) || b.device == b.agreement || self.known_key(&b.agreement) {
                        return Err(fail("device keys must be new"));
                    }
                } else {
                    self.new_device_keys(&b.device, &b.agreement)?;
                }
                let binding = match &b.link {
                    Some(link) => {
                        if !is_hex(link, 16) || self.links.contains(link) || rekey {
                            return Err(fail("this device link was already used"));
                        }
                        link_binding(link)
                    }
                    None => event.prev.clone(),
                };
                if !ed25519_verify(&b.device, &device_proof_message(&self.org, &binding, &b.person, &b.device, &b.agreement), &b.proof) {
                    return Err(fail("the new device did not prove possession of its key"));
                }
                if rekey {
                    let old = self.devices[&b.device].agreement.clone();
                    self.retired.insert(old);
                }
                if let Some(link) = b.link {
                    self.links.insert(link);
                }
                self.devices.insert(b.device, Device { person: b.person, agreement: b.agreement });
            }
            "device.remove" => {
                let b: DeviceRemoveBody = serde_json::from_value(body).map_err(parse)?;
                let remover = device_signer()?;
                let device = self.devices.get(&b.device).ok_or(fail("unknown device"))?.clone();
                if remover != device.person && !self.may_manage(&remover, &device.person) {
                    return Err(fail("only the same person or an admin can remove a device"));
                }
                self.devices.remove(&b.device);
                self.retired.insert(b.device);
                self.retired.insert(device.agreement);
            }
            "invite.create" => {
                let b: InviteBody = serde_json::from_value(body).map_err(parse)?;
                let creator = device_signer()?;
                if !is_hex(&b.invite, 16) || !is_hex(&b.invite_key, 32) || self.invites.contains_key(&b.invite) || self.known_key(&b.invite_key) {
                    return Err(fail("invalid or reused invitation"));
                }
                if !matches!(b.role.as_str(), "admin" | "member") || b.expires == 0 || b.email_hash.as_deref().is_some_and(|h| !is_hex(h, 32)) {
                    return Err(fail("invalid invitation"));
                }
                if b.email_hash.is_some() && !b.sso {
                    return Err(fail("an email-bound invitation must require single sign-on"));
                }
                match (&b.project, &b.project_role) {
                    (Some(project), Some(role)) => {
                        if !PROJECT_ROLES.contains(&role.as_str()) || !self.can_write(&creator, project) {
                            return Err(fail("only a project's editor can invite to it"));
                        }
                    }
                    (None, None) => {}
                    _ => return Err(fail("invalid invitation")),
                }
                let admin = self.is_admin(&creator);
                if !admin && (b.role != "member" || b.project.is_none() || !b.approval) {
                    return Err(fail("members may only invite to their own projects, with approval"));
                }
                if b.role == "admin" && !b.approval {
                    return Err(fail("admin invitations always need approval"));
                }
                self.invites.insert(
                    b.invite,
                    Invite { creator, key: b.invite_key, role: b.role, expires: b.expires, approval: b.approval, sso: b.sso, email_hash: b.email_hash, project: b.project, project_role: b.project_role, state: "open".into() },
                );
            }
            "invite.revoke" => {
                let b: InviteRevokeBody = serde_json::from_value(body).map_err(parse)?;
                let revoker = device_signer()?;
                let invite = self.invites.get_mut(&b.invite).ok_or(fail("unknown invitation"))?;
                if invite.state != "open" {
                    return Err(fail("the invitation is no longer open"));
                }
                let creator = invite.creator.clone();
                if revoker != creator && !self.is_admin(&revoker) {
                    return Err(fail("only the invitation's creator or an admin can revoke it"));
                }
                self.invites.get_mut(&b.invite).unwrap().state = "revoked".into();
            }
            "person.join" => {
                let b: JoinBody = serde_json::from_value(body).map_err(parse)?;
                if event.signer != b.device || b.person != person_id(&self.org, &b.device)? || self.persons.contains_key(&b.person) {
                    return Err(fail("a join must be signed by the joining person's new device"));
                }
                self.new_device_keys(&b.device, &b.agreement)?;
                if !valid_name(&b.name) {
                    return Err(fail("invalid display name"));
                }
                let invite = self.invites.get(&b.invite).filter(|i| i.state == "open").ok_or(fail("the invitation is not open"))?.clone();
                if !ed25519_verify(&b.device, &device_proof_message(&self.org, &event.prev, &b.person, &b.device, &b.agreement), &b.proof) {
                    return Err(fail("the new device did not prove possession of its key"));
                }
                if !ed25519_verify(&invite.key, &invite_message(&self.org, &event.prev, &b.invite, &b.person, &b.device, &b.agreement), &b.invite_sig) {
                    return Err(fail("the join was not signed with the invitation"));
                }
                // The invitation's creator must still be allowed to have made it.
                if !self.active(&invite.creator) {
                    return Err(fail("the invitation's creator is no longer a member"));
                }
                let state = if invite.approval { "pending" } else { "active" };
                self.persons.insert(b.person.clone(), Person { role: invite.role.clone(), state: state.into(), via: "invite".into(), name: Some(b.name), ..Default::default() });
                self.devices.insert(b.device, Device { person: b.person.clone(), agreement: b.agreement });
                if let (Some(project), Some(role)) = (&invite.project, &invite.project_role)
                    && let Some(p) = self.projects.get_mut(project)
                {
                    p.members.insert(b.person, role.clone());
                }
                self.invites.get_mut(&b.invite).unwrap().state = "used".into();
            }
            "person.request" => {
                // Asking to join through single sign-on: the service accepts this only with a
                // valid SSO login; the person stays pending, with no access, until approved.
                let b: RequestBody = serde_json::from_value(body).map_err(parse)?;
                if event.signer != b.device || b.person != person_id(&self.org, &b.device)? || self.persons.contains_key(&b.person) {
                    return Err(fail("a join request must be signed by the person's new device"));
                }
                self.new_device_keys(&b.device, &b.agreement)?;
                if !valid_name(&b.name) {
                    return Err(fail("invalid display name"));
                }
                if !ed25519_verify(&b.device, &device_proof_message(&self.org, &event.prev, &b.person, &b.device, &b.agreement), &b.proof) {
                    return Err(fail("the new device did not prove possession of its key"));
                }
                self.persons.insert(b.person.clone(), Person { role: "member".into(), state: "pending".into(), via: "sso".into(), name: Some(b.name), ..Default::default() });
                self.devices.insert(b.device, Device { person: b.person, agreement: b.agreement });
            }
            "person.approve" => {
                let b: PersonRoleBody = serde_json::from_value(body).map_err(parse)?;
                let approver = device_signer()?;
                if self.persons.get(&b.person).map(|p| p.state.as_str()) != Some("pending") {
                    return Err(fail("only a pending person can be approved"));
                }
                self.check_role_change(&approver, None, &b.role)?;
                let p = self.persons.get_mut(&b.person).unwrap();
                p.state = "active".into();
                p.role = b.role;
            }
            "person.role" => {
                let b: PersonRoleBody = serde_json::from_value(body).map_err(parse)?;
                let changer = device_signer()?;
                let current = self.role_of(&b.person).ok_or(fail("only an active person's role can change"))?.to_string();
                self.check_role_change(&changer, Some(&current), &b.role)?;
                if current == "owner" && b.role != "owner" && self.active_owners() == 1 {
                    return Err(fail("an organisation always keeps at least one owner"));
                }
                self.persons.get_mut(&b.person).unwrap().role = b.role;
            }
            "person.remove" => {
                let b: PersonBody = serde_json::from_value(body).map_err(parse)?;
                let remover = device_signer()?;
                let target = self.persons.get(&b.person).filter(|p| p.state != "removed").ok_or(fail("unknown person"))?.clone();
                let leaving = remover == b.person;
                if !leaving && !self.may_manage(&remover, &b.person) {
                    return Err(fail("this device cannot remove that person"));
                }
                if target.state == "active" && target.role == "owner" && self.active_owners() == 1 {
                    return Err(fail("an organisation always keeps at least one owner"));
                }
                self.retire_person_keys(&b.person);
                self.persons.get_mut(&b.person).unwrap().state = "removed".into();
                for project in self.projects.values_mut() {
                    project.members.remove(&b.person);
                }
                for invite in self.invites.values_mut().filter(|i| i.creator == b.person && i.state == "open") {
                    invite.state = "revoked".into();
                }
            }
            "project.create" => {
                let b: ProjectBody = serde_json::from_value(body).map_err(parse)?;
                if !is_hex(&b.project, 32) || !is_hex(&b.key_commit, 32) || b.epoch != 1 || b.project == self.org {
                    return Err(fail("invalid project"));
                }
                if b.name.as_deref().is_some_and(|n| !valid_name(n)) {
                    return Err(fail("invalid project name"));
                }
                let person = device_signer()?;
                if self.projects.contains_key(&b.project) {
                    return Err(fail("project already exists"));
                }
                self.projects.insert(b.project, Project { creator: person.clone(), epoch: 1, key_commit: b.key_commit, members: BTreeMap::from([(person, "editor".into())]), name: b.name });
            }
            "project.grant" => {
                let b: GrantBody = serde_json::from_value(body).map_err(parse)?;
                let granter = device_signer()?;
                if !PROJECT_ROLES.contains(&b.role.as_str()) {
                    return Err(fail("unknown project role"));
                }
                if !self.can_write(&granter, &b.project) {
                    return Err(fail("only a project's editor can share it"));
                }
                if !self.persons.get(&b.person).is_some_and(|p| p.state != "removed") {
                    return Err(fail("unknown person"));
                }
                let project = self.projects.get_mut(&b.project).unwrap();
                if project.members.get(&b.person).map(String::as_str) == Some("editor") && b.role != "editor" && project.members.values().filter(|r| *r == "editor").count() == 1 {
                    return Err(fail("a project always keeps at least one editor"));
                }
                project.members.insert(b.person, b.role);
            }
            "project.revoke" => {
                let b: RevokeBody = serde_json::from_value(body).map_err(parse)?;
                let revoker = device_signer()?;
                if revoker != b.person && !self.can_write(&revoker, &b.project) {
                    return Err(fail("only a project's editor (or the person themselves) can revoke access"));
                }
                let project = self.projects.get_mut(&b.project).ok_or(fail("unknown project"))?;
                let role = project.members.get(&b.person).ok_or(fail("that person has no access"))?;
                if role == "editor" && project.members.values().filter(|r| *r == "editor").count() == 1 {
                    return Err(fail("a project always keeps at least one editor"));
                }
                project.members.remove(&b.person);
            }
            _ => return Err(fail("unsupported membership event type")),
        }
        Ok(())
    }
    /// Admins manage members and admins; only owners manage owners.
    fn may_manage(&self, actor: &str, target: &str) -> bool {
        match (self.role_of(actor), self.persons.get(target).map(|p| p.role.as_str())) {
            (Some("owner"), _) => true,
            (Some("admin"), Some("member" | "admin")) => true,
            _ => false,
        }
    }
    fn check_role_change(&self, actor: &str, current: Option<&str>, role: &str) -> Result<()> {
        if !ORG_ROLES.contains(&role) {
            return Err(fail("unknown organisation role"));
        }
        let allowed = match self.role_of(actor) {
            Some("owner") => true,
            Some("admin") => role != "owner" && current != Some("owner"),
            _ => false,
        };
        if allowed { Ok(()) } else { Err(fail("this device cannot give that role")) }
    }
}

/// Basic shape checks for a person ID that arrives from outside the log.
pub fn valid_person(id: &str) -> bool {
    is_uuid(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orgsync::{ed25519_public, ed25519_sign, enrol_message, enrol_seed, x25519_public};
    use serde_json::json;

    fn sign(seed: &[u8], message: &[u8]) -> String {
        hex(&ed25519_sign(seed, message).unwrap())
    }
    fn name() -> String {
        hex(&[0x6e; 64])
    }
    /// A device: signing seed, key, agreement key and the person ID it would found.
    #[derive(Clone)]
    struct Dev {
        seed: Vec<u8>,
        key: String,
        agreement: String,
    }
    fn dev(n: u8) -> Dev {
        let seed = vec![n; 32];
        Dev { key: hex(&ed25519_public(&seed).unwrap()), agreement: hex(&x25519_public(&[n.wrapping_add(100); 32]).unwrap()), seed }
    }
    struct Org {
        id: String,
        state: OrgState,
    }
    impl Org {
        fn event(&self, kind: &str, body: Value, seed: &[u8]) -> String {
            let signer = hex(&ed25519_public(seed).unwrap());
            let mut value = json!({"v":1,"org":self.id,"prev":self.state.head,"type":kind,"body":body,"signer":signer});
            value["sig"] = json!(sign(seed, &event_signing_message(&value).unwrap()));
            canonical(&value).unwrap()
        }
        fn apply(&mut self, kind: &str, body: Value, seed: &[u8]) -> Result<String> {
            let raw = self.event(kind, body, seed);
            self.state.apply(&raw, None)
        }
        fn person(&self, d: &Dev) -> String {
            person_id(&self.id, &d.key).unwrap()
        }
        fn invite(&mut self, by: &Dev, n: u8, role: &str, approval: bool, project: Option<(&str, &str)>) -> Result<(String, Vec<u8>)> {
            let (invite, seed) = (hex(&[n; 16]), vec![n.wrapping_add(50); 32]);
            let mut body = json!({"invite":invite,"inviteKey":hex(&ed25519_public(&seed).unwrap()),"role":role,"expires":4_000_000_000u64,"approval":approval,"sso":false});
            if let Some((p, r)) = project {
                body["project"] = json!(p);
                body["projectRole"] = json!(r);
            }
            self.apply("invite.create", body, &by.seed).map(|_| (invite, seed))
        }
        fn join_body(&self, d: &Dev, invite: &str, invite_seed: &[u8]) -> Value {
            let person = self.person(d);
            let proof = sign(&d.seed, &device_proof_message(&self.id, &self.state.head, &person, &d.key, &d.agreement));
            let invite_sig = sign(invite_seed, &invite_message(&self.id, &self.state.head, invite, &person, &d.key, &d.agreement));
            json!({"invite":invite,"person":person,"device":d.key,"agreement":d.agreement,"proof":proof,"inviteSig":invite_sig,"name":name()})
        }
        fn join(&mut self, d: &Dev, invite: &str, invite_seed: &[u8]) -> Result<String> {
            let body = self.join_body(d, invite, invite_seed);
            self.apply("person.join", body, &d.seed)
        }
        fn project(&mut self, by: &Dev, n: u8) -> String {
            let project = hex(&[n; 32]);
            self.apply("project.create", json!({"project":project,"epoch":1,"keyCommit":hex(&[n; 32])}), &by.seed).unwrap();
            project
        }
    }
    fn org(mode: &str, admin_read: bool) -> (Org, Dev) {
        let id = hex(&[7; 32]);
        let owner = dev(1);
        let enrol = enrol_seed(&[9u8; 32]).unwrap();
        let mut body = GenesisBody {
            person: person_id(&id, &owner.key).unwrap(),
            device: owner.key.clone(),
            agreement: owner.agreement.clone(),
            enrol: hex(&ed25519_public(&enrol).unwrap()),
            enrol_sig: String::new(),
            mode: mode.into(),
            admin_read,
            name: name(),
            directory_commit: hex(&[0x44; 32]),
            owner_name: name(),
            service_key: (mode == "managed").then(|| hex(&x25519_public(&[0x5e; 32]).unwrap())),
        };
        body.enrol_sig = sign(&enrol, &enrol_message(&id, &body));
        let mut o = Org { state: OrgState::new(&id).unwrap(), id };
        let raw = o.event("genesis", serde_json::to_value(&body).unwrap(), &owner.seed);
        o.state.apply(&raw, Some(&body.enrol)).unwrap();
        (o, owner)
    }

    #[test]
    fn genesis_binds_mode_names_and_service_key_to_the_setup_code() {
        let (o, _) = org("managed", true);
        assert_eq!(o.state.mode.as_deref(), Some("managed"));
        assert!(o.state.service_key.is_some());
        let (o, owner) = org("e2ee", false);
        assert!(!o.state.admin_read);
        // A tampered name (or mode, or service key) breaks the setup code's signature.
        let enrol = enrol_seed(&[9u8; 32]).unwrap();
        for (field, value) in [("name", json!(hex(&[1; 64]))), ("mode", json!("managed")), ("adminRead", json!(true))] {
            let mut body = json!({"person":o.person(&owner),"device":owner.key,"agreement":owner.agreement,"enrol":hex(&ed25519_public(&enrol).unwrap()),"enrolSig":"","mode":"e2ee","adminRead":false,"name":name(),"directoryCommit":hex(&[0x44;32]),"ownerName":name()});
            let parsed: GenesisBody = serde_json::from_value(body.clone()).unwrap();
            body["enrolSig"] = json!(sign(&enrol, &enrol_message(&o.id, &parsed)));
            body[field] = value;
            if field == "mode" {
                body["serviceKey"] = json!(hex(&x25519_public(&[0x5e; 32]).unwrap()));
            }
            let mut fresh = Org { id: o.id.clone(), state: OrgState::new(&o.id).unwrap() };
            let raw = fresh.event("genesis", body, &owner.seed);
            assert!(fresh.state.apply(&raw, None).is_err(), "{field}");
        }
        // Managed needs a service key; end-to-end must not have one.
        let mut fresh = Org { id: o.id.clone(), state: OrgState::new(&o.id).unwrap() };
        let body = json!({"person":o.person(&owner),"device":owner.key,"agreement":owner.agreement,"enrol":hex(&[3;32]),"enrolSig":hex(&[0;64]),"mode":"managed","adminRead":true,"name":name(),"directoryCommit":hex(&[0x44;32]),"ownerName":name()});
        let raw = fresh.event("genesis", body, &owner.seed);
        assert_eq!(fresh.state.apply(&raw, None).unwrap_err().0, "organisation-managed orgs need the service key, end-to-end encrypted ones must not have one");
    }

    #[test]
    fn invitations_admit_once_and_approval_gates_access() {
        let (mut o, owner) = org("e2ee", true);
        let (invite, seed) = o.invite(&owner, 2, "member", false, None).unwrap();
        let (ben, eve) = (dev(2), dev(3));
        // The invitation key must sign the join; a forged signature is refused.
        let mut forged = o.join_body(&ben, &invite, &[99; 32]);
        forged["name"] = json!(name());
        assert!(o.apply("person.join", forged, &ben.seed).is_err());
        o.join(&ben, &invite, &seed).unwrap();
        assert_eq!(o.state.key_role(&ben.key), Some(KeyRole::Device { person: o.person(&ben) }));
        // Single use.
        assert_eq!(o.join(&eve, &invite, &seed).unwrap_err().0, "the invitation is not open");
        // With approval the person is pending: no key role until an admin approves.
        let (invite, seed) = o.invite(&owner, 4, "admin", true, None).unwrap();
        o.join(&eve, &invite, &seed).unwrap();
        assert_eq!(o.state.key_role(&eve.key), None);
        assert!(o.apply("person.approve", json!({"person":o.person(&eve),"role":"admin"}), &ben.seed).is_err());
        o.apply("person.approve", json!({"person":o.person(&eve),"role":"admin"}), &owner.seed).unwrap();
        assert!(o.state.is_admin(&o.person(&eve)));
        // Admin invitations always need approval; a revoked invitation admits nobody.
        assert!(o.invite(&owner, 5, "admin", false, None).is_err());
        let (invite, seed) = o.invite(&owner, 6, "member", false, None).unwrap();
        o.apply("invite.revoke", json!({"invite":invite}), &owner.seed).unwrap();
        assert!(o.join(&dev(7), &invite, &seed).is_err());
    }

    #[test]
    fn members_invite_only_to_their_projects_and_only_with_approval() {
        let (mut o, owner) = org("e2ee", true);
        let (invite, seed) = o.invite(&owner, 2, "member", false, None).unwrap();
        let ben = dev(2);
        o.join(&ben, &invite, &seed).unwrap();
        let own = o.project(&ben, 30);
        let others = o.project(&owner, 31);
        assert!(o.invite(&ben, 8, "member", false, None).is_err());
        assert!(o.invite(&ben, 8, "member", false, Some((&own, "viewer"))).is_err());
        assert!(o.invite(&ben, 8, "member", true, Some((&others, "viewer"))).is_err());
        let (invite, seed) = o.invite(&ben, 8, "member", true, Some((&own, "reviewer"))).unwrap();
        let cat = dev(9);
        o.join(&cat, &invite, &seed).unwrap();
        // Pending: the grant exists but gives no access until approval.
        assert!(!o.state.can_access(&o.person(&cat), &own));
        o.apply("person.approve", json!({"person":o.person(&cat),"role":"member"}), &owner.seed).unwrap();
        assert_eq!(o.state.project_role(&o.person(&cat), &own), Some("reviewer"));
        assert!(!o.state.can_write(&o.person(&cat), &own));
    }

    #[test]
    fn roles_keep_an_owner_and_admins_cannot_touch_owners() {
        let (mut o, owner) = org("e2ee", true);
        let (invite, seed) = o.invite(&owner, 2, "admin", true, None).unwrap();
        let ana = dev(2);
        o.join(&ana, &invite, &seed).unwrap();
        o.apply("person.approve", json!({"person":o.person(&ana),"role":"admin"}), &owner.seed).unwrap();
        let owner_person = o.person(&owner);
        assert!(o.apply("person.role", json!({"person":owner_person,"role":"member"}), &ana.seed).is_err());
        assert!(o.apply("person.remove", json!({"person":owner_person}), &ana.seed).is_err());
        assert!(o.apply("person.role", json!({"person":o.person(&ana),"role":"owner"}), &ana.seed).is_err());
        assert_eq!(o.apply("person.role", json!({"person":owner_person,"role":"admin"}), &owner.seed).unwrap_err().0, "an organisation always keeps at least one owner");
        assert!(o.apply("person.remove", json!({"person":owner_person}), &owner.seed).is_err());
        o.apply("person.role", json!({"person":o.person(&ana),"role":"owner"}), &owner.seed).unwrap();
        o.apply("person.role", json!({"person":owner_person,"role":"member"}), &owner.seed).unwrap();
        assert_eq!(o.state.persons[&owner_person].role, "member");
    }

    #[test]
    fn removal_retires_keys_access_and_open_invitations() {
        let (mut o, owner) = org("e2ee", false);
        let (invite, seed) = o.invite(&owner, 2, "member", false, None).unwrap();
        let ben = dev(2);
        o.join(&ben, &invite, &seed).unwrap();
        let project = o.project(&owner, 40);
        o.apply("project.grant", json!({"project":project,"person":o.person(&ben),"role":"editor"}), &owner.seed).unwrap();
        let bens = o.project(&ben, 41);
        let (pending, _) = o.invite(&ben, 9, "member", true, Some((&bens, "viewer"))).unwrap();
        assert!(o.state.wrap_recipients(&project).contains(&ben.agreement));
        o.apply("person.remove", json!({"person":o.person(&ben)}), &owner.seed).unwrap();
        assert_eq!(o.state.key_role(&ben.key), None);
        assert!(!o.state.can_access(&o.person(&ben), &project));
        assert!(!o.state.wrap_recipients(&project).contains(&ben.agreement));
        assert_eq!(o.state.invites[&pending].state, "revoked");
        // A removed device key can never come back, through any door.
        let (invite, seed) = o.invite(&owner, 3, "member", false, None).unwrap();
        assert!(o.join(&ben, &invite, &seed).is_err());
        // Removing is not leaving silently: a removed person's events are refused.
        assert!(o.apply("project.create", json!({"project":hex(&[42;32]),"epoch":1,"keyCommit":hex(&[1;32])}), &ben.seed).is_err());
    }

    #[test]
    fn project_roles_and_grants() {
        let (mut o, owner) = org("e2ee", false);
        let (invite, seed) = o.invite(&owner, 2, "member", false, None).unwrap();
        let ben = dev(2);
        o.join(&ben, &invite, &seed).unwrap();
        let project = o.project(&owner, 40);
        let ben_p = o.person(&ben);
        o.apply("project.grant", json!({"project":project,"person":ben_p,"role":"viewer"}), &owner.seed).unwrap();
        assert!(o.state.can_access(&ben_p, &project) && !o.state.can_write(&ben_p, &project));
        // A viewer cannot share or upgrade themselves.
        assert!(o.apply("project.grant", json!({"project":project,"person":ben_p,"role":"editor"}), &ben.seed).is_err());
        assert!(o.apply("project.grant", json!({"project":project,"person":ben_p,"role":"owner"}), &owner.seed).is_err());
        // The last editor cannot leave or be downgraded.
        let owner_p = o.person(&owner);
        assert!(o.apply("project.revoke", json!({"project":project,"person":owner_p}), &owner.seed).is_err());
        assert!(o.apply("project.grant", json!({"project":project,"person":owner_p,"role":"viewer"}), &owner.seed).is_err());
        o.apply("project.revoke", json!({"project":project,"person":ben_p}), &ben.seed).unwrap();
        assert!(!o.state.can_access(&ben_p, &project));
        // Admin read access: admins are entitled to every project's key, members are not.
        let (mut o, owner) = org("managed", true);
        let (invite, seed) = o.invite(&owner, 2, "member", false, None).unwrap();
        o.join(&ben, &invite, &seed).unwrap();
        let bens = o.project(&ben, 50);
        let recipients = o.state.wrap_recipients(&bens);
        assert!(recipients.contains(&owner.agreement) && recipients.contains(o.state.service_key.as_ref().unwrap()));
        let directory = o.state.wrap_recipients(&o.id.clone());
        assert!(directory.contains(&ben.agreement) && directory.contains(&owner.agreement));
    }

    #[test]
    fn device_links_and_removal() {
        let (mut o, owner) = org("e2ee", true);
        let laptop = dev(2);
        let person = o.person(&owner);
        let link = hex(&[5; 16]);
        let proof = sign(&laptop.seed, &device_proof_message(&o.id, &link_binding(&link), &person, &laptop.key, &laptop.agreement));
        let body = json!({"person":person,"device":laptop.key,"agreement":laptop.agreement,"proof":proof,"link":link});
        o.apply("device.add", body.clone(), &owner.seed).unwrap();
        assert_eq!(o.state.device_person(&laptop.key), Some(person.as_str()));
        // Each link adds one device.
        let phone = dev(3);
        let proof = sign(&phone.seed, &device_proof_message(&o.id, &link_binding(&link), &person, &phone.key, &phone.agreement));
        assert!(o.apply("device.add", json!({"person":person,"device":phone.key,"agreement":phone.agreement,"proof":proof,"link":link}), &owner.seed).is_err());
        // Removing a device retires its keys for good, and it can no longer sign.
        o.apply("device.remove", json!({"device":laptop.key}), &owner.seed).unwrap();
        assert_eq!(o.state.key_role(&laptop.key), None);
        let again = hex(&[6; 16]);
        let proof = sign(&laptop.seed, &device_proof_message(&o.id, &link_binding(&again), &person, &laptop.key, &laptop.agreement));
        assert!(o.apply("device.add", json!({"person":person,"device":laptop.key,"agreement":laptop.agreement,"proof":proof,"link":again}), &owner.seed).is_err());
        // Another person cannot add devices to this person, or remove theirs.
        let (invite, seed) = o.invite(&owner, 8, "member", false, None).unwrap();
        let ben = dev(8);
        o.join(&ben, &invite, &seed).unwrap();
        assert!(o.apply("device.remove", json!({"device":owner.key}), &ben.seed).is_err());
    }

    #[test]
    fn join_requests_stay_pending_and_failed_events_change_nothing() {
        let (mut o, owner) = org("e2ee", true);
        let ben = dev(2);
        let person = o.person(&ben);
        let proof = sign(&ben.seed, &device_proof_message(&o.id, &o.state.head, &person, &ben.key, &ben.agreement));
        o.apply("person.request", json!({"person":person,"device":ben.key,"agreement":ben.agreement,"proof":proof,"name":name()}), &ben.seed).unwrap();
        assert_eq!(o.state.persons[&person].state, "pending");
        assert_eq!(o.state.key_role(&ben.key), None);
        assert!(!o.state.wrap_recipients(&o.id.clone()).contains(&ben.agreement));
        let before = o.state.clone();
        assert!(o.apply("person.approve", json!({"person":person,"role":"superuser"}), &owner.seed).is_err());
        assert_eq!(o.state, before);
    }
}

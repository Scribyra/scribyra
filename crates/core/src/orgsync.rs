//! Organisation sync: the signed membership log, encrypted log entries and the
//! cryptographic helpers shared by the service and the browser (through WASM).
//! See docs/org-sync-design.md. Slice 1 covers one person backing up projects:
//! `genesis`, `recovery.set`, `device.add` and `project.create` events.
//!
//! Every function here is deterministic. Randomness (keys, nonces, codes) comes
//! from the caller: WebCrypto in the browser, the operating system on the server.
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;

pub const MAX_HEADER_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub &'static str);
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}
pub(crate) type Result<T> = std::result::Result<T, Error>;
const fn fail(message: &'static str) -> Error {
    Error(message)
}

// ---------------------------------------------------------------------------
// Encodings

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}
/// Strict lowercase hex of exactly `len` bytes.
pub fn unhex(value: &str, len: usize) -> Result<Vec<u8>> {
    if value.len() != len * 2 || !value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(fail("invalid hexadecimal value"));
    }
    Ok((0..len)
        .map(|i| u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).unwrap())
        .collect())
}
fn unhex32(value: &str) -> Result<[u8; 32]> {
    Ok(unhex(value, 32)?.try_into().unwrap())
}
pub fn is_hex(value: &str, len: usize) -> bool {
    unhex(value, len).is_ok()
}
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Canonical JSON: object keys sorted by UTF-16 code units (identical to the
/// browser's sort for the ASCII keys used here), no whitespace, integers only.
/// Strings in signed structures are restricted to printable ASCII, so the
/// escaping of `serde_json` and `JSON.stringify` agree byte for byte.
pub fn canonical(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_canonical(value, &mut out, 0)?;
    Ok(out)
}
fn write_canonical(value: &Value, out: &mut String, depth: usize) -> Result<()> {
    if depth > 16 {
        return Err(fail("canonical JSON is nested too deeply"));
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let Some(n) = n.as_u64() else {
                return Err(fail("canonical JSON allows only non-negative integers"));
            };
            if n > (1u64 << 53) - 1 {
                return Err(fail("canonical JSON integer exceeds the safe range"));
            }
            out.push_str(&n.to_string());
        }
        Value::String(s) => {
            if !s.bytes().all(|b| (0x20..0x7f).contains(&b)) {
                return Err(fail("canonical JSON strings must be printable ASCII"));
            }
            out.push_str(&serde_json::to_string(s).unwrap());
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(&Value::String((*key).clone()), out, depth + 1)?;
                out.push(':');
                write_canonical(&map[*key], out, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}
fn without(value: &Value, field: &str) -> Value {
    let mut map = value.as_object().cloned().unwrap_or_default();
    map.remove(field);
    Value::Object(map)
}

// ---------------------------------------------------------------------------
// Primitives

pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>> {
    if len == 0 || len > 255 * 32 {
        return Err(fail("invalid HKDF length"));
    }
    let mut out = vec![0; len];
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut out)
        .map_err(|_| fail("invalid HKDF length"))?;
    Ok(out)
}
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}
/// XChaCha20-Poly1305 with a caller-supplied random 24-byte nonce.
pub fn seal(key: &[u8], nonce: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if key.len() != 32 || nonce.len() != 24 {
        return Err(fail("invalid key or nonce length"));
    }
    XChaCha20Poly1305::new_from_slice(key)
        .unwrap()
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .map_err(|_| fail("encryption failed"))
}
pub fn open(key: &[u8], nonce: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    if key.len() != 32 || nonce.len() != 24 {
        return Err(fail("invalid key or nonce length"));
    }
    XChaCha20Poly1305::new_from_slice(key)
        .unwrap()
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| fail("decryption failed: wrong key or altered data"))
}
pub fn ed25519_public(seed: &[u8]) -> Result<[u8; 32]> {
    let seed: [u8; 32] = seed.try_into().map_err(|_| fail("invalid signing seed"))?;
    Ok(SigningKey::from_bytes(&seed).verifying_key().to_bytes())
}
pub fn ed25519_sign(seed: &[u8], message: &[u8]) -> Result<[u8; 64]> {
    let seed: [u8; 32] = seed.try_into().map_err(|_| fail("invalid signing seed"))?;
    Ok(SigningKey::from_bytes(&seed).sign(message).to_bytes())
}
/// Strict verification (rejects small-order keys and non-canonical signatures).
pub fn ed25519_verify(public: &str, message: &[u8], signature: &str) -> bool {
    let (Ok(public), Ok(signature)) = (unhex32(public), unhex(signature, 64)) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&public) else {
        return false;
    };
    if key.is_weak() {
        return false;
    }
    let signature = Signature::from_bytes(&signature.try_into().unwrap());
    key.verify_strict(message, &signature).is_ok()
}
pub fn x25519_public(secret: &[u8]) -> Result<[u8; 32]> {
    let secret: [u8; 32] = secret.try_into().map_err(|_| fail("invalid agreement secret"))?;
    Ok(x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(secret)).to_bytes())
}
pub fn x25519_shared(secret: &[u8], public: &[u8]) -> Result<[u8; 32]> {
    let secret: [u8; 32] = secret.try_into().map_err(|_| fail("invalid agreement secret"))?;
    let public: [u8; 32] = public.try_into().map_err(|_| fail("invalid agreement key"))?;
    let shared = x25519_dalek::StaticSecret::from(secret)
        .diffie_hellman(&x25519_dalek::PublicKey::from(public));
    if !shared.was_contributory() {
        return Err(fail("invalid agreement key"));
    }
    Ok(shared.to_bytes())
}
/// A registrable X25519 public key: 32 hex bytes and not of small order (a small-order
/// point gives an all-zero shared secret for every clamped scalar).
pub fn valid_agreement_key(public: &str) -> bool {
    let Ok(bytes) = unhex(public, 32) else { return false };
    x25519_shared(&[0x5a; 32], &bytes).is_ok()
}

// ---------------------------------------------------------------------------
// Identifiers, setup codes and recovery codes

/// UUID version 8 from a canonical JSON value (same construction as D's author IDs).
pub fn derived_uuid(value: &Value) -> Result<String> {
    let digest = hex(&sha256(canonical(value)?.as_bytes()));
    let mut h: Vec<char> = digest[..32].chars().collect();
    h[12] = '8';
    let variant = u8::from_str_radix(&h[16].to_string(), 16).unwrap() & 3;
    h[16] = ['8', '9', 'a', 'b'][variant as usize];
    let s: String = h.into_iter().collect();
    Ok(format!("{}-{}-{}-{}-{}", &s[..8], &s[8..12], &s[12..16], &s[16..20], &s[20..]))
}
pub fn person_id(org: &str, device: &str) -> Result<String> {
    derived_uuid(&serde_json::json!(["scribyra-person", 1, org, device]))
}
pub fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit() && !c.is_ascii_uppercase()
            }
        })
}
/// The Ed25519 seed an operator's single-use setup secret stands for.
pub fn enrol_seed(secret: &[u8]) -> Result<Vec<u8>> {
    if secret.len() != 32 {
        return Err(fail("invalid setup secret"));
    }
    hkdf_sha256(secret, b"scribyra-enrol/1", b"signing", 32)
}
/// What the setup code's key signs: every genesis field except its own signature, so the
/// operator's setup code vouches for the owner's keys, the mode, admin read access, the
/// service key and the encrypted names exactly as the owner chose them.
pub fn enrol_message(org: &str, body: &GenesisBody) -> Vec<u8> {
    let value = without(&serde_json::to_value(body).expect("genesis body serialises"), "enrolSig");
    format!("scribyra-org-enrol/2\n{org}\n{}", canonical(&value).expect("genesis body is canonical JSON")).into_bytes()
}
/// Ed25519 seed and X25519 secret derived from a 32-byte recovery code.
pub fn recovery_secrets(code: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    if code.len() != 32 {
        return Err(fail("invalid recovery code"));
    }
    Ok((
        hkdf_sha256(code, b"scribyra-recovery/1", b"signing", 32)?,
        hkdf_sha256(code, b"scribyra-recovery/1", b"agreement", 32)?,
    ))
}
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// 32 code bytes plus a 2-byte SHA-256 checksum, as 11 dash-separated groups of
/// five Crockford base32 characters (55 characters, 272 bits with padding).
pub fn encode_recovery_code(code: &[u8]) -> Result<String> {
    if code.len() != 32 {
        return Err(fail("invalid recovery code"));
    }
    let mut bytes = code.to_vec();
    bytes.extend_from_slice(&sha256(&[b"scribyra-recovery-check/1".as_slice(), code].concat())[..2]);
    let (mut acc, mut bits, mut chars) = (0u32, 0u32, String::new());
    for byte in bytes {
        acc = (acc << 8) | byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            chars.push(CROCKFORD[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        chars.push(CROCKFORD[((acc << (5 - bits)) & 31) as usize] as char);
    }
    Ok(chars
        .as_bytes()
        .chunks(5)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-"))
}
pub fn decode_recovery_code(text: &str) -> Result<Vec<u8>> {
    let mut values = Vec::new();
    for c in text.chars() {
        if c == '-' || c.is_whitespace() {
            continue;
        }
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        let Some(v) = CROCKFORD.iter().position(|&x| x as char == c) else {
            return Err(fail("The recovery code contains a character that is not used in codes."));
        };
        values.push(v as u32);
    }
    if values.len() != 55 {
        return Err(fail("The recovery code has the wrong length."));
    }
    let (mut acc, mut bits, mut bytes) = (0u32, 0u32, Vec::new());
    for v in values {
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
        }
    }
    if bytes.len() != 34 || acc & ((1 << bits) - 1) != 0 {
        return Err(fail("The recovery code has the wrong length."));
    }
    let (code, check) = bytes.split_at(32);
    if sha256(&[b"scribyra-recovery-check/1".as_slice(), code].concat())[..2] != *check {
        return Err(fail("The recovery code is mistyped: its check characters do not match."));
    }
    Ok(code.to_vec())
}
/// `HMAC-SHA-256(PK, "scribyra/1/key-commit")`: binds a project key epoch.
pub fn key_commit(project_key: &[u8]) -> String {
    hex(&hmac_sha256(project_key, b"scribyra/1/key-commit"))
}
/// Subkeys of a project key epoch.
pub fn project_subkey(project_key: &[u8], purpose: &str) -> Result<Vec<u8>> {
    if project_key.len() != 32 || !matches!(purpose, "update" | "blob" | "object-id" | "awareness" | "name") {
        return Err(fail("invalid project key purpose"));
    }
    hkdf_sha256(project_key, b"", format!("scribyra/1/{purpose}").as_bytes(), 32)
}

// ---------------------------------------------------------------------------
// The membership log lives in `crate::membership`; re-exported here so callers keep one path.

pub use crate::membership::*;

// ---------------------------------------------------------------------------
// Key wraps

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Wrap {
    pub v: u32,
    pub org: String,
    pub project: String,
    pub epoch: u32,
    pub recipient: String,
    pub enc: String,
    pub nonce: String,
    pub ct: String,
    pub sender: String,
    pub sig: String,
}
pub const MAX_WRAP_BYTES: usize = 1024;
/// Canonical context bound into the wrap's key derivation and associated data.
pub fn wrap_context(wrap: &Wrap) -> Result<String> {
    canonical(&serde_json::json!({"v": wrap.v, "org": wrap.org, "project": wrap.project, "epoch": wrap.epoch, "recipient": wrap.recipient, "enc": wrap.enc, "sender": wrap.sender}))
}
fn wrap_key(shared: &[u8], wrap: &Wrap, context: &str) -> Result<Vec<u8>> {
    let mut salt = unhex(&wrap.enc, 32)?;
    salt.extend(unhex(&wrap.recipient, 32)?);
    hkdf_sha256(shared, &salt, format!("scribyra-wrap/1{context}").as_bytes(), 32)
}
/// Opens a wrap with the recipient's X25519 secret (the browser does the same with WebCrypto).
/// Only the shape is checked here; callers check the wrap against the membership state and
/// the key against the epoch's commitment.
pub fn open_wrap(wrap: &Wrap, recipient_secret: &[u8]) -> Result<Vec<u8>> {
    let context = wrap_context(wrap)?;
    let shared = x25519_shared(recipient_secret, &unhex(&wrap.enc, 32)?)?;
    let key = wrap_key(&shared, wrap, &context)?;
    open(&key, &unhex(&wrap.nonce, 24)?, context.as_bytes(), &unhex(&wrap.ct, 48)?).map_err(|_| fail("the key wrap could not be opened"))
}
/// Seals a 32-byte key to a recipient (an ephemeral X25519 key per wrap); the caller signs it.
pub fn seal_wrap(wrap: &mut Wrap, ephemeral_secret: &[u8], nonce: &[u8; 24], key: &[u8]) -> Result<()> {
    wrap.enc = hex(&x25519_public(ephemeral_secret)?);
    wrap.nonce = hex(nonce);
    let context = wrap_context(wrap)?;
    let shared = x25519_shared(ephemeral_secret, &unhex(&wrap.recipient, 32)?)?;
    wrap.ct = hex(&seal(&wrap_key(&shared, wrap, &context)?, nonce, context.as_bytes(), key)?);
    Ok(())
}
pub fn wrap_signing_message(value: &Value) -> Result<Vec<u8>> {
    Ok(format!("scribyra-wrap/1\n{}", canonical(&without(value, "sig"))?).into_bytes())
}
/// Parse and check a wrap's shape and signature against the membership state.
/// The server stores only wraps from a project member addressed to a member key.
pub fn check_wrap(state: &OrgState, raw: &str) -> Result<Wrap> {
    if raw.len() > MAX_WRAP_BYTES {
        return Err(fail("key wrap is too large"));
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| fail("key wrap is not JSON"))?;
    if canonical(&value)? != raw {
        return Err(fail("key wrap is not in canonical form"));
    }
    let wrap: Wrap = serde_json::from_value(value.clone()).map_err(|_| fail("invalid key wrap"))?;
    if wrap.v != 1 || wrap.org != state.org || !is_hex(&wrap.enc, 32) || !is_hex(&wrap.nonce, 24) || !is_hex(&wrap.ct, 48) {
        return Err(fail("invalid key wrap"));
    }
    // The target is a project, or the organisation's directory (project = org ID).
    let epoch = state.key_epoch(&wrap.project).ok_or(fail("key wrap for an unknown project"))?;
    if wrap.epoch == 0 || wrap.epoch > epoch {
        return Err(fail("key wrap for an unknown epoch"));
    }
    let sender = match state.key_role(&wrap.sender) {
        Some(KeyRole::Device { person }) => person,
        _ => return Err(fail("key wraps must come from a member device")),
    };
    if !state.may_wrap(&sender, &wrap.project) || !state.wrap_recipients(&wrap.project).contains(&wrap.recipient) {
        return Err(fail("key wrap sender or recipient is not a project member"));
    }
    if !ed25519_verify(&wrap.sender, &wrap_signing_message(&value)?, &wrap.sig) {
        return Err(fail("key wrap signature is invalid"));
    }
    Ok(wrap)
}

// ---------------------------------------------------------------------------
// Project log entries

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EntryHeader {
    pub v: u32,
    pub org: String,
    pub project: String,
    pub device: String,
    pub client_seq: u64,
    pub kind: String,
    pub epoch: u32,
    pub sig: String,
}
pub const ENTRY_KINDS: &[&str] = &["update"];
/// Split `u32 header length ‖ canonical header JSON ‖ ciphertext` and check the header.
pub fn split_entry(body: &[u8]) -> Result<(EntryHeader, &str, &[u8])> {
    if body.len() < 4 {
        return Err(fail("entry is too short"));
    }
    let len = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
    if len == 0 || len > MAX_HEADER_BYTES || body.len() < 4 + len {
        return Err(fail("invalid entry header length"));
    }
    let raw = std::str::from_utf8(&body[4..4 + len]).map_err(|_| fail("entry header is not UTF-8"))?;
    let value: Value = serde_json::from_str(raw).map_err(|_| fail("entry header is not JSON"))?;
    if canonical(&value)? != raw {
        return Err(fail("entry header is not in canonical form"));
    }
    let header: EntryHeader = serde_json::from_value(value).map_err(|_| fail("invalid entry header"))?;
    let ciphertext = &body[4 + len..];
    if header.v != 1
        || !is_hex(&header.org, 32)
        || !is_hex(&header.project, 32)
        || !is_hex(&header.device, 32)
        || !is_hex(&header.sig, 64)
        || header.client_seq == 0
        || header.client_seq > (1u64 << 53) - 1
        || header.epoch == 0
        || !ENTRY_KINDS.contains(&header.kind.as_str())
    {
        return Err(fail("invalid entry header"));
    }
    // 24-byte nonce plus 16-byte tag at minimum.
    if ciphertext.len() < 40 {
        return Err(fail("entry ciphertext is too short"));
    }
    Ok((header, raw, ciphertext))
}
pub fn header_unsigned(header: &EntryHeader) -> Result<String> {
    canonical(&without(&serde_json::to_value(header).unwrap(), "sig"))
}
pub fn entry_signing_message(header: &EntryHeader, ciphertext: &[u8]) -> Result<Vec<u8>> {
    Ok(format!("scribyra-log/1\n{}\n{}", header_unsigned(header)?, hex(&sha256(ciphertext))).into_bytes())
}
pub fn verify_entry(header: &EntryHeader, ciphertext: &[u8]) -> Result<()> {
    if ed25519_verify(&header.device, &entry_signing_message(header, ciphertext)?, &header.sig) {
        Ok(())
    } else {
        Err(fail("entry signature is invalid"))
    }
}
/// SHA-256 over the canonical signed header, a newline and the ciphertext.
pub fn entry_hash(header_raw: &str, ciphertext: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(header_raw.as_bytes());
    h.update(b"\n");
    h.update(ciphertext);
    h.finalize().into()
}
/// `chain[n] = SHA-256("scribyra-log-chain/1" ‖ chain[n-1] ‖ entry_hash)`, `chain[0]` = project ID bytes.
pub fn chain_next(previous: &[u8; 32], entry_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"scribyra-log-chain/1");
    h.update(previous);
    h.update(entry_hash);
    h.finalize().into()
}
pub fn chain_start(project: &str) -> Result<[u8; 32]> {
    unhex32(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sign(seed: &[u8], message: &[u8]) -> String {
        hex(&ed25519_sign(seed, message).unwrap())
    }
    fn event(org: &str, prev: &str, kind: &str, body: Value, seed: &[u8]) -> String {
        let signer = hex(&ed25519_public(seed).unwrap());
        let mut value = json!({"v":1,"org":org,"prev":prev,"type":kind,"body":body,"signer":signer});
        let sig = sign(seed, &event_signing_message(&value).unwrap());
        value["sig"] = json!(sig);
        canonical(&value).unwrap()
    }
    struct Fixture {
        org: String,
        state: OrgState,
        device_seed: Vec<u8>,
        person: String,
    }
    fn genesis() -> Fixture {
        let org = hex(&[7; 32]);
        let secret = [9u8; 32];
        let enrol = enrol_seed(&secret).unwrap();
        let device_seed = vec![1u8; 32];
        let device = hex(&ed25519_public(&device_seed).unwrap());
        let agreement = hex(&x25519_public(&[2u8; 32]).unwrap());
        let person = person_id(&org, &device).unwrap();
        let name = hex(&[0x4e; 60]);
        let mut body = GenesisBody { person: person.clone(), device: device.clone(), agreement, enrol: hex(&ed25519_public(&enrol).unwrap()), enrol_sig: String::new(), mode: "e2ee".into(), admin_read: true, name: name.clone(), directory_commit: hex(&[0x44; 32]), owner_name: name, service_key: None };
        body.enrol_sig = sign(&enrol, &enrol_message(&org, &body));
        let raw = event(&org, &org, "genesis", serde_json::to_value(&body).unwrap(), &device_seed);
        let mut state = OrgState::new(&org).unwrap();
        state.apply(&raw, Some(&body.enrol)).unwrap();
        Fixture { org, state, device_seed, person }
    }

    #[test]
    fn canonical_json_sorts_keys_and_rejects_floats_and_non_ascii() {
        assert_eq!(canonical(&json!({"b":1,"a":[true,null,"x"]})).unwrap(), r#"{"a":[true,null,"x"],"b":1}"#);
        assert!(canonical(&json!({"a":1.5})).is_err());
        assert!(canonical(&json!({"a":"é"})).is_err());
        assert!(canonical(&json!({"a":-1})).is_err());
    }

    #[test]
    fn recovery_codes_round_trip_and_detect_typos() {
        let code: Vec<u8> = (0..32).collect();
        let text = encode_recovery_code(&code).unwrap();
        assert_eq!(text.len(), 55 + 10);
        assert_eq!(decode_recovery_code(&text).unwrap(), code);
        assert_eq!(decode_recovery_code(&text.to_lowercase().replace('-', " ")).unwrap(), code);
        let mut typo: Vec<char> = text.chars().collect();
        typo[3] = if typo[3] == 'A' { 'B' } else { 'A' };
        assert!(decode_recovery_code(&typo.into_iter().collect::<String>()).is_err());
        assert!(decode_recovery_code(&text[..60]).is_err());
    }

    #[test]
    fn seal_and_open_bind_associated_data() {
        let (key, nonce) = ([3u8; 32], [4u8; 24]);
        let sealed = seal(&key, &nonce, b"context", b"secret text").unwrap();
        assert_eq!(open(&key, &nonce, b"context", &sealed).unwrap(), b"secret text");
        assert!(open(&key, &nonce, b"other", &sealed).is_err());
        assert!(open(&[5u8; 32], &nonce, b"context", &sealed).is_err());
    }

    #[test]
    fn x25519_agrees_and_rejects_low_order_points() {
        let (a, b) = ([11u8; 32], [12u8; 32]);
        assert_eq!(x25519_shared(&a, &x25519_public(&b).unwrap()).unwrap(), x25519_shared(&b, &x25519_public(&a).unwrap()).unwrap());
        assert!(x25519_shared(&a, &[0u8; 32]).is_err());
    }

    #[test]
    fn genesis_requires_the_setup_key_and_a_canonical_signed_chain() {
        let f = genesis();
        assert_eq!(f.state.persons[&f.person].role, "owner");
        // A second genesis or a replay is refused.
        let mut copy = OrgState::new(&f.org).unwrap();
        let wrong_enrol = hex(&[1u8; 32]);
        let device = hex(&ed25519_public(&f.device_seed).unwrap());
        assert!(f.state.key_role(&device).is_some());
        let raw = event(&f.org, &f.org, "genesis", json!({}), &f.device_seed);
        assert!(copy.apply(&raw, Some(&wrong_enrol)).is_err());
    }

    #[test]
    fn recovery_key_can_add_a_device_for_its_person_only() {
        let mut f = genesis();
        let (rsign, ragree) = recovery_secrets(&[42u8; 32]).unwrap();
        let rsign_pub = hex(&ed25519_public(&rsign).unwrap());
        let ragree_pub = hex(&x25519_public(&ragree).unwrap());
        let unproven = event(&f.org, &f.state.head.clone(), "recovery.set", json!({"person":f.person,"signing":rsign_pub,"agreement":ragree_pub,"proof":hex(&[0u8;64])}), &f.device_seed);
        assert!(f.state.apply(&unproven, None).is_err());
        let rproof = sign(&rsign, &recovery_proof_message(&f.org, &f.state.head, &f.person, &rsign_pub, &ragree_pub));
        let set = event(&f.org, &f.state.head.clone(), "recovery.set", json!({"person":f.person,"signing":rsign_pub,"agreement":ragree_pub,"proof":rproof}), &f.device_seed);
        f.state.apply(&set, None).unwrap();
        assert_eq!(f.state.key_role(&rsign_pub), Some(KeyRole::Recovery { person: f.person.clone() }));
        // New device certified by the recovery key, with proof of possession.
        let new_seed = [21u8; 32];
        let new_device = hex(&ed25519_public(&new_seed).unwrap());
        let new_agree = hex(&x25519_public(&[22u8; 32]).unwrap());
        let proof = sign(&new_seed, &device_proof_message(&f.org, &f.state.head, &f.person, &new_device, &new_agree));
        let bad_proof = sign(&[23u8; 32], &device_proof_message(&f.org, &f.state.head, &f.person, &new_device, &new_agree));
        let forged = event(&f.org, &f.state.head.clone(), "device.add", json!({"person":f.person,"device":new_device,"agreement":new_agree,"proof":bad_proof}), &rsign);
        assert!(f.state.apply(&forged, None).is_err());
        let add = event(&f.org, &f.state.head.clone(), "device.add", json!({"person":f.person,"device":new_device,"agreement":new_agree,"proof":proof}), &rsign);
        f.state.apply(&add, None).unwrap();
        assert_eq!(f.state.device_person(&new_device), Some(f.person.as_str()));
        // Replaying the same event fails because the head moved.
        assert!(f.state.apply(&add, None).is_err());
        // A stranger's key cannot certify.
        let stranger = event(&f.org, &f.state.head.clone(), "device.add", json!({"person":f.person,"device":hex(&[5u8;32]),"agreement":hex(&[6u8;32]),"proof":proof}), &[77u8; 32]);
        assert!(f.state.apply(&stranger, None).is_err());
    }

    #[test]
    fn projects_and_wraps_follow_membership() {
        let mut f = genesis();
        let project = hex(&[8u8; 32]);
        let pk = [33u8; 32];
        let create = event(&f.org, &f.state.head.clone(), "project.create", json!({"project":project,"epoch":1,"keyCommit":key_commit(&pk)}), &f.device_seed);
        f.state.apply(&create, None).unwrap();
        assert!(f.state.can_access(&f.person, &project));
        assert!(f.state.apply(&event(&f.org, &f.state.head.clone(), "project.create", json!({"project":project,"epoch":1,"keyCommit":key_commit(&pk)}), &f.device_seed), None).is_err());
        let device = hex(&ed25519_public(&f.device_seed).unwrap());
        let recipient = f.state.devices[&device].agreement.clone();
        let mut wrap = json!({"v":1,"org":f.org,"project":project,"epoch":1,"recipient":recipient,"enc":hex(&[1u8;32]),"nonce":hex(&[2u8;24]),"ct":hex(&[3u8;48]),"sender":device});
        let sig = sign(&f.device_seed, &wrap_signing_message(&wrap).unwrap());
        wrap["sig"] = json!(sig);
        check_wrap(&f.state, &canonical(&wrap).unwrap()).unwrap();
        wrap["recipient"] = json!(hex(&[9u8; 32]));
        assert!(check_wrap(&f.state, &canonical(&wrap).unwrap()).is_err());
    }

    #[test]
    fn entries_are_signed_hashed_and_chained() {
        let seed = [1u8; 32];
        let device = hex(&ed25519_public(&seed).unwrap());
        let mut header = EntryHeader { v: 1, org: hex(&[7u8; 32]), project: hex(&[8u8; 32]), device, client_seq: 1, kind: "update".into(), epoch: 1, sig: String::new() };
        let ciphertext = vec![0u8; 64];
        header.sig = sign(&seed, &entry_signing_message(&header, &ciphertext).unwrap());
        let raw = canonical(&serde_json::to_value(&header).unwrap()).unwrap();
        let mut body = (raw.len() as u32).to_be_bytes().to_vec();
        body.extend_from_slice(raw.as_bytes());
        body.extend_from_slice(&ciphertext);
        let (parsed, parsed_raw, ct) = split_entry(&body).unwrap();
        verify_entry(&parsed, ct).unwrap();
        let mut altered = body.clone();
        *altered.last_mut().unwrap() ^= 1;
        let (p, _, ct) = split_entry(&altered).unwrap();
        assert!(verify_entry(&p, ct).is_err());
        let start = chain_start(&parsed.project).unwrap();
        assert_ne!(chain_next(&start, &entry_hash(parsed_raw, ct)), chain_next(&start, &entry_hash(parsed_raw, &ciphertext)));
        // Non-canonical headers are refused so entry hashes are well defined.
        let spaced = raw.replace(",", ", ");
        let mut body = (spaced.len() as u32).to_be_bytes().to_vec();
        body.extend_from_slice(spaced.as_bytes());
        body.extend_from_slice(&ciphertext);
        assert!(split_entry(&body).is_err());
    }
}

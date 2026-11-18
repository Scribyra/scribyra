//! WASM bindings for organisation sync. All logic lives in `scribyra_core::orgsync`
//! so the browser and the service sign, verify and replay exactly the same bytes.
use scribyra_core::orgsync as core;
use serde_json::Value;
use wasm_bindgen::prelude::*;

fn js(error: core::Error) -> JsValue {
    JsValue::from_str(error.0)
}
fn value(text: &str) -> Result<Value, JsValue> {
    serde_json::from_str(text).map_err(|_| JsValue::from_str("invalid JSON"))
}

#[wasm_bindgen]
pub fn org_canonical(json: &str) -> Result<String, JsValue> {
    core::canonical(&value(json)?).map_err(js)
}
#[wasm_bindgen]
pub fn org_seal(key: &[u8], nonce: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
    core::seal(key, nonce, aad, plaintext).map_err(js)
}
#[wasm_bindgen]
pub fn org_open(key: &[u8], nonce: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
    core::open(key, nonce, aad, ciphertext).map_err(js)
}
#[wasm_bindgen]
pub fn org_hkdf(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> Result<Vec<u8>, JsValue> {
    core::hkdf_sha256(ikm, salt, info, len).map_err(js)
}
#[wasm_bindgen]
pub fn org_sha256_hex(bytes: &[u8]) -> String {
    core::hex(&core::sha256(bytes))
}
#[wasm_bindgen]
pub fn org_ed25519_public(seed: &[u8]) -> Result<String, JsValue> {
    core::ed25519_public(seed).map(|k| core::hex(&k)).map_err(js)
}
#[wasm_bindgen]
pub fn org_ed25519_sign(seed: &[u8], message: &[u8]) -> Result<String, JsValue> {
    core::ed25519_sign(seed, message).map(|s| core::hex(&s)).map_err(js)
}
#[wasm_bindgen]
pub fn org_ed25519_verify(public: &str, message: &[u8], signature: &str) -> bool {
    core::ed25519_verify(public, message, signature)
}
#[wasm_bindgen]
pub fn org_x25519_public(secret: &[u8]) -> Result<String, JsValue> {
    core::x25519_public(secret).map(|k| core::hex(&k)).map_err(js)
}
#[wasm_bindgen]
pub fn org_x25519_shared(secret: &[u8], public: &str) -> Result<Vec<u8>, JsValue> {
    let public = core::unhex(public, 32).map_err(js)?;
    core::x25519_shared(secret, &public).map(|k| k.to_vec()).map_err(js)
}
/// Signing seed (32 bytes) followed by the agreement secret (32 bytes).
#[wasm_bindgen]
pub fn org_recovery_secrets(code: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (signing, agreement) = core::recovery_secrets(code).map_err(js)?;
    Ok([signing, agreement].concat())
}
#[wasm_bindgen]
pub fn org_encode_recovery_code(code: &[u8]) -> Result<String, JsValue> {
    core::encode_recovery_code(code).map_err(js)
}
#[wasm_bindgen]
pub fn org_decode_recovery_code(text: &str) -> Result<Vec<u8>, JsValue> {
    core::decode_recovery_code(text).map_err(js)
}
#[wasm_bindgen]
pub fn org_key_commit(project_key: &[u8]) -> String {
    core::key_commit(project_key)
}
#[wasm_bindgen]
pub fn org_project_subkey(project_key: &[u8], purpose: &str) -> Result<Vec<u8>, JsValue> {
    core::project_subkey(project_key, purpose).map_err(js)
}
#[wasm_bindgen]
pub fn org_person_id(org: &str, device: &str) -> Result<String, JsValue> {
    core::person_id(org, device).map_err(js)
}
#[wasm_bindgen]
pub fn org_event_signing_message(event_json: &str) -> Result<Vec<u8>, JsValue> {
    core::event_signing_message(&value(event_json)?).map_err(js)
}
#[wasm_bindgen]
pub fn org_device_proof_message(org: &str, prev: &str, person: &str, device: &str, agreement: &str) -> Vec<u8> {
    core::device_proof_message(org, prev, person, device, agreement)
}
#[wasm_bindgen]
pub fn org_recovery_proof_message(org: &str, prev: &str, person: &str, signing: &str, agreement: &str) -> Vec<u8> {
    core::recovery_proof_message(org, prev, person, signing, agreement)
}
/// The X25519 keys entitled to a project's key (or the directory key, `project` = org ID).
#[wasm_bindgen]
pub fn org_wrap_recipients(state_json: &str, project: &str) -> Result<String, JsValue> {
    let state: core::OrgState = serde_json::from_str(state_json).map_err(|_| JsValue::from_str("invalid organisation state"))?;
    Ok(serde_json::to_string(&state.wrap_recipients(project)).unwrap())
}
/// Replay events (a JSON array of canonical event strings) onto a state, or onto a
/// fresh state for `org` when `state_json` is empty. Returns the new state as JSON.
#[wasm_bindgen]
pub fn org_apply_events(state_json: &str, org: &str, events_json: &str) -> Result<String, JsValue> {
    let mut state = if state_json.is_empty() {
        core::OrgState::new(org).map_err(js)?
    } else {
        serde_json::from_str(state_json).map_err(|_| JsValue::from_str("invalid organisation state"))?
    };
    let events: Vec<String> = serde_json::from_str(events_json).map_err(|_| JsValue::from_str("invalid event list"))?;
    for raw in &events {
        state.apply(raw).map_err(js)?;
    }
    Ok(serde_json::to_string(&state).unwrap())
}
#[wasm_bindgen]
pub fn org_wrap_signing_message(wrap_json: &str) -> Result<Vec<u8>, JsValue> {
    core::wrap_signing_message(&value(wrap_json)?).map_err(js)
}
/// Checks a received wrap against the membership state and returns its context string.
#[wasm_bindgen]
pub fn org_check_wrap(state_json: &str, raw: &str) -> Result<String, JsValue> {
    let state: core::OrgState = serde_json::from_str(state_json).map_err(|_| JsValue::from_str("invalid organisation state"))?;
    let wrap = core::check_wrap(&state, raw).map_err(js)?;
    core::wrap_context(&wrap).map_err(js)
}
/// The context string for a wrap being created (all fields except nonce, ct and sig).
#[wasm_bindgen]
pub fn org_wrap_context(wrap_json: &str) -> Result<String, JsValue> {
    let mut v = value(wrap_json)?;
    let map = v.as_object_mut().ok_or_else(|| JsValue::from_str("invalid wrap"))?;
    map.entry("nonce").or_insert(Value::String(core::hex(&[0; 24])));
    map.entry("ct").or_insert(Value::String(core::hex(&[0; 48])));
    map.entry("sig").or_insert(Value::String(core::hex(&[0; 64])));
    let wrap: core::Wrap = serde_json::from_value(v).map_err(|_| JsValue::from_str("invalid wrap"))?;
    core::wrap_context(&wrap).map_err(js)
}
/// Signing message for a header object (its `sig` field, if any, is ignored).
#[wasm_bindgen]
pub fn org_entry_signing_message(header_json: &str, ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
    let mut v = value(header_json)?;
    v.as_object_mut().ok_or_else(|| JsValue::from_str("invalid entry header"))?.insert("sig".into(), Value::String(core::hex(&[0; 64])));
    let header: core::EntryHeader = serde_json::from_value(v).map_err(|_| JsValue::from_str("invalid entry header"))?;
    core::entry_signing_message(&header, ciphertext).map_err(js)
}
/// Parses an entry body and verifies its signature. Returns the canonical header JSON.
#[wasm_bindgen]
pub fn org_verify_entry(body: &[u8]) -> Result<String, JsValue> {
    let (header, raw, ciphertext) = core::split_entry(body).map_err(js)?;
    core::verify_entry(&header, ciphertext).map_err(js)?;
    Ok(raw.to_string())
}
#[wasm_bindgen]
pub fn org_entry_hash(header_raw: &str, ciphertext: &[u8]) -> String {
    core::hex(&core::entry_hash(header_raw, ciphertext))
}
#[wasm_bindgen]
pub fn org_chain_next(previous: &str, entry_hash: &str) -> Result<String, JsValue> {
    let p: [u8; 32] = core::unhex(previous, 32).map_err(js)?.try_into().unwrap();
    let e: [u8; 32] = core::unhex(entry_hash, 32).map_err(js)?.try_into().unwrap();
    Ok(core::hex(&core::chain_next(&p, &e)))
}
/// Seals one object part; returns the ASCII ID (64 bytes) followed by the sealed bytes.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn org_seal_object(project_key: &[u8], org: &str, project: &str, epoch: u32, kind: &str, hash: &str, part: u32, parts: u32, variant: u32, plaintext: &[u8]) -> Result<Vec<u8>, JsValue> {
    let (id, sealed) = core::seal_object(project_key, org, project, epoch, kind, hash, part, parts, variant, plaintext).map_err(js)?;
    Ok([id.into_bytes(), sealed].concat())
}
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn org_open_object(project_key: &[u8], org: &str, project: &str, epoch: u32, kind: &str, hash: &str, part: u32, parts: u32, variant: u32, sealed: &[u8]) -> Result<Vec<u8>, JsValue> {
    core::open_object(project_key, org, project, epoch, kind, hash, part, parts, variant, sealed).map_err(js)
}
#[wasm_bindgen]
pub fn org_object_id(project_key: &[u8], kind: &str, hash: &str, part: u32, parts: u32, variant: u32) -> Result<String, JsValue> {
    core::object_id(project_key, kind, hash, part, parts, variant).map_err(js)
}
#[wasm_bindgen]
pub fn org_object_parts(size: f64) -> u32 {
    core::object_parts(size.max(0.0) as u64)
}
#[wasm_bindgen]
pub fn org_object_variants() -> u32 {
    core::MAX_OBJECT_VARIANTS
}
/// Checks a `blobref` payload's shape; returns it as JSON.
#[wasm_bindgen]
pub fn org_check_blobref(payload: &[u8]) -> Result<String, JsValue> {
    let list = core::check_blobref(payload).map_err(js)?;
    Ok(serde_json::to_string(&list).unwrap())
}

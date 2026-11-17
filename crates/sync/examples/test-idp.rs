//! A minimal OpenID Connect provider for tests and local trials of single sign-on. Not
//! shipped and not secure: it keeps everything in memory and its signing keys are committed
//! test keys (`examples/test-idp-keys/`, generated once with `openssl genpkey`).
//!
//! `cargo run -p scribyra-sync --example test-idp -- --config idp.json`, where `idp.json` is
//!
//! ```json
//! {"bind": "127.0.0.1:0", "issuer": "http://127.0.0.1:18300", "alg": "RS256",
//!  "test_shortcuts": false,
//!  "clients": [{"client_id": "scribyra", "client_secret": "…",
//!               "redirect_uris": ["http://127.0.0.1:18301/v1/sso/callback"],
//!               "backchannel_logout_uri": "http://127.0.0.1:18301/v1/sso/backchannel"}],
//!  "users": [{"sub": "u1", "username": "alice", "password": "…", "email": "alice@example.org",
//!             "email_verified": true, "name": "Alice", "groups": ["staff"]}]}
//! ```
//!
//! `alg` is `RS256` (default), `ES256` or `EdDSA`. The issuer must be the bare origin the
//! provider is reached at. Prints `{"event":"listening","address":"127.0.0.1:PORT"}` when ready.
//!
//! Endpoints: discovery, `/jwks`, `/authorize` (a plain login form; with `test_shortcuts`
//! also `login_hint=<username>&test_password=<password>` to skip it), `/login`, `/token`
//! (authorization code with PKCE S256, client_secret_basic or client_secret_post; refresh
//! tokens rotate and are refused for disabled users), `/end_session`. On a loopback bind only,
//! `/control/disable?user=`, `/control/enable?user=`, `/control/rotate[?drop=1]`,
//! `/control/fault?kind=` (the next ID token is defective: `bad_signature`, `wrong_aud`,
//! `wrong_iss`, `wrong_nonce`, `expired`, `alg_none`, `alg_hs256`, `unknown_kid`,
//! `no_kid_multi_key` or `email_unverified`) and `/control/backchannel?user=` (posts a signed
//! logout token to each client's `backchannel_logout_uri`).
use axum::{
    Form, Json, Router,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    bind: SocketAddr,
    issuer: String,
    clients: Vec<Client>,
    users: Vec<User>,
    #[serde(default)]
    alg: Option<String>,
    #[serde(default)]
    test_shortcuts: bool,
}
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Client {
    client_id: String,
    client_secret: String,
    redirect_uris: Vec<String>,
    #[serde(default)]
    backchannel_logout_uri: Option<String>,
}
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct User {
    sub: String,
    username: String,
    password: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default)]
    hd: Option<String>,
    #[serde(default)]
    disabled: bool,
}

enum Signer {
    Rsa(Box<rsa::pkcs1v15::SigningKey<Sha256>>, rsa::RsaPublicKey),
    Es(p256::ecdsa::SigningKey),
    Ed(ed25519_dalek::SigningKey),
}
struct Key {
    kid: String,
    signer: Signer,
}
fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
fn random_hex() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn random_seed() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).unwrap();
    bytes
}
impl Key {
    fn rsa(kid: &str, pem: &str) -> Self {
        use rsa::pkcs8::DecodePrivateKey;
        let private = rsa::RsaPrivateKey::from_pkcs8_pem(pem).unwrap();
        let public = private.to_public_key();
        Self { kid: kid.into(), signer: Signer::Rsa(Box::new(rsa::pkcs1v15::SigningKey::new(private)), public) }
    }
    fn p256(kid: &str, key: p256::ecdsa::SigningKey) -> Self {
        Self { kid: kid.into(), signer: Signer::Es(key) }
    }
    fn ed(kid: &str, key: ed25519_dalek::SigningKey) -> Self {
        Self { kid: kid.into(), signer: Signer::Ed(key) }
    }
    fn alg(&self) -> &'static str {
        match self.signer {
            Signer::Rsa(..) => "RS256",
            Signer::Es(_) => "ES256",
            Signer::Ed(_) => "EdDSA",
        }
    }
    fn jwk(&self) -> Value {
        match &self.signer {
            Signer::Rsa(_, public) => {
                use rsa::traits::PublicKeyParts;
                json!({"kty":"RSA","use":"sig","alg":"RS256","kid":self.kid,"n":b64(&public.n().to_bytes_be()),"e":b64(&public.e().to_bytes_be())})
            }
            Signer::Es(key) => {
                let point = key.verifying_key().to_encoded_point(false);
                json!({"kty":"EC","crv":"P-256","use":"sig","alg":"ES256","kid":self.kid,"x":b64(point.x().unwrap()),"y":b64(point.y().unwrap())})
            }
            Signer::Ed(key) => json!({"kty":"OKP","crv":"Ed25519","use":"sig","alg":"EdDSA","kid":self.kid,"x":b64(key.verifying_key().as_bytes())}),
        }
    }
    fn sign(&self, input: &[u8]) -> Vec<u8> {
        match &self.signer {
            Signer::Rsa(key, _) => {
                use rsa::signature::{SignatureEncoding, Signer};
                key.sign(input).to_vec()
            }
            Signer::Es(key) => {
                use p256::ecdsa::signature::Signer;
                let sig: p256::ecdsa::Signature = key.sign(input);
                sig.to_bytes().to_vec()
            }
            Signer::Ed(key) => {
                use ed25519_dalek::Signer;
                key.sign(input).to_bytes().to_vec()
            }
        }
    }
}
fn jws(key: &Key, mut header: Value, claims: &Value) -> String {
    header["alg"] = json!(key.alg());
    let input = format!("{}.{}", b64(header.to_string().as_bytes()), b64(claims.to_string().as_bytes()));
    let sig = key.sign(input.as_bytes());
    format!("{input}.{}", b64(&sig))
}

struct Code {
    client_id: String,
    redirect_uri: String,
    challenge: String,
    nonce: String,
    username: String,
    sid: String,
    until: Instant,
}
struct Refresh {
    client_id: String,
    username: String,
}
struct Idp {
    config: Config,
    alg: &'static str,
    keys: Mutex<(Vec<Arc<Key>>, usize)>,
    rotated_rsa: Mutex<bool>,
    codes: Mutex<HashMap<String, Code>>,
    refresh: Mutex<HashMap<String, Refresh>>,
    disabled: Mutex<HashSet<String>>,
    sids: Mutex<HashMap<String, String>>,
    fault: Mutex<Option<String>>,
}
type Shared = Arc<Idp>;

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}
fn oauth_error(status: StatusCode, code: &str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(json!({"error": code}))).into_response()
}
fn page(status: StatusCode, body: String) -> Response {
    (status, Html(format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Test identity provider</title></head><body>{body}</body></html>"))).into_response()
}
fn found(location: String) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, location)]).into_response()
}
fn with_query(base: &str, pairs: &[(&str, &str)]) -> String {
    let mut url = url::Url::parse(base).unwrap();
    for (k, v) in pairs {
        url.query_pairs_mut().append_pair(k, v);
    }
    url.into()
}

impl Idp {
    fn current(&self) -> Arc<Key> {
        let keys = self.keys.lock().unwrap();
        keys.0[keys.1].clone()
    }
    fn user(&self, username: &str) -> Option<User> {
        self.config.users.iter().find(|u| u.username == username).cloned()
    }
    fn enabled(&self, user: &User) -> bool {
        !user.disabled && !self.disabled.lock().unwrap().contains(&user.username)
    }
    fn client(&self, client_id: &str) -> Option<&Client> {
        self.config.clients.iter().find(|c| c.client_id == client_id)
    }
    fn id_token(&self, client_id: &str, user: &User, nonce: &str, sid: &str) -> String {
        let fault = self.fault.lock().unwrap().take();
        let fault = fault.as_deref().unwrap_or("");
        let now = now();
        let mut claims = json!({
            "iss": self.config.issuer, "sub": user.sub, "aud": client_id, "exp": now + 300, "iat": now,
            "auth_time": now, "nonce": nonce, "sid": sid, "email": user.email, "email_verified": user.email_verified,
            "name": user.name, "groups": user.groups,
        });
        if let Some(hd) = &user.hd {
            claims["hd"] = json!(hd);
        }
        match fault {
            "wrong_aud" => claims["aud"] = json!("another-client"),
            "wrong_iss" => claims["iss"] = json!(format!("{}/evil", self.config.issuer)),
            "wrong_nonce" => claims["nonce"] = json!(random_hex()),
            "expired" => {
                claims["exp"] = json!(now - 600);
                claims["iat"] = json!(now - 1200);
            }
            "email_unverified" => claims["email_verified"] = json!(false),
            _ => {}
        }
        let key = self.current();
        let header = json!({"typ": "JWT", "kid": key.kid});
        match fault {
            "alg_none" => format!("{}.{}.", b64(json!({"alg":"none","typ":"JWT","kid":key.kid}).to_string().as_bytes()), b64(claims.to_string().as_bytes())),
            "alg_hs256" => {
                // The classic confusion attack: HMAC keyed with the provider's public key.
                use hmac::Mac;
                use rsa::pkcs8::EncodePublicKey;
                let secret = {
                    let keys = self.keys.lock().unwrap();
                    keys.0.iter().find_map(|k| match &k.signer {
                        Signer::Rsa(_, public) => Some((k.kid.clone(), public.to_public_key_pem(rsa::pkcs8::LineEnding::LF).unwrap())),
                        _ => None,
                    })
                };
                let (kid, pem) = secret.unwrap();
                let input = format!("{}.{}", b64(json!({"alg":"HS256","typ":"JWT","kid":kid}).to_string().as_bytes()), b64(claims.to_string().as_bytes()));
                let mut mac = hmac::Hmac::<Sha256>::new_from_slice(pem.as_bytes()).unwrap();
                mac.update(input.as_bytes());
                format!("{input}.{}", b64(&mac.finalize().into_bytes()))
            }
            "unknown_kid" => {
                let stranger = Key::ed(&format!("unknown-{}", random_hex()), ed25519_dalek::SigningKey::from_bytes(&random_seed()));
                jws(&stranger, json!({"typ": "JWT", "kid": stranger.kid}), &claims)
            }
            "no_kid_multi_key" => jws(&key, json!({"typ": "JWT"}), &claims),
            "bad_signature" => {
                let mut token = jws(&key, header, &claims).into_bytes();
                let at = token.len() - 2;
                token[at] = if token[at] == b'A' { b'B' } else { b'A' };
                String::from_utf8(token).unwrap()
            }
            _ => jws(&key, header, &claims),
        }
    }
    /// Validates an authorization request; `Err` is the response to send instead.
    #[allow(clippy::result_large_err)]
    fn check_request(&self, q: &HashMap<String, String>) -> Result<(), Response> {
        let get = |k: &str| q.get(k).map(String::as_str).unwrap_or("");
        let Some(client) = self.client(get("client_id")) else { return Err(page(StatusCode::BAD_REQUEST, "<p>Unknown client.</p>".into())) };
        if !client.redirect_uris.iter().any(|u| u == get("redirect_uri")) {
            return Err(page(StatusCode::BAD_REQUEST, "<p>Unregistered redirect URI.</p>".into()));
        }
        let ok = get("response_type") == "code"
            && get("code_challenge_method") == "S256"
            && get("code_challenge").len() == 43
            && !get("state").is_empty()
            && !get("nonce").is_empty()
            && get("scope").split(' ').any(|s| s == "openid");
        if !ok {
            return Err(found(with_query(get("redirect_uri"), &[("error", "invalid_request"), ("state", get("state"))])));
        }
        Ok(())
    }
    fn issue_code(&self, q: &HashMap<String, String>, user: &User) -> Response {
        let get = |k: &str| q.get(k).cloned().unwrap_or_default();
        let code = random_hex();
        let sid = random_hex();
        self.sids.lock().unwrap().insert(user.username.clone(), sid.clone());
        self.codes.lock().unwrap().insert(
            code.clone(),
            Code {
                client_id: get("client_id"),
                redirect_uri: get("redirect_uri"),
                challenge: get("code_challenge"),
                nonce: get("nonce"),
                username: user.username.clone(),
                sid,
                until: Instant::now() + Duration::from_secs(60),
            },
        );
        found(with_query(&get("redirect_uri"), &[("code", &code), ("state", &get("state"))]))
    }
}

fn login_form(q: &HashMap<String, String>, message: &str) -> String {
    let hidden: String = ["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method"]
        .iter()
        .map(|k| format!("<input type=\"hidden\" name=\"{k}\" value=\"{}\">", escape(q.get(*k).map(String::as_str).unwrap_or(""))))
        .collect();
    format!(
        "<h1>Test identity provider</h1>{}<form method=\"post\" action=\"/login\">{hidden}\
         <p><label for=\"username\">Username</label> <input id=\"username\" name=\"username\" autocomplete=\"username\" required></p>\
         <p><label for=\"password\">Password</label> <input id=\"password\" name=\"password\" type=\"password\" autocomplete=\"current-password\" required></p>\
         <p><button type=\"submit\">Sign in</button></p></form>",
        if message.is_empty() { String::new() } else { format!("<p role=\"alert\">{}</p>", escape(message)) }
    )
}
async fn discovery(State(idp): State<Shared>) -> Json<Value> {
    let base = idp.config.issuer.trim_end_matches('/');
    Json(json!({
        "issuer": idp.config.issuer,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
        "jwks_uri": format!("{base}/jwks"),
        "end_session_endpoint": format!("{base}/end_session"),
        "response_types_supported": ["code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": [idp.alg],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "backchannel_logout_supported": true,
        "backchannel_logout_session_supported": true,
    }))
}
async fn jwks(State(idp): State<Shared>) -> Json<Value> {
    let keys = idp.keys.lock().unwrap();
    Json(json!({"keys": keys.0.iter().map(|k| k.jwk()).collect::<Vec<_>>()}))
}
async fn authorize(State(idp): State<Shared>, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Err(response) = idp.check_request(&q) {
        return response;
    }
    if let (true, Some(username), Some(password)) = (idp.config.test_shortcuts, q.get("login_hint"), q.get("test_password")) {
        return match idp.user(username) {
            Some(user) if user.password == *password && idp.enabled(&user) => idp.issue_code(&q, &user),
            _ => found(with_query(&q["redirect_uri"], &[("error", "access_denied"), ("state", &q["state"])])),
        };
    }
    page(StatusCode::OK, login_form(&q, ""))
}
async fn login(State(idp): State<Shared>, Form(form): Form<HashMap<String, String>>) -> Response {
    if let Err(response) = idp.check_request(&form) {
        return response;
    }
    let (username, password) = (form.get("username").cloned().unwrap_or_default(), form.get("password").cloned().unwrap_or_default());
    match idp.user(&username) {
        Some(user) if user.password == password => {
            if !idp.enabled(&user) {
                return page(StatusCode::FORBIDDEN, "<p role=\"alert\">This account is disabled.</p>".into());
            }
            idp.issue_code(&form, &user)
        }
        _ => page(StatusCode::UNAUTHORIZED, login_form(&form, "Wrong username or password.")),
    }
}
/// Client authentication: `client_secret_basic` or `client_secret_post`.
fn authenticate<'a>(idp: &'a Idp, headers: &HeaderMap, form: &HashMap<String, String>) -> Option<&'a Client> {
    let decode = |s: &str| url::form_urlencoded::parse(format!("x={s}").as_bytes()).next().map(|(_, v)| v.into_owned());
    let (id, secret) = if let Some(basic) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Basic ")) {
        let raw = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(basic).ok()?).ok()?;
        let (id, secret) = raw.split_once(':')?;
        (decode(id)?, decode(secret)?)
    } else {
        (form.get("client_id")?.clone(), form.get("client_secret")?.clone())
    };
    idp.client(&id).filter(|c| c.client_secret == secret)
}
async fn token(State(idp): State<Shared>, headers: HeaderMap, Form(form): Form<HashMap<String, String>>) -> Response {
    let Some(client) = authenticate(&idp, &headers, &form) else { return oauth_error(StatusCode::UNAUTHORIZED, "invalid_client") };
    let get = |k: &str| form.get(k).cloned().unwrap_or_default();
    let (user, sid, nonce) = match get("grant_type").as_str() {
        "authorization_code" => {
            let code = idp.codes.lock().unwrap().remove(&get("code"));
            let Some(code) = code else { return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant") };
            let challenge = b64(&Sha256::digest(get("code_verifier").as_bytes()));
            if code.client_id != client.client_id || code.redirect_uri != get("redirect_uri") || code.until < Instant::now() || challenge != code.challenge {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            match idp.user(&code.username).filter(|u| idp.enabled(u)) {
                Some(user) => (user, code.sid, Some(code.nonce)),
                None => return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant"),
            }
        }
        "refresh_token" => {
            // Refresh tokens rotate: each one works once.
            let refresh = idp.refresh.lock().unwrap().remove(&get("refresh_token"));
            let Some(refresh) = refresh.filter(|r| r.client_id == client.client_id) else { return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant") };
            match idp.user(&refresh.username).filter(|u| idp.enabled(u)) {
                Some(user) => (user, String::new(), None),
                None => return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant"),
            }
        }
        _ => return oauth_error(StatusCode::BAD_REQUEST, "unsupported_grant_type"),
    };
    let refresh = random_hex();
    idp.refresh.lock().unwrap().insert(refresh.clone(), Refresh { client_id: client.client_id.clone(), username: user.username.clone() });
    let mut body = json!({"access_token": random_hex(), "token_type": "Bearer", "expires_in": 300, "refresh_token": refresh});
    if let Some(nonce) = nonce {
        body["id_token"] = json!(idp.id_token(&client.client_id, &user, &nonce, &sid));
    }
    (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], Json(body)).into_response()
}
async fn end_session() -> Response {
    page(StatusCode::OK, "<p>Signed out.</p>".into())
}

async fn control(State(idp): State<Shared>, ConnectInfo(peer): ConnectInfo<SocketAddr>, axum::extract::Path(action): axum::extract::Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    if !peer.ip().is_loopback() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let arg = |k: &str| q.get(k).cloned().unwrap_or_default();
    match action.as_str() {
        "disable" => {
            idp.disabled.lock().unwrap().insert(arg("user"));
        }
        "enable" => {
            idp.disabled.lock().unwrap().remove(&arg("user"));
        }
        "fault" => {
            const KINDS: [&str; 10] = ["bad_signature", "wrong_aud", "wrong_iss", "wrong_nonce", "expired", "alg_none", "alg_hs256", "unknown_kid", "no_kid_multi_key", "email_unverified"];
            if !KINDS.contains(&arg("kind").as_str()) {
                return StatusCode::BAD_REQUEST.into_response();
            }
            *idp.fault.lock().unwrap() = Some(arg("kind"));
        }
        "rotate" => {
            let next = match idp.alg {
                "RS256" => {
                    let mut used = idp.rotated_rsa.lock().unwrap();
                    if *used {
                        return StatusCode::CONFLICT.into_response();
                    }
                    *used = true;
                    Key::rsa("rsa-2", include_str!("test-idp-keys/rsa-2.pem"))
                }
                "ES256" => Key::p256(&format!("p256-{}", random_hex()), p256::ecdsa::SigningKey::from_bytes(&random_seed().into()).unwrap()),
                _ => Key::ed(&format!("ed25519-{}", random_hex()), ed25519_dalek::SigningKey::from_bytes(&random_seed())),
            };
            let kid = next.kid.clone();
            let mut keys = idp.keys.lock().unwrap();
            let old = keys.1;
            keys.0.push(Arc::new(next));
            keys.1 = keys.0.len() - 1;
            if arg("drop") == "1" {
                keys.0.remove(old);
                keys.1 = keys.0.len() - 1;
            }
            return Json(json!({"kid": kid})).into_response();
        }
        "backchannel" => {
            let user = match idp.user(&arg("user")) {
                Some(u) => u,
                None => return StatusCode::NOT_FOUND.into_response(),
            };
            let sid = idp.sids.lock().unwrap().get(&user.username).cloned();
            let key = idp.current();
            let mut statuses = vec![];
            for client in &idp.config.clients {
                let Some(uri) = client.backchannel_logout_uri.clone() else { continue };
                let now = now();
                let claims = json!({"iss": idp.config.issuer, "aud": client.client_id, "iat": now, "exp": now + 120, "jti": random_hex(),
                    "sub": user.sub, "sid": sid, "events": {"http://schemas.openid.net/event/backchannel-logout": {}}});
                let token = jws(&key, json!({"typ": "logout+jwt", "kid": key.kid}), &claims);
                let status = tokio::task::spawn_blocking(move || {
                    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(Duration::from_secs(10))).build().into();
                    agent.post(&uri).send_form([("logout_token", token.as_str())]).map(|r| r.status().as_u16()).unwrap_or(0)
                })
                .await
                .unwrap_or(0);
                statuses.push(status);
            }
            return Json(json!({"statuses": statuses})).into_response();
        }
        _ => return StatusCode::NOT_FOUND.into_response(),
    }
    Json(json!({"ok": true})).into_response()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [flag, path] = args.as_slice() else {
        eprintln!("usage: test-idp --config <file.json>");
        std::process::exit(2);
    };
    assert_eq!(flag, "--config", "usage: test-idp --config <file.json>");
    let config: Config = serde_json::from_slice(&std::fs::read(path).expect("read config")).expect("parse config");
    let alg = match config.alg.as_deref().unwrap_or("RS256") {
        "RS256" => "RS256",
        "ES256" => "ES256",
        "EdDSA" => "EdDSA",
        _ => panic!("alg must be RS256, ES256 or EdDSA"),
    };
    use ed25519_dalek::pkcs8::DecodePrivateKey as _;
    let keys = vec![
        Arc::new(Key::rsa("rsa-1", include_str!("test-idp-keys/rsa-1.pem"))),
        Arc::new(Key::p256("p256-1", p256::ecdsa::SigningKey::from_pkcs8_pem(include_str!("test-idp-keys/p256-1.pem")).unwrap())),
        Arc::new(Key::ed("ed25519-1", ed25519_dalek::SigningKey::from_pkcs8_pem(include_str!("test-idp-keys/ed25519-1.pem")).unwrap())),
    ];
    let current = keys.iter().position(|k| k.alg() == alg).unwrap();
    let loopback = config.bind.ip().is_loopback();
    let listener = tokio::net::TcpListener::bind(config.bind).await.expect("bind");
    let address = listener.local_addr().unwrap();
    let idp = Arc::new(Idp {
        config,
        alg,
        keys: Mutex::new((keys, current)),
        rotated_rsa: Mutex::new(false),
        codes: Mutex::default(),
        refresh: Mutex::default(),
        disabled: Mutex::default(),
        sids: Mutex::default(),
        fault: Mutex::default(),
    });
    let mut app = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/jwks", get(jwks))
        .route("/authorize", get(authorize))
        .route("/login", post(login))
        .route("/token", post(token))
        .route("/end_session", get(end_session));
    if loopback {
        app = app.route("/control/{action}", get(control).post(control));
    }
    let app = app.with_state(idp);
    println!("{}", json!({"event": "listening", "address": address.to_string()}));
    use std::io::Write;
    std::io::stdout().flush().unwrap();
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}

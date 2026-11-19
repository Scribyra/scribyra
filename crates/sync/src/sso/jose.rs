//! Compact JWS verification and OIDC claim checks for [`crate::sso`].
//!
//! Only three signature algorithms are accepted: `RS256` (RSASSA-PKCS1-v1_5 with SHA-256,
//! modulus of at least 2048 bits), `ES256` (ECDSA P-256 with SHA-256, raw `r || s`) and
//! `EdDSA` (Ed25519). The algorithm in the token header must match the key's type (`kty`,
//! `crv`) and, when the key names one, its `alg`; `none`, every `HS*` algorithm and anything
//! else is refused before a key is looked at. Keys come only from the provider's JWKS: header
//! fields such as `jwk`, `jku` and `x5u` are ignored, and any `crit` header is refused.
use base64::{
    Engine,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use serde_json::{Map, Value};

/// Largest token accepted (header, claims and signature together).
pub const MAX_TOKEN_BYTES: usize = 16 * 1024;
/// Largest JWKS document accepted, and the most keys kept from it.
pub const MAX_JWKS_BYTES: usize = 256 * 1024;
pub const MAX_KEYS: usize = 32;
/// Clock skew allowed on `exp`, and how far in the future `iat` may lie.
pub const SKEW_SECONDS: i64 = 120;
pub const MAX_IAT_AHEAD_SECONDS: i64 = 300;
const MAX_CLAIM_BYTES: usize = 512;
pub const BACKCHANNEL_EVENT: &str = "http://schemas.openid.net/event/backchannel-logout";

/// Strict base64url without padding: no `=`, no whitespace, no non-zero trailing bits.
const B64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone),
);
pub fn b64_decode(text: &str) -> Option<Vec<u8>> {
    B64.decode(text).ok()
}
pub fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoseError {
    /// Not a well-formed compact JWS (segments, encoding, JSON, size).
    Malformed,
    /// The header algorithm is not one of RS256, ES256 or EdDSA, or a `crit` header is present.
    Algorithm,
    /// The header names a `kid` absent from the key set (the caller may refetch the JWKS once).
    UnknownKey,
    /// No `kid` and the key set has more than one key, or several keys match.
    AmbiguousKey,
    /// The selected key cannot be used with the header algorithm.
    KeyMismatch,
    /// The signature does not verify.
    Signature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alg {
    Rs256,
    Es256,
    EdDsa,
}
impl Alg {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "RS256" => Some(Self::Rs256),
            "ES256" => Some(Self::Es256),
            "EdDSA" => Some(Self::EdDsa),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Rs256 => "RS256",
            Self::Es256 => "ES256",
            Self::EdDsa => "EdDSA",
        }
    }
}

#[derive(Clone)]
enum PublicKey {
    Rsa(rsa::pkcs1v15::VerifyingKey<sha2::Sha256>, usize),
    P256(p256::ecdsa::VerifyingKey),
    Ed25519(ed25519_dalek::VerifyingKey),
}
/// One signature key from a JWKS.
#[derive(Clone)]
pub struct Jwk {
    pub kid: Option<String>,
    /// The `alg` the key is restricted to, when the JWKS names one.
    alg: Option<String>,
    key: PublicKey,
}
impl Jwk {
    fn algorithm(&self) -> Alg {
        match self.key {
            PublicKey::Rsa(..) => Alg::Rs256,
            PublicKey::P256(_) => Alg::Es256,
            PublicKey::Ed25519(_) => Alg::EdDsa,
        }
    }
    fn usable_for(&self, alg: Alg) -> bool {
        self.algorithm() == alg && self.alg.as_deref().is_none_or(|a| a == alg.name())
    }
}

fn member<'a>(object: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    object.get(name).and_then(Value::as_str)
}
fn parse_key(object: &Map<String, Value>) -> Option<Jwk> {
    if object.get("use").is_some_and(|u| u.as_str() != Some("sig")) {
        return None;
    }
    let kid = match object.get("kid") {
        None => None,
        Some(Value::String(kid)) if kid.len() <= MAX_CLAIM_BYTES => Some(kid.clone()),
        Some(_) => return None,
    };
    let alg = match object.get("alg") {
        None => None,
        Some(Value::String(alg)) => Some(alg.clone()),
        Some(_) => return None,
    };
    let bytes = |name: &str| member(object, name).and_then(b64_decode);
    let key = match member(object, "kty")? {
        "RSA" => {
            let (n, e) = (bytes("n")?, bytes("e")?);
            let n = rsa::BigUint::from_bytes_be(&n);
            let bits = n.bits();
            if !(2048..=8192).contains(&bits) {
                return None;
            }
            let public = rsa::RsaPublicKey::new_with_max_size(n, rsa::BigUint::from_bytes_be(&e), 8192).ok()?;
            PublicKey::Rsa(rsa::pkcs1v15::VerifyingKey::new(public), bits.div_ceil(8))
        }
        "EC" if member(object, "crv") == Some("P-256") => {
            let (x, y) = (bytes("x")?, bytes("y")?);
            if x.len() != 32 || y.len() != 32 {
                return None;
            }
            let point = p256::EncodedPoint::from_affine_coordinates(x.as_slice().into(), y.as_slice().into(), false);
            PublicKey::P256(p256::ecdsa::VerifyingKey::from_encoded_point(&point).ok()?)
        }
        "OKP" if member(object, "crv") == Some("Ed25519") => {
            let x: [u8; 32] = bytes("x")?.try_into().ok()?;
            PublicKey::Ed25519(ed25519_dalek::VerifyingKey::from_bytes(&x).ok()?)
        }
        _ => return None,
    };
    Some(Jwk { kid, alg, key })
}
/// Parse a JWKS document. Keys of other types, curves or uses (for example encryption keys)
/// and malformed keys are skipped; at most [`MAX_KEYS`] usable keys are kept.
pub fn parse_jwks(bytes: &[u8]) -> Result<Vec<Jwk>, JoseError> {
    if bytes.len() > MAX_JWKS_BYTES {
        return Err(JoseError::Malformed);
    }
    let document: Value = serde_json::from_slice(bytes).map_err(|_| JoseError::Malformed)?;
    let keys = document.get("keys").and_then(Value::as_array).ok_or(JoseError::Malformed)?;
    Ok(keys.iter().filter_map(Value::as_object).filter_map(parse_key).take(MAX_KEYS).collect())
}

/// A verified token: its header and its claims (not yet checked; see [`check_id_token`]).
#[derive(Debug)]
pub struct Verified {
    pub header: Map<String, Value>,
    pub claims: Map<String, Value>,
}
fn decode_json(segment: &str) -> Result<Map<String, Value>, JoseError> {
    let bytes = b64_decode(segment).ok_or(JoseError::Malformed)?;
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err(JoseError::Malformed),
    }
}
/// The claims of a compact JWS **without** checking its signature. Only for choosing which
/// configuration to verify a back-channel logout token against; never trust the result.
pub fn unverified_claims(token: &str) -> Result<Map<String, Value>, JoseError> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(JoseError::Malformed);
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(JoseError::Malformed);
    }
    decode_json(parts[1])
}
/// Verify a compact JWS against a key set.
pub fn verify(token: &str, keys: &[Jwk]) -> Result<Verified, JoseError> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(JoseError::Malformed);
    }
    let parts: Vec<&str> = token.split('.').collect();
    let [header_b64, claims_b64, signature_b64] = parts.as_slice() else {
        return Err(JoseError::Malformed);
    };
    let header = decode_json(header_b64)?;
    let signature = b64_decode(signature_b64).ok_or(JoseError::Malformed)?;
    let claims = decode_json(claims_b64)?;
    if header.contains_key("crit") {
        return Err(JoseError::Algorithm);
    }
    let alg = member(&header, "alg").and_then(Alg::parse).ok_or(JoseError::Algorithm)?;
    let key = match header.get("kid") {
        Some(Value::String(kid)) => {
            let named: Vec<&Jwk> = keys.iter().filter(|k| k.kid.as_deref() == Some(kid)).collect();
            if named.is_empty() {
                return Err(JoseError::UnknownKey);
            }
            let usable: Vec<&Jwk> = named.into_iter().filter(|k| k.usable_for(alg)).collect();
            match usable.as_slice() {
                [] => return Err(JoseError::KeyMismatch),
                [key] => *key,
                _ => return Err(JoseError::AmbiguousKey),
            }
        }
        Some(_) => return Err(JoseError::Malformed),
        None => match keys {
            [] => return Err(JoseError::UnknownKey),
            [key] if key.usable_for(alg) => key,
            [_] => return Err(JoseError::KeyMismatch),
            _ => return Err(JoseError::AmbiguousKey),
        },
    };
    let input = &token.as_bytes()[..header_b64.len() + 1 + claims_b64.len()];
    let valid = match &key.key {
        PublicKey::Rsa(public, size) => {
            use rsa::signature::Verifier;
            signature.len() == *size
                && rsa::pkcs1v15::Signature::try_from(signature.as_slice()).is_ok_and(|s| public.verify(input, &s).is_ok())
        }
        PublicKey::P256(public) => {
            use p256::ecdsa::signature::Verifier;
            signature.len() == 64
                && p256::ecdsa::Signature::from_slice(&signature).is_ok_and(|s| public.verify(input, &s).is_ok())
        }
        PublicKey::Ed25519(public) => <[u8; 64]>::try_from(signature.as_slice())
            .is_ok_and(|s| public.verify_strict(input, &ed25519_dalek::Signature::from_bytes(&s)).is_ok()),
    };
    if !valid {
        return Err(JoseError::Signature);
    }
    Ok(Verified { header, claims })
}

/// Why a verified token's claims were refused. The names are short, fixed and safe to log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimError {
    Issuer,
    Audience,
    Expired,
    IssuedAt,
    Nonce,
    Subject,
    EmailUnverified,
    EmailDomain,
    Event,
}
impl ClaimError {
    pub fn code(self) -> &'static str {
        match self {
            Self::EmailUnverified => "email_unverified",
            Self::EmailDomain => "email_domain",
            _ => "id_token",
        }
    }
}

/// What the relying party expects of a token.
#[derive(Clone, Copy)]
pub struct Expect<'a> {
    pub issuer: &'a str,
    pub client_id: &'a str,
    /// The nonce sent with this flow; `None` for logout tokens (which must not carry one) and
    /// for ID tokens from a refresh (which need not carry one).
    pub nonce: Option<&'a str>,
    /// When not empty, a verified email in one of these domains is required.
    pub email_domains: &'a [String],
    /// Seconds since the Unix epoch.
    pub now: i64,
}
/// The identity taken from a checked ID token. Organisations and roles are read from the same
/// token's claims by [`crate::claims::map`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub subject: String,
    pub email: Option<String>,
    /// `email_verified: true`; a missing claim is false.
    pub email_verified: bool,
    pub name: Option<String>,
    /// An `https` picture URL.
    pub picture: Option<String>,
    pub sid: Option<String>,
}
/// A profile picture URL: `https`, at most 2048 bytes.
pub fn picture(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (text.len() <= 2048 && url::Url::parse(text).is_ok_and(|u| u.scheme() == "https" && u.host().is_some())).then(|| text.to_owned())
}
fn number(claims: &Map<String, Value>, name: &str) -> Option<i64> {
    let value = claims.get(name)?;
    value.as_i64().or_else(|| value.as_f64().filter(|f| f.is_finite() && f.abs() < 1e15).map(|f| f as i64))
}
fn short(claims: &Map<String, Value>, name: &str) -> Option<String> {
    member(claims, name).filter(|s| !s.is_empty() && s.len() <= MAX_CLAIM_BYTES).map(str::to_owned)
}
fn check_common(claims: &Map<String, Value>, expect: &Expect) -> Result<(), ClaimError> {
    if member(claims, "iss") != Some(expect.issuer) {
        return Err(ClaimError::Issuer);
    }
    let audiences: Vec<&str> = match claims.get("aud") {
        Some(Value::String(aud)) => vec![aud.as_str()],
        Some(Value::Array(list)) => list.iter().map(|a| a.as_str().ok_or(ClaimError::Audience)).collect::<Result<_, _>>()?,
        _ => return Err(ClaimError::Audience),
    };
    if !audiences.contains(&expect.client_id) {
        return Err(ClaimError::Audience);
    }
    // With several audiences the token must have been issued to us (`azp`); a present `azp`
    // must name us in every case.
    match claims.get("azp") {
        Some(azp) if azp.as_str() != Some(expect.client_id) => return Err(ClaimError::Audience),
        None if audiences.len() > 1 => return Err(ClaimError::Audience),
        _ => {}
    }
    let iat = number(claims, "iat").ok_or(ClaimError::IssuedAt)?;
    if iat > expect.now + MAX_IAT_AHEAD_SECONDS {
        return Err(ClaimError::IssuedAt);
    }
    Ok(())
}
/// Check an ID token's claims (OpenID Connect Core 1.0, section 3.1.3.7).
pub fn check_id_token(claims: &Map<String, Value>, expect: &Expect) -> Result<Identity, ClaimError> {
    check_id_token_with(claims, expect, false)
}
/// Check an ID token returned by a refresh (section 12.2): the same claims, but the nonce, which
/// only a sign-in sends, need not be present. The caller checks the subject is unchanged.
pub fn check_refreshed_id_token(claims: &Map<String, Value>, expect: &Expect) -> Result<Identity, ClaimError> {
    check_id_token_with(claims, &Expect { nonce: None, ..*expect }, true)
}
fn check_id_token_with(claims: &Map<String, Value>, expect: &Expect, refreshed: bool) -> Result<Identity, ClaimError> {
    check_common(claims, expect)?;
    let exp = number(claims, "exp").ok_or(ClaimError::Expired)?;
    if exp + SKEW_SECONDS <= expect.now {
        return Err(ClaimError::Expired);
    }
    match (expect.nonce, member(claims, "nonce")) {
        (Some(want), Some(got)) if want == got => {}
        (None, _) if refreshed => {}
        _ => return Err(ClaimError::Nonce),
    }
    let subject = short(claims, "sub").ok_or(ClaimError::Subject)?;
    let email = short(claims, "email");
    let email_verified = claims.get("email_verified") == Some(&Value::Bool(true));
    if !expect.email_domains.is_empty() {
        if !email_verified {
            return Err(ClaimError::EmailUnverified);
        }
        let domain = email.as_deref().and_then(|e| e.rsplit_once('@')).filter(|(local, _)| !local.is_empty()).map(|(_, d)| d);
        let listed = domain.and_then(|d| expect.email_domains.iter().find(|allowed| d.eq_ignore_ascii_case(allowed)));
        // Google Workspace names the hosted domain in `hd`; when present it must agree too.
        let hd_ok = match claims.get("hd") {
            None => true,
            Some(hd) => hd.as_str().zip(listed).is_some_and(|(hd, d)| hd.eq_ignore_ascii_case(d)),
        };
        if listed.is_none() || !hd_ok {
            return Err(ClaimError::EmailDomain);
        }
    }
    Ok(Identity { subject, email, email_verified, name: short(claims, "name"), picture: picture(claims.get("picture")), sid: short(claims, "sid") })
}
/// What a back-channel logout token asks to end: a subject, a provider session, or both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Logout {
    pub subject: Option<String>,
    pub sid: Option<String>,
    pub jti: String,
}
/// Check a logout token's claims (OpenID Connect Back-Channel Logout 1.0, section 2.6).
pub fn check_logout_token(claims: &Map<String, Value>, expect: &Expect) -> Result<Logout, ClaimError> {
    check_common(claims, expect)?;
    if number(claims, "exp").is_some_and(|exp| exp + SKEW_SECONDS <= expect.now) {
        return Err(ClaimError::Expired);
    }
    // Logout tokens are short lived: refuse old ones even without `exp`.
    if number(claims, "iat").is_some_and(|iat| iat + 600 < expect.now) {
        return Err(ClaimError::IssuedAt);
    }
    if claims.contains_key("nonce") {
        return Err(ClaimError::Nonce);
    }
    if !claims.get("events").and_then(Value::as_object).is_some_and(|e| e.get(BACKCHANNEL_EVENT).is_some_and(Value::is_object)) {
        return Err(ClaimError::Event);
    }
    let (subject, sid) = (short(claims, "sub"), short(claims, "sid"));
    if subject.is_none() && sid.is_none() {
        return Err(ClaimError::Subject);
    }
    let jti = short(claims, "jti").ok_or(ClaimError::Event)?;
    Ok(Logout { subject, sid, jti })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer as _;
    use serde_json::json;

    fn ed_key(seed: u8) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
    }
    fn p256_key(seed: u8) -> p256::ecdsa::SigningKey {
        p256::ecdsa::SigningKey::from_bytes(&[seed; 32].into()).unwrap()
    }
    fn ed_jwk(key: &ed25519_dalek::SigningKey, kid: &str) -> Value {
        json!({"kty":"OKP","crv":"Ed25519","kid":kid,"x":b64_encode(key.verifying_key().as_bytes())})
    }
    fn p256_jwk(key: &p256::ecdsa::SigningKey, kid: &str) -> Value {
        let point = key.verifying_key().to_encoded_point(false);
        json!({"kty":"EC","crv":"P-256","kid":kid,"x":b64_encode(point.x().unwrap()),"y":b64_encode(point.y().unwrap())})
    }
    fn keys(list: Vec<Value>) -> Vec<Jwk> {
        parse_jwks(json!({ "keys": list }).to_string().as_bytes()).unwrap()
    }
    fn encode(header: &Value, claims: &Value) -> String {
        format!("{}.{}", b64_encode(header.to_string().as_bytes()), b64_encode(claims.to_string().as_bytes()))
    }
    fn ed_token(key: &ed25519_dalek::SigningKey, header: Value, claims: Value) -> String {
        let input = encode(&header, &claims);
        let sig = key.sign(input.as_bytes());
        format!("{input}.{}", b64_encode(&sig.to_bytes()))
    }
    fn es_token(key: &p256::ecdsa::SigningKey, header: Value, claims: Value) -> String {
        use p256::ecdsa::signature::Signer;
        let input = encode(&header, &claims);
        let sig: p256::ecdsa::Signature = key.sign(input.as_bytes());
        format!("{input}.{}", b64_encode(&sig.to_bytes()))
    }
    fn claims() -> Value {
        json!({"iss":"https://idp.example","aud":"client","sub":"alice","nonce":"n1","iat":1000,"exp":2000,"email":"Alice@Example.org","email_verified":true,"name":"Alice","picture":"https://idp.example/a.png"})
    }
    fn expect() -> Expect<'static> {
        Expect { issuer: "https://idp.example", client_id: "client", nonce: Some("n1"), email_domains: &[], now: 1500 }
    }

    #[test]
    fn eddsa_and_es256_verify() {
        let (ed, ec) = (ed_key(1), p256_key(2));
        let set = keys(vec![ed_jwk(&ed, "e"), p256_jwk(&ec, "p")]);
        let t = ed_token(&ed, json!({"alg":"EdDSA","kid":"e"}), claims());
        let v = verify(&t, &set).unwrap();
        let id = check_id_token(&v.claims, &expect()).unwrap();
        assert_eq!(id.subject, "alice");
        assert_eq!((id.email_verified, id.picture.as_deref()), (true, Some("https://idp.example/a.png")));
        let t = es_token(&ec, json!({"alg":"ES256","kid":"p"}), claims());
        assert!(verify(&t, &set).is_ok());
    }
    #[test]
    fn rs256_verifies_and_small_moduli_are_ignored() {
        use rsa::{pkcs8::DecodePrivateKey, signature::Signer, traits::PublicKeyParts};
        let pem = include_str!("../../examples/test-idp-keys/rsa-1.pem");
        let private = rsa::RsaPrivateKey::from_pkcs8_pem(pem).unwrap();
        let public = private.to_public_key();
        let jwk = json!({"kty":"RSA","kid":"r","alg":"RS256","use":"sig","n":b64_encode(&public.n().to_bytes_be()),"e":b64_encode(&public.e().to_bytes_be())});
        let set = keys(vec![jwk.clone()]);
        let input = encode(&json!({"alg":"RS256","kid":"r"}), &claims());
        let signer = rsa::pkcs1v15::SigningKey::<sha2::Sha256>::new(private);
        let sig = signer.sign(input.as_bytes());
        let token = format!("{input}.{}", b64_encode(&rsa::signature::SignatureEncoding::to_bytes(&sig)));
        assert!(verify(&token, &set).is_ok());
        // The RSA key's alg is RS256: an ES256 or EdDSA header naming it is a mismatch.
        let forged = format!("{}.{}", encode(&json!({"alg":"ES256","kid":"r"}), &claims()), b64_encode(&[0; 64]));
        assert_eq!(verify(&forged, &set).unwrap_err(), JoseError::KeyMismatch);
        // A 1024-bit modulus is not a usable key at all.
        let mut weak = jwk;
        weak["n"] = json!(b64_encode(&[0xff; 128]));
        assert!(keys(vec![weak]).is_empty());
    }
    #[test]
    fn refuses_none_hmac_and_unknown_algorithms() {
        let ed = ed_key(1);
        let set = keys(vec![ed_jwk(&ed, "e")]);
        for alg in ["none", "HS256", "HS512", "RS512", "PS256", "ES384", "", "eddsa"] {
            let t = format!("{}.", encode(&json!({"alg":alg,"kid":"e"}), &claims()));
            assert_eq!(verify(&t, &set).unwrap_err(), JoseError::Algorithm, "{alg}");
            let t = format!("{}.{}", encode(&json!({"alg":alg,"kid":"e"}), &claims()), b64_encode(&[1; 32]));
            assert_eq!(verify(&t, &set).unwrap_err(), JoseError::Algorithm, "{alg}");
        }
        let t = ed_token(&ed, json!({"alg":"EdDSA","kid":"e","crit":["exp"]}), claims());
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::Algorithm);
        // A missing or non-string alg.
        let t = ed_token(&ed, json!({"kid":"e"}), claims());
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::Algorithm);
    }
    #[test]
    fn refuses_alg_kty_mismatch() {
        let (ed, ec) = (ed_key(1), p256_key(2));
        // An Ed25519 key under the kid of a P-256 key in the header, and vice versa.
        let set = keys(vec![ed_jwk(&ed, "e"), p256_jwk(&ec, "p")]);
        let t = ed_token(&ed, json!({"alg":"EdDSA","kid":"p"}), claims());
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::KeyMismatch);
        let t = es_token(&ec, json!({"alg":"ES256","kid":"e"}), claims());
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::KeyMismatch);
        // A key restricted to another alg by the JWKS.
        let mut jwk = ed_jwk(&ed, "e");
        jwk["alg"] = json!("ES256");
        let t = ed_token(&ed, json!({"alg":"EdDSA","kid":"e"}), claims());
        assert_eq!(verify(&t, &keys(vec![jwk])).unwrap_err(), JoseError::KeyMismatch);
        // Encryption keys and unknown curves are not signature keys.
        let mut enc = ed_jwk(&ed, "e");
        enc["use"] = json!("enc");
        assert!(keys(vec![enc, json!({"kty":"OKP","crv":"X25519","x":b64_encode(&[9; 32])})]).is_empty());
    }
    #[test]
    fn key_selection_by_kid() {
        let (a, b) = (ed_key(1), ed_key(2));
        let set = keys(vec![ed_jwk(&a, "a"), ed_jwk(&b, "b")]);
        let t = ed_token(&b, json!({"alg":"EdDSA","kid":"b"}), claims());
        assert!(verify(&t, &set).is_ok());
        let t = ed_token(&b, json!({"alg":"EdDSA","kid":"a"}), claims());
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::Signature);
        let t = ed_token(&b, json!({"alg":"EdDSA","kid":"c"}), claims());
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::UnknownKey);
        // No kid: fine with one key, refused with several.
        let t = ed_token(&b, json!({"alg":"EdDSA"}), claims());
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::AmbiguousKey);
        assert!(verify(&t, &keys(vec![ed_jwk(&b, "b")])).is_ok());
        let t = ed_token(&b, json!({"alg":"EdDSA","kid":5}), claims());
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::Malformed);
        // A duplicated kid is ambiguous.
        let dup = keys(vec![ed_jwk(&a, "a"), ed_jwk(&b, "a")]);
        let t = ed_token(&a, json!({"alg":"EdDSA","kid":"a"}), claims());
        assert_eq!(verify(&t, &dup).unwrap_err(), JoseError::AmbiguousKey);
    }
    #[test]
    fn refuses_malformed_encodings() {
        let ed = ed_key(1);
        let set = keys(vec![ed_jwk(&ed, "e")]);
        let good = ed_token(&ed, json!({"alg":"EdDSA","kid":"e"}), claims());
        assert!(verify(&good, &set).is_ok());
        let parts: Vec<&str> = good.split('.').collect();
        let cases = [
            format!("{good}.extra"),
            format!("{}.{}", parts[0], parts[1]),
            format!("{}.{}.{}=", parts[0], parts[1], parts[2]),
            format!("{}=.{}.{}", parts[0], parts[1], parts[2]),
            format!("{}.+{}.{}", parts[0], &parts[1][1..], parts[2]),
            format!("{} .{}.{}", parts[0], parts[1], parts[2]),
            format!("{}.{}.{}", parts[0], parts[1], &parts[2][1..]),
            format!("{}.{}.{}", b64_encode(b"[1,2]"), parts[1], parts[2]),
            format!("{}.{}.{}", parts[0], b64_encode(b"not json"), parts[2]),
            String::new(),
            "..".into(),
        ];
        for case in cases {
            assert!(verify(&case, &set).is_err(), "{case}");
        }
        // Non-zero trailing bits are not canonical base64url.
        assert!(b64_decode("QQ").is_some() && b64_decode("QR").is_none());
        // Oversized tokens are refused before any parsing.
        let mut big = claims();
        big["pad"] = json!("x".repeat(MAX_TOKEN_BYTES));
        let t = ed_token(&ed, json!({"alg":"EdDSA","kid":"e"}), big);
        assert_eq!(verify(&t, &set).unwrap_err(), JoseError::Malformed);
        assert_eq!(unverified_claims(&t).unwrap_err(), JoseError::Malformed);
        assert!(parse_jwks(&vec![b' '; MAX_JWKS_BYTES + 1]).is_err());
        // A flipped bit in the claims fails the signature.
        let at = parts[0].len() + 3;
        let mut bytes = good.clone().into_bytes();
        bytes[at] ^= 1;
        assert!(verify(std::str::from_utf8(&bytes).unwrap(), &set).is_err());
    }
    #[test]
    fn claim_checks() {
        let c = |patch: Value| {
            let mut v = claims();
            for (k, val) in patch.as_object().unwrap() {
                if val.is_null() {
                    v.as_object_mut().unwrap().remove(k);
                } else {
                    v[k] = val.clone();
                }
            }
            v.as_object().unwrap().clone()
        };
        let e = expect();
        assert!(check_id_token(&c(json!({})), &e).is_ok());
        assert_eq!(check_id_token(&c(json!({"iss":"https://idp.example/"})), &e).unwrap_err(), ClaimError::Issuer);
        assert_eq!(check_id_token(&c(json!({"aud":"other"})), &e).unwrap_err(), ClaimError::Audience);
        assert_eq!(check_id_token(&c(json!({"aud":["client","other"]})), &e).unwrap_err(), ClaimError::Audience);
        assert!(check_id_token(&c(json!({"aud":["client","other"],"azp":"client"})), &e).is_ok());
        assert_eq!(check_id_token(&c(json!({"azp":"other"})), &e).unwrap_err(), ClaimError::Audience);
        assert_eq!(check_id_token(&c(json!({"exp":1380})), &e).unwrap_err(), ClaimError::Expired);
        assert!(check_id_token(&c(json!({"exp":1381})), &e).is_ok());
        assert_eq!(check_id_token(&c(json!({"exp":null})), &e).unwrap_err(), ClaimError::Expired);
        assert_eq!(check_id_token(&c(json!({"iat":1801})), &e).unwrap_err(), ClaimError::IssuedAt);
        assert_eq!(check_id_token(&c(json!({"iat":null})), &e).unwrap_err(), ClaimError::IssuedAt);
        assert_eq!(check_id_token(&c(json!({"nonce":"n2"})), &e).unwrap_err(), ClaimError::Nonce);
        assert_eq!(check_id_token(&c(json!({"nonce":null})), &e).unwrap_err(), ClaimError::Nonce);
        assert_eq!(check_id_token(&c(json!({"sub":""})), &e).unwrap_err(), ClaimError::Subject);
        let domains = ["example.org".to_string()];
        let domain = Expect { email_domains: &domains, ..expect() };
        assert!(check_id_token(&c(json!({})), &domain).is_ok());
        assert_eq!(check_id_token(&c(json!({"email_verified":false})), &domain).unwrap_err(), ClaimError::EmailUnverified);
        assert_eq!(check_id_token(&c(json!({"email_verified":"true"})), &domain).unwrap_err(), ClaimError::EmailUnverified);
        assert_eq!(check_id_token(&c(json!({"email":"alice@evil.example.org"})), &domain).unwrap_err(), ClaimError::EmailDomain);
        assert_eq!(check_id_token(&c(json!({"email":"alice@example.org.evil"})), &domain).unwrap_err(), ClaimError::EmailDomain);
        assert_eq!(check_id_token(&c(json!({"email":null})), &domain).unwrap_err(), ClaimError::EmailDomain);
        assert_eq!(check_id_token(&c(json!({"hd":"other.org"})), &domain).unwrap_err(), ClaimError::EmailDomain);
        assert!(check_id_token(&c(json!({"hd":"example.org"})), &domain).is_ok());
        // A missing or non-boolean email_verified is false; a picture must be an https URL.
        assert!(!check_id_token(&c(json!({"email_verified":null})), &e).unwrap().email_verified);
        assert!(!check_id_token(&c(json!({"email_verified":"true"})), &e).unwrap().email_verified);
        assert_eq!(check_id_token(&c(json!({"picture":"javascript:alert(1)"})), &e).unwrap().picture, None);
        assert_eq!(check_id_token(&c(json!({"picture":"http://idp.example/a.png"})), &e).unwrap().picture, None);
        // Several domains: any one of them, and `hd` must name the email's own domain.
        let two = ["example.org".to_string(), "lab.example".to_string()];
        let both = Expect { email_domains: &two, ..expect() };
        assert!(check_id_token(&c(json!({"email":"bob@lab.example"})), &both).is_ok());
        assert_eq!(check_id_token(&c(json!({"email":"bob@lab.example","hd":"example.org"})), &both).unwrap_err(), ClaimError::EmailDomain);
        assert_eq!(check_id_token(&c(json!({"email":"bob@other.example"})), &both).unwrap_err(), ClaimError::EmailDomain);
        // A refreshed ID token need not carry the nonce; every other claim is checked as at sign-in.
        assert!(check_refreshed_id_token(&c(json!({"nonce":null})), &e).is_ok());
        assert_eq!(check_refreshed_id_token(&c(json!({"nonce":null,"aud":"other"})), &e).unwrap_err(), ClaimError::Audience);
        assert_eq!(check_refreshed_id_token(&c(json!({"nonce":null,"exp":1000})), &e).unwrap_err(), ClaimError::Expired);
    }
    #[test]
    fn logout_token_checks() {
        let base = json!({"iss":"https://idp.example","aud":"client","iat":1400,"jti":"j1","sub":"alice","events":{BACKCHANNEL_EVENT:{}}});
        let e = Expect { nonce: None, ..expect() };
        let c = |v: &Value| v.as_object().unwrap().clone();
        assert_eq!(check_logout_token(&c(&base), &e).unwrap().subject.as_deref(), Some("alice"));
        let mut v = base.clone();
        v["nonce"] = json!("n");
        assert_eq!(check_logout_token(&c(&v), &e).unwrap_err(), ClaimError::Nonce);
        let mut v = base.clone();
        v["events"] = json!({});
        assert_eq!(check_logout_token(&c(&v), &e).unwrap_err(), ClaimError::Event);
        let mut v = base.clone();
        v.as_object_mut().unwrap().remove("sub");
        assert_eq!(check_logout_token(&c(&v), &e).unwrap_err(), ClaimError::Subject);
        v["sid"] = json!("s1");
        assert_eq!(check_logout_token(&c(&v), &e).unwrap().sid.as_deref(), Some("s1"));
        let mut v = base.clone();
        v["iat"] = json!(100);
        assert_eq!(check_logout_token(&c(&v), &e).unwrap_err(), ClaimError::IssuedAt);
    }
}

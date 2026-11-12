//! Content-addressed immutable binary objects. Hashing is shared by WASM and services.
use sha2::{Digest, Sha256};

pub const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn verify(expected: &str, bytes: &[u8]) -> bool {
    valid_hash(expected) && bytes.len() <= MAX_BLOB_BYTES && hash(bytes) == expected
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_digest_and_tamper_rejection() {
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(hash(b"abc"), expected);
        assert!(verify(expected, b"abc"));
        assert!(!verify(expected, b"abd"));
        assert!(!valid_hash("../blob"));
        assert!(!valid_hash(&expected.to_uppercase()));
    }
}

//! Transport-neutral exchange validation. The caller must authenticate the peer
//! before constructing a Grant; a device/session ID in a packet proves nothing.
use crate::{blob, commands};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub version: u32,
    pub project_id: String,
    pub device_id: String,
    pub session_id: String,
    pub sequence: u32,
    pub payload: Payload,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Payload {
    Command {
        request: commands::Request,
    },
    // Plaintext replication is a separate grant; write permission alone does
    // not authorize bypassing command validation with arbitrary CRDT bytes.
    Replica {
        object: commands::Blob,
    },
    Ciphertext {
        object: commands::Blob,
        #[serde(rename = "keyEpoch")]
        key_epoch: u32,
        nonce: String,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub project_id: String,
    pub device_id: String,
    pub session_id: String,
    pub next_sequence: u32,
    pub command: Option<commands::Context>,
    pub plaintext_replication: bool,
    pub ciphertext_storage: bool,
}
fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
}
pub fn validate(envelope: &Envelope, grant: &Grant) -> Result<(), commands::Error> {
    let reject = commands::Error::invalid;
    if envelope.version != 1 {
        return Err(reject("Unsupported exchange version."));
    }
    if ![
        &envelope.project_id,
        &envelope.device_id,
        &envelope.session_id,
    ]
    .iter()
    .all(|s| identifier(s))
        || envelope.project_id != grant.project_id
        || envelope.device_id != grant.device_id
        || envelope.session_id != grant.session_id
    {
        return Err(reject("Exchange peer is outside the authenticated grant."));
    }
    if envelope.sequence == 0 || envelope.sequence != grant.next_sequence {
        return Err(reject("Exchange sequence is stale or out of order."));
    }
    match &envelope.payload {
        Payload::Command { request } => {
            let context = grant
                .command
                .as_ref()
                .ok_or_else(|| reject("Commands are not authorized."))?;
            if context.project_id != envelope.project_id
                || request.project_id != envelope.project_id
            {
                return Err(reject("Command belongs to another project."));
            }
            commands::validate(request, context)
        }
        Payload::Replica { object } => {
            if !grant.plaintext_replication {
                return Err(reject("Plaintext replication is not authorized."));
            }
            check_object(object)
        }
        Payload::Ciphertext {
            object,
            key_epoch,
            nonce,
        } => {
            if !grant.ciphertext_storage {
                return Err(reject("Ciphertext storage is not authorized."));
            }
            // Reserved suite: XChaCha20-Poly1305, 24-byte nonce, encoded as hex.
            // This validates framing only. A future client must authenticate
            // the ciphertext and bind project/object/epoch as associated data.
            if *key_epoch == 0
                || nonce.len() != 48
                || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
                || object.size < 16
            {
                return Err(reject("Invalid encrypted-object framing."));
            }
            check_object(object)
        }
    }
}
fn check_object(object: &commands::Blob) -> Result<(), commands::Error> {
    if !blob::valid_hash(&object.hash) || object.size == 0 || object.size > blob::MAX_BLOB_BYTES {
        return Err(commands::Error::invalid(
            "Invalid exchange object reference.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant() -> Grant {
        serde_json::from_value(serde_json::json!({"projectId":"p","deviceId":"d","sessionId":"s","nextSequence":1,"command":{"projectId":"p","revision":"r","capabilities":["read"]},"plaintextReplication":false,"ciphertextStorage":true})).unwrap()
    }
    fn packet(payload: serde_json::Value) -> Envelope {
        serde_json::from_value(serde_json::json!({"version":1,"projectId":"p","deviceId":"d","sessionId":"s","sequence":1,"payload":payload})).unwrap()
    }
    #[test]
    fn scope_sequence_and_command_grants_are_independent() {
        let mut p = packet(
            serde_json::json!({"kind":"command","request":{"version":1,"requestId":"q","projectId":"p","expectedRevision":"r","command":{"op":"project.inspect"}}}),
        );
        let g = grant();
        assert!(validate(&p, &g).is_ok());
        p.sequence = 2;
        assert!(validate(&p, &g).is_err());
        p.sequence = 1;
        p.session_id = "other".into();
        assert!(validate(&p, &g).is_err());
        p.session_id = "s".into();
        if let Payload::Command { request } = &mut p.payload {
            request.command = commands::Command::Delete { id: "file".into() };
        }
        assert!(validate(&p, &g).is_err());
    }
    #[test]
    fn opaque_storage_never_grants_plaintext_replication() {
        let hash = "a".repeat(64);
        let mut p = packet(
            serde_json::json!({"kind":"ciphertext","object":{"hash":hash,"size":32},"keyEpoch":1,"nonce":"b".repeat(48)}),
        );
        let mut g = grant();
        assert!(validate(&p, &g).is_ok());
        g.ciphertext_storage = false;
        assert!(validate(&p, &g).is_err());
        p.payload = Payload::Replica {
            object: commands::Blob { hash, size: 32 },
        };
        assert!(validate(&p, &g).is_err());
        g.plaintext_replication = true;
        assert!(validate(&p, &g).is_ok());
    }
    #[test]
    fn forged_grants_inside_packets_and_malformed_ciphertext_are_rejected() {
        assert!(serde_json::from_value::<Envelope>(serde_json::json!({"version":1,"projectId":"p","deviceId":"d","sessionId":"s","sequence":1,"capabilities":["write"],"payload":{"kind":"replica","object":{"hash":"a".repeat(64),"size":1}}})).is_err());
        for (epoch, nonce, size) in [
            (0, "b".repeat(48), 32),
            (1, "b".repeat(47), 32),
            (1, "z".repeat(48), 32),
            (1, "b".repeat(48), 15),
        ] {
            let p = packet(
                serde_json::json!({"kind":"ciphertext","object":{"hash":"a".repeat(64),"size":size},"keyEpoch":epoch,"nonce":nonce}),
            );
            assert!(validate(&p, &grant()).is_err());
        }
    }
}

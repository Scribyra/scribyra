//! Encrypted project objects (org-sync slice 6): binary assets and history objects under keyed
//! IDs, authorised by project membership, through the real binary against real PostgreSQL with
//! filesystem and Garage (S3) blobs.
mod support;
use scribyra_core::orgsync as core;
use scribyra_sync::blobs::{BlobKey, BlobStore, FsBlobStore, S3BlobStore, S3Settings};
use serde_json::{Value, json};
use support::{orgs::*, *};

fn put(org: &Org, token: &str, project: &str, id: &str, epoch: u32, body: &[u8]) -> Reply {
    send("PUT", &org.url(&format!("/v1/projects/{project}/objects/{id}?epoch={epoch}")), Some(token), "application/octet-stream", body)
}
fn get(org: &Org, token: &str, project: &str, id: &str) -> Reply {
    send("GET", &org.url(&format!("/v1/projects/{project}/objects/{id}")), Some(token), "", b"")
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// The blob store behind a service, opened directly (what an operator or a thief of the
/// bucket or disk would see).
fn objects(backend: Value, raw: Box<dyn BlobStore>) {
    let mut overrides = json!({"requests_per_second": 100000, "source_requests_per_second": 100000});
    for (k, v) in backend.as_object().unwrap() {
        overrides[k] = v.clone();
    }
    let s = Service::new(org_overrides(overrides));
    let mut org = Org::create(&s, &[], json!({}));
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let project = org.create_project(&token, &owner);
    // Ben views the project; Cat is a member of the org without access to it.
    let (_, invite, seed) = org.invite(&token, &owner, json!({}));
    let ben = Device::new();
    assert_eq!(org.join(&ben, &invite, &seed).status, 201);
    let (_, invite, seed) = org.invite(&token, &owner, json!({}));
    let cat = Device::new();
    assert_eq!(org.join(&cat, &invite, &seed).status, 201);
    assert_eq!(org.post(Some(&token), "project.grant", json!({"project":project,"person":org.person(&ben),"role":"viewer"}), &owner.seed).status, 201);
    let (ben_token, cat_token) = (org.token(&ben.seed), org.token(&cat.seed));

    let project_key = random_bytes(32);
    let marker = b"PLAINTEXT_IMAGE_MARKER: the bytes of a figure";
    let hash = core::hex(&core::sha256(marker));
    let (id, sealed) = core::seal_object(&project_key, &org.id, &project, 1, "asset", &hash, 0, 1, marker).unwrap();
    // Editors upload under the current epoch; an identical retry is free.
    assert_eq!(put(&org, &token, &project, &id, 1, &sealed).status, 201);
    assert_eq!(put(&org, &token, &project, &id, 1, &sealed).status, 204);
    // An ID is written once: other bytes under it are refused.
    let mut other = sealed.clone();
    other[30] ^= 1;
    assert_eq!(put(&org, &token, &project, &id, 1, &other).status, 409);
    // Only the current epoch, only editors, only members, only with a session.
    assert_eq!(put(&org, &token, &project, &random_hex(32), 2, &sealed).status, 409);
    assert_eq!(put(&org, &ben_token, &project, &random_hex(32), 1, &sealed).status, 403);
    assert_eq!(put(&org, &cat_token, &project, &random_hex(32), 1, &sealed).status, 403);
    assert_eq!(send("PUT", &org.url(&format!("/v1/projects/{project}/objects/{}?epoch=1", random_hex(32))), None, "application/octet-stream", &sealed).status, 401);
    assert_eq!(put(&org, &token, &project, &random_hex(32), 1, &[0u8; 20]).status, 400);
    // Every member reads it back exactly; others cannot.
    let reply = get(&org, &ben_token, &project, &id);
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, sealed);
    assert_eq!(core::open_object(&project_key, &org.id, &project, 1, "asset", &hash, 0, 1, &reply.body).unwrap(), marker);
    assert_eq!(get(&org, &cat_token, &project, &id).status, 403);
    assert_eq!(get(&org, &token, &project, &random_hex(32)).status, 404);
    // The plaintext hash and content are nowhere on the service: not in the database...
    for table in ["project_objects", "objects", "entries", "org_events", "usage"] {
        let count = postgres().psql(s.database_url(), &format!("SELECT count(*) FROM {table} t WHERE position('{hash}' in t::text) > 0"));
        assert_eq!(count, "0", "{table}");
    }
    // ...and not in the blob store, which holds exactly the ciphertext.
    let key = BlobKey::new(format!("objects/p-{project}/{}", core::hex(&core::sha256(&sealed)))).unwrap();
    let rt = runtime();
    let stored = rt.block_on(raw.get(&key, sealed.len())).unwrap();
    assert_eq!(stored, sealed);
    assert!(!contains(&stored, marker) && !contains(&stored, hash.as_bytes()));
    // A copy damaged in the blob store is answered with an error, never with other bytes, and an
    // editor's identical upload repairs it.
    rt.block_on(raw.put(&key, other.clone().into())).unwrap();
    assert_eq!(get(&org, &ben_token, &project, &id).status, 500);
    assert_eq!(put(&org, &token, &project, &id, 1, &sealed).status, 204);
    assert_eq!(get(&org, &ben_token, &project, &id).body, sealed);
    // A removed member loses access to objects at once.
    let ben_person = org.person(&ben);
    assert_eq!(org.post(Some(&token), "person.remove", json!({"person": ben_person}), &owner.seed).status, 201);
    assert_ne!(get(&org, &ben_token, &project, &id).status, 200);
}

#[test]
fn encrypted_objects_with_filesystem_blobs() {
    let dir = temp_dir("scribyra-objects-");
    let data = dir.join("data");
    let raw = FsBlobStore::open(&data).unwrap();
    objects(json!({"data": data}), Box::new(raw));
}
#[test]
fn encrypted_objects_with_garage_blobs() {
    let bucket: S3Settings = garage().bucket();
    let config = json!({
        "blob_store": "s3", "s3_endpoint": bucket.endpoint, "s3_region": bucket.region, "s3_bucket": bucket.bucket,
        "s3_access_key_id": bucket.access_key_id, "s3_secret_access_key_file": garage().secret_file, "s3_path_style": true,
    });
    objects(config, Box::new(S3BlobStore::new(bucket).unwrap()));
}

#[test]
fn full_organisation_storage_refuses_objects_with_507_and_keeps_membership_working() {
    let s = Service::new(org_overrides(json!({"org_bytes": 64 * 1024})));
    let mut org = Org::create(&s, &[], json!({}));
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let project = org.create_project(&token, &owner);
    let key = random_bytes(32);
    let big = random_bytes(100 * 1024);
    let (id, sealed) = core::seal_object(&key, &org.id, &project, 1, "asset", &core::hex(&core::sha256(&big)), 0, 1, &big).unwrap();
    assert_eq!(put(&org, &token, &project, &id, 1, &sealed).status, 507);
    assert_eq!(postgres().psql(s.database_url(), "SELECT count(*) FROM project_objects"), "0");
    // Membership still works in a full organisation.
    assert_eq!(org.post(Some(&token), "project.create", json!({"project": random_hex(32), "epoch": 1, "keyCommit": random_hex(32)}), &owner.seed).status, 201);
}

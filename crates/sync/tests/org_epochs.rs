//! Project key epochs (org-sync slice 7): removal makes a rotation due, the service cuts over to
//! the new epoch at its log head and refuses new entries under the old one (repeats excepted),
//! concurrent rotations are ordered by the membership log, and wraps of the new key reach only
//! remaining members. Real PostgreSQL with filesystem and Garage blobs.
mod support;
use scribyra_core::orgsync as core;
use serde_json::{Value, json};
use support::{orgs::*, *};

fn epochs(backend: Value) {
    let mut overrides = json!({"requests_per_second": 100000, "source_requests_per_second": 100000, "entry_inline_bytes": 1024});
    for (k, v) in backend.as_object().unwrap() {
        overrides[k] = v.clone();
    }
    let s = Service::new(org_overrides(overrides));
    let mut org = Org::create(&s, &[], json!({}));
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let project = org.create_project(&token, &owner);
    let (ben, cat) = (Device::new(), Device::new());
    for d in [&ben, &cat] {
        let (_, invite, seed) = org.invite(&token, &owner, json!({}));
        assert_eq!(org.join(d, &invite, &seed).status, 201);
        assert_eq!(org.post(Some(&token), "project.grant", json!({"project":project,"person":org.person(d),"role":"editor"}), &owner.seed).status, 201);
    }
    let (ben_token, cat_token) = (org.token(&ben.seed), org.token(&cat.seed));
    // Three people write under epoch 1 (one large entry goes to the blob store).
    let first = entry(&org.id, &project, &owner.seed, 1, 1, &random_bytes(100));
    assert_eq!(org.append(&token, &project, &first).status, 201);
    assert_eq!(org.append(&ben_token, &project, &entry(&org.id, &project, &ben.seed, 1, 1, &random_bytes(5000))).status, 201);
    assert_eq!(org.append(&cat_token, &project, &entry(&org.id, &project, &cat.seed, 1, 1, &random_bytes(100))).status, 201);
    // Cat is removed: her sessions close, and the project needs a new key.
    let cat_person = org.person(&cat);
    assert_eq!(org.post(Some(&token), "person.remove", json!({"person": cat_person}), &owner.seed).status, 201);
    assert!(org.state.projects[&project].stale);
    assert_ne!(org.append(&cat_token, &project, &entry(&org.id, &project, &cat.seed, 2, 1, &random_bytes(100))).status, 201);
    // A rotation cannot claim a log position the service does not have; at the head it is accepted.
    let rotate = |org: &mut Org, by: &Device, token: &str, epoch: u32, after: u64| org.post(Some(token), "project.epoch", json!({"project":project,"epoch":epoch,"keyCommit":random_hex(32),"after":after}), &by.seed);
    assert_eq!(rotate(&mut org, &ben, &ben_token, 2, 4).status, 400);
    assert_eq!(rotate(&mut org, &ben, &ben_token, 2, 3).status, 201);
    let row = postgres().psql(s.database_url(), &format!("SELECT epoch || ',' || epoch_cutover FROM projects WHERE project = '{project}'"));
    assert_eq!(row, "2,3");
    // After the cutover: an identical repeat of an entry already held still gets its answer; a
    // new entry under the old epoch is refused with 409 epoch (the client re-encrypts it); the
    // new epoch is accepted. A future epoch is refused too.
    assert_eq!(org.append(&token, &project, &first).status, 200);
    let stale = org.append(&token, &project, &entry(&org.id, &project, &owner.seed, 2, 1, &random_bytes(100)));
    assert_eq!((stale.status, stale.json()["error"].as_str()), (409, Some("epoch")));
    let big_stale = org.append(&ben_token, &project, &entry(&org.id, &project, &ben.seed, 2, 1, &random_bytes(5000)));
    assert_eq!(big_stale.status, 409);
    assert_eq!(org.append(&token, &project, &entry(&org.id, &project, &owner.seed, 2, 3, &random_bytes(100))).status, 409);
    assert_eq!(org.append(&token, &project, &entry(&org.id, &project, &owner.seed, 2, 2, &random_bytes(100))).status, 201);
    // Objects follow the same epoch.
    let object = random_bytes(100);
    let put = |token: &str, epoch: u32| send("PUT", &org.url(&format!("/v1/projects/{project}/objects/{}?epoch={epoch}", random_hex(32))), Some(token), "application/octet-stream", &object).status;
    assert_eq!(put(&token, 1), 409);
    assert_eq!(put(&token, 2), 201);
    // Wraps of the new key go to remaining members only; earlier epochs stay wrappable (to read
    // history), and the service lists every epoch a member still lacks.
    assert_eq!(org.put_wraps(&token, &[org.wrap(&project, 2, &cat.agreement, &owner)]).status, 400);
    assert_eq!(org.put_wraps(&token, &[org.wrap(&project, 2, &owner.agreement, &owner), org.wrap(&project, 1, &owner.agreement, &owner)]).status, 204);
    let pending = send("GET", &org.url(&format!("/v1/orgs/{}/pending", org.id)), Some(&token), "", b"").json();
    let listed: Vec<(String, u64)> = pending["pending"].as_array().unwrap().iter().filter(|p| p["project"] == project.as_str()).map(|p| (p["recipients"].to_string(), p["epoch"].as_u64().unwrap())).collect();
    assert!(listed.iter().any(|(r, e)| *e == 1 && r.contains(&ben.agreement)) && listed.iter().any(|(r, e)| *e == 2 && r.contains(&ben.agreement)));
    assert!(listed.iter().all(|(r, _)| !r.contains(&cat.agreement) && !r.contains(&owner.agreement)));
    // Concurrent rotations: both sign at the same head; the log takes one, the other is a
    // conflict, and signed again on the new head it is refused (that epoch exists).
    let head = org.state.head.clone();
    let a = sign_event(&org.id, &head, "project.epoch", json!({"project":project,"epoch":3,"keyCommit":random_hex(32),"after":4}), &owner.seed);
    let b = sign_event(&org.id, &head, "project.epoch", json!({"project":project,"epoch":3,"keyCommit":random_hex(32),"after":4}), &ben.seed);
    assert_eq!(org.post_raw(Some(&token), &a).status, 201);
    assert_eq!(org.post_raw(Some(&ben_token), &b).status, 409);
    assert_eq!(rotate(&mut org, &ben, &ben_token, 3, 4).status, 400);
    assert_eq!(postgres().psql(s.database_url(), &format!("SELECT epoch FROM projects WHERE project = '{project}'")), "3");
    // Readers' rule: Cat's devices are cut off above the `after` Ben signed.
    let state = &org.state;
    assert!(state.entry_cut_off(&project, &cat.key, 4, 1) && !state.entry_cut_off(&project, &cat.key, 3, 1));
    assert!(!state.entry_cut_off(&project, &ben.key, 4, 1));
    // The membership state the service replays after a restart agrees.
    let reply = send("GET", &org.url(&format!("/v1/orgs/{}/events?after=0", org.id)), Some(&token), "", b"").json();
    let events: Vec<String> = serde_json::from_value(reply["events"].clone()).unwrap();
    let mut replay = core::OrgState::new(&org.id).unwrap();
    for raw in &events {
        replay.apply(raw, None).unwrap();
    }
    assert_eq!(replay.projects[&project], org.state.projects[&project]);
}

#[test]
fn epochs_with_filesystem_blobs() {
    epochs(json!({}));
}
#[test]
fn epochs_with_garage_blobs() {
    epochs(garage().config());
}

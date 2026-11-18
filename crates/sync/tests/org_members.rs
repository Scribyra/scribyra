//! The end-to-end organisation's join requests, roles, removal, project grants and pending wraps,
//! through the real binary against real PostgreSQL and the test provider.
mod support;
use scribyra_core::orgsync::{self as core, Wrap};
use serde_json::json;
use support::{orgs::*, sso::*, *};

fn real_wrap(org: &Org, project: &str, epoch: u32, recipient: &str, sender: &Device, key: &[u8]) -> String {
    let mut wrap = Wrap { v: 1, org: org.id.clone(), project: project.into(), epoch, recipient: recipient.into(), enc: String::new(), nonce: String::new(), ct: String::new(), sender: sender.key.clone(), sig: String::new() };
    let nonce: [u8; 24] = random_bytes(24).try_into().unwrap();
    core::seal_wrap(&mut wrap, &random_bytes(32), &nonce, key).unwrap();
    let mut value = serde_json::to_value(&wrap).unwrap();
    value.as_object_mut().unwrap().remove("sig");
    value["sig"] = json!(sender.sign(&core::wrap_signing_message(&value).unwrap()));
    core::canonical(&value).unwrap()
}

fn env() -> Env {
    Env::start("RS256", people(), json!({"requests_per_second": 100000, "source_requests_per_second": 100000}), json!({}))
}

#[test]
fn join_requests_roles_and_removal_are_enforced_by_the_service() {
    let env = env();
    let client = env.client();
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    // Ben signs in and asks to join: he is pending and cannot open a session until approved.
    let ben = Device::new();
    assert_eq!(org.request(&client, "ben", &ben).status, 201);
    assert_eq!(org.sign_in_with(&ben.seed, json!({})).status, 403);
    // A join request needs a sign-in whose identity is nobody's yet, and only one per identity.
    let body = org.request_body(&Device::new());
    let stranger = Device::new();
    assert_eq!(org.post(None, "person.request", body, &stranger.seed).status, 403);
    let again = Device::new();
    let ben_login = org.logins[&org.person(&ben)].clone();
    let body = org.request_body(&again);
    assert_eq!(org.post_login("person.request", body, &again.seed, &ben_login).status, 409);
    let body = org.request_body(&again);
    assert_eq!(org.post_login("person.request", body, &again.seed, &org.logins[&org.owner_person].clone()).status, 409);
    let ben_person = org.person(&ben);
    assert_eq!(org.post(Some(&token), "person.approve", json!({"person":ben_person,"role":"member"}), &owner.seed).status, 201);
    let ben_token = org.token(&ben.seed);
    // A member cannot approve anyone.
    let cat = Device::new();
    assert_eq!(org.request(&client, "cat", &cat).status, 201);
    let cat_person = org.person(&cat);
    assert_eq!(org.post(Some(&ben_token), "person.approve", json!({"person":cat_person,"role":"member"}), &ben.seed).status, 400);
    assert_eq!(org.post(Some(&token), "person.approve", json!({"person":cat_person,"role":"member"}), &owner.seed).status, 201);
    let cat_token = org.token(&cat.seed);
    // Project roles: viewers read, only editors append.
    let project = org.create_project(&token, &owner);
    assert_eq!(org.post(Some(&token), "project.grant", json!({"project":project,"person":cat_person,"role":"viewer"}), &owner.seed).status, 201);
    let first = entry(&org.id, &project, &owner.seed, 1, 1, &random_bytes(100));
    assert_eq!(org.append(&token, &project, &first).status, 201);
    let (read, items) = org.log_page(&cat_token, &project, 0);
    assert_eq!((read.status, items.len()), (200, 1));
    assert_eq!(org.append(&cat_token, &project, &entry(&org.id, &project, &cat.seed, 1, 1, &random_bytes(100))).status, 403);
    assert_eq!(org.log_page(&ben_token, &project, 0).0.status, 403);
    assert_eq!(org.post(Some(&token), "project.grant", json!({"project":project,"person":cat_person,"role":"editor"}), &owner.seed).status, 201);
    assert_eq!(org.append(&cat_token, &project, &entry(&org.id, &project, &cat.seed, 1, 1, &random_bytes(100))).status, 201);
    // Removal closes the person's sessions at once and refuses new ones.
    assert_eq!(org.post(Some(&token), "person.remove", json!({"person":cat_person}), &owner.seed).status, 201);
    assert_eq!(send("GET", &org.url(&format!("/v1/orgs/{}/events", org.id)), Some(&cat_token), "", b"").status, 401);
    assert_eq!(org.sign_in_with(&cat.seed, json!({})).status, 403);
    // Leaving: a person can remove themselves.
    let ben_person = org.person(&ben);
    assert_eq!(org.post(Some(&ben_token), "person.remove", json!({"person":ben_person}), &ben.seed).status, 201);
    assert_eq!(org.sign_in_with(&ben.seed, json!({})).status, 403);
}

#[test]
fn pending_wraps_list_exactly_the_keys_still_missing() {
    let env = env();
    let client = env.client();
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let url = org.url(&format!("/v1/orgs/{}/pending", org.id));
    let pending = |token: &str| send("GET", &url, Some(token), "", b"").json()["pending"].clone();
    // The directory key is missing for the owner's own device until the owner wraps it.
    let list = pending(&token);
    assert_eq!(list, json!([{"project": org.id, "epoch": 1, "recipients": [owner.agreement]}]));
    let key = random_bytes(32);
    assert_eq!(org.put_wraps(&token, &[real_wrap(&org, &org.id.clone(), 1, &owner.agreement, &owner, &key)]).status, 204);
    assert_eq!(pending(&token), json!([]));
    let project = org.create_project(&token, &owner);
    assert_eq!(pending(&token), json!([{"project": project, "epoch": 1, "recipients": [owner.agreement]}]));
    assert_eq!(org.put_wraps(&token, &[real_wrap(&org, &project, 1, &owner.agreement, &owner, &key)]).status, 204);
    // A new member needs the directory key; once granted, the project key too.
    let ben = Device::new();
    org.admit(&client, "ben", &ben);
    assert_eq!(pending(&token), json!([{"project": org.id, "epoch": 1, "recipients": [ben.agreement]}]));
    let ben_person = org.person(&ben);
    assert_eq!(org.post(Some(&token), "project.grant", json!({"project":project,"person":ben_person,"role":"reviewer"}), &owner.seed).status, 201);
    let list = pending(&token);
    assert_eq!(list.as_array().unwrap().len(), 2);
    // Ben cannot see what is missing for a project he does not belong to.
    let ben_token = org.token(&ben.seed);
    let other = org.create_project(&token, &owner);
    assert!(pending(&ben_token).as_array().unwrap().iter().all(|p| p["project"] != json!(other)));
    // Wraps must address entitled keys only: a wrap to a stranger is refused.
    assert_eq!(org.put_wraps(&token, &[real_wrap(&org, &project, 1, &Device::new().agreement, &owner, &key)]).status, 400);
}

#[test]
fn the_heads_notice_wakes_on_changes_and_shows_only_readable_projects() {
    let env = env();
    let client = env.client();
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let project = org.create_project(&token, &owner);
    let ben = Device::new();
    org.admit(&client, "ben", &ben);
    let ben_token = org.token(&ben.seed);
    let heads_url = org.url(&format!("/v1/orgs/{}/heads", org.id));
    let now = send("GET", &heads_url, Some(&token), "", b"").json();
    assert_eq!(now["heads"][&project], 0);
    assert_eq!(now["events"], json!(org.state.count));
    assert!(send("GET", &heads_url, Some(&ben_token), "", b"").json()["heads"].as_object().unwrap().is_empty());
    let version = now["version"].as_u64().unwrap();
    let waiting = {
        let url = format!("{heads_url}?since={version}&wait=20");
        let token = token.clone();
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            (send("GET", &url, Some(&token), "", b"").json(), started.elapsed())
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(org.append(&token, &project, &entry(&org.id, &project, &owner.seed, 1, 1, &random_bytes(64))).status, 201);
    let (woken, elapsed) = waiting.join().unwrap();
    assert_eq!(woken["heads"][&project], 1);
    assert!(elapsed < std::time::Duration::from_secs(10), "{elapsed:?}");
    // Without a change, the poll returns after its wait.
    let version = woken["version"].as_u64().unwrap();
    let started = std::time::Instant::now();
    send("GET", &format!("{heads_url}?since={version}&wait=1"), Some(&token), "", b"");
    assert!(started.elapsed() >= std::time::Duration::from_millis(900));
}

#[test]
fn a_member_cannot_overwrite_or_hide_someone_elses_key() {
    // Review M2: wraps are kept per sender, and a recipient can report one that does not open.
    let env = env();
    let client = env.client();
    let mut org = Org::create(&env, "alice");
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let project = org.create_project(&token, &owner);
    let (mallory, ben) = (Device::new(), Device::new());
    org.admit(&client, "mallory", &mallory);
    org.admit(&client, "ben", &ben);
    for person in [org.person(&mallory), org.person(&ben)] {
        assert_eq!(org.post(Some(&token), "project.grant", json!({"project":project,"person":person,"role":"viewer"}), &owner.seed).status, 201);
    }
    let mallory_token = org.token(&mallory.seed);
    let ben_token = org.token(&ben.seed);
    let key = random_bytes(32);
    // Mallory races to plant a wrong key for Ben; the owner's good wrap still lands beside it.
    assert_eq!(org.put_wraps(&mallory_token, &[real_wrap(&org, &project, 1, &ben.agreement, &mallory, &random_bytes(32))]).status, 204);
    assert_eq!(org.put_wraps(&token, &[real_wrap(&org, &project, 1, &ben.agreement, &owner, &key)]).status, 204);
    let for_ben: Vec<Wrap> = org.wraps(&ben_token).iter().map(|w| serde_json::from_str(w).unwrap()).filter(|w: &Wrap| w.project == project).collect();
    assert_eq!(for_ben.len(), 2);
    assert!(for_ben.iter().any(|w| w.sender == owner.key));
    // Ben reports Mallory's wrap; it is gone, and only Ben's own wraps can be reported away.
    let report = |token: &str, sender: &str| send("POST", &org.url(&format!("/v1/orgs/{}/keys/report", org.id)), Some(token), "application/json", json!({"project":project,"epoch":1,"sender":sender}).to_string().as_bytes()).status;
    assert_eq!(report(&mallory_token, &owner.key), 204);
    assert!(org.wraps(&ben_token).iter().any(|w| w.contains(&owner.key)));
    assert_eq!(report(&ben_token, &mallory.key), 204);
    let left: Vec<Wrap> = org.wraps(&ben_token).iter().map(|w| serde_json::from_str(w).unwrap()).filter(|w: &Wrap| w.project == project).collect();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].sender, owner.key);
}

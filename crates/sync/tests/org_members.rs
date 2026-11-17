//! Organisations with an encryption mode, invitations, roles, removal, project grants and
//! pending wraps, through the real binary against real PostgreSQL.
mod support;
use scribyra_core::orgsync::{self as core, Wrap};
use serde_json::json;
use support::{orgs::*, *};

fn real_wrap(org: &Org, project: &str, epoch: u32, recipient: &str, sender: &Device, key: &[u8]) -> String {
    let mut wrap = Wrap { v: 1, org: org.id.clone(), project: project.into(), epoch, recipient: recipient.into(), enc: String::new(), nonce: String::new(), ct: String::new(), sender: sender.key.clone(), sig: String::new() };
    let nonce: [u8; 24] = random_bytes(24).try_into().unwrap();
    core::seal_wrap(&mut wrap, &random_bytes(32), &nonce, key).unwrap();
    let mut value = serde_json::to_value(&wrap).unwrap();
    value.as_object_mut().unwrap().remove("sig");
    value["sig"] = json!(sender.sign(&core::wrap_signing_message(&value).unwrap()));
    core::canonical(&value).unwrap()
}

#[test]
fn managed_orgs_let_the_service_open_project_keys_and_e2ee_orgs_do_not() {
    let dir = temp_dir("scribyra-master-");
    let master: [u8; 32] = random_bytes(32).try_into().unwrap();
    std::fs::write(dir.join("master.key"), master).unwrap();
    let s = Service::new(org_overrides(json!({"service_key_file": dir.join("master.key")})));
    let mut managed = Org::create(&s, &[], json!({"mode": "managed"}));
    assert_eq!(managed.state.mode.as_deref(), Some("managed"));
    let info = send("GET", &managed.url(&format!("/v1/orgs/{}/info", managed.id)), None, "", b"").json();
    assert_eq!(info["genesis"], true);
    assert_eq!(info["serviceKey"].as_str(), managed.state.service_key.as_deref());
    // The owner's app wraps every project key to the service key as well.
    let owner = managed.owner.clone();
    let token = managed.token(&owner.seed);
    let project = managed.create_project(&token, &owner);
    let project_key = random_bytes(32);
    let service_key = managed.state.service_key.clone().unwrap();
    let wraps = vec![real_wrap(&managed, &project, 1, &owner.agreement, &owner, &project_key), real_wrap(&managed, &project, 1, &service_key, &owner, &project_key)];
    assert_eq!(managed.put_wraps(&token, &wraps).status, 204);
    // The service can open it: its org key is sealed under the operator's master key file.
    let sealed = postgres().psql(s.database_url(), &format!("SELECT encode(service_key_sealed, 'hex') FROM orgs WHERE org = '{}'", managed.id));
    let secret = scribyra_sync::org::unseal_service_key(&master, &managed.id, &core::unhex(&sealed, sealed.len() / 2).unwrap()).unwrap();
    let raw = postgres().psql(s.database_url(), &format!("SELECT raw FROM wraps WHERE recipient = '{service_key}'"));
    let wrap: Wrap = serde_json::from_str(&raw).unwrap();
    assert_eq!(core::open_wrap(&wrap, &secret).unwrap(), project_key);
    // An end-to-end encrypted org on the same service refuses wraps to its service key.
    let mut e2ee = Org::create(&s, &[], json!({}));
    assert_eq!(e2ee.state.service_key, None);
    let owner = e2ee.owner.clone();
    let token = e2ee.token(&owner.seed);
    let project = e2ee.create_project(&token, &owner);
    let stored: String = postgres().psql(s.database_url(), &format!("SELECT service_key FROM orgs WHERE org = '{}'", e2ee.id));
    assert_eq!(e2ee.put_wraps(&token, &[real_wrap(&e2ee, &project, 1, &stored, &owner, &project_key)]).status, 400);
    // A genesis that names some other key as the service key is refused.
    let (code, out) = s.run(&["org", "create", "--label", "x"]);
    assert_eq!(code, 0);
    let _ = out;
    let bogus = std::panic::catch_unwind(|| Org::create(&s, &[], json!({"mode":"managed","serviceKey": core::hex(&core::x25519_public(&random_bytes(32)).unwrap())})));
    assert!(bogus.is_err());
    // Without a master key file the service offers no managed mode at all.
    let plain = Service::new(org_overrides(json!({})));
    let refused = std::panic::catch_unwind(|| Org::create(&plain, &[], json!({"mode":"managed","serviceKey": core::hex(&core::x25519_public(&random_bytes(32)).unwrap())})));
    assert!(refused.is_err());
}

#[test]
fn invitations_roles_and_removal_are_enforced_by_the_service() {
    let s = Service::new(org_overrides(json!({"requests_per_second": 100000, "source_requests_per_second": 100000})));
    let mut org = Org::create(&s, &[], json!({}));
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    // A plain invitation: the join needs no session, and the new device can sign in at once.
    let (reply, invite, seed) = org.invite(&token, &owner, json!({}));
    assert_eq!(reply.status, 201);
    let ben = Device::new();
    let forged = Device::new();
    let mut body = org.join_body(&forged, &invite, &random_bytes(32));
    body["name"] = json!(random_hex(60));
    assert_eq!(org.post(None, "person.join", body, &forged.seed).status, 400);
    assert_eq!(org.join(&ben, &invite, &seed).status, 201);
    let ben_token = org.token(&ben.seed);
    // Single use.
    assert_ne!(org.join(&Device::new(), &invite, &seed).status, 201);
    // With approval the person cannot sign in until an admin approves.
    let (_, invite, seed) = org.invite(&token, &owner, json!({"approval": true}));
    let cat = Device::new();
    assert_eq!(org.join(&cat, &invite, &seed).status, 201);
    assert_eq!(org.sign_in_with(&cat.seed, json!({})).status, 403);
    // A member cannot approve, invite admins, or invite to projects that are not theirs.
    let cat_person = org.person(&cat);
    assert_eq!(org.post(Some(&ben_token), "person.approve", json!({"person":cat_person,"role":"member"}), &ben.seed).status, 400);
    assert_eq!(org.invite(&ben_token, &ben, json!({"role":"admin","approval":true})).0.status, 400);
    assert_eq!(org.post(Some(&token), "person.approve", json!({"person":cat_person,"role":"member"}), &owner.seed).status, 201);
    let cat_token = org.token(&cat.seed);
    // Expired invitations are refused by the service's clock.
    let (_, invite, seed) = org.invite(&token, &owner, json!({"expires": 1000}));
    assert_eq!(org.join(&Device::new(), &invite, &seed).status, 410);
    // Invitations bound to SSO, and join requests, need single sign-on.
    let (_, invite, seed) = org.invite(&token, &owner, json!({"sso": true}));
    assert_eq!(org.join(&Device::new(), &invite, &seed).status, 403);
    let dan = Device::new();
    let person = org.person(&dan);
    let proof = dan.sign(&core::device_proof_message(&org.id, &org.state.head, &person, &dan.key, &dan.agreement));
    assert_eq!(org.post(None, "person.request", json!({"person":person,"device":dan.key,"agreement":dan.agreement,"proof":proof,"name":random_hex(60)}), &dan.seed).status, 403);
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
    let s = Service::new(org_overrides(json!({})));
    let mut org = Org::create(&s, &[], json!({}));
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
    let (_, invite, seed) = org.invite(&token, &owner, json!({}));
    let ben = Device::new();
    assert_eq!(org.join(&ben, &invite, &seed).status, 201);
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
fn a_device_link_adds_one_device_for_the_same_person() {
    let s = Service::new(org_overrides(json!({})));
    let mut org = Org::create(&s, &[], json!({}));
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let person = org.owner_person.clone();
    let (link, link_seed) = (random_hex(16), random_bytes(32));
    let link_key = core::hex(&core::ed25519_public(&link_seed).unwrap());
    let url = org.url(&format!("/v1/orgs/{}/device-links", org.id));
    assert_eq!(send("POST", &url, Some(&token), "application/json", json!({"link":link,"key":link_key}).to_string().as_bytes()).status, 201);
    let laptop = Device::new();
    let request = |device: &Device, signer: &[u8]| {
        let sig = core::hex(&core::ed25519_sign(signer, &core::device_request_message(&org.id, &link, &person, &device.key, &device.agreement)).unwrap());
        let proof = device.sign(&core::device_proof_message(&org.id, &core::link_binding(&link), &person, &device.key, &device.agreement));
        send("POST", &format!("{url}/{link}"), None, "application/json", json!({"device":device.key,"agreement":device.agreement,"proof":proof,"sig":sig}).to_string().as_bytes()).status
    };
    // Only the link key's holder can answer, and only once.
    assert_eq!(request(&laptop, &random_bytes(32)), 403);
    assert_eq!(request(&laptop, &link_seed), 202);
    assert_eq!(request(&Device::new(), &link_seed), 404);
    let listed = send("GET", &url, Some(&token), "", b"").json();
    assert_eq!(listed["links"][0]["request"]["device"], json!(laptop.key));
    // The new device cannot sign in until the existing one signs device.add with the link.
    assert_eq!(org.sign_in_with(&laptop.seed, json!({})).status, 403);
    let request = &listed["links"][0]["request"];
    let body = json!({"person":person,"device":request["device"],"agreement":request["agreement"],"proof":request["proof"],"link":link});
    assert_eq!(org.post(Some(&token), "device.add", body.clone(), &owner.seed).status, 201);
    assert_eq!(org.sign_in_with(&laptop.seed, json!({})).status, 200);
    assert_eq!(send("GET", &url, Some(&token), "", b"").json()["links"], json!([]));
    // A link cannot be replayed for another device.
    assert_eq!(org.post(Some(&token), "device.add", body, &owner.seed).status, 400);
    // Removing the device closes its sessions.
    let laptop_token = org.token(&laptop.seed);
    assert_eq!(org.post(Some(&token), "device.remove", json!({"device":laptop.key}), &owner.seed).status, 201);
    assert_eq!(send("GET", &org.url(&format!("/v1/orgs/{}/events", org.id)), Some(&laptop_token), "", b"").status, 401);
}

#[test]
fn the_heads_notice_wakes_on_changes_and_shows_only_readable_projects() {
    let s = Service::new(org_overrides(json!({})));
    let mut org = Org::create(&s, &[], json!({}));
    let owner = org.owner.clone();
    let token = org.token(&owner.seed);
    let project = org.create_project(&token, &owner);
    let (_, invite, seed) = org.invite(&token, &owner, json!({}));
    let ben = Device::new();
    assert_eq!(org.join(&ben, &invite, &seed).status, 201);
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

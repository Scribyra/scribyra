# Organisations, sync and encrypted storage (milestones 10 and 11)

Design, 9 November 2026, revised 10 November 2026 with Paul's decisions ([section 9](#9-decisions-paul-10-november-2026)) and 17 November 2026 with his new requirements: SSO as a first-class sign-in path, inviting people with roles, device sync, and a discussion of online compile ([section 10](#10-online-compile-options-for-discussion-17-november-2026)). Written at Paul's request: "I also want the sync/storage server to be worked upon in parallel, so maybe orgs could collaborate and store, sync internal projects and etc." Implementation is on branch `feature/org-sync-v2` (GitHub); section 8 says which slices are delivered. It turns the outlines of milestones [10 and 11](roadmap.md#milestones-10-and-11-scope) into one design that engineers can build slice by slice. It extends the [service](service-design.md) from milestone S and reuses the replication layer, identities and provenance from [milestone D](direct-sessions-design.md) (merged to main).

Four rules from earlier decisions frame everything below:

1. **Browser storage is the source of truth for each person.** The service is a durable, shared copy. It is never needed to open, edit, compile or back up a project alone, and turning it off leaves every local project usable.
2. **The service never interprets project content** (S1) in end-to-end encrypted organisations. It stores and relays opaque bytes, assigns sequence numbers and enforces access and quotas. Clients merge, validate, compact and encrypt. Organisation-managed mode (section 3) is the one deliberate exception, chosen by the org's owner and shown to every member.
3. **One binary, every feature free when self-hosted.** Paid hosting runs the same service with accounts and billing added around it, never inside the product's capabilities.
4. **Off means off** (D, 8 November). A browser that never connects to a service creates no keys, opens no extra databases and writes nothing new into projects.

## Summary

An **organisation** is a group of people on one service. Each person has one or more **devices** (browser profiles), each with its own signing and key-agreement keys. Who belongs to the org, with which role, and who may open which project is recorded in a **membership log**: a hash-chained list of events, each signed by a member's device. The server and every client replay this log with the same Rust code and reach the same answer.

Each project has an **append-only update log** on the service. Clients upload encrypted Yjs updates and receive server-assigned sequence numbers once the bytes are durable. Other clients catch up from their last cursor, decrypt, verify the author's signature and role, and run the incoming update through the same validation pipeline as D and local tabs before merging it. Assets and history objects are encrypted blobs. Editor clients periodically write encrypted snapshots so the server can drop old log entries.

People sign in to the service with their device keys and, in organisations that use it, with the organisation's own identity provider (OIDC single sign-on). They join through invitation links or, with SSO, by asking an admin to approve them, and a person's devices stay in sync through the service. Content is always encrypted by the clients with a per-project key per **epoch**, wrapped to every member device. Each organisation has an **encryption mode**, chosen by its owner at creation and shown on every project: **End-to-end encrypted** (only member devices hold keys; the service stores ciphertext) or **Organisation-managed** (the service also holds the keys, so it and authorised admins can read, which enables later server-side features such as search). Personal backups are end-to-end encrypted by default. A second org setting, **admin read access** (default on), decides whether org admins can read every org project. Removing someone starts a new epoch. Recovery after losing every device comes from a personal recovery code, from any other member re-sharing the key, or, if the org opts in, from an org recovery key that every member can see is in place.

In an end-to-end encrypted org the operator sees who is in which org and project, sizes, timing and the shape of the logs, but not names, text, comments, assets or history.

## 1. Organisations and people

### Entities

| Entity | Identifier | Visible to operator | Notes |
| --- | --- | --- | --- |
| Organisation | `org`: random 32 bytes, hex | Yes | One tenant. A self-hosted service may hold several. |
| Person | `person`: UUID v8 derived from the person's first device key and the org | Yes | Same derivation family as D's `identityAuthorId`, so author IDs in projects stay key-derived. |
| Device | Ed25519 signing public key (32 bytes) plus X25519 agreement public key | Yes | One per browser profile. D's existing per-profile Ed25519 key *is* the device signing key. |
| Team | `team`: random 16 bytes | ID and membership yes, name no | Includes the built-in team `everyone`. |
| Project | `project`: random 32 bytes; the project's `lineageId` stays inside the encrypted content | ID, sizes and grants yes; name no | |
| Display names, team names, project names | Encrypted | No | Encrypted under the org directory key or the project key. |

Display names are not identity. A person is the set of devices certified for them in the membership log. Two people may share a display name; the app shows a short key fingerprint when names collide, as D does for unpinned contacts.

### Roles

Org roles control administration. Project roles control content. They are independent: an org admin is not automatically a project editor.

| Org role | Can do | Cannot do |
| --- | --- | --- |
| Owner | Everything an admin can; choose and change the org's encryption mode and admin read access; transfer ownership; delete the org; set or remove the org recovery key; change quotas within what the operator allows. At least one owner always exists. | Read a project they are not a member of, unless admin read access is on, the org is organisation-managed, or the org recovery key covers that project and they hold it. |
| Admin | Invite and remove people; approve devices; create and edit teams; delete or archive any project; see every project's size, member list and activity times; propose grants. With admin read access on (the default), read every org project. | Edit content without an editor grant. With admin read access off: read content, or give themselves access without a project editor's approval (see below). |
| Member | Create projects; see projects listed in the org directory; be granted projects. | Administer others. |

| Project role | App modes allowed | Rights from the [annotations contract](annotations-design.md#authors-origins-and-rights) | Log entries the role may write |
| --- | --- | --- | --- |
| Editor | Editing, Reviewing, Viewing | read, edit, comment, review, export, history | Any update; snapshots; epoch changes; grants up to editor |
| Reviewer | Reviewing, Viewing | read, comment, review, export | Updates touching only discussion and review roots (section 2) |
| Viewer | Viewing | read, comment, export | Updates touching only comment roots; a grant can set `comment: false` for a read-only viewer |

Editing, Reviewing and Viewing stay device preferences, as in the [review workspace amendment](annotations-design.md#review-workspace-amendment--6-november-2026). The project role only limits which modes the app offers. Anyone who can read can copy, so "export" cannot really be withheld from a reader; the app does not pretend otherwise.

Review **acceptance authority** stays as it is: one person per review decides, other people send decision requests. With the service those requests become durable log entries (section 2), so an authority who is offline sees them later. D's in-memory request queue remains for live sessions.

### Teams

Teams are justified because they make membership changes cheap: a project shared with a team wraps its key once to the team key instead of to every member device. The org gets one built-in team, `everyone`, which is how "internal projects visible to the whole org" are expressed. Teams are flat (no nesting) to keep authorisation decidable by a simple replay. Teams arrive in a later slice; the first org slices share with people directly.

### Admin read access

**Admin read access** is an org setting (`org.policy {adminRead}`), default **on** and chosen by the owner at creation. Every member sees it on every project: "Acme's administrators can read this project."

- **On, end-to-end encrypted org:** every project key epoch is also wrapped to each admin's and owner's devices, exactly like a viewer who cannot write. Member clients do this automatically when they create a project or a new epoch, and when someone becomes an admin. The project's member list shows the admins as "can read (administrator)".
- **On, organisation-managed org:** admins read through keys the service already holds; the service wraps project keys to admin devices on request after checking the role in the membership log.
- **Turning it off:** the owner signs `org.policy {adminRead: false}`. Every project moves to a new epoch that is not wrapped to admins (unless they hold an explicit grant), and the service deletes admin wraps for future epochs. The app states plainly: "Administrators could read everything in these projects up to now, and may have kept copies. From now on they cannot read new changes." Turning it back on wraps current epochs to admins again and is announced the same way.

### Admin grants need a member's approval (admin read access off)

With admin read access off, under end-to-end encryption, an admin who adds themselves to a project still has no key until somebody who holds it wraps it for them. Editor clients wrap keys automatically for grants signed by a **project editor**. A grant signed only by an admin who is not an editor appears to the project's editors as "Ana (admin) asked to join as viewer — Approve / Decline". In such orgs this is what makes "admins cannot read content" true rather than a policy. The org recovery key, if enabled, is the explicit exception and is visible on every project it covers.

### The membership log

One log per org, stored in plaintext structure on the server (the server must enforce access), with names encrypted. Each event:

```json
{
  "v": 1,
  "org": "64 hex",
  "prev": "64 hex SHA-256 of the previous event, or the org id for genesis",
  "type": "project.grant",
  "body": {"project": "64 hex", "subject": {"person": "uuid"}, "role": "reviewer", "comment": true},
  "signer": "64 hex Ed25519 device key",
  "sig": "128 hex"
}
```

The signature covers the canonical JSON of every field except `sig`, with domain `scribyra-org-event/1`. Event types:

| Group | Types |
| --- | --- |
| Org | `genesis`, `org.rename` (encrypted name), `org.recovery.set`, `org.recovery.clear`, `directory.epoch` |
| People | `invite.create`, `invite.revoke`, `person.join`, `person.request` (join through SSO), `person.approve`, `person.role`, `person.remove` (also leaving, signed by the person) |
| Devices | `device.add`, `device.remove`, `recovery.set` (a person's recovery key) |
| Teams | `team.create`, `team.rename`, `team.add`, `team.remove`, `team.epoch`, `team.delete` |
| Projects | `project.create`, `project.list` / `project.unlist` (directory entry), `project.grant`, `project.revoke`, `project.epoch`, `project.schema`, `project.delete` |

The rules (who may sign what, when an event is valid, what each person's role is after event *n*) live in one new Rust module, `crates/core/src/membership.rs`, compiled into the service and into the browser's WASM. The server applies it before appending; clients apply it again on every event they receive. The server serialises appends: a client posts an event whose `prev` must equal the current head, or receives `409` and rebases. The log is small (thousands of events for a large org) and clients cache it.

Clients pin the genesis hash when they join (it is in the invitation link). A server that rewrites the log's history cannot produce a valid chain from the pinned genesis without the owner's key. A server can still show different clients different valid tails (a fork); see section 7.

### Devices and identity

A device is a browser profile. On first connection to a service (or when D is turned on, as today) the app creates, inside a Web Lock:

- the Ed25519 signing key (non-extractable, as D's `newIdentity` already does), and
- an X25519 agreement key (non-extractable; WebCrypto X25519 is available in current Chromium, Firefox and Safari).

The **first** device of a person defines the person ID. Later devices are added by a `device.add` event signed by an existing device of the same person (linking) or by an admin (re-enrolment after loss). Linking works like pairing a phone: the new device shows a QR code or a 12-character code with its public keys; the existing device scans or types it, shows a comparison code (D's `comparisonCode`), and signs.

Project records authored under a person's ID may be signed by any device certified for that person at that point in the log. This extends D's provenance check (`signer` in `web/direct-provenance.js`) from "the key that derives this author ID" to "a device the org log certifies for this person". D's claims (`directClaim:`) still bind earlier random author IDs to the person.

### How people authenticate to the service

Two separate questions: *who may fetch and append ciphertext* (server authentication) and *who holds keys* (cryptographic membership). Server authentication protects availability and metadata; it never grants content access by itself in an end-to-end encrypted org.

| Option | How it works | Fits | Weakness |
| --- | --- | --- | --- |
| **A. Invite links and device keys** | The service issues a challenge; the device signs it with its Ed25519 key; the service checks the device is active in the org log and returns a 12-hour session token (hash stored, token held in memory by the app). New people arrive through single-use invite links. | Every install, including one person on a home server. No email, password or identity provider. | A lost device plus no other device means the recovery kit or admin re-enrolment. A leaked unused invite link lets someone join (mitigated by expiry, approval and SSO binding). |
| **B. Service-local accounts with passkeys** | A person registers WebAuthn passkeys with the service. A passkey login lets them enrol a new device without an existing one, subject to the org's approval rule. With the WebAuthn PRF extension, the passkey can also unwrap the person's recovery key (section 3). | People with synced platform passkeys; self-recovery. | Passkey sync is platform-specific; PRF support varies by browser and authenticator. |
| **C. OIDC / SSO** | The service is an OIDC relying party for the org's identity provider. A person signs in with the org's IdP; the service links that identity to their person in the org log, requires it (if the org says so) before any device session, and blocks the person as soon as the IdP disables them. | Companies and universities with Entra ID, Google Workspace, Okta, Keycloak and similar. | The IdP and the service can let someone in, but in an end-to-end encrypted org they cannot give them keys; key revocation still needs an admin's client to sign. |

**Sequence, revised (Paul, 17 November 2026): A and C together, then B.** The 10 November order (A, then B, then C) put SSO last. Paul now requires SSO as a first-class sign-in path for organisations, so C moves up beside A: organisations get invite links, device keys and OIDC in the same early slices, and passkeys (B) follow. Passwords are still never stored. The existing S bearer principals stay for operator-provisioned relay and object namespaces; an org session resolves to the same internal principal, rights and quota boundary, as S1 required.

**Bootstrap.** The operator creates an org from the command line: `scribyra-sync org create --label lab` prints a single-use **setup code** (service address, org ID and a 256-bit secret) and stores only the Ed25519 public key derived from the secret. The owner pastes the setup code into the app's **Create organisation** dialog, chooses the org's name, its encryption mode and admin read access, and the app signs the org's `genesis` event with the device key and with the key derived from the secret; the first valid genesis consumes the code. The genesis records the encryption mode, admin read access, the org name encrypted under the directory key, and (managed mode only) the service's org key. A personal backup is the same thing with one person: name "Personal", end-to-end encrypted. Paid hosting replaces the CLI step with a sign-up page (section 6).

### Single sign-on with OIDC (added 17 November 2026)

**Roles of the parties.** The *service* is the OIDC relying party, as a confidential client using the authorization code flow with PKCE and a nonce. The *app* never sees the identity provider's tokens: the service exchanges the code, verifies the ID token, keeps any refresh token, and hands the app a short-lived one-time code that only the browser which started the sign-in can redeem. This keeps the client secret and refresh tokens off the static host and out of browsers, works the same for self-hosting and paid hosting, and lets the service notice when the IdP disables someone.

**Configuration.** Per organisation: issuer, client ID, client secret (read from a file, never a command-line argument), whether SSO is **required**, an optional email domain, an optional groups claim, the SSO session lifetime (default 12 hours) and the re-check interval (default 10 minutes). Self-hosted: `scribyra-sync org sso --org <id> --issuer … --client-id … --client-secret-file … [--required]`, with the redirect URI `https://<service>/v1/sso/callback` registered at the IdP. The issuer must use https (plain http only on loopback, for tests), and the discovery document's `issuer` must match it exactly. `GET /v1/orgs/{org}/sso` tells the app, without signing in, whether the org offers or requires SSO and which issuer, so it can show "Sign in with Acme".

**Sign-in flow.**

1. The app creates a random 32-byte verifier, keeps it in `sessionStorage`, and calls `POST /v1/sso/start {org, return: <app origin>, challenge: SHA-256(verifier)}`. `return` must be one of the service's allowed origins (the same list as CORS). The service answers with the IdP authorization URL; its `state` is single use for 10 minutes and bound to the org, the nonce, the PKCE verifier and the app challenge.
2. The app navigates there at top level (no pop-up: pop-ups and third-party storage are unreliable across Chromium, Firefox and WebKit). The person signs in at the IdP.
3. The IdP redirects to `/v1/sso/callback`. The service checks the state, exchanges the code (client secret plus PKCE verifier), and verifies the ID token: signature with a key from the IdP's JWKS selected by `kid` (RS256, ES256 or EdDSA only; `none` and HMAC algorithms refused; the algorithm must match the key type), `iss` exact, `aud` containing the client ID (and `azp` when there are several audiences), `exp`, `iat` within a small skew, `nonce`, and, when an email domain is configured, a verified email in that domain (plus the `hd` claim for Google Workspace).
4. The service redirects to `<app origin>/#scribyra-sso=<one-time code>`. The fragment never reaches the static host. The app removes it from the address bar and redeems it with `POST /v1/sso/redeem {code, verifier}`; a code without the verifier from step 1 is useless, so a leaked redirect cannot be replayed from another browser.
5. The answer is an **SSO login**: an opaque token (the service stores its hash), its expiry, the IdP's email, name and groups, and the person it is linked to in this org, if any.

**Account linking to device keys.** An org person is still defined by device keys in the signed membership log; the IdP identity is an attribute the service attaches to that person. The service keeps one link per `(org, issuer, subject)` and at most one subject per person. Links are made:

- when a person joins through an invitation while signed in with the org's IdP (the usual path once SSO is configured);
- when a person asks to join through SSO alone (below);
- for people who joined before SSO was configured: the first device sign-in that presents both a valid device signature and an unlinked SSO login links them (trust on first use, visible to admins, who can reset a link).

The link is not written into the membership log: clients cannot verify an IdP's statement, and the log would only repeat what the service asserts. Admins see each member's linked IdP identity in the members list.

**How an SSO identity maps to org membership.**

- **Invitations bound to SSO.** An invitation can require SSO (`sso: true`) and optionally a specific verified email (`emailHash`, the SHA-256 of the lower-cased address, so the log does not carry the address). The service redeems such an invitation only with a matching SSO login. The invitation secret is still needed, so the service alone cannot use the invitation to admit someone in an end-to-end encrypted org.
- **Join requests through SSO.** Someone who signs in with the org's IdP and has no link can ask to join without an invitation: their new device signs `person.request {person, device, agreement, proof, name}` and the service accepts it only with a valid, unlinked SSO login. The person is **pending**: no role, no session, no keys. An admin's app shows "Ben (ben@acme.org, via Acme SSO) asks to join" with Approve as member / Approve as admin / Decline; approval is an admin-signed `person.approve`. The service cannot approve anyone by itself, so an operator or IdP that invents a person still gets no keys.
- **Groups and roles (optional).** With a groups claim configured, the service can restrict who may request to join (allowed groups) and suggest a role from a mapping (for example `scribyra-admins` → admin). Suggestions only fill the approval dialog; an admin's device still signs. Automatic approval by group, signed by an admin's client on the admin's behalf, is a later option and would itself be an owner-signed org policy.

**Device sessions in SSO orgs.** When an org *requires* SSO, `POST /v1/auth/session` needs, besides the device signature, a live SSO login linked to the device's person (recovery-key sign-in too, so a stolen recovery kit alone is not enough in such orgs). Device sessions expire with the SSO login (at most 12 hours) and close as soon as it is revoked. When SSO is offered but not required, it is used for joining and device linking, and device keys alone keep working.

**Session lifetime.** The SSO login lasts the configured lifetime (default 12 hours). When the IdP issues a refresh token (Entra, Okta and Keycloak with `offline_access`; Google with offline access), the service re-checks it every re-check interval (default 10 minutes). When the login expires, the app shows "Sign in with Acme again"; with an active IdP session that is one redirect without typing.

**Logout and revocation.**

| Event | Effect |
| --- | --- |
| The person signs out in the app | `POST /v1/sso/logout` revokes the SSO login and the device sessions that depend on it. Local projects stay; nothing syncs until they sign in again. |
| The IdP disables the person | The next re-check gets `invalid_grant`: the service revokes their logins, marks the link **blocked**, closes their device sessions and refuses new ones. Admins see "Ana was disabled at Acme's identity provider — Remove from Acme", which signs `person.remove` and starts new epochs for her projects (slice 6). |
| The IdP sends a back-channel logout | IdPs that support OpenID Connect Back-Channel Logout (Keycloak, among others) post a signed logout token; the service verifies it like an ID token and revokes at once instead of at the next re-check. |
| An admin removes the person | `person.remove` takes effect on the service immediately, whatever the IdP says. |

Blocking at the service stops new ciphertext from reaching a disabled person within one re-check interval. It does not revoke keys they already hold; that needs the admin-signed removal and rotation, as for any removal.

**Self-hosted and paid hosting.** Identical code. Self-hosters register the service at their IdP and configure the org with the CLI. Paid hosting lets org owners enter the same settings in the account front end (section 6); one redirect URI serves every org because the state names the org. SAML is not planned; a SAML-only IdP can be bridged through Keycloak or Dex.

**Which identity providers are tested.**

| IdP | Tested how | Notes |
| --- | --- | --- |
| Local test IdP (in the repository, `crates/sync/examples/test-idp.rs`) | Every service test and the browser tests in Chromium, Firefox and WebKit | Discovery, JWKS with key rotation, authorization code with PKCE, refresh tokens, disabling a user, and fault injection (bad signature, wrong audience, issuer or nonce, expired token, `alg: none`, HMAC confusion with the RSA key, unknown `kid`). |
| Dex or Keycloak from nixpkgs | Interoperability smoke test, when practical | Proves the relying party against a real implementation. |
| Microsoft Entra ID | Manual checklist | Use the tenant-specific issuer `https://login.microsoftonline.com/<tenant>/v2.0`, never `common`; request `offline_access` for refresh tokens; `email` can be missing or unverified, so prefer restricting by tenant; large group memberships overflow the groups claim (use app roles). |
| Google Workspace | Manual checklist | Issuer `https://accounts.google.com`; restrict by the `hd` claim, not only the email domain; there is no groups claim. |
| Okta | Manual checklist | Use a custom authorization server issuer; the groups claim is configured in that server. |
| Keycloak | Manual checklist (and the nixpkgs smoke test) | Issuer `https://<host>/realms/<realm>`; groups through a mapper; supports back-channel logout. |

### Invitations, joining, removal

An admin creates an invitation in the app. The client generates a random 32-byte secret `s`, derives an Ed25519 invitation key from `HKDF(s, "scribyra/1/invite")`, and appends

```
invite.create {invite, inviteKey, role: "admin"|"member", expires, approval, sso, emailHash?, project?, projectRole?}
```

signed by an admin or owner device. A member who is not an admin may invite only to a project they edit, and their invitations always need approval. The link is

```
https://<app origin>/#join=<base64url(canonical {v, service, org, genesis, invite, secret, directoryKey})>
```

The fragment never reaches the app's static host. The service endpoint is explicit in the link; the app shows it, the org's name, its encryption mode and admin read access, and asks before connecting. The joiner's device creates its keys and signs `person.join {invite, person, device, agreement, proof, inviteSig, name}`: `proof` is the device key's possession proof bound to the log head, `inviteSig` is the invitation key's signature over the org, head, invite, person and keys, and `name` is the display name encrypted under the directory key carried in the link. The service accepts the event without a session (the invitation authenticates it, as the setup code does for genesis), checks expiry against its clock and, for SSO invitations, the SSO login. The first valid join consumes the invitation; `invite.revoke` withdraws one. If `approval` is set (always for admin invitations and for invitations made by members), the person is pending until an admin signs `person.approve`.

The directory key travels in the link so the joiner can read and write names. A leaked link therefore also reveals the org's member and project names to its holder; it is single use, expires (default 7 days), and directory epochs rotate on removal (slice 9).

**Roles and changes.** `person.role {person, role}` is signed by an admin (for member and admin roles) or an owner (for any role); the last owner cannot be demoted. `person.remove {person}` is signed by an admin, an owner (to remove an admin or owner), or the person themselves (leaving). Removal takes effect on the server immediately: their sessions close and their devices are refused. Their key access ends at the next project epoch, which remaining clients create before writing anything else (section 3). What they already downloaded stays with them; nothing can change that.

**Sharing a project.** `project.grant {project, person, role}` with role `editor`, `reviewer` or `viewer`, signed by a device of one of the project's editors (or of an admin under the rules of section 1), and `project.revoke {project, person}`. The role decides which app modes the project offers (Editing, Reviewing, Viewing), as in the role table above. The granting editor's app wraps the project key to the new member's devices and recovery key at once; if it is closed, any other editor's app does so through the pending-wraps route. Until the role scope check of section 2 is in place (slice 7), the service accepts log entries only from editors: reviewers and viewers can read and comment locally, and their comments reach others through `request` entries once that slice lands.

### Devices: linking and sync

A person's devices stay in sync through the service: each device uploads its own changes as log entries and merges every other device's entries, exactly as different people do. Linking a second device:

1. **From an existing device.** The existing device chooses **Link a device**: it creates a link secret, registers its public half with the service (`POST /v1/orgs/{org}/device-links`, valid 15 minutes) and shows a link (or QR code) carrying the service, org, genesis and secret. The new device opens it, creates its keys and posts a request signed by both its own key and the link key. The existing device shows the request with a comparison code derived from the link secret and the new keys; when the person confirms the same code on both screens, it signs `device.add` with a proof bound to that link (each link adds one device).
2. **With SSO.** The new device signs in with the org's IdP. Its request is authenticated by the person's SSO login instead of a link; any existing device of that person (or, in a managed org, the service itself — later slice) approves it after comparing codes.
3. **With the recovery kit**, as in slice 1, when no other device is available.

As soon as the new device is in the log, the person's other devices fulfil its **pending wraps**: `GET /v1/orgs/{org}/pending` lists the projects the caller can open whose current epoch lacks a wrap for some entitled key, and the caller's app wraps them. The new device then lists the org's projects it holds keys for (names are decrypted with each project's `K_name`) and downloads them on request, like a restore.

**Catch-up.** Each device keeps, per project, the verified cursor (sequence, chain, each device's last client sequence) and a **server vector**: the Yjs state vector of everything the service holds. On start, on reconnect, and whenever the service says a project moved, it reads entries after its cursor, verifies them as in section 2, decrypts and validates them on a copy of the project, merges them into the committed local project through the merged-head save path, and tells an open editor to merge the new head. It then uploads only what the server vector lacks, so another device's changes are never uploaded twice. `GET /v1/orgs/{org}/heads?wait=25` is a long poll that returns as soon as any project of the caller or the membership log moves; it is a notice only, and a missed notice is repaired by the next poll.

**Offline edits.** Both devices keep editing locally while offline (outbox entries wait). On reconnect each one first catches up, then uploads; text and tree changes merge through Yjs; concurrent binary changes become recovery projects; the final state is the same on both devices in whatever order they reconnect.

**Removing a device.** `device.remove {device}`, signed by another device of the same person or by an admin, closes the device's sessions at once and starts new epochs for the person's projects (slice 6); a removed device key can never be added again.

## 2. Sync protocol

### What moves, and how

| Data | Carried as | Notes |
| --- | --- | --- |
| Source text, file tree, settings, trash | Yjs updates in log entries | Same `Y.Doc` and schema as today. |
| Comments, replies, anchors, suggestions, reviews, discussion events, change records, version names | Yjs updates in log entries | They are roots in the same document. D's per-record proofs (`directProof:*`) travel inside it and survive export. |
| Decision requests to a review's authority | `request` log entries | Durable, so an absent authority sees them later. They never change source by themselves. |
| Assets | Encrypted blobs, plus a `blobref` log entry | Uploaded before the update that references them. |
| History checkpoint objects | Encrypted blobs, same as assets | Named versions stay restorable on a fresh device. |
| Cursors, selections, presence | Encrypted frames through the existing relay | Never stored. |
| Device preferences, drafts, provider credentials, private keys, local journals | Not sent | As in D and the backup format. |

### Routes

All routes stay under protocol major 1. `GET /v1` adds `"capabilities": ["objects", "relay", "orgs", "logs"]`; a client that needs `logs` and does not see it says the service is too old. Control bodies keep closed JSON schemas.

| Route | Purpose |
| --- | --- |
| `POST /v1/auth/challenge`, `POST /v1/auth/session` | Device-key login (option A); in orgs that require SSO the session request also carries an SSO login. |
| `GET /v1/orgs/{org}/sso`, `POST /v1/sso/start`, `GET /v1/sso/callback`, `POST /v1/sso/redeem`, `GET /v1/sso/me`, `POST /v1/sso/logout`, `POST /v1/sso/backchannel` | OIDC single sign-on (option C). |
| `GET /v1/orgs/{org}/info` | Unauthenticated: whether the org has a genesis, and the service's org key for managed mode. |
| `POST /v1/orgs/{org}/device-links`, `POST /v1/orgs/{org}/device-links/{link}`, `GET /v1/orgs/{org}/device-links` | Linking a new device to a person. |
| `GET /v1/orgs/{org}/heads?wait=25` | Long-poll notice that a project or the membership log moved. |
| `GET /v1/orgs/{org}/events?after=n`, `POST /v1/orgs/{org}/events` | Read and append membership events. |
| `GET /v1/orgs/{org}/keys?device=…`, `PUT /v1/orgs/{org}/keys` | Key wraps addressed to a device; publish wraps (section 3). |
| `GET /v1/orgs/{org}/pending` | Grants and devices still lacking wraps that this device could fulfil. |
| `POST /v1/projects/{project}/log` | Append one entry. |
| `GET /v1/projects/{project}/log?after=n&limit=k` | Catch up. |
| `PUT/GET/HEAD /v1/objects/{namespace}/{hash}` | Existing immutable objects; the namespace is the project ID, authorised by membership. |
| `GET /v1/live` (WebSocket) | One per device: subscribe to projects, receive new entries and membership events. |
| `GET /v1/connect` (WebSocket) | Existing relay, now also accepting org sessions, for awareness. |
| `DELETE /v1/projects/{project}` | Requires a signed `project.delete` already in the membership log. |

### The log entry

The wire body of `POST …/log` is binary: a 4-byte big-endian header length, the header as canonical JSON, then the ciphertext.

```json
{
  "v": 1,
  "project": "64 hex",
  "device": "64 hex Ed25519 key",
  "clientSeq": 418,
  "kind": "update",
  "epoch": 3,
  "object": null,
  "refs": null,
  "sig": "128 hex"
}
```

- `kind` is one of `update`, `snapshot`, `verify` (an editor confirming a snapshot), `blobref`, `request`. The server needs to see `snapshot` and `verify` for compaction; the other kinds could be hidden later at a small cost.
- `epoch` must be the project's current epoch in the membership log. The server refuses new appends under a superseded epoch (`409 epoch`), except idempotent repeats of entries it already holds.
- `object` is set when the ciphertext is too large to inline (over 1 MiB): the body is then empty and `object` names an already uploaded ciphertext object.
- `refs` is set only on snapshots: the list of ciphertext object hashes still in use (section 4).
- `sig` is the device's Ed25519 signature, domain `scribyra-log/1`, over the header without `sig` and the SHA-256 of the ciphertext. The server verifies it and that the device may write to this project; clients verify it again.

The ciphertext is `nonce (24 bytes) ‖ XChaCha20-Poly1305(K_update[epoch], nonce, plaintext, AD)`. The associated data is the header without `sig`. This is the suite `core::exchange` reserved, and the header carries the same fields as its `Envelope` and `Ciphertext` payload: `project`, `device`, `clientSeq` (the envelope's `sequence`, widened from u32 to u64), `epoch` (`keyEpoch`) and the nonce. The plaintext:

```json
{"domain": "scribyra-entry", "version": 1, "lineage": "uuid", "schema": 8,
 "person": "uuid", "payload": "<binary Yjs update, or blobref/request body>"}
```

Encoded as deterministic CBOR so the binary payload needs no hex expansion; D's hex-in-JSON framing doubles sizes and is kept only for D.

### Sequence numbers and durable acknowledgement

- The server assigns `seq`, a per-project u64 starting at 1 with no gaps, inside the same SQLite transaction that records the entry. Inline ciphertext is written to the blob directory with S's discipline (temporary file, fsync, rename, directory fsync) before the transaction commits.
- It also computes `chain[seq] = SHA-256("scribyra-log-chain/1" ‖ chain[seq-1] ‖ SHA-256(header ‖ ciphertext))`, with `chain[0]` the project ID.
- The response `201 {"seq": n, "chain": "…"}` is sent only after commit. That is the durable acknowledgement. Nothing else (a WebSocket send, a relay broadcast, a compile) counts as one.
- `clientSeq` is per device and project and must be exactly the last accepted value plus one, as the exchange contract requires. The client builds each entry, stores it in an IndexedDB **outbox** with its `clientSeq`, and only then sends it. After a crash or timeout it resends the same bytes. The server answers a repeat of the same `(device, clientSeq, entry hash)` with `200` and the original `seq`. The same `clientSeq` with different bytes is `409` and the client stops and reports a fault; it never reuses a number.
- Other errors: `401/403` (session or membership), `413` (size), `507` (quota), `429/503` (load). None leaves a partial entry. The outbox keeps the entry and the status explains why it is waiting.

### Uploading local changes

The client keeps a **server vector**: the Yjs state vector of everything it has seen in the log plus its own acknowledged entries. After each local save (the existing merged-head save path), and at most every two seconds while typing, it encodes

```
Y.encodeStateAsUpdate(doc, target)
```

where `target` is the server vector with every *other* client ID's clock set to the local clock. That sends only structs from this device's own Yjs client IDs, plus delete sets, which are idempotent. Edits this device received through a D session are uploaded by their own authors, not duplicated. The device records its Yjs client IDs in IndexedDB so a new tab's client ID is still "its own".

Before an update that references a new asset or checkpoint object, the client uploads the encrypted blob and a `blobref` entry. Updates larger than the inline limit go as an object; a single update above the 96 MiB `MAX_RETAINED_BYTES` bound is refused locally with a message, as D does.

### Catching up and live delivery

On connect the client fetches membership events after its cursor, then for each project `GET …/log?after=cursor`. It verifies that each entry's `chain` follows from the stored `(cursor, chain)` pair. A break means the server changed history; the client stops syncing that project and says so.

If the cursor is below the project's compaction floor the server answers `410` with the latest snapshot's `seq`. The client fetches that snapshot entry and the entries after it. It does not discard its local state: it merges the snapshot into its document like any other update, then uploads whatever the snapshot lacks.

While connected, `/v1/live` pushes new entries as they are sequenced (inline when under 48 KiB, otherwise as a "head moved to n" notice that triggers a fetch). Live delivery is an optimisation; the cursor fetch is the recovery path, exactly as D treats vectors.

### Receiving an entry

For each entry in sequence order:

1. Verify the chain and the header signature. Check `clientSeq` is the next for that device (rejects a replayed old entry presented as new).
2. Replay membership to this `seq` (section 3 explains how epochs and removals are ordered). The device must belong to a person with a role on the project; the epoch must be current for that position.
3. Decrypt. Check `lineage`, and `schema` against the running app: newer stops the project with "This project was updated by a newer Scribyra. Update to see the latest changes." and leaves the cursor before that entry; older is accepted only if the app still reads it.
4. Run D's `receiveReplica` pipeline: clone, apply, refuse pending structs, schema and lineage, `validateRetainedState`, `validatePeerMetadata`, `validateProvenance`, `validatePeerState`, hydrate verified blobs (from the service instead of a peer), preserve concurrent binary losers as recovery projects, recheck against concurrent local edits, defer during IME composition, merge with a registered remote origin, save through the merged-head path. No peer update enters undo or starts auto-compile.
5. **Role scope check (new).** While applying to the clone, collect `transaction.changedParentTypes` and map each to its root. A reviewer's update may change only `authors` (their own record), `threads`, `messages`, `anchors`, `suggestions`, `reviews`, `discussionEvents`, `changes` (their own), and `meta` proof entries for their own records. A viewer's update may change only `authors`, `threads`, `messages`, `anchors` and their proofs. An update that changes `text:*`, `files`, `assets`, `trash`, `versions` or other `meta` keys is refused.
6. Advance the cursor and server vector in the same IndexedDB transaction as the save.

A refused entry is skipped, not retried, and recorded: "2 changes from Ben couldn't be verified and were ignored." Every honest client makes the same decision because it depends only on the entry, its position and the membership log. A later entry whose Yjs structs depend on a refused one stays pending; the client keeps pending structs within the 96 MiB bound, and if they are still pending at the head it reports the dependent entries as ignored too.

Step 5 changes the accepted contract, which says narrower roles "send validated operations through an authorised client, never arbitrary Yjs updates". With a log that every receiver validates, the role check can move to the receivers, which removes the need for an editor to be online for a reviewer to comment. It needs the architect's sign-off as an amendment to the annotations contract. If it is not accepted, reviewers and viewers instead write `request` entries that an editor client converts into updates, at the cost of latency and availability.

### What D's replication layer gives, and where it does not fit

| D piece | Reused as is | Changed for the service |
| --- | --- | --- |
| `receiveReplica` validation pipeline | Yes, steps 4 above | Blob `pull` fetches encrypted objects from the service and decrypts; a role scope check is added. |
| `checkHello` schema and lineage gate | Yes | `rights: 'full-editor'` becomes the role from the membership log. |
| State vectors every 5 s with full-state answers | No | A server cannot compute a diff of ciphertext. The log plus cursor plus chain replaces it. D keeps vectors for peers. |
| Budgets: 96 MiB retained state, 64 KiB vectors, 16 KiB frames, 20 s / 120 s assembly deadlines | 96 MiB retained and per-entry bound | HTTP bodies are bounded by the service's `object_bytes`; WebSocket frames by `frame_bytes`. Chunked framing is not needed over HTTP. |
| Asset offer list (128 MiB / 1,024 references per link) | No | The service keeps immutable objects; authorisation is project membership, not "recently offered". |
| Ed25519 identity, comparison codes, contacts | Yes | The identity becomes the device key; org events certify it, so pinning comes from the log. Comparison codes remain for device linking and approvals. |
| `directProof` / `directClaim` record provenance | Yes | Any device certified for the person may sign; otherwise unchanged. |
| Minute-rotated rendezvous rooms | Partly | Awareness rooms are derived from the project awareness key and rotated every ten minutes, inside the relay's `room_seconds` maximum of 600. |
| Five-member mesh cap | No | The log has no member cap. Awareness rooms need a larger cap, configurable (default 32). |

### Compaction and snapshots

The server suggests compaction (`Compact-Suggested: true` on a log response) when a project has more than 2,000 entries or 32 MiB of entries since the last snapshot. Any **editor** client that is caught up and idle may then:

1. Build the state at a cursor `s` from its own document: since it has applied exactly the accepted entries up to `s` and nothing refused, `Y.encodeStateAsUpdate` of a document rebuilt from the previous snapshot and accepted entries up to `s` is deterministic in content. (It uses the rebuilt document, not its live one, so unsent local edits are not mixed in.)
2. Encrypt it under the current epoch, upload it as an object, and append a `snapshot` entry whose plaintext states `{covers: s, chainAt: chain[s], stateVector}` and whose header lists `refs`.
3. The server records the snapshot as a floor candidate. It prunes entries at or below `s` only after the retention window (default 30 days) **and** after a second editor's client has appended a `verify` entry naming the same snapshot hash, or immediately if the project has a single editor.

Clients that hold the covered entries verify a new snapshot by rebuilding it; a mismatch is shown ("Ana's compacted copy differs from the history; kept the history") and the verifier does not countersign. A client that joins after pruning must trust the snapshot, which means trusting the editor who wrote it. Editors can already write anything, so this adds no new power, but it does mean a malicious editor can rewrite what new members see without leaving the per-entry trail. That is a real limit and is stated in the threat model.

Snapshots keep tombstones and delete sets as Yjs encodes them; there is no silent tombstone compaction, as D requires. History restore depends on the app's own checkpoint objects, which stay as referenced blobs.

### Offline work and conflicts

Offline edits accumulate locally exactly as today, plus outbox entries. On reconnect the client catches up first, then uploads. Text, tree and discussion state merge through Yjs and the existing Rust validators; concurrent binary replacements produce recovery projects; review decisions still go only through the authority. If membership changed while offline:

- **Still a member, epoch changed:** the client first resends its outbox unchanged, which tells it (through idempotent `200` answers) which entries the server already holds. The server refuses the rest with `409 epoch`; the client re-encrypts those under the new epoch, keeping their `clientSeq` values since none were accepted, and uploads them.
- **Role narrowed:** outbox entries outside the new role are refused by others; the app warns before uploading and offers "Keep these edits as a local copy".
- **Removed:** the server refuses. The project stays on the device and becomes a local project with a fresh lineage on the person's request; nothing is deleted without asking.

### Awareness

Awareness (cursors, selections, presence, agent labels) uses the existing relay. The room ID is `HKDF(K_aware[epoch], "room" ‖ floor(minute / 10))`; frames are sealed with AES-GCM under a key derived the same way, binding room, sender device and a monotonic counter, as `web/service-client.js` already does for signalling. The relay accepts org sessions in the first message in place of a bearer. Awareness is never stored and never counts as delivery. If the relay is unavailable, editing and sync continue without cursors.

### Limits

| Limit | Default | Where |
| --- | --- | --- |
| Inline entry | 1 MiB | Server config `entry_inline_bytes` |
| Entry or object | 8 MiB, configurable to 64 MiB | Existing `object_bytes` |
| Retained project state | 96 MiB | Client (`MAX_RETAINED_BYTES`) |
| Membership event | 16 KiB | Server and client |
| Catch-up page | 256 entries or 16 MiB | Server |
| Appends per device | 10 per second | Server, on top of existing rate windows |
| Outbox | 256 entries or 128 MiB per project | Client; beyond it the app says backup is falling behind |

## 3. Encryption and trust

### Key hierarchy

```
Device (per browser profile)
  ├─ Ed25519 signing key         non-extractable; signs events, entries, wraps
  ├─ X25519 agreement key        non-extractable; receives wrapped keys
  └─ local storage key           non-extractable AES-GCM; encrypts cached keys in IndexedDB

Person
  └─ recovery key (X25519)       from a recovery code or passkey PRF; registered by recovery.set

Org
  ├─ directory key, per epoch    encrypts display names, team names, listed project names
  ├─ team keys, per epoch        wrapped to member devices
  ├─ org recovery key (X25519)   optional; private half held offline by owners
  └─ service org key (X25519)    organisation-managed orgs only; held by the service,
                                 sealed at rest under the operator's master key file

Project key PK[e], per epoch (32 random bytes)
  ├─ K_update = HKDF(PK, "scribyra/1/update")    log entries and snapshots
  ├─ K_blob   = HKDF(PK, "scribyra/1/blob")      assets and checkpoint objects
  ├─ K_objid  = HKDF(PK, "scribyra/1/object-id") stable object identities
  ├─ K_aware  = HKDF(PK, "scribyra/1/awareness") relay rooms and frames
  └─ K_name   = HKDF(PK, "scribyra/1/name")      the project's name in listings
```

XChaCha20-Poly1305 runs in the Rust WASM core (RustCrypto `chacha20poly1305`), so `K_update` and `K_blob` exist as bytes in WASM memory while a project is open. At rest they are stored in IndexedDB only encrypted by the device's non-extractable local storage key. X25519 and Ed25519 stay in WebCrypto and never leave it. AEAD is not key-committing, so each epoch event carries `keyCommit = HMAC-SHA-256(PK[e], "scribyra/1/key-commit")`, and a wrapped key that does not match is refused.

### Wrapping

A key wrap delivers `PK[e]` (or a team or directory key) to one device:

```json
{"v": 1, "org": "…", "target": {"project": "…", "epoch": 3}, "recipient": "device key",
 "enc": "X25519 ephemeral public key", "ct": "wrapped key + tag", "sender": "device key", "sig": "…"}
```

`ct` uses an ECIES-style construction: the sender makes a fresh X25519 key pair, computes the shared secret with the recipient's public key, derives `HKDF-SHA-256(ikm = shared, salt = enc ‖ recipient, info = "scribyra-wrap/1" ‖ canonical context)`, and seals the key with XChaCha20-Poly1305 under a random nonce, with the canonical context (org, target, recipient, sender) as associated data. This is deliberately simpler than RFC 9180 HPKE, which would need the DH step inside the same library as its key schedule; ours needs only the DH output, so the recipient's X25519 step can use WebCrypto `deriveBits` and the private key never leaves WebCrypto. The recipient checks the sender was a member of the target at that epoch, the signature, and `keyCommit`. A project shared with a team gets one wrap to the team key; each team member's devices hold wraps of the team key.

Wraps are fulfilled automatically: `GET /v1/orgs/{org}/pending` lists grants and new devices that lack wraps the caller could produce. A client that holds the key checks the grant in the membership log (including the admin-approval rule from section 1) and publishes wraps. A new member therefore gets keys as soon as any project member's app is open.

### Epochs, rotation and ordering

A project's epoch changes when someone loses access (person removed, grant revoked, device removed, team member removed from a team holding the project) and on request. The removing admin's client creates the new epoch if it holds the key; otherwise the first remaining member client to come online does, before it writes anything. It generates `PK[e+1]`, wraps it to every remaining entitled device or team, and appends `project.epoch {project, epoch, keyCommit, after: seq}`, where `after` is the last log `seq` the client had seen. Concurrent rotations are resolved by membership-log order; the loser discards its key.

Ordering rules:

- The server records the project head at the moment it appends `project.epoch` as the cutover, and from then on accepts only epoch `e+1` entries. Clients cannot verify a cutover the server chose, so they also apply a rule that does not depend on it: an entry from a device whose person was removed is refused if its `seq` is above the `after` value the removing client signed. A server colluding with a removed member therefore cannot insert that member's later writes into the accepted history.
- An epoch `e` entry above the cutover from a device that is still a member is accepted (it can only come from a misbehaving server, and it reveals nothing new), but the app logs it as a server fault.
- No client encrypts new content under an epoch it knows to be superseded.

Rotation protects content written **after** it. Content the removed person could read before stays readable by them: they may have the decrypted project on their device and the old epoch keys. An optional **Re-encrypt stored history** action (an editor client downloads, decrypts, re-encrypts every retained object and snapshot under the new epoch, then the server deletes the old ones) reduces exposure if old keys leak later through the server's disks; it does not undo the removed person's own copy.

### Recovery when a person loses every device

A person whose browser storage is gone has lost their local projects too, so the encrypted service copy is the only copy and it is useless without keys. Options:

| Option | How | Gains | Costs |
| --- | --- | --- | --- |
| **Re-share by another member** | An admin re-enrols the person on a new device (approval with comparison code); any project member's client then fulfils pending wraps. | Works for every project with at least one other member, with no extra secret. | Needs another member's app to be opened. Useless for projects only this person was in. |
| **Personal recovery code** | At first connection the app shows a recovery kit: the service address, the org, and a 256-bit code written as 11 groups of 5 Crockford base32 characters with a 16-bit checksum. HKDF derives from it an X25519 key (to unwrap) and an Ed25519 key (to sign a `device.add` for the same person), both registered with `recovery.set`; every project key the person receives is also wrapped to it. Typing the kit on a new device enrols that device and unwraps everything. | Self-sufficient, also covers solo projects and single-person orgs. | People lose codes. A stolen code gives the thief that person's access. In orgs with more than one person, an owner can require admin approval for recovery enrolment (`org.policy {recoveryApproval}`); a personal org cannot, since nobody else exists to approve. |
| **Passkey with PRF** | Like the recovery code, but the key is derived from a synced passkey's PRF output. | No code to keep; follows the person's platform keychain. | Only where PRF works; trusts the platform's passkey sync. |
| **Org recovery key (escrow)** | Owners create an org recovery key; its private half is printed or stored offline (optionally split 2-of-3 among owners in a later slice). Projects created while it is set wrap each epoch to it. Every member sees "Acme can recover this project" on those projects. | Org survives a departed or unreachable person, as institutions require. | Owners holding it can read covered projects. It is a deliberate, visible exception to "admins cannot read". |

**Decided (Paul, 10 November 2026):** re-share is always on; the personal recovery code is offered at first connection and strongly encouraged; passkey PRF replaces the code where available once passkeys land; org escrow is off by default and an explicit org policy, visible on every project it covers, never retroactive without telling members. In organisation-managed orgs the service can always re-wrap keys for a re-enrolled person, so recovery there needs only re-enrolment.

### What the operator can see

| Visible | Hidden |
| --- | --- |
| Org IDs, person IDs, device public keys, roles, team membership, project IDs and grants | Display names, team names, project names (directory key / project key) |
| Membership log event types and times | Text, file names and tree, comments, reviews, history, settings |
| Log entry sizes, times, kinds, which device wrote them, sequence numbers | Which file or record an entry touches |
| Blob sizes, counts, ciphertext hashes, which snapshot references them | Asset contents and plaintext hashes (object IDs are keyed with `K_objid`) |
| Awareness room membership and traffic volume | Cursors and selections |
| IP addresses, origins, session times, OIDC claims or passkey registrations when used | Private keys, recovery codes |

The operator can deny, delay, drop, replay or fork traffic. Clients detect altered or reordered entries and replayed entries; they cannot force availability.

### What an org admin can and cannot do

Can: invite, approve, remove people and devices; create teams; grant; archive or delete projects (deletion is real, section 4); see sizes, members and activity times; set quotas within the operator's limits; export the org's ciphertext and membership log; read every project while admin read access is on or the org is organisation-managed. Cannot: edit without an editor grant; read a project's content when admin read access is off in an end-to-end encrypted org, unless granted by an editor or holding the org recovery key; impersonate a member's authorship (records are signed by member devices); alter history unnoticed; change the encryption mode or admin read access silently (only the owner can, and every member is told).

### Encryption modes (decided 10 November 2026)

Paul decided that the encryption mode is a per-organisation setting, not a fixed property. The owner chooses it when creating the org; it is recorded in the signed membership log (`genesis.mode`, later `org.mode`), and every member sees it on the org and on every project.

Both modes use the **same client pipeline**: clients always encrypt entries, blobs and snapshots with project keys, and the service always stores ciphertext. The only difference is who else holds the project keys. This keeps one data path and makes switching a key operation, not a data migration.

| | **End-to-end encrypted** | **Organisation-managed** |
| --- | --- | --- |
| Who holds project keys | Member devices (plus admins while admin read access is on, plus the org recovery key if set) | The same, plus the service's org key |
| The service can read content | No | Yes, by unwrapping project keys with its org key |
| Data at rest on the service | Ciphertext under keys the service never has | Ciphertext under keys the service holds, sealed by the operator's master key file |
| Disk theft or a leaked database backup | Exposes metadata only | Exposes metadata; content too if the master key file is also taken |
| Recovery after losing every device | Recovery code, re-share, or org recovery key | Re-enrolment alone: the service re-wraps keys |
| Later server-side features (search, previews, web hooks) | Not possible | Possible, each one added as an explicit feature |
| Default for | Personal backups and orgs whose owner picks it | Orgs whose owner picks it |

**What the app says.** On the org and in each project's Share and status details:

- End-to-end encrypted: "End-to-end encrypted. Only members' devices can read this project. The service stores ciphertext; its operator can see who is a member, sizes and timing."
- Organisation-managed: "Organisation-managed. Acme's service holds the keys to this project. The service operator and Acme's administrators can read it."
- When admin read access is on, either mode adds: "Acme's administrators can read this project."

The org creation dialog shows both options with these sentences and pre-selects end-to-end encryption for a personal org. A project in a managed org shows a small "Managed" badge in the project list, so nobody mistakes it for an end-to-end encrypted one.

**Switching from end-to-end encrypted to organisation-managed.** The owner signs `org.mode {mode: "managed", serviceKey}` with the service's org public key. Nothing is escrowed by that event alone. Every member's app shows a blocking notice: "Acme changed to organisation-managed encryption. The service will be able to read the projects you share keys for. Share keys with the service?" Only after the person consents does their client wrap the current epochs of their projects to the service key. A project becomes managed once any member with its key consents; until then it stays end-to-end encrypted and its project page says "Waiting for a member to allow organisation-managed access". The owner cannot force escrow of a project nobody consents for; they can only archive or delete it. Older epochs are escrowed too, since a member who consents can already read them; the notice says so.

**Switching from organisation-managed to end-to-end encrypted.** The owner signs `org.mode {mode: "e2ee"}`. The service deletes its org key and every wrap addressed to it, and stops serving admin reads through itself. Every project moves to a new epoch not wrapped to the service; member clients do this automatically the next time they open the project, before writing anything. The app states plainly to everyone: "Acme is now end-to-end encrypted. The service operator could read these projects until now and may have kept copies. New changes can only be read by members' devices." A project shows "Switching…" until its new epoch exists.

**Never silently.** The service refuses to serve or accept wraps that contradict the mode in the signed log, and clients check the mode from the log rather than trusting a service flag. A service that claims managed mode without an owner's signed event gets no keys; a service that hides a switch to managed mode still gets no keys, because member clients only escrow after their own person consents.

**Limits of managed mode.** The service's org key is protected at rest by a master key file the operator controls (`service_key_file`), not by an HSM in this design. Clients cannot tell whether the operator has also copied the key elsewhere. Managed mode is a trust choice about the operator, which is why the app says it in plain words.

## 4. Storage

### Server schema (PostgreSQL)

Decided 10 November 2026: all metadata (memberships, logs, sequences, quotas, objects) lives in **PostgreSQL** from the start, managed by versioned migrations embedded in the binary. The SQLite store is retired; `scribyra-sync migrate-sqlite` copies an existing milestone-S data directory (its `objects` table and blob files) into the new stores once. Relay and object capabilities stay in the operator's configuration file, so they need no migration. Tables:

| Table | Columns (abridged) |
| --- | --- |
| `orgs` | `org, created, quota_bytes, quota_objects, state` |
| `org_events` | `org, seq, hash, prev, type, signer, body_json, received` |
| `devices` | `org, device, person, agreement_key, state` (materialised from events) |
| `grants` | `org, project, subject, role, state` (materialised) |
| `sessions` | `token_hash, device, org, expires` |
| `wraps` | `org, recipient, target, epoch, sender, body, received` |
| `projects` | `org, project, head_seq, head_chain, floor_seq, bytes, objects, state` |
| `entries` | `project, seq, device, client_seq, kind, epoch, entry_hash, chain, size, inline_blob, object, received` |
| `refs` | `project, snapshot_seq, object` |
| `objects` | `namespace, hash, size, created`; namespace is a capability namespace or a project ID |
| `usage` | `scope, bytes, objects`: one row per namespace, org and the global total, locked `FOR UPDATE` in a fixed order for serialised quota checks |

Materialised tables are rebuilt from `org_events` at startup in debug builds and checked against the stored copies, so a bug cannot silently diverge from the log.

### Quotas

Quotas count ciphertext bytes and object counts per project, per org and globally, using the existing serialised check before persistence. Org owners can set per-project limits under the org quota. Exceeding returns `507`; the app shows "Acme's storage is full. Your changes are saved on this device and will back up when space is freed." Wraps and events have their own small quotas so a full org can still remove members and delete projects.

### Retention and garbage collection

- **Log entries** are pruned below a verified snapshot after the retention window (section 2).
- **Objects** cannot be judged by the server, because it cannot read the document. Each snapshot's `refs` lists the objects still needed: current assets, assets in the trash and every checkpoint object behind a still-restorable version. An object is collectable when no retained snapshot lists it, no retained entry names it, and it is older than the retention window. Clients choose what to reference; the server only deletes what nobody references.
- **History**: unpinning or deleting a named version in the app removes its objects from the next snapshot's `refs`, and they age out.

### Deletion that really deletes

`project.delete` (signed by an admin, an owner, or the project's last editor) makes the server, in one transaction, mark the project deleted and refuse all access; then a background job unlinks its objects and entries and removes the rows. Postgres `VACUUM` reclaims the deleted rows' pages; operators who need prompt physical erasure of database pages run `VACUUM FULL` on the affected tables, documented in [service.md](service.md). Org deletion does the same for everything in the org. Wraps are deleted too, so the remaining ciphertext in any operator backup is unreadable without a member's device key.

What deletion cannot reach, and the app says so: copies on members' devices (each person is asked on their next connection: "Acme deleted this project. Delete your copy too, or keep it as a local project?"), operator backups until they rotate (documented: backup retention bounds how long deleted data lingers), and anything already exported.

### Complete export

- **A person**: every project is already complete in their browser, and the existing `.scribyra-backup` export works offline. **Download everything** produces one backup per project the person can decrypt, without the service's help beyond fetching missing blobs.
- **An org**: an owner's client exports every project the owner is a member of (or can recover with the org recovery key), plus a plaintext member and team list from the decrypted directory. Projects the owner cannot decrypt are listed as such.
- **Operator migration**: `scribyra-sync export --org <id>` writes an encrypted archive (membership log, wraps, entries, objects, chain heads). `scribyra-sync import` on another service restores it; clients reconnecting to the new endpoint verify the chain against their cursors. This moves an org between services, including from paid hosting to self-hosting, without anyone decrypting anything.

### Operator backup and restore

Objects are immutable and the database only refers to an object after it is durable, so a consistent online backup is: take a `pg_dump` (or a base backup with WAL archiving) first, then copy the blob directory or bucket. Every object the dump refers to is already in the blob store; objects written after the dump are harmless extras. The service documentation gives the exact commands for both backends.

Restoring an older backup rolls the logs back. Clients notice: their cursor is past the head, or the chain at their cursor differs. If the server's log is a prefix of what the client verified, the client resets its cursor to the server head and re-uploads its own entries from its local state (new `clientSeq` values after the server's last known one for that device). "Backed up remotely" drops back to "Backing up…" until that finishes. Local-first storage turns a server rollback into a short re-upload rather than data loss, for every change still on some member's device.

### PostgreSQL, and filesystem or S3 blobs

Decided 10 November 2026 (Paul: "efficient from the get go"; backend choice by the architect):

| Part | Choice | Why |
| --- | --- | --- |
| Metadata | PostgreSQL 15 or later, through `sqlx` with its embedded migrator | Async connection pool on the same Tokio runtime as Axum; row-level locking for sequence assignment and quotas; replication and managed hosting are standard. |
| Migrations | `sqlx::migrate!` (SQL files in `crates/sync/migrations`, embedded at compile time, recorded in `_sqlx_migrations` with checksums) | One dependency for both the pool and migrations, plain SQL files reviewers can read, no build-time database (queries are checked at runtime, not with sqlx's compile-time macros). Refinery would add a second database stack beside the driver. |
| Blobs and large log entries | One `BlobStore` trait with two backends: **filesystem** (temporary file, fsync, rename, directory fsync) and **S3-compatible** (AWS S3, Cloudflare R2, MinIO, Garage; path-style or virtual-host addressing) | Small installs keep one binary, Postgres and a directory; larger ones use any S3 service. A successful PUT is the durability point. |
| Small log entries | Inline in Postgres (up to 64 KiB by default) | Avoids an object-store round trip per keystroke batch while keeping large entries out of the database. |
| S3 client | `rusty-s3` request signing with the existing `ureq` HTTP client | Small dependency set, no SDK runtime; works with every S3-compatible service tested. |
| Single writer | A Postgres advisory lock held for the process lifetime | Relay rooms and sessions live in memory; two processes on one database would split them. Multiple nodes are later hosting work. |

Startup no longer reads every stored object (that does not scale to S3); every read verifies the object's hash, and `scribyra-sync verify` checks the whole store on demand.

## 5. App UX

### Connecting to a service

All projects → **Services** → **Connect to a service** asks for an invitation link (or a service address plus link). The dialog shows the service address, the org label once decrypted, the org's encryption mode and admin read access in the plain sentences from section 3, and what connecting does: "Creates keys for this browser. Projects you add are encrypted on this device before upload." After joining, the app offers the recovery code. Turning sessions on for D and connecting to a service use the same device key; neither creates one until the person acts.

### Project list

The list gains a grouping: **On this device** (local projects) and one group per org ("Acme Lab · sync.acme.org"). An org project that is on this device shows normally; one granted but not yet downloaded shows **Download** with its size. Each row shows one status:

| Status | Meaning |
| --- | --- |
| **Saved on this device** | Committed to IndexedDB. Local projects always show this; org projects show it when changes are waiting. |
| **Backing up…** / **3 changes waiting** | Outbox not empty; the reason appears on hover (offline, quota, newer version needed). |
| **Backed up remotely** | Every local change and referenced blob is in entries the service acknowledged. |
| **Synced** | Backed up, and caught up with the service's head over a live connection in the last 30 seconds. |
| **Paused: update Scribyra** | A newer schema arrived. |
| **Removed from Acme** | Server refused; the copy is local only now. |

A project never shows "Backed up remotely" because a D peer has it.

### Adding and sharing projects

**Add to Acme…** on a local project shows the same disclosure as D's Share (source, assets, comments, suggestions, history, trash including deleted files' text) and offers the cleaned copy. The project keeps its lineage when added whole. **Share** in an org project lists people and teams with a role picker (Editor, Reviewer, Viewer, and "can comment" for viewers). Admin self-grants appear to editors as approval requests. People see who has access and the project's recovery state ("Recoverable with your code", "Acme can recover this project").

### Conflicts and offline

Nothing new for text: concurrent edits merge. The app's existing tree conflict marks, binary recovery projects and suggestion conflicts appear as they do for local tabs and D. New messages cover verification ("2 changes from Ben couldn't be verified and were ignored"), role changes while offline, and a server rollback ("The service lost recent changes. Re-uploading from this device.").

### Leaving or being removed

**Leave Acme** asks per project: keep as a local project, or delete from this device. Kept projects get a new lineage, so they cannot be re-added silently. The device's keys for that org are deleted. On removal, the app shows the same choice when it next connects. The app never claims it can wipe a copy remotely.

### D's live sessions

Members of the same org can start a D session on a shared project without exchanging an invite secret by hand: the org log already pins their keys, so the comparison code step becomes optional. D's direct channel and the service log run side by side; each device uploads only its own Yjs structs, so nothing is duplicated, and an update that arrives by both routes merges once. Awareness goes through the relay by default and through the direct channel when one is open. D remains the only route that works without internet on a permissive LAN; the service remains the only durable one.

## 6. Paid hosting later

The hosted service is the same `scribyra-sync` release with a `tenancy: "multi"` configuration and, outside the binary or behind a configuration flag present in every build, a small account front end:

- **Accounts**: an email address plus passkey for the person who pays. An account owns one or more orgs. It is not a project identity; org membership and keys work exactly as self-hosted.
- **Self-serve org creation** replaces the CLI bootstrap. Self-hosters can enable the same sign-up page.
- **Metering** reads the quota counters the service already keeps (bytes, objects, transfer, relay minutes).
- **Billing** sets the org's quota numbers and suspends writes (never reads or exports) for unpaid orgs.
- **Operations**: the same Postgres and S3 backends self-hosters use, plus multiple nodes, and the export command for customers who leave.

No feature is hosted-only: teams, OIDC, passkeys, recovery, escrow, export and quotas all work in a self-hosted install. Choosing hosting is an explicit endpoint, never a default the app contacts on its own.

## 7. Threat model

| Adversary | Can | Cannot | Notes |
| --- | --- | --- | --- |
| **Malicious or compromised server operator** | See the metadata in section 3; deny, delay or drop service; withhold the newest entries; show different members different valid tails (fork); refuse to delete; keep deleted ciphertext; collude with a removed member's old keys. | Read content; forge or alter entries or membership events; reorder an entry before a removal; give anyone keys. | Forks are detected only when members compare heads another way (a D session exchanges chain heads; the app shows a warning on mismatch). Withholding the newest entries is undetectable without such a comparison. |
| **Operator of an organisation-managed org** | Everything above, plus read every project whose keys were escrowed. | Read projects nobody consented to escrow after a switch; read new epochs after a switch back to end-to-end encryption. | This is the deliberate trade of managed mode, stated in the app. |
| **Malicious member (editor)** | Read and copy everything; write any content; redact others' messages (D decision); write a misleading snapshot that new joiners trust; share keys outside the app. | Forge another member's signed records; change roles without admin rights; read projects they are not in. | Removal and rotation stop future access only. |
| **Malicious reviewer or viewer** | Read and copy; add comments and suggestions; flood within quota. | Change source, files or assets (refused by every honest receiver); accept suggestions without authority. | Depends on the role scope check (section 2). |
| **Removed member** | Keep everything already downloaded; keep old epoch keys. | Read entries after rotation; write entries that are accepted after their removal. | Re-encrypting stored history limits exposure from later server leaks only. |
| **Stolen device, unlocked browser** | Everything that person could do until the device is removed. | Survive removal: rotation follows. | Browser profile protection is the platform's job. Keys in IndexedDB are non-extractable or encrypted with a non-extractable key, which stops copying files off disk but not use inside the running profile. |
| **Stolen device, locked or disk image** | Read whatever the browser stores unencrypted: IndexedDB project content is plaintext today. | Use non-extractable keys outside that browser profile. | Local at-rest encryption of projects is out of scope; full-disk encryption is the recommendation. |
| **Network attacker** | Observe TLS metadata. | Read or alter traffic beyond TLS; replay entries (chain and `clientSeq`). | TLS is required for non-loopback endpoints, as today. |
| **Malicious invitation link holder** | Join with the invited role before the intended person; read the org's member and project names (the link carries the directory key). | Join if the invite needs approval and the admin compares a code, or if it is bound to SSO (and an email) the holder cannot sign in as. | Links are single use and expire (default 7 days); admin invitations and members' invitations always need approval. |
| **Compromised or malicious identity provider** | Sign anyone in as any subject; keep a disabled person signed in; in orgs that require SSO, lock everyone out. | Give anyone keys in an end-to-end encrypted org: SSO only admits people to the service and to pending join requests that an admin approves; invitations still need their secret. | The IdP is trusted for *who may reach the service*, not for content. In an organisation-managed org it is trusted as much as the service. |
| **Operator colluding with the IdP** | Everything above, plus link an SSO identity to any person and admit them to the service. | Read content in an end-to-end encrypted org, or approve a join request (needs an admin's signature). | SSO links live only on the service; admins see them in the members list. |

Out of scope: hiding who collaborates with whom from the operator; traffic analysis; a malicious app build served by the static host (the app is the trusted computing base; reproducible builds and pinned releases are milestone 12 work); compromised browsers or extensions; preventing a reader from copying; remote wipe; post-quantum security; independent review, which remains Paul's decision before public security claims.

## 8. Slices

Re-planned 17 November 2026 after Paul's new requirements: SSO and invitations come right after the personal backup, then device sync; assets, epochs, review roles and compaction follow. Each slice is reviewable on its own, ends with its acceptance tests passing in Chromium, Firefox and WebKit where browsers are involved, runs its Rust tests against real PostgreSQL with filesystem and S3-compatible (Garage) blobs, gets an independent adversarial review of its authentication, invitation and key-distribution parts, and adds no visible feature until its slice says so.

| # | Slice | Extends | Acceptance |
| --- | --- | --- | --- |
| 1 | **Personal encrypted backup on the Postgres foundation** (delivered). PostgreSQL with embedded migrations, the `BlobStore` trait (filesystem and S3), the SQLite migration tool, NixOS module and compose file; device-key login, encrypted append-only logs with durable acks and an outbox, a recovery kit, restore on a fresh profile, and the review fixes (paging to an explicit head, re-wrapping to replaced kits, resumable connect, restore and kit replacement, rollback re-upload). | — | Kill the server between body write and commit: no ack, retry gives one entry. Duplicate retry returns the same seq; same clientSeq with other bytes is 409. Fresh profile plus recovery kit restores byte-identical source, comments and reviews. A plaintext marker is absent from the database and blob files. Lost answers and interrupted restores resume. |
| 2 | **Organisations.** Create an org with a setup code, choosing its name, encryption mode (end-to-end or organisation-managed, the service's org key sealed by the operator's master key file) and admin read access; directory key and encrypted names; the mode shown on the org and its projects. | Slice 1, `membership` rules in `crates/core`. | A managed org's project keys are wrapped to the service key and the service can open them; an end-to-end org's are not, and the service refuses wraps that contradict the signed mode. Names never reach the service in plaintext. |
| 3 | **Single sign-on (OIDC).** The service as relying party, per-org configuration, the app's "Sign in with …" path, account linking, required-SSO device sessions, blocking when the IdP disables someone, logout, back-channel logout. | Slice 2. | Against the local test IdP: sign-in works in all three browsers; every forged or misdirected token is refused; disabling the user at the IdP blocks their sessions within one re-check; a login for one org is useless for another; no token or secret appears in logs. |
| 4 | **Invitations, membership and roles.** Invite links (optionally SSO-bound), join requests through SSO, approval, owner/admin/member roles, removal with immediate session close, the members list; project sharing with editor/reviewer/viewer and automatic wrap fulfilment; log entries accepted from editors only until slice 8. | Slices 2–3. | Replaying the same event log in Rust natively and in WASM gives identical state for randomised event sequences. Forged, reused, expired or out-of-order invitations are refused by both. A removed person's sessions close at once. A project shared with a second person opens on their browser with the role's modes. |
| 5 | **Second device and device sync.** Linking by link code or SSO, pending wraps, downloading org projects, catch-up with a long-poll notice, uploading only own changes, offline reconciliation, device removal. | Slices 1–4, `web/local-tabs.js` merge path. | Two profiles of one person edit offline, reconnect in both orders and converge; an open editor shows the other device's change without reload; lost notices are repaired by catch-up; a removed device's sessions close. |
| 6 | **Encrypted assets and history objects** (was 3). | Object routes (namespace = project), `web/assets.js`, `web/history-backup.js`. | A project with images and named versions restores on a fresh profile; a corrupted blob is refused and refetched; quota exhaustion keeps local saving working. |
| 7 | **Shared editing with epochs and rotation** (was 6). | Slices 4–5, `web/direct-provenance.js`. | Three people edit; one is removed; the next entries use an epoch the removed device cannot decrypt, and its later uploads are refused by others even if a test server injects them; admin self-grants wait for an editor. |
| 8 | **Reviewer and viewer roles at receivers** (was 7). | Role scope check, durable decision requests. | A reviewer's crafted update that deletes accepted text is refused by every receiver; a suggestion reaches an offline authority; a viewer with `comment: false` cannot add a thread. |
| 9 | **Compaction and garbage collection** (was 4). | Slices 1–6. | A client 5,000 entries behind the floor catches up from a snapshot; a falsified snapshot is detected; objects age out only after the window. |
| 10 | **Awareness over the relay** (was 8). | Relay, `web/service-client.js`. | Cursors for up to 20 members; a relay restart loses cursors but no edits. |
| 11 | **Recovery and lost devices** (was 9): admin re-enrolment, re-share, org recovery key, directory epochs, optional history re-encryption. | Slices 4–7. | Losing every device: shared projects return by re-share; solo projects by the recovery code; escrow only where members saw the notice. |
| 12 | **Passkeys and teams** (was 11 without OIDC). | Slices 4, 7, 11. | A passkey alone enrols a new device only with org approval; adding a person to a team with 50 projects writes one wrap per device. |
| 13 | **Switching encryption modes and admin read access** (was 12). | Slices 2, 7, 11. | A switch to managed escrows only consented projects; a switch back rotates every project; turning admin read access off excludes admins from the next epoch; every member sees each change. |
| 14 | **Deletion, export and operator tooling** (was 10). | CLI, `web/downloads.js`. | Deleted projects leave no ciphertext hashes in the data directory; export/import moves an org between services without re-encryption. |
| 15 | **Hosting mode** (was 13). | Postgres and storage trait. | The full suite passes with filesystem blobs and with MinIO; an org exported from hosting runs unchanged self-hosted. |
| 16 | **Online compile**, after Paul decides (section 10). | — | — |

**Delivered on `feature/org-sync-v2` (17 November 2026).** Slices 1–5, each with Rust tests against real PostgreSQL (filesystem and Garage blobs), Node engine tests, browser tests in Chromium, Firefox and WebKit, and an independent adversarial review of authentication, SSO, invitations and key distribution (no Critical; one High and three Medium findings, all fixed with regression tests: quadratic log replay, invitations outliving their creator's authority, overwritable wraps, and SSO linking that was too permissive). Known limits until later slices:

- Removing a person or a device closes their sessions at once, but their keys rotate only with slice 7; the members list says so beside the Remove buttons.
- Reviewers and viewers read through the service; what they write (comments, suggestions) stays on their device until slice 8.
- Entries from other people are checked for signature, chain, role and project structure (`validateReplica`); D's per-record provenance check for other people's records joins in slice 7.
- A join request through SSO carries no readable name (the joiner has no directory key yet); admins see "Asked to join with single sign-on" until they approve. Showing the IdP's name and email to admins needs an admin route on the service.
- Organisation-managed orgs are created with the service key and every key is wrapped to it; the service does not yet use it (admin reads through the service, re-enrolment and mode switches are slice 13).
- Group-to-role suggestions and an interoperability run against Dex or Keycloak are not done yet.

Slices 1–5 give organisations what Paul asked for on 17 November: SSO, invitations with roles, and device sync. Until slice 7, removing someone blocks them on the service at once but cannot take back keys they already hold; the app says so in the removal dialog. Slices 1–7 complete milestone 10; 8–11 complete milestone 11's recovery and revocation gate, after which the independent security review should happen before any public claim.

## 9. Decisions (Paul, 10 November 2026)

1. **Encryption is a per-organisation setting.** The owner chooses "End-to-end encrypted" or "Organisation-managed" at creation; it is shown to every member on every project, personal backups default to end-to-end, and switching in either direction follows section 3, with explicit consent for escrow and a plain statement that the operator could already read earlier data after switching back. The mode never changes silently.
2. **Recovery as recommended:** re-share by members, a personal recovery code at first connection, and an optional org recovery key shown on covered projects.
3. **Sign-in order as recommended:** invite links with device keys, then passkeys, then OIDC/SSO.
4. **PostgreSQL for all metadata from the start**, with embedded `sqlx` migrations, and one blob storage trait with S3-compatible and filesystem backends (section 4). The SQLite store is retired with a one-time migration tool. Self-hosting stays one binary plus Postgres, with blobs on disk or S3.
5. **Admin read access is a setting, default on** for organisations. In end-to-end encrypted orgs, project keys are also wrapped to admins' devices, shown to members; in managed orgs admins read through the service. Turning it off rotates keys going forward and states plainly what admins could already read.

The role scope check in section 2 is the architect's decision below.

### Requirements (Paul, 17 November 2026)

6. **SSO is a first-class sign-in path for organisations**: OIDC with the org's identity provider, beside invite links and device keys (passkeys follow). Section 1, "Single sign-on with OIDC"; the sign-in order in decision 3 becomes A and C together, then B.
7. **Inviting people to collaborate**: org membership and per-project sharing with the roles editor, reviewer and viewer, matching the app's modes. Section 1, "Invitations, joining, removal".
8. **Device sync**: the same person's devices stay in sync through the service and offline edits reconcile. Section 1, "Devices: linking and sync".
9. **Online compile is discussed before it is built**: options, a recommendation and questions in section 10.
10. Encryption stays a per-org setting (end-to-end or organisation-managed) and admin read access a setting defaulting on, as decided on 10 November.

The slices were re-planned accordingly (section 8): organisations, SSO and invitations come right after the personal backup, then device sync.

## Architect decision: role scope at receivers (November 9, 2026)

Accepted, as an amendment to the annotations contract, with three conditions:

1. Root-level checks aren't enough. Inside an allowed root, a reviewer or viewer may only create records they author, or change records whose provenance binds them as the author (their own message edits, their own suggestion withdrawal). Changing or deleting another person's record, even inside `messages` or `threads`, is refused, except for the actions the role itself grants (editors redacting, deciding suggestions).
2. The check is one shared, deterministic function used by D sessions and the service log alike, and it's covered by property tests that generate arbitrary Yjs updates from each role and assert that every update outside the role's allowance is refused by every receiver.
3. Until that check exists and passes review, reviewers and viewers use the fallback `request` entries that an editor's client converts.

## 10. Online compile: options for discussion (17 November 2026)

Paul asked to discuss online compile before anything is built. Today every compile runs in the browser (BusyTeX in WebAssembly, packages fetched on demand and cached locally). That stays the default whatever is decided: it works offline, costs nothing to run, and never shows content to anyone. The question is what a service-side compile adds and where it may run.

**What it would be for.** Weak or battery-limited devices (phones, tablets, old laptops); very long builds; an always-current PDF for members who only read; sending a PDF to people outside the org; later, automation such as a build on every accepted review.

**The constraint.** In an end-to-end encrypted org the service cannot read the source, so it cannot compile it. Any design either keeps compile on a machine that is already a member, or gives the service the keys, which is organisation-managed encryption under another name.

| Option | Where it runs | End-to-end encrypted orgs | Isolation and limits | Cost and abuse |
| --- | --- | --- | --- | --- |
| **A. Browser only, plus a shared package cache** | Every member's browser, as now. The service additionally serves a content-addressed cache of public TeX packages (integrity-checked against the catalog), so a fresh device does not fetch hundreds of files from the internet. | Unaffected (packages are public; the service sees which packages a device asks for). | Nothing new. | Package bandwidth only. |
| **B. Service-side worker, organisation-managed orgs only** | A compile worker beside the service decrypts a project at a log position with keys the service already holds, compiles, and stores the PDF encrypted with the project's blob key. Opt-in per project by an editor, shown to members ("Compiled on Acme's service"). | Not offered. | See below. | Metered compile minutes; per-org concurrency and queue limits. |
| **C. A compile device the org enrols** | The same worker, run by the org on hardware it trusts (a lab server), enrolled as a member device with read access to the projects it should compile. It gets keys through ordinary wraps and uploads encrypted PDFs. | Works without weakening anything: the member list shows "Lab compile server can read this project". | The org runs it; same sandbox. | The org's own hardware; nothing for the operator. |
| **D. Per-job key release to the service** | A member's app hands the project key to the service's worker for one compile. | Technically possible, but the service then reads the project, so the org is not really end-to-end encrypted any more. | Same sandbox. | Same as B. |

**Isolation of a worker (B and C).** TeX is a full programming language and documents come from members, so a compile is untrusted code:

- **Engine:** run the same BusyTeX WebAssembly build the browser uses, inside a WebAssembly runtime (wasmtime) with a virtual file system and no host file system, network or process access. It produces the same PDF as the browser and isolates by construction. A native TeX Live in a container or micro-VM is faster and complete but has a much larger attack surface.
- **TeX settings:** shell escape off, always (no `minted` or `\write18` on a service); reading and writing restricted to the project tree (`openin_any`/`openout_any` paranoid).
- **Limits per job:** CPU time (for example 60 s), wall clock (120 s), memory (2 GiB), output size, number of passes, and the existing 96 MiB retained-state bound for input. Per org: concurrent jobs and queue length.
- **Caching:** packages from the shared cache, read-only; compiled PDFs keyed by the project state, engine and package versions, and stored encrypted, so an unchanged project is never compiled twice.

**Paid hosting.** Compile minutes are the main variable cost: meter them per org, include a quota per plan, and stop at the quota rather than queueing forever. Abuse means endless loops (CPU limit), output bombs (size limits) and many small jobs (concurrency and rate limits). Self-hosters get the same worker with limits they set.

**Recommendation.** Keep browser compile as the default; add **A** first (cheap, helps every device, no trust change). Build one worker on WebAssembly BusyTeX under wasmtime and offer it as **B** for organisation-managed orgs and **C** for end-to-end encrypted orgs. Do not build **D**: an org that wants the service to compile its projects should say so by choosing organisation-managed encryption, which the app already explains in plain words.

**Questions for Paul.**

1. Which need drives this: weak devices, an always-current PDF for readers, long builds, or sharing PDFs outside the org? If it is mainly weak devices, A plus C may be enough.
2. Is it acceptable that end-to-end encrypted orgs get online compile only through a compile device they run themselves (C), and the hosted service compiles only for organisation-managed orgs (B)?
3. Engine: identical-output WebAssembly BusyTeX under wasmtime (recommended), or native TeX Live in a sandbox for speed and completeness?
4. Should compiled PDFs be stored and synced to members (encrypted, counted in the quota), or only returned to whoever asked?
5. Who switches it on: any editor per project (recommended, visible to all members), or an org admin first?
6. Confirm that shell escape is never available on a service-run compile.

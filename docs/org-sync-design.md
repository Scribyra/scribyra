# Organisations, sync and encrypted storage (milestones 10 and 11)

Design, 9 November 2026, revised 10 November 2026 with Paul's decisions ([section 9](#9-decisions-paul-10-november-2026)); written at Paul's request: "I also want the sync/storage server to be worked upon in parallel, so maybe orgs could collaborate and store, sync internal projects and etc." Slice 1 is being implemented on branch `agent/org-sync`; the rest is design. It turns the outlines of milestones [10 and 11](roadmap.md#milestones-10-and-11-scope) into one design that engineers can build slice by slice. It extends the [service](service-design.md) from milestone S and reuses the replication layer, identities and provenance from [milestone D](direct-sessions-design.md) (merged to main).

Four rules from earlier decisions frame everything below:

1. **Browser storage is the source of truth for each person.** The service is a durable, shared copy. It is never needed to open, edit, compile or back up a project alone, and turning it off leaves every local project usable.
2. **The service never interprets project content** (S1) in end-to-end encrypted organisations. It stores and relays opaque bytes, assigns sequence numbers and enforces access and quotas. Clients merge, validate, compact and encrypt. Organisation-managed mode (section 3) is the one deliberate exception, chosen by the org's owner and shown to every member.
3. **One binary, every feature free when self-hosted.** Paid hosting runs the same service with accounts and billing added around it, never inside the product's capabilities.
4. **Off means off** (D, 8 November). A browser that never connects to a service creates no keys, opens no extra databases and writes nothing new into projects.

## Summary

An **organisation** is a group of people on one service. Each person has one or more **devices** (browser profiles), each with its own signing and key-agreement keys. Who belongs to the org, with which role, and who may open which project is recorded in a **membership log**: a hash-chained list of events, each signed by a member's device. The server and every client replay this log with the same Rust code and reach the same answer.

Each project has an **append-only update log** on the service. Clients upload encrypted Yjs updates and receive server-assigned sequence numbers once the bytes are durable. Other clients catch up from their last cursor, decrypt, verify the author's signature and role, and run the incoming update through the same validation pipeline as D and local tabs before merging it. Assets and history objects are encrypted blobs. Editor clients periodically write encrypted snapshots so the server can drop old log entries.

Content is always encrypted by the clients with a per-project key per **epoch**, wrapped to every member device. Each organisation has an **encryption mode**, chosen by its owner at creation and shown on every project: **End-to-end encrypted** (only member devices hold keys; the service stores ciphertext) or **Organisation-managed** (the service also holds the keys, so it and authorised admins can read, which enables later server-side features such as search). Personal backups are end-to-end encrypted by default. A second org setting, **admin read access** (default on), decides whether org admins can read every org project. Removing someone starts a new epoch. Recovery after losing every device comes from a personal recovery code, from any other member re-sharing the key, or, if the org opts in, from an org recovery key that every member can see is in place.

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
| People | `invite.create`, `invite.revoke`, `person.join`, `person.approve`, `person.role`, `person.remove`, `person.leave` |
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

Two separate questions: *who may fetch and append ciphertext* (server authentication) and *who holds keys* (cryptographic membership). Server authentication protects availability and metadata; it never grants content access by itself.

| Option | How it works | Fits | Weakness |
| --- | --- | --- | --- |
| **A. Invite links and device keys** | The service issues a challenge; the device signs it with its Ed25519 key; the service checks the device is active in the org log and returns a 12-hour session token (hash stored, token held in memory by the app). New people arrive through single-use invite links. | Every install, including one person on a home server. No email, password or identity provider. | A lost device plus no other device means admin re-enrolment. A leaked unused invite link lets someone join (mitigated by expiry and optional approval). |
| **B. Service-local accounts with passkeys** | A person registers WebAuthn passkeys with the service. A passkey login lets them enrol a new device without an existing one, subject to the org's approval rule. With the WebAuthn PRF extension, the passkey can also unwrap the person's recovery key (section 3). | People with synced platform passkeys; self-recovery. | Passkey sync is platform-specific; PRF support varies by browser and authenticator. |
| **C. OIDC / SSO** | The service is an OIDC relying party for the org's identity provider. Invites can be bound to an IdP subject or email domain. When the IdP disables someone, the service blocks their devices at once and queues a `person.remove` for an admin's client to sign and rotate keys. | Companies and universities with Keycloak, Entra, Google Workspace and similar. | The IdP and server can log someone in, but cannot give them keys; full removal still needs an admin client to sign. |

**Decided sequence (Paul, 10 November 2026): A, then B, then C.** A is the smallest thing that works for everyone and stores no passwords at all. B adds self-recovery without an admin. C is what larger orgs require, and fits naturally once A's server-side session boundary exists. Passwords are never stored. The existing S bearer principals stay for operator-provisioned relay and object namespaces; an org session resolves to the same internal principal, rights and quota boundary, as S1 required.

**Bootstrap.** The operator creates an org from the command line: `scribyra-sync org create --label lab` prints a single-use **setup code** (service address, org ID and a 256-bit secret) and stores only the Ed25519 public key derived from the secret. The owner pastes the setup code into the app, which signs the org's `genesis` event with the device key and with the key derived from the secret; the first valid genesis consumes the code. The genesis records the encryption mode and admin read access the owner chose. Paid hosting replaces this with a sign-up page (section 6).

### Invitations, joining, removal

An admin creates an invitation in the app. The client generates a random 32-byte secret `s`, derives an Ed25519 invitation key from `HKDF(s, "scribyra/1/invite")`, and appends `invite.create {invite, role, inviteKey, expires, approval: bool, boundSubject?}`. The link is

```
https://<app origin>/#org=<base64url(version, service origin, org, genesis hash, invite, s)>
```

The fragment never reaches the app's static host. The service endpoint is explicit in the link; the app shows it and asks before connecting. The joiner's device creates its keys and signs `person.join {invite, person, device, agreementKey, encryptedDisplayName}`, countersigned with the invitation key. The first valid join consumes the invitation. If `approval` is set (always for admin invitations), the person is pending until an admin compares a code with them and signs `person.approve`.

Removal (`person.remove`, signed by an admin, or `person.leave`, signed by the person) takes effect on the server immediately: their sessions close and their devices are refused. Their key access ends at the next project epoch, which remaining clients create before writing anything else (section 3). What they already downloaded stays with them; nothing can change that.

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
| `POST /v1/auth/challenge`, `POST /v1/auth/session` | Device-key login (option A). |
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
| **Malicious invitation link holder** | Join with the invited role before the intended person. | Join if the invite needs approval and the admin compares a code. | Links expire (default 7 days); admin invitations always need approval. |

Out of scope: hiding who collaborates with whom from the operator; traffic analysis; a malicious app build served by the static host (the app is the trusted computing base; reproducible builds and pinned releases are milestone 12 work); compromised browsers or extensions; preventing a reader from copying; remote wipe; post-quantum security; independent review, which remains Paul's decision before public security claims.

## 8. Slices

Each slice is reviewable on its own, ends with its acceptance tests passing in Chromium, Firefox and WebKit where browsers are involved, and adds no visible feature until its slice says so. Slices 1 and 2 can start on main; slices that touch identity and provenance need D merged first (or rebase on `agent/d-direct`).

| # | Slice | Extends | Acceptance |
| --- | --- | --- | --- |
| 1 | **Personal encrypted backup on the Postgres foundation.** The service moves to PostgreSQL with embedded migrations and the `BlobStore` trait (filesystem and S3), with a one-time SQLite migration tool and updated NixOS module and compose file. One person, one end-to-end encrypted org created by CLI, device-key login, one project pushed as encrypted log entries with durable acks and an outbox; a recovery kit; restore on a fresh browser profile. No blobs yet (projects with assets are refused with a message). Managed mode is refused at creation until a later slice. | `crates/sync` (Postgres, migrations, storage trait, auth, log routes), `crates/core` (new `membership.rs` with genesis, device and recovery events; entry header types beside `exchange.rs`), Rust WASM XChaCha, `web/direct-identity.js` (device keys), new `web/org-sync.js`, status line. | Kill the server between body write and commit: no ack, retry gives one entry. Duplicate retry returns the same seq; same clientSeq with other bytes is 409. Fresh profile plus recovery code restores byte-identical source, comments and reviews. A plaintext marker is absent from the database and blob files. A tampered entry or broken chain stops sync with a message. A browser that never connects is byte-identical to main (extend `tests/direct-off.test.mjs`). |
| 2 | **Catch-up, live delivery and second device.** Device linking by QR or code; `/v1/live`; cursor catch-up; offline edits on both devices reconcile; status states including Synced. | `web/replication.js` (`receiveReplica` with a service blob source), slice-1 routes. | Two profiles edit offline for a day of simulated time, reconnect in both orders, converge. Lost live notices are repaired by catch-up. Removing the second device closes its sessions. |
| 3 | **Encrypted assets and history objects.** Blob encryption, keyed object IDs, `blobref`, quotas with the 507 path. | Existing object routes (namespace = project), `web/assets.js`, `web/history-backup.js`. | A project with images and named versions restores on a fresh profile, including restoring an old version with a deleted image. A corrupted blob is refused and refetched. Quota exhaustion keeps local saving working and shows the waiting state. |
| 4 | **Compaction and garbage collection.** Snapshots, verification by a second editor, floors, `410` catch-up, `refs`, retention window. | Slices 1–3, `web/history-storage.js`. | A client 5,000 entries behind the floor catches up from the snapshot and uploads its offline edits. A falsified snapshot is detected by a verifying client. Objects referenced only by a pruned version are deleted after the window and never earlier. |
| 5 | **Org membership.** Invitations, joining, approval, roles owner/admin/member, removal, encrypted directory, Services dialog and grouped project list. | `membership.rs`, server ACL materialisation, app project list. | Replaying the same event log in Rust natively and in WASM gives identical state for 1,000 randomised event sequences. A forged or out-of-order event is refused by both. A removed person's sessions close within one second. |
| 6 | **Shared editing via the service.** Project grants to people with the editor role, automatic wrap fulfilment, epochs and rotation on removal, admin self-grant approval. | Slices 2 and 5, `web/direct-provenance.js` (person-level signers). | Three people edit one project; one is removed; the next entries use a new epoch the removed device cannot decrypt; the removed device's later uploads are refused by others even if a test server injects them. An admin's self-grant waits for an editor. Long-offline member re-encrypts its outbox after rotation. |
| 7 | **Reviewer and viewer roles.** Role scope check, durable decision requests to the authority, mode limits in the editor. | `web/replication.js` (scope check), reviews and comments modules, annotations contract amendment. | A reviewer's crafted update that deletes accepted text is refused by every receiver and reported. A reviewer's suggestion reaches an authority who was offline when it was made, and acceptance produces one patch. A viewer with `comment: false` cannot add a thread. |
| 8 | **Awareness over the relay.** Org sessions on `/v1/connect`, epoch-derived rooms, larger room cap. | `crates/sync/src/main.rs` relay, `web/service-client.js`, D's awareness display. | Cursors appear for up to 20 members; a relay restart loses cursors but no edits; a removed member cannot join rooms of the new epoch. |
| 9 | **Recovery and lost devices.** Admin re-enrolment, re-share by members, org recovery key, recovery state shown per project, optional history re-encryption. | Slices 5–6. | A person loses every device: with only re-share, shared projects return and a solo project is reported unrecoverable; with the recovery code, all return; with org escrow, an owner recovers a departed member's solo project and members saw the escrow notice. |
| 10 | **Deletion, export and operator tooling.** Project and org deletion, person and org export, `scribyra-sync backup`, `export`/`import`, rollback detection. | `crates/sync` CLI, `web/downloads.js`. | After deletion no file in the data directory contains the project's ciphertext hashes. An org moved to a second service by export/import continues syncing without re-encryption. Restoring a day-old backup triggers re-upload and loses no change still on a device. |
| 11 | **Teams, then passkeys, then OIDC.** Team keys and `everyone`; WebAuthn registration and PRF recovery; OIDC relying party with subject-bound invites and IdP-driven blocking. | Slices 5, 6, 9. | Adding a person to a team with 50 projects writes one wrap per device. A passkey alone enrols a new device only with org approval. Disabling a user at a test Keycloak blocks their devices at once and queues the removal for an admin. |
| 12 | **Organisation-managed mode and admin read access.** Service org key sealed by the master key file, consented escrow, both switching directions, admin wraps, mode badges. | Slices 5, 6, 9. | A switch to managed mode escrows only consented projects; a switch back rotates every project and the service can no longer decrypt new entries; turning admin read access off excludes admins from the next epoch; every member sees each change. |
| 13 | **Hosting mode.** Multiple nodes, multi-tenant configuration, metering counters, account front end. | Postgres and storage trait from slice 1. | The full test suite passes on Postgres with filesystem blobs and with MinIO. An org exported from hosting runs unchanged on a self-hosted service. |

Slice 1 is the smallest useful end-to-end result: someone with a home server gets an encrypted off-device backup that restores on a new machine. Slices 1–4 complete milestone 10's "Backed up remotely" for one person; 5–8 bring orgs and shared editing; 9–11 complete milestone 11's recovery and revocation gate, after which the independent security review should happen before any public claim.

## 9. Decisions (Paul, 10 November 2026)

1. **Encryption is a per-organisation setting.** The owner chooses "End-to-end encrypted" or "Organisation-managed" at creation; it is shown to every member on every project, personal backups default to end-to-end, and switching in either direction follows section 3, with explicit consent for escrow and a plain statement that the operator could already read earlier data after switching back. The mode never changes silently.
2. **Recovery as recommended:** re-share by members, a personal recovery code at first connection, and an optional org recovery key shown on covered projects.
3. **Sign-in order as recommended:** invite links with device keys, then passkeys, then OIDC/SSO.
4. **PostgreSQL for all metadata from the start**, with embedded `sqlx` migrations, and one blob storage trait with S3-compatible and filesystem backends (section 4). The SQLite store is retired with a one-time migration tool. Self-hosting stays one binary plus Postgres, with blobs on disk or S3.
5. **Admin read access is a setting, default on** for organisations. In end-to-end encrypted orgs, project keys are also wrapped to admins' devices, shown to members; in managed orgs admins read through the service. Turning it off rotates keys going forward and states plainly what admins could already read.

The role scope check in section 2 is the architect's decision below.

## Architect decision: role scope at receivers (November 9, 2026)

Accepted, as an amendment to the annotations contract, with three conditions:

1. Root-level checks aren't enough. Inside an allowed root, a reviewer or viewer may only create records they author, or change records whose provenance binds them as the author (their own message edits, their own suggestion withdrawal). Changing or deleting another person's record, even inside `messages` or `threads`, is refused, except for the actions the role itself grants (editors redacting, deciding suggestions).
2. The check is one shared, deterministic function used by D sessions and the service log alike, and it's covered by property tests that generate arbitrary Yjs updates from each role and assert that every update outside the role's allowance is refused by every receiver.
3. Until that check exists and passes review, reviewers and viewers use the fallback `request` entries that an editor's client converts.

# Self-hostable service

Milestone S provides an optional opaque object store and live connection relay.
Read the [decisions and threat boundary](service-design.md) first. No application
project connects automatically; the standalone experimental adapter is
`web/service-client.js`. Accounts, membership, encrypted project replication,
recovery and billing are later milestones. Every feature here is free to host.

## Install from the pinned source

The service is one binary plus PostgreSQL (15 or later; tested with 17). Object
bytes go either to a local POSIX directory (the default) or to an S3-compatible
bucket. Use this private checkout, its `flake.lock` and `Cargo.lock`, and Nix.
No TeX assets or frontend build are needed. Run all commands from the checkout.

```sh
nix develop -c cargo build --locked --release -p scribyra-sync --bin scribyra-sync
mkdir -p tmp
install_root=$(mktemp -d "$PWD/tmp/service-install.XXXXXX")
mkdir -m 700 "$install_root/data"
cp target/release/scribyra-sync "$install_root/scribyra-sync"
```

Create a database and a role that owns it. With a local PostgreSQL and peer
authentication over its unix socket, the role must have the same name as the
operating-system user running the service:

```sh
sudo -u postgres createuser "$USER"
sudo -u postgres createdb -O "$USER" scribyra
```

Write the database URL into its own file, readable only by the service user. A
URL with a password is a secret; it never belongs in `service.json`, a command
line or logs. For peer authentication there is no password:

```sh
umask 077
printf '%s\n' "postgres:///scribyra?host=/run/postgresql" > "$install_root/database-url"
```

For a remote server use `postgres://user:password@host:5432/scribyra?sslmode=verify-full`
(add `sslrootcert=/path/ca.pem` for a private CA). TLS uses rustls; `sslmode=require`
encrypts without checking the certificate and is not recommended.

Create `service.json` in the installation directory. For an empty,
deny-by-default instance with filesystem blobs:

```json
{"bind":"127.0.0.1:8787","data":"data","database_url_file":"database-url","origins":[],"principals":[]}
```

Run from the installation directory, with restrictive file creation permissions:

```sh
(cd "$install_root" && umask 077 && SCRIBYRA_SERVICE_CONFIG=service.json exec ./scribyra-sync)
```

At startup the service takes ownership of the database (below), applies any
pending migrations, opens the blob store and checks readiness. It then emits a
JSON `listening` event; `GET /health` and `GET /ready` return 200. `GET /v1`
advertises protocol 1. No principal means no storage or relay access. For an
occupied port choose another or use `127.0.0.1:0` and read the bound address.

The binary has three commands. All of them read the same configuration:

| Command | Effect |
| --- | --- |
| `scribyra-sync` or `scribyra-sync serve` | Run the service |
| `scribyra-sync verify` | Check every object's presence, size and hash, and the usage totals; print counts; exit 1 on any problem |
| `scribyra-sync migrate-sqlite <old-data-dir>` | Copy a milestone-S data directory into PostgreSQL and the configured blob store (see [Upgrade from the SQLite store](#upgrade-from-the-sqlite-store)) |

Any other arguments print the usage and exit 2. Every command takes the
database ownership lock, so `verify` and `migrate-sqlite` run while the service
is stopped.

For a reproducible disposable installation, exchange, backup, upgrade and
restore drill:

```sh
nix develop -c cargo build --locked --release -p scribyra-sync --bin scribyra-sync
nix develop -c node scripts/service-smoke.mjs
```

The script starts a private PostgreSQL cluster in `tmp/` (from the dev shell),
installs the release binary into a fresh directory with a database URL file,
generates **synthetic disposable** capabilities, encrypts a test document,
uploads it and exchanges opaque bytes between two relay clients. It then takes
an online backup (`pg_dump`, then a copy of the blob directory), writes one more
object, reinstalls, restores into a fresh database and directory, runs `verify`
and checks the bytes. The object written after the dump is absent from the
restored metadata, as expected. It cleans up its directories and stops its exact
child processes. It contacts only loopback.

## Configuration and access

`SCRIBYRA_SERVICE_CONFIG` points to strict JSON. Missing fields use defaults;
unknown fields and invalid bounds fail startup. Every field also has an override
`SCRIBYRA_SERVICE_<UPPERCASE_FIELD>`: string and path fields (`BIND`, `DATA`,
`DATABASE_URL_FILE`, `S3_ENDPOINT` and so on) are plain text; numbers, booleans,
arrays and objects are JSON. Overrides win over the file. Paths are relative to
the process working directory; the data directory’s parent must already exist.
Configuration reload is a restart.

### Storage fields

| Field | Default | Meaning |
| --- | --- | --- |
| `database_url` | none | PostgreSQL URL. Contains a password for remote servers, so prefer `database_url_file`. Exactly one of the two is required |
| `database_url_file` | none | File holding the URL on its first line (a trailing newline is ignored) |
| `database_connections` | 10 | Connection pool size, 1–1000. One more connection holds the ownership lock, and a server-readable deployment one more for `LISTEN` |
| `blob_store` | `"filesystem"` | `"filesystem"` or `"s3"` |
| `data` | `service-data` | Filesystem blob directory (`objects/<namespace>/<sha256>`), created if missing |
| `s3_endpoint` | none | Service URL, for example `https://s3.eu-west-1.amazonaws.com` or `https://<account>.r2.cloudflarestorage.com`. `http://` is accepted only for `127.0.0.1`, `::1` or `localhost` |
| `s3_region` | none | Signing region (`auto` for R2, `garage` or your Garage `s3_region`) |
| `s3_bucket` | none | Existing bucket; the service never creates or lists buckets |
| `s3_access_key_id` | none | Access key ID |
| `s3_secret_access_key_file` | none | File holding the secret access key |
| `s3_path_style` | `false` | `true` for path-style URLs (Garage, MinIO, IP endpoints); `false` for virtual-host style (AWS, R2) |
| `s3_ca_file` | none | PEM file with the only certificate authority trusted for `s3_endpoint`, instead of the platform trust store. The Kubernetes operator sets it for its in-cluster Garage, which it serves over TLS with a private CA ([operator](operator.md)) |

All S3 fields are required when `blob_store` is `"s3"`. The S3 key needs only
object read, write and delete on its bucket, plus `HeadBucket` for readiness.
HTTPS certificates are checked against the platform trust store
(`SSL_CERT_FILE` can point to a private CA bundle). Each S3 request has a
30-second deadline; a timed-out or failed request is never acknowledged.

### Organisation fields

Added with organisation sync; the organisation routes document their use.

| Field | Default | Meaning |
| --- | --- | --- |
| `public_url` | none | The exact `https://` origin clients use for this service. Required by `deployment` |
| `deployment` | none | The organisation this service serves, its policy and its sign-in providers ([Deployment](#deployment)). Without it the service is a plain object store and relay: no sign-in, no organisation |
| `service_key_file` | none | A file with exactly 32 random bytes (`head -c 32 /dev/urandom`, mode 0400): the deployment's master key. Required when `deployment.encryption` is `"server"` (server-readable projects are sealed under keys it wraps); checked at start. Losing it makes server-readable projects unreadable; back it up separately from the database |
| `org_bytes` | 1073741824 | Default stored-bytes quota per organisation (1 GiB) |
| `entry_inline_bytes` | 65536 | Log entries up to this size are stored inline in PostgreSQL; larger ones go to the blob store |
| `sessions` | 10000 | Maximum live organisation sessions |
| `sso_recheck_tick_seconds` | 60 | How often the single sign-on recheck runs (1–3600) |
| `sso_jwks_refetch_seconds` | 60 | Minimum interval between key-set refetches caused by an unknown key ID (0–3600) |
| `sso_starts_per_minute` | 60 | 1–100000: sign-ins one source (an IPv4 address or an IPv6 /64) may start per minute on one replica (`429` beyond) |

### Deployment

A deployment is one service, its database and its blob store, serving **one organisation**. Its
policy is the `deployment` object of the configuration file (or `SCRIBYRA_SERVICE_DEPLOYMENT` as
JSON); every field is validated at start, and an inconsistent file refuses to start with
`{"event":"invalid_configuration","reason":"…"}` on stderr naming the field (never a value).

```json
"deployment": {
  "name": "Acme Lab",
  "encryption": "e2ee",
  "admins": ["it-admin@acme.org"],
  "providers": [
    {"id": "acme", "label": "Acme account", "issuer": "https://login.acme.org/realms/lab",
     "client_id": "scribyra", "client_secret_file": "/run/secrets/scribyra-oidc",
     "email_domains": ["acme.org"], "groups_claim": "groups",
     "admin_groups": ["scribyra-admins"], "member_groups": [],
     "guest": {"claim": "acct", "equals": "1"}, "offline_access": true}
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | required | 1–64 characters, shown in the app before and after sign-in |
| `encryption` | `"server"` | `"server"` (server-readable; needs `service_key_file`) or `"e2ee"` (end to end). Recorded in the database at first start: a later start with the other mode refuses (`{"event":"deployment_encryption_changed"}`). `"e2ee"` serves the [organisation routes](#organisation-routes-end-to-end-deployments) and answers `404` on `/v1/sr/`; `"server"` serves the [server-readable routes](#server-readable-projects) and answers `404` on the end-to-end ones |
| `offline` | `true` | `false` makes the deployment online-only (used by server-readable mode) |
| `compile` | `"browser"` | `"browser"`, `"server"` or `"both"`; the last two need `encryption: "server"` and `texlive` |
| `link_sharing` | `false` | Whether editors may create share links (later slice) |
| `guests` | `"off"` | `"off"` refuses provider guest accounts at sign-in; `"shared"` admits them as guests |
| `admins` | `[]` | Administrators whatever groups say, each one of: `provider:email` (a verified email at that configured provider, for example `acme:it-admin@acme.org`); a plain lowercase email, which matches only through a provider whose `email_domains` include its domain (an entry no provider vouches for refuses start); or `issuer#subject`. In an end-to-end deployment, only an administrator's sign-in may create the organisation (once) |
| `providers` | required | 1–16 OpenID Connect providers ([Sign-in](#single-sign-on-oidc)) |
| `quotas` | 100 GiB / 1 GiB / 10 GiB | `deployment_bytes`, `project_bytes`, `member_bytes` (server-readable mode) |
| `audit_retention_days` | 400 | 30–3650 |
| `compile_limits` | design section 6 | `cpu_seconds`, `wall_seconds`, `memory_mib`, `scratch_mib`, `output_mib`, `passes` (each job, [sandbox](#server-compile-sandbox)); `concurrency` (jobs per worker), `queue` (waiting jobs), `per_member_per_hour`, `per_project_per_minute`, `active_per_member`, `active_per_owner`, `retention_days` ([Server compile](#server-compile)) |
| `texlive` | none | A TeX Live tree, for server compile |

The organisation's ID is random, made at first start and recorded with the mode (a database that
already held exactly one organisation from before keeps it). `GET /v1/deployment` is public and
answers `{name, encryption, offline, compile, linkSharing, providers: [{id, label}], org}`;
issuers, client IDs and secrets never leave the service.

### Organisation routes (end-to-end deployments)

All bodies are JSON unless noted; every signed event and wrap is checked by the same Rust
rules the browsers use (`crates/core/src/membership.rs`). They serve the deployment's
organisation only, and only when `deployment.encryption` is `"e2ee"` (otherwise `404`).
Nothing here signs anyone in by itself: every device or recovery-key session needs the live
sign-in (`ScribyraSSO` login token) of the person the key belongs to.

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /v1/auth/challenge`, `POST /v1/auth/session` | An active device or recovery key, with its person's login | Device session. The key signs `scribyra-auth/2`, this service's `public_url`, the org, the key, the SHA-256 of the login token and the challenge; the request carries the login token (`sso`, required). A login that is missing, expired, someone else's or blocked at the provider is refused, and the session ends with the login |
| `GET /v1/orgs/{org}/info` | Anyone | Whether the org has a genesis, its log head and length, its sealed name |
| `GET`/`POST /v1/orgs/{org}/events` | Members; the genesis and join requests with a login instead of a session | The signed membership log (paged, with its length). The genesis is accepted once, only with a configured administrator's login, and links that login to the owner; a `person.request` needs a login nobody is linked to yet and links it |
| `GET /v1/orgs/{org}/people` | Member devices | Each person's verified sign-in email (`null` if the provider did not verify one) and provider (`{person: {email, provider, providerLabel}}`), for approving join requests and sharing |
| `GET`/`PUT /v1/orgs/{org}/keys`, `POST /v1/orgs/{org}/keys/report` | Member devices | Key wraps (one per sender), and reporting a wrap that does not open |
| `GET /v1/orgs/{org}/pending` | Member devices | Entitled keys that still lack a wrap, for the caller's projects (every epoch, so members keep earlier keys to read history) and the directory |
| `GET /v1/orgs/{org}/heads?since=&wait=` | Member devices | Long-poll notice of membership and project head changes (at most 25 s) |
| `GET /v1/orgs/{org}/device-links`, `POST /v1/orgs/{org}/device-links/sso` | A device of the person; the new browser with the person's login | Device requests: a member's new browser signs in and asks (15 minutes, four open per person); one of their devices adds it with a signed `device.add` after the person types the code the new browser shows |
| `GET`/`POST /v1/projects/{project}/log` | Project members (append: editors only) | Encrypted log entries, read to the `Scribyra-Log-Head` header. After a `project.epoch` event the service accepts only the new epoch: other new entries get `409 {"error":"epoch"}` (the client re-encrypts), identical repeats of entries it holds still get `200` |
| `GET`/`PUT /v1/projects/{project}/objects/{id}?epoch=` | Project members (upload: editors only, under the current epoch) | Encrypted assets and history objects under keyed IDs (64 hex, an HMAC the service cannot invert). Uploads are write-once per ID (`204` for identical bytes, `409` for other bytes), at most `object_bytes`, stored content-addressed under the object namespace `p-<project>` and charged to the global, organisation (`org_bytes`) and project (`namespace_bytes`, `namespace_objects`; every ID counts) quotas, `507` when full. Downloads are checked against the stored ciphertext hash (`500` if the stored copy is damaged; an identical re-upload repairs it) |

Project epochs: a signed `project.epoch {project, epoch, keyCommit, after}` event (from an
editor) is appended only if `after` does not reach
past the project's log head; the service records the head at that moment in
`projects.epoch_cutover`. Nothing old is deleted: earlier entries, objects and wraps stay so
members can read the history.

### Server-readable projects

With `deployment.encryption: "server"` the service is the authority for organisation projects
(design sections 1, 4 and 7). A project is an append-only log of **Yjs updates** that the service
sequences, checks with `yrs`, seals and stores; browsers keep a local copy and reconcile through
the log. Everything durable is in PostgreSQL and the blob store, so several replicas can serve one
deployment (with S3 blobs: a filesystem blob directory belongs to one process); changes reach
every replica's heads polls through `NOTIFY scribyra_sr` (the payload names the project, or
`a:<account>` when the projects an account can see or its sessions change; it only routes
wake-ups, and a woken poll reads its answer from the database).

**Updates are checked before `yrs` reads them.** `yrs` 0.25 trusts its input (it reserves memory
from untrusted lengths, recurses without a limit and assumes valid UTF-8), so every update a
client sends (`POST …/log`, and `state` at creation) first passes a strict lib0 v1 validator
(`update_check.rs`) that walks the whole update grammar as `yrs` reads it and refuses (`400`):
any length or count larger than the bytes left, varints longer than their type, `Any` nesting
deeper than 64, more than 2^20 structs or deleted ranges, an estimated decoded size over 256 MiB,
invalid UTF-8, clock or range overflow, unknown or reserved info bits and content kinds (weak
links included), and trailing bytes. An accepted update is then decoded and applied to an empty
document (inside `catch_unwind`, on a blocking thread). Replays check stored entries again and
turn a `yrs` panic into an error; a panic in any request handler answers `500` for that request.

**Sessions.** Every route needs `Authorization: ScribyraSSO <token>` from
[sign-in](#single-sign-on-oidc) (`401 {"error":"sign in required"}` without a valid one; a login
from before accounts existed gets `401 {"error":"sign in again"}`). Errors are JSON
`{"error": "<short text>"}`; every response is `Cache-Control: no-store`. IDs (projects,
accounts, invitations) are 64 lowercase hex characters; times are milliseconds since the epoch.
Emails are stored and compared in one normal form (surrounding space trimmed, Unicode lowercase
as Rust defines it, independent of the database's locale; no Unicode normalisation): sign-ins
store it in accounts and logins, invitations store it, and SQL compares stored values with `=`.
CORS allows `GET, HEAD, PUT, POST, PATCH, DELETE`, the request headers `Authorization`,
`Content-Type`, `Scribyra-Client`, `Scribyra-Client-Seq`, and exposes `Scribyra-Log-Head`,
`Scribyra-Log-Floor`, `Scribyra-Snapshot-Seq`, `Scribyra-Audit-Head` and `Content-Disposition`.

**Roles.** A project has one owner and shares with role `editor`, `reviewer` or `viewer`.

| Who | Read (details, log, snapshot, objects) | Write (log, objects), rename | Share (invite, withdraw, change, remove others) | Delete, transfer |
| --- | --- | --- | --- | --- |
| Owner | yes | yes | yes | yes |
| Editor | yes | yes | yes (not a guest) | no (`403`) |
| Reviewer, viewer | yes | no (`403`; their writes follow in slice 12) | no (`403`) | no (`403`) |
| Anyone else | `404 {"error":"unknown project"}` on every project route, as if it did not exist | | | |

Guests (`guests: "shared"`) see only projects shared with them and cannot create projects
(`403`). Administrators read a project without a share only after an audited "Open as
administrator" ([Administration](#administration-and-the-audit-log)): for 12 hours their role on
it is `admin` (read like a viewer, never write); "Edit as administrator" gives them an explicit
editor share. Anyone but the owner may leave a project (remove their own share).

| Route | Body → answer |
| --- | --- |
| `GET /v1/sr/projects` | → `200 {account, role, projects: [{id, name, role, head, size, created, updated, owner: {account, name, email, provider}, adminOpened}]}` (owned and shared, and for an administrator the projects they opened as administrator, `role: "admin"`; newest change first; `role` at the top is the deployment role; `adminOpened` is when an administrator last opened the project, or `null`) |
| `POST /v1/sr/projects` | `{name, id?, state?, client?, clientSeq?}` → `201 {project, seq}` (members and admins only). `name` 1–200 characters. `id` (64 hex) lets a retry find the project it created: the project's ID is then SHA-256 of `scribyra-sr-project/1\n<account>\n<id>` (hex), so the app can compute it beforehand, a repeat by the same account gets `200` and the same body, and the same `id` from another account makes that account's own project (nothing tells anyone whether another account used it). Without `id` the ID is random. `state` is base64 of a Yjs update (the project's initial state, at most `sr_entry_bytes`), appended as the first entry under `client`/`clientSeq` (default `initial`/1); `seq` is its sequence number or `null`. `400` for a bad name or a state that is not a Yjs update, `413` too large, `507` over quota (the new project is then not kept) |
| `GET /v1/sr/projects/{p}` | → `200` project details: `{id, name, role, owner: {account, name, email, provider, role:"owner"}, head, floor, snapshot, size, created, updated, members: [{account, name, email, provider, role}] (owner first), invitations: [{id, email, provider, role, created, expires}], adminActivity: [{action, time}]}`. Invitations are listed for the owner and editors only. Emails are verified ones or `null`. `adminActivity` is the newest ten administrator actions on the project from the audit log (`project.admin_open`, `project.admin_edit`, and transfers and renames by an administrator), which the app shows as "An administrator opened this project on …" |
| `PATCH /v1/sr/projects/{p}` | `{name}` → `200` details (owner, editors) |
| `DELETE /v1/sr/projects/{p}` | → `204` (owner). Crypto-erase: the wrapped key is removed in the same transaction that marks the project deleted; everything sealed under it is unreadable from then on, and maintenance removes rows and blobs. Members' later requests get `404` |
| `POST /v1/sr/projects/{p}/log` | Body: one Yjs update (`application/octet-stream`, at most `sr_entry_bytes`, else `413`), headers `Scribyra-Client` (1–64 of `A-Z a-z 0-9 - _`, one per browser) and `Scribyra-Client-Seq` (1 to 2^53). → `201 {seq}` after commit (the durable acknowledgement); `200 {seq}` with the original number when the same account sends the same `(client, clientSeq)` again with the same bytes; `409` with other bytes. Slots belong to the account: another member using the same client ID has slots of their own and cannot block these. `400` without both headers or when the body is not a valid Yjs update (v1 encoding, checked as above); `403` reviewer/viewer; `507 {"error":"quota"}`. Write access is checked again under the project's lock inside the append's transaction, so a member removed (`404`) or made a reviewer or viewer (`403`) while their append waits does not get it stored |
| `GET /v1/sr/projects/{p}/log?after=n&limit=k` | → `200`, `application/octet-stream`: entries with `seq > n` in order, each framed as `seq` (u64 big-endian), length (u32 big-endian), the update. `limit` 1–1000 (default 256); a page stops at 16 MiB (at least one entry). Headers `Scribyra-Log-Head` (read again until you reach it), `Scribyra-Log-Floor`, `Scribyra-Snapshot-Seq`. With `n` below the floor: `410 {"error":"compacted", floor, snapshot}` (same headers): fetch the snapshot, then the log after it. The same `410` answers a page whose bodies the floor passed while it was being read |
| `GET /v1/sr/projects/{p}/snapshot` | → `200`, the whole Yjs state (one update, v1) covering `Scribyra-Snapshot-Seq`, with the log headers; `404 {"error":"no snapshot"}` before the first one (read the log from 0); `410 {"error":"compacted", floor, snapshot}` when a newer snapshot replaced it while it was read (ask again) |
| `PUT /v1/sr/projects/{p}/objects/{sha256}` | Body: an asset or history object's plaintext (at most `sr_object_bytes`). → `201` stored, `204` already stored, `400` when the body's SHA-256 is not the path's, `403` reviewer/viewer (checked again inside the upload's transaction, as for appends), `413`, `507`, `503` when `uploads` are all busy. Upload objects before the update that references them |
| `GET /v1/sr/projects/{p}/objects/{sha256}` | → `200` the plaintext (checked against its hash), `404 {"error":"unknown object"}` |
| `POST /v1/sr/projects/{p}/invitations` | `{email, role}` (owner, editors). `email` is a plain email or `provider:email`. An email counts only at a provider that vouches for it (the same rule as `admins`): a plain email names accounts at providers whose `email_domains` include its domain, or at the deployment's only provider; `provider:email` names that provider's accounts. With several providers and none vouching, a plain email is `400` (name the provider); an unknown provider is `400`. If active accounts with that **verified** email exist at those providers, they are shared at once: `201 {status:"shared", project}` (`200` when the share existed; the role is updated). Otherwise `201 {status:"pending", invitation: {id, email, provider, role, expires}, project}` (`provider` is `null` for "any vouching provider"): the first sign-in with that verified email at such a provider turns it into a share. Inviting the same email again updates the pending invitation's role and expiry. Invitations expire after `sr_invitation_days` (30). `409` for the owner's own email, `400` bad email or role. No email is sent in this release |
| `DELETE /v1/sr/projects/{p}/invitations/{id}` | → `204` withdrawn, `404` unknown or no longer pending |
| `PUT /v1/sr/projects/{p}/members/{account}` | `{role}` → `200` details (owner, editors), `404` if not a member |
| `DELETE /v1/sr/projects/{p}/members/{account}` | → `204`. Owner and editors remove others; anyone removes themselves (leave), except the owner (`409`) |
| `POST /v1/sr/projects/{p}/owner` | `{account}` (owner) → `200` details: that member (not a guest, `409`) becomes the owner and the old owner an editor |
| `GET /v1/sr/heads?since=v&wait=s` | → `200 {version, projects: {"<id>": {head, role, name, adminOpened?}}}` for every project the caller can open (`adminOpened`: when an administrator last opened it). With `since` equal to the current `version` it waits up to `wait` seconds (at most 25) until something the caller sees changes (an entry, a rename, a share or invitation acceptance, a removal or deletion), on any replica; then or at the deadline it answers. A notice only: read the logs afterwards. Only notices about the caller's projects or account wake a poll. An account keeps at most 4 polls waiting per replica: a fifth ends the oldest at once with its current state and `superseded: true` (keep one poll per account and do not re-poll a superseded answer at once). A sign-out, revocation or block ends the session's polls at once with `401`. Shutdown ends waiting polls at once |

**Sealing at rest.** Each project has a random 32-byte data key, stored only as
`nonce ‖ XChaCha20-Poly1305(master key, nonce, "scribyra-sr-key/1\n<deployment>\n<project>", key)`
in `sr_projects.data_key_wrapped`; the master key is `service_key_file`, never in the database.
Entry bodies, snapshots and objects are sealed under the data key with associated data
`scribyra-sr/1\n<project>\n<update|snapshot|object>\n<seq|hash>`, so sealed bytes cannot be moved
between projects or slots. Entries up to `entry_inline_bytes` (sealed) are stored inline in
PostgreSQL, larger ones and all objects in the blob store under `sr/<project>/…`. A database dump
or a bucket copy without the key file shows metadata only (names, emails, sizes, shares, times).
Back up the key file separately: without it no project opens.

**Snapshots, floor and maintenance.** After `sr_snapshot_entries` entries or `sr_snapshot_bytes`
stored bytes since the last snapshot, the service replays the snapshot and entries with `yrs`
(keeping every tombstone) and writes a new snapshot covering the head. Once a snapshot is older
than `sr_retention_seconds` (7 days), the floor moves to it: entry bodies at or below it and
older snapshots are dropped (entry rows stay, so a late retry still gets its sequence number).
Every `sr_maintenance_seconds` (and right after a deletion) a pass on any replica erases deleted
projects' rows, moves floors and removes queued blobs (`sr_garbage`); rows are claimed with
`SKIP LOCKED`, so replicas do not collide. A crash between a commit and a blob deletion leaves
at most an orphaned sealed blob, never a dangling row.

**Quotas.** `deployment.quotas` count sealed bytes: the deployment (`usage` row
`sr:deployment`, locked by every charging write), each project (`project_bytes`) and each
owner's projects together (`member_bytes`). A write over any of them is `507` and stores
nothing; the server's own snapshots are charged but never refused. Transfers do not check the
new owner's quota.

**The browser** (`web/org-server.js`, `web/org-server-dialog.js`). Remote backup → the
deployment's address shows its name, "Stored on Acme's server, which can read it. Acme's
administrators can open it." and one "Sign in with …" button per provider; nothing is contacted
or stored before that. Signed in, the dialog lists the deployment's projects (on this device, or
**Open**, which downloads the snapshot and log into a new local copy and opens it) with their
state (Saved on this device · Syncing… · Synced · Waiting to sync · Read only · No longer shared
with you), **Add to Acme** for personal projects (a copy with a new lineage becomes the new
project; the personal project stays), **Share** (people with access and their roles, pending
invitations, invite by email with a role, change a role, remove, withdraw) and **Sign out**
(`POST /v1/sso/logout`). Each local copy has its own client ID (`<browser>-<copy>`, so a copy
downloaded again never reuses sequence numbers), an IndexedDB outbox written before each send, a
cursor and the server's Yjs state vector; uploads are `encodeStateAsUpdate(doc, serverVector)`,
one at a time per project, at most every 2 s while typing (at once when online-only), after the
assets and named-version objects they refer to. Catch-up validates the merged project like a
replica from another tab before the merged-head save and then advances the cursor (the save and
the cursor are in two databases: a crash between them repeats idempotent work, never loses it).
Reviewers and viewers open with their role's modes and send nothing. With `offline: false` the
editor is read only unless the service answered within the last 30 s and nothing is unsent
("Reconnecting — editing is paused because Acme keeps projects online only."), and local copies
are deleted at sign-out, when the service refuses the session, and at start without a valid
session.

**Materialisation** (for export and compile): `server_projects::Projects::materialise` replays a
project and returns its files with paths (from the `files` tree, the same rules as the app),
texts, asset objects (with their bytes when stored), the main file and the name.

### Administration and the audit log

Design section 5, slice 10. **Audit log.** Every security-relevant action is one row of
`audit_events` (migration `0015`): `seq` (gap-free), `time`, `actor` (an account ID or `system`),
`ip` (the client, or the address a trusted proxy names), `action`, `target_type`/`target_id`, a
small JSON `detail` (at most 4 KiB), `prev` and `hash` = SHA-256(prev bytes ‖ the row's canonical
text: `jsonb_build_array(seq, time in µs, actor, ip or "", action, target_type or "", target_id or
"", detail)::text`), 64 zeros before the first row. Rows are written only by the SQL function
`audit_append`, which locks the one `audit_head` row, so appends from every replica form one line
(and `time` never decreases along it); a trigger refuses direct `INSERT`, every `UPDATE`, `DELETE`
outside `audit_purge`, and `TRUNCATE` (also on `audit_head`). The trigger guards against mistakes
and the service's own bugs; anyone who can disable triggers (a database superuser, or the table's
owner) can still change rows, and the chain is what makes that visible. Events are written in the
transaction of the action they record, so an action and its event commit together.

| Action | Recorded when | Actor, target, detail |
| --- | --- | --- |
| `session.sign_in`, `session.sign_out` | A sign-in is redeemed; a session signs out | the account; `{provider, role}` |
| `session.refused` | A sign-in in progress is refused (`reason`: a claim check, `guest`, `not_member`, `token_exchange`, `account_disabled`, `account_removed`, …) | `system` (or the account, when known); `{reason, provider}`. Requests with an unknown `state` are not recorded |
| `session.revoked`, `account.blocked` | Back-channel logout, a refused refresh token (`invalid_grant` blocks the account), the group rules at a recheck | `system`; `{reason, provider}` |
| `account.created`, `account.role_changed` | First sign-in; a role the provider's groups or an administrator changed | `{provider, role}`; `{from, to, by: "provider" or "admin"}` |
| `account.disabled`, `account.unblocked`, `account.removed` | Admin area | `{from}`; removal `{transferredTo, projects, shares}` |
| `project.created`, `project.renamed`, `project.deleted`, `project.transferred` | Owners, editors and administrators (`admin: true` when an administrator acted) | target the project |
| `project.admin_open`, `project.admin_edit` | Open or edit as administrator | |
| `project.compile_mode` | `PUT …/settings` | `{mode}` |
| `share.created`, `share.changed`, `share.removed` | Sharing (including a member leaving, `left: true`) | `{account, role}` |
| `invitation.created`, `invitation.accepted`, `invitation.withdrawn` | Invitations (the invitee's email is not recorded) | `{invitation, role, provider}` |
| `export.everything`, `audit.export` | Admin exports | filters and format |
| `audit.purge` | Retention | `system`; `{count, last_seq, last_hash, before}` |
| `deployment.start` | Each start of `serve` | `system`; `{policy, encryption, schema, version}` (`policy` is the SHA-256 of the deployment object, so configuration changes show) |

Never recorded: content, ID or session tokens, provider tokens; emails only as account details
(the admin routes add the actor's name and email from `accounts`).

**Retention.** Every `audit_purge_seconds` (daily) a task on each replica deletes the events older
than `deployment.audit_retention_days` (30–3650, default 400) through `audit_purge`, which appends
`audit.purge` with the count and the last purged event's sequence number and hash; the head's lock
keeps two replicas from purging the same events.

**`scribyra-sync audit verify [<seq>:<hash>]`** reads the log (no ownership lock, so it runs beside
serving replicas) and recomputes every hash outside the database's functions; it checks that
sequence numbers have no gap, that each `prev` is the previous hash, that the first kept event is
the chain's start or anchored by an `audit.purge` (its `last_seq` + 1 and `last_hash`), and that
`audit_head` names the last event; with `<seq>:<hash>` (the head an export carries) also that this
event, if still kept, has that hash. It prints `{"event":"audit_verify","ok":…,"events":n,"first":…,
"last":…,"head":{"seq","hash"},"anchored":…,"problems":[{"seq","problem"}]}` and exits 0 only when
the chain holds.

**Admin routes** (`/v1/admin/…`, `Authorization: ScribyraSSO <token>` of an administrator; `401`
without a session, `403` for everyone else). An administrator is one by `admins`, by
`admin_groups`, or by an administrator's grant in the admin area; the configuration's own
administrators can only be changed in the configuration (or at the provider).

| Route | Body → answer |
| --- | --- |
| `GET /v1/admin/members?removed=true` | → `{account, members: [{account, name, email, provider, role, state, guest, granted, created, lastSeen, storage, projects}]}` (`storage`: sealed bytes of owned projects; removed accounts only with `removed=true`) |
| `PUT /v1/admin/members/{a}/role` | `{role: "admin"|"member"}` → the member. `409` for guests (they stay guests), for an administrator by the configuration, a removed account, or the caller's own account |
| `POST /v1/admin/members/{a}/disable` | → the member: sessions revoked at once (waiting heads polls answer `401`), sign-in refused (`403 "this account is disabled"`) |
| `POST /v1/admin/members/{a}/unblock` | → the member: a disabled, blocked or removed account may sign in again |
| `POST /v1/admin/members/{a}/remove` | `{transfer?}` → `{account, state: "removed", transferredTo, projects}`: sessions revoked, every share removed, owned projects transferred to `transfer` (an active member or administrator; default the caller); sign-in refused (`403 "this account was removed"`) until unblocked. End-to-end: removal from the organisation still needs an administrator's app to sign `person.remove` |
| `GET /v1/admin/projects` | → `{encryption: "server", projects: [{id, name, owner, members, size, head, created, updated, role, openUntil}]}`; end-to-end: `{encryption: "e2ee", projects: [{id, size, head, epoch}]}` |
| `POST /v1/admin/projects/{p}/open` | → project details with `role: "admin"`: read access (log, snapshot, objects, heads) for 12 hours (`sr_admin_opens`), recorded as `project.admin_open` |
| `POST /v1/admin/projects/{p}/edit` | → details: an editor share for the administrator (`project.admin_edit`) |
| `POST /v1/admin/projects/{p}/owner` | `{account}` → `{id, owner}`: an active member or administrator becomes the owner; the previous owner keeps an editor share |
| `DELETE /v1/admin/projects/{p}` | → `204`: crypto-erase as the owner's delete; end-to-end: the ciphertext the service holds (log, objects, key wraps) is removed |
| `GET /v1/admin/export` | → a streamed zip (stored, UTF-8 names, ZIP64 when large): `projects/<name>-<id8>/<path>` for every file of every project materialised from the server's state (assets whose object is missing are listed in `projects.json` as `missing`), `projects.json`, `members.json`, `audit.jsonl` (every event and a final `{"head": {seq, hash}}`). One export at a time per replica (`429`) |
| `GET /v1/admin/audit?actor&action&target&targetType&from&to&before&limit` | → `{events: [{seq, time, actor, actorName, actorEmail, ip, action, targetType, target, detail, prev, hash}], head: {seq, hash}, next}` newest first; `action` matches an action or its first part (`project`); `from`/`to` in ms; `limit` ≤ 500; page with `before=next` |
| `GET /v1/admin/audit/export?…&format=jsonl|csv` | → the filtered events oldest first, as JSON lines ending with `{"head": …}` or CSV (every field quoted, formula prefixes defused, a final `# head <seq>:<hash>` line); header `Scribyra-Audit-Head: <seq>:<hash>`; recorded as `audit.export` |
| `GET /v1/admin/settings` | → the deployment's policy (providers without client IDs or secret files) and its `policy` hash |

In end-to-end mode open, edit, transfer and export answer `409` (the service cannot read
projects); members, the project list, deletion and the audit log work.

**The admin area in the app** (`web/org-admin-dialog.js`): Remote backup → **Admin** (shown to
administrators only): Members (role, Disable/Unblock, Remove with the new owner of their projects),
Projects (Open as administrator, which opens a read-only copy labelled "Opened as administrator ·
Read only"; Transfer; Delete with confirmation), Audit log (filters by actor, action, target and
dates; Export JSON lines and CSV), Export (downloads the zip) and Settings (read only). Members
see "An administrator opened this project on …" on the project in their list and in its sharing
panel. The admin area is for server-readable deployments; an end-to-end organisation's
administrators use the routes above.

### Access and limits

A principal is `{ "token_hash": "64 lowercase hex", "namespace": "64 lowercase
hex", "storage": true, "relay": true }`. Generate a random 32-byte bearer
encoded as hex, hash its UTF-8 representation with SHA-256, and store only the
hash. Generate the namespace independently with 32 random bytes. Provision the
bearer to intended clients through an authenticated private channel. Never put
it in URLs, source control, browser local storage or logs. This is operator
provisioning, not a user/account system. Capabilities sharing a namespace share
its quota; rights remain independent. Revoke by removing a hash and restarting.

`origins` is an exact list such as `["https://editor.example.org"]`, without
trailing slashes. Empty denies all browser origins. Non-browser clients may
omit Origin but still need authorization. Origins are not authentication.
No wildcard, credentials-in-URL or cookie authentication is supported.

| Field | Default | Meaning |
| --- | --- | --- |
| `object_bytes` | 8388608 | Maximum PUT; 16-byte minimum, maximum configurable 64 MiB |
| `namespace_bytes`, `total_bytes` | 268435456, 1073741824 | Durable payload quota |
| `namespace_objects`, `total_objects` | 10000, 100000 | Durable object count quota |
| `tcp_connections` | 128 | Total sockets, including upgrades and pre-HTTP clients; 30-second idle timeout |
| `http_concurrency` | 16 | Non-upload handlers/download transfers and independent disk-job count |
| `requests_per_second` | 100 | Separate one-second windows per anonymous source, authenticated namespace, and health source |
| `source_requests_per_second`, `rate_sources` | 1000, 4096 | Pre-authentication request ceiling per source; maximum tracked sources in each of the independent ordinary/health tables |
| `trusted_proxies` | `[]` | Exact peer IPs allowed to provide one replacement client IP in `X-Forwarded-For`; no CIDRs or forwarded chains |
| `uploads`, `principal_uploads`, `namespace_uploads` | 6, 3, 3 | Uploads in flight globally, per capability and per namespace; separate from other HTTP handlers |
| `response_bytes`, `namespace_downloads` | 33554432, 2 | Global resident download payload budget (32 MiB), concurrent downloads per namespace |
| `send_seconds` | 15 | Absolute download send deadline, configurable 1–120 seconds |
| `connections`, `rooms` | 100, 20 | Pending/authenticated WebSockets, nonempty live rooms |
| `namespace_connections`, `namespace_rooms` | 20, 4 | Authenticated connections and nonempty rooms per namespace, shared by all its capabilities |
| `room_attempts`, `namespace_room_attempts` | 1024, 128 | Retained attempt records globally/per namespace, including empty rooms until their original expiry |
| `room_seconds` | 120 | Absolute lifetime, configurable 1–600 seconds |
| `frame_bytes`, `messages_per_second` | 65536, 60 | WebSocket frame/message size, per-sender one-second window |

PUT authenticates the capability, storage right and namespace before polling the
body. Upload slots remain held through disk completion, including timed-out disk
jobs. Exhausting one capability/namespace returns 429 before reading its body;
other namespaces retain upload capacity at the defaults. Liveness uses no
transfer slot and has an independent source-rate table. The global TCP ceiling
still applies; liveness is not reserved socket capacity.

GET reserves the metadata-declared size **before allocation** and reads exactly
that size plus a one-byte corruption check. The payload owner retains its byte,
namespace and HTTP permits through socket closure, including Hyper's pending
writes. Frames are at most 64 KiB, and the listener supports vectored writes.
Downloads close their HTTP connection after the response and have an absolute
send deadline; trickling bytes cannot reset it. HEAD uses the same verified read
path and releases the reservation when its connection closes. Existing objects
larger than a newly lowered response budget return 503; size that budget for the
largest retained object, not just new PUTs. Configuration requires
`response_bytes >= object_bytes` and caps the byte budget at 1 GiB. For fair
sharing at maximum object size, budget for at least two namespaces
(`2 × namespace_downloads × object_bytes`), as the defaults do. Substitute the
largest retained size if older objects exceed the new PUT limit.

The final member leaving a room releases its live-room slot and broadcast queue.
A small empty record preserves the original attempt deadline; rejoining before
expiry cannot restart the clock. Unexpired records are never evicted to admit a
new attempt. The separate attempt quotas bound churn without charging a different
namespace's live-room quota. Expired identifiers must not be reused by clients;
reuse after expiry/restart is not a replay-protection mechanism.

These are admission ceilings, not a scheduler or reserved tenancy. At defaults,
one provisioned namespace cannot fill the global upload, download, room,
connection or attempt pools. Several hostile namespaces can exhaust shared
pools. The TCP ceiling and per-source admission apply before identity is known;
TLS/proxy limits below cover that boundary. Keep namespace ceilings below global ceilings
when tuning for fair sharing. Provisioning multiple capabilities in one namespace
does not multiply its allowance.

Rooms allow five members, 16 buffered frames and two seconds per send. First
WebSocket authentication is limited to 1024 bytes and three seconds. HTTP
handlers time out after 15 seconds. Global overload returns 429 or 503; quota
returns 507; size returns 413; invalid framing/hash returns 400. Unauthorized
requests return 401/403. No partial durable success is reported. Quotas count
payload bytes. Usage is kept in a `usage` table, one row per scope (`global`,
`namespace:<id>`); a write locks the rows it charges in a fixed order (global
first), checks the limits and inserts the object in the same transaction, so
concurrent writes never exceed a quota and a retry of an existing object
charges nothing. Reserve extra disk for PostgreSQL (tables, indexes, WAL),
directory entries, temporary writes and backups. This version retains objects
indefinitely; per-project deletion/GC is not yet implemented.

For a small installation, start with **1 GiB RAM and at least 2 GiB writable
disk** for the service/proxy, excluding backups (planning estimates, not measured
minimums). Default retained download payloads are bounded to 32 MiB regardless
of paused-client count. Six uploads contribute up to 48 MiB of accepted bodies;
allow another 48 MiB for collection copies and up to 8 MiB for duplicate-write
verification. Twenty full relay queues contribute up to 20 MiB plus active frames.
The database pool, allocator retention, task/header/TLS buffers, kernel sockets and the proxy
need additional headroom: these payload ceilings are **not a whole-process RSS
limit**. Use supervisor/container memory limits and observe the actual workload.
Default durable payloads consume at most 1 GiB; metadata, temporary writes and
free space need the rest. Raise disk and memory together when increasing limits.

PostgreSQL runs beside the service. A small instance works with its defaults
plus about 256 MiB of RAM; each pooled connection is a backend process of a few
MiB, so keep `database_connections` modest (the default 10 suffices because
writes serialize on quota rows and uploads are capped at `uploads`). Metadata is
small: about 200 bytes per object row including its index, so 100,000 objects
take roughly 20 MiB plus WAL (by default up to 1 GiB of WAL is retained between
checkpoints; plan for it). With filesystem blobs, disk holds payloads, one
in-flight temporary file per upload and backups. With S3 blobs the service disk
holds only PostgreSQL, and the bucket holds payloads.
The regression's 48 MiB RSS-growth bound applies to its stated download probe,
not every possible combined workload.

## Protocol and browser adapter

`PUT /v1/objects/<namespace>/<ciphertext-sha256>` uses a Bearer Authorization
header and octet-stream body. 201 means persisted, 204 means the exact object
already exists. GET/HEAD returns the same bytes under the same grant. All
objects are immutable. Clients must verify hash and authenticated encryption
before applying anything. The service cannot detect a client that deliberately
uploads plaintext. No plaintext merge or document decoder runs on the server.

`/v1/connect` is a WebSocket: first send
`{version:1,bearer,room,connection}`, then await `{version:1,ready:true}`.
Both identifiers are fresh 32-byte random hex strings. Binary frames then go to
other attached members in the same principal namespace and room. They are not
stored. Dropped, lagged or expired connections need a fresh attempt. Frames
have no durable acknowledgement and must never be called a remote backup.

`createInvitation()` generates room/key locally. Pass the invitation through a
trusted out-of-band channel, then use
`connectService({endpoint,bearer,invitation,onSignal,onError})`. `send` accepts
only offer/answer SDP or ICE candidates; `close` releases the socket. There is
no default endpoint. The adapter authenticates encrypted room/sender/sequence
context and rejects replay/reflection/tampering before `onSignal`. A verified
high-entropy invitation is mandatory: a short code/password is not supported.
Create a new invitation (room **and** key) for every attempt; invitation reuse
across restarts is unsupported, and replay state is session-local. Chromium may
require Local Network Access permission when a hosted page contacts a local
service; the browser fixture grants this permission explicitly. D must expose
that permission/failure in its UI. The server sees pairing, timing, IP addresses and lengths, but cannot recover
connection details without the invitation key. It can always deny service.

D will supply UI, persistent identity, signed membership and project replication.
The retained browser test demonstrates normal immediate local descriptions and
trickled ICE in **both** directions, with no deferred answer and no ICE servers.
Its direct data-channel traffic never passes through the service.

## Single sign-on (OIDC)

Signing in is OpenID Connect only, through the providers listed in `deployment.providers`
(several per deployment). The service is a confidential relying party of each (authorization
code flow, PKCE S256, `client_secret_basic`) and has no sign-in of its own: no passwords,
passkeys, setup codes, invitation links or link codes. A login proves who someone is at the
provider and carries their deployment role (administrator, member or guest); it grants no
project keys. `public_url` and `origins` must be set: the app's origin must be in `origins`,
because the service only ever redirects back to a configured origin.

**Register the service at each provider** as a confidential web client with:

- redirect URI `<public_url>/v1/sso/callback/<id>` (exactly; `<id>` is the provider's `id` below,
  so each provider has its own and a response is only accepted at the provider it belongs to),
- grant types authorization code and refresh token,
- optionally the back-channel logout URI `<public_url>/v1/sso/backchannel`.

**Configure each provider** in `deployment.providers`:

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | required | Short lowercase name (`a-z`, `0-9`, `-`), unique; the app sends it to `POST /v1/sso/start` |
| `label` | required | Shown on the app's "Sign in with …" button |
| `issuer` | required | `https://` (`http://` only on loopback), without query; must equal the `issuer` in the provider's `/.well-known/openid-configuration` character for character, including any trailing slash, or sign-in is refused |
| `client_id`, `client_secret_file` | required | The client; the secret is read from its file (one line) when used, so a rotated file takes effect without a restart. It is never stored in the database, printed or logged; an unreadable file refuses start |
| `email_domains` | `[]` | When set, only ID tokens with `email_verified: true` and an email in one of these lowercase domains are admitted (and, when the token has a Google `hd` claim, `hd` must be that email's domain) |
| `groups_claim` | none | A claim holding an array of group names (at most 256 kept, longer than 256 bytes dropped); Entra ID app roles: `"roles"` |
| `admin_groups` | `[]` | Members of these groups are administrators (needs `groups_claim`) |
| `member_groups` | `[]` | When set, only members of these groups (or administrators) may sign in (needs `groups_claim`) |
| `guest` | none | `{"claim", "equals"}`: the claim and value that mark a guest account (Entra `acct` = `1`). With `guests: "off"` such sign-ins are refused |
| `offline_access` | `false` | Adds the `offline_access` scope, which some providers require before they issue refresh tokens |
| `session_hours` | 12 | 1–720: how long a login lasts |
| `recheck_minutes` | 10 | 1–1440: how often a login with a refresh token is rechecked |
| `scopes` | `[]` | Extra scopes beyond `openid email profile` |

Group, guest and member rules apply at sign-in (refused sign-ins return to the app with
`#scribyra-sso-error=guest` or `not_member`), again whenever a login is used (so a configuration
change takes effect at once), and at each recheck from a refreshed ID token's claims. A person's
account is the pair (provider, subject): the same email at two providers is two accounts. Every
sign-in creates or refreshes the account (table `accounts`: provider, issuer, subject, email and
whether it is verified, name, role, guest mark, state `active`, `blocked` or `disabled`, last
seen); a disabled account cannot sign in.

`POST /v1/sso/start {provider, return, challenge}` → `{url}`; the provider redirects to
`/v1/sso/callback/<provider>`, which redirects to `<return>/#scribyra-sso=<grant>&org=<org>`;
`POST /v1/sso/redeem {code, verifier}` → `{token, expires, org, provider, role, subject, person,
state, account, email, name}` (`state` is `unlinked`, `linked` or `blocked`; `account` is the
account ID; `email` is the **verified** email or `null`; `subject.email` is whatever the provider
sent, for the person's own display only); `GET /v1/sso/me` (same body without `token`) and
`POST /v1/sso/logout` take `Authorization: ScribyraSSO <token>`. Sign-ins in progress, one-time
grants and used back-channel logout tokens are in PostgreSQL (`sso_flows`, `sso_grants`,
`sso_logout_jtis`; only hashes of states and grant codes), so any replica can finish a sign-in
another one started. A source (an IPv4 address, or an IPv6 /64: what one host or subscriber
holds) holds at most eight sign-ins in progress (a ninth replaces its oldest) and may start
`sso_starts_per_minute` a minute per replica (`429` beyond); a network (IPv4 /24, IPv6 /48) holds
at most 64 (its oldest replaced); and a full table (4096) or provider (256) drops the oldest
sign-in of the network that holds the most, rather than refusing or dropping the oldest
overall, so a network with few sign-ins keeps them while any other network holds more. A
source holds at most eight end-to-end session challenges.

**Removed with slice 8** (no replacement command): `scribyra-sync org create` and setup codes,
`scribyra-sync org sso` and its table `org_sso`, invitation links, link-code device linking
(`POST /v1/orgs/{org}/device-links`, `…/device-links/{link}`), device-key-only sessions,
organisation-managed mode and admin read access. Migration 0007 drops them from an existing
database (pending link-code links are deleted; logins from before providers were configured are
revoked).

**What is stored.** In PostgreSQL: each login's provider, subject, email, name, groups, guest
mark and provider session ID, the SHA-256 of the login token (never the token), and the
provider's **refresh token in plain text** (table `sso_logins`), plus the links between
provider subjects and members (`sso_links`, with the email only when verified). Client secrets stay in their files. Protect database access and backups
accordingly. Expired and revoked logins are deleted after a week. Discovery documents
and key sets are cached in memory for an hour; an unknown key ID refetches the key set
at most once per `sso_jwks_refetch_seconds`, so key rotation needs no restart.

**Accepted tokens.** ID tokens must be signed with `RS256` (2048-bit or larger keys),
`ES256` or `EdDSA` by a key in the provider's key set, matching the key's type and
`alg`; `none` and `HS*` are always refused. `iss` must match exactly, `aud` must
contain the client ID (with several audiences, `azp` must be the client ID), `exp` must
not have passed (two minutes of clock skew allowed), `iat` must not be more than five
minutes ahead, and `nonce` must match the sign-in. Keep the service's clock synchronised.

**Recheck and blocking.** Every `sso_recheck_tick_seconds`, logins that hold a refresh
token and were last checked more than their provider's `recheck_minutes` ago are refreshed at
the provider (rotated refresh tokens are stored). Every replica runs the recheck; a due login
is claimed first (`FOR UPDATE SKIP LOCKED`, its `checked` time moved in the same statement), so
only one replica ever uses a given refresh token: two using it would look like token theft to a
provider with reuse detection. A refreshed ID token, when the provider sends
one, is verified like a sign-in's (without the nonce) and updates the login's groups and guest
mark; an account that no longer passes the group or guest rules has its logins revoked. If the
provider answers `invalid_grant` (account disabled or deleted, consent or session revoked),
every login of that person is revoked and their link is **blocked**: they can sign in at the
provider again, but stay blocked until an administrator unlinks them. Their account is marked
`blocked` too; a later sign-in that the provider admits makes it `active` again. Any other
client error (except 408 and 429) revokes only that login without blocking, so a
wrong client secret does not block everyone. Network and server errors keep the login
and retry on the next pass (the claim is undone); the service logs only counters
(`{"event":"sso_recheck",…}`). Logins without a refresh token cannot be rechecked and
simply expire after `session_hours`: **group changes, guest marks and provider disablement
reach such logins only when they expire**, so set `offline_access: true` (or use a provider that
issues refresh tokens without it, like Keycloak) wherever that matters. Each revocation of a linked member's login (also a
sign-out or a back-channel logout) closes their device sessions at once.

**Back-channel logout** (OpenID Connect Back-Channel Logout 1.0) is accepted at
`/v1/sso/backchannel`: a logout token signed like an ID token, with the back-channel
logout event, no `nonce`, and `sub` and/or `sid`, revokes the matching logins. Only
configured issuers are contacted to verify it.

**Logging.** The service never logs tokens, codes, client secrets, ID tokens, emails or
provider error text; failures are logged as fixed reason codes
(`{"event":"sso_refused","reason":"claim_aud"}`) and the app receives a short code in
the redirect fragment (`#scribyra-sso-error=id_token`).

**Provider notes.**

- *Microsoft Entra ID*: use the tenant-specific issuer
  `https://login.microsoftonline.com/<tenant-id>/v2.0`, never `common` or
  `organizations` (their discovery `issuer` is a template and will not match). Use
  `offline_access` to receive refresh tokens. The `email` claim may be missing or not
  verified for many accounts, so `email_domains` can refuse legitimate users; test it
  with your tenant before relying on it. Group claims are object IDs by default, and a
  user in too many groups gets an overage indicator instead of the list, so prefer app roles
  (`groups_claim: "roles"`). Mark guests with `guest: {"claim": "acct", "equals": "1"}`.
- *Google Workspace*: issuer `https://accounts.google.com`. Use `email_domains` with
  your Workspace domain: the `hd` claim is checked too. Google sends no groups claim.
  Google issues refresh tokens only for offline access requests, which this service
  does not make, so Google logins are not rechecked and last for `session_hours`.
- *Okta*: use a custom authorization server's issuer
  (`https://<org>.okta.com/oauth2/<server-id>`, or `/oauth2/default`). Groups appear
  only after you add a groups claim to that authorization server; name it with
  `groups_claim`. Use `offline_access` for refresh tokens.
- *Keycloak*: issuer `https://<host>/realms/<realm>`. Add a "Group Membership" mapper
  to the client to get a groups claim. Keycloak issues refresh tokens without
  `offline_access` and supports back-channel logout (set the client's back-channel
  logout URL).

For local trials and the tests there is a minimal provider,
`cargo run -p scribyra-sync --example test-idp -- --config idp.json`; see the comment
at the top of `crates/sync/examples/test-idp.rs`. It is not for production use.

## Server compile

With `deployment.encryption: "server"` and `deployment.compile` `"server"` or `"both"` (which
need `texlive`), members compile server-readable projects on the server (design section 6).
The routes below need the same sign-in as the other `/v1/sr/` routes and answer `404` to anyone
the project is not shared with; with `compile: "browser"` the compile routes answer `404 {"error":
"this deployment compiles in the browser"}`.

**Where a project compiles.** `compile: "server"`: every project. `compile: "both"`: each
project's `compile` setting (`browser` by default; owners and editors change it, and members see
it in the project details and heads). `compile: "browser"`: none. Project details and heads show
the effective mode as `compile` (`"browser"` or `"server"`).

| Route | Body → answer |
| --- | --- |
| `POST /v1/sr/projects/{p}/compile` | `{seq?}` (owner, editors; reviewers and viewers `403`). Materialises the project at `seq` (default: the head) with its main file (`meta.mainFile`, else a top-level `main.tex`; none: `400`), engine (`meta.engine`: `pdflatex` (default), `xelatex`, `lualatex`) and bibliography tool (Biber when a file loads BibLaTeX without `backend=bibtex`, else BibTeX when the `.aux` asks). → `202 {job, state: "queued", replaced}` (`replaced`: it took the place of this project's queued job); `200 {job, state, cached: true}` when a stored PDF has the same files, engine and TeX Live; `200 {job, state}` when the same files are already queued or running. `409` with `compile: "both"` and the project set to `browser`; `400` for `seq` past the head, `410` below the floor; `429` (`Retry-After: 60`) after `per_member_per_hour` requests by the caller in the last hour or `per_project_per_minute` requests on the project in the last minute (checked before the project is materialised; every answer counts, refused ones do not), or while the caller has `active_per_member` jobs queued or running, or the project's owner `active_per_owner` on their projects; `503` (`Retry-After: 60`) when `queue` jobs wait already |
| `GET /v1/sr/projects/{p}/compile` | Any member. → `200 {mode, head, texlive, job, pdf}`: `job` is the latest request `{id, state (queued, running, done, failed), seq, engine, requestedBy: {account, name}, queued, started, finished, outcome, error, cpuMs, log}` or `null`; `pdf` the latest successful PDF `{job, seq, engine, requestedBy, compiled, bytes, fromHead}` or `null` (`fromHead`: compiled at the current head) |
| `GET /v1/sr/projects/{p}/compile/pdf?job=` | Any member. → `200 application/pdf` with `Scribyra-Compile-Job` and `Scribyra-Compile-Seq`: the latest successful PDF, or `job`'s (as a cached answer or the status names it) while it is kept; `404 {"error":"no PDF yet"}`, or `"that compile's PDF is not kept"` for a `job` |
| `GET /v1/sr/projects/{p}/compile/log?job=` | Any member. → `200 text/plain`: the log of `job`, or of the latest finished job that kept one (a job that failed before TeX ran gives its error); `404` |
| `PUT /v1/sr/projects/{p}/settings` | `{compile: "browser"\|"server"}` (owner, editors who are not guests, as for sharing; else `403`) → `200 {compile}`; `409` unless the deployment's `compile` is `"both"` |

Outcomes (`job.outcome`): `success`; `tex_error`; `limit_cpu`, `limit_wall`, `limit_memory`,
`limit_output`, `limit_scratch`, `limit_processes`; `rejected` (paths, sizes, a missing main file
or asset, or a version compacted meanwhile); `sandbox_failure`; `lost` (the worker stopped
heartbeating twice); `quota` (the PDF did not fit the project quota). `error` is a fixed text of
the service's own; the details are in the log. A `sandbox_failure` log is a fixed text too (the
host's error, which names paths of the machine, goes to the service's own log as
`{"event":"compile_sandbox_failure","reason":…}`).

**Queue.** Jobs are `compiles` rows (migration `0010`) in PostgreSQL, taken by workers with
`SELECT … FOR UPDATE SKIP LOCKED`, round robin by requester: the requester with the fewest
running jobs first, each requester's oldest job first. At most `compile_limits.queue` jobs wait;
a project has at most one queued job (a newer request replaces it, even when the queue is full)
and one running (its next job waits for it); a member has at most `active_per_member` jobs
queued or running and an owner's projects at most `active_per_owner` (both default 2). Requests
are recorded (`compile_requests`, migration `0020`, kept an hour) and limited before the
project is replayed. A worker runs `compile_limits.concurrency` jobs at once, each in the
sandbox below with the deployment's `compile_limits` (input files checked against the sandbox's
128 MiB from the assets' recorded sizes before any is read), and reports each one alive every
`compile_heartbeat_seconds` while it prepares, runs and stores it. Each claim has its own token:
a job taken back and claimed again, even by the same process, cannot be stored twice, and a lost
claim's late result is discarded with only its own blobs. A worker whose heartbeats fail or hang
for `compile_heartbeat_timeout_seconds` less one interval stops the job. A job without a report
for `compile_heartbeat_timeout_seconds` is taken back by any worker or `serve` replica: requeued
once, then failed (`lost`).

**Retention and metering.** Rows record who compiled what, when, with the files' digest and CPU
time. Every ten minutes the reaping processes delete finished, failed and replaced rows older than
`compile_limits.retention_days` (default 90; migration `0021` indexes them), except those holding
the newest PDF or log and each project's latest job. CPU metering from `compiles` therefore covers
only the retention window: a host that bills per period must read the rows (for example into its
own billing store) more often than `retention_days`.

**Results.** The PDF and the log are sealed under the project's data key (associated data
`scribyra-sr/1\n<project>\n<pdf|log>\n<job>-<claim>`, where `<claim>` is 16 hex digits of the
claim's token; results stored before claims had tokens use `<job>`), stored as blobs under
`sr/<project>/c/<job>-<claim>-<pdf|log>`, and
count against the project, owner and deployment quotas. Only the newest successful PDF and log
and the newest failed log are kept; older ones are queued for removal. Every queued, started and
finished job `NOTIFY`s the project, so members' heads polls wake (their entry has
`compile: {mode, job, state}`). The cache key is the digest of the materialised files (paths and
content hashes), the main file and the bibliography tool, plus the engine and the TeX Live store
path's name; only the newest successful PDF can be reused.

**Workers.** `scribyra-sync compile-worker` reads the same configuration, connects to the same
database and blob store (S3: a filesystem blob directory belongs to the `serve` process), takes
jobs until SIGTERM, then lets running jobs finish for up to `shutdown_grace_seconds` and puts the
rest back in the queue (without using up their retry) before exiting 0. It answers `/healthz`
(live) and `/readyz` (database, schema, blob store; `503` once stopping) on
`compile_worker_bind`. It needs what the [sandbox](#server-compile-sandbox) needs: `bwrap`
(`SCRIBYRA_BWRAP` or `PATH`), the TeX Live tree of `deployment.texlive` and its closure
(`SCRIBYRA_TEXLIVE_CLOSURE` when it belongs to that tree, else `nix-store -qR` at start), unprivileged
user namespaces, and a delegated cgroup v2 subtree (`SCRIBYRA_COMPILE_CGROUP`, else a systemd
user scope; without either it refuses to start, `{"event":"compile_runner_unavailable"}`). For
development, `compile_worker_in_process: true` runs one worker inside `serve` (filesystem blobs
work then); SIGTERM gives its jobs back the same way.

**Metrics.** With `metrics_bind` set, `serve` and `compile-worker` answer `GET /metrics`
(Prometheus text) on that separate listener (pods: `0.0.0.0:9090`); never expose it publicly.
Series: `scribyra_compile_queue_length` (queued plus running jobs, read from the database at each
scrape; scales the workers), `scribyra_compile_jobs{state}`, `scribyra_http_requests_total{route,
status}` (route templates such as `/v1/sr/projects/{project}/compile`), `scribyra_compile_requests_total{result}`
(`queued`, `replaced`, `existing`, `cached`, `rate_limited`, `busy`, `queue_full`, `refused`),
`scribyra_compile_jobs_total{outcome}` (this process's finished jobs, plus `requeued` and
`lost`), `scribyra_compile_seconds_total`, `scribyra_compile_cpu_seconds_total` and
`scribyra_compile_running`. No label holds a project, account, name, path or content.

## Server compile sandbox

`crates/compile` (`scribyra-compile`) runs one TeX Live compile per sandbox; the compile
worker ([Server compile](#server-compile)) calls it. Each job is a `bwrap` process with new
user, mount, PID, network (empty but for loopback), IPC, UTS and cgroup namespaces; a
read-only root holding exactly the TeX Live store closure, a minimal `/dev`, no `/proc`, and
a tmpfs `/work` of `scratch_mib` as the only writable path. The project's files enter `/work`
from sealed memfds (no host disk is touched); only the PDF and the log leave it, read as
regular files through `O_NOFOLLOW` and size-bounded; the scratch vanishes with the namespace.
The seccomp filter, built in Rust, is an allow list (what bash, coreutils, the three engines,
BibTeX and xdvipdfmx call, traced with `crates/compile/tools/strace-syscalls.py`; anything
else gets `ENOSYS`). Checked before it and answered with `EPERM`: `ptrace`, `mount` and the
new mount API, `unshare`, `setns`, namespace `clone` flags (`clone3` gets `ENOSYS`), key,
`bpf`, `perf_event_open`, `userfaultfd`, `io_uring`, `personality`, module, reboot, `kexec`
and `memfd_create` calls, `socket` for every family except `AF_UNIX`, and foreign ABIs. TeX
runs with `-no-shell-escape -interaction=nonstopmode -halt-on-error`, `shell_escape=f`,
`openout_any=p`, `openin_any=p` (`r` for LuaTeX), a fixed `SOURCE_DATE_EPOCH`, and reruns
while the log asks, running BibTeX when the `.aux` has `\bibdata`. Biber (Perl, with many
modules) runs only if the configured TeX Live tree has it; it is not in `texliveSmall` and
adds attack surface inside the same sandbox.

Every job also gets its own **cgroup v2**: `memory.max` = `memory_mib` (the scratch tmpfs and
any shared memory count), `memory.swap.max` 0, `memory.oom.group` 1, `pids.max` and one CPU
(`cpu.max`). The runner reads CPU time from its `cpu.stat` (orphans included), kills the job
with `cgroup.kill` when that passes `cpu_seconds`, and removes the cgroup afterwards. Where
the cgroups come from (`Confinement`):

- `SCRIBYRA_COMPILE_CGROUP=<dir>`: a delegated, writable cgroup v2 directory with the
  `memory`, `pids` and `cpu` controllers: a systemd unit with `Delegate=yes`, or on
  Kubernetes the worker pod's own cgroup through its cgroup namespace (mounted writable for
  the worker). Processes already in it (the worker) are moved to a `supervisor` leaf.
- otherwise a transient `systemd-run --user --scope -p Delegate=yes` scope made at startup
  (development; needs the user's systemd manager), held by a `cat` that exits with the runner;
- otherwise nothing runs, unless `SCRIBYRA_COMPILE_UNCONFINED_MEMORY=1`
  (`Confinement::UnconfinedMemory`): development only, with per-process rlimits but no
  job-wide memory, process or CPU bound.

Requirements: Linux with unprivileged user namespaces (`unshare -Urn true` works) and a
delegated cgroup v2 subtree as above; on Kubernetes the worker pod runs with
`hostUsers: false`, its own cgroup namespace and a seccomp profile allowing user namespaces
(design section 10). `bwrap`'s `--disable-userns` is not used because it must write
`/proc/sys/user/max_user_namespaces`, which LXC and pods mount read-only; the seccomp filter
refuses nested namespaces instead. The runner needs `bwrap`, the TeX Live store path and its
closure: `SCRIBYRA_BWRAP`, `SCRIBYRA_TEXLIVE` and `SCRIBYRA_TEXLIVE_CLOSURE` (a
`closureInfo` `store-paths` file; without it `nix-store -qR` computes it at startup). The
development shell sets all three (`bubblewrap`, `texliveSmall`).

| Limit (default) | Enforced by |
| --- | --- |
| `cpu_seconds` 60 | the job's cgroup CPU time (all processes); `RLIMIT_CPU` per process too |
| `wall_seconds` 120 | the runner kills the job's cgroup and the sandbox |
| `memory_mib` 2048 | the job's `memory.max` (scratch included, no swap); `RLIMIT_AS` per process too |
| `output_mib` 64 | `RLIMIT_FSIZE` per file; also the PDF read back |
| `scratch_mib` 512 | tmpfs size of `/work` (also counts against `memory_mib`) |
| `processes` 64, `open_files` 256 | `pids.max` (plus bwrap's own), `RLIMIT_NPROC`, `RLIMIT_NOFILE`; core dumps off |
| `passes` 5, `files` 2000, `input_mib` 128, `log_kib` 1024 | the runner |

`RLIMIT_NPROC` is set inside the job's user namespace, where it counts only the job's
processes (set outside, it would count every process of the service's user). The other
rlimits are set on `bwrap` before it starts and inherited. The driver's report on its pipe
only classifies TeX's outcome; the runner's own kills and the cgroup's OOM and `pids.max`
events take precedence, success needs a `%PDF` the runner received, and without `/proc` job
code cannot reopen the driver's descriptors. Paths are refused before anything is written:
absolute, empty, `.` or `..` components, dot files, control characters, backslashes,
duplicates and file/folder clashes. Test with `nix develop -c cargo test -p scribyra-compile`.

## Configuration reference for operators

One JSON file (`SCRIBYRA_SERVICE_CONFIG`, mounted read-only) holds every setting; each top-level
field can be overridden by the environment variable `SCRIBYRA_SERVICE_<FIELD>` (the field name
upper-cased: `shutdown_grace_seconds` → `SCRIBYRA_SERVICE_SHUTDOWN_GRACE_SECONDS`). Text, path and
optional fields take plain text; numbers, booleans, arrays and objects take JSON. The `deployment`
object comes whole from `SCRIBYRA_SERVICE_DEPLOYMENT` (JSON), and each of its fields from
`SCRIBYRA_SERVICE_DEPLOYMENT_<FIELD>` (applied after it, so they refine it; `name`, `encryption`,
`compile`, `guests` and `texlive` are plain text, the rest JSON). The environment wins over the
file. **Secrets are only ever files**: `database_url_file`, `s3_secret_access_key_file`,
`service_key_file`, each provider's `client_secret_file` (`database_url` exists for local use;
prefer the file). The whole configuration is validated at start; a refusal prints
`{"event":"invalid_configuration","reason":"…"}` naming the field, never a value, and exits 1.

| Field (env `SCRIBYRA_SERVICE_…`) | Default | Meaning |
| --- | --- | --- |
| `bind` | `127.0.0.1:8787` | Listen address |
| `public_url` | none | The exact origin clients use; required with `deployment` ([Organisation fields](#organisation-fields)) |
| `origins` | `[]` | Browser origins allowed by CORS and as sign-in `return` |
| `trusted_proxies` | `[]` | Peers allowed to name the client in `X-Forwarded-For` (exactly one address) |
| `database_url_file` / `database_url` | none | PostgreSQL URL (file preferred); exactly one |
| `database_connections` | 10 | Pool size (plus the ownership connection and, server-readable, the `LISTEN` connection) |
| `migrate_on_start` | `true` | Apply pending migrations at start. With `false` the service refuses to start (`{"event":"schema_mismatch","schema":"behind"}`) unless every migration of its own is applied: run `scribyra-sync migrate` first. A schema a newer build extended (all of this build's migrations applied, with matching checksums, and more) is served either way (`{"event":"schema_ahead"}`): migrations are additive within a minor series |
| `shutdown_grace_seconds` | 25 | 1–3600: after SIGTERM, how long in-flight requests may finish before the process exits 0 |
| `blob_store`, `data`, `s3_endpoint`, `s3_region`, `s3_bucket`, `s3_access_key_id`, `s3_secret_access_key_file`, `s3_path_style` | filesystem, `service-data` | Blob store ([Storage fields](#storage-fields)). Several replicas need S3: a filesystem blob directory is locked by one process |
| `service_key_file` | none | 32-byte master key; required for `encryption: "server"`; back it up apart from the database |
| `deployment` | none | The organisation's policy ([Deployment](#deployment)); its fields as `SCRIBYRA_SERVICE_DEPLOYMENT_NAME`, `…_ENCRYPTION`, `…_OFFLINE`, `…_COMPILE`, `…_LINK_SHARING`, `…_GUESTS`, `…_ADMINS`, `…_PROVIDERS`, `…_QUOTAS`, `…_AUDIT_RETENTION_DAYS`, `…_COMPILE_LIMITS`, `…_TEXLIVE` |
| `sr_entry_bytes` | 16 MiB | Largest log entry or initial state (1 KiB to 64 MiB − 64 B) |
| `sr_object_bytes` | 32 MiB | Largest asset or history object (same range) |
| `sr_snapshot_entries`, `sr_snapshot_bytes` | 2000, 32 MiB | Snapshot after this many entries or stored bytes since the last |
| `sr_retention_seconds` | 604800 (7 days) | Snapshot age before the floor moves to it (0–366 days) |
| `sr_invitation_days` | 30 | 1–365: pending invitations expire |
| `sr_maintenance_seconds` | 30 | 1–3600: background erasure, floor and blob clean-up pass |
| `entry_inline_bytes` | 65536 | Entries (sealed) up to this size stay in PostgreSQL |
| `metrics_bind` | none (off) | Listener for Prometheus `/metrics` ([Server compile](#server-compile)); pods use `0.0.0.0:9090` |
| `sso_recheck_tick_seconds`, `sso_jwks_refetch_seconds`, `sso_starts_per_minute` | 60, 60, 60 | [Single sign-on](#single-sign-on-oidc) |
| `audit_purge_seconds` | 86400 | How often the audit log's retention task runs (1 s to 7 days) |
| `audit_retention_seconds` | none | Development and tests only: keep audit events this many seconds instead of `deployment.audit_retention_days` |
| `org_bytes`, `sessions` | 1 GiB, 10000 | End-to-end organisation quota and device sessions |
| `principals`, `object_bytes`, `namespace_bytes`, `total_bytes`, `namespace_objects`, `total_objects` | see [Access and limits](#access-and-limits) | Capability object store |
| `tcp_connections`, `http_concurrency`, `requests_per_second`, `source_requests_per_second`, `rate_sources`, `uploads`, `principal_uploads`, `namespace_uploads`, `namespace_downloads`, `response_bytes`, `send_seconds` | see [Access and limits](#access-and-limits) | Admission and transfer limits (`uploads` also bounds server-readable object uploads) |
| `connections`, `rooms`, `room_seconds`, `namespace_rooms`, `namespace_connections`, `room_attempts`, `namespace_room_attempts`, `frame_bytes`, `messages_per_second` | see [Access and limits](#access-and-limits) | Relay limits |

**Commands** (all read the same configuration):

| Command | Does | Exit |
| --- | --- | --- |
| `scribyra-sync` or `scribyra-sync serve` | Serve (applies migrations first unless `migrate_on_start: false`) | 0 after SIGTERM/SIGINT, 1 on a startup or runtime failure |
| `scribyra-sync migrate` | Apply pending migrations and exit; prints `{"event":"migrated","applied":n,"schema":v}`. Takes no ownership lock (the migrator locks itself), so it can run as a Job while replicas serve. Refuses a database with migrations newer than the binary (a downgrade) | 0, or 1 |
| `scribyra-sync compile-worker` | Take [server compile](#server-compile) jobs from PostgreSQL and run them in the sandbox; probes on `compile_worker_bind`. Needs server compile, S3 blobs (unless `serve` is stopped) and the sandbox's requirements | 0 after SIGTERM/SIGINT (running jobs finish or go back to the queue within `shutdown_grace_seconds`), 1 on a startup failure |
| `scribyra-sync migrate` | Apply pending migrations and exit; prints `{"event":"migrated","applied":n,"schema":v}`. Takes no ownership lock (the migrator locks itself), so it can run as a Job while replicas serve. Refuses a database with migrations newer than the binary | 0, or 1 |
| `scribyra-sync verify` | Check every capability object's blob and the usage rows | 0 when consistent |
| `scribyra-sync audit verify [<seq>:<hash>]` | Recompute the audit log's hash chain ([Administration](#administration-and-the-audit-log)) | 0 when the chain holds, 1 otherwise |
| `scribyra-sync migrate-sqlite <dir>` | One-time import of a milestone-S data directory | 0 |

**Probes and signals:**

| | Path | Answers |
| --- | --- | --- |
| Liveness | `/healthz` (also `/health`) | `200 {"live":true}` while the process serves; separate rate table, no transfer slot |
| Readiness | `/readyz` (also `/ready`) | `200` when the database answers, every migration of this build is applied (a newer build's additional migrations do not matter, so its migration Job does not make the running replicas unready during a rollout), the ownership connection is alive and the blob store answers; otherwise `503`. Every request, probes included, gets `503` once shutdown began |
| SIGTERM | | Stop accepting connections, answer new requests on open connections `503`, end heads long polls at once (they answer with the current state, so clients poll another replica), let in-flight requests finish for up to `shutdown_grace_seconds`, then exit 0 (`{"event":"shutdown"}`, then `{"event":"stopped"}` or `{"event":"drain_timeout"}`) |

**Replicas.** A server-readable deployment keeps nothing a second replica would need in memory:
sessions, sign-ins in progress, accounts, projects and the heads notices are in PostgreSQL
(`LISTEN/NOTIFY`), so replicas share the database (they take the ownership lock in shared mode)
and need S3 blobs. An end-to-end deployment still takes the lock exclusively: one replica (until
slice 19).

## TLS, logging and supervision

Keep the listener on loopback behind both supplied proxy configurations:
[`service-admission.cfg`](../deploy/service-admission.cfg) performs TCP admission
**before TLS**, then [`service-nginx.conf`](../deploy/service-nginx.conf) terminates
TLS 1.2/1.3 on a private PROXY-protocol listener. Nginx's HTTP limits alone cannot
bound partial TLS handshakes. HAProxy and nginx come from the pinned development
flake; they are deployment infrastructure, with no client installation.

For a local installation, service on `127.0.0.1:8787`, set
`"trusted_proxies":["127.0.0.1"]` in service config. Nginx replaces
`X-Forwarded-For` with the source verified through HAProxy's PROXY v2 header.
The service trusts no forwarded headers by default. With a trusted proxy peer,
a missing, malformed, repeated or chained address returns 400. An untrusted
peer's forwarded headers are ignored. Keep both upstream ports private: local
processes able to reach them are inside this deployment's trust boundary.

Create the prefix inside this checkout. The certificate below is disposable;
remote clients need a trusted certificate. Run the two foreground commands in
separate terminals (or supervisor units), recording their exact PIDs:

```sh
mkdir -p tmp/service-proxy
cp deploy/service-nginx.conf tmp/service-proxy/nginx.conf
cp deploy/service-admission.cfg tmp/service-proxy/admission.cfg
nix develop -c openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
  -keyout tmp/service-proxy/tls.key -out tmp/service-proxy/tls.crt
chmod 600 tmp/service-proxy/tls.key
nix develop -c nginx -t -p "$PWD/tmp/service-proxy/" -c nginx.conf
nix develop -c haproxy -c -f "$PWD/tmp/service-proxy/admission.cfg"
nix develop -c nginx -p "$PWD/tmp/service-proxy/" -c nginx.conf -g 'daemon off;'
nix develop -c haproxy -db -f "$PWD/tmp/service-proxy/admission.cfg"
```

Only HAProxy's `https://127.0.0.1:8443` listener may become externally reachable.
Nginx stays on `127.0.0.1:9443`, the service on `127.0.0.1:8787`. Change the
external bind/certificate/server name as needed; no public listener, certificate
fetch or ACME account is implicit. Set the editor's exact allowed HTTPS origin.
Stop only recorded process PIDs. Do not expose nginx's PROXY listener directly.

TCP admission tracks at most 4096 source IPs without evicting unexpired entries;
a full table rejects untracked sources. Each source gets at most 16 concurrent
connections (including incomplete TLS) and 32 new connections per second.
The frontend ceiling is 128 and process ceiling 256. Replenishing expired
handshakes therefore cannot let one IP occupy nginx's 256 worker slots.
Nginx also bounds active HTTP/upgraded connections to 16/IP and 64 total,
requests to 20/second/IP with burst 20, and health requests with an independent
20/second/IP bucket. Connection limits still cover health; several attacking
sources or a shared NAT can exhaust shared capacity. These ceilings do not
protect against link saturation or a distributed attack.

The nginx body limit is 8 MiB; header lines have 4 KiB buffers. Handshake/header,
body/send and keepalive idle deadlines are five seconds. Upstream
connect/send/read limits are 2/15/125 seconds; health connect/read are 2/2.
HAProxy's TCP idle timeout is 125 seconds, accommodating the default relay room.
The service supplies absolute transfer/room deadlines. Update all limits together.
Requests and responses stream without proxy buffering, allowing early rejection
of unfinished unauthorized uploads. Origin, Authorization and WSS upgrades are
preserved. Access/request error logging is disabled; startup diagnostics remain.

```sh
nix develop -c node scripts/service-proxy-smoke.mjs
```

The disposable smoke uses the exact templates with changed ports, a generated
certificate verified as the local CA, and cleans up its child processes/files.
It covers HTTP/WSS, bounds and deadlines, forwarded-header replacement,
independent health requests, and a replenished partial-TLS attack lasting beyond
the handshake timeout while another source checks health and exact stored bytes.
It separately checks connection-rate rejection without concurrent handshakes.
TLS verification remains enabled. HAProxy's pre-session admission semantics are
specified in its [configuration manual](https://cdn.haproxy.com/documentation/haproxy-configuration-manual/new/latest/).

Structured stdout logs contain fixed event/status fields; startup logs include
the bind address. No request path/content/room/bearer is logged. Rotate stdout
through the supervisor; payload quotas exclude logs and backups. Health is only
liveness; readiness performs a pooled database round trip, checks the ownership
connection and probes the blob store (a synced create-and-remove for the
filesystem, `HeadBucket` for S3). Storage errors return failure, never
acknowledgement. Startup does not read stored objects (that does not scale to a
bucket); every GET verifies size and hash and returns 500 for a missing or
corrupt object, and `scribyra-sync verify` checks the whole store on demand.
A PostgreSQL advisory lock (`pg_try_advisory_lock`) on a dedicated connection
makes one process the owner of a database; a second process exits with status
1. If that connection is lost, the service logs `database_ownership_lost` and
exits so a supervisor can restart it. Filesystem blobs also take an exclusive
lock on `<data>/.lock`. The database URL, S3 credentials and secret paths are
never logged.
Stop with SIGTERM or SIGINT. Active relays close; HTTP work drains. Give the
process 30 seconds before a supervisor kills it. Hardware/filesystems must honor
fsync; abrupt process-kill tests cannot prove power-loss guarantees.

Native diagnostics use the existing default-off `SCRIBYRA_DIAGNOSTICS` and
explicit export settings documented in [telemetry](telemetry.md). There is no
new telemetry destination, account integration or content logging.

## Container and NixOS

`nix/service.nix` replaces `Dockerfile.sync`: it builds from scratch using the
Rust toolchain, dependency lock and base packages pinned by **flake.lock and
Cargo.lock**. It copies only the service's runtime closure, not the plaintext
demo, compiler or frontend. There is no mutable remote base-image tag.

```sh
nix build .#service-image
docker load < result
# Create ./service.json with explicit grants (data and bind come from the image).
mkdir -m 700 secrets
openssl rand -hex 32 > secrets/postgres-password
printf 'postgres://scribyra:%s@postgres:5432/scribyra\n' "$(cat secrets/postgres-password)" > secrets/database-url
chmod 644 secrets/*   # read by container users; the secrets directory stays 700
docker compose up -d
```

[`compose.yaml`](../compose.yaml) runs a `postgres` service (official image
pinned by version tag; record and compare its digest before first use, then pin
`tag@sha256:<digest>` as the file explains) with a health check and an
unpublished port, and starts the sync service only once PostgreSQL is healthy.
The sync service reads the database URL from a secret file, keeps filesystem
blobs on the `sync-data` volume, refuses pulls, publishes only loopback, mounts
a read-only config and drops capabilities. A commented block shows S3 blobs.
The image runs as UID/GID 10001 and supports a read-only root. Identify an
installed image by its Docker image ID; retain the previous ID for rollback.
Do not expose the container port publicly without the TLS proxy policy above.

A rootless Podman drill can import the local archive with Skopeo (no registry):

```sh
nix-shell -p podman skopeo slirp4netns --run 'nix develop -c node scripts/service-container-smoke.mjs'
# LXC without /dev/net/tun: use host networking bound only to loopback.
nix-shell -p podman skopeo --run 'nix develop -c node scripts/service-container-smoke.mjs --host-network'
```

The script owns isolated storage under `tmp/`, imports only the built archive,
uses synthetic grants, creates a read-only UID/GID 10001 container with all
capabilities dropped, checks health/readiness, writes, stops/starts and reads
back exact bytes from a named volume. It removes its container, volume and
storage. Cgroups are disabled for this LXC drill; resource enforcement on a
real host remains an operator check. The host-network variant proves no port
mapping or network namespace isolation. No external destination is contacted.
The local-archive signature policy accepts only Docker archives and rejects
other image transports; no registry trust policy is relaxed. Plain `podman load`
from `nix-shell -p podman` can fail if the host has no policy.json, so this drill
uses Skopeo's explicit policy argument.

The image's environment overrides config `bind` and `data` to
`0.0.0.0:8787` and `/data`. Override the corresponding environment variables
explicitly to change them. Config contains only hashes and must be readable by
UID 10001 (for example mode 0644 in an operator-private parent directory).

For NixOS import `nixosModules.scribyra-sync` from this flake and configure:

```nix
services.scribyra-sync = {
  enable = true;
  package = scribyra.packages.${pkgs.stdenv.hostPlatform.system}.service;
  configFile = /etc/scribyra/service.json;
  # Defaults: database.createLocally = true; blobStore.type = "filesystem".
};
```

By default the module enables `services.postgresql`, creates database and role
`scribyra-sync` (`ensureDatabases`, `ensureUsers` with database ownership) and
connects over `/run/postgresql` with peer authentication, so no password
exists. The unit runs as the fixed system user `scribyra-sync` (not a dynamic
user, so peer authentication can map it) and starts after `postgresql.service`
and `postgresql-setup.service`. For an external server set
`database.createLocally = false` and `database.urlFile` to a root-only file; for
S3 set `blobStore.type = "s3"` and `blobStore.s3.{endpoint,region,bucket,accessKeyId,secretAccessKeyFile,pathStyle}`.
Both secret files reach the unit through `LoadCredential`. Filesystem blobs stay
in the private `/var/lib/scribyra-sync`. Leave database and blob fields out of
`configFile`: the module sets them through the environment, and giving both
`database_url` and `database_url_file` is refused. The unit keeps the restrictive
umask and systemd hardening. Config contains hashes, never bearer secrets, and
must be readable by the service. The module opens no firewall ports and installs
no client program. Configure TLS separately.

The flake includes a booted module test:

```sh
nix build .#checks.x86_64-linux.service-vm --out-link tmp/service-vm
```

It enables the actual module with its local PostgreSQL, boots NixOS, waits for
the units, checks health and readiness, writes and verifies an object, checks
its database row and blob file, stops the unit and runs `verify` as the service
user, restarts PostgreSQL and the unit, then checks readiness and exact
read-back. It permits QEMU software emulation without KVM; the overall
runtime deadline is ten minutes. It opens no external listener or firewall port.

## Upgrade, backup and restore

Objects are immutable and a metadata row is committed only after its blob is
durable, so every object the database refers to is already in the blob store.

**Backup** (online, the service may keep running):

1. Dump the database first: `pg_dump --format=custom --file=scribyra.dump "$(cat database-url)"`
   (or a base backup with WAL archiving).
2. Then copy the blobs: `cp -a data backup/data` (or `rsync -a`) for the
   filesystem backend; for S3 use bucket versioning or replication, or copy the
   bucket with your provider's tools (for example `rclone copy`).

Objects written after the dump are harmless extras in the blob copy. Back up the
configuration and secret files separately. Keep backups private: they hold
ciphertext and all metadata.

**Restore** into an empty database and an empty blob directory (or bucket):

```sh
createdb -O scribyra-sync scribyra_restored
pg_restore --no-owner --exit-on-error --dbname "$restored_url" scribyra.dump
cp -a backup/data restored/data
SCRIBYRA_SERVICE_CONFIG=service.json ./scribyra-sync verify
```

Point the configuration at the restored database and directory, run `verify`,
start the service, check `/ready` and retrieve a known object before switching
clients. Restoring an older backup rolls stored state back; clients that still
have their data re-upload it.

**Upgrade**: stop the service, keep the previous binary or image and a backup,
install the new binary, start it (or run `scribyra-sync migrate` first and start replicas with
`migrate_on_start: false`). Pending migrations (`crates/sync/migrations`,
embedded in the binary and recorded in the `_sqlx_migrations` table with
checksums) run automatically at startup. An applied migration whose checksum differs is
refused (startup exits 1). A database with migrations the binary does not know, on top of all of
its own (a newer build migrated it), is served, since migrations are additive within a minor
series, but `scribyra-sync migrate` from the older binary refuses it. Migrations are append-only. `scribyra-sync migrate` applies pending migrations and exits
(`{"event":"migrated","applied":n,"schema":N}`) without opening the blob store or serving; it
takes no ownership lock (the migrator serialises itself), so it can run as a Job while replicas
of the previous version serve, as long as each release's migrations are additive. The Kubernetes
operator runs it as a Job before rolling out a new version ([operator](operator.md)). For rollback restore
the pre-upgrade backup with the old binary; never run an old binary against a
newer schema.

To erase deleted rows physically, PostgreSQL needs `VACUUM FULL` on the affected
tables; plain `VACUUM` only marks space reusable.

### Upgrade from the SQLite store

Milestone-S releases stored metadata in `<data>/metadata.sqlite` and blobs in
`<data>/blobs/<namespace>-<hash>`. Move such an installation once:

1. Stop the old service and back up its whole data directory.
2. Install the new binary and write a configuration with the new
   `database_url_file` and a blob store. Use a **different** `data` directory
   for new filesystem blobs (the old `blobs/` layout is not read by the service).
3. Run `scribyra-sync migrate-sqlite /path/to/old-data`. It refuses a directory
   whose old service still holds `service.lock`, a database that is not a
   milestone-S schema-1 database, or a future schema. It then reads and verifies
   **every** object (size and SHA-256) before writing anything, and refuses the
   whole import if any blob is missing or corrupt. Then it copies each object,
   verifying it again, and charges usage (configured quotas are not enforced
   for imported data, so nothing acknowledged is dropped). It prints only counts:
   `{"event":"migrate_sqlite","objects":N,"imported":N,"existing":0}`.
4. Re-running is safe: objects already present are counted as `existing`.
5. Run `scribyra-sync verify`, start the service, check `/ready` and retrieve a
   known object. Keep the old directory until clients have been checked.

Relay and object capabilities stay in the configuration file and need no
migration.

### Verify

`scribyra-sync verify` (service stopped) reads every object once, one at a time,
and checks that the blob exists and has the recorded size and hash. It also
compares the `global` and `namespace:` usage rows with the objects. It prints
`{"event":"verify","objects":N,"missing":M,"corrupt":C,"usage_mismatch":U}` and
exits 0 only when all three are zero. It does not print keys or paths. With S3
blobs it reads the whole bucket, so schedule it with the transfer cost in mind.

## PostgreSQL storage, 10 November 2026

Executed in the `agent/org-sync` worktree on 10 November 2026, with PostgreSQL
17.11 and Garage 1.3.1 from the dev shell. No deployment, push, real credentials
or external service.

| Command (from checkout) | Result |
| --- | --- |
| `nix develop -c cargo test -p scribyra-sync` | 22 passed, 0 failed: 5 blob-store tests (one conformance suite passed by the filesystem and Garage backends, strict keys, settings), 15 binary tests (object semantics, concurrent quota, SIGKILL during upload, each with filesystem and Garage blobs; advisory lock; future migration and bad config refusal; URL file over a unix socket; `verify` on filesystem and S3; `migrate-sqlite` to both backends, idempotent re-run and refusals), 2 retained demo tests |
| `nix develop -c node --test tests/service.test.mjs` | 20 passed, 0 failed, against a private PostgreSQL cluster with filesystem blobs; the plaintext search covers the PostgreSQL data directory after a checkpoint |
| `nix develop -c cargo build --locked --release -p scribyra-sync --bin scribyra-sync` then `nix develop -c node scripts/service-smoke.mjs` | Release build passed; 13/13 install, exchange, online backup, upgrade, restore and verify checks |
| `nix develop -c node scripts/service-proxy-smoke.mjs` | 20/20 checks with the release binary |
| `nix eval --raw .#checks.x86_64-linux.service-vm.drvPath` | The VM test with the new module evaluates |

Not run: the booted VM test (`nix build .#checks.x86_64-linux.service-vm`) would
build 438 derivations and fetch 2.2 GB with about 12 GB of disk free, below a safe
margin on this host; the Podman container drill (no Podman installed); the
Compose stack (no Docker daemon).

## Delivery evidence

Original S1–S4 evidence. The [security-review follow-up](#security-review-follow-up-6-november-2026)
below supersedes its capacity findings and final-check scope.

Executed in this dedicated worktree on 6 November 2026, against its own `dist/`
on port 4801. No deployment, push, real credentials, external service or TeX
runtime download. The final clean-directory drill used the release binary.

| Command (from checkout) | Result |
| --- | --- |
| `nix develop -c cargo build -p scribyra-sync --bins --examples --offline` | Pass |
| `nix develop -c node --test tests/service.test.mjs` | 12 passed, 0 failed: three SIGKILL/restart cycles, exact opaque bytes, no seeded plaintext in database/blobs, corruption refusal (including duplicate PUT), auth/rights/origins, versions, quotas, rates, frame/TCP/WebSocket/room/member limits, expiry, shutdown, environment overrides schema/lock refusal, and retained capacity during a real stalled filesystem read past the HTTP deadline |
| `nix develop -c npm test` | 154 Rust and 915 JS/WASM passed, 0 failed; 2 existing Rust ignores and 6 existing optional-service skips; includes `tests/sync.test.mjs` and all 512 randomized sequences |
| `nix develop -c cargo test -p scribyra-sync` | 2 retained demo tests passed; explicitly enabled through the example's `test = true` |
| `nix develop -c npm run fixtures` | Pass; existing compiler assets reused |
| `nix develop -c npm run build` | Pass; existing Rollup annotation warnings only |
| `nix develop -c env SCRIBYRA_TEST_PORT=4801 npx playwright test tests/browser/service.spec.js --project=chromium --project=firefox` | 6 passed, 0 failed; two separate browser processes; immediate local descriptions, candidates in both directions, offer-to-applied-answer under 1500 ms and bidirectional direct-channel transfer; tamper/replay rejected |
| `nix develop -c env SCRIBYRA_TEST_PORT=4801 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/service.spec.js --project=webkit -g 'client rejects'` | 2 passed, 0 failed; signaling crypto only, no WebKit WebRTC reachability claim |
| `nix develop -c env SCRIBYRA_TEST_PORT=4801 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/collaboration.spec.js tests/browser/commands.spec.js --project=chromium --project=firefox --project=webkit` | 12 passed, 0 failed; retained demo source/cursors/assets/offline reload and stale-dialog protections; only server executable paths changed |
| `nix develop -c cargo build --locked --release -p scribyra-sync --bin scribyra-sync` then `nix develop -c node scripts/service-smoke.mjs` | Release build passed; 9/9 clean-directory install/exchange/reinstall/restore checks |
| `nix eval --offline --raw .#packages.x86_64-linux.service.drvPath` and `nix eval --offline --raw .#packages.x86_64-linux.service-image.drvPath` | Both derivations evaluated; immutable inputs come from the lock files |

The NixOS unit was also evaluated with `nix eval --offline --impure --json
--expr` using `builtins.getFlake "git+file://<this-worktree>"`,
`inputs.nixpkgs.lib.nixosSystem`, this module, `system = "x86_64-linux"`,
`system.stateVersion = "26.05"`, an enabled service with this flake's package
and `/etc/scribyra/service.json`, selecting
`config.systemd.services.scribyra-sync.serviceConfig`. It produces the expected
binary, dynamic user, state directory, umask, shutdown timeout and hardening.
This evaluates configuration; it does not boot a NixOS host.

The broad `npm test` run began before the final storage-permit and WebSocket
drain hardenings and before enabling the two moved example tests by default.
After those changes, all 12 service cases and the rebuilt release's 9-check
installation drill passed. The restored demo target separately passed 2/2;
a future full run includes those two Rust cases (156 total) and the added
stalled-disk JS case (916 runnable JS cases). The expensive unrelated history
suite was not repeated after these isolated service changes. Production frontend
and browser checks exercised the final frontend/client code; later changes were
server shutdown/capacity handling and documentation.

Earlier failures and limits:

- Initial service compilation exposed integer conversion errors, corrected
  before acceptance. An early seven-test run started before the binary existed
  (7 startup failures); subsequent final service runs pass all 12 cases.
- First Chromium attempt: 3 failures with
  `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`; Firefox passed 3/3.
  Explicitly granting that permission in the fixture fixes all Chromium cases.
  No browser security flag disables the policy. This is not a real-network,
  firewall, radio, Windows, macOS or Safari test.
- An initial full unit run failed the frozen folders test
  `exclusive_session_scope_and_missing_bindings_are_enforced` with
  `WouldBlock: This folder is already in use by another Scribyra session.`
  `nix develop -c cargo test -p scribyra-folders --test transactions
  exclusive_session_scope_and_missing_bindings_are_enforced` then passed 1/1;
  no frozen-crate code or assertion was changed. The subsequent broad run
  passed that test too.
- `nix build --offline .#service --no-link` was interrupted when it began
  rebuilding uncached system dependencies. Docker and Podman are absent.
  Container execution and a booted NixOS installation are untested; the allowed
  fresh-directory route supplied the installation/restore gate. Initial path
  flake evaluations that copied the entire worktree were interrupted and
  replaced with the successful Git-flake evaluation above.
- Reinstallation uses schema 1 and the same release. There is no released
  older opaque schema to migrate; empty-schema initialization, future-schema
  rejection and crash recovery are tested. No power-cut/hardware-failure claim.
- The plaintext demo and its browser/native checks remain separate from the
  opaque service. No existing test was removed, weakened or newly skipped. D UI,
  identity/membership, project encryption and the 10–12 gates remain open;
  the owner still commissions independent security review before strong claims.

## Security-review follow-up, 6 November 2026

This follow-up addresses unauthenticated upload occupancy, disconnected-room
churn across tenants, and slow-download memory retention. The four new service
regressions assert observable availability, quota sharing, RSS growth and deadline
recovery. Existing service assertions remain intact; no test was weakened or
newly skipped. The relay helper now fails explicitly when readiness never arrives.

The fresh pre-fix debug binary reproduced the PUT failure (health 503 with 16
one-byte unfinished uploads), 20 disconnected rooms blocking a second namespace
in 65 ms, and 24 successful paused 8-MiB downloads with `http_concurrency:2`
increasing RSS from 13,221,888 to 223,490,048 bytes (200.5 MiB growth). These are
local synthetic probes, not a production load model.

The final download regression independently exercises the transfer-count limit
(`http_concurrency:2`, 32 MiB byte budget) and the byte limit
(`http_concurrency:16`, 8 MiB budget), with the namespace download ceiling raised
to 16 to isolate those controls. Each sends 24 requests for one 8-MiB object,
pauses successful response bodies, samples Linux `/proc/<pid>/status`, asserts
RSS growth below **48 MiB**, and then verifies a complete authorized GET after
the three-second test send deadline without resuming the stalled clients. Final
measurements: 16,830,464 bytes (16.1 MiB) growth with two transfers admitted,
and 8,421,376 bytes (8.0 MiB) with one admitted. The other requests returned 503;
liveness stayed responsive, and complete downloads succeeded after the send
deadline. Full acceptance counts are recorded below.

| Command | Follow-up result |
| --- | --- |
| `nix develop -c cargo build --locked -p scribyra-sync --bin scribyra-sync` | Pass |
| `nix develop -c cargo fmt -p scribyra-sync -- --check` | Pass |
| `nix develop -c node --test tests/service.test.mjs` | 16/16 passed, 0 failed/skipped; four new effect-based abuse regressions |
| `nix develop -c npm test` | 156 Rust and 920 JS/WASM passed, 0 failed; 2 existing Rust ignores and 6 existing optional-service skips; all 512 randomized sequences and frozen companion/folders checks included |
| `nix develop -c npm run fixtures` | Pass; provisioned compiler assets reused |
| `nix develop -c npm run build` | Pass; existing Rollup annotation/chunk warnings |
| `nix develop -c cargo build --locked --release -p scribyra-sync --bin scribyra-sync` | Pass |
| `nix develop -c node scripts/service-smoke.mjs` | 9/9 install, exchange, same-release upgrade and clean-directory restore checks |
| `nix develop -c node scripts/service-proxy-smoke.mjs` | 13/13 checks with a locally generated, verified self-signed certificate; HTTP and WSS, body/header/connection/rate limits, actual handshake/header deadlines |
| `nix develop -c env SCRIBYRA_TEST_PORT=4801 npx playwright test tests/browser/service.spec.js --project=chromium --project=firefox` | 6/6 passed; 3 per engine |
| `nix develop -c env SCRIBYRA_TEST_PORT=4801 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/service.spec.js --project=webkit -g 'client rejects'` | 2/2 passed; signaling crypto only, no WebKit WebRTC claim |
| `nix develop -c timeout 180 nix build --offline .#service-image --no-link` | Failed before timeout: pinned Nix dependency hash mismatch, below |
| `nix develop -c docker run --pull=never --rm --network none scribyra-sync:0.1.0-s1`; `nix develop -c docker version`; `nix develop -c podman version` | All exit 127: `exec: docker: not found`, `exec: podman: not found` |

The image build failed on the pinned `tinycc-musl-unstable-2025-12-03` dependency,
not on service compilation. Exact failure:

```text
error: hash mismatch in fixed-output derivation '/nix/store/d1simrxi41d15h88m043y00yd400fpd4-cb41cbfe717e4c00d7bb70035cda5ee5f0ff9341.tar.gz.drv':
         specified: sha256-MRuqq3TKcfIahtUWdhAcYhqDiGPkAjS8UTMsDE+/jGU=
            got:    sha256-2MwFlPOKStd1EMwzMmSDR/ahzvhUqCT46Lz71+5LrB0=
```

The `scribyra-sync.tar.gz` derivation then failed transitively. No lock/hash was
changed to bypass this failure. No image was produced or run; even with an image,
this environment has neither Docker nor Podman. The release-binary installation
and TLS proxy are tested locally; a booted container/NixOS host remains untested.

Development failures retained for review: two Rust compile errors (SQLite
`usize` conversion and a borrowed header value) were corrected. The initial
16-case run against the old binary had 12 passes/4 failures: the PUT availability
failure and three startup refusals for new configuration fields. An intermediate
implementation had 14 passes/2 failures: the original concurrent durable-quota
check was preempted by an upload ceiling of two, and Hyper copied whole response
buffers, releasing byte-owned permits too early. Defaults now admit three uploads
per namespace, and bounded chunks plus a connection-held reservation cover
transport buffering. A later run had 15 passes/1 failure from assuming concurrent
socket arrival order; the test now asserts each admission stage without ordering
its requests. The first broad run passed Rust tests but stopped on the borrowed
header compile error before JavaScript. The next broad run had 156 Rust passes,
919 JavaScript passes, one JavaScript failure and six existing skips: it had
loaded the earlier upload assertion before the arrival-order correction. The
full suite was restarted against the committed correction. The expanded proxy test initially treated
the expected timeout reset as an unexpected rejected promise; it now observes
socket closure and asserts elapsed time. Final checks above supersede those runs.

No public endpoint, deployment, push, real credential or TeX-runtime download was
used. Nix fetched proxy dependencies into its cache. Browser profiles, service
processes and proxy workers are cleaned up. Shared pre-authentication TCP/rate
pools, multi-namespace aggregate overload, disk stalls, allocator/kernel overhead,
and real-network behavior remain explicit limits; these checks are not an
independent security review. The owner still owns commissioning that review before
strong encryption/security claims; no new product decision is required here.

## Second security review and runtime deployment, 6 November 2026

This supersedes the earlier global-rate/TLS capacity findings and the earlier
container/VM disclosure above. Direct admission now has a bounded per-source
pre-authentication ceiling, an anonymous source budget and a budget shared by
all capabilities in an authenticated namespace. Health has its own source table
and request budget. Four added service cases cover the 105-request pipeline,
namespace aliases, bounded source-table reclamation and explicit proxy trust.
The pipeline verifies health and authorized downloads from the attack address
and another address; rotating forwarded headers is ineffective by default.
A source exceeding the higher pre-auth ceiling can still affect authenticated
users sharing its NAT; other sources and health retain independent budgets.

The final proxy attack opens 256 sockets from `127.0.0.2`, sends the six-byte
partial TLS prefix `16 03 01 02 00 01`, and replenishes closed sockets for eight
seconds, beyond nginx's five-second handshake deadline. It attempted **8,144**
connections, observed at most **16** live attack sockets, and completed **30**
health/exact-byte download pairs from `127.0.0.3` during the attack. The observed
fast-rejection count was **8,128**. Separate sequential handshakes exercise the
connection-rate control with no intended concurrent occupancy. This measures
local IPv4 loopback sources, not physical clients, NAT fairness or a distributed
attack. Ordinary proxy request-rate checks use one persistent connection so the
pre-TLS connection ceiling cannot mask an HTTP-rate regression. The old HTTP
429 expectation at the TCP ceiling now asserts TLS rejection and another source's
successful health response, because rejection intentionally occurs before HTTP.
The old global-rate unit test is renamed to reflect independent health admission;
its bounded-admission assertions remain. No existing test was removed or skipped.

The online image build succeeded with unchanged `flake.lock`, `Cargo.lock` and
expected dependency hashes. Fetching the previously failing fixed-output source
from the Nix binary cache also succeeded, and hashing it returned exactly
`sha256-MRuqq3TKcfIahtUWdhAcYhqDiGPkAjS8UTMsDE+/jGU=`. There was no hash change
or acceptance of the earlier mismatching bytes. This restores the documented
network-enabled build route; rebuilding the compiler bootstrap directly from
repo.or.cz was not tested. One redundant image build started during development
was interrupted; the subsequent build completed.

The rootless container drill ran the built image
`sha256:a6ca362e3fd2652976f983b3678d7bc98d994821d8f39bed308bb99f3abda306`.
It passed import, readiness, health, write, restart/readiness, exact read-back and
configured UID/GID checks, with a read-only root and dropped capabilities.
The NixOS test **booted**, used the real hardened dynamic-user unit, and completed
health/readiness, write/read, systemd restart and exact read-back in **140.89 s**;
the driver then stopped QEMU. `/dev/kvm` is absent, so this was software emulation.
No real-host, KVM, hardware power-loss or cross-version migration claim follows.

| Command | Result |
| --- | --- |
| `nix develop -c cargo build --locked -p scribyra-sync --bin scribyra-sync` | Pass |
| `nix develop -c cargo fmt -p scribyra-sync -- --check` | Pass |
| `nix develop -c node --test tests/service.test.mjs` | 20/20 pass, 0 failed/skipped; two complete runs |
| `nix develop -c npm test` | 156 Rust and 924 JS/WASM pass, 0 failed; 2 existing Rust ignores / 6 existing optional-service skips; all 512 seeds included |
| `nix develop -c npm run fixtures` | Pass; provisioned compiler assets reused |
| `nix develop -c npm run build` | Pass; existing Rollup annotation/chunk warnings |
| `nix develop -c cargo build --locked --release -p scribyra-sync --bin scribyra-sync` | Pass |
| `nix develop -c node scripts/service-smoke.mjs` | 9/9 install/exchange/reinstall/backup/restore checks |
| `nix develop -c node scripts/service-proxy-smoke.mjs` | Final 20/20 pass; verified TLS, HTTP/WSS, source admission, independent health, partial-handshake attack and churn |
| `nix develop -c env SCRIBYRA_TEST_PORT=4801 npx playwright test tests/browser/service.spec.js --project=chromium --project=firefox` | 6/6 pass, 3 per engine, 0 failed/skipped |
| `nix develop -c env SCRIBYRA_TEST_PORT=4801 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/service.spec.js --project=webkit -g 'client rejects'` | 2/2 pass; crypto only, no WebKit WebRTC claim |
| `nix build .#service-image` | Pass, online; image built and then run |
| `nix build --no-link '/nix/store/d1simrxi41d15h88m043y00yd400fpd4-cb41cbfe717e4c00d7bb70035cda5ee5f0ff9341.tar.gz.drv^*'` | Pass; expected source fetched from cache.nixos.org |
| `nix hash file --type sha256 --sri /nix/store/j8vqssml916z4hvq1dk36w19grfrks7y-cb41cbfe717e4c00d7bb70035cda5ee5f0ff9341.tar.gz` | Matches pinned expected hash above |
| `nix-shell -p podman skopeo --run 'nix develop -c node scripts/service-container-smoke.mjs --host-network'` | 7/7 pass, rootless, named-volume stop/start/read-back; host loopback, cgroups disabled |
| `nix build .#checks.x86_64-linux.service-vm --out-link tmp/service-vm` | 1/1 booted NixOS VM test pass; seven successful shell commands, two exact-byte assertions; software QEMU |

Development failures and remaining limits:

- Initial proxy smoke ran before the new release binary finished building and
  failed startup. Two following runs hit pre-TLS connection rejection in the old
  concurrent HTTP-rate probe. The persistent-connection probe tests the HTTP
  limiter independently; a subsequent 18-check run and final 20-check run passed.
- Bare `podman load` failed because this host has no signature policy. A global
  `--signature-policy` attempt failed as an unknown flag; XDG and containers.conf
  attempts did not supply the policy to image loading. Explicit local-archive
  import through Skopeo succeeded. These were tooling failures before execution.
- The first published-port drill lacked `slirp4netns`; after provisioning it
  through Nix, start failed with `open("/dev/net/tun"): No such file or directory`.
  No device or privilege was added. The first host-network drill then exposed
  the image's environment overriding the config bind address; the script now
  passes an explicit bind override. The final rootless drill passes.
- Docker Compose, published container networking and cgroup resource enforcement
  were not run successfully here. A real host must check those deployment paths.
  The image itself and the NixOS unit were run, not merely evaluated. ARM and
  macOS deployments remain untested. All spawned services/proxies/browsers and
  the VM were stopped; the rootless drill removed its container/volume/storage.
- Admission tables and global transport/storage pools are bounded, not reserved
  tenancy or distributed denial-of-service protection. Host-local access to
  trusted loopback proxy ports remains trusted. The owner retains the later independent
  security-review decision before strong encryption claims; no new product
  decision is required for these fixes.

## Experimental direct-session client

Milestone D adds the off-by-default **Share → Experimental direct browser
sessions** flow described in [the direct-session design](direct-sessions-design.md).
Enter the service root URL by hand; there is no build default. Provision a
**relay-only** capability for each participant in the same namespace and deliver
it privately, separately from the invite. The UI keeps that bearer in memory,
never in the invite or project. Account authentication in milestone 10 will
resolve to this same principal boundary.

The signaling adapter also accepts a bounded `session` payload containing D's
signed identity/commitment/SDP messages. The existing AES-GCM room envelope still
protects these bytes. Document updates and assets travel over verified WebRTC
channels, not the service. A fresh derived rendezvous room each UTC minute stays
within the default 120-second absolute room lifetime. Configure at least that
lifetime; shortened operator limits can interrupt discovery. Clock disagreement,
blocked peer traffic and service failure remain visible connection failures.

For a real two-machine session, run from a third machine with SSH access to both:

```sh
nix develop -c npm run build
nix develop -c cargo build -p scribyra-sync
nix develop -c node scripts/direct-session-trial.mjs --mode=smoke --a=HOST_A --b=HOST_B --dry-run
nix develop -c node scripts/direct-session-trial.mjs --mode=smoke --a=HOST_A --b=HOST_B
nix develop -c node scripts/direct-session-trial.mjs --mode=mixed --a=HOST_A --b=HOST_B
```

`--help` lists the options. Hosts, SSH user and key come from those arguments or from
`SCRIBYRA_TRIAL_HOST_A`, `SCRIBYRA_TRIAL_HOST_B`, `SCRIBYRA_TRIAL_USER` and
`SCRIBYRA_TRIAL_KEY`; unnamed user and key fall to your SSH configuration. The script serves this build and a temporary relay-only
service on the local machine, reaches both through SSH reverse tunnels at 127.0.0.1,
and uses drivers and browsers already in each machine's Nix store: it refuses plainly
if they are missing and installs nothing. It writes a JSONL report of steps, rules,
offerer roles, candidate types and per-phase Wi-Fi and mesh bytes, without source,
invites, codes, addresses or capabilities. The app's service worker is withheld, so
its precache does not cross the mesh during measurement. It changes no firewall rule.

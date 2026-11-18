# Organisation deployments: server projects, sign-in, administration and compile

Design, 9 November 2026; rewritten 18 November 2026 for Paul's decisions of that day ([section 12](#12-decisions)), which move organisations to a model much like Overleaf: an organisation runs a **deployment** whose server stores its projects, people sign in only through OpenID Connect, members share projects by invitation, administrators see and control everything with an audit log, and the server can compile. End-to-end encryption remains, as a deployment setting. Revised the same day for Paul's further decision that deployments are cloud native, through a Kubernetes operator ([section 10](#10-deployment-on-kubernetes)). Implementation is on branch `feature/org-sync-v2`; [section 11](#11-slices) says what of the earlier slices 1–7 is kept, changed or removed, and which new slices are delivered. The end-to-end mode's protocol, built in slices 1–7, is kept in [Appendix A](#appendix-a-end-to-end-mode-protocol) with the parts this rewrite removes taken out.

Four rules frame everything below:

1. **Personal use without an organisation stays exactly as it is**: local, no account, no service. The app opens, edits, compiles and exports projects in the browser alone. Nothing below runs, opens a database or creates a key until a person connects to a deployment (*off means off*, D, 8 November).
2. **No login of our own.** People are identified only by OpenID Connect providers that the deployment configures. Scribyra stores no passwords, offers no passkeys, and no link or code ever signs anyone in.
3. **One binary, every feature free when self-hosted.** Paid hosting runs the same `scribyra-sync` with accounts and billing around it, never inside the product's capabilities.
4. **The deployment says what the server may read, and the app says it in plain words.** A server-readable deployment (the default) stores projects so the server can read them; an end-to-end deployment stores ciphertext only. Every member sees which one they are in.

## Summary

A **deployment** is one `scribyra-sync` service, its PostgreSQL database and its blob store, configured by one file. It serves one **organisation**. People sign in with one of the deployment's OIDC providers (the organisation's own identity provider, and on paid hosting perhaps Google, Microsoft or GitHub); the service is the relying party, keeps the provider's tokens to itself and gives the app a short-lived bearer session.

In the default **server-readable** mode the server is the authority for organisation projects. Each project is an append-only log of Yjs updates that the server sequences, validates and stores, encrypted at rest under a per-project data key that the deployment's master key wraps. Browsers keep a synced local copy in IndexedDB, edit it offline (unless the deployment is **online-only**), and reconcile through the log exactly as two tabs or two devices do today. Because the server can read projects, administrators can open, transfer, export and delete any project, the server can build snapshots and compile PDFs, and everything an administrator or member does is written to an append-only, hash-chained **audit log**.

Members share a project with other members as **editor**, **reviewer** or **viewer** by inviting them by email; an invitation waits until someone signs in with that verified email. Guests exist only as the identity provider's own guest accounts, and only if the deployment admits them. Share links are off by default and never replace sign-in.

**Server compile** (server-readable mode only) runs native TeX Live from nixpkgs, each job in a throwaway bubblewrap sandbox with no network, a seccomp filter, resource limits and a size-limited scratch directory, and no shell escape. The PDF is stored with the project and reaches every member; the app shows "Compiled on server". The deployment chooses server-only, browser-only or both, and with both each project chooses.

The optional **end-to-end** mode keeps the design of slices 1–7: signed membership log, device keys certified for each person, client-side encryption with per-epoch project keys, re-keying on removal. Its sign-in is OIDC too: device keys are bound to OIDC identities, but a device key never signs anyone in by itself. There is no server compile and no administrator reading in that mode.

## 1. Architecture

### Parties and stores

| Part | Holds | Notes |
| --- | --- | --- |
| **Browser app** (static, from Pages or the deployment) | Personal projects, local copies of organisation projects, outbox, cursors | The same app for personal use and every deployment. It contacts a deployment only after the person enters its address or opens a link that names it and confirms. |
| **`scribyra-sync`** (API and sync) | Nothing durable in memory: sessions, accounts, projects, shares, invitations, logs, the compile queue and the audit log are in PostgreSQL | Stateless replicas behind the deployment's ingress (section 10). Changes reach the replicas' long polls through PostgreSQL `LISTEN/NOTIFY`. The end-to-end mode's in-memory relay rooms and the single-writer advisory lock remain until slice 19 moves them to PostgreSQL. |
| **PostgreSQL** | All metadata and small log entries | Embedded `sqlx` migrations, unchanged from slice 1. |
| **Blob store** (filesystem or S3-compatible) | Large entries, snapshots, assets, history objects, PDFs and compile logs | The `BlobStore` trait from slice 1, unchanged. |
| **Compile workers** (`scribyra-sync compile-worker`) | Nothing durable | A separate Deployment that takes jobs from the PostgreSQL queue and runs each in a throwaway sandbox (section 6); in development the service can run one in-process. |
| **OIDC providers** | Who people are | Trusted for identity, never given project content. |

### Server-readable mode: the server is the authority

Each organisation project is a sequence of **entries** on the server:

| Kind | Body | Who writes it |
| --- | --- | --- |
| `update` | One Yjs update (binary) | A browser, for its own edits |
| `snapshot` | The whole Yjs state at a sequence number | The server, during compaction |
| `asset` | Not an entry: assets and history checkpoint objects are content-addressed objects (`SHA-256` of the plaintext) referenced from the Yjs document as today | A browser uploads before the update that references them |

Appending works as in slice 1, without client-side cryptography:

1. The app builds an update from the local document (below), stores it in its IndexedDB **outbox** with a per-browser client ID and the next `clientSeq`, and only then sends `POST /v1/sr/projects/{p}/log` with the raw update as the body and `Scribyra-Client` and `Scribyra-Client-Seq` headers.
2. The server checks the session, the person's role on the project (editors write updates; reviewer and viewer writes follow in slice 12), the size, that the body decodes as a Yjs update (`yrs`), and the project quota. It seals the body with the project's data key, assigns the next `seq` in the same transaction that records the entry (inline in PostgreSQL up to 64 KiB, otherwise in the blob store first, with the durable-write discipline of slice 1), and answers `201 {"seq": n}` only after commit. That answer is the durable acknowledgement.
3. A repeat of the same `(client, clientSeq, SHA-256 of body)` answers `200` with the original `seq`; the same `clientSeq` with other bytes is `409`, and the app stops and reports a fault.

Reading is `GET /v1/sr/projects/{p}/log?after=n&limit=k`: entries in order, with the current head in a `Scribyra-Log-Head` header. When `n` is below the compaction floor the server answers `410` with the latest snapshot's `seq`, and the app fetches `GET …/snapshot` and the entries after it. `GET /v1/sr/heads?wait=25` is a long poll that returns as soon as any project the caller can open (or its sharing, or its latest PDF) changes; it is a notice only, and the next catch-up repairs a lost one.

There is no hash chain and no device signature in this mode: the server is trusted with content, so a chain would only prove what the server already controls. Integrity against everyone else comes from TLS and the server's checks; integrity against the server is what end-to-end mode is for.

**Server-side snapshots.** The server can read the log, so compaction is the server's job: after 2,000 entries or 32 MiB since the last snapshot, a background task replays the snapshot and entries with `yrs`, writes a new `snapshot` covering `s`, and moves the floor to `s` once the snapshot is durable and older than the retention window (default 7 days, so offline copies resume from entries rather than a snapshot). Yjs tombstones and delete sets are kept, as D requires. The same replay gives the server a project's files for compile and export (section 6, section 4).

### How the CRDT and the local copy reconcile

Nothing changes inside the app's document model: a project is one `Y.Doc` with the same roots (`files`, `text:*`, `assets`, `trash`, `meta`, discussion and review roots) and the same validators. The local copy reconciles through the merge path that local tabs and slice 5's device sync already use:

- **Catch-up.** On start, on reconnect, and when the heads poll names a project, the app reads entries after its cursor, applies them to a copy of the local document, runs the existing validation (`validateReplica`: schema, lineage, retained-state bound, peer metadata, project structure), merges into the committed project through the merged-head save path, and tells an open editor to merge the new head. It advances the cursor and its **server vector** (the Yjs state vector of everything the server has acknowledged or sent) in the same IndexedDB transaction as the save.
- **Upload.** After each local save, and at most every two seconds while typing, the app encodes `Y.encodeStateAsUpdate(doc, serverVector)`: exactly what the server lacks. Updates are idempotent in Yjs, so an update that two browsers both send merges once.
- **Offline.** While offline, saves accumulate locally and in the outbox. On reconnect the app catches up first, then uploads. Text, tree and discussion merge through Yjs; concurrent binary replacements become recovery projects, as for local tabs.
- **New browser.** "Open" on a project not on this device downloads the latest snapshot and entries after it into a new local project bound to the deployment.

Assets and named-version checkpoint objects are uploaded as plaintext objects (`PUT /v1/sr/projects/{p}/objects/{sha256}`; the server checks the hash, seals and stores) before the update that references them, and fetched on demand like slice 6's encrypted objects.

### Online-only deployments

`offline: false` makes a deployment **online-only**:

- The app edits an organisation project only while it holds a valid session and its last request to the server succeeded within 30 seconds; otherwise the editor becomes read-only with "Reconnecting — editing is paused because Acme keeps projects online only."
- Every save is sent at once; the outbox holds only requests in flight. If a send fails, editing pauses until it is acknowledged, so no unsent work can pile up.
- The local copy is a cache: it is deleted at sign-out, when the session cannot be renewed, and on start when no session exists. Downloads stay possible (anyone who can read can copy), so online-only limits what lingers on shared or lost machines, not what a member can keep.

### End-to-end mode

`encryption: "e2ee"` runs the design of slices 1–7 ([Appendix A](#appendix-a-end-to-end-mode-protocol)): the signed membership log decides membership, clients encrypt entries, objects and snapshots with per-epoch project keys wrapped to member devices, the server stores and sequences ciphertext, verifies device signatures and enforces access, and removal starts a new epoch. Sign-in is OIDC (section 3). The server cannot compile, compact or export content, and administrators cannot read projects they are not members of.

### One mode per deployment

The encryption mode is fixed when a deployment first starts: the service records it in the database and refuses to start if the configuration later names the other mode. Moving between modes is an export from one deployment and an import into a new one (slice 18), never a silent switch. This replaces the earlier per-organisation modes and the "organisation-managed" mode with its consent flow, which are removed.

## 2. Deployment configuration

Everything about a deployment is in its one configuration file (`SCRIBYRA_SERVICE_CONFIG`, JSON, as since milestone S; each field can be overridden by `SCRIBYRA_SERVICE_<FIELD>`). The service-level fields (bind address, database URL file, blob store, rate limits, origins) are unchanged; a new `deployment` object holds the organisation's policy:

```json
{
  "public_url": "https://scribyra.acme.org",
  "origins": ["https://app.scribyra.org", "https://scribyra.acme.org"],
  "database_url_file": "database-url",
  "blob_store": "s3", "s3_endpoint": "https://s3.acme.org", "s3_bucket": "scribyra", "...": "...",
  "service_key_file": "master.key",
  "deployment": {
    "name": "Acme Lab",
    "encryption": "server",
    "offline": true,
    "compile": "both",
    "link_sharing": false,
    "guests": "off",
    "admins": ["it-admin@acme.org"],
    "providers": [
      {
        "id": "acme",
        "label": "Acme account",
        "issuer": "https://login.microsoftonline.com/<tenant>/v2.0",
        "client_id": "…",
        "client_secret_file": "acme-oidc-secret",
        "email_domains": ["acme.org"],
        "groups_claim": "groups",
        "admin_groups": ["scribyra-admins"],
        "member_groups": [],
        "guest": {"claim": "acct", "equals": "1"},
        "offline_access": true,
        "session_hours": 12,
        "recheck_minutes": 10
      }
    ],
    "quotas": {"deployment_bytes": 107374182400, "project_bytes": 1073741824, "member_bytes": 10737418240},
    "audit_retention_days": 400,
    "compile_limits": {"cpu_seconds": 60, "wall_seconds": 120, "memory_mib": 2048, "scratch_mib": 512, "output_mib": 64, "passes": 4, "concurrency": 2, "queue": 32, "per_member_per_hour": 120},
    "texlive": "/nix/store/…-texlive-2025-env"
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | required | Shown in the app's sign-in and project list. |
| `encryption` | `"server"` | `"server"` (server-readable) or `"e2ee"`. Fixed at first start (section 1). `"server"` needs `service_key_file`. |
| `offline` | `true` | `false` makes the deployment online-only. |
| `compile` | `"browser"` | `"browser"`, `"server"` or `"both"`. `"server"` and `"both"` need `encryption: "server"` and `texlive`. |
| `link_sharing` | `false` | Whether editors may create share links (section 4). |
| `guests` | `"off"` | `"off"` refuses provider guest accounts; `"shared"` admits them to projects shared with them only. |
| `admins` | `[]` | Verified emails (or `issuer#subject`) that are administrators whatever groups say; the bootstrap for a new deployment. |
| `providers` | required, 1–16 | OIDC providers (section 3). Each `id` is a short lowercase name; the redirect URI is `<public_url>/v1/sso/callback` for all of them. |
| `quotas` | as shown | Stored bytes per deployment, per project and per member's owned projects. Exceeding returns `507`; local saving continues. |
| `audit_retention_days` | `400` | 30–3650; older audit events are purged by a recorded purge (section 5). |
| `compile_limits` | as shown | Section 6. |
| `texlive` | none | A TeX Live tree from nixpkgs (the NixOS module fills it in). |

Storage (PostgreSQL URL file, filesystem or S3 blobs) stays in the existing service fields. The service validates the whole file at start and refuses to run with an inconsistent one (for example `compile: "server"` with `encryption: "e2ee"`), naming the field. `GET /v1/deployment` is public and tells the app what it needs before sign-in: `{name, encryption, offline, compile, linkSharing, providers: [{id, label}], org}` (`org` is the deployment's organisation ID, which end-to-end clients sign with; it is random, made at first start and recorded with the mode); secrets and issuers' client settings never leave the server.

In production the Kubernetes operator writes this file from the `Scribyra` resource into a Secret mounted read-only into every pod, with each referenced secret (client secrets, database URL, S3 keys, master key) as its own mounted file (section 10); the service reads nothing else and needs no writable disk except, with filesystem blobs, its data volume. The NixOS module and the Compose file stay for development only and are to be retired once the k3s path covers small installs.

## 3. Sign-in: OpenID Connect only

### What is removed

Scribyra no longer has any sign-in of its own: no passkeys (never built; dropped from the plan), no device-key login without a provider, no invitation links that admit people, no link codes that sign in a new device, and no setup codes. The `#join=` and device-link URL formats, `invite.create`/`person.join` with invitation keys, `POST /v1/orgs/{org}/device-links` and `…/{link}`, the setup-code genesis, the `scribyra-sync org create` and `org sso` commands and the per-organisation `org_sso` table are removed with their tests (section 10). Organisations are created from the configuration file.

### Providers and the relying party

Each provider is an OIDC issuer. The service is a confidential client using the authorization code flow with PKCE and a nonce, exactly as built in slice 3: discovery with an exact `issuer` match, JWKS by `kid` with RS256, ES256 or EdDSA only (no `none`, no HMAC, algorithm bound to key type), `aud` and `azp`, `exp`, `iat` within skew, `nonce`, and for providers with `email_domains` a verified email in one of them (and the `hd` claim for Google Workspace). Several providers per deployment are supported from the start; paid hosting can list "Google", "Microsoft" and "GitHub" (through an OIDC bridge, since GitHub's own OAuth is not OIDC) beside the organisation's IdP. A person's account is the pair `(provider, subject)`; the same email at two providers is two accounts unless an administrator merges them (slice 14), because providers do not vouch for each other's emails.

### Sessions

1. The app shows one "Sign in with …" button per provider. It creates a PKCE-style verifier, keeps it in `sessionStorage`, and calls `POST /v1/sso/start {provider, return, challenge}`; `return` must be one of the configured `origins`.
2. The app navigates at top level to the provider; after sign-in the provider redirects to `/v1/sso/callback`, the service exchanges the code and verifies the ID token, and redirects to `<app>/#scribyra-sso=<one-time code>`.
3. The app redeems the code with the verifier (`POST /v1/sso/redeem`) and receives an opaque **session token** (the service stores its SHA-256), its expiry and the account (`{account, email, name, role}`).

The token is a bearer token sent in `Authorization`; the app keeps it in `sessionStorage` and IndexedDB (so a reopened tab resumes), never in cookies, because the app's origin and the deployment's usually differ and third-party cookies are unreliable in all three engines. CORS allows only the configured origins.

**Refresh.** Sessions last `session_hours` (default 12). When the provider issued a refresh token (`offline_access`), the service re-checks it every `recheck_minutes` (default 10) and keeps the newest refresh token; the app never sees provider tokens. When a session expires the app shows "Sign in with Acme again"; with an active provider session that is one redirect. Local work continues meanwhile (unless online-only).

**Logout.** "Sign out" calls `POST /v1/sso/logout`, which revokes the session; the app then forgets the token and, in an online-only deployment, deletes local copies. When the provider advertises `end_session_endpoint`, the app offers "Also sign out of Acme", which navigates there with `id_token_hint` (kept by the service, handed over once for this purpose) and `post_logout_redirect_uri`. Back-channel logout tokens (Keycloak and others) revoke sessions at once, as built. A provider that disables a person makes the next re-check fail with `invalid_grant`: the service revokes their sessions and marks the account **blocked** until an administrator unblocks it or the provider admits them again.

**Group-to-role mapping (optional).** With `groups_claim`, members of `admin_groups` are administrators; when `member_groups` is non-empty, only people in it (or `admins`) may sign in at all. Roles from groups are recomputed at every sign-in and re-check, so removing someone from the admin group at the IdP takes effect within one re-check. Without groups, the `admins` list and the admin area decide roles. Entra ID users with many groups should use app roles in the `roles` claim (set `groups_claim: "roles"`).

**Guests.** Providers mark guests differently (Entra `acct = 1`, a guests group, a separate issuer); `guest` in the provider configuration names the claim and value. With `guests: "off"` such sign-ins are refused ("Guest accounts can't use Acme's Scribyra"). With `"shared"` a guest account can open projects shared with it, with the role it was given, but cannot create projects, browse the member directory or be made an administrator. Nobody becomes a guest any other way: there are no Scribyra-made guest accounts.

### Accounts and roles

| Deployment role | Can |
| --- | --- |
| **Administrator** | Everything (section 5). |
| **Member** | Create projects; share their projects; see the member directory (names and emails) to share with. |
| **Guest** | Open projects shared with them; nothing else. |

Accounts are created at first sign-in (members and admitted guests). An administrator can disable an account (sessions revoked at once, sign-in refused) and remove it (shares removed, owned projects transferred to a chosen member or to the administrator).

### End-to-end mode: binding device keys to OIDC identities

End-to-end mode still needs device keys, because only devices hold project keys. They are bound to OIDC identities without becoming a login:

- **Session.** Every org session requires a live OIDC session. `POST /v1/auth/session` takes the OIDC session token *and* a device signature over `(service, org, device, OIDC session hash, server challenge)`; it succeeds only if the device is active in the membership log for the person linked to that OIDC account. A device key alone is never enough; an OIDC session alone gives no keys. Device sessions end with the OIDC session.
- **Joining.** Someone who signs in and has no person yet sends `person.request` with their new device's keys; an administrator's app shows "Ben (ben@acme.org, via Acme) asks to join" and signs `person.approve`. The service links `(provider, subject)` to the person when it accepts the request. Invitations by email (section 4) pre-fill the role and let the admin's app approve a matching request in one step; the approval is still an admin's signature, because the clients cannot verify a provider's claims.
- **Bootstrap.** The organisation's genesis is signed by the first configured administrator to sign in; the service accepts a genesis only from an OIDC session of an account in `admins`, and only once.
- **New devices.** A new device of a signed-in person posts a device request (the slice 5 SSO path); an existing device of that person compares codes and signs `device.add`; with no device left, the recovery kit plus an OIDC session re-enrols, or an administrator re-enrols after comparing codes.
- **Blocking.** Provider disablement closes device sessions at once; key access ends with the next epoch once an administrator removes the person (Appendix A).

## 4. Sharing

**Projects have one owner** (who created it, or to whom it was transferred) and shares: `(project, account, role)` with roles editor, reviewer or viewer, as before mapped to the app's modes (Editing/Reviewing/Viewing; reviewers and viewers comment).

**Invitations.** An owner or editor invites by email with a role: `POST /v1/sr/projects/{p}/invitations {email, role}`. If an account with that verified email exists the share is created at once; otherwise the invitation waits and turns into a share the first time someone signs in with that verified email (through a provider whose `email_domains`, or verified-email claim, vouch for it). Invitations expire (default 30 days) and can be withdrawn. Inviting does not send email in this slice; the app shows "Ask Ben to sign in to Acme's Scribyra", and the project appears in his list. Guests can be invited only when `guests: "shared"`.

**Share links** (`link_sharing: true` only, slice 13): an editor creates a link that grants viewer or reviewer access to any signed-in account of the deployment that opens it (never anonymous, never to accounts the deployment refuses). Links can be revoked and are audited.

**In end-to-end mode** sharing is the signed `project.grant` of Appendix A, to people already in the organisation; email invitations bring people into the organisation as above.

## 5. Administration and the audit log

### The admin area

Administrators get an **Admin** area in the app (server-readable and end-to-end, with what each mode allows):

| Action | Server-readable | End-to-end |
| --- | --- | --- |
| Members: list (name, email, provider, role, last seen, storage), change role, disable, remove | Yes | Yes; removal also signs `person.remove` and starts new epochs |
| Projects: list all (name, owner, members, size, last change) | Yes | IDs, owners, members and sizes; names only for projects the admin can decrypt |
| Open any project | Yes, read-only by default ("Open as administrator"); "Edit as administrator" adds an explicit editor share. Both audited. | Only projects they are a member of |
| Transfer ownership | Yes | Yes (owner field and grants) |
| Delete a project | Yes, with crypto-erase (below) | Yes (`project.delete`) |
| Export everything | A zip with every project (source files, assets, a `.scribyra-backup` each), the member list and the audit log | Ciphertext archive plus member list and audit log |
| Audit log: view, filter, export | Yes | Yes |
| Deployment settings | Read-only view of the configuration file's policy | Same |

Administrator actions on content are never silent to members: a project opened by an administrator shows "An administrator opened this project on 18 November" in its activity (from the audit log).

### Audit log

Every security-relevant action is one row in `audit_events`: `seq` (gap-free), time, actor (account or `system`), the actor's IP address (or the forwarded one from a trusted proxy), action, target (type and ID), a small JSON detail, `prev` and `hash = SHA-256(prev ‖ canonical row)`.

Recorded actions: sign-in, sign-out, sign-in refused (with reason), session revoked by the provider; account created, role changed, disabled, unblocked, removed; project created, opened by an administrator, deleted, ownership transferred, renamed by an administrator; share created, changed, removed; invitation created, accepted, withdrawn; share link created and used; export (by whom, of what); compile mode changed; audit export and purge; deployment start with a hash of the policy (so configuration changes appear).

- **Append-only.** The service's database role inserts audit rows only through one function; a trigger refuses `UPDATE` and `DELETE` on `audit_events` except the purge function. The hash chain makes later edits by anyone with database superuser rights detectable (`scribyra-sync audit verify`), and each export carries the head hash so an exported copy can be compared later.
- **Retention.** A daily task deletes events older than `audit_retention_days` and appends an `audit.purge` event recording how many and the hash of the last purged event, so the chain stays verifiable from the purge point.
- **Export.** `GET /v1/admin/audit/export?from&to&format=jsonl|csv`, streamed, itself audited. Administrators can filter by actor, action, target and time in the app.
- **Not logged.** Project content, ID tokens, session tokens, email bodies; email addresses appear only as account details.

### Deletion that really deletes

In server-readable mode each project has its own random data key, stored only wrapped by the master key. Deleting a project deletes the wrapped key in the same transaction that marks the project deleted; entries, snapshots, objects and PDFs are then unreadable everywhere, including database dumps and bucket backups made before, and a background task removes the rows and objects. Members' local copies are offered "Keep a local copy or delete it" on their next connection. End-to-end deletion is as in Appendix A.

## 6. Server compile

Available only when `encryption` is `"server"` and `compile` is `"server"` or `"both"`.

### Flow

1. An editor (or the app on save, when the project compiles on the server) calls `POST /v1/sr/projects/{p}/compile` with the head `seq` it has seen. Viewers and reviewers can read compiled PDFs but not start compiles.
2. The server materialises the project at that `seq` (or its head) with `yrs`: the file tree, text and asset objects, main file, engine (`pdflatex`, `xelatex` or `lualatex`) and bibliography tool from the project's settings. If a PDF for the same content hash, engine and TeX Live version exists, it is reused.
3. The job enters a FIFO queue in PostgreSQL (`compiles` rows taken with `SELECT … FOR UPDATE SKIP LOCKED`; bounded by `queue`, with at most one queued or running job per project; a newer request replaces a queued one). Each worker runs `concurrency` jobs at once; a job whose worker stops heartbeating is requeued once, then failed. The queue length is exported as a metric that scales the worker Deployment (section 10).
4. A worker writes the files into a fresh scratch directory and runs the engine (and BibTeX or Biber) up to `passes` times inside the sandbox, rerunning while the log asks for it.
5. The PDF and the log are sealed with the project's data key and stored as objects; `compiles` records the job (project, `seq`, content hash, requester, status, times, CPU time, sizes). The heads poll tells every member; their apps download the PDF and show it with "Compiled on server · 18 Nov 14:02 · from your latest changes" (or "from an older version" when local edits are newer).

Only the latest successful PDF and log per project, plus the last failed log, are kept; older ones are deleted. The PDF counts against the project quota.

### Compile mode

The deployment chooses `browser` (today's BusyTeX in WebAssembly only), `server` (server only: the app's Compile button queues a server compile and its in-browser compiler stays unloaded for organisation projects) or `both`. With `both`, each project has a **compile** setting (`browser` or `server`, default `browser`) that its owner or an editor changes; the change is audited and shown to members. Personal projects always compile in the browser.

### Sandbox: choice

TeX is a full programming language and project content is untrusted. Candidates on NixOS:

| Option | Isolation | Runs unprivileged / in LXC | Limits | Cost |
| --- | --- | --- | --- | --- |
| **bubblewrap + seccomp + rlimits + cgroup slice** | Linux namespaces (user, mount, PID, network, IPC, UTS, cgroup), empty root with read-only binds, seccomp-BPF syscall filter | Yes (unprivileged user namespaces; verified in this deployment's LXC) | rlimits per job; cgroup v2 memory/CPU/tasks through the service's systemd slice | Milliseconds to start; tiny, audited C program used by Flatpak; in nixpkgs |
| nsjail | Same namespace set, built-in seccomp (Kafel) and cgroup support | Namespaces yes; its cgroup features need delegation or root | Built in | Larger configuration surface; fewer users |
| `systemd-run` transient units (`PrivateNetwork`, `SystemCallFilter`, `DynamicUser`, `MemoryMax`) | Namespaces and seccomp via systemd | Needs the system manager (root or polkit rule); not available to an unprivileged service | Excellent (cgroups) | Couples the service to PID 1; slower start |
| gVisor (`runsc`) | User-space kernel: syscalls never reach the host kernel directly | Rootless mode is limited; needs `runsc` and an OCI bundle | Via the OCI runtime | Strongest of these against kernel bugs; 10–30% slower for TeX's file-heavy work; more moving parts |
| Firecracker micro-VM | Hardware virtualisation | Needs `/dev/kvm` (not in this LXC) | VM sizing | Strongest; image management and boot time |
| BusyTeX WebAssembly under wasmtime (the 17 November proposal) | Wasm sandbox | Yes | Fuel and memory | Same output as the browser, but slow and an incomplete TeX Live; Paul chose native TeX Live |

**Recommendation and implementation: bubblewrap** with a seccomp filter and rlimits for each job, inside a worker pod that is itself confined. On Kubernetes the worker pod runs with `hostUsers: false` (user namespaces, Kubernetes 1.33 and later) so bubblewrap can create its namespaces without privileges, a read-only root file system, all capabilities dropped, a `RuntimeDefault`-based seccomp profile that additionally allows `unshare`/`clone` of user namespaces, memory and CPU limits on the pod, and a NetworkPolicy denying all egress except PostgreSQL and the blob store. For paid hosting the operator can set a **gVisor `RuntimeClass`** on the worker pods: the jobs' system calls then reach gVisor's user-space kernel, not the host's, while bubblewrap still separates jobs from the worker and from each other. The runner is one trait in the worker, so a micro-VM runner can follow without changing the queue. Outside Kubernetes (development) the same bubblewrap runner works on any Linux with unprivileged user namespaces, verified in this LXC.

Each job:

- `bwrap --unshare-all --die-with-parent --new-session --clearenv`, a fresh tmpfs root, `--ro-bind` of exactly the TeX Live closure from `/nix/store` (computed from the store paths, not all of `/nix/store`), a minimal `/dev`, no `/proc` (nothing in a compile needs it, and it would show the host), the scratch directory as the only writable path (a tmpfs with `--size` = `scratch_mib`), no home, `HOME` and `TEXMFVAR` inside scratch, a fixed `SOURCE_DATE_EPOCH`.
- No network: a new, empty network namespace (only bwrap's loopback).
- A seccomp filter (generated by the service and passed with `--seccomp`): an allow list of the system calls bash, coreutils, the engines, BibTeX and xdvipdfmx make (everything else `ENOSYS`), which first refuses `ptrace`, `mount`, `umount2`, `pivot_root`, `unshare`, `setns`, `clone` with namespace flags, `keyctl`, `add_key`, `request_key`, `bpf`, `perf_event_open`, `userfaultfd`, `io_uring_*`, `personality`, kernel module and reboot calls, `memfd_create`, and `socket` for every family except `AF_UNIX`.
- A cgroup v2 per job under a **delegated subtree** (a systemd unit with `Delegate=yes`; on Kubernetes the worker pod's own cgroup through its cgroup namespace; for development a `systemd-run --user --scope -p Delegate=yes` scope; without one, nothing runs unless an explicit development-only opt-in): `memory.max` = `memory_mib` including the scratch tmpfs and shared memory, no swap, OOM kills the whole job, `pids.max`, one CPU, CPU time metered from `cpu.stat` (orphans included) and the job killed when it passes `cpu_seconds`.
- rlimits as well: CPU seconds and address space per process, file size (`output_mib`), open files (256), processes (64), no core dumps; a wall-clock deadline after which the job's cgroup and PID namespace are killed.
- TeX settings: `-no-shell-escape`, `-interaction=nonstopmode`, `-halt-on-error`, `openin_any=p` and `openout_any=p` (paranoid: no absolute paths, no `..`, no dot files; LuaTeX reads with `openin_any=r` because luaotfload opens TeX Live files by absolute path, which is safe as the sandbox holds nothing else), `shell_escape=f` in the environment kpathsea reads, so even a package that tries `\write18` gets nothing.
- Nothing from the job is trusted afterwards: the service reads only the PDF and log (regular files, through `O_NOFOLLOW`), with size limits, and deletes the scratch directory.

### TeX Live and the package cache

TeX Live comes from nixpkgs (`texliveSmall` by default, `texlive.combine { … }` for more): one read-only, content-addressed tree in `/nix/store`, shared by every job and every project — the server's shared package cache. Formats and font maps are prebuilt by Nix; per-job font caches (LuaTeX) live in scratch and are discarded, with an optional read-only, pre-warmed `luaotfload` cache built at deployment time. Projects that need packages outside the configured scheme fail with the usual "File `x.sty' not found" and the app suggests asking the administrator.

The **browser's** compile keeps its own per-device cache. A deployment can also serve the BusyTeX package files the browser fetches on demand (`GET /v1/tex/{name}`, a content-addressed, catalog-checked mirror; slice 15), so a fresh device inside the organisation does not fetch hundreds of files from the internet.

### Abuse and cost

Per member: `per_member_per_hour` compiles; per deployment: `concurrency` and `queue`. Infinite loops end at the CPU limit, output bombs at the file-size limit, fork bombs at the process limit, memory bombs at the job's cgroup memory limit (and the address-space limit per process). Paid hosting meters CPU seconds per organisation from `compiles`.

## 7. Storage

PostgreSQL and the `BlobStore` (filesystem or S3) from slice 1 are kept. New tables for server-readable mode (migration `0007`):

| Table | Columns (abridged) |
| --- | --- |
| `deployment` | `id, encryption, created, policy_hash` (one row; the fixed mode) |
| `accounts` | `account, provider, subject, email, email_verified, name, role, guest, state, created, last_seen` |
| `sessions` | `token_hash, account, provider, refresh_token, id_token, expires, checked, revoked` (OIDC sessions; the slice 3 `sso_logins` table is generalised) |
| `sr_projects` | `project, owner, name, created, updated, deleted, head_seq, floor_seq, bytes, data_key_wrapped, compile` |
| `sr_shares` | `project, account, role, created_by, created` |
| `sr_invitations` | `invitation, project, email, role, created_by, created, expires, state` |
| `sr_clients` | `project, client, last_client_seq` (idempotency) |
| `sr_entries` | `project, seq, kind, account, client, client_seq, body_hash, size, inline_sealed, blob, received` |
| `sr_objects` | `project, hash, size, blob, created` |
| `compiles` | `job, project, seq, content_hash, engine, requested_by, state, queued, started, finished, cpu_ms, pdf_blob, log_blob, pdf_bytes` |
| `audit_events` | section 5 |

**Sealing at rest.** The master key (32 bytes, `service_key_file`, outside the database and its backups) wraps each project's data key with XChaCha20-Poly1305 (associated data: deployment ID and project ID). Entry bodies, snapshots, objects, PDFs and logs are sealed with the data key and associated data naming the project, kind and sequence or hash, so ciphertext cannot be moved between projects or slots. **Why not plain?** A server-readable deployment must read projects in the service process, so encryption at rest cannot protect against the running service or anyone who holds both the database and the key file. It does protect the cases that dominate in practice: a leaked `pg_dump`, a misconfigured or stolen bucket, a backup tape, a hosting provider's storage staff, and deleted projects in old backups (crypto-erase). Its cost is one key file to back up separately and a few microseconds per entry. Operators may still rely on disk encryption; it covers none of these cases.

Quotas count stored (sealed) bytes per project, per owner and per deployment, with the serialised usage rows of slice 1.

## 8. Threat model

### Server-readable mode

| Adversary | Can | Cannot |
| --- | --- | --- |
| Operator / anyone controlling the running service | Read and change every project; impersonate anyone to the app; read the audit log; turn off auditing by changing the binary | Hidden from the operator: nothing. This mode trusts the operator, and the app says so: "Acme's server stores and can read this project. Administrators can open it." |
| Thief of a database dump or bucket (without `service_key_file`) | See metadata: account emails and names, project names, sizes, times, shares, the audit log | Read project content, assets, PDFs or deleted projects |
| Thief of dump and key file | Read everything not yet crypto-erased | Read projects deleted before the dump's key rows were removed |
| Administrator | Everything in section 5, through the app, audited | Act unaudited without database access; read end-to-end projects (other mode) |
| Member | Read and copy projects shared with them; edit as editors; invite within their projects | Open unshared projects; read the audit log; escalate role |
| Reviewer / viewer | Read and copy; comment (once slice 12 lands) | Change source (server refuses their updates) |
| Removed or disabled member | Keep local copies already downloaded | Reach the server after the next request (sessions revoked at once) |
| Compile job (malicious document) | Use CPU, memory and scratch up to its limits; read the TeX Live tree | Reach the network, other projects, the service's files, the database or other jobs; persist anything; escape without a kernel or bubblewrap vulnerability |
| Compromised OIDC provider | Sign in as anyone at that provider, including administrators by group | Act as accounts of other providers; avoid the audit log |
| Network attacker | TLS metadata | Read or change traffic (TLS required off loopback) |

### End-to-end mode

As [Appendix A.4](#a4-threat-model-end-to-end-mode): the operator sees metadata only and cannot read content, forge entries or give anyone keys; a compromised provider can admit people to the service and to pending join requests but cannot give them keys, because joining needs an administrator's signature and keys come only from members' devices. Administrators read only projects they belong to. No server compile, server snapshots or administrator export of plaintext.

### Common

Out of scope: a malicious app build (the app is the trusted computing base; reproducible builds are milestone 12), compromised browsers or extensions, preventing a reader from copying, remote wipe, traffic analysis. An independent security review remains Paul's decision before public claims.

## 9. App experience

- **Connect.** All projects → **Organisation** → enter the deployment address (or open `https://app/#deployment=<address>`, which only pre-fills it). The app shows the deployment's name, mode sentence and sign-in buttons. Signing in shows the person's projects.
- **Project list.** Groups: **On this device** (personal) and the deployment ("Acme Lab · scribyra.acme.org"). Org projects on this device open as today; others show **Open** (downloads). Status per project: Saved on this device · Syncing… · Synced · Waiting to sync (offline) · Read only · No longer shared with you.
- **Add to Acme** on a personal project uploads it as a new organisation project (after the disclosure of what moves: source, assets, comments, history, trash), keeping the local one unless the person chooses to move it.
- **Share** lists people with roles and pending invitations, with "Invite by email" and a role picker.
- **Mode sentences.** Server-readable: "Stored on Acme's server, which can read it. Acme's administrators can open it." End-to-end: as Appendix A.
- **PDF.** Server compiles show "Compiled on server" with time and whether it reflects the latest changes; the Compile button says "Compile on server" when that is the project's mode.
- **Admin** (administrators only): Members, Projects, Audit log, Export, Settings.

## 10. Deployment on Kubernetes

Decided by Paul on 18 November 2026: deployments are cloud native. A **Kubernetes operator** is the default and probably the only supported deployment method; a single-node **k3s** install is the small-install path. The NixOS module (`nix/service-module.nix`) and `compose.yaml` remain for development and the existing tests only, and are to be retired once the k3s path covers small installs.

### The operator

`scribyra-operator` is a Rust binary built with **kube-rs** (`kube`, `k8s-openapi`, `kube-runtime` controllers), in the same workspace as the service, so the CRD types, configuration validation and defaults share code with `crates/sync` (`config::Deployment` is serialised into the generated service configuration). It watches `Scribyra` resources and the objects it owns, reconciles idempotently, and reports progress in status conditions. It is installed on its own: one manifest (or a Helm chart that contains only the operator: CRD, namespace, ServiceAccount, RBAC scoped to what it manages, the operator Deployment). Deployments are then created as resources, never by the chart.

### The `Scribyra` resource

```yaml
apiVersion: scribyra.org/v1alpha1
kind: Scribyra
metadata: {name: acme, namespace: acme}
spec:
  version: "1.4.0"                      # orchestrated upgrades (below)
  domain: scribyra.acme.org             # app, API and OIDC callback on one origin
  ingress: {className: nginx, gateway: null, issuerRef: {kind: ClusterIssuer, name: letsencrypt}}
  name: Acme Lab
  encryption: server                    # server | e2ee; fixed after first start
  compile:
    mode: both                          # browser | server | both
    texlive: small                      # small | medium | full image variant
    runtimeClassName: gvisor            # optional
    workers: {min: 0, max: 8, jobsPerWorker: 2}
    limits: {cpuSeconds: 60, wallSeconds: 120, memoryMiB: 2048, scratchMiB: 512, outputMiB: 64}
  offline: true
  linkSharing: false
  guests: "off"
  admins: [it-admin@acme.org]
  providers:
    - id: acme
      label: Acme account
      issuer: https://login.microsoftonline.com/<tenant>/v2.0
      clientId: "…"
      clientSecretRef: {name: acme-oidc, key: client-secret}
      emailDomains: [acme.org]
      groupsClaim: groups
      adminGroups: [scribyra-admins]
  masterKeyRef: {name: acme-master-key, key: key}   # generated by the operator if absent; must be backed up
  postgres:
    external: {urlSecretRef: {name: acme-db, key: url}}
    # or provisioned: {cloudNativePG: {instances: 1, storage: 20Gi, backup: {...}}}
  storage:
    external: {endpoint: https://s3…, bucket: acme, region: …, credentialsSecretRef: {name: acme-s3}}
    # or provisioned: {garage: {storage: 50Gi}}   (single node; MinIO is not used: licence)
  api: {replicas: 2, autoscaling: {min: 2, max: 10, targetCPU: 70}}
  quotas: {deploymentBytes: 100Gi, projectBytes: 1Gi, memberBytes: 10Gi}
  auditRetentionDays: 400
  backups: {schedule: "0 3 * * *", retentionDays: 30, destination: {s3: {…, credentialsSecretRef: …}}}
status:
  conditions: [Ready, DatabaseReady, StorageReady, MigrationsApplied, CompileReady, CertificateReady, UpgradeInProgress, Degraded]
  version: "1.4.0"
  url: https://scribyra.acme.org
```

Admission validation (CEL rules in the CRD plus a validating webhook for cross-field rules) refuses the same inconsistent combinations as the service (for example server compile with `e2ee`) and changes to `encryption` after first start.

### What it reconciles

| Component | Kubernetes objects | Notes |
| --- | --- | --- |
| **API and sync** | Deployment (`scribyra-sync serve`), Service, HorizontalPodAutoscaler, PodDisruptionBudget | Stateless; configuration is a generated Secret mounted read-only, each referenced secret as its own file. Liveness `/health`, readiness `/ready`; SIGTERM stops accepting, drains requests and closes long polls with "retry" so clients reconnect to another replica. |
| **Live updates between replicas** | PostgreSQL `LISTEN/NOTIFY` | A sequenced entry, share change or finished compile `NOTIFY`s the project; every replica wakes its waiting heads polls. The relay for awareness forwards frames between replicas the same way (small frames only; slice 16). |
| **Compile workers** | Deployment (`scribyra-sync compile-worker`), optional `runtimeClassName`, scaled on queue length (KEDA `postgresql` scaler when present, otherwise an HPA on the `scribyra_compile_queue_length` external metric) down to zero | Pods with `hostUsers: false`, read-only root, no capabilities, seccomp profile allowing user namespaces for bubblewrap, the pod's own cgroup (cgroup namespace) writable by the worker so it can make one cgroup per job (section 6), `emptyDir` (memory-backed, size-limited) scratch. The TeX Live tree is in the worker image (`texlive` variant chosen in the spec, built with Nix). |
| **Static web app** | Served by the API Deployment from its image at `https://<domain>/` | The app and the API share one origin, so CORS and the OIDC `return` are same-origin; the public Pages app can still connect to any deployment by address. |
| **Migrations** | A `Job` per version (`scribyra-sync migrate`) | Run before the new API ReplicaSet rolls out; the API refuses to start against a newer schema it does not know. |
| **Ingress / Gateway API** | Ingress or HTTPRoute, cert-manager `Certificate` | TLS always; long-poll timeouts set on the route. |
| **NetworkPolicies** | Default deny per namespace | API: ingress from the ingress controller, egress to PostgreSQL, storage, and the OIDC issuers (HTTPS). Workers: egress to PostgreSQL and storage only. Database and storage: from API, workers and backup jobs only. |
| **PostgreSQL** | External (secretRef) or a CloudNativePG `Cluster` | CloudNativePG brings WAL archiving and point-in-time recovery. |
| **Object storage** | External S3 (secretRef) or a single-node Garage StatefulSet | Garage is already the S3 used in tests. |
| **Backups** | CronJob or CloudNativePG `ScheduledBackup` plus a bucket copy job, in the order of [Appendix B](#appendix-b-operator-backup-and-restore) (database first, then blobs); the master key is reported in status as "must be backed up separately" | Restore is a documented `Scribyra` with `restoreFrom`. |

**Upgrades.** Changing `spec.version` makes the operator check the upgrade path (no skipped migration series), set `UpgradeInProgress`, run the migration Job, roll the API and workers with `maxUnavailable: 0`, then clear the condition. Migrations are additive within a minor series so old and new replicas can serve together during a rollout; destructive steps wait for the next version.

**Multi-tenant hosting.** One `Scribyra` per customer namespace, with namespace ResourceQuotas, per-tenant NetworkPolicies, and shared (or per-tenant) CloudNativePG clusters and buckets. Billing and sign-up live outside the product and create or update `Scribyra` resources. Compile workers of different customers never share a pod; with gVisor they do not share a host kernel either.

**Small installs.** `curl … | sh` installs k3s, the operator manifest and cert-manager, then applies a `Scribyra` with provisioned PostgreSQL and Garage on local-path volumes. That is the replacement for Compose.

### Observability and supply chain

- **Telemetry.** The service and workers already emit structured JSON events; they gain OpenTelemetry traces (OTLP endpoint from the spec) and a Prometheus `/metrics` endpoint on a separate port: requests by route and status, sync appends and catch-up latency, long polls open, queue length, compile durations and outcomes, sandbox limit kills, OIDC sign-ins and refusals, audit events written. The operator exposes its own reconcile metrics and creates `ServiceMonitor`s when the Prometheus operator is installed. No project content or personal data in metrics or traces.
- **Images.** Built with Nix (`dockerTools.buildLayeredImage`), multi-arch (amd64, arm64), one image for API and operator plus a worker image per TeX Live variant; each signed with cosign (keyless, from CI) with an SPDX SBOM attached and SLSA provenance; the operator can refuse unsigned images through a policy controller.
- **CI.** A kind cluster (and a k3s job) installs the operator manifest, applies a `Scribyra` with provisioned PostgreSQL and Garage and the local test OIDC provider, and runs a browser spec against it: sign in, add a project, sync to a second profile, compile on the server, upgrade to the current build, back up and restore.

## 11. Slices

### What happens to slices 1–7

| # | Slice | Status | What changes |
| --- | --- | --- | --- |
| 1 | Personal encrypted backup on Postgres | **Changed** | Kept: PostgreSQL with migrations, `BlobStore` (filesystem, S3), `migrate-sqlite`, NixOS module and Compose (development only, section 10), durable acknowledgements, outbox, rollback re-upload. Removed: the account-less personal backup to a service (setup code, device-key sign-in). Personal use is local only; a person's private projects on a deployment are organisation projects nobody else is shared on. The recovery kit stays for end-to-end mode. |
| 2 | Organisations | **Changed** | The organisation comes from the configuration file; setup codes and `org create` are removed; "organisation-managed" mode and per-organisation encryption modes are removed (replaced by the deployment's `encryption`); admin read access as a setting is removed (server-readable admins read by design; end-to-end admins read only what they belong to). Directory key and encrypted names stay in end-to-end mode. |
| 3 | Single sign-on | **Kept and extended** | Required for every session; several providers per deployment from the configuration file instead of `org sso` per organisation; group mapping and guests added. |
| 4 | Invitations, membership, roles | **Changed** | Invitation links and `person.join` with invitation keys are removed; joining is an OIDC sign-in (server-readable) or an OIDC join request approved by an administrator (end-to-end). Roles, removal and project sharing are kept. |
| 5 | Device sync | **Changed** | Link-code device linking is removed; new devices are added through an OIDC sign-in (end-to-end: approved by the person's other device or the recovery kit). Catch-up, outbox and offline reconciliation are kept and reused by server-readable mode. |
| 6 | Encrypted assets and history | **Kept** for end-to-end mode | Server-readable mode stores the same objects sealed by the server instead. |
| 7 | Re-keying on removal | **Kept** for end-to-end mode only | Server-readable removal revokes sessions and shares at once. |

### New plan

| # | Slice | Acceptance |
| --- | --- | --- |
| 8 | **Removal of own sign-in** (setup codes, invite links, link codes, device-key-only sessions, managed mode, `org create`/`org sso`); providers in the configuration file; end-to-end orgs bootstrap from `admins`. | Every remaining end-to-end flow passes with OIDC only; no route accepts a device signature without an OIDC session. |
| 9 | **(a) Deployment configuration and server-readable projects.** The `deployment` config and `GET /v1/deployment`; accounts and roles from OIDC; server-readable projects with sealed log, objects, snapshots, idempotent appends, catch-up, heads; the browser's local copies with offline on and off; sharing by email invitation. | Rust against PostgreSQL with filesystem and S3 blobs: durable acks, idempotent retry, 409 on reuse, role checks, quota, sealed at rest (a plaintext marker is absent from database and blobs), crypto-erase. Browser (Chromium, Firefox, WebKit): sign in, add a project, a second person invited by email opens and edits it, edits sync live and after offline work on both sides; online-only pauses editing offline and leaves no local copy after sign-out. |
| 10 | **(b) Admin area and audit log.** | Admin lists, opens, transfers, deletes and exports; a non-admin is refused every admin route; every action appears once in the audit log in order; the chain verifies and detects a changed row; `UPDATE`/`DELETE` are refused; retention purges and records it; export is complete. Browser specs for the admin area in all three engines. |
| 11 | **(c) Server compile.** Sandbox runner, queue, limits, cache, PDF sharing, compile mode. | Real TeX Live from nixpkgs compiles a project; `\write18`, network access, reading outside the project, fork, memory and output bombs, and infinite loops all fail safely within limits; the PDF reaches another member's browser with "Compiled on server"; modes and the project switch are enforced. **Progress:** sandbox runner delivered on branch `feature/org-compile-sandbox` (crate `scribyra-compile`, `docs/service.md` "Server compile sandbox"; integration tests with real TeX Live and bwrap cover every acceptance case above except the queue, sharing and modes, which remain; review findings H1, M1–M3 and L1–L4 fixed with regression tests). |
| 12 | Reviewer and viewer writes (server-side role scope check in server-readable mode; receiver check in end-to-end mode, Appendix A). | |
| 13 | Share links and guest policy refinements. | |
| 14 | Account merge across providers; administrator unblock; email notifications (optional SMTP). | |
| 15 | Shared TeX package mirror for browser compiles. | |
| 16 | Awareness (cursors) over the relay for both modes. | |
| 17 | End-to-end recovery, compaction and garbage collection (former slices 9 and 11). | |
| 18 | Export/import between deployments and modes. | |
| 19 | Stateless end-to-end mode: sessions, relay rooms and heads in PostgreSQL; drop the single-writer lock. | Two API replicas behind one ingress pass every org spec. |
| 20 | **Kubernetes operator** (section 10): CRD, reconcilers, k3s small install, CloudNativePG and Garage provisioning, upgrades with migration Jobs, backups. | kind and k3s end-to-end tests in CI: install, sign in, sync, compile, upgrade, back up and restore. |
| 21 | Images and supply chain: signed multi-arch images with SBOMs; OpenTelemetry and Prometheus metrics. | |
| 22 | Multi-tenant paid hosting on the operator (one `Scribyra` per customer namespace). | |

**Slice 8 status (18 November 2026): delivered** on `feature/org-sync-v2`. The `deployment` configuration (section 2) is parsed and validated (field and cross-field rules, unreadable secret files refuse start, reasons name the field), the encryption mode and the organisation are recorded at first start (migration `0007_deployment.sql`), and a later start with the other mode refuses; `GET /v1/deployment` is public; `Config::deployment` and `Store::org` are there for slices 9–11. Sign-in uses the configured providers (several per deployment; `POST /v1/sso/start {provider, return, challenge}`), keeps every earlier ID-token check, refresh, back-channel logout and blocking, accepts several `email_domains`, refuses guests with `guests: "off"`, and applies `admin_groups` and `member_groups` at sign-in, on every use of a login and at each recheck (from a refreshed ID token). Removed with their tests: setup codes and `org create`, `org sso` and `org_sso`, invitations (`invite.create`, `invite.revoke`, `person.join`, `#join=`), link-code device links, device-key-only sessions, organisation-managed mode and admin read access; there was no passkey code. In end-to-end mode a genesis is accepted once, from a configured administrator's login, which it links to the owner; `POST /v1/auth/session` requires the login of the key's person and the device signs its hash (`scribyra-auth/2`), for recovery keys too; `GET /v1/orgs/{org}/people` gives members the email each person signed in with. The browser starts from the deployment address and "Sign in with …"; the first administrator creates the organisation, others ask to join and are approved, a member's new browser is added by one of their devices (typed code) or by the recovery kit with a sign-in. Evidence: Rust `cargo test -p scribyra-sync -p scribyra-core` (new `deployment`, `org_sso` and SSO tests for refused device signatures, non-admin genesis, guests, group rules and configuration rules), `npm test`, and the five organisation browser specs in Chromium, Firefox and WebKit, against the repository's test provider. Not built here: server-readable projects (slice 9; with `encryption: "server"` the end-to-end routes answer `404`), guest restrictions inside end-to-end organisations (a guest admitted with `guests: "shared"` can ask to join like anyone), and an administrator merging or unblocking accounts (slice 14).

Slices 9–11 are built to fit slice 20 already: the server-readable API keeps no state in memory, takes its configuration from mounted files and environment, answers `/health` (liveness) and `/ready` (database and blob store reachable, migrations applied), drains in-flight requests and long polls on SIGTERM within the pod's grace period, and the compile worker is a separate command that takes jobs from PostgreSQL.

The former slices "passkeys and teams" and "switching encryption modes" are removed; teams may return later as groups from the provider.

## 12. Decisions

### Paul, 18 November 2026 (this rewrite)

1. Organisation deployments store files on the server; browsers keep a synced local copy; offline editing is on by default and a deployment setting turns it off.
2. Login is OIDC only, with several providers per deployment; passkeys and invite-link sign-in are dropped.
3. Members share by invitation as editor, reviewer or viewer; guests only through the provider's guest accounts; link sharing off by default.
4. Administrators see and control everything, with an append-only, exportable audit log with configurable retention.
5. Encryption is a deployment setting: server-readable by default (chosen here: sealed at rest with per-project keys under a master key file, section 7), end-to-end optional, with re-keying only there.
6. Server compile with native TeX Live in a throwaway sandbox (chosen here: bubblewrap, section 6), PDF synced to members, deployment and project compile modes, a shared package cache.
7. Personal use without an organisation stays as today.
8. Deployments are cloud native: a Kubernetes operator (Rust, kube-rs) is the default and probably only deployment method, with single-node k3s as the small install; the NixOS module and Compose file become development-only (section 10).

### Earlier decisions and their status

- 10 November: encryption as a per-organisation setting — **replaced** by decision 5. Recovery by re-share, recovery code and optional org recovery key — **kept for end-to-end mode**. Sign-in order (invite links, passkeys, OIDC) — **replaced** by decision 2. PostgreSQL and the blob storage trait — **kept**. Admin read access as a setting — **removed**.
- 17 November: SSO first-class — **kept** (now the only sign-in); invitations with roles — **kept** as sharing; device sync — **kept**; online compile discussion — **decided** by decision 6 (native TeX Live, not BusyTeX under wasmtime).
- Architect, 9 November: role scope at receivers — **kept** for end-to-end mode; server-readable mode checks roles on the server (slice 12).

### Open questions for Paul

1. Should one deployment serve several organisations (hosting tenants) in one process, or one deployment per customer? This design assumes one organisation per deployment.
2. Administrators opening a project: should members be notified actively (email or in-app banner) or is the activity entry enough?
3. Should email invitations send email (needs SMTP configuration), or is "ask them to sign in" enough for now?
4. Default TeX Live scheme for the NixOS module: `texliveSmall` (0.6 GB) or `texliveMedium`/full (several GB) for fewer "package not found" failures?
5. Paid hosting: gVisor `RuntimeClass` for compile workers (recommended), or dedicated compile nodes per customer with bubblewrap only?
6. Kubernetes floor: is Kubernetes 1.33 (user namespaces for the compile worker) an acceptable minimum, also for customers' own clusters?
7. Should the operator provision PostgreSQL (CloudNativePG) and object storage (Garage) by default for single-node k3s, or always require external ones in production?

## Appendix A: end-to-end mode protocol

Built in slices 1–7 and kept for `encryption: "e2ee"`, with the parts this rewrite removes taken out (setup codes, invitation links, link codes, device-key-only sessions, organisation-managed mode, admin read access, passkeys). People, roles, the signed membership log, devices and their linking are as in the 17 November design, except that every session and every join goes through OIDC (A.2). The membership log's event types are `genesis`, `person.request`, `person.approve`, `person.role`, `person.remove`, `device.add`, `device.remove`, `recovery.set`, `project.create`, `project.grant`, `project.revoke`, `project.epoch` (teams and directory epochs later); `invite.create`, `invite.revoke` and `person.join` are removed. The rules live in `crates/core/src/membership.rs`, shared by the service and the browser's WASM.

### A.1 Sync protocol

#### What moves, and how

| Data | Carried as | Notes |
| --- | --- | --- |
| Source text, file tree, settings, trash | Yjs updates in log entries | Same `Y.Doc` and schema as today. |
| Comments, replies, anchors, suggestions, reviews, discussion events, change records, version names | Yjs updates in log entries | They are roots in the same document. D's per-record proofs (`directProof:*`) travel inside it and survive export. |
| Decision requests to a review's authority | `request` log entries | Durable, so an absent authority sees them later. They never change source by themselves. |
| Assets | Encrypted blobs, plus a `blobref` log entry | Uploaded before the update that references them. |
| History checkpoint objects | Encrypted blobs, same as assets | Named versions stay restorable on a fresh device. |
| Cursors, selections, presence | Encrypted frames through the existing relay | Never stored. |
| Device preferences, drafts, provider credentials, private keys, local journals | Not sent | As in D and the backup format. |

#### Routes

All routes stay under protocol major 1. `GET /v1` adds `"capabilities": ["objects", "relay", "orgs", "logs"]`; a client that needs `logs` and does not see it says the service is too old. Control bodies keep closed JSON schemas.

| Route | Purpose |
| --- | --- |
| `POST /v1/auth/challenge`, `POST /v1/auth/session` | Device session: a device signature bound to a live OIDC session (A.2); never a login by itself. |
| `GET /v1/orgs/{org}/sso`, `POST /v1/sso/start`, `GET /v1/sso/callback`, `POST /v1/sso/redeem`, `GET /v1/sso/me`, `POST /v1/sso/logout`, `POST /v1/sso/backchannel` | OIDC single sign-on (option C). |
| `GET /v1/orgs/{org}/info` | Unauthenticated: whether the org has a genesis. |
| `POST /v1/orgs/{org}/device-links/sso`, `GET /v1/orgs/{org}/device-links` | A signed-in person's new device asks to be added; their other devices list and approve requests. |
| `GET /v1/orgs/{org}/heads?wait=25` | Long-poll notice that a project or the membership log moved. |
| `GET /v1/orgs/{org}/events?after=n`, `POST /v1/orgs/{org}/events` | Read and append membership events. |
| `GET /v1/orgs/{org}/keys?device=…`, `PUT /v1/orgs/{org}/keys` | Key wraps addressed to a device; publish wraps (A.2). |
| `GET /v1/orgs/{org}/pending` | Grants and devices still lacking wraps that this device could fulfil. |
| `POST /v1/projects/{project}/log` | Append one entry. |
| `GET /v1/projects/{project}/log?after=n&limit=k` | Catch up. |
| `PUT/GET/HEAD /v1/objects/{namespace}/{hash}` | Existing immutable objects; the namespace is the project ID, authorised by membership. |
| `GET /v1/live` (WebSocket) | One per device: subscribe to projects, receive new entries and membership events. |
| `GET /v1/connect` (WebSocket) | Existing relay, now also accepting org sessions, for awareness. |
| `DELETE /v1/projects/{project}` | Requires a signed `project.delete` already in the membership log. |

#### The log entry

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
- `refs` is set only on snapshots: the list of ciphertext object hashes still in use (Appendix B).
- `sig` is the device's Ed25519 signature, domain `scribyra-log/1`, over the header without `sig` and the SHA-256 of the ciphertext. The server verifies it and that the device may write to this project; clients verify it again.

The ciphertext is `nonce (24 bytes) ‖ XChaCha20-Poly1305(K_update[epoch], nonce, plaintext, AD)`. The associated data is the header without `sig`. This is the suite `core::exchange` reserved, and the header carries the same fields as its `Envelope` and `Ciphertext` payload: `project`, `device`, `clientSeq` (the envelope's `sequence`, widened from u32 to u64), `epoch` (`keyEpoch`) and the nonce. The plaintext:

```json
{"domain": "scribyra-entry", "version": 1, "lineage": "uuid", "schema": 8,
 "person": "uuid", "payload": "<binary Yjs update, or blobref/request body>"}
```

Encoded as deterministic CBOR so the binary payload needs no hex expansion; D's hex-in-JSON framing doubles sizes and is kept only for D.

#### Sequence numbers and durable acknowledgement

- The server assigns `seq`, a per-project u64 starting at 1 with no gaps, inside the same SQLite transaction that records the entry. Inline ciphertext is written to the blob directory with S's discipline (temporary file, fsync, rename, directory fsync) before the transaction commits.
- It also computes `chain[seq] = SHA-256("scribyra-log-chain/1" ‖ chain[seq-1] ‖ SHA-256(header ‖ ciphertext))`, with `chain[0]` the project ID.
- The response `201 {"seq": n, "chain": "…"}` is sent only after commit. That is the durable acknowledgement. Nothing else (a WebSocket send, a relay broadcast, a compile) counts as one.
- `clientSeq` is per device and project and must be exactly the last accepted value plus one, as the exchange contract requires. The client builds each entry, stores it in an IndexedDB **outbox** with its `clientSeq`, and only then sends it. After a crash or timeout it resends the same bytes. The server answers a repeat of the same `(device, clientSeq, entry hash)` with `200` and the original `seq`. The same `clientSeq` with different bytes is `409` and the client stops and reports a fault; it never reuses a number.
- Other errors: `401/403` (session or membership), `413` (size), `507` (quota), `429/503` (load). None leaves a partial entry. The outbox keeps the entry and the status explains why it is waiting.

#### Uploading local changes

The client keeps a **server vector**: the Yjs state vector of everything it has seen in the log plus its own acknowledged entries. After each local save (the existing merged-head save path), and at most every two seconds while typing, it encodes

```
Y.encodeStateAsUpdate(doc, target)
```

where `target` is the server vector with every *other* client ID's clock set to the local clock. That sends only structs from this device's own Yjs client IDs, plus delete sets, which are idempotent. Edits this device received through a D session are uploaded by their own authors, not duplicated. The device records its Yjs client IDs in IndexedDB so a new tab's client ID is still "its own".

Before an update that references a new asset or checkpoint object, the client uploads the encrypted blob and a `blobref` entry. Updates larger than the inline limit go as an object; a single update above the 96 MiB `MAX_RETAINED_BYTES` bound is refused locally with a message, as D does.

#### Catching up and live delivery

On connect the client fetches membership events after its cursor, then for each project `GET …/log?after=cursor`. It verifies that each entry's `chain` follows from the stored `(cursor, chain)` pair. A break means the server changed history; the client stops syncing that project and says so.

If the cursor is below the project's compaction floor the server answers `410` with the latest snapshot's `seq`. The client fetches that snapshot entry and the entries after it. It does not discard its local state: it merges the snapshot into its document like any other update, then uploads whatever the snapshot lacks.

While connected, `/v1/live` pushes new entries as they are sequenced (inline when under 48 KiB, otherwise as a "head moved to n" notice that triggers a fetch). Live delivery is an optimisation; the cursor fetch is the recovery path, exactly as D treats vectors.

#### Receiving an entry

For each entry in sequence order:

1. Verify the chain and the header signature. Check `clientSeq` is the next for that device (rejects a replayed old entry presented as new).
2. Replay membership to this `seq` (A.2 explains how epochs and removals are ordered). The device must belong to a person with a role on the project; the epoch must be current for that position.
3. Decrypt. Check `lineage`, and `schema` against the running app: newer stops the project with "This project was updated by a newer Scribyra. Update to see the latest changes." and leaves the cursor before that entry; older is accepted only if the app still reads it.
4. Run D's `receiveReplica` pipeline: clone, apply, refuse pending structs, schema and lineage, `validateRetainedState`, `validatePeerMetadata`, `validateProvenance`, `validatePeerState`, hydrate verified blobs (from the service instead of a peer), preserve concurrent binary losers as recovery projects, recheck against concurrent local edits, defer during IME composition, merge with a registered remote origin, save through the merged-head path. No peer update enters undo or starts auto-compile.
5. **Role scope check (new).** While applying to the clone, collect `transaction.changedParentTypes` and map each to its root. A reviewer's update may change only `authors` (their own record), `threads`, `messages`, `anchors`, `suggestions`, `reviews`, `discussionEvents`, `changes` (their own), and `meta` proof entries for their own records. A viewer's update may change only `authors`, `threads`, `messages`, `anchors` and their proofs. An update that changes `text:*`, `files`, `assets`, `trash`, `versions` or other `meta` keys is refused.
6. Advance the cursor and server vector in the same IndexedDB transaction as the save.

A refused entry is skipped, not retried, and recorded: "2 changes from Ben couldn't be verified and were ignored." Every honest client makes the same decision because it depends only on the entry, its position and the membership log. A later entry whose Yjs structs depend on a refused one stays pending; the client keeps pending structs within the 96 MiB bound, and if they are still pending at the head it reports the dependent entries as ignored too.

Step 5 changes the accepted contract, which says narrower roles "send validated operations through an authorised client, never arbitrary Yjs updates". With a log that every receiver validates, the role check can move to the receivers, which removes the need for an editor to be online for a reviewer to comment. It needs the architect's sign-off as an amendment to the annotations contract. If it is not accepted, reviewers and viewers instead write `request` entries that an editor client converts into updates, at the cost of latency and availability.

#### What D's replication layer gives, and where it does not fit

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

#### Compaction and snapshots

The server suggests compaction (`Compact-Suggested: true` on a log response) when a project has more than 2,000 entries or 32 MiB of entries since the last snapshot. Any **editor** client that is caught up and idle may then:

1. Build the state at a cursor `s` from its own document: since it has applied exactly the accepted entries up to `s` and nothing refused, `Y.encodeStateAsUpdate` of a document rebuilt from the previous snapshot and accepted entries up to `s` is deterministic in content. (It uses the rebuilt document, not its live one, so unsent local edits are not mixed in.)
2. Encrypt it under the current epoch, upload it as an object, and append a `snapshot` entry whose plaintext states `{covers: s, chainAt: chain[s], stateVector}` and whose header lists `refs`.
3. The server records the snapshot as a floor candidate. It prunes entries at or below `s` only after the retention window (default 30 days) **and** after a second editor's client has appended a `verify` entry naming the same snapshot hash, or immediately if the project has a single editor.

Clients that hold the covered entries verify a new snapshot by rebuilding it; a mismatch is shown ("Ana's compacted copy differs from the history; kept the history") and the verifier does not countersign. A client that joins after pruning must trust the snapshot, which means trusting the editor who wrote it. Editors can already write anything, so this adds no new power, but it does mean a malicious editor can rewrite what new members see without leaving the per-entry trail. That is a real limit and is stated in the threat model.

Snapshots keep tombstones and delete sets as Yjs encodes them; there is no silent tombstone compaction, as D requires. History restore depends on the app's own checkpoint objects, which stay as referenced blobs.

#### Offline work and conflicts

Offline edits accumulate locally exactly as today, plus outbox entries. On reconnect the client catches up first, then uploads. Text, tree and discussion state merge through Yjs and the existing Rust validators; concurrent binary replacements produce recovery projects; review decisions still go only through the authority. If membership changed while offline:

- **Still a member, epoch changed:** the client first resends its outbox unchanged, which tells it (through idempotent `200` answers) which entries the server already holds. The server refuses the rest with `409 epoch`; the client re-encrypts those under the new epoch, keeping their `clientSeq` values since none were accepted, and uploads them.
- **Role narrowed:** outbox entries outside the new role are refused by others; the app warns before uploading and offers "Keep these edits as a local copy".
- **Removed:** the server refuses. The project stays on the device and becomes a local project with a fresh lineage on the person's request; nothing is deleted without asking.

#### Awareness

Awareness (cursors, selections, presence, agent labels) uses the existing relay. The room ID is `HKDF(K_aware[epoch], "room" ‖ floor(minute / 10))`; frames are sealed with AES-GCM under a key derived the same way, binding room, sender device and a monotonic counter, as `web/service-client.js` already does for signalling. The relay accepts org sessions in the first message in place of a bearer. Awareness is never stored and never counts as delivery. If the relay is unavailable, editing and sync continue without cursors.

#### Limits

| Limit | Default | Where |
| --- | --- | --- |
| Inline entry | 1 MiB | Server config `entry_inline_bytes` |
| Entry or object | 8 MiB, configurable to 64 MiB | Existing `object_bytes` |
| Retained project state | 96 MiB | Client (`MAX_RETAINED_BYTES`) |
| Membership event | 16 KiB | Server and client |
| Catch-up page | 256 entries or 16 MiB | Server |
| Appends per device | 10 per second | Server, on top of existing rate windows |
| Outbox | 256 entries or 128 MiB per project | Client; beyond it the app says backup is falling behind |

### A.2 Encryption and trust

#### Key hierarchy

```
Device (per browser profile)
  ├─ Ed25519 signing key         non-extractable; signs events, entries, wraps
  ├─ X25519 agreement key        non-extractable (sealed by the storage key where IndexedDB cannot keep it); receives wrapped keys
  └─ local storage key           non-extractable AES-GCM; encrypts cached keys in IndexedDB

Person
  └─ recovery key (X25519)       from a recovery code; registered by recovery.set

Org
  ├─ directory key, per epoch    encrypts display names, team names, listed project names
  ├─ team keys, per epoch        wrapped to member devices
  └─ org recovery key (X25519)   optional; private half held offline by owners

Project key PK[e], per epoch (32 random bytes)
  ├─ K_update = HKDF(PK, "scribyra/1/update")    log entries and snapshots
  ├─ K_blob   = HKDF(PK, "scribyra/1/blob")      assets and checkpoint objects
  ├─ K_objid  = HKDF(PK, "scribyra/1/object-id") stable object identities
  ├─ K_aware  = HKDF(PK, "scribyra/1/awareness") relay rooms and frames
  └─ K_name   = HKDF(PK, "scribyra/1/name")      the project's name in listings
```

XChaCha20-Poly1305 runs in the Rust WASM core (RustCrypto `chacha20poly1305`), so `K_update` and `K_blob` exist as bytes in WASM memory while a project is open. At rest they are stored in IndexedDB only encrypted by the device's non-extractable local storage key. X25519 and Ed25519 stay in WebCrypto and never leave it. AEAD is not key-committing, so each epoch event carries `keyCommit = HMAC-SHA-256(PK[e], "scribyra/1/key-commit")`, and a wrapped key that does not match is refused.

#### Wrapping

A key wrap delivers `PK[e]` (or a team or directory key) to one device:

```json
{"v": 1, "org": "…", "target": {"project": "…", "epoch": 3}, "recipient": "device key",
 "enc": "X25519 ephemeral public key", "ct": "wrapped key + tag", "sender": "device key", "sig": "…"}
```

`ct` uses an ECIES-style construction: the sender makes a fresh X25519 key pair, computes the shared secret with the recipient's public key, derives `HKDF-SHA-256(ikm = shared, salt = enc ‖ recipient, info = "scribyra-wrap/1" ‖ canonical context)`, and seals the key with XChaCha20-Poly1305 under a random nonce, with the canonical context (org, target, recipient, sender) as associated data. This is deliberately simpler than RFC 9180 HPKE, which would need the DH step inside the same library as its key schedule; ours needs only the DH output, so the recipient's X25519 step can use WebCrypto `deriveBits` and the private key never leaves WebCrypto. The recipient checks the sender was a member of the target at that epoch, the signature, and `keyCommit`. A project shared with a team gets one wrap to the team key; each team member's devices hold wraps of the team key.

Wraps are fulfilled automatically: `GET /v1/orgs/{org}/pending` lists grants and new devices that lack wraps the caller could produce. A client that holds the key checks the grant in the membership log (including the admin-approval rule from section 1) and publishes wraps. A new member therefore gets keys as soon as any project member's app is open.

#### Epochs, rotation and ordering

A project's epoch changes when someone loses access (person removed, grant revoked, device removed, team member removed from a team holding the project) and on request. The removing admin's client creates the new epoch if it holds the key; otherwise the first remaining member client to come online does, before it writes anything. It generates `PK[e+1]`, wraps it to every remaining entitled device or team, and appends `project.epoch {project, epoch, keyCommit, after: seq, cuts}`, where `after` is the last log `seq` the client had verified and `cuts` names every device that lost access with the last client sequence of it that client accepted (implemented 18 November 2026; see below). Concurrent rotations are resolved by membership-log order; the loser discards its key.

Ordering rules:

- The server records the project head at the moment it appends `project.epoch` as the cutover, and from then on accepts only epoch `e+1` entries. Clients cannot verify a cutover the server chose, so they also apply a rule that does not depend on it: an entry from a device that lost access is refused if its client sequence is above the one the rotating client signed for it in `cuts` and it is under an older epoch. Until that rotation exists, readers hold (neither accept nor refuse) entries from such devices, so the rotating client cuts at what it accepted before the removal. A server colluding with a removed member therefore cannot insert that member's later writes into the accepted history. A rotation that cuts off a change a reader had already accepted (a service showed it before the removal reached that reader, or a rotating editor cut back too far) stops that reader's sync with a message rather than letting readers diverge.
- An epoch `e` entry above the cutover from a device that is still a member is accepted (it can only come from a misbehaving server, and it reveals nothing new), but the app logs it as a server fault.
- No client encrypts new content under an epoch it knows to be superseded.

Rotation protects content written **after** it. Content the removed person could read before stays readable by them: they may have the decrypted project on their device and the old epoch keys. An optional **Re-encrypt stored history** action (an editor client downloads, decrypts, re-encrypts every retained object and snapshot under the new epoch, then the server deletes the old ones) reduces exposure if old keys leak later through the server's disks; it does not undo the removed person's own copy.

#### Recovery when a person loses every device

A person whose browser storage is gone has lost their local projects too, so the encrypted service copy is the only copy and it is useless without keys. Options:

| Option | How | Gains | Costs |
| --- | --- | --- | --- |
| **Re-share by another member** | An admin re-enrols the person on a new device (approval with comparison code); any project member's client then fulfils pending wraps. | Works for every project with at least one other member, with no extra secret. | Needs another member's app to be opened. Useless for projects only this person was in. |
| **Personal recovery code** | At first connection the app shows a recovery kit: the service address, the org, and a 256-bit code written as 11 groups of 5 Crockford base32 characters with a 16-bit checksum. HKDF derives from it an X25519 key (to unwrap) and an Ed25519 key (to sign a `device.add` for the same person), both registered with `recovery.set`; every project key the person receives is also wrapped to it. Typing the kit on a new device enrols that device and unwraps everything. | Self-sufficient, also covers solo projects and single-person orgs. | People lose codes. A stolen code gives the thief that person's access. In orgs with more than one person, an owner can require admin approval for recovery enrolment (`org.policy {recoveryApproval}`); a personal org cannot, since nobody else exists to approve. |
| **Org recovery key (escrow)** | Owners create an org recovery key; its private half is printed or stored offline (optionally split 2-of-3 among owners in a later slice). Projects created while it is set wrap each epoch to it. Every member sees "Acme can recover this project" on those projects. | Org survives a departed or unreachable person, as institutions require. | Owners holding it can read covered projects. It is a deliberate, visible exception to "admins cannot read". |

**Decided (Paul, 10 November 2026):** re-share is always on; the personal recovery code is offered at first connection and strongly encouraged; org escrow is off by default and an explicit org policy, visible on every project it covers, never retroactive without telling members.

#### What the operator can see

| Visible | Hidden |
| --- | --- |
| Org IDs, person IDs, device public keys, roles, team membership, project IDs and grants | Display names, team names, project names (directory key / project key) |
| Membership log event types and times | Text, file names and tree, comments, reviews, history, settings |
| Log entry sizes, times, kinds, which device wrote them, sequence numbers | Which file or record an entry touches |
| Blob sizes, counts, ciphertext hashes, which snapshot references them | Asset contents and plaintext hashes (object IDs are keyed with `K_objid`) |
| Awareness room membership and traffic volume | Cursors and selections |
| IP addresses, origins, session times, OIDC claims | Private keys, recovery codes |

The operator can deny, delay, drop, replay or fork traffic. Clients detect altered or reordered entries and replayed entries; they cannot force availability.

#### What an org admin can and cannot do

Can: invite, approve, remove people and devices; create teams; grant; archive or delete projects (deletion is real, Appendix B); see sizes, members and activity times; set quotas within the operator's limits; export the org's ciphertext and membership log. Cannot: edit without an editor grant; read a project's content unless granted by an editor or holding the org recovery key; impersonate a member's authorship (records are signed by member devices); alter history unnoticed.


### A.3 Known limits of the delivered slices

(As recorded on 18 November 2026 before this rewrite.) Objects are identified by keyed IDs with four write-once variants, so an editor who fills all four can stall others' sync of a file; unreferenced objects stay until garbage collection; a removed person's devices are cut off at the `after` of the next rotation, which binds only once a reader has the `project.epoch` event; "Re-encrypt stored history" is not built; wraps grow with projects × epochs × keys; demoted editors are not cut off for writes until receivers check role scopes; reviewers' and viewers' writes stay local until the receiver check (slice 12).

### A.4 Threat model (end-to-end mode)

| Adversary | Can | Cannot | Notes |
| --- | --- | --- | --- |
| **Malicious or compromised server operator** | See the metadata in section 3; deny, delay or drop service; withhold the newest entries; show different members different valid tails (fork); refuse to delete; keep deleted ciphertext; collude with a removed member's old keys. | Read content; forge or alter entries or membership events; reorder an entry before a removal; give anyone keys. | Forks are detected only when members compare heads another way (a D session exchanges chain heads; the app shows a warning on mismatch). Withholding the newest entries is undetectable without such a comparison. |
| **Malicious member (editor)** | Read and copy everything; write any content; redact others' messages (D decision); write a misleading snapshot that new joiners trust; share keys outside the app. | Forge another member's signed records; change roles without admin rights; read projects they are not in. | Removal and rotation stop future access only. |
| **Malicious reviewer or viewer** | Read and copy; add comments and suggestions; flood within quota. | Change source, files or assets (refused by every honest receiver); accept suggestions without authority. | Depends on the role scope check (A.1). |
| **Removed member** | Keep everything already downloaded; keep old epoch keys. | Read entries after rotation; write entries that are accepted after their removal. | Re-encrypting stored history limits exposure from later server leaks only. |
| **Stolen device, unlocked browser** | Everything that person could do until the device is removed. | Survive removal: rotation follows. | Browser profile protection is the platform's job. Keys in IndexedDB are non-extractable or encrypted with a non-extractable key, which stops copying files off disk but not use inside the running profile. |
| **Stolen device, locked or disk image** | Read whatever the browser stores unencrypted: IndexedDB project content is plaintext today. | Use non-extractable keys outside that browser profile. | Local at-rest encryption of projects is out of scope; full-disk encryption is the recommendation. |
| **Network attacker** | Observe TLS metadata. | Read or alter traffic beyond TLS; replay entries (chain and `clientSeq`). | TLS is required for non-loopback endpoints, as today. |
| **Compromised or malicious identity provider** | Sign anyone in as any subject; keep a disabled person signed in; in orgs that require SSO, lock everyone out. | Give anyone keys in an end-to-end encrypted org: SSO only admits people to the service and to pending join requests that an admin approves; joining needs an administrator's signature. | The IdP is trusted for *who may reach the service*, not for content. |
| **Operator colluding with the IdP** | Everything above, plus link an SSO identity to any person and admit them to the service. | Read content in an end-to-end encrypted org, or approve a join request (needs an admin's signature). | SSO links live only on the service; admins see them in the members list. |

Out of scope: hiding who collaborates with whom from the operator; traffic analysis; a malicious app build served by the static host (the app is the trusted computing base; reproducible builds and pinned releases are milestone 12 work); compromised browsers or extensions; preventing a reader from copying; remote wipe; post-quantum security; independent review, which remains Paul's decision before public security claims.

## Appendix B: operator backup and restore

Objects are immutable and the database only refers to an object after it is durable, so a consistent online backup is: take a `pg_dump` (or a base backup with WAL archiving) first, then copy the blob directory or bucket. Every object the dump refers to is already in the blob store; objects written after the dump are harmless extras. The service documentation gives the exact commands for both backends.

Restoring an older backup rolls the logs back. Clients notice: their cursor is past the head, or the chain at their cursor differs. If the server's log is a prefix of what the client verified, the client resets its cursor to the server head and re-uploads its own entries from its local state (new `clientSeq` values after the server's last known one for that device). "Backed up remotely" drops back to "Backing up…" until that finishes. Local-first storage turns a server rollback into a short re-upload rather than data loss, for every change still on some member's device.

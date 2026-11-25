# Full Git in the browser (design)

Status: **design only**, November 22, 2026. Nothing here is built. The shipped
[GitHub and GitLab plugin](git-sync.md) syncs a project through the hosts' REST APIs and
needs no Git protocol, no proxy and no local repository. This document designs the next
step: a plugin that clones, fetches and pushes **any** Git remote over HTTPS, keeps real
history in the browser, and works with hosts that have no REST API or no CORS.

## Goals and non-goals

Goals:

- Clone, fetch, pull (merge), commit, push and branch against any smart-HTTP Git remote
  (GitHub, GitLab, Gitea/Forgejo, Bitbucket, a bare `git http-backend`).
- Real history in the browser: log, blame of a line, diff between commits, a branch per
  draft. Commits that standard Git verifies (`git fsck`) and reads.
- The same project model and review flow as the REST plugin: a pull is reviewed file by
  file, conflicts are resolved per file, Reviewing turns changes into suggestions.
- Work offline after a clone; network only on fetch and push.
- No Scribyra server in the path unless the remote cannot be reached from a browser, and
  then a proxy the person or their organisation runs, never a shared default.

Non-goals (for the first version): SSH remotes (a browser cannot open TCP), submodules
(shown, not checked out), Git LFS uploads, signing, rebase and interactive history
editing, partial clone filters beyond `blob:none`, hooks.

## Architecture

```
 Scribyra page ──capability API──▶ plugin sandbox (opaque-origin iframe → Worker)
   │  project.apply / project.read            │ isomorphic-git (JS) or gitoxide (WASM)
   │  git.storage (new, per project)          │ object store + index in plugin storage
   │                                          │ HTTP client = net.fetch (host proxy)
   ▼                                          ▼
 host fetch proxy ──▶ https://git-host…  (CORS: direct)   or   https://proxy.example.org/… ──▶ git host
```

### Engine

Two candidates, both run in the plugin's Worker:

| | isomorphic-git | gitoxide (`gix`) compiled to WASM |
| --- | --- | --- |
| Maturity in browsers | Used in production in browsers for years; documents a Web Worker setup and a pluggable `fs` and `http` | Not packaged for wasm32; needs our own `fs`/transport shims and a build |
| Protocol | Smart HTTP v1 and v2 (fetch), v1 push; shallow and `--depth`; no partial clone | Full protocol v2, partial clone, efficient pack handling |
| Merge | Line merge with conflict markers, no rename detection | Rename-aware tree merge (newer, still moving) |
| Size | ~300 KB minified + pako | Several MB of WASM, compiled once per install |
| Fit with the sandbox | Plain JS; we pass `http` = a wrapper over `net.fetch`, `fs` = a wrapper over plugin storage | WASM is allowed (`wasm-unsafe-eval`); imports only what the shim passes in, as the Rust template does |

**Choice: isomorphic-git first**, behind a small engine interface (`clone`, `fetch`,
`log`, `readTree`, `readBlob`, `writeTree`, `commit`, `push`, `merge3`) so a gitoxide build
can replace it if pack sizes or merge quality demand it. The diff and three-way merge the
person reviews stay Scribyra's (`web/line-diff.js`), so both engines show the same review.

Bundle size: the package limit is 4 MiB today; isomorphic-git fits. A WASM engine would
need the limit raised for this plugin's registry entry, or a second, lazily installed
package with its own hash in the signed registry.

### Storage

The plugin keeps the repository (objects, refs, index, config without credentials) in a
new **`git.storage` capability**: a per-plugin, per-project byte store in IndexedDB
(`scribyra-plugin-git`), separate from `projectData` (4 MiB) because a repository is
larger. Proposed bounds: 256 MiB per project and 1 GiB per plugin, shown in the manager
with **Free space** (drop history, keep the project). The store is device-local:

- never in project history, backups, exports or direct sessions;
- deleted with the project, and with the plugin on uninstall;
- writes keyed by the host's instance record, as all plugin data.

The working tree is the project itself. A checkout or merge result reaches the project
only through `project.apply` after the person confirms it, exactly as a REST pull does;
the plugin never writes project files directly. Local edits are compared with the index
by blob id (the plugin hashes `project.read` content), so `status` works without a
second copy of the files.

The object store packs loose objects after each fetch (isomorphic-git `packObjects`) and
keeps one pack plus an index per fetch, so 500 MB of history is not 500,000 IndexedDB
records. Opening a project mounts the store lazily; a status check reads only the index
and the current tree.

### Transport and CORS

Git smart HTTP is `GET /info/refs?service=git-upload-pack`, `POST /git-upload-pack` and
`POST /git-receive-pack`. From a browser at `https://app.scribyra.com`:

- **github.com** and **gitlab.com** do not send CORS headers on these endpoints (as of
  this writing, the long-standing behaviour isomorphic-git documents), so a browser cannot
  read the replies. Their REST APIs do allow CORS, which is why the shipped plugin uses
  them.
- **Self-hosted** Gitea/Forgejo, GitLab and `git http-backend` can be configured to send
  CORS (`Access-Control-Allow-Origin: https://app.scribyra.com`, allow `Authorization`,
  `Content-Type`, `Git-Protocol`; expose nothing special). The plugin then talks to them
  directly, through the host's fetch proxy, after a `network.ask` consent for the origin.
- Otherwise the plugin needs a **CORS proxy**.

The plugin's HTTP client is `net.fetch`. It already enforces exact origins, no redirects
and `credentials: 'omit'`. Git needs two additions to it, both generic:

1. **Streaming bodies.** Packfiles exceed the 8 MiB request and 16 MiB response limits. A
   `net.stream` method hands the plugin a response in chunks (back-pressured over the
   port) and accepts a request body in chunks, with a per-plugin budget (for example
   512 MiB per operation) the person sees in the operation's progress.
2. **Redirect policy per origin.** Some Git hosts redirect `/info/refs` (for example from
   `http` to `https` or to add `.git`). The proxy keeps `redirect: 'error'`; the plugin
   retries the final URL itself if it is on an allowed origin.

### The CORS proxy

A small stateless HTTP service, **part of the operator later** (the organisation
deployment, [org-sync design](org-sync-design.md)), and runnable alone:

```
POST https://proxy.example.org/v1/git/<host>/<path>/git-upload-pack
GET  https://proxy.example.org/v1/git/<host>/<path>/info/refs?service=git-upload-pack
```

Rules, all enforced in the proxy:

- **Allow-list of upstream hosts** (configuration, not request input): for example
  `github.com`, `gitlab.com`, `git.example.org`. Anything else is 403. No IP literals, no
  private or link-local ranges after DNS resolution (checked at connect time, so DNS
  rebinding cannot reach the operator's network).
- **Only the three Git endpoints** above, only `GET`/`POST`, only Git content types
  (`application/x-git-upload-pack-request`, `…-result`, `…-advertisement`, and the
  `receive-pack` pair). No other path is forwarded, so it is not a general open proxy.
- **CORS** answered by the proxy for the configured app origins only
  (`https://app.scribyra.com`, the organisation's own app address), never `*`.
- **Credentials pass through, never stored or logged.** The `Authorization` header is
  forwarded to the upstream and dropped from logs; cookies are neither accepted nor sent.
  Request and response bodies are streamed, not buffered to disk.
- **Limits:** request and response size caps (for example 2 GiB), time limits, per-IP and
  per-token rate limits, and a concurrency cap.
- **No redirects followed** across hosts; a redirect to another allowed host is returned
  to the client as an error with the target, so the client decides.
- **Observability without content:** counts, sizes, durations and upstream host only.
  The operator's telemetry rules apply ([telemetry](telemetry.md)); no repository names
  unless the organisation enables audit logging.
- **Deployment:** a single static binary (Rust, `hyper` + `rustls`) or a container in the
  operator's chart, configured by `SCRIBYRA_GIT_PROXY_UPSTREAMS` and
  `SCRIBYRA_GIT_PROXY_ORIGINS`. Self-hosters can also use any proxy implementing the same
  rules; isomorphic-git's `cors-proxy` is a reference for the shape but allows any host by
  default, which this design does not.

In the app, a proxy is an ordinary origin: the person (or the organisation policy) adds
`https://proxy.example.org` with `network.ask`, and the plugin's remote configuration
says "through proxy X". The proxy is never on by default and Scribyra publishes none, so
using the plugin with github.com's Git endpoints requires a proxy the person trusts. The
dialog says plainly that the proxy operator can see repository content and tokens in
transit.

### Authentication

HTTPS only:

- **Personal access tokens or project tokens**, sent as HTTP Basic (`x-access-token:<token>`
  for GitHub, `oauth2:<token>` for GitLab, `<user>:<token>` elsewhere). The token is a
  **bound secret** (`secrets.set {origin}`), and the host adds the `Authorization` header
  for requests to that origin only (`net.fetch {auth}`), as the REST plugin does. When the
  remote goes through a proxy, the secret is bound to the proxy's origin and the remote
  host is part of the path; the dialog shows both.
- The plugin never stores credentials in the repository config (`remote.origin.url` is
  written without user info, and isomorphic-git's `onAuth` reads from the host).
- OAuth device flow (GitHub, GitLab) is a later option: it avoids pasting tokens but needs
  a registered OAuth app per deployment, which belongs to the operator.
- Scopes: the narrowest that allow push: GitHub fine-grained "Contents: Read and write";
  GitLab `write_repository` (here, unlike the REST API, Git over HTTP is exactly what that
  scope is for) or `read_repository` to fetch only.

### Large repositories

- **Shallow clone by default** (`depth: 50` or since a date), with **Fetch more history**
  on demand; `singleBranch: true`.
- **Folder-limited projects:** the project still holds at most 64 MiB and 512 files, so a
  large repository is linked by subfolder as in the REST plugin. Git still needs the whole
  tree objects of each commit, but not the blobs outside the folder: with a partial clone
  (`filter=blob:none`, supported by GitHub and GitLab, not by isomorphic-git today) only
  the folder's blobs are fetched. Without partial clone support, the plugin refuses
  repositories whose pack for the requested depth exceeds the storage budget and says why.
- **Progress and cancellation** for every network operation; a cancelled fetch leaves the
  previous refs untouched (objects are written first, refs last).
- **Interrupted operations** recover: refs update only after their objects are stored;
  a push is retried from the computed pack; a merge result is applied to the project only
  in one `project.apply`.

### Git LFS

LFS pointers are already recognised and skipped by the REST plugin and by Open in
Scribyra links. With full Git:

- **Download** uses the LFS batch API (`POST <remote>.git/info/lfs/objects/batch`) and the
  returned `href`s, which point to other hosts (object storage). Each such host needs its
  own `network.ask` consent, or the proxy must allow them. Objects are verified by their
  SHA-256 `oid` before use. Large LFS objects count against the project's 64 MiB.
- **Upload** is out of scope for the first version: committing a changed LFS-tracked file
  is refused with an explanation. Pointers are never replaced by content silently, and
  content is never committed where `.gitattributes` says LFS.

### Merge model

Fetch brings the remote branch; the plugin computes the merge base with the local branch
(real history, not the REST plugin's per-file records), then the same per-file review:
added, changed, removed, three-way text merges with `web/line-diff.js`, binary choices,
and edit with conflict markers. The person's choices produce a merge commit (two parents)
or, when nothing local changed, a fast-forward. Push sends only fast-forwards; if the
remote moved, fetch and merge again. Never force-push.

Comments, reviews and history stay out of the repository, as in the REST plugin
([decision](git-sync.md#what-is-never-pushed)).

## Capability API additions

| Addition | Why | Safety |
| --- | --- | --- |
| `git.storage` (or a generic `storage.blob`): bytes per plugin and project, bounded | A repository does not fit in 4 MiB of JSON | Same keying and deletion rules as `projectData`; quota shown in the manager |
| `net.stream`: chunked request and response bodies | Packfiles exceed 8/16 MiB | Same origin, header and redirect rules as `net.fetch`; per-operation byte budget |
| Bound secrets as HTTP Basic (`auth.scheme: 'Basic'`, with a fixed user name) | Git over HTTP uses Basic | The host builds the header; the plugin still never reads the token |

Everything else (`project.read` binary, `project.apply`, `network.ask`, `ui.status`) already
exists for the REST plugin.

## Threat model

Assets: project content, repository content and history, access tokens, the person's
network position (their LAN), the integrity of commits pushed in their name.

| Threat | Mitigation |
| --- | --- |
| Plugin exfiltrates the project to an arbitrary host | Sandbox CSP; only granted origins and origins the person allowed; the consent dialog says a contacted origin can receive project content |
| Token sent to the wrong host | Bound secrets: the host adds the token only to its origin; the plugin never reads it back |
| Malicious remote returns a crafted pack or tree (path traversal, `.git/` entries, case-folding collisions, symlinks out of the tree, huge objects, zip-bomb-like deltas) | Paths validated as in the REST plugin (`plugins/github-gitlab/src/paths.js`) and again by the host in `project.apply`; symlinks and submodules not checked out; object and delta sizes bounded while inflating; storage quota |
| Malicious remote exhausts memory or storage | Streaming with byte budgets; shallow clone; quotas; cancellation |
| CORS proxy becomes an open proxy or SSRF into the operator's network | Upstream allow-list, Git endpoints only, private ranges refused at connect time, no cross-host redirects |
| Proxy operator reads tokens and content | Disclosed in the consent dialog; proxies are opt-in and self-hosted; tokens scoped to one repository and short-lived |
| A pushed commit contains secrets or unintended files | Same push review as the REST plugin: secret scan, `.scribyraignore`, per-file ticks; comments, reviews and history never committed |
| Remote rewrites history (force-push) under the person | Fetch shows a non-fast-forward; the plugin offers to merge from the new tip or reset the link, never silently drops local commits |
| Interrupted operation corrupts the local repository | Objects before refs; refs updated with compare-and-swap in one IndexedDB transaction; `fsck` on open after a crash |
| A dependency (isomorphic-git) is compromised | Pinned version, bundled into the signed package, reviewed on update; it runs inside the sandbox with the plugin's permissions only |

Not defended: a malicious proxy the person chose to trust; timing side channels; a host
that serves different content to different clients.

## Plan

1. Engine interface and isomorphic-git behind it, tested in Node against `git
   http-backend` with real repositories (`git fsck` on everything the plugin writes).
2. `git.storage` and `net.stream` in the capability API, with quotas in the manager.
3. Clone/fetch/merge/push against a CORS-enabled Gitea in the browser specs, all three
   engines; interrupted fetch and push recovery.
4. The proxy as a standalone binary with its allow-list and SSRF tests; then in the
   operator's chart.
5. LFS download.

Open decisions for Paul (`needs::decision`): whether Scribyra publishes a hosted proxy
for github.com/gitlab.com at all (this design assumes no), the storage quotas, and
whether the REST plugin and the Git plugin become one plugin with two transports.

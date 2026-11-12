# Self-hostable service

Milestone S provides an optional opaque object store and live connection relay.
Read the [decisions and threat boundary](service-design.md) first. No application
project connects automatically; the standalone experimental adapter is
`web/service-client.js`. Accounts, membership, encrypted project replication,
recovery and billing are later milestones. Every feature here is free to host.

## Install from the pinned source

Use this private checkout, its `flake.lock` and `Cargo.lock`, a local POSIX disk,
and Nix. No TeX assets or frontend build are needed for the service. Run all
commands below from the checkout. The smoke installation deliberately uses a
fresh directory in `tmp/`, so it also works without a container/VM daemon.

```sh
nix develop -c cargo build --locked --release -p scribyra-sync --bin scribyra-sync
mkdir -p tmp
install_root=$(mktemp -d "$PWD/tmp/service-install.XXXXXX")
mkdir -m 700 "$install_root/data"
cp target/release/scribyra-sync "$install_root/scribyra-sync"
```

Create `service.json` in that directory. For an empty, deny-by-default instance:

```json
{"bind":"127.0.0.1:8787","data":"data","origins":[],"principals":[]}
```

Run from the installation directory, with restrictive file creation permissions:

```sh
(cd "$install_root" && umask 077 && SCRIBYRA_SERVICE_CONFIG=service.json exec ./scribyra-sync)
```

It emits a JSON `listening` event; `GET /health` and `GET /ready` return 200.
`GET /v1` advertises protocol 1. No principal means no storage or relay access.
For an occupied port choose another or use `127.0.0.1:0` and read the bound
address. Do not reuse the legacy demo database.

For a reproducible disposable installation, exchange, upgrade and restore drill:

```sh
nix develop -c node scripts/service-smoke.mjs
```

This script follows the same install steps with the already-built release
binary, generates **synthetic disposable** access capabilities, encrypts a test
document, uploads it, exchanges opaque bytes between two clients, stops, backs
up, reinstalls, restores into a second clean directory, and verifies the bytes.
It cleans up both directories and its exact child processes. It needs no real
credentials and contacts only loopback. This is the clean-directory acceptance
route when Docker/VMs are unavailable.

## Configuration and access

`SCRIBYRA_SERVICE_CONFIG` points to strict JSON. Missing fields use defaults;
unknown fields and invalid bounds fail startup. Every field also has an override
`SCRIBYRA_SERVICE_<UPPERCASE_FIELD>`: strings (`BIND`, `DATA`) are plain text;
numbers, arrays and objects are JSON. Overrides win over the file. Paths are
relative to the process working directory; the data directory’s parent must
already exist. Configuration reload is a restart.

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
payload bytes; reserve extra disk for SQLite, WAL, directory entries, temporary
writes and backups. This version retains objects indefinitely. An operator can
export the complete stopped data directory; per-project deletion/GC is not yet
implemented. A full instance requires backup and administrative migration.

For a small installation, start with **1 GiB RAM and at least 2 GiB writable
disk** for the service/proxy, excluding backups (planning estimates, not measured
minimums). Default retained download payloads are bounded to 32 MiB regardless
of paused-client count. Six uploads contribute up to 48 MiB of accepted bodies;
allow another 48 MiB for collection copies and up to 8 MiB for duplicate-write
verification. Twenty full relay queues contribute up to 20 MiB plus active frames.
SQLite, allocator retention, task/header/TLS buffers, kernel sockets and the proxy
need additional headroom: these payload ceilings are **not a whole-process RSS
limit**. Use supervisor/container memory limits and observe the actual workload.
Default durable payloads consume at most 1 GiB; metadata, temporary writes and
free space need the rest. Raise disk and memory together when increasing limits.
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
liveness; readiness performs a database write-lock and synced filesystem probe.
Storage errors return failure, never acknowledgement. Startup fails on missing
or corrupt committed objects. An exclusive directory lock prevents two writers.
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
# Create ./service.json with data=/data, bind=0.0.0.0:8787 and explicit grants.
docker compose up -d
```

Compose refuses pulls, publishes only loopback, mounts one durable volume and a
read-only config, and drops capabilities. The image runs as UID/GID 10001 and
supports a read-only root. Back up the named volume while stopped. Identify an
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
};
```

The module uses a dynamic user, private `/var/lib/scribyra-sync`, restrictive
umask and systemd hardening. Config contains hashes, never bearer secrets, and must be readable by the service. It
opens no firewall ports and installs no client program. Configure TLS separately.

The flake includes a booted module test:

```sh
nix build .#checks.x86_64-linux.service-vm --out-link tmp/service-vm
```

It enables the actual module, boots NixOS, waits for the unit, checks health and
readiness, writes and verifies an object, restarts the unit, then checks readiness
and exact read-back. It permits QEMU software emulation without KVM; the overall
runtime deadline is ten minutes. It opens no external listener or firewall port.

## Upgrade, backup and restore

1. Stop the exact process (`kill -TERM <recorded-pid>`), container or systemd
   unit and wait for exit. Copy **the whole data directory**, including SQLite,
   WAL/SHM if present, blob directory and lock file; the copied lock has no live
   owner. Preserve permissions and keep backups private. Never copy a live DB
   without an atomic filesystem snapshot or SQLite-aware procedure.
2. Back up the config separately. Retain the old binary/image and record the
   source commit plus lock files. Copy the new binary/install the new image.
3. Start with the same config/data. Supported schema upgrades run in a single
   SQLite transaction; schema 0 (empty) becomes 1. Unknown/future schemas and
   legacy plaintext DBs fail without migration. Check `/ready` and retrieve a
   known object. For protocol 1 this preserves all object hashes and bytes.
4. Restore into an **empty** directory while stopped, copying the entire backup
   and config. Start the matching version, check readiness and retrieve/hash an
   object before switching clients. For rollback restore the pre-upgrade backup
   with the old binary; never run an old binary against a newer schema.

S includes the schema mechanism, not a fictional schema-2 migration. The drill
reinstalls the same release and restores the stopped backup to a clean directory.
Future versions must add real migration fixtures before release.

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

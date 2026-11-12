# Service design (S1)

Decision, 6 November 2026. `scribyra-sync` becomes one optional Rust/Axum
service, SQLite metadata database and filesystem blob directory. No external
service, account, license check or default browser destination is required.
The same binary and features serve self-hosting and future paid hosting.

## Boundary and compatibility

The service never constructs a Yrs document, merges updates, runs commands,
compiles source or interprets project content. Clients own validation, merging,
checkpoints and encryption. The old server moves to the explicitly named
`plaintext-demo` Cargo example, restricted to loopback even in a container.
Its Yjs/Yrs, restart, blob and telemetry tests remain and target that example.
Its warned loopback-only toolbar/action and `web/sync.js` remain for existing
concurrent-edit, cursor, asset and stale-dialog regression tests. The UI names
the explicit example command; `npm run sync` starts only the new service. Neither
the release container nor the NixOS service includes the demo.

Service protocol major 1 lives exclusively under `/v1`. Unknown major routes
fail; closed JSON control schemas reject unknown fields. Immutable object
PUT/GET uses a random namespace and SHA-256 of the **opaque bytes**, never a
filename or plaintext digest. PUT success acknowledges durable bytes plus the
metadata transaction; duplicate PUT is idempotent. A hash mismatch fails.
There is no listing, overwrite, merge, delete or catch-up protocol in S.
Those require the membership and retention rules in 10/11.

Connection relay WebSockets authenticate in their first bounded JSON message
(version, bearer, room, connection). Subsequent binary messages are opaque,
ordered per sender, ephemeral, and broadcast to other attached room members.
They have no durable acknowledgement. A disconnect/lag/expiry requires a fresh
attempt; there is no replay queue. Rooms have an absolute lifetime, not an
idle timeout extended by traffic. Up to five members share a room.

The existing `core::exchange` v1 contract stays unchanged for frozen adapters.
Its project/device/session/sequence and ciphertext descriptor belong **inside**
a future authenticated encrypted client payload, not public service routing.
The outer service envelope only routes opaque bytes. S's signaling encryption
is a separate, domain-separated ephemeral channel; it does not select or
replace milestone 11's reserved XChaCha20-Poly1305 project suite. D2 still owns
persistent Ed25519 identities, committed comparison codes and signed membership.
Version changes that break semantics require a new major route; additive
capabilities require explicit discovery and cannot silently downgrade clients.
Schema version is independent of protocol version; future schemas are refused.

## Authentication and identifiers

No anonymous write or relay access. The operator provisions SHA-256 hashes of
random 256-bit bearer capabilities, each bound to one random 256-bit namespace
and explicit storage/relay rights. A bearer is sent only in an Authorization
header or first WebSocket frame over TLS, never a URL. No plaintext bearer is
stored or logged. Revocation/config changes take effect on restart, closing
all sessions. This is a small-install authentication boundary, not accounts,
device identity, project membership or billing. Later account authentication
must resolve to the same internal principal/rights/quota boundary; request
fields never grant themselves rights.

Room and connection IDs are fresh random 256-bit hex values. They are not
project, device, email or human names. Namespace IDs are random but persistent
and therefore linkable. A room is scoped to the authenticated namespace.
Clients share a separate random 256-bit invitation key outside the relay and
verify that trusted invitation before use. Browser AES-GCM seals signaling
with random 96-bit IVs, binding protocol/domain, room, sender and monotonic
sequence as associated data. Receivers reject tampering, reflection and replay.
An operator without that key cannot read or replace SDP/fingerprints undetected.
An attacker controlling the invitation channel can impersonate a peer; users
must authenticate the invite out of band. Short passwords/codes are unsupported.
Malicious admitted members and persistent identity are D/11 work.

The small client module is experimental and separate from the app. Its real
browser test uses normal immediate `setLocalDescription`, offer/answer plus
trickled ICE in both directions, with no deferred answer or human timer, and
no ICE servers. It sends random test data only on the direct data channel.
It cannot promise reachability on restricted networks.

## Durability and operations

SQLite uses WAL and FULL synchronous commits. Blob writes use a temporary file,
file fsync, atomic rename and directory fsync **before** metadata commit/receipt.
Startup removes unreferenced crash remnants and checks referenced objects;
missing/corrupt acknowledged objects prevent readiness. A single process owns
the database (exclusive filesystem lock). Disk work is off the async reactor.
The supported storage is a local POSIX filesystem with working fsync/rename;
network filesystems and multiple replicas are unsupported.

Configuration is strict JSON plus explicit environment overrides. Defaults bind
loopback and admit no browser origins or principals. Health is process liveness;
readiness probes database and writable blob storage. SIGTERM/SIGINT stops new
work, closes relays and drains bounded requests. Schema upgrades are transactional
and automatic only for supported versions; operators take a stopped backup of
both database and blobs before upgrade. Downgrade uses that backup.

Bounds cover body/frame size, request rate, concurrent HTTP work and WebSockets,
room count, five members per room, room lifetime, send deadline, per-connection
message rate, per-namespace object bytes/count and global bytes/count. Limits
apply before persistence and are serialized with writes. Reverse proxies must
also bound TCP connections, headers, slow clients and TLS handshakes. Global
rate limits bound unauthenticated requests without an attacker-sized IP map.

Logs contain fixed event names, status classes and counts, never paths, room or
namespace IDs, bearer hashes, payloads, SDP, IPs or error strings from requests.
Existing native diagnostics remain default-off; enabling/exporting them uses
only the existing configuration and safe operation taxonomy.

## Visible metadata and limits

The operator can observe client IPs, origins, timing, sizes, traffic volume,
namespace relationships, ciphertext hashes, storage usage and which connections
share a room. TLS termination sees bearer capabilities. The operator can deny,
delay, drop or replay traffic; clients detect altered/replayed signaling but
cannot force availability. Disk theft exposes ciphertext and metadata.

Opaque storage does not prove that an arbitrary uploader encrypted correctly.
The service cannot distinguish ciphertext from deliberately uploaded plaintext.
Acceptance seeds a document, encrypts it on a client, stores and restores exact
opaque bytes, and searches database/blob files for its plaintext marker. This
is a boundary test, not milestone 11 or an encryption-at-rest product claim.
Accounts, memberships, device recovery/revocation, retention/GC/deletion,
long-offline catch-up, billing and independent security review remain 10–12.

# Experimental direct browser sessions

Decision, 7 November 2026. The owner has started milestone D. This is the implementation
contract; delivery evidence below will distinguish tested behavior from open gates.
D is optional and off by default. There is no built-in service endpoint or ICE
server. People must already have the app and compiler packages they need.

## Grant and disclosure

A session grants every admitted participant full access to the shared replica:
read, edit, comment, review, export and history. Only invite trusted full editors.
A participant can retain and redistribute everything received. Comment-only and
read-only participants cannot join D: narrower roles in 10 submit validated
commands to an authorized editor, never arbitrary Yjs updates. Viewing is a local
input mode, not a remote permission; incoming edits continue while it is selected.
Existing review acceptance authority remains separate from this full-editor grant.

Before starting, Share discloses source, assets, comments, suggestions, discussions,
authors, environment metadata and trash, including deleted files' full text and
CRDT history. Names of historical versions can arrive without their checkpoint
objects and must remain unavailable until verified objects are present. Device
preferences, drafts, provider credentials, device private keys and local journals
are not shared. Offer a cleaned copy: reconstruct only live source/assets/folders
under fresh identities and lineage, with no trash, discussion or CRDT history.
The original project is unchanged. Sharing never implies a backup.

## D1: common replication contract

D, 10 and 11 use the same byte-oriented replication engine. Each authenticated
channel first negotiates protocol 1, exact project schema, lineage and full-editor
rights. Compare against the running model's exported schema constant, including
schema 8 and later when those releases ship; do not freeze a schema-7 whitelist.
Reject newer schemas plainly: “This peer needs a newer Scribyra version. Update
before joining.” Older schemas require their sender to upgrade locally first.
Never migrate another peer's live update implicitly.

Both directions send a state vector on connect and every five seconds. Always
answer with `encodeStateAsUpdate`, including delete sets even when vectors match.
Do not infer delivery from a vector or a channel send. Lost updates and dependent
pending structs recover at the next exchange. Reconnect runs the same exchange.
Local edits request both vectors after an 80 ms debounce; they do not wait for
the five-second repair timer. Incremental updates are an optimization, not the
sole recovery mechanism.

Binary framing carries one bounded message at a time per direction: total length,
message identity, contiguous offset and bytes. Chunks fit the negotiated SCTP
`maxMessageSize`, including framing, capped at 16 KiB. Bound total messages,
receive buffers, queues and channel buffered bytes; malformed or incomplete frames
fail closed, with a 20-second inactivity and 120-second total assembly deadline.
Recently advertised asset bytes are retained within a 128 MiB / 1,024-reference
bound per link so replacement during a pull does not invalidate the advertisement. Pull missing immutable blobs on demand,
one at a time per link, and verify SHA-256 and length using the existing Rust asset
validator. A hash is not proof of authorization; requests are restricted to objects
reachable from the shared project. History-object availability remains explicit.

Incoming state follows local tabs' preview/validate/hydrate/recover pipeline:
clone the authoritative document; apply to the clone; enforce schema and all Rust
semantic validators; hydrate verified referenced blobs; preserve concurrent binary
losers as recovery projects; recheck against edits during asynchronous work; defer
publication during IME composition; then merge into the authoritative Y.Doc using
a registered remote origin. Persist through the existing merged-head save path.
Same-profile tabs follow committed heads, not raw network frames. No peer update
enters local undo or triggers auto-compile. Comments, suggestions, discussions,
restore records and future semantic roots use the shared validator, not a separate
transport subset. No causal-history reseeding or silent tombstone compaction.

## D2: identity, verification and the envelope for 11

Each browser profile owns one persistent nonextractable Ed25519 private key in
IndexedDB and its public key. Identity initialization is serialized with Web Locks.
Public author records and agent labels are descriptive; signing a transport message
does not make historical authorship authentic. Losing storage loses the identity.
Pinned contacts bind a public identity key, not a display name or expiring DTLS
certificate. Changing a pinned key requires a new explicit verification.

Each session generates a fresh DTLS certificate and random nonce. Before revealing
them, each side sends a signed commitment to its public identity, nonce and DTLS
SHA-256 fingerprint. Reveal only after receiving the other commitment. Reject any
reveal that does not open that commitment. SDP and trickled candidates are signed,
binding domain, protocol, room epoch, sender identity/session, receiver session and
sequence. Check SDP fingerprints against the revealed fingerprint before applying.
All mesh links use this protocol, even when signaling is carried by another member.
The opaque service wrapper is still `web/service-client.js`; a room key alone does
not authorize a member to impersonate another identity.

The comparison code hashes the sorted committed reveals plus invitation identity.
Room and lineage are included too. Show 12 hexadecimal digits per pair. Users compare through a trusted channel before
confirming and optionally pinning a contact. A middleman substituting identities or
fingerprints produces different codes. The service observes client addresses,
timing, sizes and room membership; direct peers learn each other’s network
addresses. This does not provide anonymity. No short-password authentication or claim of
independent cryptographic review is made. Possession of an invite is sensitive;
a malicious full editor can alter or copy the document even after verification.

The common authenticated payload binds `{domain, version, lineageId, deviceId,
sessionId, sequence, kind, objectId, keyEpoch}` to immutable payload bytes. D uses
signed signaling plus verified DTLS channels and a scoped negotiated replica
stream. It does not implement encrypted project storage. Milestone 11 wraps this
same logical payload in the reserved XChaCha20-Poly1305 suite with a random 24-byte
nonce and 16-byte tag; associated data binds all context above. Outer object hashes
identify ciphertext; stable object IDs are distinct. Sign membership/epoch changes
with Ed25519; reject unknown suites/epochs and replay before publishing. Device
addition, recovery, signed membership, epoch rotation, revocation and encrypted
history/assets remain 11 work, not a second incompatible D crypto design.

## D3: live connection and capability provisioning

The operator provisions relay-only bearer capabilities in the existing service
namespace, through an authenticated private channel. Each participant enters their
own bearer in Share; it stays in memory and goes only in the first WebSocket
message. Invites never include a bearer, account token or default endpoint. The
invite fragment carries protocol, room seed, invitation key, lineage and inviter
identity; endpoints are configured by hand. The version-1 binary invite is
113 bytes: version (1), room seed (32), invitation key (32), inviter public key
(32), and lineage UUID (16). Base64url encodes it as 151 fragment characters;
the app URL and `#direct=` prefix add to the pasted link length. Users review the full-editor disclosure
before connecting. This leaves milestone 10 free to exchange account authentication
for the same service principal/rights boundary without changing invites or replicas.

Fresh rendezvous rooms and keys are derived from the random invite seed/key and
UTC minute, domain-separated. Replace the signaling socket each minute; existing
WebRTC links continue. This stays below the service's absolute 120-second room
lifetime and allows a sleeping browser to discover any remaining member again.
The relay adapter retains up to 32 sender replay counters, including departed
sockets, so rejoining inside one minute does not exhaust the four-peer active
mesh limit. The service still caps simultaneous room membership.
Wall-clock disagreement can delay discovery to the next shared interval; it is
reported as connection failure, not diagnosed as isolation. Signed fresh session
challenges prevent a replayed discovery message from authenticating a new link.

Prefer Chromium as offerer in mixed Chromium/Firefox pairs; otherwise use stable
identity order. The existing real-Wi-Fi report measured six failures in eight
Firefox-to-Chromium offers and eight successes in eight reverse offers; this
choice targets that observed asymmetry, without claiming its cause is known. Immediate SDP and trickled candidates go through the live service.
Show Connecting… while checks run, with a 20-second application timer even if
Chromium never changes state. Retry by establishing fresh connections, never by
reusing expired ICE details. Explain: “Browsers could not reach each other. Check
that both are online and this network permits direct connections.” This is not
proof of isolation, and the app does not circumvent firewall/network policy.
No manual delayed SDP flow, camera probing, STUN, TURN or implicit relay fallback.

## D4: session and authority lifecycle

Full mesh supports at most five profiles. Every member can share the same invite;
there is no indispensable original host. A Web Lock per browser profile and app origin owns one active
session; another tab reports that the session is in another tab and follows the
committed project head. Closing/leaving releases sockets, timers, channels and lock.
Resume/rejoin makes fresh signed connections and reconciles both offline replicas.
Presence contains bounded display names, human/agent kinds and author IDs. It is
not durable storage or proof of past authorship. Status says connected peers and
“Saved on this device” separately, never “backed up”.

Only the review's acceptance authority executes terminal decisions through the
existing Web Lock and committed-sequence guard. Other profiles send bounded,
authenticated-channel decision requests with suggestion IDs and observed event heads.
Share shows pending requests to the authority for explicit approval; no incoming
request itself changes source. A requester sees “Waiting for acceptance authority”.
If absent, the UI reports waiting and the requester resends after rejoin; no lease
or automatic authority takeover. Received requests stay in memory until approval,
dismissal or close; closing loses those requests, not proposals.

Disconnected-peer anchors need a qualified limit: anchors known to the deleting
peer get existing undo rebindings. An anchor created only on an offline peer can
reference deleted items the undoing peer never saw; later equal text does not prove
identity. It stays visibly detached after reunion and requires manual reattachment.
D must test this case; no claim that every offline anchor survives undo is allowed.

## Acceptance and open field evidence

Unit/randomized tests cover lost updates, deletion-only repair, semantic convergence,
blob corruption, framing limits, tampering, commitment substitution and newer schema
refusal. Real browser contexts through a local service cover two/five members,
Chromium/Firefox/mixed offerer selection, concurrent source/comments/suggestions,
rejoin, local undo, Viewing and authority routing. Linux WebKit runs non-WebRTC
cases only. Inspect Share at 1366×768 in light/dark. Regression gates are `npm test`,
production build, reviews, comments, local-tabs and editor in all three engines.

Real two-machine Wi-Fi, managed office networks, firewall behavior, actual sleep,
Safari/macOS/Windows, Chrome permission prompts and offline package differences
remain open. Local contexts establish none of these. The trial script records
browser roles and elapsed connection results without source, keys or capabilities.
Allowed wording only after a good field test: “Connects directly between browsers on your network, using a connection service you can host yourself. The connection is encrypted
by WebRTC. Check the code to confirm who you are connected to. Works only on
networks that allow devices to reach each other.” The connection service is required
for discovery; do not claim “no server”, encrypted backup or end-to-end encrypted
collaboration. The owner retains the later independent security-review decision.


## Delivery commands and evidence (7 November 2026)

All commands ran in this worktree through the flake. Browser tests use port 6001
and the local Rust service fixture; no deployed service or external network trial.
The production preview is managed and stopped by Playwright. Browser engines and
compiler assets were already provisioned; the TeX runtime was not downloaded.

```sh
nix develop -c npm run fixtures
nix develop -c npm run wasm
nix develop -c npm test
nix develop -c npm run build
nix develop -c node --test tests/replication.test.mjs tests/local-tabs.test.mjs
nix develop -c node --test --test-name-pattern='signed envelope' tests/replication.test.mjs
nix develop -c node scripts/direct-session-trial.mjs --help
nix develop -c env SCRIBYRA_TEST_PORT=6001 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/direct-sessions.spec.js tests/browser/reviews.spec.js tests/browser/comments.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js --project=chromium --project=firefox --project=webkit
nix develop -c env SCRIBYRA_TEST_PORT=6001 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/direct-sessions.spec.js --project=chromium --project=firefox --project=webkit
nix develop -c env SCRIBYRA_TEST_PORT=6001 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/direct-sessions.spec.js tests/browser/service.spec.js --project=chromium --project=firefox --project=webkit --grep 'relay replay tracking|client rejects' --output=tmp/direct/service-rejoin
```

Fixtures ran once; nine production builds passed, including the final runtime.
The full `npm test` passed 161 Rust tests (2 existing ignored)
and 1,069 JavaScript/WASM tests (6 existing optional-service skips), with no
failures. That run preceded the final browser-only refinements and the added
asset-replacement/compact-invite cases. A subsequent focused unit run passed
21/21, and the final run after immediate two-way edit notifications passed 22/22,
including 64 seeded five-replica schedules. The comparison-scope follow-up passed
1/1. Frozen companion and folders remain included in the full suite.

The helper's `--help` passed; no real-machine trial was run here. The architect can
run it separately on each machine as documented in `docs/service.md`. It records
actual engine versions, offerer roles, connection elapsed times and synthetic
marker counts. Add network, OS, sleep and permission observations manually.

Earlier attempts are not hidden: the first focused unit command failed to import
two test modules before WASM generation. After `npm run wasm` it passed. The first
Chromium smoke passed 2/2. An early Chromium/Firefox matrix passed 9, failed 2 and
skipped 1; a Firefox-five diagnostic failed 1. Pacing alone passed 6, failed 5 and
skipped 1: repeated commitment signals still overflowed the bounded relay queue,
and two newly added assertions incorrectly expected CodeMirror's read-only mode
to remove `contenteditable`. The implementation now announces presence before a
single commitment/reveal and paces signaling; the test asserts `aria-readonly` and
also tries typing. The next five-member/mixed run passed 3 with 1 intentional skip.
A separate authority diagnostic failed 1 because the test proposed before an undo
had converged; after waiting for that convergence, its Chromium rerun passed 1/1.
The cleaned-copy and blocked-path checks passed 2/2. A subsequent relay-rejoin
and existing service tamper/replay matrix passed 9/9 across all three engines. Existing tests were not weakened,
skipped or renamed. Final browser totals are recorded below.

The UI was inspected at 1366×768 in light and dark, including the connected state.
The active-session popover hides setup fields to keep the code and Leave visible.
Invites contain 113 binary bytes / 151 base64url fragment characters (URL overhead
additional). DTLS/signature and middleman tests are synthetic transcript checks,
not an independent security review or a malicious real-network proxy trial.
Large-project throughput and resource limits are unmeasured. Historical checkpoint
objects are not pulled by D; unavailable versions remain visibly unavailable.


The combined 312-case browser run completed with 304 passes, 2 failures and 6
skips. Both failures were the new two-member authority scenario (Chromium and
Firefox) proposing before the preceding undo had converged; its explicit wait
and durable feedback checks were added before the final direct-only rerun.
The required existing regressions passed unchanged: Chromium 98/98; Firefox and
WebKit 97 passes each plus their existing Chromium-CDP composition skip. That is
292 passes and 2 skips across reviews, comments, local-tabs and editor. These ran
before the last direct-only refinements; those refinements are covered by the
final direct and focused replication/service checks, not by a second full suite.


Final direct-session matrix after the last runtime build: **21 passed, 0 failed,
6 intentional skips** (Chromium 9; Firefox 7 plus 2 skips; WebKit 5 non-WebRTC
passes plus 4 skips). Skips are Linux WebKit local WebRTC, the mixed pairing run
once in Chromium, and the blocked-path negative case run once in Chromium.
The preceding direct matrix passed 20, failed 1 and skipped 6: early channel
closure replaced the blocked-network message. Teardown is now idempotent and
all early reachability failures use the same plain message. The footer now says
“Direct session” while active, rather than retaining the legacy “Local only”.
A newly added agent-label assertion initially failed 1 because it targeted the
closed popover; the corrected persistent-header assertion passed 1/1 against the
final build. No existing assertion was removed. Earlier browser attempts total
13 failures; none remains in the final gates.

```sh
nix develop -c env SCRIBYRA_TEST_PORT=6001 npx playwright test tests/browser/direct-sessions.spec.js --project=chromium --grep '2 real' --output=tmp/direct/agent-label-final
```

Final initial-link measurements (elapsed from per-link setup to data-channel
open on the offerer, excluding human verification): Chromium two-member 213 ms;
Chromium five-member 10/10 links, 576–951 ms; Firefox two-member 305 ms; Firefox
five-member 10/10 links, 686–1,767 ms; mixed five-member 10/10 links, 243–1,640 ms.
All **6/6 mixed-engine pairs chose Chromium as offerer**, 696–1,611 ms. The two-
and five-member cases also pass offline edits and rejoin, with the original host
leaving the five-member session and rejoining through a survivor's invite. These
are local contexts/processes on one Linux host. No reverse-offerer or real-Wi-Fi
success rate is inferred. The bounded JSON measurements and screenshots are local
ignored artifacts under `tmp/direct/`; failed traces are removed to conserve disk.

D1, D2 and D4 are checked for the delivered experimental scope. D3 stays open for
real-network transport/offerer measurements, and D5 for the explicit field/device
matrix. Full-editor-only rights, absent authority, unavailable historical objects,
disconnected unknown anchors and lack of backup/revocation guarantees remain
intentional limits. No service was deployed or pushed. The owner retains the later
independent security-review decision; no additional product decision is requested.

## Security review follow-up (November 7, 2026)

Replica handshakes now require protocol **2** (the compact invitation and signaling
formats remain version 1). Old replica implementations must reload. Every incoming
update is staged and checked before publication; a failure disconnects that peer
with a plain explanation and leaves the authoritative document, including unsaved
local edits, intact.

Record provenance uses the existing nonextractable Ed25519 profile identity and
Web Crypto. The human author UUID is a domain-separated SHA-256-derived key ID
(128 bits). Agent UUIDs are separately derived from the owner ID and agent session;
an attacker cannot relabel another human as its agent. Display names are still
self-asserted labels, not verified civil identities. Comparison codes authenticate
the session key through the channel people use to compare them.

Independent `meta` entries named `directProof:<root>:<id>` carry signed digests of
canonical record data, root, domain, protocol and project lineage. Independent keys
avoid losing another author's proofs during concurrent map merges. Terminal review
proofs also bind the complete proposal, anchor, change/session record and designated
review authority. The
trusted decision command signs its prepared decision before durable publication;
ordinary replication cannot retroactively sign an unsigned terminal claim. Live
synchronous proposal withdrawals are authorized by the trusted review handler and
signed before transmission. Receivers validate both the authority key and author
identity, including on records forwarded by another peer. Signatures survive saves,
reloads and same-lineage backups. Cross-lineage copies do not inherit approval
credentials. Authority reassignment by another key is refused; D does not implement
a signed authority-transfer protocol.

These signatures attest that a key authorized those records. They do **not** prove
that the current source equals an approved proposal, that a human reviewed it, that
an agent is an independent person, or that an editor cannot modify source. Source
changing rights rest on the full-editor invite. A source edit is not an approval.
An unverifiable incoming claim is reported as **Unverified edit**, quarantined with
its update, and never published as an accepted decision. Unsigned historical records
are not silently upgraded into authenticated history. A legacy profile acquires a
key-bound ID on opening a saved project; its former local acceptance authority is
retained for offline decisions. Sharing legacy unsigned discussions requires a
cleaned copy or continuing the review locally. Offline synchronous withdrawals
without a retained signature likewise remain local evidence.

All roots must be recognized map roots or bounded `text:` roots. Validation inspects
both Yjs storage lanes before interpreting lazy root types, refuses nested shared
types/subdocuments and text embeds, and applies existing Rust semantic validation.
Orphan text retained by old migrations is counted, rather than ignored or deleted.
For peer state, the 64 MiB content limit includes **every** text and asset root (local
saves keep their earlier rules; see the second review). A separate 96 MiB limit includes the encoded retained CRDT state (including tombstones
and pending structures) plus referenced asset bytes; at most 4,096 roots are kept.
Each peer has one active update and one coalesced waiting update totaling at most
96 MiB, plus one active and one coalesced pending vector preparation (64 KiB per
state vector). Duplicate forwarded CRDT history
is coalesced before further signature verification. Missing causal history can remain only in the bounded private
accumulator until repaired; it cannot enter the authoritative document. Existing
192 MiB framed-message/send-queue and 128 MiB advertised-asset limits remain.
Signaling permits up to 64 small queued frames within the existing 1 MiB aggregate
byte ceiling; duplicate pending greetings are coalesced for mesh rejoin bursts. These
are byte budgets, not a claim that JavaScript heap overhead equals serialized size.

The negotiated lineage is checked on every merged update and before sending. A
local lineage change closes the session. Share owns a generation and abort signal
for pending startup and joins; disable, leave and project close cancel them.
Intentional navigation to a joined or cleaned project explicitly transfers that
pending attempt, with checks after asynchronous boundaries. The service adapter
also observes abort while importing its key, connecting and encrypting: a stale
socket is closed before its open callback can transmit the bearer.

### Security follow-up validation

Commands below ran through the flake in this worktree, using provisioned assets.
The final browser command uses port 6001 and software WebKit. Tests retain their
existing assertions and skips. No existing test was weakened or renamed. The new
queue attack sends distinct updates because duplicate Yjs history now coalesces.

| Command (prefix `nix develop -c`) | Observed result |
| --- | --- |
| `npm run fixtures` | Passed once. |
| `npm run build` | Eight successful production builds during implementation. |
| `npm test` (initial) | 161 Rust pass / 2 existing ignores; 1,066 JS/WASM pass, 9 fail, 6 optional-service skips. Eight failures exposed legacy orphan-text compatibility; one service paused-download check timed out. |
| `npm test` (rerun) | 161 Rust pass / 2 existing ignores; **1,077 JS/WASM pass, 0 fail, 6 optional-service skips**, including 512 seeded integration sequences. The service timeout did not recur. |
| `node --test tests/replication.test.mjs tests/model.test.mjs` | 28 pass, 0 fail. |
| `node --test --test-name-pattern='quarantine\|queued byte\|authority signatures' tests/replication.test.mjs` | 3 pass, 0 fail. |
| `node --test tests/replication.test.mjs tests/model.test.mjs tests/local-tabs.test.mjs` | 43 pass, 0 fail. |
| `node --test --test-name-pattern='migration preserves\|complete backup roundtrips\|pre-journal' tests/history.test.mjs` | 11 pass, 0 fail after counting retained orphan text. |
| `node --test --test-name-pattern='authority signatures\|delegated agent\|quarantine\|queued byte' tests/replication.test.mjs` | 4 pass, 0 fail. |
| `node --test --test-name-pattern='authority signatures\|delegated agent\|approval binds' tests/replication.test.mjs` | 3 pass, 0 fail. |
| `node --test --test-name-pattern='signed record provenance' tests/history.test.mjs` | 1 pass, 0 fail. |
| `node --test tests/replication.test.mjs` | 15 pass, 0 fail after queue coalescing, including 64 five-replica schedules. |
| `node --test tests/replication.test.mjs` (final) | 16 pass, 0 fail after bounded vector coalescing. |
| `node --test --test-name-pattern='vector bursts' tests/replication.test.mjs` | 1 pass, 0 fail after bounded vector coalescing. |
| `node --test --test-concurrency=1 tests/replication.test.mjs tests/service.test.mjs tests/history.test.mjs` | 143 pass, 0 fail after the queue and backup refinements. |

Browser invocations all used this exact environment prefix:

```sh
nix develop -c env SCRIBYRA_TEST_PORT=6001 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1
```

The commands following that prefix, including failed development runs:

| Command | Observed result |
| --- | --- |
| `npx playwright test tests/browser/direct-sessions.spec.js --project=chromium --grep 'real transport\|cancels pending\|connecting socket\|two profiles'` | 8 pass, 0 fail. |
| `npx playwright test tests/browser/direct-sessions.spec.js --project=chromium` | 14 pass, 3 fail: presence/signing races and the positive forwarding fixture missing explicit terminal-signing authorization. |
| Required five-spec / three-engine command below, first attempt | Stopped after 61 pass, 10 fail, 1 interrupted; 273 did not run. One mixed-mesh provenance race, then nine harness page closures while the development WASM was installed. Fresh release builds passed those harness cases; the closure cause was not independently isolated. |
| `npx playwright test tests/browser/direct-sessions.spec.js --project=chromium --grep 'mixed Chromium\|browser identities\|real transport'` | 2 pass, 1 fail: duplicate replica updates exceeded the old queue count during mixed rejoin. |
| `npx playwright test tests/browser/direct-sessions.spec.js --project=chromium --grep 'mixed Chromium\|real transport'` | 1 pass, 1 fail: the separate signaling frame-count limit rejected a small-message rejoin burst. |
| `npx playwright test tests/browser/direct-sessions.spec.js --project=chromium --grep 'mixed Chromium\|relay receive queues'` | 2 pass, 0 fail after coalescing greetings and retaining a 1 MiB signaling queue budget. |
| Required five-spec / three-engine command below, second attempt | Stopped after 177 pass, 1 fail, 2 existing skips, 1 interrupted; 167 did not run. Firefox five-profile rejoin exceeded the old two-pending-vector count. Replaced it with one active and one coalesced pending vector, each bounded to 64 KiB. |
| `npx playwright test tests/browser/direct-sessions.spec.js --project=chromium --project=firefox --project=webkit` | 48 pass, 0 fail, 6 existing skips after the final vector refinement. All new attacks and cancellation cases passed in all engines. |

The required combined invocation:

```sh
npx playwright test tests/browser/direct-sessions.spec.js tests/browser/reviews.spec.js tests/browser/comments.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js --project=chromium --project=firefox --project=webkit
```

The final refinement unit command (no WASM regeneration during browser checks):

```sh
nix develop -c node --test --test-concurrency=1 tests/replication.test.mjs tests/service.test.mjs tests/history.test.mjs
```

The successful full `npm test` preceded the last queue, backup and vector
refinements. The focused unit runs above cover those refinements; production was
rebuilt before the final browser checks. The frozen companion and folders crates
were built and tested by `npm test` and were not changed.

Existing browser skips cover Linux WebKit local WebRTC, mixed-pair and negative
paths run once in Chromium, and native composition injected through Chromium CDP.
All new security regressions run in every engine, with actual framed WebSocket
transports for the adversarial states. This does not establish real-device,
real-network, real-Safari or sleep acceptance. D3 and D5 remain open. No new owner
decision is required for these corrections; the existing field-acceptance and
deployment decisions remain his.

## Second adversarial review (November 7, 2026)

### The two WebKit acceptance failures

Both had one cause, and the product was at fault as well as the platform. Linux
WebKit's `generateKey('Ed25519')` rejects with `OperationError` sporadically: 35 of
3,000 attempts, while 9,000 sign/verify rounds on returned keys all succeeded. Opening
any project awaited that key, so a failure left the header with no Share dialog (the
`locator.check` timeout), and the test's own `newIdentity` surfaced the same error. A
browser with no Ed25519 could not open a project at all, with sessions off.

Generation now retries `OperationError` up to eight times. Project opening and local
review decisions no longer depend on an identity. Share checks Web Crypto, Ed25519,
Web Locks, IndexedDB and WebRTC certificates, names what is missing and disables Start,
Join and cleaned copy before any project, socket or bearer use.

The Linux WebKit WebRTC limit is now narrower than recorded. With no app code, a data
channel between two connections in one page opens, also with explicit certificates.
Between two pages, in one context or two, both connections stay `new` for ten seconds.
Those cases stay skipped for that reason. This is not evidence about real Safari.

### Findings and outcomes

| Severity | Finding | Outcome |
| --- | --- | --- |
| Blocker | Off was not off: every project open and review decision required a working identity. | Fixed, regression in all engines. |
| Blocker | The 96 MiB retained-state cap and unknown-root refusal also guarded every local save, so a long-lived project could stop saving with sessions off. | Peer limits moved to `validatePeerState`; local rules match before D. |
| Major | A peer's self-signed `restoreProjection` could rewrite another identity's message; only suggestions checked authority. | Refused, as are all incoming restore and authority-transfer events. |
| Major | `authorRename` and `messageEdit` could target another identity. | Refused unless the signer owns the target; local edits are refused first during a session. |
| Major | A self-signed decision for a not-yet-seen proposal was accepted, then refused that proposal for good. | A decision must bind a present proposal and its review's authority. |
| Major | `directProof:<any root>:…` passed peers but made backups refuse the project; an orphan proof could outvote a later honest one in the CRDT. | Closed shape, known root, existing record. |
| Major | A peer could set `texLinkOrigin` on an existing project, gating compile and backup. | Inherited only at first join. Engine and name are also bounded. |
| Major | A handshake cut by the minute rotation failed after 20 s and blocked retry; `seen` also filled for good after 32 rejoin sessions. | Rotation restarts unopened links and clears counters, whose replays the epoch already drops. Regression fails without the fix. |
| Major | Approve request did not show what would be approved. | Shows up to five before/after pairs. |
| Minor | Unverified peers could cause a 192 MiB allocation; reveals were open-shaped; an offer could arrive in the wrong role; a full 96 MiB state exceeded the message limit; repeat requests re-notified; an invite pasted into an open tab stayed in the URL; older peers got a generic error; the disclosure omitted network-address exposure. | Fixed. |

Forged and replayed approvals were retested: self-signed, transplanted to another
event or proposal, relabelled, proof deleted, signed in another lineage, and record
removed from forwarded state. All are refused with the document unchanged, and now
read as **Unverified edit** because authentication runs before semantic rules.
Comparison codes, commit-before-reveal order and SDP fingerprint binding held on
inspection and in transcript tests. A cancelled start or join sent no bearer. A
cleaned copy's raw CRDT bytes contain no trash, discussion or original author.

### Remaining limits

- **Restore in place.** Its events cannot be signed for other people's reviews, and it
  removes proofs. A restored project fails closed: Start refuses it and offers a
  cleaned copy; restoring during a session disconnects that person from their peers.
- **Identity while off.** Superseded by the owner's decision of 8 November 2026 (below):
  no key exists until sessions are turned on.
- **Redaction and review close.** Any full editor can redact another's message or close
  another's review. The signed event identifies who did so.
- **Anchor reattach.** Any full editor can move another's anchor. The proposal's
  `before` text must still match at the new place.
- **Continuous typing** can defer incoming publication until a pause, because a local
  change restarts validation. Nothing is lost. Large-state cost is unmeasured; hex
  framing doubles bytes on the wire.
- **The trial script** ran here through a Playwright WebDriver shim only, so real
  geckodriver, chromedriver, the Firefox sandbox and SSH remain untested.

### Commands and results

Browser commands use the exact prefix recorded above.

| Command | Result |
| --- | --- |
| `nix develop -c npm test` | 161 Rust pass, 2 existing ignores; 1,087 JS/WASM pass, 0 fail, 6 optional-service skips. |
| `nix develop -c npm run build` | Passed. |
| `npx playwright test tests/browser/direct-sessions.spec.js tests/browser/direct-trial.spec.js tests/browser/reviews.spec.js tests/browser/comments.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js --project=chromium --project=firefox --project=webkit` | 354 pass, 0 fail, 15 skips. Chromium 123/0/0; Firefox 117/0/6; WebKit 114/0/9. |

Skips: WebKit real-context, rotation and blocked-path cases (the limit above); mixed
and blocked-path cases run once in Chromium; trial cases run once in Chromium, which
starts both engines; native composition needs Chromium CDP. Earlier development runs
in this review failed as follows: the rotation test failed three times on its own
timing and assertions before it was correct, then failed as intended with the fix
removed; a two-member accept test failed twice on `revision_conflict`, because signing
moves the revision a caller saw, and now retries as a caller would; one unit run failed
2 on a too-narrow refusal message. The trial's first smoke run failed at its authority
step, which proposed at a point later edits had moved; it now proposes afresh.

D3 and D5 stay open. The results above predate the merge with `main` below.

## Merge with main at schema 8 (November 7, 2026)

`main` (26 commits, schema 8) was merged at `d93a496`. The conflicts were independent
additions: `web/main.js` keeps both import lines, and the commands, comments and roadmap
documents keep both sections. D has no schema migration of its own: it negotiates the
running schema, so peers on 7 and 8 refuse each other plainly. Earlier projects reach 8
on open with nothing of D added, and schema-7 proofs survive and still verify.

Suggestion replies use the existing generic provenance, plus three rules. A thread with
`suggestionId` must bind a present proposal with the same anchor and review, so it
cannot be planted ahead of the proposal and make its honest arrival fail for good.
Threads, messages and suggestions are immutable once accepted. Peers cannot resolve or
reopen a suggestion discussion, which follows its decision. Record count and semantic
bytes are checked before any signature, so a small flood cannot buy 100,000 checks.

The merge exposed a real race. Signing a decision awaits crypto between reading the
saved head and committing; a proof saved in that window failed the commit, and the
retained draft then refused every retry, blocking all decisions for the session.
Proofs now wait while a decision holds the editor. A head that moved under the commit
retries on the new head if its sources still match, and is otherwise dropped unpublished.

Share opens through the shared popup (`openDialog` in `web/menu.js`), anchored to its
button with the shared theme, dismissal and focus return; fields keep ordinary typing.
In a live session, the file menu, replace all and the reply composer follow each
member's mode as before: Viewing and Reviewing close the tree, Viewing disables
replacement, Reviewing replace all proposes, and replies are allowed and verified in
every mode. The trial script takes hosts, SSH user and key from arguments or
`SCRIBYRA_TRIAL_*`; it names no account, key or host.

| Command (prefix `nix develop -c`; browsers add the recorded environment) | Result |
| --- | --- |
| `npm test` (after the race fix) | 162 Rust pass, 2 existing ignores; 1,144 JS/WASM pass, 0 fail, 6 optional-service skips. |
| `npm run build`, `cargo build -p scribyra-sync` | Passed. |
| `npx playwright test` direct-sessions, direct-trial, review-workspace, reviews, comments, local-tabs, editor, menus, three engines | 507 pass, 0 fail, 18 skips: Chromium 175/0/0; Firefox 168/0/7; WebKit 164/0/11. |
| `npm run build:pages`, then pages, pages-domains, agent-surface, agent-recipe in Chromium with `SCRIBYRA_TEST_PAGES_URL` | 12 pass. |
| `node scripts/direct-session-trial.mjs --mode=smoke --a=host-a.example --b=host-b.example --dry-run` | Printed the plan, connected to nothing. |

Skips are the existing ones plus the new live role check on Linux WebKit, for the
reason recorded above. The first full browser run failed the two-member authority
accept on `revision_conflict` in Chromium; that is the race above. No existing
assertion was changed. Remaining: a peer's typing closes an open tree menu and makes
rename/move fail with a revision conflict, as the older modal route did on submit.

## Merge with main: More tools, consent telemetry, privacy pages (November 8, 2026)

Share follows main's calmer top bar. More tools always offers **Share project**,
marked Experimental with its state; the top-bar Share button appears only once
direct sessions are on or a session is active, and the popup anchors to More tools
otherwise. `site/privacy.html` lists direct sessions under things only the person
can start: the connection service they enter (which passes setup messages encrypted
with the invite key and sees addresses, timing, sizes and room membership), the
direct encrypted link to invited peers, and that no STUN, TURN or service of ours is
used (`iceServers: []`). Direct sessions add no telemetry operation;
`docs/telemetry.md` says so and a unit test checks the direct modules never record.

### Remote edits and open UI

Tree menus watched, and tree actions committed against, the whole-project revision,
which every keystroke from any peer advances. Tree actions now check only the node
they act on (path, kind, conflict state) and commit against the current revision;
the menu closes only when what it offers changes. A reviewed move refuses if the
reviewed LaTeX references changed. A peer renaming, moving or deleting the same node
refuses with “Someone else renamed, moved or deleted …”. The same coarse check also
voided project settings and rename, asset replacement, a new comment's selection
(now resolved through its anchor), message edits (event heads guard them), project
search results when an unrelated file changed, and History version naming (now
retried when a peer's edit lands mid-commit). Restore and clean-up plans still refuse
any project change, as their dialog states.

Altered tests: `menus.spec.js` “file actions reject a same-task revision change”
required the old behaviour and now asserts that a text edit does not void a choice
while a tree change still refuses every one; `direct-sessions.spec.js` reaches Share
and Project settings through More tools and clicks outside the popup at a point
clear of it. New: two local-tabs regressions with real concurrent typing, one
direct-session typing regression, one search unit test, one telemetry unit test.

### Review decisions with sessions off

Superseded on 8 November 2026 by [off means off](#decisions-8-november-2026-off-means-off).
What follows was the behaviour until then. A review decision signed with the profile key even when sessions were off, so a later
session could verify it (an unsigned terminal decision is refused by peers and cannot be
signed afterwards). Opening any saved project already creates that key. Measured on
a sample project: the first accept added 21 `directProof:*` entries to `meta`
(about 7.6 KB of a 10.3 KB stored-update growth; a backup grew 9.1 to 15.2 KB). They
are in backups and history, not in source ZIPs, and do not count toward the 64 MiB
source limit.

## Decisions, 8 November 2026: off means off

The owner decided three points on 8 November 2026.

1. **Off means off.** With direct sessions never turned on in a browser profile, D does
   nothing: no signing key is created, no `scribyra-direct` database is opened, the local
   author ID is the random one `main` produces, and no `directProof:*`, `directClaim:*` or
   other D field reaches any project, backup, export or history. The key is created only
   when the person turns sessions on, or turns them on to join an invitation. Turning them
   off again stops all D activity (no signing, claiming, Share probe or invite project) and
   keeps the key; Share offers **Delete signing key**.
2. **Restored projects share only as a cleaned copy** (the default proposed above). Restore
   events have no signed peer protocol, so Start refuses a restored project and offers a
   cleaned copy.
3. **Any full editor can redact others' messages or close their reviews** (the default
   proposed above). The signed event identifies who did so.

### What changed

- `web/direct-state.js` holds the enabled flag, the list of this profile's earlier author
  IDs and a marker that a key exists, all in `localStorage`, so reading them opens nothing.
- Opening a project no longer touches identity. `profileIdentity()` creates a key only
  with `{create:true}`, which only the Share toggle calls. Share runs its browser-support
  probe (which makes a throwaway key) only once sessions are on. An invite link opened
  with sessions off is shown against an unsaved placeholder; no project is created until
  the person turns sessions on. Review decisions sign only while sessions are on.
  Agents draw their random author ID exactly as before while off; on, the ID is derived
  from owner and session as before.
- The test that proves it: `tests/direct-off.test.mjs` runs one deterministic project
  (an edit, a comment, a reply, a review with an accepted and a rejected proposal, a
  named history version, a backup and a ZIP export) with sessions never on, and compares
  the SHA-256 of every IndexedDB row, the backup and the ZIP, plus `localStorage`, the
  author ID, the databases opened and the keys generated, with the same run on `main`
  (`fixtures/direct-off-main.json`, recorded by `scripts/direct-off-baseline.mjs
  --ref=main`, which extracts `main`'s `web/` and runs the identical scenario). The
  scenario supplies Web Locks and IndexedDB as a browser does. The branch head before
  this change fails it: one key generated, `scribyra-direct` opened, different storage
  and backup hashes. The browser test "off means off until turned on" checks the same
  in all three engines, through the UI.

### Earlier records, and author continuity

Turning sessions on moves the profile to a key-derived author ID; the earlier random ID
is kept in `scribyra:legacy-authors` as this profile's own. Locally, earlier comments,
reviews and decisions stay attributed to the person: names come from the same author
records, earlier-authority reviews can still be decided, and the review mode carries
over. During a session, a message written under the earlier ID cannot be edited, since
peers could not verify the edit.

Key-derived IDs (people and delegated agents) are now UUID **version 8**; IDs from
`crypto.randomUUID()` are version 4. So an ID itself says whether a key must stand
behind it. Peers accept an **unsigned** record only under a version-4 ID that no proof,
claim, connected peer or own profile binds here, and show it as **unverified**. Unsigned
records under a version-8 ID are forgeries and refused as before. An agent whose ID is
not derived from its owner and session (one made while sessions were off) speaks only
for itself, so it cannot be used to relabel a person as someone's agent.

When a project is shared, the sharer writes a signed, lineage-bound
`directClaim:<earlier ID>` binding each earlier ID that owns records there to its
key-derived ID, and signs those records with **claimed** proofs (`{"digest":…,
"claimed":true}`). Decisions made before the profile signed decisions (under an earlier
ID, or with sessions off) also get only claimed proofs. Peers show claimed records as
"claimed, not verified" and such decisions as "Marked accepted by … · claimed decision,
not an approval". Only the trusted decision command produces a verified decision, as
before; an unsigned decision under a key-bound authority is still refused. Before
sharing, Share states how many earlier decisions will show as unverified, how many
earlier records as claimed, and how many records by others are unsigned.

A claim cannot be used to take someone else's past records: claims are immutable and
signature-checked; a claim is refused for a version-8 ID, an ID any key or claim binds
here, or an ID that already owns records the receiver holds without that claim; a
claimed proof can only accompany a record as it first arrives; and claimed records
carry no authority. Unsigned records under a claimed ID are refused. Deleting the key
gives the profile a fresh random ID (both earlier IDs remain its own), because records
under the old key-derived ID can no longer be signed.

Remaining limits: a member who already holds someone's earlier records (for example
from a backup) and reaches a new joiner first can show them as claimed by that member;
peers that already hold those records refuse the claim and disconnect. Unverified
records under random IDs can be written by any full editor; they are labelled as such
and carry no authority, but can still occupy a pending earlier-ID review with an
unverified decision. If browser storage loses the key but keeps the key-derived author
ID, records made under it afterwards can only be shared as a cleaned copy. Trust labels read stored proofs without repeating
signature checks, which ran as each record arrived.

### Blocked direct path test

The Chromium test "the page timer explains a blocked direct path" failed in two long runs
and passed alone. Cause: the product. A minute rotation restarts every link that has not
opened, and restarting gave the link a fresh 20-second timer. Whenever the test reached
the join within about 20 seconds of a UTC minute boundary, the blocked path showed
"Connecting…" for up to 40 seconds, beyond the test's 25-second wait. Long runs reach
the test at arbitrary wall-clock seconds; a short run alone often did not. Joining at
:48–:50 reproduced it every time. The deadline now belongs to the attempt: a restarted
link keeps it, with at least five seconds' grace in the new room. The test now always
joins at :48–:50, so it exercises the boundary on every run.

### Commands and results (8 November 2026)

Browser commands use the exact prefix recorded above (port 6001, software WebKit).

| Command | Result |
| --- | --- |
| `nix develop -c npm test` | 169 Rust pass, 2 existing ignores; 1,177 JS/WASM pass, 0 fail, 6 optional-service skips (1,183 total). |
| `nix develop -c npm run build`; `cargo build -p scribyra-sync` | Passed. |
| `npx playwright test` direct-sessions, direct-trial, review-workspace, reviews, comments, local-tabs, editor, menus, telemetry-consent, workspace, history; three engines | 764 pass, 2 fail, 20 skips. Chromium 260/2/0; Firefox 255/0/7; WebKit 249/0/13. Both failures were the trial script (smoke, mixed) typing into Share before turning sessions on had finished; the script now waits. |
| `npx playwright test tests/browser/direct-trial.spec.js`, three engines, after that fix | Chromium 4/0/0; Firefox and WebKit skip by design (the trial runs once, from Chromium). |
| `npm run build:pages`; `nix develop -c python3 scripts/ci-telemetry.py browser-pages`; `npm run build` | Passed; 13/13 Pages tests, telemetry delivery off. |
| `node scripts/direct-off-baseline.mjs --ref=main` / `--ref=240b74f` | `main` and this branch identical; the previous branch head differs (key, database, proofs). |

Skips are the existing ones (Linux WebKit cross-page WebRTC, single-engine mixed, blocked
and trial runs, Chromium-only composition) plus the new peer-trust test on WebKit.
Development runs before these: one Chromium direct-sessions run failed 5 (two of my own
new assertions picked the wrong card or name; the popup test clicked where the larger
dialog then was; the cleaned-copy count was stated wrongly; the no-Ed25519 switch now
stays off); the agent-authored earlier decision first blocked Start, fixed in
`signRecords`; three existing unit tests failed until unsigned records were limited to
version-4 IDs. Altered existing tests: cleaned sharing, browser identities, no
Ed25519 (above), and the blocked-path test (now aligned to a minute boundary).

## Merge with main: two-tab fixes, companion retirement, update notice (November 9, 2026)

`main` at `a6cf985` merged into this branch. Main had cherry-picked this branch's
menu/rename fix (`fbdc0b3`) and extended it: tree actions refuse a destination folder
another tab renamed, moved or deleted; a folder delete refuses when what it holds
changed after confirmation; settings refuse when the main file they show was deleted;
a new comment refuses when its selected text changed, even partly. Main's extended
version is kept whole, including its tests. These checks read the shared document, so
a direct-session peer's change trips them exactly as another tab's does; a new
direct-session browser test proves it for all four cases (Chromium and Firefox; Linux
WebKit page-to-page WebRTC stays skipped as before).

The update notice: reloading ends this tab's part in a live session, and the relay
capability is not kept. While a session is active, Reload reads "Reload and leave
session"; choosing it explains this and offers "Leave session and reload" or "Stay in
session". A session that starts after the choice refuses the reload; confirming saves
as main does, closes the session, then reloads. Limit: as on main, a reload is refused
if the project's revision moves between saving and reloading, so a peer typing
continuously can make Reload ask to be chosen again.

Off means off still holds: `scripts/direct-off-baseline.mjs --ref=main` gives the same
digests at `a6cf985` as at the previous baseline `5a9c17b`, so only the recorded commit
changed, and this tree matches it byte for byte.

The full Chromium suite found one real accessibility fault in markup that predates
this merge (why earlier recorded runs did not report it was not established): `#direct-participants` was a role-less span with an
`aria-label` (axe `aria-prohibited-attr`). It is now a labelled group.

| Command | Result |
| --- | --- |
| `nix develop -c npm test` | 169 Rust pass, 2 existing ignores; 1,180 JS/WASM pass, 0 fail, 6 optional-service skips. |
| `nix develop -c npm run build`; `cargo build -p scribyra-sync` | Passed. |
| Full browser suite, one engine at a time | Chromium 444 pass / 0 fail / 9 skip; Firefox 437 / 0 / 16; WebKit 428 / 0 / 25. |
| First full Chromium run, before the group fix | 436 / 7 / 10: six axe audits (above) and one telemetry-isolation case because this worktree lacked the pinned Alloy binary (linked from the main checkout's cache, no download). All seven then passed 5 of 5 each. |
| `npm run build:pages`; `ci-telemetry.py browser-pages`; `npm run build` | Passed; 13/13 Pages tests, telemetry delivery off. |

## Real two-machine trial (November 9, 2026)

Real browsers drove the real app through `scripts/direct-session-trial.mjs`, with the connection service on the agent host reached over SSH reverse tunnels. Machine A was a desktop on wired Ethernet, machine B a laptop on Wi-Fi, both on the same home network behind the same router, with default NixOS firewalls unchanged. Browsers were Firefox 159.0 and Chromium 156.0.8078.79 from each machine's Nix store; WebDriver ran over the mesh, and peer traffic was measured per interface.

- Smoke: Firefox on A started, Chromium on B joined; connected in 91 ms after the codes were shown, one concurrent edit round, converged.
- Mixed, two repetitions: Firefox and Chromium in both start orders and both machine directions, eight sessions in all, each with three concurrent rounds of editing, commenting and suggesting, 2 MiB of text sent over the session, leave, offline work and rejoin. **8 of 8 converged**, including the four where Firefox started and Chromium joined, which failed 6 of 8 times before the offer fix. Connection after the codes took 99–181 ms. Sending the 2 MiB of text took 5.5–6.8 s, and converging it 2.3–8.0 s.

This covers one wired-and-Wi-Fi home network on one day. It doesn't cover client isolation, guest or office networks, Safari, Windows or Mac, or sleep, so D3 and D5 stay open.

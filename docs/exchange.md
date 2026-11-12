# Runtime and exchange contracts (v1)

The static browser is the authoritative runtime for a connected project. Each
build is scoped to a project and source revision, with a host-issued monotonic
job ID (random workspace epoch plus monotonic counter) and AbortSignal. Results
include `jobId`, `projectId`, and the command host’s captured `sourceRevision`
on success, cancellation, and failure. A workspace admits one job at a time. Cancellation aborts
compiler/package activity and PDF preparation. Completion releases the slot;
closing the project invalidates its session immediately and terminates the retained
compiler even when it is idle. Late progress and
results cannot publish into another project. A retained old handle cannot cancel
a later build. Neither a completed build nor a command receipt acknowledges a
local save or remote durability.

PDF replacement keeps its previous document alive until the new preview finishes
initializing. Cancellation or failure rolls back that replacement; it preserves
the previous download bytes. Failed compilation preserves the previous preview.
Source edits during a build still mark its PDF stale and invalidate navigation.
Cancellation can clear navigation metadata; recompiling restores it.

## Transport envelope

`crates/core/src/exchange.rs` and the `validate_exchange` WASM binding validate
this transport-neutral JSON shape (unknown fields are rejected):

```json
{
  "version": 1,
  "projectId": "project-id",
  "deviceId": "authenticated-device-id",
  "sessionId": "authenticated-session-id",
  "sequence": 1,
  "payload": {"kind": "replica", "object": {"hash": "64-lowercase-hex-digits", "size": 1024}}
}
```

Payload kinds are `command` (a v1 project command request), `replica` (an immutable
plaintext CRDT object reference), and `ciphertext` (an opaque object reference,
positive `keyEpoch`, and 24-byte nonce encoded as 48 hex characters). Ciphertext
framing reserves [XChaCha20-Poly1305](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction), including its 16-byte authentication tag.
This reservation implements no encryption and proves no ciphertext authenticity.

The trusted adapter constructs the separate grant after authenticating the
connection and checking current pairing/revocation. It binds project, device,
session, next expected sequence, optional command context, and independent
plaintext-replication and ciphertext-storage permissions. Packet identifiers are
claims to compare with that grant, never credentials. No received packet can
construct or broaden a grant. Read-only command grants cannot authorize writes;
command access does not implicitly authorize raw CRDT replication, and opaque
storage does not grant plaintext or command access.

Sequence numbers start at 1 and must exactly match the next expected number.
The transport owner must serialize dispatch, recheck revocation before execution,
and atomically advance the sequence only when accepting the operation; this
stateless validator does not keep a replay database. Session changes require new
grants. Sequence exhaustion requires a new authenticated session rather than
wrapping to zero. Command retries use the existing request-ID receipt mechanism;
reconnect/retry policy must reconcile accepted receipts with transport sequencing.

Binary bytes travel separately, within the existing 64 MiB object bound. Adapters
must verify byte length and SHA-256 before committing an object reference. For
ciphertext, the hash identifies the encrypted bytes; an untrusted store should
receive no source filename or text. Future encryption clients must verify AEAD,
bind protocol/project/stable-object-identity/epoch as associated data (the
object identity must be distinct from the resulting ciphertext hash), enforce nonce uniqueness,
and handle key epochs/revocation/recovery. Metadata confidentiality and traffic
analysis require additional design in milestone 11; these framing types alone do
not provide end-to-end encryption.

The generic replication/ciphertext envelope is not exposed as plaintext by the
[opaque service](service.md); future encrypted clients carry it inside their
authenticated payload. The localhost `plaintext-demo` example retains its
explicitly unauthenticated plaintext protocol. The companion below implements a separate scoped request/
reply contract using the shared command validator; it does not grant raw CRDT
replication or ciphertext storage. Remote authentication, encryption and storage
delivery remain later roadmap work.

This is an incoming-operation contract. Outgoing command receipts retain their
existing v1 command envelope. A concrete companion adapter must define its
progress/result framing and reconnect behavior before exposing a listener.

## Acceptance and results

This delivery requires: cancelled or closed build handles cannot publish or stop
a later project build; cancellation during the real PDF-worker handshake must
release the build slot; cancelling an in-progress page replacement must preserve
the previous downloadable PDF byte-for-byte; PDF reading, offline restart and
source navigation must continue working in Chromium, Firefox and WebKit. Viewer
page changes must also preserve an uncommitted page-number input draft.

Exchange checks require rejection of foreign device/session/project scope,
stale or out-of-order sequence numbers, unknown permission fields, unauthorized
commands, raw replication under an opaque-storage grant, and invalid encrypted
object framing. The trusted transport remains responsible for authentication,
revocation, sequence persistence and actual object-byte verification.

Validation: 25 Rust tests and 64 JavaScript tests pass, including actual WASM
validation. The targeted browser matrix covered 15 runtime/PDF/navigation cases;
an initial WebKit page-input failure was corrected and the page-input case passed
again in all three browsers with an explicit draft-preservation assertion. The
final Chromium cancellation test also checks result correlation IDs and source
revisions; the existing runaway-compiler cancellation/recovery case is rechecked.
The production build passes; after the final idle-worker cleanup change, its
unit check and the Chromium compile/cancel/project-switch recovery case passed again. This completes the contract/lifecycle goal, while
IME/accessibility workspace acceptance and the transport implementations remain
required roadmap work.

## Optional Rust companion and MCP server

> Discontinued November 8, 2026 (the owner's decision). The editor no longer offers
> pairing or contacts the companion; this section describes the retained code,
> reachable only with the test-only `localStorage['scribyra-companion-dev']` switch.

Goal 3a exposes the active browser project through an optional local Rust
companion. Goal 3b adds [outbound provider connections](mcp-providers.md) with a separate
permission boundary. Both server and client acceptance are required for milestone 3. The browser editor remains independently
usable as a static website, with every self-hosted feature included.

`crates/companion` uses the official [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk),
pinned at 3.8.0. The endpoint supports current `2026-07-28` requests and legacy
`2025-11-25` clients. Interoperability tests use the official TypeScript client
2.4.0 with its modern revision explicitly pinned, and the maintained SDK 1.32.2
legacy client. Tests observe the actual HTTP protocol-version headers. This
matters because [2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
removes protocol-level sessions and uses per-request streams for cancellation;
older clients still negotiate their legacy lifecycle. The SDK handles those
transport differences; Scribyra enforces its project grant on every request.

### Pairing and grants

Run `npm run companion` and pair from **More tools** → **Rust companion and MCP** in the open project. The
service binds only `127.0.0.1`, defaults to port 43821, validates the HTTP Host and
browser Origin, and accepts only configured editor origins. Additional origins
are explicit `--origin` arguments. Static hosting remains independent; `--app
dist` optionally serves the same built app locally when a browser does not permit
a hosted page to connect to loopback. Its storage origin is separate from another
hosted editor origin.

The startup pairing code is a long random secret, generated for this process.
`SCRIBYRA_PAIRING_CODE` can provide a 64-character lowercase hex secret for
controlled local provisioning. It is not a project property or a vendor license.
The browser sends a fresh nonce and HMAC-SHA-256 proof derived from the code,
bound to its Origin, project ID and exact permission flags. It sends neither the
code nor project source in that request. The companion rejects replayed nonces
and returns a domain-separated server proof binding the browser/client tokens,
project, permissions and endpoint. The browser verifies that proof before creating
a project adapter. Opaque project identity is the only project metadata needed
before the peer proof; the project name/source is not sent during pairing.

Browser and MCP client credentials are different. The browser authenticates its
WebSocket in the first bounded message; credentials never appear in URLs. The MCP
client uses the separately issued Authorization header. Read access is the default;
write, direct compilation and export are separate immutable project grants.
The browser keeps its own trusted copy of the selected permissions, independent
of received packets. Changing permissions requires a new pairing. The panel
shows the actual address and granted permissions when reopened, and the toolbar
visibly identifies a connected companion.

This is local manual bearer provisioning. The service does not implement OAuth
server discovery, arbitrary public hosting, OS account management or an encrypted
remote transport. The [MCP authorization framework](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
is separate from protocol framing. Clients need configurable HTTP headers for
this server; no built-in language model or paid API is required.

At most 16 pairings exist in one process. A new pairing must attach its browser
within 30 seconds; an attached pairing expires after eight hours. A disconnected
browser loses its grant and cached artifacts, requiring explicit pairing again.
Heartbeat checks close an unresponsive connection. Revocation, expiry and process
shutdown remove access and reject pending operations. Browser-side closure first
closes its command host and aborts its owned operations, before asynchronous
network cleanup. No request can switch the adapter to another project.

### Browser request and result contract

`crates/core/src/companion.rs` defines a closed version-1 request with `requestId`,
`projectId`, `sessionId`, monotonically increasing safe-integer `sequence` and a
tagged operation. Grants/context are separate trusted inputs. Rust validates scope,
sequence, permission and parameter bounds in the native process and through WASM
in the browser. A correctly scoped/sequenced frame is consumed independently of
its operation result, so a stale operation does not invalidate later frames.
Malformed, foreign or replayed frames close the browser channel.

Operations cover inspection, bounded file reads, bibliography metadata, diagnostics,
build metadata, shared Rust search, project commands, compilation, export and
request-scoped cancellation. Writes use the existing command host: it checks the
actual current revision and `before` strings atomically and retains bounded
request-ID receipts. Retrying the same write ID/payload returns that receipt;
reusing it for a different command fails. Receipts include concrete requested
changes and the transaction result. They acknowledge a live browser transaction,
not successful local persistence or remote durability. The ordinary journal/save
indicator continues to report persistence separately.

Read/search results label the source revision they observed. File chunks use
UTF-16 offsets and never split surrogate pairs. Search runs in the existing
cancellable Rust/WASM workspace worker. Source patches use the same validated edit
path as the UI and form separate undo groups; ordinary undo/redo in an open
source editor can undo a companion edit without also undoing the preceding
keyboard edit. Binary file
reads return metadata; bulk source/PDF export has its own grant.

Compilation uses the existing browser build session, pinned LuaLaTeX packages,
preview and diagnostics. It rejects a stale starting revision or a busy workspace.
The remote request owns only its own build handle: cancelling it cannot cancel a
later/manual build. Modern HTTP stream cancellation and legacy SDK cancellation
are forwarded to that handle. Closing the project cancels pending work and a late
result cannot publish into another project. The editor's optional automatic
compilation preference still applies to source edits; the compile grant controls
direct MCP build requests.

The server exposes these tools:

| Tool | Required grant and result |
| --- | --- |
| `inspect_project` | Read; live tree, metadata, permissions and revision. |
| `read_file` | Read; source chunk or binary metadata for a live file ID. |
| `search_project` | Read; Rust literal/regex search with UTF-16 matches and source revision. |
| `create_file` | Write; atomic text-file creation through the shared command host. |
| `patch_text` | Write; expected revision, exact before/after edits and stable transaction ID. |
| `compile_project` | Compile; real browser build result and diagnostics. |
| `export_project` | Export; source ZIP or available PDF, with a scoped temporary artifact. |
| `read_artifact` | Export; bounded base64 chunks and integrity metadata for that pairing's export. |

Resource URIs under `scribyra://<projectId>/` expose `tree`, `bibliography`,
`diagnostics`, `build`, `files/<fileId>` and previously issued artifact metadata.
They retain revision/context rather than treating a saved source path as a live
OS filename. Bibliography resources link the actual project `.bib` file identities;
source content uses the same bounded file-read interface.

The bridge accepts at most eight concurrent operations per pairing and bounds
request frames at 8 MiB. The SDK also limits HTTP request bodies. Reads return
at most 1,048,576 UTF-16 units; use `nextOffset` for additional chunks. Exports are
bounded at 65 MiB. The companion holds at most two exports and 128 MiB per pairing
in RAM, evicting older ones when needed. Artifacts expire after 15 minutes and
are removed on disconnect/revocation. They are immutable snapshots, not a project
working copy. PDF metadata identifies the successful build and whether its preview
is stale relative to current source.

Exports can be downloaded with the same scoped Authorization header, or retrieved
entirely through `read_artifact` in chunks of at most 65,536 bytes. Follow
`nextOffset` to `eof`, concatenate decoded chunks and verify the reported SHA-256.
No credential is embedded in the download URL. An invalid, expired, foreign or
revoked artifact request cannot fall back to a host filesystem path.

### Server acceptance

This delivery requires independent modern and legacy MCP clients to read the
active browser model, reject foreign scope and ungranted direct calls, detect a
concurrent edit before patching, retry an accepted transaction without repeating
it, and export byte-correct source. Pairing checks require rejection of a forged
permission set, incorrect Origin, incorrect peer proof, nonce replay, missing
credentials and a forged Host header. Browser checks require all three engines to
pair read-only and with explicit permissions, search/edit/undo live source, compile
a real PDF, transfer source/PDF bytes, cancel an owned runaway build while keeping
the previous PDF, revoke access on project closure, retain source/PDF build
provenance when a failed local save prevents closure, restore dialog focus and pass
the new dialog's accessibility audit. The locally served static-workspace fallback
must also pair successfully.

Validation for goal 3a: the production WASM/static build, Rust formatting and
compiler-wrapper checks pass. The final native run passes **50 Rust tests**;
`node --test tests/*.test.mjs` passes **126 JavaScript tests**, including the
independent modern/legacy MCP clients and the existing sync-demo regression.
The final browser matrix passes **30 cases** across Chromium, Firefox and WebKit:
nine companion cases plus editor, shared-command and PDF cancellation/rollback
regressions. It exercises actual browser compilation and byte transfers rather
than substituting a native TeX process. The release companion builds and its CLI
help runs successfully. MCP browser/client tests use public synthetic sources.

The private-paper acceptance is checked separately with disposable Chromium
storage; private ZIPs, source, PDF outputs and reports remain ignored. The IEEE
paper compiles unchanged online and offline to five pages (121,508 PDF bytes),
with all 53 source files byte-exact on export. The original thesis still reports
its explicit source compatibility error; its separate compatibility copy compiles
to 36 pages. This validates the existing compiler flow after the runtime changes.

The server delivery alone does not complete milestone 3. Outbound HTTP/stdio
connections and their separate permission/acceptance boundary are recorded in
[goal 3b](mcp-providers.md).
Local folder/LAN sync, Git, remote collaboration and encryption remain later
milestones. The unauthenticated sync demonstration is separate and does not gain
production sharing status from this companion.

# Project command contract v1

The static application uses `web/commands.js` and shared Rust definitions in `crates/core/src/commands.rs`. This is an in-process command boundary, not a network listener or an MCP server. A trusted browser adapter supplies the current Y.Doc, project ID, capabilities and session lifetime. Requests cannot grant their own access. The later companion and plugin hosts must authenticate and scope their callers before constructing an adapter; importing this module inside the trusted application is not authentication.

## Request and receipt

```json
{
  "version": 1,
  "requestId": "unique-id-for-this-request",
  "projectId": "authorized-project-id",
  "expectedRevision": "opaque-session-revision",
  "command": {
    "op": "text.patch",
    "edits": [
      {"fileId": "stable-file-id", "start": 0, "end": 5, "before": "Hello", "after": "Salut"}
    ]
  }
}
```

Rust rejects unknown fields and operations, unsupported versions, invalid paths/IDs, oversized payloads and unauthorized capabilities. Every write requires `expectedRevision`; reads may omit it or supply it to require a matching snapshot. Offsets are UTF-16 code units, matching CodeMirror, and must be Unicode scalar boundaries. Patches include the expected old text, reject overlaps, and validate every target and the resulting project size before applying one Yjs transaction. Offset validation walks each affected source once, rather than rescanning it for every edit.

Successful receipts contain `version`, `requestId`, `projectId`, the resulting `revision`, `ok: true`, and `value`. Failures contain the same envelope fields, `ok: false`, and `error: {code, message}`. A successful write means **accepted in memory**. It is not a storage acknowledgment; IndexedDB durability remains the separate save queue and “Saved locally” indicator. The operation must remain exportable if that queue later fails.

Revisions are opaque, per-document-session UUID/counter tokens. Every Yjs update advances the counter, including deletion-only updates, merges and undo. A new session changes the UUID even when its source bytes are identical. This deliberately avoids treating a Yjs state vector as a complete revision: deletion-only edits can leave that vector unchanged. These tokens are concurrency preconditions, not persistent history IDs, authenticated authorship or cryptographic commitments.

Each host retains the last 128 successful write receipts with a SHA-256 digest of the normalized request. Retrying the exact request returns its original receipt without reapplying the mutation; reusing its ID for a different request fails. Its receipt may refer to an older revision than the current head. After eviction or reopening, a genuinely applied mutation's old revision is rejected. Revoking/closing the host prevents reads and retries too. Callers should acquire a fresh revision after reconnecting rather than assume the replay cache is durable.

## Operations

| Operation | Capability | Payload / result |
| --- | --- | --- |
| `project.inspect` | read | Derived tree and project metadata |
| `file.read` | read | Stable file `id`; returns text or a checked binary copy and its blob reference |
| `project.export` | export | Ordinary source ZIP bytes, including empty folders |
| `project.configure` | write | Optional `name`, `engine` (`lualatex` only), `mainFile`; a nonempty main ID must name a live, unconflicted `.tex` source |
| `environment.set` | write | `environment`: a strict version-1 TeX environment lock or `null` to unlock; runtime/catalog compatibility is checked by the compiler/import adapters |
| `files.add` | write | Atomic entries tagged `folder`, `text`, or `asset`, each with `path` and optional `id` |
| `node.planRelocation` | read | `id`, destination `path`; returns detected reference edits and warnings |
| `node.relocate` | write | `id`, `path`, `selectedReferences`; recomputes the reviewed plan at the required revision |
| `node.duplicate` | write | `id`, `path`; creates independent file identities and text |
| `node.delete` | write | `id`; retains the subtree in recoverable deleted files |
| `trash.restore` | write | Restores the latest deletion batch with conflict validation |
| `asset.replace` | write | `id` and `{hash, size}` blob reference |
| `text.patch` | write | At most 2,000 validated source edits, applied atomically |

Binary attachments are separate from JSON requests: `execute(request, attachments)` accepts a map from SHA-256 hash to Uint8Array. Each referenced object is checked against its claimed hash and length before mutation. Binary read/export results currently use Uint8Array values in the in-process receipt; future transports must explicitly frame these bytes or represent them as scoped resources, never serialize typed arrays as accidental numeric-key JSON objects. Returned objects and buffers are isolated copies. Assets remain subject to the existing 64 MiB project and recoverable-trash limit.

Failures distinguish `unsupported_project_version`, `unsupported_version`, `invalid_request`, `permission_denied`, `revision_required`, `revision_conflict`, `request_id_reused`, `project_closed`, `not_found`, and `blob_unavailable`; existing model validation failures use `operation_failed`. A consumer must handle unknown future error codes as failures rather than success. Protocol version 1 does not accept executable code, arbitrary Yjs updates or filesystem paths outside the project.

## UI and extension boundary

Project creation/import, settings, tree mutations, figure insertion, binary replacement and source export and environment locks use the same command host as future authorized consumers. Dialogs and asynchronous file reads retain their starting revision and cannot silently commit against a subsequently changed project. Source search/replacement and `text.patch` share the same Rust patch validation and Yjs mutation helper; reviewed search batches keep their dedicated undo manager. Live typing and native editor undo remain CRDT editor operations, while the command revision observes their updates. There is still one authoritative Y.Doc, not a competing Rust text replica.

Build cancellation/result identities and the reserved Rust exchange validator are now documented in [runtime and exchange contracts](exchange.md). The workspace integration/input gate is recorded in [workspace acceptance](workspace-acceptance.md); authenticated adapters and encryption implementations are later milestones. This command contract does not claim those later integrations are complete. The existing loopback sync demo remains a separate plaintext, unauthenticated experiment; it must not be exposed as a production command gateway.

## Verification

`npm test` runs the shared Rust authorization/Unicode checks and JavaScript host tests against actual WASM. Tests cover revoked/read-only/foreign-project access, deletion-only revisions, reopening, retries, rejected settings, all-or-nothing text patches, tampered binary attachments, copy isolation and reviewed reference moves. `tests/browser/commands.spec.js` exercises concurrent changes from real separate browser profiles while settings and deletion dialogs are open. Existing browser suites cover imports, moves, replacement undo, saves, compiler/PDF behavior and offline use through the same UI paths.

## Internal collaboration foundation v2

`web/collaboration-commands.js` is an opt-in trusted-host dispatcher for milestones
A/5/6/7. It is **internal**. A5's experimental `window.scribyra.agent` adapts its
implemented operations; there is no public versioned contract, new transport or
companion command. V1 parsing and read/write/export grants are unchanged.
The schema, namespace policies and independent read/edit/comment/review/export/history
rights live in `crates/core/src/collaboration_{schema,commands}.rs`. Every mutation
requires a revision. Feature handlers additionally validate payloads, ownership,
restore mode and original undo rights before publication. Disabled feature stubs
return `unsupported_command`; `describe()` advertises only registered implementations.

V2 uses `{version:2,requestId,projectId,expectedRevision?,command}` and the existing
receipt envelope with `version:2`; successful values require `valueVersion:1` and
at most 64 KiB JSON. `extensionCommands` shares the document revision clock and
128-entry successful-mutation replay rules with v1. Revision checks include pure
annotations and deletion-only edits. Closed/revoked sessions reject retries too.
Handlers prepare synchronously; asynchronous preparation belongs to a revision-bound
feature plan. Durable handlers use awaited, per-document serialized dispatch with
in-flight retry deduplication and guarded storage commits. `history.name`,
`suggestion.accept`, `history.restore`, `history.compact` and `backup.import` use
this path automatically; other trusted handlers opt in with `durable:true`.
Callers await their `execute()` result. Receipts follow completed commits, and
quota errors return `quota_exceeded`. See the [durable-dispatch contract](annotations-design.md#rust--js-and-agent-command-contract)
for handler guards, replay and revocation at the commit boundary. No foundation
stub performs a review decision, history restore or backup export.

The feature lifecycle receives the document, project ID, internal commands, save
flush, storage gateway, selection, activation, compile, state, origin/undo and
transfer-registration hooks. The compile hook accepts isolated `inputs` and an
explicit `destination(result,session)`, plus optional progress/cancellation. It
shares the accepted build's coordinator and occupied slot through publication;
preview results belong to a separate destination. Comments, Reviews and History mount their local controls and register implemented operations. Source-affecting updates invalidate accepted PDF/navigation; annotation
updates still save and advance command revisions, without auto-compiling. Only
local source changes schedule auto-compile. Agent origins isolate per-file undo;
review/restore origins remain outside it and can register dedicated batch managers.

`commitPrepared(projectId,expectedSequence,update,objects,pins)` stages verified
immutable `{hash,bytes}` history objects and `{hash,pin}` retention roots in the
same transaction as the merged head/journal. `expectedSequence:null` requires an
absent project; otherwise the committed sequence must match exactly. A mismatch
returns `revision_conflict`. Hashing/copying precedes the transaction; only
IndexedDB requests are awaited inside it. The returned `{update,sequence}` is
published by the caller after commit. Ordinary saves and incoming local-tab previews
use the same full-state validation dispatch. Retention, restore and backup policy are implemented above this gateway by
[history](history.md).

## Experimental agent adapter (A5)

`web/agent-commands.js` registers only `agent.*` operations on the workspace's v2
host and exposes convenience methods at `window.scribyra.agent` while a project
is open. `describe()` reports `experimental:true`, envelope/value versions, project/build
identity, `recipe:"agent.md"` and implemented operation names (including other
namespaces when installed). `describe({details:true})` adds limits and operation rights. R4 still gates a public versioned contract;
there is no `window.scribyra.v1`. See the deployed [recipe](../public/agent.md).

| Method / v2 operation | Behavior |
| --- | --- |
| `status` / `agent.status` | Compact project, main/active file, busy state and latest session job ID |
| `readTree` / `agent.tree` | Exact `path` lookup, or default 50 / maximum 100 nodes; minimal `{path,id,kind,size}` entries (UTF-8/asset bytes, folders 0); revision-bound cursor; 16 KiB items budget |
| `readSource` / `agent.readSource` | Exactly one of `path` or `fileId`, inclusive 1-based line range; default 50, maximum 200 lines and 8,192 UTF-16 units; offset continuation at the same revision |
| `patchSource` / `agent.patchSource` | Required expected revision, exactly one `path` or `fileId` per edit, and at most 20 range edits or unique literal find/replace edits, 128 KiB payload; shared Rust patch validation and one AgentOrigin transaction |
| `compile` / `agent.compile` | Start, return session job ID immediately; busy is a failure, never a toggle |
| `poll` / `agent.poll` | Optional `waitMs` (0–25,000), at most 16 pending waits per job / 32 per session with one shared timer (`too_many_waiters` on excess), resolves on completion/cancel/close or timeout; named job's running/succeeded/failed/cancelled state, source revision, stale flag, pages (null when unavailable), errors/warnings |
| `diagnostics` / `agent.diagnostics` | Final-pass actionable warnings (runtime-only epstopdf shell-escape notice excluded); explicit still-running message before completion; named build's source revision and computed stale flag on every page; issues, default 10 / maximum 20; 512-unit summaries, optional 1,024-unit details; 16 KiB items budget, explicit continuation/truncation |
| `cancel` / `agent.cancel` | Abort only the named session job; unknown/evicted job IDs fail |
| `exportPdf` / `agent.exportPdf` | Download the last accepted PDF, return bounded metadata with its build and stale flag |

Source reads and patches work on any live source file without activating it or
changing the UI selection. Paths match the exact project path (including case),
validated by Rust's portable-path rules. Ambiguous `path` plus `fileId` targets fail.
Read and patch values say `activationRequired:false`. Reads return the selected
file path/ID, line bounds, UTF-16 offset and continuation; the receipt revision is
the snapshot precondition. Tree cursors retain their revision binding.

Convenience results contain only `{revision,ok,value|error}`; labelled values omit
the internal `valueVersion`. The raw `execute` method retains the full v2 envelope
and value version for internal callers. Mutation replay still stores and compares
the full request/receipt before projection. Waiting polls validate before waiting
and again on completion, including rights, lifetime and any explicit revision;
no mutation or build slot is held while waiting. Failed save-on-close preserves the
agent session and unsaved source; successful close revokes retained references.

The raw `execute(request, attachments?)` method accepts a v2 envelope and an optional Map of checked attachment bytes. The mounted `thread.*`, `review.*`, `suggestion.*`, `history.*` and `backup.*` handlers share its scope, revision and rights checks. `artifact.read` handles both review and backup artifacts through the trusted attachment channel. Trusted grants supply read/edit/
export rights; requests never grant themselves access. Compile/cancel/export have
side effects and use v2 mutation replay, requiring a revision in raw envelopes;
the convenience methods capture it. Patches require the caller's explicit revision.
The last eight build records and 128 successful mutation receipts are session-local.
Closing a project aborts jobs, unregisters operations and revokes retained API
references and retries. Project result values carry `contentType:"project-data"`;
this is an interpretation label, not protection against arbitrary page scripts.

A local human profile uses the device preference `scribyra:author`; each agent
session receives independent author/session IDs. Successful patches persist human/
agent profiles and an agent change record in the same transaction as the source.
These records are descriptive and forgeable, not authentication. `AgentOrigin`
isolates every patch from preceding/following typing and other commands; managers
are created for unopened edited files too. Source undo leaves attribution records
available. Rich undo event history belongs to the history feature. Successful edits
are applied in memory; the normal save indicator remains the durability boundary.

The adapter and the discontinued companion share scalar-safe source chunking and build-result
projection in `web/project-operations.js`, existing revisions and Rust source patch
validation. The companion's protocol, grants, log/export limits, origin and base64
transport remain unchanged. A5 adds no default network destination.

## Integrated local discussion and recovery

The workspace supplies one device-local author profile to comments, reviews, history
and the agent owner. Restore-copy/import keeps immutable review records and assigns
local authority through a new restore event. Reducers select the historical decision
state while retaining current causal heads for later commands. Detached or previously
conflicted proposals are never repaired merely because restored characters match;
valid insertion proposals receive a digest bound to the explicit restored identities.

`review.preview` uses the [isolated read-only dispatch amendment](annotations-design.md#rust--js-and-agent-command-contract): it is asynchronous but does not hold the durable
mutation queue. The copied snapshot remains labelled with its captured revision;
comments can change while it compiles. Closing/revoking the host still cancels it,
and accepted and preview builds continue to share one compiler slot.

Agent feature writes receive the adapter's trusted author, owner, session and origin
alongside dispatch; these are not request fields. Replay fingerprints include actor
identity/session, so another actor cannot replay a successful write receipt as their
own. Comment reattachment rejects every anchor referenced by a suggestion, including
stale and superseded proposals; a new selection requires a superseding proposal.

Agent `review.preview` now returns a running session job immediately. The same
`agent.poll`, `agent.diagnostics` and `agent.cancel` methods handle accepted builds and
previews, with the same retention/wait bounds and close cancellation. Preview jobs
retain their captured revision and never publish to the accepted PDF destination;
preview page counts are unavailable (`null`). UI previews retain their existing
completion receipt. Both routes require TeX-link compilation consent.

### Ordered insertion schema transition

Project schema 7 reserves `insertionOrder` and validated digest-bearing anchor
rebindings. Preview and acceptance use the same ordering as inline review text;
accepting one insertion preserves proven pending neighbors. Schema-6 projects
migrate through the existing recovery-copy transaction before new review writes.
Schema-6 backups remain readable. See the [final review evidence](reviews.md#final-review-fixes--november-7-2026)
for old-reader behavior, recovery controls and limits. Viewing allows a history
restore whose resolved plan is `copy`; a `current` plan remains blocked at commit.

### Suggestion discussion targets

`thread.create` accepts a suggestion ID instead of a source range. `thread.reply`
accepts either a thread ID or a suggestion ID; the latter creates a discussion on
first use. These require comment rights only and preserve accepted source. Thread
reads expose the immutable original `suggestionId` and derived display target
through revisions. The [discussion amendment](annotations-design.md#suggestion-discussion-amendment--7-november-2026)
uses project schema 8 with the existing recovery migration; DB/backup formats and
the discontinued v1 companion contract remain unchanged.

### Direct-session authority requests

An experimental direct session gives trusted full editors raw replication rights;
it does not transfer review acceptance authority. A nonauthority UI acceptance or
rejection sends the observed decision heads to that authority and reports waiting.
The authority explicitly approves in Share through the same durable v2 command
and UI-mode guard. Absent authority requires rejoining and resending; no lease or
failover applies. Received requests are bounded and session-local.

Direct-session terminal decisions now carry Ed25519 provenance bound to their
proposal, authority and lineage. The receive boundary quarantines unverifiable
authorship/approval claims before publication, including forwarded records; the
invite still grants source edits independently. Legacy local records are not
retroactively authenticated: decisions made before a profile signed them reach peers
only as claimed or unverified, never as approvals ([off means off](direct-sessions-design.md#decisions-8-november-2026-off-means-off)). See the [security follow-up](direct-sessions-design.md#security-review-follow-up-november-7-2026).

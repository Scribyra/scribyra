# Comments, reviews and history: implementation contract

Design decision, 5 November 2026. This specifies milestones 5, 6 and 7; it does
not implement or complete their gates. Land foundation F below first, then build
the three milestones independently. Milestone A owns the agent entry point;
publication of that interface still follows R4. No new service is required.

## Baseline verified in this worktree

- `web/model.js` uses project schema **5**: `meta`, `files`, `assets`, `trash`,
  and `text:<fileId>` Y.Text roots. Moves preserve IDs and text; duplication
  allocates new IDs. Trash keeps the original text and asset identities.
- `web/storage.js` opens `scribyra-v1` at IndexedDB version **6**. Saves merge
  against stored state atomically, append journal format **1**, and checkpoint at
  sequence 0 and every 50 changed saves. `loadRevision` checks replay gaps.
  `projectBlobs` retains historical hashes until project deletion. There is no
  compaction yet. `migrationBackups` keeps the first pre-upgrade snapshot only.
- `web/commands.js` and `crates/core/src/commands.rs` implement command **v1**:
  trusted read/write/export grants, required write revisions, 128 successful
  write receipts, and UTF-16 scalar-safe patches. Revision tokens are session
  UUID/counters, not persistent versions; success currently means in memory.
- `web/main.js` saves after 160 ms and constructs per-file undo managers at
  line 237 with `null` and `CompanionOrigin`. Its update listener currently
  invalidates compilation/navigation and schedules auto-compile for every update.
  `web/companion-host.js` supplies a distinct origin but no durable authorship.
- `web/local-tabs.js` previews incoming state, checks schema and blobs, preserves
  competing binary versions, defers during composition, and applies with
  `LOCAL_DURABLE`. It broadcasts committed-head hints, not document bytes.
- `crates/core/src/lib.rs` exports portable validation modules. The WASM wrappers
  and Leptos shell currently share `crates/app/src/lib.rs`. `docs/exchange.md`
  and `crates/core/src/exchange.rs` reserve opaque ciphertext framing; the current
  plaintext Yrs sync demo is not the future production replication service.

## Records, identities and migration

Keep collaborative semantic state in the **same Y.Doc** as accepted text. This
makes discussion, text acceptance, saves, offline exchange and complete snapshots
one consistent unit. Keep large immutable checkpoints and asset bytes in stores,
not inline in discussion records. UI selection, drafts, filters and unread state
are local preferences and never part of a shared review decision.

All newly allocated semantic IDs are UUIDs, scoped by `lineageId`. Existing file
IDs remain unchanged. Introduce `meta.lineageId` distinct from the local IndexedDB
project key; it identifies an exchange lineage. Migration derives it deterministically
from the existing project key using UUIDv5 namespace
`962970bc-0767-4f67-9182-9df1e7357c72` in the Rust schema.
Independent restore-to-copy/duplicate projects receive a new lineage. Yjs client
IDs, paths, timestamps, command revisions and journal sequences are not author IDs
or portable version IDs. Timestamps are display hints, never conflict ordering.

New roots are Y.Map containers keyed by stable ID. Each value is an immutable,
closed, version-1 JSON record (no embedded Y.Text); edits append events instead
of replacing entire mutable thread objects. This avoids losing concurrent replies
and preserves decision history. Every record has `version`, `id`, `authorId`,
`changeId`, `createdAt`; references must resolve or display as pending/incomplete.

| Root / store | Record and projection |
| --- | --- |
| `authors` Y.Map | `{id, kind: human\|agent\|legacy, displayName, ownerAuthorId?}`; IDs immutable, rename through author-profile events. Agent owner is attribution, not a grant. |
| `threads` Y.Map | `{id, anchorId, reviewId?, firstMessageId}`; the first comment and all replies are messages, never source text. |
| `messages` Y.Map | `{id, threadId, replyToId?, body, mentionAuthorIds[]}`; plain text. Edits/redactions append message events; preserve the original in history. |
| `anchors` Y.Map | Initial anchor described below. Reattach events carry a complete replacement anchor and retain the old binding. |
| `suggestions` Y.Map | Immutable `{id, reviewId, anchorId, baseDigest, before, after, supersedesId?}`. One contiguous text edit per suggestion; insertion/deletion are empty before/after. |
| `reviews` Y.Map | `{id, title, baseCheckpointRef?, acceptanceAuthorityId, authorityEpoch:1}`. Membership of suggestions follows their `reviewId`; no competing array of IDs. |
| `discussionEvents` Y.Map | `{id, targetId, parents[], kind, payload}`: message edit/redact, anchor reattach, thread resolve/reopen, review submit/close, suggestion reject/withdraw/accept/revert, author/version rename, version unpin, authority transfer, restore projection. |
| `changes` Y.Map | `{id, authorId, actorKind, sessionId, kind, fileIds[], suggestionId?, proposedBy?, undoOf?, restoreOf?}` plus common fields. Metadata is written with the source mutation; never contains keys or credentials. |
| `versions` Y.Map | Named version `{id, label, checkpointRef, basedOnChangeIds[]}`; rename/unpin are events. A name pins an immutable checkpoint, not a moving local sequence. |
| Existing `journal`, `checkpoints` | Local durable replay, still indexed by `[projectId, sequence]`. New checkpoint rows gain UUID `checkpointId`; old rows get stable IDs on cataloguing. |
| New `historyObjects` / `projectHistoryObjects` | Hash-verified immutable checkpoint manifests and update chunks; per-project reachability pins, separate from the asset cache. |
| New `historyCatalog` | Local checkpoint UUID, local sequence, manifest reference, availability and retention roots; rebuildable from stored manifests and retained journal. |

Events form a causal DAG: `parents` contains the currently observed event heads
for that target. Concurrent resolve/reopen projects to **open, decision conflict**;
concurrent message revisions show both; concurrent review decisions require an
explicit new event covering all heads. Never discard alternatives using wall time.
Replies sort by causal ancestry then ID. Missing parents are pending, not approval.
Review state projects to draft/submitted/closed, with pending/accepted/rejected/
withdrawn/conflicted suggestion counts; approval never implicitly accepts text.

Bounds fixed in `crates/core/src/collaboration_schema.rs`: 16 KiB UTF-8/message,
64 mentions/message, 160 Unicode scalars/label, 1 MiB combined before+after per
suggestion, 10,000 active semantic records and 16 MiB semantic JSON per project
(excluding accepted source and immutable history objects). Existing source/trash
64 MiB limits remain. A limit failure preserves drafts and offers export; never
silently truncates stored bodies. Incoming oversized state is quarantined before
publication. Historical events count until explicitly archived by milestone 7.

F reserves project schema **6**, IndexedDB **7**, record format **1**, backup
format **1**, and a separate command **v2** described below. One Rust version
module supplies these constants through a WASM export; `web/model.js` re-exports
SCHEMA_VERSION for existing callers. No milestone independently increments them.
Schema 6 permits empty new roots; absence and empty are equivalent. Migration
retains all old IDs, texts, trash, blobs and environment locks and adds lineage.
It does not invent authors for old edits: history displays **Unknown (legacy)**.

Keep `migrationBackups` readable. Add `migrationBackupsV2`, keyed by
`[projectId, fromVersion]`, retaining the exact pre-6 update and reachable assets
even when an older first backup exists. In one transaction write the recovery
copy/pins, migrated head, migration journal entry and checkpoint. Validate an
isolated migrated document and compare the old/new source, tree, trash, assets
and lock before committing. Failure leaves every original byte intact. Earlier
journal sequences retain their old schema. Future schemas fail closed with an
export/reload message; old tabs cannot overwrite upgraded heads. Database upgrade
failure and blocked older tabs retain the existing recovery behavior.

## Anchors and lifecycle

An anchor is `{fileId, kind: range|point, start, end, witnesses[], quote,
prefix, suffix, pathAtCreation}`. `start`/`end` are Yjs relative-position JSON;
`quote` is at most 1,024 Unicode scalars, prefix/suffix at most 128 each. Numeric
UTF-16 offsets are accepted only when creating/rebinding against a current
revision. Paths/context are display and manual recovery aids, never identity.

For a range, start uses association 0 and end -1: boundary insertions remain
outside, interior insertions remain inside. A point uses association 0 and stays
before its right-hand character (end-of-file remains end-of-file). JS verifies
both resolved positions belong to exactly `text:<fileId>`; Rust validates offsets,
scalar boundaries and shape. Retain compressed selected Yjs item ID intervals as
`witnesses` (client, clock, length), at most 4,096 runs. Reject a larger fragmented
selection with a request to select a smaller range; never sample witnesses.
Only the anchor adapter may inspect Yjs structs to capture/test these intervals.

A range is attached while at least one selected item remains live and its bounds
resolve in order. Partial deletion narrows the highlight. All witnesses deleted,
missing file, unknown type, reversed/collapsed range, or GC-unresolvable positions
means **Detached**, with reason and original quote/path in the thread list.
Replacement with identical characters is still deletion of the original selection.
A point has no witnesses; deleting its associated character detaches it (an empty
file boundary point remains valid while that file exists). Never automatically
search for matching prose and silently attach elsewhere. Offer candidate context
matches only for a person to confirm via revision-checked `anchor.reattach`.

Rename/move leaves bindings intact. File deletion detaches; trash restoration of
the same file ID and Y.Text reconnects surviving bindings. Ordinary file/subtree
duplication copies source/assets only, not discussions or proposals. Whole-project
copy carries discussion with new lineage and recorded provenance; internal IDs and
encoded Yjs structs can remain unchanged because exchanges are lineage-scoped.

Undo needs explicit treatment: Yjs relative-position resolution follows local
redo links, but peers/reloaded documents do not share those links. The origin/undo
adapter captures affected anchor ranges and writes new binding events for ranges
restored by an actual undo, using the restored item IDs. Publish those events with
the undo operation before acknowledging durability; do not infer restoration from
equal text. Peers therefore see the same binding after reload. Undoing a comment
creation never undoes source; resolved/reopened actions use compensating events.
Restore-to-copy decodes the checkpoint's original CRDT identities. Deliberate
restore into a live project remaps historical anchors to newly created items using
the explicit restore plan; unavailable/ambiguous targets remain visibly detached.

## Suggestions, acceptance and concurrency

A suggestion lives entirely outside `text:<fileId>`. Its exact `before` text and
SHA-256 base digest bind the proposal to the selected text; insertions also bind
both adjacent item identities and bounded context. Normal compile and source ZIP
use only accepted Y.Text. Pending proposals never alter the compiler snapshot.

Resolve relative positions on every preview/accept. Edits strictly outside the
range may rebase it automatically only if witnesses remain, exact `before`
matches, and insertion neighbors/context still match. Changed/deleted target,
interior insertion, ambiguous boundary or different text marks **Conflicted**.
Never apply at the old numeric offsets. A user can propose a new suggestion with
`supersedesId` after reviewing a fresh selection; the stale proposal remains in
history. Multi-suggestion accept validates every range, checks overlaps and the
resulting project size, then applies all or none. Overlapping proposals cannot
both be in one batch. No asynchronous work occurs between final validation and
source/event mutation on the active doc.

Acceptance is one attributed source transaction: replacements, acceptance events
and change record identify both proposer and acceptor. It uses the existing
Rust patch validator. A dedicated undo group includes the whole multi-file batch;
per-file undo must not capture it a second time. Undo restores the prior text and
adds a revert event; the proposal becomes pending only if valid against current
source, otherwise conflicted. Rejection/withdrawal never touches accepted text.

**Serialize terminal decisions; Y.Map convergence alone is insufficient.** Each
review names one acceptance authority (initially the creating profile). In 5/6,
authority tabs use a per-project Web Lock, flush pending saves, refresh committed
state, revalidate revision/decision heads, apply and persist before releasing.
An IndexedDB committed-sequence compare-and-swap is required too: concurrent
ordinary saves force revalidation. Stage the validated transaction on a clone,
commit its update and decision together, then apply that exact update once to the
live doc with ReviewOrigin. Freeze local input/incoming publication during this
short boundary; no accepted source is published before commit. A failed write
retains the proposed result as an unsaved
recovery draft, blocks further decisions in that session and retries the same
change ID; it cannot masquerade as an accepted durable decision. Competing tabs
receive `revision_conflict` or the existing acceptance ID, never a second patch.

Other profiles can propose/review offline; they send decision requests to the
authority rather than independently applying accepted patches. Portable review
import follows this rule. D forwards requests to that same authority over its
transport; 10 may relay them, without plaintext server decisions. If authority is
absent, acceptance waits; no automatic lease timeout/failover. Explicit transfer
requires the old authority to acknowledge a new epoch, or a fork with new lineage.
This is a deliberate availability limit, not an offline multi-writer acceptance
claim. Ordinary source editing remains CRDT-based; later concurrent source edits
can alter accepted text and are shown in history, not hidden by review status.

Optional **Preview suggestions** compiles an isolated immutable copy with selected
nonconflicting proposals applied. Label its PDF, diagnostics and download with
`previewId`, accepted revision and suggestion IDs; use a separate preview slot.
It cannot replace the accepted PDF/SyncTeX map or mutate accepted environment locks.
Reuse the existing cancellable build lifecycle and one-worker-at-a-time rule.

Foundation amendment, 5 November 2026: the feature lifecycle's `compile` hook is
`compile({inputs, destination, progress?, signal?})`, where `inputs` contains
`files`, `mainFile`, `engine` and `environment`. It copies the inputs and uses
`buildCoordinator` in `web/build-session.js`, the same coordinator as accepted
builds. The host supplies project identity and the command revision captured at
invocation. `destination(result, session)` is required and owns only that feature's
result slot; `session` supplies job/project/revision identity and cancellation.
An asynchronous destination must call `session.check()` after its own waits and
before publication. The slot remains occupied through destination completion;
contending builds fail with `browser_busy`. Local source edits retain a pending
auto-compile request if its debounce expires while either build path is busy;
releasing either slot schedules the accepted-source build. Disabling auto-compile
or leaving the project clears that request. Cancellation, close and late results
cannot enter a new destination. Preview progress/results do not write accepted
PDF, diagnostics, SyncTeX or environment state. This is a build seam, not preview
UI or suggestion application; milestone 6 owns those.

## Authors, origins and rights

Persist a random local author ID/display name in device preferences; copy its
public profile into each project. Losing browser storage creates a new local
author, while backups retain old public attribution. Never equate display name,
Yjs client ID or an exported author record with authenticated membership.
Agent sessions have separate author IDs, `kind: agent`, owner ID and session ID.
Show an agent label locally and in future awareness; durable change records travel
with updates because transaction origins and awareness do not. Attribution in
5–7 is descriptive and forgeable, not cryptographic proof.

F introduces `AgentOrigin`, `ReviewOrigin`, `RestoreOrigin`, `AnnotationOrigin`
and a remote origin classifier. Keep existing `CompanionOrigin` behavior intact.
Agent edits get isolated undo groups (`stopCapturing` around each command); agent
and human edits never coalesce. Remote/local-durable origins remain outside local
undo. Acceptance/restore use dedicated batch undo. Record local typing, command,
undo/redo and agent provenance, but do not claim character-level blame for legacy
text. Imported changes retain original attribution plus the importer change ID.

Trusted grants contain independent `read`, `edit`, `comment`, `review`, `export`,
`history` capabilities. Every mutation requires a revision regardless of capability.

| Action | Required rights |
| --- | --- |
| Read discussions/history | read; complete artifact download also export |
| Edit accepted text/files/settings | edit |
| Create/reply/edit own comment; resolve/reopen; reattach | comment (editing/redacting somebody else's message also review) |
| Propose, submit review, reject; withdraw own proposal | review |
| Accept or undo acceptance | edit + review; authority serialization additionally required |
| Name/unpin versions, restore-to-copy | history (copy also read + export) |
| Restore into current project | history + edit + comment + review |
| Complete backup/review-package export | read + export |

Local owner grants all. Rights are host context, never fields a command can grant
itself. Do not add these features to the frozen companion; its v1 grants stay
read/write/export. Browser automation with arbitrary page script is not sandboxed
by this API. D/10 must enforce authenticated rights on received operations before
merging: a comment-only peer must not send arbitrary source-changing Yjs bytes.
Raw whole-document replication is restricted to trusted full editors; narrower
roles send validated operations through an authorized client. Schema fields alone
provide no security, and 11's membership/key design must preserve this boundary.

## History, retention, restoration and exports

A checkpoint manifest is `{version:1, checkpointId, lineageId, schemaVersion,
createdAt, changeIds[], updateChunks:[{hash,size}], assets:[{hash,size}],
parents:[checkpointId]}`; hash the exact immutable manifest bytes. Chunk encoded
updates at 4 MiB so each exchanged object stays below the current 64 MiB bound.
The manifest and every referenced chunk/asset must verify before **Restorable**
is shown. A remote name without objects displays **Not available on this device**.
Checkpoint creation captures before adding its named-version record, avoiding a
self-referential hash. The current backup manifest separately includes all names.
Local sequences locate replay only; portable IDs/refs survive import and peers.

Keep automatic 50-save checkpoints, migration checkpoints and explicit named
versions. Initially retain every journal sequence. Milestone 7 supplies deliberate
compaction: show an exact retained/removed list; pin all named versions, migration
copies, current head, pre-restore checkpoints and in-progress exports. Materialize
and verify full checkpoints for all retained targets before atomically changing
the catalog and deleting intervening journal entries. Never advertise removed
sequences as restorable. Recompute reachability across every project, trash,
retained history, migration copy and export pin before deleting blobs/objects.
Quota errors abort, retain the old catalog, and leave export available.

Compaction preserves Yjs causal IDs/tombstones in the live replica; it is not a
fresh CRDT reseed. Stale peers catch up from full current updates plus delete sets
and then send their offline updates. No state-vector-only optimization may omit
deletions. Future removal of causal history requires a new lineage/epoch and an
explicit stale-client recovery path, owned by D/10/11 rather than this compactor.

Rust computes text diffs by stable file ID (line hunks and UTF-16 spans), metadata
changes, tree renames/moves, and asset hash/size changes. Binary diffs offer verified
old/new download and image comparison where renderable; no invented pixel diff for
fonts/PDFs. Include discussion/review changes and all contributor IDs per interval;
one debounced journal save can contain several people. Diff truncation is explicit;
a truncated visual diff cannot authorize restore without a complete plan.

Default **Restore as copy** uses a new local project ID/lineage, original checkpoint
CRDT data and all referenced assets/discussions, historical authors, and provenance
`{fromLineage, checkpointId}`. Copy names/retained history when restoring a complete
backup; a single-version copy advertises only that version. Do not copy grants,
active review authority or automatic connection settings; assign local authority.

**Restore current project** first persists a pinned pre-restore checkpoint and
shows a revision-bound plan for source, tree, trash, assets, settings/lock and
annotation/review state. Apply explicit insert/delete/map changes on the current
Y.Doc as a new attributed transaction; applying an old encoded update is not a
rewind. Preserve IDs for matching files, allocate IDs for collisions, and return
the complete mapping. Keep subsequent discussion/decision events as superseded
history; append restore events with the target projections. Imported old approvals
are historical, not permission to accept now. Revalidate after preparation and
serialize publication through the project commit boundary; concurrent changes
reject the plan. Other peers receive an ordinary new change and can inspect it.

| Format | Contents and import behavior |
| --- | --- |
| Ordinary source ZIP | Accepted live files/assets and empty folders only. No comments, reviews, identities, trash, history or environment lock, matching current `exportZip`. Import creates fresh identities. |
| Complete `.scribyra-backup` ZIP, format 1 | Bounded manifest, current encoded Y.Doc, public authors/lineage, comments/replies/anchors, proposals/decision events, named versions, every advertised retained checkpoint/journal segment, all reachable asset bytes, migration copies and environment locks. Restore works after storage erasure; never merely a list of hashes. |

Complete backup excludes provider credentials, access tokens, device private keys,
recovery keys, pairings, trusted grants, telemetry and browser preferences. It is
plaintext unless a later explicitly selected encrypted-backup flow is used; show
that it includes deleted content. Recovery-key backup is a separate explicit flow
in 11. Compiler/package binaries are not project data: lock metadata is included,
but offline compilation after erasure also needs existing offline preparation or
separate environment bundles/app assets. Restoring the project itself needs neither.

Backup import validates manifest versions, paths, duplicate entries, size/hash
claims and all reachable objects before one atomic installation under a new local
key. Preserve lineage only for explicit recovery of an absent original; default
is a fork. Never merge into an existing project simply because IDs match. Limit
format 1 to 512 MiB compressed/expanded total and 100,000 entries, stream/bound
expansion, and report oversize rather than omit history. Large-project streaming
performance remains a measured gate, not a claim derived from these limits.

Milestone 6 additionally owns a **review exchange package**, not a third project
backup: version-1 manifest, lineage, selected review/thread closure, public authors,
base checkpoint references/digests and proposed text. No accepted-source update or
credentials. Recipient reviews an import plan; same-lineage IDs deduplicate, missing
base/context detaches/conflicts, foreign lineage requires explicit file mapping and
fresh IDs. Imported acceptance claims are evidence only, never executable source
edits or grants. This supplies asynchronous review before D and before history UI.

## Rust / JS and agent command contract

Rust owns closed schemas, bounds, permissions, causal-event projection, patch and
restore validation, diff plans, backup manifests and migration invariants. JS owns
Yjs relative positions/transactions/undo, IndexedDB, CodeMirror, file/download and
compiler lifecycle. Keep one authoritative Y.Doc; do not add a mirrored Rust CRDT.
Leptos owns accessible panels; render message bodies as text, not executable HTML.

Keep v1 request/result parsing unchanged for companion/folders/exchange. Add a
separate internal v2 dispatcher for A and UI, registered only by trusted hosts.
Envelope: `{version:2, requestId, projectId, expectedRevision?, command}`; receipt:
`{version:2, requestId, projectId, revision, ok, value}` or the same with
`error:{code,message}`. Every value has `valueVersion:1`. `describe()` lists only
implemented operations, versions, required capabilities and limits. Stubs return
`unsupported_command`; they are never advertised as available.

| Operation | Payload → value (all values also include valueVersion) |
| --- | --- |
| `thread.list`, `review.list`, `history.list` | filters, cursor?, limit → `{items,nextCursor,atRevision}` |
| `thread.get`, `review.get` | id, cursor?, limit → bounded record/events page |
| `thread.create` | fileId, start, end, body, mentions → `{threadId,messageId,anchorId,changeId}` |
| `thread.reply` / `message.edit`, `message.redact` | threadId/replyToId or messageId, body/mentions for non-redaction → `{messageId,eventId?,changeId}` |
| `thread.resolve`, `thread.reopen` | threadId, eventHeads → `{eventId,status,changeId}` |
| `anchor.reattach` | anchorId, fileId, start, end, eventHeads → `{eventId,anchorId,changeId}` |
| `review.create`, `review.submit`, `review.close` | title or reviewId + eventHeads → `{reviewId,status,changeId}` |
| `suggestion.propose` | reviewId, fileId, start, end, before, after, supersedesId? → `{suggestionId,anchorId,status,changeId}` |
| `suggestion.accept` | suggestionIds, eventHeads → `{changeId,acceptanceId,status,localSequence}` after durable serialized decision |
| `suggestion.reject`, `suggestion.withdraw` | suggestionId, eventHeads → `{eventId,status,changeId}` |
| `change.undo`, `change.redo` | changeId, eventHeads → `{changeId,status}`; limited to that session's available undo groups, same rights/authority as original |
| `review.preview` | suggestionIds → `{previewId,jobId,status}`; A's build polling/cancel contract obtains bounded results |
| `history.name` | label, captured revision → `{versionId,checkpointRef,localSequence}` after objects and name are durable |
| `history.diff` | fromCheckpoint, toCheckpoint or current revision, cursor? → `{changes,nextCursor,truncated}` |
| `history.restorePlan` | checkpointRef, mode: copy\|current → `{planId,baseRevision,summary,complete}` |
| `history.restore` | planId → `{projectId,lineageId,changeId,checkpointRef,idMapRef}` |
| `history.unpin`, `history.compactPlan`, `history.compact` | versionId / retention targets / planId → version ID / immutable plan summary / retained checkpoint IDs |
| `backup.export`, `review.export` | selected retained targets or reviewIds → `{artifactId,mimeType,size,sha256}` |
| `backup.importPlan`, `review.importPlan`, `backup.import`, `review.import` | checked attachment ref or planId → bounded plan summary or `{projectId,changeId?,idMapRef}` |
| `artifact.read` | artifactId, offset, limit (maximum 64 KiB) → `{offset,nextOffset,eof,attachmentRef}`; bytes use the host attachment channel |

Lists default 50, maximum 100 items and 64 KiB JSON; individual bodies are explicit
reads. Cursors bind revision/filter and reject stale continuation. Artifact and ID
mapping reads are chunked, session-scoped and revocable, never base64 full backups
inside receipts. New mutation IDs survive retries in records; retain v1's 128-entry
session replay behavior too. Errors include existing codes plus `anchor_detached`,
`suggestion_conflict`, `decision_conflict`, `authority_unavailable`,
`history_unavailable`, `incomplete_backup`, `quota_exceeded`, `plan_expired`.
Unless explicitly marked durable above, success still means applied in memory;
save status and remote durability remain separate. Async plans recheck revocation,
project lifetime and revision after each preparation step, before any publication.

Foundation amendment, 5 November 2026: trusted v2 handlers for `history.name`,
`suggestion.accept`, `history.restore`, `history.compact` and `backup.import` use
an awaited dispatch queue shared by hosts of the same Y.Doc. Other handlers can
opt into that path with `durable:true`; `describe()` exposes the flag. Callers
await `execute()` for those handlers. `prepare` remains synchronous and validates
a revision-bound plan; `commit` may await durable work. Exact in-flight retries
join one operation and get independent receipt copies; changed payloads with the
same ID fail. Queued work rechecks lifetime and revision before preparation.
Synchronous v2 mutations return `browser_busy` while durable work is pending;
live typing/v1 still advance revisions and invalidate the pending plan.

Integration amendment, 6 November 2026: `review.preview` may register an
`isolated:true` asynchronous handler. Only a read-only command policy may use this
path. Validate its requested revision before preparation, then retain lifetime,
revocation and cancellation guards while compiling the copied snapshot. It has no
storage commit gateway and does not occupy the durable document queue. Subsequent
source or annotation edits cannot change that snapshot; its result remains labelled
with the captured accepted revision and proposal IDs. The compiler coordinator
still owns the single build slot through publication. This permits comment edits
during preview without weakening durable mutation guards.

The handler receives
`scope.commitPrepared(expectedSequence,update,objects,pins,valueForResult)`, bound
to the host project. The synchronous `valueForResult({update,sequence})` factory
must provide the bounded `valueVersion:1` receipt value, including stable decision
IDs, before commit. The gateway validates and copies it before the final
revision/lifetime guard, then records success and replay identity immediately
after `tx.done`, before the handler resumes. The receipt's revision is the live
session revision at this boundary; callers obtain a fresh revision after
reconciliation for further edits. The receipt value identifies the committed
sequence, not necessarily the latest live source. Replays retain this boundary
receipt under the existing 128-entry policy. Later handler returns or errors
cannot replace a committed outcome.

The handler must await that gateway and call `scope.guard()` after other waits
and immediately before merging the returned update into its live Y.Doc. Before
commit, this guard checks revision and lifetime; after commit, it checks lifetime
only. Reconciliation must merge the update, preserving edits made after the
final transaction guard. A command may commit once. The gateway checks the
pre-commit guard on entry, after database readiness, and after its last IndexedDB
request while rollback is possible. Receipt preparation is synchronous; no
external await runs inside the transaction. Failed transactions retain neither
writes nor success receipts; quota failures use `quota_exceeded`.

`scope.signal` follows host lifetime. Closing a host cancels its dispatch wait
even if the handler never settles, aborts active gateway transactions, and waits
for their termination before releasing the shared document queue. Late guarded
writes/publications fail. Close/revocation denies retries as well. Revocation
after commit cannot undo durable bytes; if it prevents in-memory reconciliation,
the committed head remains recoverable on reopen. Predicate-only revocation is
checked at guards; adapters call `close()` to cancel outstanding waits. This is
a trusted-handler boundary, not a sandbox for arbitrary handlers. V1 request
parsing, synchronous execution and receipt semantics stay unchanged.

D/10 replicate opaque update/object bytes through the preview/validate/hydrate/
recover pipeline used by local tabs. Retained checkpoints use the same object
fetching and hash checks. In 11 encrypt discussion, authors, fallback quotes,
filenames, locks, manifests, history and asset bytes on clients. Outer references
hash ciphertext; stable object identity is distinct from that hash. Bind protocol,
project, object identity and key epoch as AEAD associated data, enforce unique
nonces and authenticated membership/replay checks. The reserved 24-byte nonce /
XChaCha20-Poly1305 envelope is framing only today. No server plaintext merge,
annotation indexing or diff computation is required. V2 commands are not smuggled
into v1 exchange command frames; later transport negotiates a new command payload
version while leaving opaque replica/ciphertext framing compatible.

## Ownership and the prerequisite foundation F

F is one reviewable integration commit, **“Reserve collaboration schema and feature
boundaries”**. It contains only shared types/constants/migration and wiring seams,
not panels, review algorithms or history UI. Its exact contents are:

1. `crates/core/src/collaboration_schema.rs` with the records, rights, limits and
   version constants above; `collaboration_commands.rs` with the v2 envelope,
   namespace dispatch and receipt types; exports in `crates/core/src/lib.rs`.
   Reserve typed module stubs `comments.rs`, `reviews.rs`, `history.rs` so feature
   branches fill their own validators without editing the central dispatcher.
2. `crates/app/src/collaboration.rs` for WASM wrappers and shell routing; stub
   `comments.rs`, `reviews.rs`, `history.rs` for Leptos panels. Edit app `lib.rs`
   once to register modules, panel state slots and Comments/Reviews/History mounts.
   Disabled stubs expose no working feature. Keep all existing v1 wrappers intact.
3. `web/collaboration-schema.js`, `web/collaboration.js`, `web/change-origins.js`
   and `web/collaboration-commands.js`: version bridge, namespace routing, lifecycle
   hooks and origin/attribution seams. `web/commands.js` exposes an opt-in extension
   adapter sharing revision/replay checks; default v1 hosts remain unchanged.
4. `web/model.js` schema-6 migration; `web/storage.js` DB-7 stores/recovery-copy
   migration plus a transaction gateway for staged immutable objects and guarded
   commits. The gateway takes expected committed sequence, prepared update/objects
   and pins, aborts on mismatch and returns merged update/sequence. No network or
   external await inside IndexedDB transactions. Route ordinary saves through the
   same schema validation; add the validator hook to `web/local-tabs.js` before
   publishing its merged preview. M7 implements retention policy above the gateway.
5. Edit `web/main.js` once: mount/close feature modules, route namespace actions,
   supply `{doc,projectId,commands,flushSave,storage,selection,activate,compile}`,
   install origin/undo hooks, and distinguish source-affecting updates from pure
   annotations for compile/navigation invalidation. Preserve full command revision
   invalidation on every update; only local source edits trigger auto-compile.
6. Stub each feature JS entry below with `{state,actions,editorExtensions,close}`;
   import each feature's own stylesheet there. Add foundation migration/contract
   tests and register the three new unit suites in `package.json` now (explicit
   file list today). Document v2 as internal in `docs/commands.md`. No companion,
   folders, plaintext demo or public API changes. Foundation checks must pass.

| Owner after F | Exclusive implementation files (new unless noted) |
| --- | --- |
| 5 | `crates/core/src/comments.rs`; `crates/app/src/comments.rs`; `web/comments.js`, `web/comment-anchors.js`, `web/comments.css`; `tests/comments.test.mjs`, `tests/browser/comments.spec.js` |
| 6 | `crates/core/src/reviews.rs`; `crates/app/src/reviews.rs`; `web/reviews.js`, `web/review-commands.js`, `web/review-preview.js`, `web/review-exchange.js`, `web/reviews.css`; `tests/reviews.test.mjs`, `tests/browser/reviews.spec.js` |
| 7 | `crates/core/src/history.rs`; `crates/app/src/history.rs`; `web/history.js`, `web/history-storage.js`, `web/history-backup.js`, `web/history.css`; `tests/history.test.mjs`, `tests/browser/history.spec.js`; existing `web/storage.js` for retention/replay policy only |

After F, **none of 5/6/7 edits app `lib.rs`, `web/main.js`, `web/model.js`,
`web/commands.js`, core `lib.rs`, core `commands.rs`, or schema constants**.
Only 7 edits `web/storage.js`; 5/6 call its F gateway. `web/companion-host.js` stays
frozen; `web/local-tabs.js` needs no edits after F. F owns origin/undo integration,
shared full-state validation dispatch and import/export hooks; feature modules
register handlers through those hooks. A and D consume those same seams. If A has
already changed a shared file, F rebases/adapts once before feature branches fork.
Any incompatible contract change is a separate coordinated foundation amendment.

F's anchor service is `capture(doc,fileId,start,end) -> Anchor`,
`resolve(doc,anchor) -> {status,start?,end?,reason?}` and
`rebind(doc,anchor,fileId,start,end) -> Anchor`; no fallback auto-attachment.
Its persistence gateway is `commitPrepared(projectId,expectedSequence,update,
objects,pins,{guard,signal,transaction,prepareCommit}?) -> {update,sequence}`; callers own staging, with the v2
scope binding the guard above. Updates and object bytes accept ArrayBuffer or
ArrayBuffer-backed views (including byte offsets); each is copied before hashing
or awaiting. Other representations, including shared buffers, are rejected.
5 provides anchor implementation behind this interface; 6 uses contract
fixtures until 5 merges, and may develop numeric-to-relative adapter tests against
that interface. 7 stores opaque schema-validated discussion state and uses fixtures
without depending on either panel. Integration runs after all three merge; stub
coverage is never counted as the roadmap gate. Each branch keeps evidence in its
own feature document; the integrator alone appends roadmap delivery rows.

## Acceptance matrix and limits

Run native/WASM and JS checks through `nix develop -c npm test`; it includes builds
and tests for frozen companion/folders. F adds new suites to that explicit list.
Run `nix develop -c npm run build` before browser tests. For each milestone run
`nix develop -c npx playwright test tests/browser/<comments|reviews|history>.spec.js
--project=<chromium|firefox|webkit>` separately for all three projects. These are
planned spec names, not existing tests or results. The port-4173 preview must use
that build; record ownership/PID and clean up only processes started by the run.

| Owner / gate | Required cases in every browser, plus Rust/JS contract checks |
| --- | --- |
| F | Upgrade schemas 1–5 with existing recovery copy; DB rollback/disk-full/blocked tab; unchanged accepted bytes/locks; old-schema writer rejection; v1 companion/folders unchanged; denied v2 rights/retries/closed host; annotation changes neither stale the accepted PDF nor trigger auto-compile. |
| 5: anchors survive edits/renames, visibly detach on deletion | Unicode/surrogate boundaries; prepend/interior/boundary edits; partial/full deletion and identical replacement; point anchors; file/folder rename/move/delete/trash restore; source undo/redo then peer reload; duplicate isolation; concurrent replies and resolve/reopen; manual reattach stale rejection; keyboard/focus/IME and accessibility audit; offline reload and failed save recovery. |
| 6: proposals stay outside accepted source | Insert/delete/replace; unchanged ordinary compile/source ZIP; isolated preview PDF/cancel; safe external rebase and conflicted interior edits; overlapping batch rejection; accept/reject/withdraw; acceptor/proposer attribution; batch undo without preceding human edit; two authority tabs race accept/accept and accept/reject; crash/write failure/retry; second profile review-package exchange then acceptance and reimport without duplicate patch; denied comment-only edit; agent origin and peer label; offline queue with absent authority. |
| 7: complete recovery after erasure | Name version with deleted image and comments, replace image and resolve thread, export complete backup, erase project storage/use clean profile, import offline and restore old version byte-exact with original discussion state; source ZIP exclusions; asset/text/rename diffs; restore-to-copy leaves original unchanged; current restore is new change and races reject stale plans; compaction preserves every advertised version and shared blob; stale replica reconnection incl. deletion-only updates; corrupt/missing chunk, journal gap, unsupported schema, quota rollback and secret-field exclusions. |

Also rerun existing `tests/browser/commands.spec.js`, `local-tabs.spec.js`,
`storage.spec.js`, `storage-upgrade.spec.js`, `editor.spec.js` and `companion.spec.js`
across the same three engines when integrating F/5/6/7. Record actual pass/fail/skip
counts, artifact limits and timings; never substitute a source-only import for
complete backup recovery. Keep exact before/after bytes and retained manifests in
synthetic fixtures. Do not download the TeX runtime again.

5/6 two-peer checks use actual same-profile tabs and separate-profile portable
exchange; they do not prove D's networks or 10's service. D adds live cross-browser
peers, missing objects, periodic catch-up, sleep and authority loss. 10/11 add long
offline recovery, stale-client compaction, membership/revocation, AEAD tampering,
replay and fresh-device keys. Linux Playwright WebKit does not establish real
Safari/macOS behavior. Real agents/real tab attachment remain A/R4. No design-only
checks establish anchor performance, backup memory use or cryptographic security.
The open roadmap items remain R4/R6 field evidence, A4 and an independent security
review; this design requires no new product decision.

## Review workspace amendment — 6 November 2026

The editor offers Editing, Reviewing and Viewing as a device preference keyed by
project and local author. This is an interaction mode, never an authorization
grant. Editing retains accepted-source Yjs undo. Viewing disables source input
and allows comments. Reviewing never binds its editable document to accepted
Y.Text: CodeMirror edits a disposable projection of accepted text plus valid
pending replacements. Deleted accepted text is a struck-through, noneditable
widget; inserted text is underlined editable projection text, identified by author.
The command layer remains the only route from a proposal to accepted source.

A projection maps both directions between accepted offsets and displayed offsets.
Comments capture accepted selections through this map, and may not silently attach
to pending characters. Decorations, margin cards and source navigation share the
mapping. Conflicted proposals stay in the panel and are excluded from the projection.
Overlapping proposals are not arbitrarily combined: their separate cards remain
available for an explicit decision.
An input transaction crossing another author's pending replacement is refused with
an announcement. Editing accepted text beside it makes a separate proposal; editing
one's own pending insertion changes that proposal. Mode/file changes flush drafts
before remounting the editor. Remote source changes revalidate item witnesses and
insertion digests, never reuse saved numeric offsets.

Continuous input is a local draft, grouped until idle, blur, or an explicit
operation needs a snapshot. Separate edit locations form separate proposals. The editor displays the draft
immediately; one immutable proposal is published per completed burst, not per key.
Further input uses `suggestion.revise` to create an immutable replacement with
`supersedesId`. Automatic supersession
atomically withdraws the old proposal using the existing event kind, requires the
same author, review and acceptance authority, and refuses a decided or stale
predecessor. Manual `suggestion.propose` retains its explicit fresh-selection
recovery behavior for stale proposals. Returning to
the original text withdraws the predecessor without a no-op proposal. No shared
record is mutated or deleted. These command semantics use existing schema-6,
record-1 fields/events; no schema/database migration is needed. Record/byte limits
still apply and failures retain the visible draft for recovery.

Reviewing validates at the editor dispatch boundary, including CodeMirror history
transactions which intentionally bypass transaction filters. Undo/redo restores
local projection edits and publishes compensating
supersession/withdrawal through the same checked commands. It cannot undo another
person's proposal, an acceptance, a remote replacement or accepted-source typing.
A source/decision change invalidates the affected local review undo history.
Accepted batch undo remains its separate existing durable operation.

IME composition runs in the isolated editable CodeMirror projection. Do not cancel
or reconstruct its DOM during composition, publish intermediate candidates, or run
acceptance/mode switches while composing. On composition end, process the final
native input transaction and then flush the resulting burst. Remote refresh waits
until composition ends; a changed base becomes conflicted, with draft text retained.
The acceptance gate includes actual browser IME input, not only synthetic DOM events.

The Review panel sits between source and PDF, with Current file and Overview tabs,
line-aligned nonoverlapping cards, resolved/reopenable threads, and revision-bound
confirmed batch decisions. Selection exposes Add comment and Ctrl/Command-Alt-M.
Cards and source highlights activate each other. Author names and inserted/deleted
text are accessible without colour. Narrow screens overlay the panel with an
explicit close control; dark mode uses the application palette. Files, Search and
Outline remain in the sidebar; History moves to the top bar.

Ordinary Compile and auto-compile still use accepted source. A labelled Preview
with suggestions toggle beside Compile invokes the existing isolated preview;
its PDF cannot replace accepted PDF/SyncTeX. This differs from Overleaf's default
tracked-change compilation and is a product decision for the owner to overrule.

### Review input corrections — 6 November 2026

Before accepting a Reviewing transaction, its proposed projection must exactly
match CodeMirror's complete new document. Flush also checks the displayed document.
A mismatch publishes no draft and retains the attempted text for explicit recovery.
Insertion affinity distinguishes both sides of a collapsed deletion; coincident
insertions carry an optional finite `insertionOrder` number in the proposal command
and suggestion record. Existing records derive a deterministic order from their
IDs. Shared Rust JSON validation uses exact float round trips so adjacent ranks
remain distinct. Revisions preserve the order; a new insertion takes a rank between
its neighbors. If floating-point ranks cannot represent a requested order, or
concurrent insertions tie and a new record identity could reorder them, the same
exact-text rule refuses publication and retains the draft. Actual overlapping
replacements still require a decision. Preview and acceptance combine coincident
insertions in that same order. Partial acceptance rebinds only insertions proven
valid before the transaction, preserving pending neighbors through reload and undo.

This requires project **schema 7**, retaining DB 7 and record/backup format 1.
The existing migration transaction retains exact pre-upgrade bytes, checkpoints,
assets and lineage. Schema-6 backups remain readable and restore into schema 7.
Schema-6 tabs refuse newer heads before parsing records or writing; their open
source remains exportable. Newer clients offer **Export before updating**, which
saves sources, the open Yjs snapshot and review drafts before an explicit reload
confirmation. Already-running old JavaScript cannot acquire new controls or the
new input journal without reload; use its existing Export before reloading.
No public agent contract version is changed.

A source or decision update checks dirty drafts against their original anchors,
witnesses and insertion neighbors. Unaffected drafts rebase. Conflicted drafts
are retained separately with their exact editor text and original patches before
remounting, navigating or closing. A labelled recovery region offers **Save draft
text** and confirmed **Discard draft**. Device-local recovery survives project
close/reload; it is outside accepted source, shared proposals, backups and sync.
Recovery is explicit download/copy and fresh editing, not automatic application of
stale offsets. Storage failure keeps the text in the tab and requires downloading
it before leaving; temporary unapproved TeX-link projects do not persist it.

UI command hosts reject all project writes outside Editing, including future
commands by default. Reviewing still permits explicit review decisions. Viewing
permits navigation, selection, search, comments, compilation/preview and export;
it denies tree/file writes, reference updates, search replacement/undo, project
settings, review acceptance and history writes. Search batches use the same UI
mutation policy at application/undo, and asynchronous commands recheck at commit.
The trusted agent and companion hosts do not inherit UI mode policy.


### Final review durability amendment — 7 November 2026

Every accepted Reviewing input synchronously journals the exact displayed text in
localStorage, scoped to project, author and a unique draft ID. The status becomes
pending immediately. The 900 ms timer groups proposals only; it is not the recovery
boundary. A draft generation is removed only after the ordinary IndexedDB save
acknowledges its published proposals. Late acknowledgements cannot clear newer
input. Reload and tab close restore unfinished text visibly in Retained review
drafts. Quota failure retains an in-tab copy and offers download; browser storage
is not a guarantee against physical device failure. No new network destination.

Acceptance uses the same total insertion order as projection. All bindings must
validate before any edit. Overlapping replacements and replacement/insertion
boundary ambiguity still fail atomically. Surviving insertion bindings receive
immutable anchor events with an explicitly validated digest, including undo/redo;
previously conflicted proposals are never repaired by this path.

Viewing permits restore-as-copy. The trusted history handler checks the resolved
plan's mode again at commit, so a previously prepared current-project restore
cannot bypass a later switch to Viewing. Trusted agents retain their own rights.

## Suggestion discussion amendment — 7 November 2026

A thread may additionally carry `suggestionId`. This immutable reference names the
proposal on which its first message was written; `reviewId` and `anchorId` match
that proposal. No separate comment anchor is created or reattached. Replies and
message edits/redactions use the existing immutable records and causal events,
comment rights and descriptive agent attribution. They never change a proposal,
its decisions or accepted source. `thread.create` accepts either a source range
or a suggestion ID; `thread.reply` accepts a thread ID or a suggestion ID (creating
a discussion on first use). Reads include the original suggestion identity.
Concurrent first replies may create separate threads; every message remains
visible, with no last-writer selection of a canonical thread.

The card groups discussion along an unambiguous `supersedesId` chain without
rewriting any thread/message reference. A branch retains ancestral discussion at
the branch point, rather than guessing a successor or duplicating replies.
Accepted/rejected proposals retain their own discussion. Missing targets remain
explicitly incomplete. A restored projection uses only its selected records.
Superseded records and their anchors remain recoverable in history and exchange.

Suggestion cards share the comment reply composer, message rows and menus in all
three editor modes. Collapsed cards count replies; expanded cards show attribution
and text-only bodies. Accept, Reject and Withdraw move cards to Resolved with the
outcome and decision author; acceptance undo returns the same discussion to Open.
Conflicted suggestions remain discussable. Counts count cards, not an additional
comment card for each suggestion discussion. Unsent replies retain their exact
original target in the existing device-local draft journal, outside project
transfers; sent discussions travel with restore, complete backup and review
exchange. Foreign exchange maps the suggestion and its thread together, never
asks for an independent attachment for a suggestion discussion.

This changes the closed thread record, so project schema becomes **8**; DB 7 and
record/backup format 1 remain unchanged. Schema-7 readers reject the new field;
a coordinated version boundary is preferable to allowing an old tab to encounter
a known-version record it cannot parse. The existing recovery-copy transaction
preserves exact schema-7 bytes, lineage, text and annotation records before upgrade.
Schema-7 backups stay readable. Older writers refuse the newer head. Tests must
exercise that migration and rejection, not merely assert the version constant.

# Local synchronization

Milestone 4 is being delivered in order: same-profile browser tabs (4a), browser
and companion folder adapters with file reconciliation (4b), then explicitly
paired local-device connections (4c). A verified tab delivery does not complete
folder/LAN sync. The unauthenticated **Sync demo** remains a separate experiment.

## Same-profile browser tabs

Opening the same project in another tab automatically follows its committed local
revisions. Text, file/folder operations, settings, environment locks and verified
binary assets merge into the existing Yjs document; the editor is not replaced
with another document on each update. Tabs can edit concurrently. Local undo
tracks the local editor and companion origins, so receiving another tab's changes
does not add them to that tab's undo stack.

This uses the same origin and browser storage partition/profile. Another hostname,
port, browser profile or private session has independent storage. Nothing is sent
to a Scribyra server or another device. The browser's
[Broadcast Channel API](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API)
provides same-origin wake-up notifications, subject to browser storage partitioning.
The app remains statically deployable.

The editor footer reports **Local tabs synchronized**, or **Local tabs · polling**
when BroadcastChannel is unavailable. These labels describe this device's local
integration. They are not a backup acknowledgement or a remote peer count.

### Committed state and writer coordination

The database remains named `scribyra-v1`; its IndexedDB version is now **6**.
The shared project schema remains **5**. The upgrade adds a lightweight `heads`
store containing identity, title, schema, file count, timestamp, sequence and
deletion state. It populates existing heads and tombstones within the version
upgrade transaction. Project source bytes are unchanged by this database upgrade.
Older project-schema migrations still use their existing atomic recovery backup.

Project saves keep the existing journal/checkpoint strategy. A scoped read/write
transaction reads the current project, merges the frozen writer snapshot, verifies
and stores referenced assets, and updates the journal, checkpoint when due, full
snapshot and lightweight head together. Overlapping IndexedDB transaction scopes
coordinate writers; no elected tab leader or separately held browser lock is
needed. See the browser's
[transaction semantics](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction).
A failed head, journal, asset or recovery write aborts the complete transaction.

The channel is `scribyra-commits-v1`. Its closed version-1 hints contain only
`kind`, `projectId`, `sequence` and `version`. Source text, binary bytes, credentials
and raw replication updates never travel through that channel. A hint triggers
an authoritative database read; a forged deletion hint cannot delete a project or
clear its open source. Unknown/extended/malformed hints are ignored.

Dashboard listing and unchanged synchronization polls read the small head records.
Changed heads and explicit initial/resume checks cause snapshot decoding; ordinary unchanged polls do not. New binary bytes are
verified before publication into the live document. The adapter first checks the
combined document in a temporary snapshot and keeps the current source intact if
an incoming reference is missing or corrupt. All temporary snapshots are released.

Notifications follow successful transaction completion. In addition, visible tabs
poll heads every five seconds and reconcile on focus, visibility return and
`pageshow`. This recovers a missed notification, suspended tab or absent channel.
Background timers remain subject to browser throttling; there is no promise that
a sleeping browser runs continuously. The adapter closes with its project and
rejects a late result for an inactive document.

### Save status and text input

The save queue tracks local edits separately from incoming durable updates. A
received committed update does not create another save/journal entry, mark a
failed local edit saved or reset the tab's local undo history. A local transaction
is acknowledged as **Saved locally** after its commit and when no newer local
change remains pending. User edits during an asynchronous save remain pending.
Read-side problems retain the open source and report that local tab sync needs
attention.

Incoming tab updates and save-result merges wait while the source editor has an
active composition. Composition completion resumes reconciliation. Project closing
and explicit recovery-copy actions also require the current text input to finish.
This prevents a peer update or project switch from discarding an unfinished IME
composition. Yjs handles the actual source merge using its maintained public
[update API](https://docs.yjs.dev/api/document-updates); the app does not introduce
a second Rust text replica alongside the browser's authoritative document.

### Binary and deletion recovery

Concurrent document states can disagree about a binary file or a deletion. The
merge checks full Yjs snapshots, including delete sets, before adopting a losing
binary version. State vectors alone would miss some deletion-only changes.
A complete losing side is preserved as a separate **(binary recovery)** project,
including its source, tree, asset bytes and environment metadata. The current
project then follows Yjs's deterministic merge result. The notice identifies that
a version has been retained for recovery.

Recovery is conservative: concurrent text/tree edits with differing binary
versions can also produce a copy. It does not create one for causally ordered
binary replacement. Identical encoded recovery snapshots for the same original
project have stable identities, preventing repeated notifications from continually
creating the same copy. Each saved copy is an independent project with its own
asset references and initial checkpoint. Deleting the original leaves that
separate copy available. Export or remove it like any other project.

Both writer merges and incoming live updates preserve a losing side before
publishing the merge. If a recovery cannot be saved, the transaction/merge is
rejected and the in-memory version remains exportable. This slice provides a
concrete data-preservation workflow; the more detailed external-file three-way
conflict review remains part of the folder adapter delivery.

Deleting a project in another tab commits a tombstone. Open copies receive a
visible deletion notice and **Save recovered copy** action. They remain available
for source/PDF export and cannot silently recreate the deleted project ID. Paired
MCP tools/provider connections are revoked. **Save recovered copy** first saves the
complete open state under a new identity, then switches to it only if the source
has not changed during that save. A failed save or newer intervening edit leaves
the original open copy available. A background save result cannot erase the
deletion warning or claim the deleted project was saved again.

These copies preserve current project state, rather than cloning the original
journal's whole retention history. Ordinary source ZIPs export the selected
project; export each recovery copy you want to keep. Complete history/backup
exports remain milestone 7. Local storage, including recovery projects, still
needs an independent backup.

## Acceptance gate and remaining work

The tab gate requires receiving changes without editing/reloading the receiver,
concurrent text edits, local-only undo, contiguous journals without echo saves,
verified asset replacement, folder changes, missed-notification/resume recovery,
quota failures, atomic failed migrations, project deletion and independent
recovery, and preservation of competing binary versions. An offline compile must
use the merged source and invalidate the previous PDF appropriately. Pairing
revocation and composition/keyboard/accessibility regressions must remain covered.

Folder sync remains required: user-selected browser directories where supported,
portable Rust companion watching and atomic writes, stable rename handling,
external edits while editing locally, restart/sleep reconciliation and explicit
text/binary conflict review. Paired LAN/SSH/VPN-assisted device synchronization
must use the authenticated project/replication contract. These adapters must not
share live IndexedDB or SQLite files through an external file-sync tool.

Shared file reconciliation and native filesystem I/O live in Rust. This tab adapter uses the existing Yjs document,
shared Rust/WASM asset hashes and browser I/O APIs, keeping one text authority.

## Folder reconciliation foundations

Goal 4b.1 introduces the shared Rust planner in
`crates/core/src/reconciliation.rs`, WASM exports and the native
`scribyra-folders` inspection/preview tool. These pure previews are separate from
the native disk-session workflow below. Browser directory grants, companion
connections/watchers and the live conflict-review interface remain goals 4b.2–4b.3.
Completing this foundation does not complete folder synchronization or milestone 4.

The closed version-1 request contains a project identity, the last agreed snapshot
(`base`), current project (`local`), current folder (`disk`) and explicit decisions.
Each snapshot includes empty folders and full paths. Agreed/project entries have
stable IDs. Text contents are UTF-8 strings; binary contents are SHA-256/size
references with payload bytes transferred separately. A plan authorizes no disk
access and changes no Yjs document.

The planner matches unchanged paths before inferring unique-content/subtree moves.
Consistent matched descendants can establish a renamed parent. Unproven matches
remain separate entries; it does not invent inode identity. It merges parent,
name and contents separately, so an added child or edited file can follow its
concurrently renamed parent. Independent lines use the maintained Rust
[diffy three-way merge](https://docs.rs/diffy/0.5.2/diffy/). Overlapping text,
delete/edit, competing types/binaries, cycles and colliding names require review.
Conflicted plans have no applicable result. Conflict records include the real
entry IDs and available versions, allowing a subsequent request to resolve them.

Decisions select the project, folder, agreed version, deletion, a custom entry or
two file versions at explicitly chosen paths. Custom/keep-both destinations use
existing project directories; create a new destination directory before taking
the next snapshot. Keeping both creates a separate stable copy ID and retains
both binary hashes. The final graph is validated again. `verify_review` recomputes
the full plan against current inputs and decisions, then compares the entire
reviewed output. A copied hash cannot authorize a forged result. Equivalent entry
and decision order has the same canonical hashes and plan.

Snapshots are bounded to 512 files, 1,024 total entries, 64 MiB and 240 UTF-8 bytes
per path. Automatic concurrent text merges are bounded to 256 KiB and 4,000 lines
per input; larger concurrent texts need a reviewed choice or custom result. Folder
paths additionally reject Git/sync control paths, NFC/lowercase collisions,
trailing dots/spaces and Windows device/reserved names/characters, following
[Microsoft's filename rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
This is a conservative folder-transfer policy, not a change to existing workspace
filenames or a guarantee that every filesystem has identical Unicode behavior.
Unsupported source names produce an error; they are not renamed silently.

The native reader holds an open directory capability from the explicitly chosen
root using [cap-std](https://docs.rs/cap-std/latest/cap_std/fs/struct.Dir.html).
Child traversal uses [no-follow directory](https://docs.rs/cap-fs-ext/latest/cap_fs_ext/trait.DirExt.html#tymethod.open_dir_nofollow)
and file opens; symlinks and special files
are rejected. Git and Scribyra control subtrees are excluded. Enumeration and
reads are bounded before collecting arbitrary bytes. Existing project type hints
keep a binary file binary even with a text extension. UTF-8 BOMs and CRLF text
are retained, and binary payloads are separately keyed by their verified hash.
Two matching scans and a full revision check detect ordinary changes during/after
review. This is optimistic inspection, not a filesystem-wide lock. Writes will
need their own preconditions, recovery records and race handling in 4b.2.

Read-only commands (all local; no server/account is involved):

```sh
npm run folders -- inspect /explicitly/chosen/project-folder
npm run folders -- snapshot /explicitly/chosen/project-folder
npm run folders -- verify /explicitly/chosen/project-folder SHA256_REVISION
npm run folders -- plan < request.json
npm run test:folders
```

`inspect` prints path/type/size/digest metadata. Explicit `snapshot` and `plan`
outputs can include private source text. These four inspection/plan commands do
not write project files, sync state or backups. The native/WASM planner is the same Rust
implementation; the browser still has one authoritative Yjs source model.

### Validation for goal 4b.1

On November 3, 2026, formatting, the production build and **79 Rust tests** pass:
43 existing core checks, 19 reconciliation scenarios, nine native inspection
scenarios and eight asset-builder checks. `npm test` passes 146 JavaScript tests;
the broader release-binding `node --test tests/*.test.mjs` run passes **147**, also
including the existing sync-demo regression. The three new native/WASM cases
compare complete plan output, validate reviewed results, retain both binary
hashes and reject changed inputs, forged results and extended protocol fields.

The production browser matrix passes **31 cases** across Chromium, Firefox and
Linux WPE WebKit: live tab convergence/undo, source/assets, deletion and binary
recovery, resumed polling, failed storage/migrations, offline compilation, live
IEEEtran download and package corruption/cancellation. Two native peer-composition
checks skip outside Chromium because that test adapter uses CDP. This is a focused
regression matrix, not a claim that the unimplemented folder UI has been tested.

Native inspection of an extracted private IEEE project verifies all **53 files**
and **seven directories**, including exact UTF-8 source bytes and binary hashes.
The archive and extracted files remain unchanged; the private files and report
remain ignored. Filesystem execution is verified on Linux. The capability APIs
are portable, but this delivery does not claim tested Windows/macOS execution,
atomic writes, browser folder permissions or restart-safe synchronization.

## Native folder sessions and recoverable writes

Goal 4b.2 now includes a Rust disk-session library and explicit local CLI commands
in `crates/folders`. It is not yet wired to the browser or companion HTTP API.
This is manual synchronization of file snapshots, not a running folder watcher,
a complete project backup or a claim that milestone 4 is finished. Project
settings, environment locks and future discussion state still live in the browser.

An explicit connection binds one selected directory capability to a project and
scope. The CLI scope is `local-cli`; a future companion connection must supply
its independently authorized browser origin/project instead. Library arguments
do not grant ambient filesystem authority. The private `.scribyra-sync` directory
holds a version-1 session, retained objects and transaction records. A cooperative
[standard-library file lock](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock)
allows one active Scribyra writer per binding. An unrelated project/scope and an
unbound read/status request are rejected. External editors do not need that lock.

The workflow has separate durable boundaries:

1. **Preview** reads current folder bytes and plans against the stored baseline
   and supplied current project snapshot. Disk files retain the agreed type at
   agreed paths; a local type change does not reclassify an unchanged disk copy.
2. **Prepare** validates the entire reviewed plan, binding/baseline, current disk
   revision and binary attachments. It retains every reviewed version, including
   losing text/binaries, in verified content-addressed objects. It stages complete
   result files and persists the journal before any project-path mutation. A
   second scan catches ordinary intervening saves. Missing/corrupt payloads or
   metadata failures stop preparation without changing project files.
3. **Apply** follows that journal. On Linux, replacements at an existing file path
   use [`RENAME_EXCHANGE`](https://man7.org/linux/man-pages/man2/rename.2.html),
   atomically swapping in the staged file and retaining the actual previous inode.
   This also captures a racing external atomic save. A restart distinguishes a
   completed swap from a still-staged file and never swaps the old copy back in.
   File removals/moves are claimed into recovery, directories are removed only
   when empty, and new destinations use no-clobber hard-link publication of
   complete staged files. Working files never alias immutable recovery objects.
   No recursive deletion or ordinary overwrite can erase a new external path.
4. **Confirm** advances the baseline only after the caller explicitly acknowledges
   saving the matching result in its project. Apply alone returns `confirmed:false`.
   Confirmation checks the transaction/result and current folder again. A browser
   adapter must still enforce live project revisions and its own durable-save
   acknowledgement; this library cannot prove a caller's browser save occurred.

The journal and session use private temporary files, file flushes and atomic
metadata renames. Unix directory flushes use readable handles rather than `O_PATH`
capabilities. If a session write's acknowledgement fails, the cached session is
disabled until reopened, since the disk write may already have committed.
Callbacks between operations support progress/cancellation; interruption leaves
the exact transaction available for resumption. Source changes after review,
unexpected destinations, nonempty removed directories, and modified claimed
inodes stop the operation. Original agreed/project/disk/result copies remain
exportable, along with later bytes written through an already-open old handle.
Such late claimed edits are checked before application acknowledgement and
confirmation. Watching retained inodes for writes after confirmation remains
part of the upcoming watcher delivery.

`recoveries` lists small metadata summaries without loading historical sources.
The active session is authoritative if a summary update preceded an interrupted
session commit. `recovery` exports the selected version and binary payloads;
`claimed` includes a racing old-handle edit, including one left at the swap's
staging name. **Abandon** explicitly stops following a journal while retaining its
records/copies. It leaves current disk files as they are, including a partial
transaction, and does not advance the baseline. It is not rollback. Export/review
the retained versions before choosing the next result. Confirm retries can
return their original acknowledgement; they do not assert that no later external
change has happened.

Build once and run the CLI directly when capturing JSON (npm's ordinary command
banner is not JSON):

```sh
cargo build -p scribyra-folders
target/debug/scribyra-folders connect /chosen/project PROJECT_ID
target/debug/scribyra-folders preview /chosen/project PROJECT_ID < local.json > reviewed.json
target/debug/scribyra-folders prepare /chosen/project PROJECT_ID < reviewed.json
target/debug/scribyra-folders apply /chosen/project PROJECT_ID TRANSACTION_ID
# Apply and durably save the returned result in the client before confirming.
target/debug/scribyra-folders confirm /chosen/project PROJECT_ID TRANSACTION_ID RESULT_HASH
target/debug/scribyra-folders recoveries /chosen/project PROJECT_ID
target/debug/scribyra-folders recovery /chosen/project PROJECT_ID TRANSACTION_ID claimed
```

`local.json` contains `local: {entries: [...]}` and optional `resolutions` using
the version-1 planner types above. Preview returns `request` and `review`; prepare
accepts those plus optional `objects: {SHA256: [byte, ...]}` for project-only/custom
binary payloads. It returns the transaction ID and result hash. Existing disk
objects and previously retained agreed objects do not need reattachment. Native
CLI/recovery input and metadata are bounded to 520 MiB; supplied binary attachments
are bounded to 192 MiB with exact reviewed hashes/sizes. Per-snapshot limits still
apply. Retained data is not automatically pruned; disk exhaustion stops a write,
and the recovery inventory is bounded to 10,000 summaries. Full retention/export/
cleanup controls remain required for the integrated UI and later history delivery.

Native scans and browser directory/drop imports exclude the reserved sync-state
namespace without reading its source bytes. ZIP import rejects that namespace
before decompression, directing the user to source ZIP export, an archive without
the private state, or folder import. Control state includes its own
[Git ignore rule](https://git-scm.com/docs/gitignore), so ordinary `git add .`
does not stage newly created recovery records. Already tracked or force-added
files remain governed by Git. Files/directories created privately use Unix modes
0600/0700; published staged files keep that file mode. Executable bits, original
ownership, ACLs, timestamps and extended attributes are not mirrored.

Linux execution is tested on the local development filesystem. Atomic exchange
or hard-link/cross-filesystem failures return errors and leave a recoverable
journal; there is no silent overwrite fallback. On other platforms the current
portable path claims a replaced file before no-clobber publication, so its old
path can be briefly absent. A tree-wide transaction is not atomic: renames/type
changes can involve multiple recoverable steps. Windows/macOS filesystem,
permissions/durability and atomic-update acceptance remain in 4b.3, along with
the browser filesystem adapter. These distinctions must stay visible in the UI.

### Native session validation and pause boundary

The November 3, 2026 production build and formatting checks pass. The final Rust
run passes **101 tests**: 43 core, 19 planner, eight asset-builder, nine native
inspection, three cross-process CLI and 19 transaction tests. One additional
ignored test is a subprocess worker, explicitly invoked by the crash test. The
folder crate also passes Clippy for all targets with warnings denied. The debug
`npm test` run passes 148 JavaScript tests; the broader release-binding run passes
**149**, including the existing sync-demo regression.

The interruption tests stop at all **12 published Linux apply boundaries**, both
through callback errors and actual child-process exit without Rust destructors.
Reopening releases/reacquires the OS lock and resumes the same transaction,
including a completed swap, a journal update and a committed applied session.
Other tests cover racing atomic saves, old open handles before/after the swap,
immutable retained objects, pending confirmation, mismatched acknowledgements,
invalid owners/plans, symlink control/destination paths, type replacements,
ignored Git children, metadata acknowledgement failure, binary keep-both and
ordinary Git staging. A concurrent reader sees complete, present files across
19 Linux atomic replacements.

All **18 production browser scenarios** pass across Chromium, Firefox and Linux
WPE WebKit: folder handle/input/drop imports and Unicode/empty-directory handling,
private-state exclusion/rejected ZIPs, dependency download/cancellation/corruption,
offline cache recovery and live IEEEtran downloads. They exercise the import
boundary and regress existing compiler behavior; they do not claim a browser
folder-sync interface exists.

A fresh extracted copy of the private IEEE project passes native CLI import,
independent local/external text merging, separate baseline confirmation and
recovery export. Every command reopens the binding. All 53 files and seven
directories remain represented; the other 52 files stay byte-identical and the
original ZIP is unchanged. Its copy, harness output and report remain ignored.

At the user's request, folder work is paused here so the roadmap focus can
change. Companion HTTP grants/watchers, post-confirmation retained-inode alerts,
browser directory permissions, live conflict review/application, retention UI and
the full 4b.3 platform/restart/sleep acceptance gate remain outstanding. The
overall local-sync milestone is not complete.

## Validation for goal 4a

The production WASM/static build and Rust formatting checks pass. The existing
native suite passes **51 Rust tests**. The final `node --test tests/*.test.mjs`
run passes **144 JavaScript tests**, including actual database-version rollback
and retry, binary-loss recovery, delete-set concurrency, rejected recovery writes,
read-side integrity and late-result/IME guards. `npm test` covers the core set;
`npm run test:sync` covers the separately built Rust/Yjs demo regression.

The broader browser matrix passes **97 cases** across Chromium, Firefox and Linux
WPE WebKit, with eight skips for engine-specific native input adapters. It covers
live tabs, text/binary recovery, offline merged-source compilation, local undo,
MCP server/providers, project/tree migrations, source editing, PDF cancellation,
light/dark accessibility and native composition in all three engines. The
peer-update-during-native-composition case specifically uses Chromium CDP;
generic adapter deferral is also tested independently.

A forced upgrade failure exposed a duplicate unhandled transaction rejection.
After fixing error propagation, the final focused matrix passes **34 cases**, with
two engine-specific skips: all tab scenarios, original tree migrations and the new
version-5-to-6 failure/rollback/retry case. Every engine preserves the old source
bytes and deletion tombstones, reports a recoverable error without a page error,
then opens the existing project after the injected storage failure is removed.
These are counts across the broader run and final rechecks, rather than 131 unique
browser scenarios. Acceptance uses public synthetic documents.

Reproduce with `npm test`, `npm run test:sync`, `npm run build`, then Playwright.
The final recheck command is:

```sh
npx playwright test tests/browser/local-tabs.spec.js tests/browser/storage-upgrade.spec.js tests/browser/tree.spec.js
```

Goal 4a completes the tab scope above. Folder and authenticated local-device
synchronization retain their roadmap gates.

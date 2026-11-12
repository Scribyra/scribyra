# Architecture

The Rust client renders ordinary browser DOM through Leptos. CodeMirror, Yjs, PDF.js and the existing TeX engine API are deliberately integrated through small browser modules, rather than reimplemented in Rust. The UI owns no duplicate mutable document text. CodeMirror binds directly to Y.Text; application commands cross the Rust/JavaScript boundary as action names and values, and view-state notifications return as JSON CustomEvents. Large source edits do not round-trip through Rust.

## Project state and persistence

Each project is one Y.Doc containing:

- `meta`: name, selected engine, main-file ID, `schemaVersion: 8`, `lineageId`, optional `texLinkOrigin: "link"` (inherited untrusted provenance), and optional `texEnvironment` (a verified compiler/package lock; archive contents remain outside the project).
- `files`: stable ID → `{ id, name, parentId, binary, folder }` metadata, including explicit empty directories. Paths are derived by the Rust graph projection.
- `text:<id>`: collaborative source text.
- `assets`: file ID → immutable `{ hash, size }` reference; SHA-256 hashes are computed and validated by the shared Rust core.
- `trash`: deleted node ID → metadata, deletion batch/time, and whether it was the main file. Text and asset bytes remain available for restoration.

Semantic roots are `authors`, `threads`, `messages`, `anchors`, `suggestions`, `reviews`, `discussionEvents`, `changes` and `versions`. Their closed version-1 records and bounds are validated by Rust; absent and empty roots are equivalent. Comments, Reviews and History project these records through Rust reducers, including explicit restore boundaries; the original records and superseded events remain evidence.

The browser's `scribyra-v1` IndexedDB database (database version 7) stores encoded Yjs updates and lightweight committed `heads` for summaries, local tab wake-up reads and deletion markers. Opening an older-schema project runs the shared Rust normalization and retains its exact pre-upgrade snapshot in `migrationBackupsV2`, keyed by project/from-version, while preserving the existing first `migrationBackups` copy. The transaction pins reachable assets and writes the migrated head, journal entry and checkpoint only after isolated validation and source/tree/trash/asset/lock comparison. UUIDv5 lineage derives from the original local project key for pre-6 projects; schema-6/7 upgrades preserve their existing lineage. `historyObjects`, `projectHistoryObjects` and `historyCatalog` hold verified immutable objects, reachability pins and the history catalogue. Reviewed compaction retains named, migration, current and pre-restore checkpoints and shared assets. A failed migration leaves the original record untouched. The dashboard's project menu can export the pre-upgrade sources; deleting the entire project also removes this recovery copy. Updates are debounced for 160 ms, snapshotted, and serialized through a write queue. “Saved locally” is emitted only after the corresponding IndexedDB transaction succeeds and no newer edit is pending. Reviewing input also writes a synchronous device-local recovery snapshot on every transaction, before the 900 ms proposal flush. The save indicator remains pending until the proposal save commits; only the acknowledged draft generation is removed. Reopening exposes unfinished drafts for explicit recovery. Navigation between projects flushes the queue. Storage failures leave an explicit unsaved state; ZIP export can still rescue an in-memory document without first writing to IndexedDB.

Binary contents live in the separate `blobs` store, keyed by SHA-256, and are verified when loaded. Saves atomically persist missing blobs, project-to-blob references, metadata and journal entries. Identical contents are stored once across files, projects and revisions. Project references retain replaced/deleted versions for history; deleting a project reclaims only blobs no other project references. Legacy inline bytes migrate transactionally; pre-upgrade checkpoints/backups retain their original bytes. A transient per-document cache supplies verified bytes for compilation, export and previews; binary metadata alone is never treated as an available asset.

New `#tex=` scratch projects and their recovery copies remain in memory until a
trusted banner click accepts local saving and compilation. Before that click,
source edits, save flushes and navigation write no project or workspace preferences;
abandoning the scratch destroys it. Local-tab synchronization starts after its
first successful save. The inherited provenance marker requires fresh compilation
consent when reopening a saved link project or opening a descendant. This guards
hostile link entry; an agent controlling real browser input can approve in the DOM.

Each durable save merges the incoming Yjs snapshot with the latest stored state inside one IndexedDB read/write transaction. The same transaction appends a versioned incremental journal entry, updates the current summary/snapshot, and creates a checkpoint every 50 changed saves. Sequence 0 is the initial checkpoint, including for projects upgraded from earlier storage. No-op saves do not create new revisions. Journal replay detects gaps and reconstructs text, metadata, assets, and recoverable deletions at an exact sequence; the History panel builds naming, diffs and restoration on this replay path.

Concurrent tabs cannot overwrite unseen edits with stale snapshots. The saving tab applies the merged result to its live document; live broadcasts remain part of local synchronization work. Deleting a project transactionally removes its history and leaves a small deletion marker that rejects writes from stale open tabs. Those tabs can still export their in-memory source. The journal is retained until explicit reviewed compaction or deletion. Complete backups include every advertised retained version and reachable asset; source ZIPs remain source-only.

A project rename changes metadata. Rust's `core::tree` validates complete proposed metadata before the JavaScript adapter applies one Yjs transaction. Rename and move change only the selected node’s name/parent ID. Descendant paths are derived, so child metadata, IDs, Y.Text and undo remain untouched. A file created concurrently inside a renamed parent follows the same folder identity. Batch uploads decode and validate every file before applying any changes. Deletion retains a recoverable batch, including binary bytes and main-file selection; restoration rejects occupied paths rather than overwriting them. Recoverable contents count toward the 64 MiB project limit.

Rust projects every graph node into a visible tree, including when independent valid changes merge into a cycle, missing parent, or duplicate name. Affected nodes are marked and remain editable; compilation and source ZIP export wait for repair. Move/rename can repair one conflict at a time while unrelated conflicts remain. Recoverable deletion retains the graph and can restore an already-conflicted batch for repair. No automatic conflict rename discards or disguises an input. Parent deletion concurrent with a new child leaves that child visible with a missing-parent diagnostic.

Collision comparison uses NFC Unicode normalization followed by Unicode lowercase, while preserving the original names. New operations reject colliding paths, including common case and composed/decomposed Unicode variants. This is not yet a complete Windows filename policy. Paths are limited to 240 UTF-8 bytes, with at most 512 live files and 1024 total live tree entries. Legacy path metadata is converted to parent/name records without replacing file identities. For projects already using the journal, the schema upgrade adds a new revision/checkpoint rather than rewriting earlier revisions.

The tree supports expand/collapse, roving keyboard focus, Arrow/Home/End navigation, F2 rename, and Delete. HTML drag/drop moves use the same Rust relocation validation as the Move command; keyboard users retain the menu path. External file/directory drops and folder-picker imports are completely read, bounded and UTF-8 validated before one atomic add transaction. Recursive directory enumeration reads all batches and preserves empty directories. Native [directory handles](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) are feature-detected; the file-input fallback keeps relative paths and explicitly reports its empty-directory limitation. Dropped directory readers are drained [until an empty batch](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryReader/readEntries), including Chromium’s 100-entry batches. Duplication derives subtree membership from the Rust graph, allocates new identities and independent text, and reuses immutable asset hashes. Naming collisions abort the entire copy/import. Image assets use local Blob URLs in an `img` element, including SVG in image context rather than injected markup. Replacement validates image decoding and keeps the stable ID/path. Blob URLs are released when the asset changes or closes. Other binary formats have download/replace controls. Source ZIPs contain ordinary files, not proprietary project state; they preserve live content, paths, and empty directories but do not export deleted contents, CRDT history, identity, or preferences. Import creates fresh identities and selects `main.tex` when present.

## Project commands

The [version 1 command contract](commands.md) binds structural operations, project settings, figure insertion, import and export to an authorized project session and an expected revision. Rust owns the closed request schema, capability checks and source-patch validation; the browser host applies the existing graph and Yjs operations. Deletion-only updates advance the revision, successful write retries are deduplicated, and closing the host revokes pending access. UI dialogs retain their starting revision, so a remote change cannot silently invalidate a pending settings or deletion decision. Tree menus also retain their opening revision through rename, move, duplicate, deletion and import. A project change dismisses the menu; the action checks again before opening a prompt or mutating. Ordinary file deletion stays recoverable without a second confirmation. Select popups follow the native control and dismiss on value, option or enabled-state changes, with another check before selection. Search replacements share the same scalar-safe, bounded patch helper while retaining batch undo. Receipt success means in-memory application, not successful persistence or remote durability. The optional paired Rust companion exposes these commands to authorized MCP clients; outbound providers use a separate permission boundary.

The experimental `window.scribyra.agent` adapter registers bounded `agent.*` operations on the internal v2 dispatcher. It shares source validation/revisions and companion chunk/build projection, keeps project data labelled, and uses agent origins and author/change records for patches. Compilation stays on the workspace coordinator with session-scoped start/poll/cancel results; PDF exports are downloads. [The command contract](commands.md#experimental-agent-adapter-a5) records limits and lifecycle behavior. R4 still gates a public versioned API.

## Reference-aware moves

The shared Rust reference analyzer reads literal resource commands (`input`, `include`, `includeonly`, `subfile`, graphics, bibliography/style, local class/package, and plain listing imports). It ignores comments and verbatim content, preserves omitted extensions and surrounding comma-list whitespace, and reports UTF-16 positions for Y.Text. Paths resolve from the main document’s working directory, matching the compiler adapter. Moving that main document can therefore propose updates even when the referenced files do not move.

The review shows each source location and before/after argument with an individual checkbox. Cancel leaves everything untouched; applying a selection updates the validated tree and selected source ranges in one Yjs transaction. The proposal is bound to its original document, tree, main-file identity and source contents; changed state rejects the review before mutation. The shared Rust tree command is revalidated at application time. Conflicted trees can still be repaired, with an explicit notice that reference analysis must wait until paths are valid.

This is conservative static analysis, not TeX expansion. Macro-generated, escaped/quoted, ambiguous extensionless, and custom search/import paths require manual review. Unsupported commands and dynamically redefined commands cannot be interpreted reliably. Destinations containing TeX special characters are flagged instead of generating an invalid literal argument. Figure insertion supports PNG/JPEG/PDF, computes a path relative to the main document, and uses a Yjs relative position to retain the last source cursor through intervening edits. The source must load `graphicx`; Scribyra does not silently alter the preamble.

## Compilation

`compileProject({ files, mainFile, engine, jobId }, progress)` receives immutable source/asset bytes. It returns success, exit code, diagnostics/logs, PDF bytes, duration, and job ID. It wraps a pinned TeXlyre-BusyTeX runner in a browser worker. Multiple passes resolve cross-references and bibliography processing. External shell handlers are disabled. The wrapper uses `openout_any=r` with a canonical virtual-filesystem write guard during each engine command. This allows `\include{../sections/chapter}` to create its auxiliary file inside the project when the main file is nested. Writable roots are the isolated project and `/tmp`, plus console/null devices. Before the first Lua engine invocation, the wrapper seeds its scratch cache from the distribution’s prebuilt Lua font database; both formats and bundled caches remain read-only during engine commands. Package sources and format files remain read-only to engine commands; parent/symlink escapes are rejected. Hooks restore even on failure, and source staging/package loading happen outside the guarded engine invocation. This is a browser-worker policy; native compilation will require its own OS sandbox. TeX’s default string-based parent-path restriction is documented in [Kpathsea’s filename checks](https://tug.org/texinfohtml/kpathsea.html#Safe-filenames).

One active worker is retained between compiles within a project. Cancel, timeout, project navigation, or failure destroys it. A generation token prevents a superseded job from replacing a later result. If source changes during a successful compile, the result is discarded and the existing preview is marked out of date. A failed compile never replaces a last good PDF. Auto-compile queues another attempt after the document becomes idle.

Rust diagnostics track TeX's nested input files and explicit file/line errors. Relative inputs resolve against the main document's compiler directory; only exact current project text paths become source links. Missing dependencies stay in the issue summary, while `file` and `line` identify the importing source when the log provides it. Unknown locations are omitted rather than inventing a line. The report counts distinct LaTeX, package and class warnings from the final TeX pass, deduplicating repeated log/stdout evidence. A later TeX command supersedes earlier warning and missing-glyph evidence; auxiliary commands do not. Logs without command boundaries are treated as one pass. An explicit runtime-warning list filters epstopdf’s disabled-shell-escape notice; all evidence remains in the raw log. Existing missing-glyph and incomplete-recorder warnings also contribute to `warningCount`. Reports contain at most 100 issues, 1,024 UTF-8 bytes per summary/action and 8,192 per detail, with `truncated` when the issue cap is reached. Core evidence limits remain 8 MiB of log and 1 MiB of recorder; the browser submits its existing smaller bounded evidence.

Compile and Cancel compilation are separate controls with fixed positions. Compile keeps its name, exposes `aria-busy` and `data-state=idle|running`, and is disabled while running; Cancel is disabled while idle. The existing keyboard and companion cancellation behavior is unchanged. A named compilation status reports outcome, pages and warnings; a discarded stale result explicitly says pages are unavailable. The compilation status is a button toggling compact issues. Warnings never open the panel automatically; failed compiles do. Close and Escape hide the panel, and its visibility choice survives successful compiles until another failure. The panel is capped at 25% of the viewport height and scrolls internally. Source locations link to known project text files; unavailable line numbers are omitted. Warning advice appears once. Issues remain accessible independently of the raw log. Show compilation log opens a named region that is absent by default and closes on the next build and on success.

The PDF adapter uses the pinned PDF.js viewer, link service and find controller, following its [component integration example](https://github.com/mozilla/pdf.js/blob/master/examples/components/simpleviewer.mjs). PDF.js owns text geometry, Unicode/ligature search, highlighting, internal links and page rendering; rewriting these in Rust would duplicate a mature layout implementation. Application controls remain Leptos components. PDF scripts, XFA and annotation editing are disabled. External links open separately with `noopener noreferrer`.

The reader offers native text selection, physical page numbers, keyboard page navigation, match-case/whole-word search, and width/page fit. Zoom and recompilation preserve the current page and PDF position; fit modes adapt to pane resizing. Loading a new PDF validates its first page before replacing the old document, and generation checks prevent project switches from displaying an obsolete result. Failed TeX compilation retains the previous PDF with an out-of-date indicator. Text layers improve text access, but semantic reading order and structure still depend on the PDF's tags; generated untagged LaTeX PDFs are not automatically made fully accessible.

PDF.js lazily renders pages and evicts old canvases through its viewer buffer (normally ten pages, expanded for a larger visible range). Each canvas is limited to 4,194,304 pixels and 4,096 pixels per dimension; high zoom may downsample the preview while PDF download retains the original. Whole-document search extracts text as needed. The source editor uses browser-native input and composition handling through CodeMirror.

## Source/PDF navigation

Compilation enables SyncTeX and retains its metadata alongside an immutable manifest of source IDs, paths and line counts. A locally adapted, MIT-licensed `synctex-parser` runs in Rust/WASM through a cancellable worker. The memory-only feature forbids host filesystem reads even in native builds. The core normalizes relative input paths against the main document’s compiler directory and admits only exact project-manifest paths; package files, generated sidecars and uncompiled basename aliases cannot become editor targets. Gzip checksums and expansion are checked, input is bounded to 16 MiB and 250,000 records, parsing depth is capped, and workers time out after five seconds. A fresh worker reparses the metadata for each query; a reusable index is a possible measured optimization.

The UI associates navigation with the exact document and revision that produced the displayed PDF. Any source-affecting document update clears the mapping, cancels pending work and removes the marker. Completion guards also cover a source change while PDF page loading is pending. Reverting an edit still requires recompilation. Missing or malformed navigation data leaves the successful PDF usable. Navigation is line-level: macro expansion and engine metadata can point to nearby source lines. Canonical C-parser comparisons cover all three engines; LuaLaTeX can emit unusually tall boxes, so the visual marker is capped to the bottom 24 PDF points without altering the parser result. PDF.js performs viewport conversion. The upstream parser license, port details and canonical reference are recorded in `vendor/synctex-parser/PROVENANCE.md`.

## Editor workspace

File tabs use stable IDs, so renames preserve their identity. Closing the last tab leaves an empty editor; restoring deleted sources reopens the main file when no tab remains. LocalStorage holds per-project tab IDs, the active ID, font size, indentation, line wrapping and auto-compile preferences. These device preferences are separate from shared project metadata and durable source saves. Selection anchors and scroll positions survive tab switches within a session using Yjs relative positions; they are not persisted across browser restarts. Per-file Yjs undo managers survive editor remounts.

Single-file find/replace uses CodeMirror's search state and commands with a custom
panel in `web/editor-search.js` and token-based styles in `web/editor-search.css`.
Its count retains at most 10,000 match ranges per query/document, reports larger
sets as `10,000+`, and reuses the count on selection changes. The existing search
keymap, replacement templates and single-selection policy (including Select all)
remain unchanged. Reviewing replacements validate individual CodeMirror changes
against a temporary draft before publishing any of them. Replace-all creates one
suggestion per match, including adjacent matches, and preserves intervening
proposals. Protected matches reject the whole editor transaction with a message.
Reviewing replacements enter the existing suggestion dispatcher;
Viewing refuses them through CodeMirror read-only state and the editor transaction
filter. The panel adds no source mutation path or network request.

Rendered CodeMirror lines carry `data-line` and a title such as `Line 6` or `Line 7, blank`. Playwright AI-mode accessibility snapshots retain these labels and blank rows in source order. Virtualization remains: navigate or scroll before reading offscreen lines. Default-mode Playwright snapshots still omit editable descendants, and snapshot text still normalizes whitespace. The tab title follows the current project name and returns to the dashboard title on exit; URL routing is unchanged.

The Rust core owns Unicode search, regex captures and literal TeX outlines. Browser workers load the same WASM core without mounting Leptos. Each request can be cancelled; a five-second timeout terminates expensive analysis. Queries are bounded to 4 KiB, replacement templates to 64 KiB, and previews to 2,000 matches and 1 MiB of matched/replacement text. Capture expansion is conservatively bounded before allocation. Truncated previews cannot be applied. Regex syntax is Rust's `regex` syntax, with multiline anchors; replacement captures use `$1` or `${name}`. Outlines skip comments and common verbatim environments but do not expand macros or derive document inclusion order.

Replacement previews bind to a source snapshot, file identities and paths. Applying a stale preview fails without mutation. Selected UTF-16 ranges apply in one Yjs transaction after size validation. A dedicated undo manager reverses or reapplies the batch across files while retaining subsequent unrelated edits. Search results become stale after document changes; fresh analysis is required before navigation or another replacement.

## Offline assets

Vite generates a versioned service worker with a precache list covering the entire application shell, including Rust WASM, the search/outline worker and the PDF worker. Native Rust generates a smaller LuaLaTeX data collection, static supplemental archives and a font family index from the pinned upstream compiler distribution. Runtime manifests pin bounded sizes and SHA-256 hashes; the service worker verifies network and cached bytes and stores runtime assets by content hash. Original collection preloads are excluded from deployment. Biber assets load separately when needed; explicit offline preparation caches them too.

Supplemental archives use a separate IndexedDB cache and Rust SHA-512/XZ/TAR validation. A small pinned manifest routes on-demand filename/package shards into an incremental Rust catalog. Metadata has its own namespace and budget in the public package cache; metadata and archives bypass service-worker HTTP caching. Portable bundles include metadata proofs verified in Rust, and imports commit metadata/archives in one cache transaction. The catalog authenticates a LuaHBTeX/prebuilt-format profile, verified in Rust against the runtime and binary. Native generation also checks the frozen catalog and compiler/format byte pins before publication. Project environment locks pin the effective runtime and all packages loaded in the worker. Offline preparation/checking verifies both caches and reports storage failures without deleting or changing source. Clear-compiler-cache also attempts to remove the older Emscripten preload database. See [TeX delivery](tex-packages.md) for limits, measurements and remaining work.

Only same-origin static assets are cached. Compilation source files and binary assets never enter an HTTP request. The optional WebSocket/HTTP sync demo, behind its development switch, is the exception to local-only document processing and starts only after a user action. The local MCP companion is discontinued (November 8, 2026); the editor no longer offers or contacts it, and its retained code runs only behind the test-only `scribyra-companion-dev` switch.

## Optional service and retained demo

`scribyra-sync` implements the [opaque service protocol](service.md), with
authenticated immutable storage and short-lived signaling. It never merges
project data. The following historical protocol is retained only in the
loopback-only `plaintext-demo` Cargo example, excluded from release images.

### Plaintext demo protocol v1

`GET /health` reports demo availability. `GET /rooms/{room}` upgrades to WebSocket. Binary frames begin with a one-byte type:

| Type | Payload | Behavior |
| --- | --- | --- |
| 0 | Yjs v1 encoded update | Merge with Yrs, transactionally persist complete state to SQLite, broadcast update. |
| 1 | Yjs awareness update | Ephemeral broadcast, never persisted. |
| 2 | Empty | Acknowledge durable receipt of one document update. |

On connection the server sends existing state, and the client sends its full local state. Reconnection therefore repairs missed updates without requiring the broadcast buffer to be durable. SQLite writes finish before acknowledgements. Lagged clients are disconnected so they reconnect and resynchronize. Invalid document updates close the connection without corrupting stored state.

Binary objects use `HEAD/GET/PUT /rooms/{room}/blobs/{sha256}`. The Rust service rejects invalid hashes, mismatched bytes and disallowed browser origins; objects are immutable and scoped to a room, with a 64 MiB per-object and 256 MiB per-room limit. The client uploads missing objects before sending referencing metadata, verifies bounded downloads before applying received metadata, and reports synchronization complete only after queued transfers and durable metadata acknowledgements finish. Existing hashes are reused across reconnects. Objects persist in SQLite across restarts. This loopback prototype retains uploaded blobs indefinitely; authenticated ownership and retention policies belong to remote synchronization.

This validates the protocol and local persistence, not production tenancy or authorization. Production sharing will need server-owned project identity, authenticated memberships, revocation, schema validation, limits, and an explicit remote backup policy. End-to-end encryption is not implemented or claimed.

## Subsequent release

Preserved requirements: project sharing, accounts and HTTPS Git remotes through a self-hostable transport proxy. Local comments, source suggestions, restorable history and complete backups are integrated; see [verification and limits](integration-567.md). The transport proxy is not implemented in this milestone. SSH, Git LFS, submodules, rich-text LaTeX editing, AI, billing, public hosting and native companions remain outside this prototype.

Outbound MCP providers use a shared Rust/WASM operation validator, the maintained browser SDK for direct HTTP and the Rust SDK plus owned Tokio processes for configured local stdio. Provider credentials and responses stay outside project storage; source disclosure is an explicit reviewed action. See [provider connections](mcp-providers.md).

Same-profile tab synchronization follows committed local heads through metadata-only broadcasts, polling and resume checks. The existing document receives verified updates without echo saves or peer-owned undo entries. Concurrent binary losses are preserved in independent recovery projects before publishing a merge; deletion keeps open source exportable and can save a new identity. See [local synchronization](local-sync.md).

## Experimental direct sessions

`web/replication.js` provides two-way periodic state-vector repair, bounded chunk
framing, verified asset pulls and the local-tab full-state validation seam.
`web/direct-session.js` supplies the optional WebRTC full mesh, signed signaling
through the configured service, comparison-code verification and a profile Web
Lock. `web/direct-share.js` owns the off-by-default Share controls. Incoming updates
use a registered remote origin and the existing save/committed-head path; Viewing,
local undo and auto-compile retain their existing policy. Newer project schemas
are refused before publication. See [the protocol and limits](direct-sessions-design.md).

Direct replica protocol 2 additionally validates key-bound record signatures, pinned
lineage and complete retained-state/queue budgets before publication. Review decisions
are authenticated separately from the invite’s source-edit grant. Generation tokens
and abort signals cancel pending Share startup and joins. See the [security follow-up](direct-sessions-design.md#security-review-follow-up-november-7-2026). Since 8 November 2026 nothing of this runs until the person turns sessions on (`web/direct-state.js`); records from before then are claimed or unverified, never approvals ([off means off](direct-sessions-design.md#decisions-8-november-2026-off-means-off)).

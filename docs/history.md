# Restorable history (milestone 7)

Current integration: History now runs with the other local features and production anchors.
See [combined verification, corrections and limits](integration-567.md). Earlier branch-only
counts and integration caveats below are historical.

Implementation of [the history contract](annotations-design.md#history-retention-restoration-and-exports).
Rust selects restore boundaries and supplies their active events to the comment/review
reducers. The application restores attached anchors, thread resolution, pending suggestions
and review authority through the production adapters; the clean-profile offline browser
case exercises these together.

The History panel exposes automatic checkpoints, named checkpoints, stable-file-ID text/rename/asset
and discussion diffs, restore-as-copy, reviewed current-project restoration, reviewed compaction,
and complete plaintext `.scribyra-backup` export/import. Names capture the document before adding
the name. Verified manifests, 4 MiB update chunks, all asset bytes and resolved discussion
projections are required for Restorable.
Missing objects never authorize restore. Ordinary source ZIP behavior is unchanged.

Current restoration creates explicit text/map edits on a clone of the current replica. The durable
transaction pins a byte-exact pre-restore checkpoint before publishing the new attributed update.
The full file-ID mapping is a session artifact; type collisions allocate new IDs. Historical discussion
and decisions remain as evidence with explicit restore projections; unavailable anchor adapters mark
bindings detached. Each new `restoreProjection` carries its root, normalized target record (or null), immutable
`eventIds`, identity map and remapped anchor (or explicit detached flag). It never embeds earlier
events. Parents contain the observed causal heads. `discussionProjection` selects the latest
restore boundary and active ordinary event IDs for the owning feature's decision reducer;
concurrent ordinary decisions survive, while missing references, cycles and competing restores
fail explicitly. Causal heads are computed separately from projection selection, so an explicit
restore of a clean target can supersede competing boundaries in the current head. Conflicted
targets remain visible as unavailable; copy/current restore plans and complete-backup import
plans reject unresolved target projections before offering success. Legacy embedded projections are read with a depth bound of 64 and normalized
when restoring again. Existing immutable evidence is retained, not rewritten. Copies fork lineage, retain historical attribution and set local review authority.
A single-version copy advertises only that version. Complete-backup imports retain all names/history.
Explicit recovery may preserve lineage only when it is absent from this device, checked inside the
installation transaction. Imports always use a new local project key and record the importer.

Compaction plans enumerate retained/removed checkpoint IDs and local sequences plus retained/released
project object and asset references. Shared bytes remain while another project pins them. Unknown
feature pins conservatively keep project assets until their owner supplies a narrower closure. Names still pinned,
migration copies, current head and pre-restore snapshots are mandatory. Full snapshots retain causal
IDs and delete sets; this is not a CRDT reseed. Journal deletion, catalog changes, object pins and
cross-project blob reference collection share one guarded transaction. Export holds a consistent
copied snapshot, so later compaction cannot invalidate an in-progress artifact. Quota errors roll
back history/head/installation together. Reversing a restore uses its pinned pre-restore checkpoint.

Format 1 is a ZIP with `manifest.json`, `project.update`, `history.json`, and content-addressed
`objects/<sha256>`, `assets/<sha256>`, `updates/<sha256>` entries. The manifest is closed and includes
each path, expanded size and SHA-256. History metadata retains raw checkpoints/journal entries and
both generations of migration recovery copies. Import validates directory/local headers, paths,
duplicates, encryption/symlink flags, overlap, versions, exact sizes/hashes and all referenced objects
before installation. DEFLATE input is fed in 1 KiB slices with declared/aggregate output bounds.
Compressed and expanded bounds are 512 MiB, with at most 100,000 entries; ZIP64 entry counts are supported; multidisk/descriptor
archives and per-entry sizes outside the aggregate bound are rejected. Large-project memory
and throughput are not measured by the small fixtures.

Only project stores are exported. Provider/device credentials, pairings, grants, telemetry, preferences,
compiler binaries and package caches are not read. Unexpected project roots or metadata fail export
rather than carrying connection state. Before exporting or importing retained updates, validation uses Yjs's
`decodeUpdate` to inspect the original serialized structs, including deleted content kept by an
UndoManager or merged updates and content pending missing predecessors. Root names and `meta`
keys use the same allowlists as visible-state validation. Origin/parent references resolve across
retained updates; content whose root cannot be established fails closed. This covers the current
snapshot, both migration stores, ordinary/replay-only checkpoints, journal updates, named
checkpoint chunks, and uncatalogued checkpoint objects retained by copies. Unclassified history
objects reject complete backup rather than escaping inspection. Unsafe bytes are rejected, never
silently rewritten or redacted. The app does not put credentials in project documents; this is a
structural guard against unexpected connection state, **not a general secret scanner**. It does
not inspect source strings or asset bytes for credential-like text, or identify secrets placed
inside otherwise allowed project fields. Export and import share validation of every retained raw
checkpoint (including replay-only rows), both migration-copy generations, each journal state
using a strictly earlier checkpoint, and replay through the committed head. The replayed head
must match the current encoded snapshot. A failed complete export offers a source ZIP of current
files and explicitly states that history/discussions are absent; no complete artifact is returned. The UI warns that backups are plaintext and include deleted
content. Restoring data needs no compiler runtime; compiling after cache erasure needs offline
preparation separately.

Internal v2 handlers register `history.list`, `history.name`, `history.diff`, `history.restorePlan`,
`history.restore`, `history.unpin`, `history.compactPlan`, `history.compact`, `backup.export`,
`backup.importPlan`, `backup.import`, `artifact.read`. All use the awaited document queue; mutations
require revisions, mode-specific rights, lifetime guards and committed-sequence checks. Plans expire
after 15 minutes or a revision change. Lists default to 50, cap at 100 and paginate within the receipt
bound; cursors bind revision and query. Complete plans and compaction receipts use a JSON detail artifact when their lists exceed the
receipt budget; the UI displays the full detail before applying. Lists/diffs show at most 32
contributor IDs inline and expose the complete set through an explicit JSON artifact. Artifacts
are session-scoped, limited to 1,024 references and 512 MiB total session bytes, and chunked at 64 KiB. A full
artifact budget rejects new exports instead of advertising already-evicted downloads. `artifact.read`
returns an attachment reference: trusted adapters retrieve its bytes through the registered history
transfer's `attachment.read` hook; no backup bytes are encoded in receipts. The host attachment map
supplies backup import bytes. Closing the feature clears plans/artifacts and revokes attachment reads.
This remains the internal API; publication still belongs to A/R4.

## Stored history size (history format 2, November 11, 2026)

The owner approved this on November 11, 2026 ([large-projects.md](large-projects.md#what-needs-a-decision)).
Before it, every keystroke wrote a full change record (about 414 bytes) into the project
document, every 50 saves stored another full copy of the document, and every journal row
repeated the document's whole delete set. Stored history grew quadratically, and a project
could not even be typed past about 10,000 keystrokes: the 10,000-record collaboration bound
refused the next save. Measurements are in [large-projects.md](large-projects.md#stored-history-size-after-the-fix).

### Typing bursts (`web/history.js`, `web/history-compaction.js`)

Consecutive plain source edits by one author, in one session, in one file share one change
record: the record written by the burst's first transaction. Consecutive undo/redo steps form
their own bursts (`kind: 'undo-redo'`). A burst ends when

- the person pauses for **60 seconds** (`BURST_PAUSE_MS`);
- it has lasted **5 minutes** (`BURST_MAX_MS`);
- an edit touches another file, or several files, or the tree, assets or settings;
- the kind changes (typing after undo, undo after typing);
- the edit is attributed (agent commands keep one record per command, as before);
- any other change record appears in the project: a comment, reply, review action,
  suggestion, decision, named version, restore, or a peer's record;
- a save becomes an automatic version (`collaboration.endBurst()` before the save is frozen).

Sixty seconds is far longer than the gaps inside writing (keys, words, sentences, short
thinking pauses) and shorter than the gaps that separate one piece of work from another, so a
burst reads as "this person edited this file around this time". It also keeps the record count
well inside the 10,000-record bound: the 100,000-character simulation writes one record per
roughly 400 characters, so a 1.4-million-character thesis needs a few thousand records. The
five-minute cap matches the automatic-version interval, so History still dates edits to within
minutes, and a diff after any automatic version names who typed after it.

Records stay immutable and keep their exact shape (no schema change): a burst's record is
complete the moment it is written, carries the burst's start time, and is signed once for
direct sessions like any other record; continuing a burst adds no record and no proof, and
peers verify it as before. Undo managers, their capture groups and their scopes are untouched;
the test "undo and redo behave exactly as without coalescing" replays an undo/redo script with
and without the history module and compares every intermediate text.

### Automatic versions, the journal and the thinning ladder (`web/storage.js`)

- **Journal rows hold only what a save added**: the update the save transaction itself emits,
  instead of `encodeStateAsUpdate(merged, vector)`, which repeats the whole delete set in every
  row. Replay is byte-for-byte identical.
- **Automatic versions are journal points**, not copies: a save is marked `point` (with a
  `checkpointId`) at most once per **5 minutes** of saving (`POINT_INTERVAL_MS`; the tab ends
  its typing burst first), and the last save before a pause of **2 minutes** or more
  (`POINT_GAP_MS`) is marked too. A point is restored by replaying the journal from the nearest
  full copy. No full copy is written every 50 saves any more.
- **Maintenance thins and merges** (`maintainHistory`): it keeps every automatic version from
  the last hour, then the latest one per hour for a day, per day for a month and per week after
  that (`ladder`). Named versions, pre-restore versions, migration versions and the starting
  point are never candidates. The journal rows between two kept states are merged into one
  row (`version: 2`, covering `from`..`sequence`) with `Y.mergeUpdates`. Rows end at every
  kept version, every catalogue sequence and the head, so every retained point still replays.
- **Sparse full copies** (`replayOnly` checkpoints) are kept only where the journal bytes since
  the previous copy exceed both 1 MiB and the copy's own size, so restoring a point never
  replays more than about one project's worth of updates, and the copies add up to about twice
  the final project size at most (geometric spacing).

Why this design: a full copy per version costs the whole project per version (quadratic in
total); merged deltas cost each change once (linear), and the occasional full copy bounds the
replay. Measured restore of the oldest automatic version stays at about one project decode.
Opening History lists journal points from one linear replay instead of decoding and validating
every stored copy; a point is fully validated when it is opened, compared or restored.

Maintenance runs in the background, a few seconds after the person stops typing, when 600
saves or an hour have passed since the last run, and once after opening. It holds a Web Lock
per project (one tab at a time). Each step is one IndexedDB transaction that re-reads its rows,
refuses if another tab changed them, verifies that the merged row rebuilds exactly the same
encoded state as the original rows, and only then replaces them. A closed tab or a failed step
leaves a valid, partly maintained history; the next run continues. Saves made meanwhile
append after the planned range and are untouched.

### Projects stored before format 2 (`compactProjectData`, then maintenance)

Project records carry `history: {version: 2, …}`. A record without it is compacted on its first
open after the update, in a transaction separate from loading (a failure never blocks opening;
the next open tries again):

1. A **recovery copy** of the current project, with every original record, is saved as a
   separate project named "… (before history compaction)", the same way binary conflicts are
   preserved. It gets a new lineage, so it can never join the original's direct sessions.
2. Redundant per-keystroke records are deleted with the same burst rule as live typing,
   never across a stored version's time. A record is kept when anything cites it (authors,
   comments, messages, anchors, suggestions, reviews, decisions, restore events, `undoOf`,
   `restoreOf`, proofs). `verifyCoalesced` checks inside the transaction that only change
   records disappeared, that each one is represented by a kept record of the same author,
   session, kind and file, and that every text, file, asset, setting and discussion record is
   identical. The deletion is journaled as an ordinary save; historical versions keep their
   exact bytes, including their original records.
3. A project that has carried direct-session proofs or claims keeps every record: peers refuse
   removed attributed records. Its history is still thinned.
4. Maintenance then thins the old automatic copies on the ladder and merges the old journal.
   Old automatic copies that are kept become journal points (their `checkpointId` is kept);
   duplicate automatic catalogue entries from earlier backups are released.
5. When the compacted history replays exactly to the saved project, the recovery copy is
   deleted, unless the person has opened and changed it.

### Clean up history in format 2 (November 11, 2026, after review)

Clean-up used to replace the journal with a full copy at each kept version, which with many
named versions made storage larger (backup 17.8 → 32.5 MB on the heavy-history project). It now
keeps versions through the same journal mechanism: (1) maintenance merges the steps between
versions, removing none and writing no copy, so every listed state is unchanged even if what
follows fails; (2) one guarded commit drops removed versions' `point` flags or catalogue entries
and objects, marks chosen versions `kept` (automatic thinning never removes them) and releases
assets no remaining stored state refers to; (3) maintenance merges across the removed versions,
without new copies. A merged row is never larger than the rows it replaces (smaller encoding, or
the rows stay). Projects still in format 1 keep the earlier clean-up. Regressions: a fresh
compacted project and the real version-7 project (`tests/history-size.test.mjs`), the
heavy-history project (`scripts/compact-dump.mjs`, opt-in heavy spec). The compact quota tests
(Node and browser) now compare versions, head, catalogue, objects and assets, because the merge
in step 1 may change journal rows while keeping every state; the browser compaction test checks
that no journal row remains between kept versions instead of an empty journal.

### Formats and compatibility

- IndexedDB **version 8** (was 7). No store changed, but rows are read differently, so an older
  Scribyra refuses to open the database instead of misreading merged rows.
- Complete backups are **format 2** (`manifest.format` and `history.json` `version`): journal
  rows may carry `from`, `point` and `checkpointId`, and `compacted` says whether records were
  already merged. Format-1 backups still import; their projects compact on first open. Newer
  formats are refused, as is a newer database. The project document schema stays 8.
- Source ZIP export is unchanged.

Tests: `tests/history-size.test.mjs` (real version-7 database and format-1 backup made by the
earlier code with `tests/fixtures/history/make-legacy.mjs`), `tests/storage.test.mjs`,
`tests/history.test.mjs`, `tests/large-projects.test.mjs`; browser: `history`, `storage`,
`storage-upgrade` and the opt-in `typing-history` and `large-projects` measurements.

### Independent review, verification and limits

An independent data-safety review (adversarial probes for attribution, named versions,
discussions, undo, interrupted or racing compaction, direct-session peers, restore and
backups) found three defects that were reproduced and fixed: automatic versions kept in
**Clean up history** were thinned again by later maintenance; a peer's or another tab's
typing burst could span this tab's automatic version and vanish from that diff's contributors
(diffs from a version now also name authors of bursts begun within 5 minutes before it); and a
crafted full copy inside a merged row could hang replay (replay now skips such copies and
backups refuse that layout). Four suspected issues were also addressed: migration now keeps
the history bookkeeping; a failed verification marks the project, stops automatic maintenance,
keeps the recovery copy and tells the person; earlier-format compaction ends bursts at any
other record, as live typing does; and schema-migration copies no longer count as automatic
versions (found by the browser suite: they caused an unneeded recovery copy). All are
regression tests in `tests/history-size.test.mjs`.

Acceptance (November 11, 2026): `npm test` passed (1,202 JavaScript/WASM pass, 0 fail,
6 optional-service skips; every Rust suite passed). `npm run build`, `npm run build:pages`
and `python3 scripts/ci-telemetry.py browser-pages` (13/13) passed. Full browser suites:
Chromium 449 pass / 2 fail / 15 skip / 1 not run, Firefox 443 / 1 / 22 / 1, WebKit 433 / 2 /
31 / 1. The `pages-domains` failure and its "not run" follower in every engine need the
`build:pages` artifacts and pass in all three engines once they exist. Chromium's tree-upgrade
failure was the migration-copy defect above (fixed; 5/5 since). WebKit's
"settings, search replacements…" local-tabs test is flaky and predates this change: 3 of 10
runs failed against main's build, 2 of 7 against this branch. Chromium's history, storage,
storage-upgrade, foundation, tree, local-tabs, comments and reviews specs were rerun on the
final build: 180/180.

Tests changed, and why: `storage.test.mjs` (the "periodic checkpoints" case now asserts no
copy every 50 saves, then exact replay after maintenance); `history.test.mjs` replayEach case
(adds the sparse bases maintenance would write, since saves no longer write them);
`large-projects.test.mjs` inventory case (journal points need five minutes of virtual time and
are compared with full verification through `openVersion`); `local-tabs.test.mjs`,
`storage-upgrade.test.mjs` and `foundation.spec.js` expect database version 8;
`fixtures/direct-off-main.json` re-recorded (decoded, only journal row bytes and the project
record's `history` field differ; the document, ZIP and every direct-session check are
unchanged). No assertion was removed or loosened beyond these format changes.

Limits: Named versions remain full
copies. A burst continued by another tab of the same profile after this tab's automatic
version is attributed through the 5-minute rule, not exactly. Two copies of one lineage, one
compacted and one not, and never shared through a session before, cannot later share a direct
session (the peer refuses the removed records); nothing is lost. Saves still encode the whole
document (large-projects bottleneck 5), and maintenance runs on the main thread (about 1–2 s
per run for a 3.5 MB document).

## Remaining review findings, November 5, 2026

Deleted `providerToken` canaries now reject export and import in 21 cases: three retention forms
(merged updates with default GC, UndoManager retention, and pending updates) across seven locations
(head, both migration stores, ordinary/replay-only checkpoints, journal, and catalogue chunks).
Four more cases cover deleted roots, inherited map keys, unknown pending ancestry, and ordinary
source text containing `providerToken`. Two cases cover uncatalogued checkpoint objects and
unclassified raw update objects. The concurrency regression merges two independently restored
replicas containing a review, names the conflicted head, checks unavailable status and rejected
copy/current/import plans, then restores the earlier clean checkpoint and successfully copies
the resolved version. Rust independently tests causal heads, superseding boundaries, missing
parents and cycles. Browser regressions exercise six credential locations and the concurrent
restore/plan/recovery path in each engine.

An explicit restore resolves the live head; it does not rewrite historical conflicted checkpoints.
Those retained targets remain unavailable and prevent complete backup/compaction while retained.
A clean version can still be copied. Existing discussion-adapter integration remains unproven;
this repair does not enable that skipped gate or claim Safari/macOS coverage.

Follow-up focused checks (logs `tmp/m7-followup-*.log`):

```sh
nix develop -c npm run wasm
nix develop -c cargo test -p scribyra-core history
nix develop -c node --test --test-name-pattern='deleted credential bytes|concurrent restored replicas' tests/history.test.mjs
nix develop -c node --test --test-name-pattern='deleted credential bytes|concurrent restored replicas|serialized backup checks' tests/history.test.mjs
nix develop -c node --test --test-name-pattern='deleted credential bytes|concurrent restored replicas|serialized backup checks|uncatalogued retained' tests/history.test.mjs
nix develop -c npm run fixtures
nix develop -c bash -c 'ulimit -c 0; npm test > tmp/m7-followup-npm.log 2>&1 && npm run build > tmp/m7-followup-build.log 2>&1'
```

WASM and fixture generation passed. Native history passed **9/9**. The first 22-case probe run
had **18 pass / 4 fail**: one confirmed falsely Restorable concurrent checkpoints; three new
catalogue fixtures used a stale asset closure and were corrected to preserve it. The same
command then passed **22/22**. Expanded focused runs passed **26/26** and **28/28**. The first full
npm run passed **146 native / 306 JavaScript/WASM**, with 0 failures, 2 existing native ignores
and 6 optional-service skips (372.54 s JS phase). The two uncatalogued-object probes and final
plan-allocation ordering were added while that run was in flight, so final acceptance is rerun
on the committed implementation below. No existing test was weakened, deleted, renamed or skipped.

The first production build passed (17.82 s Vite phase), verifying cached TeX components without a
runtime download. Final test/build commands on the committed source:

```sh
nix develop -c bash -c 'ulimit -c 0; npm test > tmp/m7-followup-final-npm.log 2>&1 && npm run build > tmp/m7-followup-final-build.log 2>&1'
nix develop -c bash -c 'ulimit -c 0; echo $$ > tmp/m7-followup-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4502 --strictPort'
nix develop -c env SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/history.spec.js tests/browser/storage.spec.js --project=chromium --output=tmp/m7-followup-browser-chromium'
nix develop -c env SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/history.spec.js tests/browser/storage.spec.js --project=firefox --output=tmp/m7-followup-browser-firefox'
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/history.spec.js tests/browser/storage.spec.js --project=webkit --output=tmp/m7-followup-browser-webkit'
```

The first browser attempt used these three browser commands **without `--output`**, concurrently.
They collided in Playwright's shared `test-results/.playwright-artifacts-*` directories: Chromium
had **22 pass / 1 fail / 1 skip**, Firefox **21 / 2 / 1**, and WebKit **20 / 3 / 1**. All six failures
reported `browserContext.close: ENOENT` on trace files during teardown; no product assertion
failed. The complete matrix was rerun with the isolated output paths above and unchanged tests.
Logs are `tmp/m7-followup-{chromium,firefox,webkit}.log` for the failed attempt and
`tmp/m7-followup-verified-{chromium,firefox,webkit}.log` for the isolated runs. The preview was owned
PID **797514**, serving this worktree's first production `dist`.

The first isolated matrix passed **69/69 runnable checks** (Chromium 2.1 min, Firefox 2.4 min,
WebKit 2.7 min). No assertion or test timeout changed. The preview was stopped with `kill 797514`
before the final rebuild; its process exited on SIGTERM.

Final full results, completed **November 6 local time**: **146 native pass / 0 fail / 2 existing
ignores**, **308 JavaScript/WASM pass / 0 fail / 6 optional-service skips**, including all **101
history tests**. The JS phase took 398.53 s; its 30-cycle restore regression took 384.91 s. The
frozen companion/folders built and passed unchanged. The final production build passed (14.04 s
Vite phase); prebuild verified cached TeX assets, and only the existing third-party Zod annotation
warnings remained. No external service or runtime download was needed.

A comparison of the two builds matched WASM and the smaller JS chunk but not the main bundle/hash
or its index reference. Vite embeds Git revision/dirty state. The complete isolated browser matrix
was therefore rerun against the exact final `dist`, with no intervening source edits. This used
the same preview command with
`tmp/m7-followup-final-preview.pid`, owned PID **832929**, and the same isolated browser commands.
Final logs are `tmp/m7-followup-final-{chromium,firefox,webkit}.log`.

| Final browser check | Passed | Failed | Skipped | Duration |
| --- | ---: | ---: | ---: | --- |
| Chromium: history, storage | 23 | 0 | 1 existing integration gate | 45.1 s |
| Firefox: history, storage | 23 | 0 | 1 existing integration gate | 59.4 s |
| WebKit/Mesa: history, storage | 23 | 0 | 1 existing integration gate | 56.8 s |

Final browser acceptance is **69 pass / 0 fail / 3 existing integration skips**. The final preview
was stopped with `kill 832929`; port 4502 is free, owned browsers are closed, no core dumps remain,
and `git diff --check` passes. The structural secret-check and historical-conflict limits above
remain; integrated discussion adapters, Safari/macOS and large-project throughput are unproven.
No new decision belongs to the owner. No deployment, push, new network destination or frozen-crate
feature was introduced.

## Review repairs, November 5, 2026

The two export probes are regressions at both the command and rendered UI boundaries: deleting
the committed journal tail or replacing it with a valid empty update rejects complete export,
produces no complete download, and offers a working current-source ZIP. Secret canaries in both
migration-copy stores, raw and replay-only checkpoints, a journal entry hidden by a same-sequence
checkpoint, and a subsequently deleted journal credential all reject export with a clean current
snapshot. Existing schema-1–5 migration backup round trips remain covered.

Projection checks use actual Yjs relative positions and witness records, realistic thread resolve/
reopen, message edit, review submit/close, suggestion reject/withdraw and authority events. A new
regression completes **30 snapshot/edit/current-restore cycles**, asserting bounded event-JSON
growth, immutable event references, selected historical decisions, explicit detached anchors
without the unavailable adapter, and new local review authority. It then compacts, exports/imports,
restores a copy and restores an absent historical message without deleting its later evidence.
Four added native cases cover restore selection, concurrent decisions/restores, missing references,
cycles, absent records and normalization of older embedded projections. Active records still count
against the 10,000-record/16 MiB limits; this change prevents recursive duplication, not unlimited
history or automatic semantic archival. Large-project performance remains unmeasured.

The browser test **“discussion integration gate: real anchors, thread resolution and review
authority after offline recovery”** is deliberately skipped until milestones 5/6 merge. Its body
mounts the real adapters, creates discussion through v2 commands, imports into a clean offline
profile, restores a checkpoint, and checks adapter output, anchor resolution and the real panels.
The integrator must align response fields/panel selectors with the merged adapters and enable it;
it is not evidence today. The existing recovery test was renamed to **“source, asset and opaque
record recovery in a clean profile offline after project storage erasure”** to state its actual
scope. No existing assertion was removed or weakened. **The milestone 7 discussion recovery gate
remains unproven until that integrated case passes in all three engines.**

Review checks (logs `tmp/m7-review-*.log`):

```sh
nix develop -c npm run wasm
nix develop -c cargo test -p scribyra-core history
nix develop -c node --test tests/history.test.mjs
nix develop -c npm run fixtures
nix develop -c node --test --test-name-pattern='complete export rejects' tests/history.test.mjs
nix develop -c bash -c 'ulimit -c 0; npm test > tmp/m7-review-npm.log 2>&1 && npm run build > tmp/m7-review-build.log 2>&1'
```

Focused checks passed: WASM build 1/1, native history 8/8, JavaScript history 72/72 before
projection work and 73/73 afterward, fixture generation 1/1. The final focused 30-cycle test
took 269.38 s (274.88 s suite total); these small-fixture timings are not large-project throughput
evidence. Full npm passed 145 native tests (0 failed, 2 existing ignores) and 280 JavaScript/WASM
tests (0 failed, 6 optional private-service skips, 306.48 s JS phase). The ignores/skips are the
existing crash subprocess fixture, explicit Alloy test and private Grafana/Alloy/GitLab checks;
no external stack was started. Frozen companion/folders built and passed unchanged.

The pre-race-fix production build passed (15.99 s Vite phase, plus Rust/WASM/assets); prebuild verified cached
LuaLaTeX assets without a runtime download. Rollup reported the existing third-party Zod comment
annotation warnings; the build completed successfully.

The first review browser matrix passed Chromium **22/22 runnable** (40.1 s) and Firefox
**22/22 runnable** (55.2 s), each with the named integration gate skipped. WebKit had **21 pass /
1 fail / 1 skip** (1.9 min): the empty-update export was correctly rejected, but a queued refresh
replaced its failure with “History is stored on this device.” `web/history.js` now preserves the
failure while the source-ZIP offer is active. Both existing export-probe unit cases explicitly
refresh and assert that the failure remains visible; their focused rerun passed **2/2**. No assertion
was relaxed to handle the race. The full acceptance sequence was restarted after this repair. That rerun passed 145 native /
280 JavaScript checks (0 failures, the same 2 ignores / 6 skips; JS phase 269.90 s), and its
intermediate build passed (13.70 s Vite). Final UI cleanup routes the fallback through the existing
`project.export` action, retaining its revision/grant checks and project-derived ZIP filename;
the browser probes assert that exact filename. The final sequence below follows this wiring change.

The first preview served this worktree's rebuilt `dist` on **4502** as owned PID **709825** and
was stopped with `kill 709825` before rebuilding:

```sh
nix develop -c bash -c 'ulimit -c 0; echo $$ > tmp/m7-review-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4502 --strictPort'
for engine in chromium firefox webkit; do
  nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/{history,storage,storage-upgrade}.spec.js --project="$1"' bash "$engine" > "tmp/m7-review-$engine.log" 2>&1 || exit
done
```

The intermediate post-race-fix sequence was:

```sh
nix develop -c bash -c 'ulimit -c 0; npm test > tmp/m7-review-final-npm.log 2>&1 && npm run build > tmp/m7-review-final-build.log 2>&1'
```

The final acceptance sequence after all code changes is:

```sh
nix develop -c bash -c 'ulimit -c 0; npm test > tmp/m7-review-verified-npm.log 2>&1 && npm run build > tmp/m7-review-verified-build.log 2>&1'
```

Final npm results after all code changes: **145 native pass / 0 fail / 2 ignored** and
**280 JavaScript/WASM pass / 0 fail / 6 skipped**, including all 73 history tests (272.09 s JS
phase). The final production build passed (15.90 s Vite phase); prebuild again verified cached
TeX assets. The final preview was owned PID **739769**, started with:

```sh
nix develop -c bash -c 'ulimit -c 0; echo $$ > tmp/m7-review-verified-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4502 --strictPort'
for engine in chromium firefox webkit; do
  nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/{history,storage,storage-upgrade}.spec.js --project="$1"' bash "$engine" > "tmp/m7-review-verified-$engine.log" 2>&1 || exit
done
```

| Final browser check | Passed | Failed | Skipped | Duration |
| --- | ---: | ---: | ---: | --- |
| Chromium: history, storage, storage-upgrade | 22 | 0 | 1 integration gate | 40.3 s |
| Firefox: same three specs | 22 | 0 | 1 integration gate | 59.4 s |
| WebKit/Mesa: same three specs | 22 | 0 | 1 integration gate | 52.2 s |

Final browser acceptance is **66 pass / 0 fail / 3 intentional integration skips**, including
**57 passing history executions**. Both rendered export probes pass in every engine after the
refresh repair. No existing test was skipped; the three skips are executions of the newly named,
unproven discussion gate. There were no other failures in this review's checks.

The final preview was stopped with `kill 739769`; both owned preview processes exited on SIGTERM.
Playwright closed its browser contexts and fixture servers. Port 4502 is free, no core dumps
remain, and `git diff --check` passes. No external service, deployment, push, runtime download,
new network destination or frozen-crate feature was introduced. No new decision belongs to the owner.
Linux WebKit remains distinct from Safari/macOS evidence; quota faults are injected and large
project performance is unmeasured. Earlier logs/counts below belong to the preceding
implementation, not this review.

## Previous implementation verification

Logs are worktree-local in `tmp/m7-*.log`. Final counts below are separate from supplemental
and failed attempts; no test was weakened, deleted or renamed.

Final toolchain sequence (the shell wrapper preserves the two npm exit statuses):

```sh
nix develop -c bash -c 'ulimit -c 0; npm test > tmp/m7-final-npm.log 2>&1 && npm run build > tmp/m7-final-build.log 2>&1'
```

The final browser matrix serves this worktree's rebuilt `dist` on **4502**, with
`SCRIBYRA_TEST_PORT=4502` and worktree-local browser temporary files. Commands:

```sh
nix develop -c env SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" npx playwright test tests/browser/history.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js --project=chromium
nix develop -c env SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" npx playwright test tests/browser/history.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js --project=firefox
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" npx playwright test tests/browser/history.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js --project=webkit
```

| Final check | Passed | Failed | Skipped / ignored | Duration / scope |
| --- | ---: | ---: | ---: | --- |
| Native Rust, including frozen companion/folders | 141 | 0 | 2 ignored | Per-suite timings in `tmp/m7-final-npm.log` |
| JavaScript/WASM, full npm suite | 271 | 0 | 6 optional-service skips | 12.33 s JS phase; includes 64 history cases |
| Production build | 1 | 0 | 0 | 15.10 s Vite phase, plus assets/WASM |
| Chromium, seven requested/integration specs | 37 | 0 | 0 | 2.3 min; 17 history cases |
| Firefox, same seven specs | 36 | 0 | 1 platform skip | 3.0 min; 17 history cases |
| WebKit with Mesa, same seven specs | 36 | 0 | 1 platform skip | 3.0 min; 17 history cases |

Final browser acceptance is **109 pass / 0 fail / 2 platform skips**, including **51/51 history
executions**. These historical counts do not establish the integrated discussion gate. Every implemented fixture case ran in all three engines, with clean-profile offline
complete-backup recovery, exact retained CRDT bytes, opaque discussion fixtures, source ZIP
exclusions, source/asset/rename differences, current/copy restore, stale plans, compaction/shared
blobs, deletion-only stale replicas, corruption/gaps/future schema, quota rollback, secret-field
exclusions, rights, retries, artifact bounds and keyboard/accessibility checks. The two browser
skips are the existing native Chromium composition test on Firefox/WebKit, not history cases.
The native ignores are a crash subprocess fixture exercised by its parent and optional real-Alloy
integration. The six JS skips need explicitly started private Grafana/Alloy/GitLab infrastructure;
none was started. The frozen companion/folders crates built and passed unchanged.

The final preview was owned PID **632687**, started with:

```sh
nix develop -c bash -c 'ulimit -c 0; echo $$ > tmp/m7-verified-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4502 --strictPort'
kill 632687
```

It was stopped after the matrix with that exact kill command. Playwright and native fixtures
closed their owned browsers/servers. No core dumps remain; `git diff --check` passes. No TeX
runtime was downloaded: prebuild verified the provisioned cached baseline/components. No push,
deployment, external service or other worktree change was performed.

- [x] M7 history implementation and its three-engine fixture acceptance matrix.
- [x] Full native/WASM/JS tests and production build.
- [x] Storage, storage-upgrade, commands, local-tabs, editor and companion browser reruns.
- [x] Feature evidence recorded here for the original implementation; review repairs below also update the roadmap.

The initial focused preview used owned PID **576805**, stopped with `kill 576805`. The first
matrix preview used owned PID **586876**, stopped with `kill 586876`; the post-trace-repair
preview used owned PID **607135**, stopped with `kill 607135`. Browsers and fixture servers
close through Playwright and their `finally` hooks. Core dumps were disabled for browser runs.
The final preview PID and cleanup result are recorded with the completed matrix above.

Supplemental commands included:

```sh
nix develop -c npm run wasm
nix develop -c cargo test -p scribyra-core history
nix develop -c node --test tests/history.test.mjs
nix develop -c node --test tests/build-session.test.mjs
nix develop -c env SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" npx playwright test tests/browser/history.spec.js --project=chromium --max-failures=1
nix develop -c env SCRIBYRA_TEST_PORT=4502 TMPDIR="$PWD/tmp" npx playwright test tests/browser/commands.spec.js --project=chromium
```

Focused history native tests passed **3/3** before the fourth portable restore-validation test
was added. Focused history JS runs passed **51/51**, **58/58**, **59/59**; the final npm suite includes
**64 history tests**, including the original 36 foundation cases. Later focused runs passed
**63/63** and **64/64**, covering legacy prototype-like file IDs and a 500-file restore whose
complete detail requires multiple artifact reads. The first 51-case run had
**40 pass / 11 fail**: ten failures used a nonexistent test rename helper, and one corruption
fixture could reconstruct its chunk from another retained checkpoint. The fixtures now use the
real relocation helper and remove alternate copies when testing unavailable bytes. No existing
assertion was weakened. The focused Chromium history run passed **15/15** in **28.2 s**.

Two intermediate WASM builds failed on Leptos ownership errors in the new asset-comparison view;
cloning the displayed strings fixed them. An intermediate production build failed because a new
WASM wrapper was added after that build had generated its bindings. Final verification runs all
WASM-producing commands before browser tests, with no source changes in flight.

The first full npm attempt stopped with **79 native pass / 1 fail** at the existing core telemetry
flush timeout (`native.flush(Duration::from_secs(3))`); JS did not run. A subsequent full run passed
**140 native / 265 JS**, with 2 native ignores and 6 optional-service skips. After adding the fourth
portable restore test and the collision case, another run had **141 native pass**, **265 JS pass /
1 fail / 6 skip**: the existing metadata concurrency timing test observed `3 !== 4`. It was not
changed. The pre-foundation-repair acceptance rerun passed **141 native / 267 JS**, with the same
existing ignores/skips, and its production build passed (17.19 s Vite phase).

The first seven-spec Chromium run had **32 pass / 2 fail / 1 unrun** in **2.5 min**. All **15 history
cases passed**. The command spec's sync subprocess failed to start; its unchanged focused rerun
passed **2/2** in **10.6 s**. An owned two-second diagnostic sync process could subsequently bind
127.0.0.1:8787; the startup failure's cause is unconfirmed. The companion trace regression exposed
a separate foundation defect, repaired below. No unrelated process was stopped. After that
repair, the next full Chromium run passed **35/35** in **2.3 min**, with the original 15 history
cases. Subsequent review added two legacy-ID unit cases, one cross-browser legacy-ID case,
and a 500-file complete-plan case: large plans must not make an available checkpoint
unrestorable merely because its summary exceeds one receipt.

## Small shared foundation correction

Commit `b237fd3`, **Preserve trace context identity when copying build inputs**, changes only
`web/build-session.js` and `tests/build-session.test.mjs` outside M7 ownership. The coordinator
cloned the telemetry parent along with project inputs. The recorder recognizes parents through
a WeakMap, so compilation succeeded while worker child spans vanished. The coordinator now clones
project inputs and preserves the trusted trace context's identity. The new regression checks both
the live child span and independent source/asset buffers. The focused build-session suite passes
**4/4**; the final browser matrix also passes the real companion/worker trace case in all engines. No frozen crate, compiler behavior, command assertion or privacy check changes.

## Limits

Linux Playwright WebKit with Mesa is not Safari/macOS evidence. Quota faults are injected. Fixtures
exercise real IndexedDB and Yjs, with discussion records independent of the unfinished peer panels.
Attribution is descriptive, not authentication or character-level legacy blame. Semantic roots
retain F's 10,000-record/16 MiB bounds; this compactor reclaims replay and immutable-object/blob
storage and does not archive active semantic records or reseed CRDT state. Per-file Undo does
not capture restoration; reversing it uses the pinned pre-restore checkpoint. No integrated
cross-feature `change.undo` route for restoration is claimed here. No service, deployment,
push, new network destination or frozen companion/folders feature is introduced. No new owner decision;
R4/R6 field tests, A4 and independent security review remain open roadmap items.

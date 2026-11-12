# Reviews and proposed changes (milestone 6)

Current integration: Reviews now run with the other local features and production anchors.
See [combined verification, corrections and limits](integration-567.md). Earlier branch-only
counts and integration caveats below are historical.

The owner-6 modules now use milestone 5's production `capture`, `resolve` and
`rebind` service. The browser suite always uses production anchors; contract
fixtures remain unit-level coverage only. Reviews are enabled in the application
and exposed through the shared agent dispatcher. Restored copies preserve
immutable evidence and record the local acceptance authority explicitly.

| Delivery record | Evidence | Limits |
| --- | --- | --- |
| Initial owner 6: reviews and proposed changes | 141 Rust and 262 JS/WASM pass; build passes. Final review matrix 81/81 plus 40 existing regression passes: **121 pass, 0 fail, 2 platform skips**. | 2 Rust ignores, 6 optional-service skips. Contract anchors; real browser IndexedDB/Web Locks/compile; injected quota and postcommit close. M5 and shared artifact routing still require integration. |
| Review-finding corrections | 141 Rust / 263 JS/WASM pass; build passes; reviews **31/31 per engine**; default production-panel check **3/3**. | 2 Rust ignores / 6 optional-service skips. Explicit fixture for the review matrix; production anchors remain unavailable and the panel is disabled. Initial frozen-folders lock failure passed isolated and full reruns. |

## Delivered behavior

Reviews and insert/delete/replace suggestions are immutable semantic records in
the accepted document's annotation roots. Creating, submitting, rejecting,
withdrawing, exporting and previewing proposals does not edit accepted source.
Ordinary source ZIP and compiler snapshots still contain accepted files only.
The Leptos panel provides labelled inputs, keyboard buttons, status announcements,
plain-text differences, batch acceptance/undo/redo, package import planning and a
separate preview PDF download. Agent profiles retain their explicit label.

The Rust module validates closed command payloads, hashes binding material,
projects causal decision heads and validates decision authority/proposer metadata.
JS resolves current anchors and compares exact old text and the complete selected
item intervals. Identical replacement therefore conflicts even if the visible
text is unchanged. Insertions additionally bind both neighboring identities and
bounded context. External range edits may rebase; interior edits, deleted targets,
unknown anchors, ambiguous insertion boundaries and overlapping batches fail
without modifying accepted text. The existing Rust patch validator checks scalar
boundaries, all edits and final project size.

Accept/reject/withdraw and acceptance undo/redo require the designated authority.
They acquire `scribyra:review:<projectId>` through Web Locks, flush saves, read the
committed head, merge unseen state and recheck command revision and decision heads.
CodeMirror input is inert during the short decision boundary; composing input is
refused. Other live updates invalidate the precommit guard. A private Y.Doc stages
source, attributed changes and events. Only a successful bound `commitPrepared`
CAS publishes that exact merged update with `ReviewOrigin`, in one live transaction.
No async work separates staging validation from staging mutation. Later edits
remain CRDT edits; postcommit reconciliation never replaces the live document.

Each accepted batch owns a private Yjs undo manager. Undo validates inverse
bindings, retains unrelated human edits and publishes restored anchor bindings
with revert events, including other affected anchors captured before acceptance.
Each saved binding retains its witness provenance and the pre-batch validity of
its suggestions. Undo never rebinds a suggestion that was already conflicted;
unresolved or manually rebound anchors are never guessed. Redo validates the
proposals and snapshots affected bindings again, including conflicts introduced
since the previous undo. UI and agent commands use this same path. The original
acceptance change ID identifies the undo group; the receipt's change ID identifies the new
undo/redo transaction. Per-file human undo does not capture review publication.
Groups are session-local; reopening requires new decisions, not guessed undo.
A failed write retains exact prepared bytes and its change identity, leaves source
unpublished and blocks other terminal decisions. Retry uses the same bytes and
CAS sequence. If the committed head has changed, the draft remains stale; export the review proposals and
reopen for a fresh decision; it is never applied by numeric offset.

Preview uses the foundation's isolated build hook and shared build coordinator.
Its copied inputs, PDF URL, diagnostics, preview ID, accepted revision and selected
suggestion IDs stay in a separate destination. Cancellation/close revokes that
slot. Accepted PDF, SyncTeX, environment and source remain untouched.

## Commands and portable exchange

The trusted internal v2 host registers `review.list/get/create/submit/close`,
`suggestion.propose/accept/reject/withdraw`, `change.undo/redo`, `review.preview`,
`review.export/importPlan/import`. Mutation revisions and independent grants are
checked by F; acceptance and undo also check edit + review and authority. Review
body reads use bounded chunks and revision-bound page cursors. Accept/undo/redo
`eventHeads` is an object keyed by suggestion ID; single decisions use an array.
No new public window API, companion commands or transport is installed.

A `.scribyra-review` file is version-1 UTF-8 JSON with a lineage, selected review
IDs and semantic closure (authors, proposals, threads/messages, anchors, events,
changes and checkpoint references). Its maximum encoded size is 16 MiB; source
updates, credentials, history objects and unknown roots/fields are rejected.
The file picker checks `File.size` before `arrayBuffer()`; the exchange validator
still checks the actual byte length before decoding.
This is a review package, not a backup. Plans are revision-bound and explicit.
Same-lineage immutable IDs deduplicate; different content under an existing ID
fails. Imported terminal/authority-transfer/reattachment/restore claims are inert evidence. Missing
bindings remain conflicted. Foreign proposals require an explicit current file
selection per suggestion; foreign threads require one per anchor. All semantic
IDs are freshly mapped, public authorship is preserved and the new local review
has local authority. Foreign mapping is available through the command payload;
the file-picker UI supports same-lineage packages.

`review.export` returns a bounded artifact descriptor. The module retains at most
eight export artifacts and eight import plans; close revokes both. Bytes are
available in chunks of at most 64 KiB through the registered `reviews` transfer
handler (`read`, `{artifactId,offset,limit}`), for the integrator's shared
`artifact.read` attachment route. This branch does not claim to implement that
shared history/agent artifact dispatcher. A trusted host can inject `author`,
`authorityId`, `anchors` and `locks`; normal mounting uses a persistent local
review author and the foundation anchor adapter. Authorship is descriptive, not
cryptographic membership.

## Review-finding corrections (November 5, 2026)

The exact stale-proposal regression creates A over `bravo`, replaces its interior
`a` with the same character, accepts overlapping B, and undoes B. A stays
conflicted and acceptance fails without changing source, including after peer
reload. The shared unit/browser case exercises human and agent command hosts,
redo/undo, and a conflict introduced between undo and redo. A separate browser
case reloads an actual second tab from committed storage.

The production mount probes `capture`, `rebind` and `resolve` on an isolated
synthetic document. An unavailable service leaves the panel disabled and registers
no review actions, commands or transfers. The availability browser case always
loads the real `dist` app without replacing its anchor service. The import-picker
case verifies zero `arrayBuffer()` calls for a file larger than 16 MiB, then
supplies oversized returned bytes from a small file to check the second bound.

Current reproduction commands (each browser invocation is separate):

```sh
nix develop -c npm run fixtures
nix develop -c node --test tests/reviews.test.mjs
nix develop -c npm test
nix develop -c npm run build
nix develop -c bash -c 'ulimit -c 0; echo $$ > tmp/m6-review-fixes-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4503 --strictPort'
ulimit -c 0
nix develop -c env SCRIBYRA_TEST_PORT=4503 SCRIBYRA_REVIEW_ANCHORS=fixture TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js --project=chromium --output=tmp/m6-review-fixes-chromium-results
nix develop -c env SCRIBYRA_TEST_PORT=4503 SCRIBYRA_REVIEW_ANCHORS=fixture TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js --project=firefox --output=tmp/m6-review-fixes-firefox-results
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4503 SCRIBYRA_REVIEW_ANCHORS=fixture TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js --project=webkit --output=tmp/m6-review-fixes-webkit-results
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4503 TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js --grep 'production panel follows' --output=tmp/m6-review-fixes-production-results
```

| Final correction check | Passed | Failed | Skipped / ignored | Duration |
| --- | ---: | ---: | ---: | --- |
| Native Rust, including frozen crates | 141 | 0 | 2 ignored | Per-suite times in `tmp/m6-review-fixes-npm-final.log` |
| JavaScript/WASM | 263 | 0 | 6 optional-service skips | 13.31 s JS phase |
| Final production build | 1 | 0 | 0 | 13.22 s Vite phase, plus assets/WASM |
| Chromium reviews, explicit fixture | 31 | 0 | 0 | 1.4 min |
| Firefox reviews, explicit fixture | 31 | 0 | 0 | 1.6 min |
| WebKit reviews, explicit fixture | 31 | 0 | 0 | 1.6 min |
| Default production-panel check, all engines | 3 | 0 | 0 | 15.2 s |

The preview served this worktree's final `dist` on **4503**, owned PID **656527**,
and was stopped with `kill 656527`. Browser contexts/processes were closed by
Playwright and their fixtures. No core dumps remain. Logs are worktree-local at
`tmp/m6-review-fixes-*.log`; no runtime download, external service, deployment or
push was requested. The six optional-service skips and two Rust ignores retain
the reasons listed in the initial verification below. Broader browser specs were
not rerun for these owner-6 corrections. M5 production proposal/undo integration
still needs the full matrix without the fixture flag after merge; Linux WebKit
is not evidence for Safari/macOS. No new decision belongs to the owner.

The first full `npm test` stopped after **131 Rust passes, 1 failure and 1
ignore**, before JavaScript ran. The unchanged frozen-folders test
`exclusive_session_scope_and_missing_bindings_are_enforced` failed at
`crates/folders/tests/transactions.rs:19:58` with:

```text
called `Result::unwrap()` on an `Err` value: Custom { kind: WouldBlock, error: "This folder is already in use by another Scribyra session." }
```

Its isolated rerun passed **1/1**:

```sh
nix develop -c cargo test -p scribyra-folders --test transactions exclusive_session_scope_and_missing_bindings_are_enforced
```

The subsequent unchanged full run passed. Both production builds passed (final
Vite phase **13.22 s**); the earlier focused review unit run passed **25/25**.
`npm run fixtures` passed, and browser discovery with
`nix develop -c env SCRIBYRA_TEST_PORT=4503 SCRIBYRA_REVIEW_ANCHORS=fixture npx playwright test tests/browser/reviews.spec.js --list`
listed **93 tests** without executing them. Existing Nix eval-cache-busy and
third-party Rollup comment warnings did not fail checks. No existing test was
weakened, skipped, deleted or renamed for these corrections.

## Verification (initial owner-6 delivery)

The commands and counts below are historical. Current browser reproduction
requires the explicit fixture flag described above until M5 lands.

All toolchain commands ran through the flake. The preview on **4503**, PID
**514245**, was owned by this run and served this worktree’s final `dist`. Core
dumps were disabled. It was stopped with `kill 514245` after verification. No core dumps remain.
No TeX runtime download was requested. Tests use real Yjs, Rust/WASM validation and the
real persistence gateway. Unit storage uses fake IndexedDB; browser storage uses
real IndexedDB and Web Locks. The test-only anchor adapter lives inside
`tests/reviews.test.mjs`; `tests/browser/reviews.spec.js` bundles that exact fixture
and the production review modules. Its full-app case replaces only the anchor
adapter and adds test entry points, retaining the real compiler/PDF implementation.
Other browser cases cover actual same-profile racing tabs, separate profiles
exchanging packages, fault injection, postcommit host death and offline proposals.

Final reproduction commands (each browser invocation is separate):

```sh
nix develop -c npm test
nix develop -c npm run build
ulimit -c 0
nix develop -c bash -c 'echo $$ > tmp/m6-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4503 --strictPort'
nix develop -c env SCRIBYRA_TEST_PORT=4503 TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=chromium --output=tmp/m6-final-chromium-results
nix develop -c env SCRIBYRA_TEST_PORT=4503 TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=firefox --output=tmp/m6-final-firefox-results
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4503 TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=webkit --output=tmp/m6-final-webkit-results
```

| Final check | Passed | Failed | Skipped / ignored | Duration |
| --- | ---: | ---: | ---: | --- |
| Native Rust, including frozen crates | 141 | 0 | 2 ignored | Per-suite times in `tmp/m6-npm-final.log` |
| JavaScript/WASM | 262 | 0 | 6 optional-service tests | 13.0 s JS phase |
| Production build | 1 | 0 | 0 | 18.38 s Vite phase, plus assets/WASM |
| Chromium, five specs | 40 | 0 | 0 | 2.6 min |
| Firefox, five specs | 39 | 0 | 1 composition test | 3.5 min |
| WebKit, five specs | 39 | 0 | 1 composition test | 3.6 min |

The 24 review unit cases include the four existing foundation command tests and
20 review scenarios. The 27 review browser cases per engine cover every owner-6
matrix row case, using the contract anchors rather than M5's production service:

| Contract boundary | Evidence |
| --- | --- |
| Insert/delete/replace, ordinary ZIP/compile exclusion | Exact ZIP/snapshot comparison; real accepted compile retained through proposal/preview |
| Preview PDF/cancel | Controlled coordinator cancellation and real compiler cancellation/PDF download; accepted PDF ID/source unchanged |
| Safe rebase, stale/interior/identical replacement, overlap | Current item witnesses; rename; whole batch rejection without mutation |
| Accept/reject/withdraw, attribution, undo | Multi-file batch and per-file undo separation; prior/later human edits; distinct agent proposer and human acceptor; peer-reloaded anchor bindings |
| Authority races and crash/failure | Actual same-profile tabs accept/accept and accept/reject; real storage CAS; injected quota rollback/exact retry; close immediately after commit then reopen |
| Portable exchange | Independent browser profiles propose/import/accept/reimport; inert acceptance evidence; foreign mapping, new IDs and closed package validation |
| Rights, agents and absent authority | Comment-only denial; agent label in a second actual tab; offline pending proposals with absent authority |
| Accessibility | Leptos inputs/status, keyboard acceptance and axe audit of the review panel in each engine |

Earlier attempts are not added to the final totals:

- Initial WASM build failed because `review_projection` inferred an unsized slice;
  annotating the parsed vector fixed it. A premature unit invocation then failed
  before running tests because generated bindings were not yet present (1 failed
  test-file invocation).
- Focused review runs: **4 pass / 15 fail** from a missing fixture service argument;
  **18 pass / 1 fail** exposed the private undo manager's outer-transaction redo
  bug. The corrected runs passed **19/19**, then **23/23** twice as regressions grew.
  The final 24 are included in `npm test` above.
- First full `npm test`: **140 Rust / 257 JS pass**, 0 failures, 2 ignores / 6 skips.
  The next run, using `env TMPDIR="$PWD/tmp" npm test`, stopped in the unchanged
  frozen-folders CLI diagnostics test: `assertion failed: ... operation ==
  "native_session" && ... outcome == "success"`. The targeted unchanged rerun,
  `nix develop -c cargo test -p scribyra-folders --test cli explicit_native_diagnostics_preserve_cli_output_and_exclude_inspected_content`,
  passed **1/1**. The subsequent full run passed **140 Rust / 261 JS**; final
  coverage above includes the additional package and anchor-rebind cases.
- First Chromium review run: **24 pass / 1 fail**, because the full-app test bundle
  omitted Vite's compiler constants (`Cannot read properties of null (reading
  'loader')`). The first focused UI retry failed **0/1** on `TeX package worker
  failed`: esbuild did not rewrite Vite worker URLs. The harness now supplies the
  real pinned constants and serves the actual built workers. The next focused UI
  retry passed **1/1** with the real compiler, preview cancellation and axe audit.
  No production assertion was weakened. A supplemental Chromium regression run
  passed **14/14** before the final five-spec matrix.
- Three earlier production builds passed. Nix occasionally emitted an ignored eval
  cache SQLite-busy warning; Vite emitted existing third-party PURE-comment
  warnings. Neither failed the final checks.

After the five-spec matrix passed **118 checks, 0 failures and 2 platform skips**,
a final UI review found that the first-100 display limit could hide a proposal
included by the batch button. The button now explicitly accepts only displayed
pending proposals. A new real UI case creates 101 proposals, rejects one visible
proposal, accepts the displayed remainder and verifies that the hidden pending
proposal is untouched. Imported authority-transfer evidence is also explicitly
ignored by the authority check; the package regression includes such a claim.

The final full `npm test` again passed **141 Rust / 262 JS**, with the same ignores
and skips; its JS phase took **12.8 s**. The final build passed (13.54 s Vite phase).
The final focused unit invocation, `nix develop -c node --test tests/reviews.test.mjs`,
passed **24/24**. Only the review spec needed a further browser rerun for these
review-local changes; the existing regression specs and their assertions did not
change. Exact final review commands:

```sh
nix develop -c env SCRIBYRA_TEST_PORT=4503 TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js --project=chromium --output=tmp/m6-reviews-final-chromium-results
nix develop -c env SCRIBYRA_TEST_PORT=4503 TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js --project=firefox --output=tmp/m6-reviews-final-firefox-results
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4503 TMPDIR="$PWD/tmp" npx playwright test tests/browser/reviews.spec.js --project=webkit --output=tmp/m6-reviews-final-webkit-results
```

| Final review rerun | Passed | Failed | Skipped | Duration |
| --- | ---: | ---: | ---: | --- |
| Chromium | 27 | 0 | 0 | 1.3 min |
| Firefox | 27 | 0 | 0 | 1.6 min |
| WebKit | 27 | 0 | 0 | 1.4 min |

The final gate count uses **81 review passes** from the last rerun plus **40
regression passes** from the five-spec runs: **121 passed, 0 failed, 2 skipped**.
Earlier repeated executions are not added. Preview PID 514245 was stopped by exact
PID after these results; browser contexts, demo servers and compiler workers were
closed by their owning fixtures. No core dumps remain.

The six JavaScript skips require optional private Grafana/Alloy/GitLab services,
which were not started. Rust ignores are the subprocess crash fixture exercised
by its parent and an optional real-Alloy integration test. The non-Chromium
composition skips are the existing CDP-only test, unchanged. No existing test was
weakened, deleted or renamed. Tests and fixture servers clean up their own browser
contexts and processes. Final logs are worktree-local under `tmp/m6-*.log`.

## Limits and decisions

Integration must supply M5's real anchor implementation and connect the shared
artifact attachment reader; those seams are intentionally not reimplemented in
owner-6 files. After M5 merges, run the browser spec without `SCRIBYRA_REVIEW_ANCHORS`;
it uses the production service throughout, including the full-app cases. Missing
production anchors fail the feature cases explicitly; tests are not silently
skipped or switched to the fixture. The production-panel availability case always
uses the unmodified built app, even during a fixture run. The preview panel offers its isolated PDF as a labelled download, not a
second PDF.js navigation workspace. UI lists show the first 100 reviews/proposals; the batch button accepts only
displayed pending proposals. The command interface provides pagination and body chunks. The package file picker
has no foreign-file mapping form; the explicit mapping payload is supported by v2.

Quota and crash cases inject errors or close the host after a real commit; they
are not physical disk exhaustion or an OS kill during IndexedDB internals.
Fixtures are small synthetic projects, not large-project performance evidence.
Linux Playwright WebKit with Mesa does not establish Safari/macOS behavior.
Absent authority leaves proposals pending; there is no timeout failover. Remote
transport, cryptographic identity, encryption, persistent undo and real-agent/tab
attachment remain their separately owned milestones. No new decision is required;
R4/R6 field evidence, A4 and independent security review are unchanged.

## Review input corrections (November 6, 2026)

Reviewing checks its complete projection against each editor transaction and
before flush. Boundary affinity and persisted insertion order preserve typed text
beside other authors' proposals, including after idle flush and reload. A source
update rebases unaffected anchored drafts and retains conflicting text separately.
The recovery region survives navigation and offers a text download or confirmed
discard. Viewing is enforced at UI command commit paths, including file actions,
reference rewrites and search batches; trusted agents remain independent.
See the [contract amendment](annotations-design.md#review-input-corrections--6-november-2026).

The engineer resumed after disk exhaustion. Earlier logs and provisional counts
are excluded from this acceptance record; all counts below come from fresh runs.
Old browser result directories in `tmp/` were removed before running checks.
The existing preview, PID 2311302 on port 5501, was verified to belong to this
worktree. Its served index matched the rebuilt `dist/index.html` byte for byte before
browser acceptance (SHA-256
`b573e4a350181a93dd3c3458b28b9fab53792af91ec7dce1de41ac041160911c`).
No other worktree or preview process was changed.

### Real-input negative control

The 54 seeded boundary cases import `reviewingSession` from the production
`web/review-input.js`, then use the production proposal dispatcher, WASM validation,
anchors, persistence and reload. Their oracle is independently spliced editor
transaction text, not a projection reconstructed from the implementation's patches.
They cover before/inside/after pending insertions and replacements, both affinities
of collapsed deletions, protected crossings, multiple authors, Unicode,
multi-character input and undo after reload. The 512 broader production sequences
also call this input layer. Native CodeMirror/IME dispatch is covered separately
by the browser specs; the Node test does not simulate a browser.

With only `web/review-input.js` temporarily replaced by its exact contents at
`4b70ddf`, the current 54-case regression produced **24 pass / 30 fail**, exit 1.
Seed 0 expected `ab😀QXXcdeQf` but got `abXX😀QcdeQf`; seed 1 expected
`ab😀QyzNXMVeQf` after reload but got `abcdeQf`. This isolates the old input layer
with the current test/dependency harness; it is not a full checkout of the old app.
The current file was restored in a `finally` block and checked against git before
acceptance. Negative-control log: `tmp/resume-negative-control.log`.

```sh
# Run with the old input file, then restore it before npm test:
nix develop -c node --test --test-name-pattern='review boundary transaction' tests/integration-random.test.mjs
nix develop -c npm run fixtures
nix develop -c npm test
nix develop -c npm run build
```

Validation runs serially: `npm test` first, then the release build, then browsers.
The browser harness imports `web/pkg`; rebuilding WASM during its run would replace
the artifact under test. Browser core dumps are disabled with `ulimit -c 0`.

The first fresh `npm test` completed with **158 Rust pass / 0 fail / 2 ignored**
and **993 JS pass / 1 fail / 6 skipped**. The legacy-order test exposed an exact
rank-rounding defect in Rust JSON parsing: `0.46513919989131836` became
`0.4651391998913184`. A new deterministic production regression failed **0/1**
before the fix with that same mismatch. Enabling `serde_json`'s `float_roundtrip`
feature in the shared core preserves adjacent representable ranks; the rank
representation and ordering approach are unchanged. No assertion was relaxed.
A fresh WASM build passed, then input/command checks passed **23/23**.

```sh
nix develop -c node --test --test-name-pattern='adjacent insertion ranks' tests/review-input.test.mjs
nix develop -c npm run wasm
nix develop -c node --test tests/review-input.test.mjs tests/commands.test.mjs
```

The final full `npm test` passed **158 Rust / 995 JS-WASM**, with **0 failures**,
**2 existing Rust ignores / 6 existing optional-service skips**. All 54 boundary
cases passed, as did the 512 production sequences and their repeatability check.
Frozen companion/folders built and passed. Rust ignores are the subprocess crash
fixture invoked by its parent and the opt-in Alloy test. JS skips require private
Grafana/Alloy stacks or authenticated CI artifacts; these were not accessed.
Logs: `tmp/resume-npm-test.log`, `tmp/resume-rank-before.log`,
`tmp/resume-rank-wasm.log`, `tmp/resume-rank-after.log`, and
`tmp/resume-npm-test-final.log`.

The release build passed. The complete browser matrix passed **285/285** in
19.2 minutes: **95 Chromium / 95 Firefox / 95 WebKit**, zero failures or skips.
All five concurrent-patch exit routes pass in every engine: typing, undo, mode
change, file switch and project close, with retained-text download/discard/reload.
The boundary-ordering and Viewing mutation/allowed-action regressions also pass
in every engine, including native IME input through the existing adapters.

```sh
ulimit -c 0
nix develop -c env SCRIBYRA_TEST_PORT=5501 \
  __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 npx playwright test \
  tests/browser/review-workspace.spec.js tests/browser/review-editor.spec.js \
  tests/browser/reviews.spec.js tests/browser/comments.spec.js \
  tests/browser/editor.spec.js tests/browser/references.spec.js \
  tests/browser/tree.spec.js --project=chromium --project=firefox --project=webkit \
  --output=tmp/resume-browser-results
```

Fixtures, standalone WASM rebuild and release build each passed once in the
resumed run. Build log: `tmp/resume-build.log`; browser log:
`tmp/resume-browser.log`. Playwright and its fixtures closed their browsers and
owned subprocesses. No preview server was started by this resumed run; the
pre-existing PID 2311302 was reused and left untouched. Successful browser result
directories were removed; compact logs remain. No core dumps remain in the tree.
No runtime download, external service, deployment or push was performed.

The existing Firefox synthetic clipboard test now constructs its clipboard event
before setting its text because Gecko initializes the event's data on construction.
Its nonempty-payload control and source-protection assertions remain intact. No
existing test was removed, skipped, weakened or renamed to obtain a pass.

Limits: Linux Playwright engines, including software-rendered WebKit and the
existing native IME adapters; no Safari/macOS or real remote collaboration claim.
Retained drafts are device-local recovery text, outside project backups/sync;
recovery requires a deliberate fresh edit. Storage failure keeps the in-tab copy
and provides download before leaving. Coincident proposal batch acceptance keeps
its existing conflict guard. The optional ordering field requires coordinated
reader integration (older closed-schema builds reject it). No new network route,
service, styling or frozen companion/folder feature was added. No decision from
the owner is needed for these fixes; the architect retains integration/sign-off.
Roadmap checkboxes remain unchanged as requested by the specific original brief.

## Final review fixes — November 7, 2026

The implementation below supersedes the preceding review-input delivery. The
required acceptance gate has not passed; final matrix evidence and unresolved
prerequisites are recorded below.
Every accepted Reviewing input now writes its exact text synchronously to the
local recovery journal. The header becomes pending before the input returns.
Publishing a grouped proposal starts the ordinary save queue; only a successful
IndexedDB acknowledgement removes that exact journal generation. Later typing
survives an older acknowledgement. Reopening shows unfinished text in Retained
review drafts, with download and explicit discard. A failed localStorage write
retains the in-tab text and the unsaved status. Unload no longer pretends that a
synchronous proposal mutation is a durable save.

Inline projection, preview and acceptance share insertion ordering. Each proposed
binding validates before any source edit. Coincident insertions combine in display
order for the scalar patch validator. Individual acceptance, undo and redo rebind
only previously valid surviving insertions; conflicted proposals stay conflicted.
The binding event carries a validated replacement digest without changing the
immutable suggestion record. Overlapping replacements remain atomic failures.
The randomized checks independently splice expected strings, preview all remaining
insertions, accept them in different orders, and reopen the persisted project.

Project schema is now **7**, with DB 7 and record/backup format 1 unchanged. The
foundation transaction saves exact pre-upgrade bytes and migration checkpoints;
schema-6 lineage and annotations survive. Schema-6 complete backups still import,
and restored working copies upgrade before publication. The exact Rust record
validator from `a56836f` is retained as a test fixture: it rejects `insertionOrder`.
The existing old-reader head/version check refuses schema 7 before record parsing,
and its writer cannot overwrite an upgraded project. Its unsaved source remains
exportable. Already-running old code cannot receive the new input journal or new
controls; export from that tab before reloading. This is a coordinated schema
transition, not a promise to repair an already-discarded draft in an old binary.

For future upgrades, the new tab shows **Reload to update Scribyra** and **Export
before updating**. It downloads `scribyra-before-update.zip`, containing ordinary
`sources.zip`, the open `open-project.yjs` snapshot and `review-drafts.json`, then
asks the person to verify the download before reloading. A changed source revision
or draft cancels that reload. The archive is a recovery export, not a format-1
complete history backup; its source ZIP can be imported normally, and draft text
can be copied into a fresh review. No automatic application of stale draft offsets.

Viewing permits restore-as-copy. The history handler checks the actual prepared
plan again at durable commit, so a current-project plan prepared in Editing still
fails after switching to Viewing. Trusted agents keep their independent rights.

Tests that asserted the current schema changed from 6 to 7, and future-schema
negative controls from 7 to 8. No existing test was removed, skipped or weakened.
The new crash-like case bypasses unload handlers; it is not a physical OS kill or
power-loss test. Linux Playwright WebKit uses software rendering, not Safari/macOS.
Local recovery depends on browser storage and remains outside ordinary project
backups/sync. Optional service checks retain their existing prerequisites. No deployment, push, new network destination or frozen companion/folder feature
was added. Existing package tests made upstream mirror requests in earlier attempts before
those routes were identified; see the verification limit below. No new decision belongs to the owner; architect sign-off
remains required. Roadmap checkboxes remain unchanged.

### Verification commands and intermediate failures

All toolchain commands used the flake. The complete unit invocation was:

```sh
nix develop -c env CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='-C opt-level=2' npm test
```

It passed **161 Rust / 1,059 JS-WASM**, with **0 failures**, **2 existing Rust
ignores / 6 optional-service skips**. The first complete JavaScript phase took **428.898 s**; the final post-correction
run took **435.152 s** with the same counts.
The WASM-only compiler flag optimizes debug code for these repeated sequences;
it does not remove assertions, alter the test selection or change native test
profiles. Frozen companion/folders built and passed. The 36 added ordered-acceptance
sequences and 24 draft-journal sequences are included, not added again to totals.
The first complete pass is `tmp/final-npm-test.log`; after the combined-branch
corrections, the same complete command passed again with the same counts in
**426.436 s** of JS time (`tmp/final-npm-test-4.log`).

Intermediate commands below are diagnostic evidence, not acceptance totals:

| Command after `nix develop -c` | Results before final acceptance |
| --- | --- |
| `npm run wasm` | Two completed rebuilds; both passed. |
| `node --test tests/review-input.test.mjs tests/reviews.test.mjs tests/history.test.mjs` | First partial run observed 67 pass / 5 fail because it started before the schema-7 WASM rebuild completed. Second observed 71 pass / 1 fail at an outdated future-schema sentinel. Both were stopped and superseded; neither is a full pass. |
| `node --test --test-name-pattern='ordered acceptance sequence' tests/integration-random.test.mjs` | 12 pass / 24 fail: the new rebound digest still needed closed-payload validation. |
| `node --test --test-name-pattern='ordered acceptance sequence\|input journal' tests/integration-random.test.mjs` | 48 pass / 12 fail, then 60 pass / 0 fail. The failures exposed nearby surviving insertion context invalidation after a later partial acceptance. The literal shell pattern used a quoted `|`, without a backslash. |
| `node --test --test-name-pattern='ordered acceptance undo' tests/review-input.test.mjs` | 0 pass / 1 fail before survivor rebinding on undo; 1 pass / 0 fail after. |
| `node --test tests/comments.test.mjs` | 30 pass / 0 fail. |
| `node --test tests/history.test.mjs` | Duplicate diagnostic run stopped after 72 reported passes; no complete result claimed. |
| `node --test --test-name-pattern='schema 6 upgrade' tests/history.test.mjs` | 1 pass / 0 fail. |
| `node --test --test-name-pattern='schema 6 complete backup' tests/history.test.mjs` | 0 pass / 1 fail because the test retained the original lineage; after erasing the original before recovery, 1 pass / 0 fail. |
| `npm test` | First run stopped with 100 Rust pass / 1 fail at schema-6 backup validation. Second: 161 Rust pass / 0 fail / 2 ignored; JS reported 600 pass / 2 fail / 6 skips. One failure was the backup-test setup above; the other was the deliberately terminated randomized child after that known failure. It was superseded by the complete final run. |

The initial focused runs are recorded honestly as partial runs. Final acceptance
uses one complete unit run. Compact logs are `tmp/final-{wasm,wasm-2,focused,
focused-2,order,order-2,order-3,undo,undo-2,comments,history,migration,backup,
backup-2,npm-test-1,npm-test-2}.log`. Rust formatting ran with
`nix develop -c rustfmt --edition 2024 --config skip_children=true crates/core/src/comments.rs crates/core/src/collaboration_schema.rs crates/core/src/history.rs crates/app/src/lib.rs`;
unrelated pre-existing app formatting was restored. `git diff --check` passes
on the final source changes.

The first production command `nix develop -c npm run build` passed; Vite's phase took
**12.89 s**. Existing third-party Rollup annotation warnings were nonfatal. The
preview was started by this run, PID **2480622**, on **5401**. Its served index
matched `dist/index.html` byte for byte (SHA-256
`d1995c33f05737cf03c3774fa6c7dcc98078dcb0235b3a89459e10b0015ce475`).
No upstream TeX runtime was downloaded or reprovisioned; fixtures were already
generated as supplied. Browser download tests use the locally served assets.

```sh
nix develop -c bash -c 'ulimit -c 0; echo $$ > tmp/final-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5401 --strictPort'
# Both browser commands below ran after npm test and the production build.
ulimit -c 0
nix develop -c env TMPDIR="$PWD/tmp" SCRIBYRA_TEST_PORT=5401 \
  __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 npx playwright test \
  tests/browser/review-workspace.spec.js tests/browser/history.spec.js tests/browser/local-tabs.spec.js \
  --grep='review input survives|preserves order through reload|Viewing permits|newer schema' \
  --project=chromium --project=firefox --project=webkit --trace=off --reporter=line \
  --output=tmp/final-focused-browser-results
nix develop -c env TMPDIR="$PWD/tmp" SCRIBYRA_TEST_PORT=5401 \
  __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 npx playwright test \
  --project=chromium --project=firefox --project=webkit --trace=off --reporter=line \
  --output=tmp/final-browser-results
```

The first focused browser run passed **12 / failed 9**. The new test incorrectly
read Leptos's DOM synchronously inside the CodeMirror input task. The corrected
check asserts the synchronous pending state notification and recovery write,
then the rendered status on the next animation frame, with elapsed time **under
900 ms**. It then performs actual reload, tab close or unload-bypass reload.
The second focused run passed **21/21** (7 in each engine), zero failures/skips,
in **1.1 minutes**. It also checks ordered individual/batch acceptance, explicit
upgrade export and Viewing copy/current policy. No existing assertion was relaxed.
Logs: `tmp/final-focused-browser.log`, `tmp/final-focused-browser-2.log`.
The focused result directory was removed before the full matrix.

The first full-matrix attempt was deliberately interrupted after 28.8 minutes:
203 passed, 8 failed, 1 interrupted, 2 skipped and 692 not run. It is diagnostic
evidence only, not an acceptance run. The interrupted case waited for an Accept
button intentionally hidden in Viewing; the corrected test asserts that it is
hidden and invokes the guarded action directly, retaining its denial/source
assertions. The attempt exposed additional combined-branch regressions.
The legacy comment-panel assertions need their intended Messages-list scope now
that inline cards also show the message. The compiler-status selector needs its
explicit button because the footer also has a log button. Error diagnostics must
retain their actionable recovery text. The UI command adapter must preserve the
original actor when retrying a retained decision. Selection dismissal must reset
on selection transactions, including transitions occurring within one frame.
A fully undone review edit must still obtain durable acknowledgement before its
input journal is cleared. These are corrections, not reasons to remove assertions.
The separate-host Pages test additionally requires a locally assembled root shell.

The native-IME review-editor helper now honors the absolute URL its isolated
Firefox/WebKit contexts already supply, instead of incorrectly navigating to a
relative URL without a base URL. The first correction build passed
(`nix develop -c npm run build`, Vite 12.96 s).

The correction-focused invocation selected ten cases per engine:

```sh
ulimit -c 0
nix develop -c env TMPDIR="$PWD/tmp" SCRIBYRA_TEST_PORT=5401 \
  __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 npx playwright test \
  tests/browser/annotations-integration.spec.js tests/browser/compatibility.spec.js \
  tests/browser/integration-review.spec.js tests/browser/review-editor.spec.js tests/browser/review-workspace.spec.js \
  --grep='comment and suggestion share|annotation changes preserve|project package and OTF|missing fonts,|actual UI Retry|a card or highlight|Viewing refuses native IME|conflicting agent patch.*undo|Viewing refuses existing' \
  --project=chromium --project=firefox --project=webkit --trace=off --reporter=line \
  --output=tmp/final-corrections-results
```

This correction run passed 27 and failed 3 (one per engine), 0 skips, in
9.4 minutes. All three failures were the Viewing denial assertion: the main UI
reports that guard in Workspace notification, before reaching review status. The
test now dismisses the earlier notification and checks the exact new explanation
after attempting acceptance. Source-preservation and hidden-button assertions
remain. Log: `tmp/final-corrections.log`.

The follow-up used the same browser environment/options, selecting only
`tests/browser/review-workspace.spec.js --grep='Viewing refuses existing'`,
with `--output=tmp/final-viewing-results`: **3/3 passed**, zero failures/skips,
15.5 seconds (`tmp/final-viewing.log`). Both correction result directories were
removed.

For final acceptance, `nix develop -c npm run build:pages` passed (app Vite
13.71 s, root shell 7.28 s), then `nix develop -c npm run build` passed
(Vite 12.99 s). The root preview's served index matched `dist/index.html`:
`dbc0a4b77a2ddef9d75a68d93945b35f0eaf7f572014073859c3ae335f7e62a5`.
A disposable Python standard-library server served only `.pages` on loopback
port 35753 (owned PID 2519886); root-app preview remained owned PID 2480622 on
5401. This supplies the existing Pages prerequisites without a deployment.

```sh
ulimit -c 0
nix develop -c env TMPDIR="$PWD/tmp" SCRIBYRA_TEST_PORT=5401 \
  SCRIBYRA_TEST_PAGES_URL="$(cat tmp/final-pages-url)" \
  PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/tmp/final-browser-report.json" \
  __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 npx playwright test \
  --project=chromium --project=firefox --project=webkit --trace=off \
  --reporter=line,json --output=tmp/final-browser-results
```

The next full-matrix attempt was interrupted after **284 passed, 0 failed,
1 interrupted, 2 skipped, 619 not run** (29.6 minutes). The existing test
`IEEEtran class downloads from the live mirror...` uses the external TeX mirror;
it completed before this route was identified. The earlier multilingual
compatibility test also fetches `babel-romanian` from that mirror despite a
local fixture being available to other tests. Request counts were not recorded.
This contradicts the requested
no-external-services constraint and is explicitly not claimed as compliant
acceptance. No further external fetch was authorized. The pinned archive
(`ieeetran`, 89,368 bytes, SHA-512 beginning `7712cc4a26fe8b01`) is absent from
this worktree's fixtures/assets and the local package cache. Searches of the
provisioned Nix store were bounded and stopped without a match; this does not
claim an exhaustive store audit. Substituting different bytes would bypass the
catalog integrity check. No test was skipped or weakened to hide this.

The constrained diagnostic full-matrix command adds `--config=tmp/final-offline.config.mjs` to
the preceding invocation, with log `tmp/final-browser-3.log`. The temporary
configuration preserves every test and assertion and blocks non-loopback
transport through an unused local proxy port:

```js
import base from '../playwright.config.js';
export default {...base,testDir:new URL('../tests/browser',import.meta.url).pathname,
  use:{...base.use,proxy:{server:'http://127.0.0.1:9',bypass:'127.0.0.1,localhost'}},
  webServer:{...base.webServer,cwd:process.cwd()}};
```

This is a test-run constraint, not an application network configuration change.
The existing mirror test remains selected and is expected to fail if its archive
is unavailable; its result belongs in acceptance totals, not in the skip count.

The constrained run also exposes the multilingual test's unmocked
`babel-romanian` route: `Could not install babel-romanian r77682: Failed to
fetch`. Its existing local fixture is used by other fault-injection tests, but
this spec does not route that request to it. The missing IEEEtran archive remains
an independent prerequisite for a wholly offline acceptance run.

That diagnostic constrained attempt was stopped after **291 passed, 7 failed,
1 interrupted, 11 skipped, 596 not run** (32.3 minutes). Three failures were
unrouted upstream-package dependencies (multilingual, Romanian workspace,
IEEEtran); three were stale Compile selectors in telemetry isolation; one was
the missing pinned Alloy executable. The two Romanian specs now use the retained
checksum-pinned fixture, while preserving production unpacking/cache checks and
refusing any fixture fetch during offline mode. The Compile selectors now name
the exact action instead of also matching Compile options. The same obsolete
selector was corrected in the optional telemetry-failures spec. Missing Alloy
now fails before starting fixture processes; it is not converted to a skip.

The correction-focused command uses the same closed-proxy configuration and
browser environment, with these spec/selection arguments:

```sh
npx playwright test --config=tmp/final-offline.config.mjs \
  tests/browser/compatibility.spec.js tests/browser/workspace.spec.js tests/browser/telemetry-isolation.spec.js \
  --grep='multilingual class-loaded|Romanian custom class|collection preserves' \
  --project=chromium --project=firefox --project=webkit --trace=off --reporter=line \
  --output=tmp/final-offline-corrections-results
```

This focused run finished **15 passed / 3 failed / 0 skipped** in 17.9 minutes.
All three failures are the stopped-collector case (one per engine):
`Pinned Alloy test executable is unavailable: .../.cache/telemetry-tools/alloy-v1.21.3`.
All local Romanian-package, disabled, slow and rejecting cases passed. The
result directory was removed; compact log: `tmp/final-offline-corrections.log`.

After the fixture and selector corrections, the complete optimized-WASM
`npm test` command passed again: **161 Rust / 1,059 JS-WASM**, **0 failures**,
2 existing Rust ignores and 6 optional-service skips; JS duration **435.152 s**.
Log: `tmp/final-npm-test-5.log`.

The final post-correction builds passed: `nix develop -c npm run build:pages`
(Vite 12.80 s / root shell 7.81 s), then `nix develop -c npm run build`
(Vite 12.98 s). Root preview SHA-256 matches `dist/index.html`:
`efcc7d0802b107bac7a219c030a436103905e6f4c434830d384d0f718cb208df`.
The complete final browser invocation uses the preceding closed-proxy config,
all three `--project` selections, all 906 cases, and no grep filter.
Log: `tmp/final-browser-4.log`.


### Final uninterrupted matrix: acceptance not passed

All **906 cases** ran in one uninterrupted invocation after the final unit and
build checks, with no retries or selection filter. Exit status **1**; duration
**7,404.553 seconds** (2 h 3 min 24.553 s). Results:

| Engine | Passed | Failed | Existing skips |
| --- | ---: | ---: | ---: |
| Chromium | 290 | 2 | 10 |
| Firefox | 289 | 2 | 11 |
| WebKit | 288 | 3 | 11 |
| Total | **867** | **7** | **32** |

The 21 requested browser regressions all passed in this matrix, including real
reload, tab close, unload-bypass navigation inside the flush window, ordered
acceptance/reload, Viewing restore permissions and export-before-update. The
32 existing skips comprise 8 cases for another engine's native IME adapter and
24 optional telemetry cases requiring explicitly configured services/tools.
No test was newly skipped to obtain these results.

Six failures are unavailable acceptance prerequisites: IEEEtran in every engine
(`Expected: "Undefined control sequence"; Received: "Could not load TeX package:
ieeetran"`) and stopped collection in every engine (`Pinned Alloy test executable
is unavailable: .../.cache/telemetry-tools/alloy-v1.21.3`). The seventh is WebKit's
separate-process WebRTC exchange: after 20 seconds its connection state remained
`new`, expected `connected`. The other local service tests passed. A focused
loopback-only diagnostic below checks whether the temporary proxy explains it;
that result cannot replace the failed full matrix.

Exact final invocation:

```sh
ulimit -c 0
nix develop -c env TMPDIR="$PWD/tmp" SCRIBYRA_TEST_PORT=5401 \
  SCRIBYRA_TEST_PAGES_URL="$(cat tmp/final-pages-url)" \
  PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/tmp/final-browser-report.json" \
  __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 npx playwright test \
  --config=tmp/final-offline.config.mjs \
  --project=chromium --project=firefox --project=webkit \
  --trace=off --reporter=line,json --output=tmp/final-browser-results
```

Compact log and extracted counts/errors are retained in
`tmp/final-browser-4.log` and `tmp/final-browser-summary.json`. Neither a passing
whole-browser acceptance gate nor readiness to ship is claimed. The pinned
archive and Alloy prerequisite must be provisioned under the architect's
constraints before a clean full-matrix rerun.


The unchanged WebKit test was then rerun without the proxy: **0 passed / 1 failed /
0 skipped**, exit 1, with the identical `new` versus `connected` timeout. Exact
command (same local preview, no STUN or external service):

```sh
ulimit -c 0
nix develop -c env TMPDIR="$PWD/tmp" SCRIBYRA_TEST_PORT=5401 \
  __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/service.spec.js \
  --grep='two separate browsers' --project=webkit --trace=off --reporter=line \
  --output=tmp/final-webrtc-results
```

A temporary diagnostic copy retained the same assertions and recorded peer state
in a `finally` block around the failing poll. With the same flake/environment,
`npx playwright test --config=tmp/final-webrtc.config.mjs --grep='two separate browsers' --project=webkit --trace=off --reporter=line --output=tmp/final-webrtc-diagnostic-results`
also finished **0 passed / 1 failed / 0 skipped**. Both peers had stable signaling,
completed gathering, one emitted candidate, received offer/answer and candidate,
no relay errors, zero remote-candidate stats and zero candidate pairs. Candidates
were `.local` names. Host WebKit mDNS/ICE handling is a plausible explanation,
not a proven root cause; the proxy alone does not explain it. No timeout or
assertion was relaxed. Local service delivery succeeds, but WebKit connection
acceptance remains unresolved. Compact diagnostics:
`tmp/final-webrtc.log`, `tmp/final-webrtc-diagnostic.log`,
`tmp/final-webrtc-summary.json`; full synthetic SDP/certificates were discarded.


Cleanup: owned preview PIDs **2480622** and **2519886** were terminated by exact
PID and their sessions reaped. No browser/service process remained with this
worktree as its working directory. Removed all `tmp/final-*-results` directories,
root `test-results` screenshots/benchmarks and the full browser JSON report;
compact logs/counts remain for independent review. No core dumps were left.
`git diff --check` passed; roadmap checkbox lines were compared against HEAD and
are unchanged. The evidence row records failed acceptance, not completion.

## Suggestion discussion — November 7, 2026

Suggestions now retain discussion through acceptance, rejection, withdrawal and
batch undo/redo. Open shows pending/conflicted proposals; Resolved shows decided
proposals with the outcome and decision author, plus their replies. Acceptance
undo returns the proposal and discussion to Open. Replying changes neither the
immutable proposal nor accepted source. Resolved cards remain discussable.

A thread's optional `suggestionId` names its original immutable proposal;
`reviewId` and `anchorId` must match. Revision/supersession groups discussion along
an unambiguous successor chain without changing those references. Forks retain
ancestral discussion at the branch rather than choosing one child. Accepted or
rejected proposals retain their own discussion. All replies remain independently
addressable by their original thread IDs. Suggestions still prohibit manual anchor
reattachment. Restore projects historical records and events together.

Project schema is **8**, DB 7 and record/backup formats remain 1. The closed
schema-7 thread decoder rejects `suggestionId`, so this uses the foundation's
coordinated migration and exact recovery copy instead of writing incompatible
records under schema 7. Schema-7 projects/backups retain lineage, source and
existing annotations, and old writers cannot overwrite upgraded heads. The schema
constant tests and future-version sentinels now reflect 8/9 respectively.

Review exchange includes suggestion threads through their `reviewId`. Foreign
mapping remaps the thread with its suggestion and preserves supersession links;
it does not request a separate comment-anchor selection. Message edits/redactions
remain effective after mapping, while imported source decisions remain evidence.
The compact served agent recipe documents `thread.reply {suggestionId,body}`;
`describe()` advertises the existing thread operations and comment rights.

### Suggestion discussion verification

Commands ran from the dedicated worktree through its flake. Debug WASM used
`CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='-C opt-level=2'`; the production
build used the normal release profile. No compiler runtime was downloaded.

| Command | Result |
| --- | --- |
| `nix develop -c npm run fixtures` | Pass, once in this worktree. |
| `nix develop -c env RUST_TEST_THREADS=1 CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='-C opt-level=2' npm test` | 162 native pass / 0 fail / 2 existing ignores; 1,073 JS/WASM pass / 0 fail / 6 optional-service skips. Includes all 512 randomized integration sequences with suggestion replies and immutable-target/source invariants; frozen companion/folders build and tests. |
| `nix develop -c node --test --test-name-pattern='suggestion discussion\|comment-only actors\|accepting a batch\|review exchange retains' tests/integration-review.test.mjs` | 8 pass / 0 fail / 0 skip. |
| `nix develop -c node --test tests/comments.test.mjs tests/integration-review.test.mjs` | Two focused runs: 59 pass / 0 fail / 0 skip each, including the final release WASM after the composer-target correction. |
| `nix develop -c npm run build` | Both builds passed, including the final composer-target correction; cached compiler assets verified, release WASM and Vite built. |

The first explicit `nix develop -c env CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS='-C opt-level=2' npm run wasm`
failed with `error[E0308]: mismatched types` in a Leptos `Show` comparison. Bracing
the comparison fixed it; both subsequent explicit WASM builds passed, as did the
WASM build within `npm test`. No test assertion was weakened. Current-schema
expectations changed from 7 to 8, and future-version sentinels from 8 to 9.
The native ignores are the subprocess crash fixture (run by its parent test) and
the opt-in Alloy integration. The six JS skips require private telemetry services;
no credentials or external service were accessed.

Browser checks use port **5701**, a preview started from this worktree's `dist`
(served `index.html` SHA-256 matched the built file), and a temporary config
extending `playwright.config.js`. Its only changes are explicit test/server
directories and a dead non-loopback proxy with localhost bypass, keeping checks
local. Separate output directories prevent cross-engine artifact cleanup races;
workers and assertions are unchanged. Commands use `ulimit -c 0` and `--trace=off`.
To reproduce that config at `tmp/suggestion-threads/playwright.config.mjs`:

```js
import base from '../../playwright.config.js';
export default {...base,
  testDir:new URL('../../tests/browser',import.meta.url).pathname,
  use:{...base.use,proxy:{server:'http://127.0.0.1:9',bypass:'127.0.0.1,localhost'}},
  webServer:{...base.webServer,cwd:process.cwd()}};
```

The following command was run once per engine, expanding `ENGINE` to `chromium`,
`firefox` and `webkit`; WebKit additionally received the software-renderer
environment shown below, inside `nix develop -c env`:

```sh
nix develop -c env SCRIBYRA_TEST_PORT=5701 \
  PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/tmp/suggestion-threads/final-ENGINE.json" \
  bash -c 'ulimit -c 0; exec npx playwright test \
  --config=tmp/suggestion-threads/playwright.config.mjs \
  tests/browser/comments.spec.js tests/browser/reviews.spec.js \
  tests/browser/review-workspace.spec.js tests/browser/review-editor.spec.js \
  tests/browser/history.spec.js tests/browser/integration-review.spec.js \
  tests/browser/annotations-integration.spec.js tests/browser/agent-recipe.spec.js \
  tests/browser/agent-surface.spec.js --project=ENGINE --trace=off \
  --reporter=line,json --output=tmp/suggestion-threads/final-ENGINE-results'
# Additional WebKit environment:
# __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json
# LIBGL_ALWAYS_SOFTWARE=1
```

The first matrix was stopped deliberately after an independent interaction probe
found two visible composers when navigating from a suggestion reply to a source
thread through Review tools. Chromium had 31 pass / 1 interrupted / 156 unrun;
Firefox 12 / 1 / 175; WebKit 40 / 1 / 147. These are partial runs, not acceptance.
The card now selects the composer target by its current mode, so a retained
suggestion ID cannot mount a source-thread composer. A new browser regression
checks exactly one input on the correct card, its sent thread and unchanged source.
Against the previous build, the regression failed as intended: `Expected: 1`,
`Received: 2` for `#comment-body:visible` (1 fail / 0 pass). This negative control
used the same Chromium command with `--grep="switching from suggestion discussion"`.
After the corrected production build, the same selected regression ran in all
three projects: **3 pass / 0 fail / 0 skip**. The full unit run preceded this final
UI-only target-selection correction; the final build and browser matrix include it.

The restarted matrix reported Chromium **189 pass / 0 fail / 0 skip** (exit 0),
Firefox **189 / 0 / 0** but runner exit **143** after writing its complete report,
and WebKit **188 / 1 / 0**. WebKit's existing narrow-history test failed
`toBeFocused`: `Expected: focused`, `Received: inactive` on the first version
option after opening Versions. Five unchanged repetitions of that case passed
(`history.spec.js --grep="collapses the version list" --project=webkit --repeat-each=5`).
The failure was intermittent; there is no proven cause or claimed focus fix.
The full Firefox and WebKit suites were repeated, with identical test arguments
and `firefox-rerun` / `webkit-rerun` artifact prefixes, to obtain clean completion.
Both full repeats completed with **189 pass / 0 fail / 0 skip**, exit 0.
Together with Chromium, the final required nine-spec acceptance is **567 passed,
0 failed, 0 skipped**. No assertion, timeout or test was weakened or removed.

Before that matrix, the same local config ran Chromium's `review-workspace`,
`history`, `agent-recipe` and `integration-review` specs with
`--grep="suggestion replies|suggestion (accept|reject|withdraw)|reply draft follows|suggestion discussion recovery|served suggestion reply|production agent imports"`:
**12 pass / 0 fail / 0 skip**. The new agent test uses the existing Pages-aware
`app/` URL when `SCRIBYRA_TEST_PAGES_URL` is set. No Pages deployment was performed.

The changed migration expectations also passed **18/18** across all three engines:

```sh
nix develop -c env SCRIBYRA_TEST_PORT=5701 \
  PLAYWRIGHT_JSON_OUTPUT_FILE="$PWD/tmp/suggestion-threads/migration-browser.json" \
  __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 bash -c 'ulimit -c 0; exec npx playwright test \
  --config=tmp/suggestion-threads/playwright.config.mjs \
  tests/browser/foundation.spec.js tests/browser/local-tabs.spec.js \
  --grep="upgrades with exact recovery copy|newer schema fails closed" \
  --trace=off --reporter=line,json \
  --output=tmp/suggestion-threads/migration-browser-results'
```

`nix develop -c bash -c 'ulimit -c 0; exec node tmp/suggestion-threads/shots.mjs'`
captured four 1366×768 PNGs, adapting the supplied design-merge screenshot script.
All four were read: light/dark Overview with a two-person suggestion discussion
and a collapsed accepted proposal, plus light/dark Resolved with the accepted
discussion expanded. Shared comment styling needed no further adjustment.
Artifacts remain uncommitted in `tmp/suggestion-threads/screenshots/` as
`1366-{light,dark}-discussion-{all,resolved}.png`.

The owned preview PID **2983496** was stopped by exact PID and reaped. No browser
or Node process remained with this worktree as its working directory; no core
dumps were left. `git diff --check` passed. No push or deployment was performed.

Synthetic Linux browsers and injected faults do not establish Safari/macOS, physical storage
failure or remote collaboration. Existing record/message limits and session-local
acceptance undo apply. Unsent reply drafts remain device-local. No new decision
belongs to the owner; architect review and the separately tracked R4/R6 gates remain.

### Suggestion discussion review follow-up — November 7, 2026

Final acceptance is complete for this review scope:

| Check | Result |
| --- | --- |
| `npm test` | **162 native + 1,077 JS/WASM passed; 0 failed**. Two existing native ignores and six optional service skips. Includes all 512 strengthened seeds and their deterministic repeat; JS/WASM phase 2,079.9 s. Frozen companion/folders tests and builds passed. |
| `npm run build`; `npm run fixtures` | Both passed; no TeX runtime download. |
| Seven required browser specs | **183/183 per engine; 549 passed, 0 failed, 0 skipped** in the final full runs. First WebKit run: 182 passed / 1 existing focus failure; complete unchanged rerun: 183 passed. |
| Focused regressions | 56/56 JS/WASM; 2/2 seeded selections; 2/2 release cycle/palette checks; 2/2 settled Chromium/Firefox captures. |
| Visual/contrast evidence | Six final screenshots inspected; all five authors activated in light/dark in every engine. Minimum deletion contrast 4.87:1 light / 5.76:1 dark. |


Restore validation now checks projected record shapes and identities, including
legacy embedded restore records. A thread cannot change its original suggestion,
anchor, review or opening-message identity; replies cannot change threads.
Suggestion supersession cycles are rejected by the shared ingestion validator.
The defensive projection keeps original targets on ambiguous chains, and the
workspace shows explicit incomplete cards instead of filtering their discussions
away. Missing-target discussions remain visible too.

Review export selects records and comment events through the Rust history
reducer. It collapses causal edges through restore boundaries and gives changed
events stable identities; terminal decisions and excluded events are separate
inert evidence. Foreign import applies the same selection to older raw packages
before remapping IDs. No imported acceptance changes accepted source. Same-lineage
import still merges into the current local state; it is not a remote restore and
does not delete local records omitted by a package.

Five muted author colours share card and editor attribution in both themes.
Insertion tints use 10% colour, strengthened to 18% when active; deletion text uses
the full contrast-bearing author colour. Matching-selection highlights use a soft
theme-aware tint, avoiding CodeMirror's green overlay obscuring the author marks.
The new browser audit activates all five authors in both themes and checks editor
and card contrast, including repeated replacement text.

Regressions cover forged direct/nested restore targets, cyclic package ingestion
and visible incomplete cards, selected discussion exchange after revision and
restore, post-restore edits, and retained acceptance evidence. Each of the 512
production seeds now follows its original reply through revision, restore and
foreign exchange, checking original thread identity, the selected proposal and
exclusion of the later reply.

The validation follow-up avoids reparsing projected records that exactly equal an
already validated raw record, and only copies the identity map when a restore
supplies a previously absent record. Differing projections still receive complete
shape and identity checks. Wrong-root targets and extra projected fields have
regressions too. This followed an interrupted full unit attempt in which the
existing 30-restore case took 428 seconds; the final gate below uses the optimized
validator. The final debug-WASM stress case passed in 409.4 seconds. These
concurrent runs are not a controlled performance comparison or a measurement of
release UI latency; the observed timing improvement was modest.

Verification uses port 5701, provisioned compiler assets and the repository flake.
The frozen companion and folder crates are included in `npm test`. The six
optional telemetry/service tests and two native ignores retain their existing
conditions; no existing test was weakened or removed. Synthetic Linux engines
and software-rendered WebKit do not establish Safari/macOS or remote peer
transport. Attribution remains descriptive, imports do not confer decision
authority, and unresolved restore selections fail export instead of guessing.
No owner decision, push, deployment or new network destination is involved.

Commands for the final acceptance (each engine invocation had its own output
folder and used the same owned preview of the production `dist`):

```sh
nix develop -c npm run fixtures
nix develop -c npm test
nix develop -c npm run build
nix develop -c env SCRIBYRA_TEST_PORT=5701 bash -c 'ulimit -c 0; exec npx playwright test tests/browser/{comments,reviews,review-workspace,review-editor,history,integration-review,accessibility}.spec.js --project=chromium --trace=off --reporter=line --output=tmp/suggestion-threads/acceptance-chromium-results'
nix develop -c env SCRIBYRA_TEST_PORT=5701 bash -c 'ulimit -c 0; exec npx playwright test tests/browser/{comments,reviews,review-workspace,review-editor,history,integration-review,accessibility}.spec.js --project=firefox --trace=off --reporter=line --output=tmp/suggestion-threads/acceptance-firefox-results'
nix develop -c env SCRIBYRA_TEST_PORT=5701 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 bash -c 'ulimit -c 0; exec npx playwright test tests/browser/{comments,reviews,review-workspace,review-editor,history,integration-review,accessibility}.spec.js --project=webkit --trace=off --reporter=line --output=tmp/suggestion-threads/acceptance-webkit-results'
```

Focused checks also ran through `nix develop -c`:
`node --test tests/integration-review.test.mjs tests/reviews.test.mjs` passed
**56/56**, both before and after the validation optimization;
`node --test --test-name-pattern='production sequence seed=90644518$|seed 90644525 repeats' tests/integration-random.test.mjs`
passed **2/2**. Chromium's release `reviews`/`review-editor` run with
`--grep="five author colours|cyclic grouping"` passed **2/2**.

Intermediate attempts are not acceptance: an early focused invocation preceded
the WASM export (two module-load failures); the first compiled run passed 49 and
failed 7, exposing copy-provenance and object-key-order compatibility problems;
a build/WASM overlap then ran stale output (50 pass / 6 fail). Corrected focused
runs passed 56/56. The first palette audit failed on the green matching-selection
overlay; after correction it passed, while the debug-build corrupt-state browser
closed during harness loading. The release retry caught a strict selector matching
both proposal and reply headers (1 pass / 1 fail); selecting the proposal header
fixed it, and the final release retry passed 2/2. The first full unit attempt was
stopped for validation cost after its native checks passed, without a JS total.
No failed attempt or partial run is counted as a passing gate.

The first full WebKit matrix passed **182** and failed **1**: the existing
`history.spec.js:316` narrow version-list check reported `Expected: focused`,
`Received: inactive`, after 60,000 ms. The same intermittent failure is recorded
in the earlier discussion delivery above. Its assertion and application code
were left unchanged for the complete rerun. Chromium and Firefox each passed
**183/183**, with no skips.

After inspecting Firefox's screenshots, the palette test was tightened to await
the eight-pixel card gaps before capture. The additional release run
`npx playwright test tests/browser/review-editor.spec.js --project=chromium --project=firefox --grep="five author colours" --trace=off --output=tmp/suggestion-threads/settled-palette-results`
(through the flake, port 5701, core dumps disabled) passed **2/2**.

The final five-author audit passed in every engine: **30 engine/theme/active-author
combinations**, no axe contrast violations, minimum measured deletion contrast
**4.87:1 in light** and **5.76:1 in dark** in each engine. All six settled 1366×768
screenshots were read: `tmp/suggestion-threads/screenshots/{chromium,firefox,webkit}-{light,dark}-five-authors.png`.
The PNGs and small contrast JSON files stay uncommitted; the reproducible capture
and assertions are in `review-editor.spec.js`.

The complete WebKit rerun passed **183/183**, exit 0, using the same command with
`--output=tmp/suggestion-threads/acceptance-webkit-repeat-results`. Final required
browser gates are therefore **549 pass / 0 fail / 0 skip** across the three full
successful runs; the earlier WebKit run remains **182 pass / 1 fail** separately.
The owned preview PID **3171145** was stopped by exact PID and reaped after the
browser runs exited. Port 5701 was empty and no core dumps were found in the tree.

Final `git diff --check` passed. The roadmap task and delivery row were updated
without reordering milestones. All implementation/evidence commits carry the
requested Codex co-author footer; no push or deployment was performed.

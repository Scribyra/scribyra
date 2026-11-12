# Foundation F delivery evidence

This implements the foundation boundary in [the annotation contract](annotations-design.md#ownership-and-the-prerequisite-foundation-f), not milestones 5–7. The original delivery needed no contract amendment; the [review corrections](#review-corrections-to-5d27827) amend the durable-dispatch and build seams without a new product decision.

## Delivered boundary

- Rust owns shared schema/version/limit constants, closed record shapes, namespace rights and the internal v2 envelope. Feature validators and dispatchers have separate typed stubs. The app registers separate panel state/mounts; all stubs remain invisible and unadvertised.
- JS exposes lifecycle, validation, transfer, anchor, origin/undo and trusted command registration seams. V1 parsing remains unchanged. There is no new window API. Every document update advances command revisions; only source-affecting changes invalidate accepted PDF/navigation, and only local source changes schedule auto-compile.
- Schema 6 derives migration lineage with the specified UUIDv5 namespace. DB 7 preserves the exact pre-6 update in `migrationBackupsV2`, retains the existing first backup and asset pins, compares accepted content/tree/trash/assets/locks in Rust, and atomically writes the migration journal/checkpoint/head. Earlier checkpoints remain byte-exact, including projects without a prior journal. Failed transactions publish nothing.
- Guarded commits compare the committed sequence, verify immutable history objects before opening the transaction, and persist objects/pins/update together. Ordinary saves and merged local-tab previews share full-state validation. No retention, restore, review acceptance or annotation algorithm is implemented.

## Checks and reproduction

All toolchain work used `nix develop -c`. TeX assets were regenerated from already provisioned inputs by the existing build; no runtime download was requested. The preview process was owned by this run, PID **272754**, on **4373**, serving this worktree's `dist`; it was stopped by exact PID after verification. Browser/test servers were closed by their owning fixtures.

Final commands (run each browser separately):

```sh
nix develop -c env TMPDIR="$PWD/tmp" npm test
nix develop -c npm run build
ulimit -c 0
nix develop -c env SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js tests/browser/foundation.spec.js --project=chromium
nix develop -c env SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js tests/browser/foundation.spec.js --project=firefox
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js tests/browser/foundation.spec.js --project=webkit
```

| Final check | Passed | Failed | Skipped / ignored | Duration |
| --- | ---: | ---: | ---: | --- |
| Native Rust (`npm test`, including frozen crates) | 137 | 0 | 2 ignored tests | Per-suite timings in local run log |
| JavaScript/WASM (`npm test`) | 219 | 0 | 6 optional private-service tests | 11.6 s JS phase |
| Production build | 1 | 0 | 0 | 14.4 s Vite phase; also ran assets/WASM stages |
| Chromium, seven specs | 34 | 0 | 0 | 2.6 min |
| Firefox, seven specs | 33 | 0 | 1 Chromium-only composition test | 3.5 min |
| WebKit, seven specs | 33 | 0 | 1 Chromium-only composition test | 3.3 min |

The final browser matrix has **100 passes, 0 failures and 2 platform skips**. Its **42/42 foundation cases** are included in that total. The 24 new foundation unit cases are included in the JavaScript total, not additional to it. The six optional JavaScript skips require private Grafana/Alloy/GitLab test infrastructure, which was not started for this goal. The Rust ignores are one subprocess fixture exercised by its parent crash-recovery test and one optional real-Alloy integration test.

The six existing browser specs retain their assertions. `commands.spec.js` uses a test-only WebSocket forwarding hook on non-4173 ports, supplying the frozen demo's permitted Origin to its real Rust server. Browser profiles, Yjs state, command races and persistence remain real; this does not claim that the demo itself accepts origin 4373. No application/demo/companion allowlist was changed. The injected foundation harness blocks service workers because it is not a deployed asset; the existing editor/local-tabs specs still exercise offline application behavior with the production worker.

## Earlier failures and corrections

- First focused existing unit run: 54 pass / 1 fail. An assertion still expected schema 5. Existing schema/DB expectations now name schema 6 / DB 7; the future-schema assertion moved from 6 to 7. No assertion was weakened or removed.
- First foundation unit run: 19 pass / 1 fail. It exposed agent/human undo coalescing; the capture boundary now closes after Yjs records the transaction. Follow-up focused runs passed 25/25, 34/34 and 23/23 foundation cases. A final additional async-preparation guard brings the foundation unit count to 24, included in the final `npm test` total.
- Two Chromium harness attempts each timed out on the first fixture inspection (13 cases unrun). Esbuild returned a Uint8Array that Playwright's response body did not serve as JavaScript; using its text output fixed the test harness. A subsequent focused Chromium run passed all 14 foundation cases in 1.6 minutes.
- The first full Chromium attempt had 34 browser-launch failures before assertions: the deliberately worktree-local temporary path exceeded Chromium's Unix socket limit. All resulting core dumps were removed; the shorter worktree `tmp` path works, with core dumps disabled.
- The first Firefox matrix passed 32 cases, skipped the Chromium-only composition case, and failed one fixture with `WebAssembly.Instance(): Import #25 ... function import requires a callable`. Running `npm test` concurrently had replaced generated WASM bindings between worker loads. Final verification runs WASM-producing commands before, never alongside, browser tests.
- A plain extra-Origin-header attempt for the frozen demo failed (1 timed-out command case / 1 unrun). A scoped test transport hook replaced that attempt; the focused command spec then passed 2/2 in 11.3 seconds. The original demo implementation remains unchanged.
- The pre-refactor Chromium matrix also passed 34/34; it was rerun after v1/v2 replay helpers were consolidated. Only the final matrix is counted in the delivery row.

## Limits

Quota failures are injected IndexedDB exceptions, not physical disk exhaustion. Fixtures are small synthetic projects with retained exact update/asset/first-backup bytes; no large real-project migration benchmark is claimed. Browser coverage is Linux Playwright Chromium, Firefox and software-rendered WebKit, not Safari/macOS. Foundation stubs do not count as comments/reviews/history gates, and origin attribution is not authentication. Real agents, real-tab attachment, independent profiles exchanging review packages, network collaboration, encryption and complete-backup restoration remain later milestones. The existing R4/R6 field tests, A4 and the independent security review remain open.

## Review corrections to `5d27827`

The follow-up fixes three foundation defects; it does not implement milestones
5–7. The durable-dispatch and isolated-build additions are recorded separately in
[the amended contract](annotations-design.md).

- `commitPrepared` owns ArrayBuffer and view bytes, respecting offsets, before
  hashing or awaiting. Shared buffers and other representations are rejected.
  Regression cases mutate both history-object backing memory and update bytes
  immediately after invocation and verify the persisted hash, bytes and pin.
- Durable v2 handlers are awaited and serialized per document. Exact in-flight
  retries share work, completed retries retain their receipt, and changed request
  payloads fail. The bound gateway checks lifetime/revision inside the storage
  transaction before commit. Tests register `history.name` and `suggestion.accept`
  fixture handlers backed by the real gateway, including injected quota failures, retry after
  failure, queued stale operations, close/revocation, and source changes before
  and during storage. Quota exceptions now use `quota_exceeded`, not DOMException's
  numeric code. The v1 host/helpers before the extension boundary are byte-identical
  to `5d27827`. Two existing v2 tests now await durable dispatch; their assertions
  and synchronous preparation restriction are unchanged.
- Accepted and isolated builds share `buildCoordinator`, cancellation and one
  occupied slot through result publication. Features supply copied isolated inputs
  and an explicit destination. Coordinator tests use a controlled compiler to
  verify contention in both directions, immutable inputs, cancellation/close,
  distinct job IDs, and preservation of accepted PDF, diagnostics and SyncTeX.
  Existing browser runtime/editor cases still exercise real compiler/PDF workers
  and offline behavior. No preview UI or full proposed-source compilation is claimed.

All commands below ran in this worktree. WASM-producing checks completed before
browser tests. The preview served the new production `dist` on port **4373**, PID
**341882**, owned by this run and stopped with `kill 341882` after verification.
Browser/test fixtures closed their own processes; no core dumps remain. Core dumps
were disabled with `ulimit -c 0`.

```sh
nix develop -c node --test tests/history.test.mjs tests/reviews.test.mjs tests/build-session.test.mjs
nix develop -c env TMPDIR="$PWD/tmp" npm test
nix develop -c npm run build
nix develop -c bash -c 'echo $$ > tmp/f-fix-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4373 --strictPort'
nix develop -c env SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/foundation.spec.js tests/browser/commands.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=chromium
nix develop -c env SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/foundation.spec.js tests/browser/commands.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=firefox
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/foundation.spec.js tests/browser/commands.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=webkit
```

| Final correction check | Passed | Failed | Skipped / ignored | Duration |
| --- | ---: | ---: | ---: | --- |
| Native Rust (`npm test`, including frozen crates) | 137 | 0 | 1 crash fixture / 1 optional Alloy test | Per-suite timings in local log |
| JavaScript/WASM (`npm test`) | 238 | 0 | 6 optional private-service tests | 11.6 s JS phase |
| Production build | 1 | 0 | 0 | 12.04 s Vite phase, plus assets/WASM |
| Chromium, requested six specs | 42 | 0 | 0 | 2.1 min |
| Firefox, requested six specs | 42 | 0 | 0 | 2.7 min |
| WebKit, requested six specs | 42 | 0 | 0 | 2.6 min |

Final browser acceptance is **126 pass / 0 fail / 0 skip**, including **99 foundation
cases** (57 new regression executions). The 19 new unit cases are already included
in the 238 JS passes. Optional Grafana/Alloy/GitLab infrastructure was not started.
The ignored crash fixture is exercised by its parent test. This repair ran the six
specs requested in its goal; it does not claim a rerun of the earlier local-tabs
or companion browser suites. Frozen companion/folders builds and tests passed
through `npm test`. `git diff --check` passes.

The first focused run had **37 pass / 2 fail**: injected IndexedDB quota errors
returned numeric code `22` instead of a contract error string. After correcting
that mapping, the focused rerun passed **39/39**. Final acceptance includes those
cases. The browser matrix adds 19 regression cases per engine; its compiler
contention fixture uses controlled results, while its persistence fixtures use
actual browser IndexedDB. Disk-full errors are injected, not physical exhaustion.
Linux Playwright WebKit with Mesa software rendering does not establish macOS
Safari behavior. Post-commit revocation cannot roll back committed bytes; the
contract distinguishes that from pre-commit transaction abort and denies later
publication/retries in a revoked host. Existing R4/R6 field evidence, A4 and independent
security-review items remain open; this repair needs no new decision.

## Second review corrections to `adf7ad0` and `893a98f`

This repairs the three distinct reproduced defects (the auto-compile finding was
listed twice). No feature UI, public API, default network destination or frozen
crate behavior changes.

- Durable handlers supply a synchronous receipt-value factory to the bound
  gateway. Storage validates/copies that value before its final transaction guard
  and confirms the receipt and replay identity after `tx.done`, before returning
  to the handler. A later source edit cannot turn that committed acceptance into
  `revision_conflict`. Post-commit guards check lifetime, and Yjs reconciliation
  merges the accepted update with subsequent typing. Later handler errors/values
  cannot replace the committed receipt. The receipt revision labels the live
  session at the commit boundary; its value identifies the committed sequence.
- Host close aborts its lifetime signal and races the awaited handler, including
  one that never settles. Active gateway transactions abort and terminate before
  the document queue advances; late guarded writes fail. A second host can then
  commit, and synchronous mutations stop returning `browser_busy`.
- Auto-compile retains pending local source work after a debounce observes a
  busy compiler. Both preview and accepted-build release schedule that work;
  starting the accepted build consumes it. Disabling auto-compile or leaving the
  project clears it.

The [amended internal contract](annotations-design.md#rust--js-and-agent-command-contract)
records the receipt factory, pre/post-commit guards and host cancellation. Existing
buffer ownership, completed/in-flight retries, quota rollback and pre-commit
revision/revocation/close assertions remain. No existing test was removed,
weakened or renamed to accommodate a UI change.

New regressions use real gateway-backed v2 handlers. They inject typing in a
microtask immediately after the final transaction guard, verify identical
original/in-flight/boundary/completed receipts (also with a later handler error),
and check stored accepted bytes plus both changes in live source. Never-settling
handlers are closed both before storage and during an active transaction; the
second host's preparation observes transaction termination, and late writes are
rejected. Two browser cases bundle the actual `web/main.js` with test-only entry
points and a controlled compiler: typing outlasts the debounce during preview or
accepted compilation, then exactly one accepted build receives the edited source.
These entry points are not in production assets. Existing runtime/editor specs
continue to exercise the real compiler and PDF implementation.

Verification commands (all toolchain commands ran through the flake; logs are
worktree-local under `tmp/f-second-*.log`):

```sh
nix develop -c node --test tests/history.test.mjs tests/reviews.test.mjs tests/build-session.test.mjs
nix develop -c env TMPDIR="$PWD/tmp" npm test
nix develop -c npm run build
ulimit -c 0
nix develop -c bash -c 'echo $$ > tmp/f-second-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4373 --strictPort'
nix develop -c env SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/foundation.spec.js --project=chromium --grep 'post-guard|never-settling|typing during'
nix develop -c env SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/foundation.spec.js tests/browser/commands.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=chromium
nix develop -c env SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/foundation.spec.js tests/browser/commands.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=firefox
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4373 TMPDIR="$PWD/tmp" npx playwright test tests/browser/foundation.spec.js tests/browser/commands.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/runtime.spec.js --project=webkit
```

Earlier checks: the existing focused unit suite passed **39/39**; adding four
regressions produced **42 pass / 1 fail**, because the new test helper reported
DOMException's numeric `code` (20) rather than `name` (`AbortError`). Correcting
that helper produced **43/43**, with unchanged assertions. The focused Chromium
run passed **6/6**. The main-module test bundle initially failed to resolve Vite's
`?url` PDF-worker import. Its test-only bundler now supplies an unused worker URL;
controlled failed build results never instantiate that worker. The bundle check
then passed, using:

```sh
nix develop -c node --input-type=module -e "import {foundationMain} from './tests/helpers/foundation-main.mjs'; console.log((await foundationMain()).length);"
```

One initial focused-command invocation never started because shell redirection
to an invalid log path was denied; subsequent logs use this worktree's `tmp`.
Nix also reported a transient ignored evaluation-cache SQLite busy warning during
concurrent shell startup; it did not fail a check.

| Final second-review check | Passed | Failed | Skipped / ignored | Duration |
| --- | ---: | ---: | ---: | --- |
| Native Rust (`npm test`, including frozen crates) | 137 | 0 | 2 ignored | Per-suite timings in local log |
| JavaScript/WASM (`npm test`) | 242 | 0 | 6 optional-service skips | 13.6 s JS phase |
| Production build | 1 | 0 | 0 | 13.78 s Vite phase, plus assets/WASM |
| Chromium, requested six specs | 48 | 0 | 0 | 2.6 min |
| Firefox, requested six specs | 48 | 0 | 0 | 5.4 min |
| WebKit, requested six specs | 48 | 0 | 0 | 3.3 min |

The final browser matrix is **144 pass / 0 fail / 0 skip**, including **117
foundation executions** and **18 new regression executions**. Supplemental focused
runs are not added to these totals. The optional skips need private
Grafana/Alloy/GitLab infrastructure, which was not started; Rust ignores remain
the crash subprocess fixture (exercised by its parent) and optional Alloy test.
The frozen companion/folders crates built and passed through `npm test`.

The preview served this worktree's rebuilt `dist` on **4373**, owned PID **369221**;
it was stopped with `kill 369221`. Browser fixtures closed their processes. Core
dumps were disabled for browser runs; none remain in the tree. `git diff --check`
passes. No TeX runtime download was requested; build assets came from provisioned
inputs. No push, deployment or external service was used.

Limits: quota faults are injected; timing regressions use a controlled compiler,
while existing runtime/editor checks use the real compiler/PDF paths. Linux
Playwright WebKit with Mesa does not establish Safari/macOS behavior. Replay is
still session-local and bounded to 128 receipts; a closed/revoked host denies
access, including retries. Durable bytes survive post-commit close even if the
handler cannot reconcile them until reopen. Predicate-only revocation still
requires `close()` to cancel a never-settling wait. These trusted handler seams do
not implement review/history features or sandbox arbitrary code. No new decision
is needed; existing R4/R6 field tests, A4 and independent security-review
items remain unchanged.

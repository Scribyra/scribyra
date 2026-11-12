# Milestones 5, 6 and 7 integration

The comments, reviews and history branches were cherry-picked onto the foundation/A5
main branch in that order, retaining their commits and both sides' roadmap evidence.
The two duplicate trace-context fixes were omitted because main already contained A5's
fix. No push, deployment, private-service configuration or TeX runtime download was made.

## Restore witness ownership correction (November 6, 2026)

Current-project restore maps only the checkpoint's surviving selected-item intervals
into the restored text's item identities. It retains the original quote and context;
unrelated interior insertions never become selection witnesses. Mapping requires
identical checkpoint/restored source and a resolvable selection. Missing, invalid or
over-fragmented mappings produce the existing explicit detached restore projection.
Yjs item traversal remains in `web/comment-anchors.js`; review conflict preflight is
unchanged. Point anchors retain their associated-character/EOF behavior.

The recapture audit found one history recapture site, in `restoreCurrent`, now replaced.
Restore-to-copy and complete-backup import use `fork`/`cloneProject`, preserving Yjs
item identities and witness records without range recapture. Ordinary file duplication
does not copy discussions. Review-package import captures an explicitly mapped new
selection; manual reattachment also deliberately selects new text. Neither is history
restoration. Undo/redo's `restoredBinding` follows actual redo links for range witnesses;
its remaining range-free recapture is only for point anchors. Review undo also rebinds
the proposal's own exact reinstated `before` text after full-source verification;
other affected comments use their saved witness identities. `resolveSuggestion`'s
fresh capture compares witnesses for conflicts and does not persist a new binding.

Three deterministic Node and three browser regressions cover current restore, copy,
and complete-backup import: comment on `alpha`, insert `UNRELATED` after `al`, name
the version, restore (after another edit for current/copy), delete `al`, then `pha`.
The comment stays attached after the first deletion, detaches after the second,
retains quote `alpha`, and remains detached after IndexedDB reload. An adapter test
also checks remapped file IDs, point ownership and unavailable mappings.

Every one of the existing 512 random seeds now adds an ownership probe after its
24 mixed-command steps. An independent scalar-token oracle distinguishes original
selection from one to three random interior insertions, sometimes deletes part of
the original before checkpointing, restores after an outside edit, and deletes the
remaining original scalars in random order. After restore and every deletion, the
comment must be attached exactly while original selection survives. Final reload
checks detachment, exact source and the unchanged original quote. Unicode selections
and human/agent actors vary by seed. The independent-UUID repeat check remains.

Before the fix, the strengthened seed `90644518` failed **0 pass / 1 fail** with
`original selection survival: actual 'attached', expected 'detached'` after deleting
all original scalars. With the fix, that seed plus the three deterministic ownership
cases passed **4/4**. For the negative control, retain the new test and use
`f64075e^:web/history-storage.js` as the restore implementation. Exact commands run:

```sh
nix develop -c bash -c 'ulimit -c 0; node --test --test-name-pattern="seed=90644518$" tests/integration-random.test.mjs > tmp/witness-before.log 2>&1'
nix develop -c bash -c 'ulimit -c 0; node --test --test-name-pattern="seed=90644518$|preserves original comment ownership" tests/integration-random.test.mjs tests/integration-review.test.mjs > tmp/witness-after.log 2>&1'
nix develop -c bash -c 'ulimit -c 0; npm test > tmp/witness-npm-test.log 2>&1'
nix develop -c bash -c 'ulimit -c 0; npm run fixtures > tmp/witness-fixtures.log 2>&1 && npm run build > tmp/witness-build.log 2>&1'
nix develop -c env SCRIBYRA_TEST_PORT=4601 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 bash -c 'ulimit -c 0; npx playwright test tests/browser/comments.spec.js tests/browser/history.spec.js tests/browser/reviews.spec.js --project=chromium --project=firefox --project=webkit --output=tmp/witness-browser-results > tmp/witness-browser.log 2>&1'
nix develop -c bash -c 'ulimit -c 0; node --test tests/tex-metadata.test.mjs > tmp/witness-metadata-stable.log 2>&1 && npm test > tmp/witness-npm-test-final.log 2>&1'
git diff --check
```

The first command was run with the old restore implementation; the remaining commands
use the correction committed as `f64075e`. Fixture preparation and the production build
pass, reusing the provisioned TeX assets. The requested comments/history/reviews run
passes **255/255** in one invocation: **85/85 per engine, zero failures or skips**,
including all **nine** new browser regression executions, in **12.0 minutes**.
Playwright started its preview from this worktree's `dist` after checking port 4601
was unused; it closed its browsers/server on completion, and the port is free again.
The final uninterrupted `npm test` passes **156 native / 902 JavaScript/WASM tests,
zero failures**, with **two existing native ignores** (the crash-recovery subprocess
fixture and opt-in pinned-Alloy test) and **six existing optional-service skips**
(the private telemetry/Grafana integration cases listed below). Its JavaScript phase
took **1,134.7 seconds** and includes all 512 strengthened seeds plus the independent-UUID
repeat check. Frozen companion/folders binaries and examples build and tests pass.
The stable-assets metadata check passes **7/7**. `git diff --check` passes; no core
dumps remain. No test was weakened, renamed or newly skipped.

The initial unit run ended **895 JavaScript passes / 1 failure / 6 optional-service
skips**. Running the production build concurrently rewrote `web/pkg` while
`tests/tex-metadata.test.mjs` initialized WASM, causing
`CompileError: WebAssembly.Module(): section ... extends past end of the module`.
This was an execution scheduling mistake, not a product assertion failure. All 512
strengthened seeds and the repeat check passed in that run. The final command above
checks metadata against stable assets, then reruns the complete `npm test` with no
concurrent build. The failed log remains retained; no assertion or test was changed.

Limits: Linux browsers and software-rendered WebKit, small synthetic projects, and
fake IndexedDB for Node. This prevents future recapture; it does not migrate bindings
already rewritten by older restores. The full browser matrix remains the architect's
independent check. Milestones 5–7 remain **Integrated; gate under review**. No new
decision is required from the owner; no external service, deployment or push is involved.

## Third integration review corrections (November 6, 2026)

Milestones 5–7 remain **Integrated; gate under review**. Commits `4a7acf1` and
`c5715ca` fix importer attribution, UI recovery retry and reproducible thread
selection. No new decision is needed from the owner; the architect retains gate sign-off.

Review planning now carries the trusted actor into every new local import record.
Application requires the planning actor and session and records the same identity
in both `review.import` changes. Imported reviews, proposals, messages and threads
retain their original contributor profiles; local acceptance authority remains a
separate local-owner choice. The production browser regression imports a foreign
review through the agent adapter, inspects both persisted change records and
contributor profiles, then names, exports, restores and reloads it.

Recovery keeps the normalized command and its trusted actor separately from the
replay fingerprint. The actual **Retry unsaved decision** button resubmits that
command with its original session. Production browser tests inject a quota error
at the next project-sequence write, assert no source/decision publication, restore
the storage method and click Retry. Human and agent cases each verify one committed
acceptance with its original author/session and proposer, followed by reload.

The write-path audit covered comment creation/reply/edit/redaction, thread decisions
and reattachment; review creation/submission/closure/proposals/terminal decisions and
undo/redo; history naming/unpinning/current and copy restoration; backup import;
agent source patches; and the source attribution observer. Apart from review exchange,
these command handlers already forward their trusted actor. The observer additionally
needed to preserve the transaction's trusted session and owner instead of assigning
the local session. A focused regression exercises that observer with `AgentOrigin`.
Artifact, preview and compaction paths do not create author change records.

The expanded randomized tests exposed another import/history interaction: imported
`restoreProjection` evidence was interpreted as a local restore boundary, causing
`history_unavailable: Invalid discussion restore projection`. The shared Rust history
reducer now excludes explicitly imported evidence from decision selection and causal
heads, as the review reducer already does. It retains the immutable records and still
rejects missing ancestry in actual decisions. A Rust regression and the production
import/backup/restore cases cover this correction.

Randomized thread choices use stable creation ordinals retained through reload and
restore, rather than UUID-sorted command results. All 512 seeds (`90644518` through
`90645029`) still run 24 steps each. An additional test runs seed **90644525** twice
with independent runtime UUIDs and compares its normalized selection trace. Set
`SCRIBYRA_RANDOM_TRACE=1` to print it. The attribution invariant now covers review
import, replies, message edits/redaction, thread resolve/reopen, review submit/close,
withdrawal, history unpin, source patches, copy restore and backup import, including
changes written into newly installed projects. The existing independent source,
selection, unchanged-file and saved-source checks remain enabled.

Final unit coverage includes **465 successful review imports**, **431 source patches**,
**219 unpins**, **449 current/copy restorations**, and **402 backup imports**. All new
local changes are checked against the trusted human/agent author and session; the
installed copy/import change is checked before the temporary project is deleted.
Refused stale/terminal/permission operations keep their source unchanged.

Verification uses port **4601** and product/test commit `c5715ca`. No test was removed,
weakened, renamed or newly skipped. The frozen crates are unchanged. Exact commands:

```sh
nix develop -c npm run fixtures > tmp/round3-fixtures.log 2>&1
nix develop -c npm run wasm > tmp/round3-wasm.log 2>&1
nix develop -c node --test tests/integration-review.test.mjs > tmp/round3-deterministic-final.log 2>&1
nix develop -c bash -c 'node --test tests/integration-review.test.mjs tests/integration-random.test.mjs > tmp/round3-final-focused-node.log 2>&1'
nix develop -c env SCRIBYRA_RANDOM_TRACE=1 node --test --test-name-pattern='repeats selections' tests/integration-random.test.mjs > tmp/round3-reproducibility.log 2>&1
nix develop -c env TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npm test > tmp/round3-npm-test.log 2>&1'
nix develop -c env TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npm run build > tmp/round3-final-build.log 2>&1 && bash tmp/integration-pages-build.sh > tmp/round3-pages-build.log 2>&1'
nix develop -c rustfmt --check --edition 2024 crates/core/src/history.rs > tmp/round3-format.log 2>&1
git diff --check
```

Fixture generation, explicit WASM build, formatting and diff checks pass. The focused
production run passes **526/526** (512 seeds plus 14 deterministic tests); the repeated
selection check passes **1/1**, and the final deterministic rerun passes **14/14**.
The focused seeded run began before adding the repeated-selection test; full
`npm test` includes it. `npm test` passes **156 native / 898 JavaScript/WASM**, with
**0 failures, 2 existing native ignores and 6 existing optional-service skips**;
its JS phase takes **833.1 seconds**. Frozen companion/folders binaries/examples
build and tests pass. Production build and both local Pages bundles plus assembly
pass, reusing the cached TeX baseline/components without a runtime download.

The unfiltered browser matrix runs in one invocation, with one worker, no retries,
the final build's `dist` on port 4601 and the final `.pages` on an owned loopback server.
The Pages build/server recipes are reproduced in the earlier evidence below. The
server and matrix were started with:

```sh
nix develop -c bash -c 'echo $$ > tmp/round3-pages-pid; exec python3 tmp/integration-pages-server.py' > tmp/round3-pages-server.log 2>&1
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 bash -c 'ulimit -c 0; export SCRIBYRA_TEST_PAGES_URL="$(cat tmp/integration-pages-url)"; exec npx playwright test --project=chromium --project=firefox --project=webkit --output=tmp/round3-full-browser-results > tmp/round3-full-browser.log 2>&1'
```

The single uninterrupted invocation exited **0**, dispatching all **759 cases**
without retries or partial reruns. Playwright reports **2.0 hours**:

| Engine | Passed | Failed | Existing skips |
| --- | ---: | ---: | ---: |
| Chromium | 245 | 0 | 8 |
| Firefox | 244 | 0 | 9 |
| WebKit | 244 | 0 | 9 |
| Total | **733** | **0** | **26** |

All **48 production integration-review cases** pass (16 per engine), including all
**9 new foreign-import and actual UI Retry cases**. The 26 existing skips are 18
private-service cases and eight engine-specific native-input cases. Local Alloy
and native companion ingress ran and passed in every engine. The earlier focused
three-regression browser run passed **9/9** before extending the imported review
case with named restore/backup checks; it does not contribute to the matrix totals.

Playwright closed its owned preview server (PID **1354717**) and test browsers.
The separate loopback Pages server was stopped with `kill -TERM 1354544`; its
normal termination status was 143. A final process check found no browser, server
or other runtime process with this worktree's cwd. No core dumps remain.

Development failures are retained separately from final acceptance. The initial
import probe passed **0/2**, and the first deterministic run passed **12/14**: the new
comment fixture supplied an unsupported `before` field, which was removed from that
command. The first expanded seeded attempt was stopped at **117 pass / 8 fail** and
the next at **45 pass / 12 fail**; these exposed the imported restore-evidence bug
fixed in Rust above. No failed assertion was weakened. An earlier single-seed probe
passed **1/1**, and the pre-reducer production build passed. Logs are
`tmp/round3-{import-probe,integration-node,focused-node,expanded-seeds,seed-probe,build}.log`.

Limits remain Linux browsers with software WebKit, synthetic quota injection and
small bounded history/backup fixtures. Attribution is descriptive, not cryptographic.
Existing disconnected-peer anchor and authority-transfer limits remain. Private
service/real-device/R4/R6 gates and remote/encrypted collaboration remain outside
this correction. No external service was configured, no private credentials were read,
and no deployment or push was made. The existing full-matrix IEEEtran case reads its
pinned package from the public mirror; compiler runtime provisioning reused the
cached assets.

## Second integration review corrections (November 6, 2026)

Milestones 5–7 remain **Integrated; gate under review**. This round fixes stale
acceptance replay after restore, comments lost on redo, and agent history writes
attributed to the human owner. The aggregate roadmap row now agrees with the
reopened gates. No new decision is required from the owner; Complete status belongs to
the architect after independent review.

Restore/import change records invalidate acceptance, editor and search undo stacks,
including boundaries received through Yjs updates without their original transaction
origin. Removed targets and non-local whole-source replacements also retire affected
stacks. Every acceptance/undo/redo (and retained-draft retry) compares the full rehearsed
source result, merged into the current document, with independently applied,
Rust-validated edits before storage commit. An expired or mismatched replay refuses
without publishing source. Retained decision drafts are bound to the original actor
and session. The implementation deliberately refuses old groups after restoration.

Undo captures effective bindings on the accepted text, including comments and manual
reattachments created after acceptance. Redo follows actual restored item identities
and commits the resulting binding events with the source. Changed causal heads and
already-conflicted suggestion bindings are not repaired by guessing. The disk-full
regression verifies detached comments and original source remain visible until the
exact source/binding draft commits; reload then sees the repaired binding.

History naming, unpinning, current/copy restoration and backup import use the trusted
caller author/session. Restored acceptance authority belongs to that author's human
owner (or the human caller), independently of authorship. JavaScript projection and
the shared Rust validator agree on that distinction. Production browser backup
inspection verifies agent history changes, their session and human owner authority.

`tests/integration-random.test.mjs` runs **512 seeds**, `90644518` through `90645029`,
with **24 steps per seed (12,288 steps)** through the production agent adapter/shared
command host, WASM validators, anchors, review/history services and storage code.
Node supplies fake IndexedDB and an in-process lock adapter; there is no simulated
feature implementation. The three-slot source oracle is independent of resolved
CRDT offsets. It tracks each comment's selected slot/text and checkpoint state,
checks every new change's actual actor/session, checks exact accepted source and
an untouched second file after each step, and verifies saved source after every
step. Operations include comment, propose, accept, reject, undo, redo, name, restore,
reload and explicit comment reattachment, mixing human and agent callers. Each seed
also finishes with reload. Reproduce an individual trace with
`nix develop -c node --test --test-name-pattern='seed=90644518$' tests/integration-random.test.mjs`.

The eleven deterministic Node regressions additionally check the reported corruption
sequence, full and effective redo bindings across repeated cycles/reload, deliberately
misplaced private undo/redo mutations, transported restore boundaries, editor/search
stack retirement, atomic quota-failure recovery, and search-manager listener cleanup.
Three cases restore under a different human owner (current/copy/import), checking
agent sessions and acceptance through the shared Rust authority validator. Four new browser cases cover
both old undo/redo states after restore and both new/effective comment bindings on
redo; the existing agent attribution case now includes history and backup evidence.

The completed seeded runs found **no additional product counterexamples** after the
repairs. Successful/refused command counts were: accept **762/744**, undo **775/688**,
redo **569/933**, reject **266/725**; all **713** restores, **1,461** proposals,
**1,506** comment creations, **971** reattachments and **1,194** names succeeded.
Refusals are expected stale/terminal/unavailable-group outcomes, with unchanged
source checked by the oracle.

The first complete unit run and initial build used commit `9531c37`:

- `nix develop -c npm test`: **155 native passed / 0 failed / 2 existing ignored**;
  **890 JS/WASM passed / 0 failed / 6 existing optional-service skips**, including
  the 512 seeded and first seven deterministic cases. JS duration **996.1 seconds**.
  Frozen companion/folders crates, binaries and examples build and pass unchanged.
- `nix develop -c npm run fixtures`: passed; reused provisioned compiler assets.
- `nix develop -c env TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npm run build > tmp/round2-build-final.log 2>&1 && bash tmp/integration-pages-build.sh > tmp/round2-pages-final.log 2>&1'`:
  production build and both local Pages bundles/assembly passed. The Pages script
  and loopback server are reproduced in the first-round section below.
- `nix develop -c node --test tests/reviews.test.mjs tests/history.test.mjs tests/comments.test.mjs tests/editor.test.mjs`:
  **161 passed / 0 failed**, 393.8 seconds.
- `nix develop -c node --test tests/integration-review.test.mjs`:
  **7 passed / 0 failed** after the final retained-draft actor check.
- `nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/integration-review.spec.js --project=chromium --output=tmp/round2-focused-browser-results'`:
  **13 passed / 0 failed**, 53.5 seconds (before the final draft/lifecycle cleanup;
  the complete matrix below uses the final build).
- `nix develop -c rustfmt --check --edition 2024 crates/core/src/reviews.rs` and
  `git diff --check`: passed. No repository-wide formatting claim.

Development probes are not counted as final acceptance. The first randomized
attempt completed **10 pass / 12 fail** before interruption: the new reattachment
harness omitted required causal heads (`Invalid comment command fields`). The
second completed **35 pass / 2 fail** before interruption: the generator attempted
unchanged proposals (`Invalid or oversized suggestion`). Both were harness errors;
the corrected generator supplies current heads and always changes proposal text.
The third completed **221 pass / 0 fail**, then was stopped to strengthen the
independent selection/persistence/actor oracle. Its focused strengthened rerun
passed **28/28**. An initial `npm test` was interrupted for the final draft actor
check; it is not counted as a full run. A diagnostic
`nix develop -c node --test --test-timeout=60000 tests/comments.test.mjs` cancelled
one whole test file at 60 seconds; the normal 161-case run and final `npm test`
subsequently passed without that artificial timeout. A redundant direct
`nix develop -c node tests/history.test.mjs` was stopped after 72 passing cases
while its existing 30-cycle test ran. No existing assertion, UI name or skip was
weakened or changed. Logs are retained under `tmp/round2-*`.

Final lifecycle review found that the new search undo `destroy()` wrapper also
needed to replace its previously registered document-destroy callback. Otherwise
explicitly destroyed managers remained referenced until project closure. Commit
`8451b09` fixes that cleanup; a regression verifies a closed batch receives no
later destroy callback. The focused command
`nix develop -c env TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec node --test tests/integration-review.test.mjs tests/editor.test.mjs'`
passes **15/15**, including all eleven final deterministic integration cases.
The preceding owner-change coverage commit `cd6fc9d` was test-only (10/10 focused
integration cases); it required no production correction.

The preliminary full browser runs were explicitly interrupted for that lifecycle
fix; they are **not acceptance totals**: Chromium **239 passed / 0 failed / 5 skipped /
1 interrupted / 4 not run** (34.9 min), Firefox **225 / 0 / 2 / 1 / 21** (35.0 min),
and WebKit **223 / 0 / 3 / 1 / 22** (35.1 min). All thirteen production integration
cases had passed in each engine before interruption. The expanded unit rerun was
also interrupted for the fix. The two owned preview/Pages servers were stopped by
exact PID, **1173375 / 1173374**, before rebuilding. No existing assertion or
browser harness was changed to accommodate the fix.

The next full matrix exposed a real comment-save focus race in the existing WebKit
manual-reattachment case: its first Backspace left the source unchanged because a
queued save callback stole focus from the editor. The assertion reported
`Expected "Detached: selection deleted"; received "main.texopen · attached · 1 messagesselected"`.
Those runs were stopped: Chromium **71 passed / 0 failed / 0 skipped / 1 interrupted /
177 not run**, Firefox **60 / 0 / 1 / 1 / 187**, WebKit **59 / 1 / 1 / 1 / 187**.
They are not acceptance totals. A new controlled frame-order regression failed
against the old build (`Expected focused; received inactive`), confirming the cause.
Commit `392e9c7` rechecks the current focus when the deferred callback actually runs.
The existing reattachment assertion remains unchanged. Both cases then passed three
repetitions in each engine: **18 passed / 0 failed** (Chromium 14.3 s, Firefox 30.8 s,
WebKit 20.8 s), using `npx playwright test tests/browser/comments.spec.js --grep
"manual reattach|late comment save focus" --repeat-each=3 --project=<engine>` through
the flake with the same environment as the final matrix below.

The preceding complete unit run at `8451b09` also passed: **155 native / 894 JS/WASM
passes**, **0 failures**, **2 native ignores / 6 optional-service skips** (JS 955.0 s).
The final run below repeats acceptance after the focus correction. No existing
test was removed, weakened, renamed or newly skipped.

The final acceptance commands use build `392e9c7`, port **4601**, one worker per
engine and no retries. The owned preview serves this worktree's `dist`; a separate
loopback server serves the locally assembled `.pages`. The Pages URL is set in
every engine so those checks run instead of skipping. The servers and build script
are the local-only recipes reproduced below. Logs and traces use separate output
directories per engine.

Final `npm test`: **155 native passed / 0 failed / 2 existing ignored**;
**894 JS/WASM passed / 0 failed / 6 existing optional-service skips**, 900 JS tests
total, **954.5 seconds**, with all **512** seeded sequences and **11** deterministic
integration cases passing. Frozen companion/folders binaries and examples build
and their tests pass unchanged. Final production and both local Pages bundles
plus assembly passed (Vite root 12.78 s, Pages app 12.95 s, root shell 7.19 s).
The build reports `Verified cached LuaLaTeX baseline and static components.`

The final unfiltered, uninterrupted browser runs all exited successfully:

| Engine | Passed | Failed | Existing skips | Duration |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 242 | 0 | 8 | 34.8 min |
| Firefox | 241 | 0 | 9 | 43.3 min |
| WebKit | 241 | 0 | 9 | 41.4 min |
| Total | **724** | **0** | **26** | |

All **13 production integration-review cases per engine (39/39)** and the new
deferred-focus regression in each engine pass within those full runs. No partial
rerun substitutes for a final matrix result. The 26 skips are eight engine-specific
IME cases and eighteen existing private-service cases; no credentials or managed
services were used. Both owned preview/Pages servers were stopped by exact PID
(`1265911`, `1265910`); the final workspace process check found only its own check
shell/Python process, with no test browser or server left. No core dumps remain.
Scoped Rust formatting and `git diff --check` pass; repository-wide formatting is
not claimed.

```sh
nix develop -c env TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npm test' > tmp/round2-npm-after-focus.log 2>&1
nix develop -c env TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npm run build > tmp/round2-build-after-focus.log 2>&1 && bash tmp/integration-pages-build.sh > tmp/round2-pages-after-focus.log 2>&1'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; export SCRIBYRA_TEST_PAGES_URL="$(cat tmp/integration-pages-url)"; exec npx playwright test --project=chromium --output=tmp/round2-final-chromium-results > tmp/round2-final-chromium.log 2>&1'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; export SCRIBYRA_TEST_PAGES_URL="$(cat tmp/integration-pages-url)"; exec npx playwright test --project=firefox --output=tmp/round2-final-firefox-results > tmp/round2-final-firefox.log 2>&1'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 bash -c 'ulimit -c 0; export SCRIBYRA_TEST_PAGES_URL="$(cat tmp/integration-pages-url)"; exec npx playwright test --project=webkit --output=tmp/round2-final-webkit-results > tmp/round2-final-webkit.log 2>&1'
```

Limits: the seeded model uses three small independent text slots, fake IndexedDB
and a lock adapter; it is not exhaustive concurrent-peer or large-backup testing.
Browser checks use real IndexedDB, production WASM and Linux browser engines with
software-rendered WebKit, not Safari/macOS. Existing private-service/platform skips
and the disconnected-peer witness ancestry limit remain. Attribution records are
local descriptive evidence, not cryptographic identity proof. Frozen companion and
folders code is unchanged; there are no new destinations, services or deployments.

## Integration review corrections (November 6, 2026)

Milestones 5, 6 and 7 are **Integrated; gate under review**. The architect alone
will restore Complete status. The earlier full runs below contained failures;
passing partial reruns did not close that gate.

Rebased onto local `main` (`0d174b6`), preserving `#tex=` entry and its consent
boundary. Comment commands reject suggestion-anchor reattachment in shared Rust.
Acceptance undo follows the actual Yjs redo links for every saved witness interval,
including partial overlaps, retaining original quote and narrowing provenance.
History maps the effective checkpoint binding; shared restore projection excludes
historical reattach events from overriding that new mapping while retaining their
immutable evidence. The trusted agent actor/session/origin reaches comment and
review writes. Agent previews use the same bounded job registry, polling,
diagnostics and cancellation as ordinary compilation.

`integration-review.spec.js` exercises production `window.scribyra.agent`, UI,
release WASM, real anchors, IndexedDB, backup exports/imports and compiler workers.
It constructs no substitute feature service or contract anchor adapter. Exported
Yjs bytes are decoded only to assert persisted author/session records. Cases cover
cross-file reattachment rejection and a fresh superseding proposal; partial-overlap
undo, later narrowing and reload; current restore after undo/manual reattachment;
real agent labels and attribution; running/completed/cancelled preview jobs; a
successful ordinary PDF despite a pending invalid-TeX proposal, followed by an
actual failed preview compile; offline clean-profile recovery of event-rebound
anchors; and TeX-link preview consent.

Pre-fix production build and fixture generation passed. All eight original new
browser cases failed as expected: reattachment was accepted, partial undo started
at 46 instead of 41, both restored comments detached, writes used the human ID,
preview returned complete instead of running, preview polling was rejected (the
60-second diagnostic run timed out), and recovered rebound anchors detached.
The first fixed focused run had 6 passes and 2 test synchronization/selector
failures: reopening was not awaited and an exact label omitted ` · pending`.
Those new-test mistakes were corrected without removing assertions. Focused units
passed 68/68. The corrected focused Chromium run passes **17/17**: nine new production cases
and all eight existing TeX-link cases. No existing browser assertion was changed.

This review's checks use `SCRIBYRA_TEST_PORT=4601`, one Playwright worker and no
retries. No compiler runtime was downloaded. Exact commands (logs under `tmp/`):

```sh
nix develop -c npm run fixtures
nix develop -c npm run build # pre-fix: tmp/review-baseline-build.log
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test tests/browser/integration-review.spec.js --project=chromium --timeout=60000 --output=tmp/review-baseline-results > tmp/review-baseline-browser.log 2>&1'
nix develop -c npm run wasm
nix develop -c env RUST_TEST_THREADS=1 bash -c 'node --test tests/comments.test.mjs tests/reviews.test.mjs tests/agent-commands.test.mjs > tmp/review-focused-unit.log 2>&1'
nix develop -c npm run build # first fix: tmp/review-fixed-build.log
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test tests/browser/integration-review.spec.js --project=chromium --output=tmp/review-fixed-results > tmp/review-fixed-browser.log 2>&1'
nix develop -c env TMPDIR="$PWD/tmp" RUST_TEST_THREADS=1 bash -c 'ulimit -c 0; npm test > tmp/review-test.log 2>&1'
nix develop -c env TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npm run build > tmp/review-final-build.log 2>&1 && bash tmp/integration-pages-build.sh > tmp/review-pages-build.log 2>&1'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test tests/browser/integration-review.spec.js tests/browser/tex-link.spec.js --project=chromium --output=tmp/review-focused-final-results > tmp/review-focused-final.log 2>&1'
nix develop -c rustfmt --check --edition 2024 crates/core/src/comments.rs crates/core/src/history.rs
```

`npm test` passes **155 native / 371 JS/WASM**, with **0 failures, 2 existing
native ignores and 6 optional-service skips**. It also builds both frozen crates
and their bins/examples. The JS phase takes 393.0 seconds. All three production
builds, fixture generation, explicit WASM build, scoped Rust formatting check,
and both local Pages Vite builds plus assembly pass. Pages preparation uses the
expanded build/assembly script retained below, serving only loopback. The final
root-app bundle stage takes 13.26 seconds; the recipe is 1,989 bytes and retains
main's TeX-link instructions.

Full browser matrix, one uninterrupted invocation per engine, no retries or
partial reruns counted:

| Engine | Passed | Failed | Existing skips | Duration |
| --- | ---: | ---: | ---: | --- |
| Chromium | 237 | 0 | 8 | 34.9 min |
| Firefox | 236 | 0 | 9 | 43.9 min |
| WebKit | 236 | 0 | 9 | 41.5 min |

Exact full-matrix invocations (the Pages server writes its ephemeral loopback URL
into `tmp/integration-pages-url`):

```sh
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; export SCRIBYRA_TEST_PAGES_URL="$(cat tmp/integration-pages-url)"; exec npx playwright test --project=chromium --output=tmp/review-full-chromium-1-results > tmp/review-full-chromium-1.log 2>&1'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; export SCRIBYRA_TEST_PAGES_URL="$(cat tmp/integration-pages-url)"; exec npx playwright test --project=firefox --output=tmp/review-full-firefox-1-results > tmp/review-full-firefox-1.log 2>&1'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 bash -c 'ulimit -c 0; export SCRIBYRA_TEST_PAGES_URL="$(cat tmp/integration-pages-url)"; exec npx playwright test --project=webkit --output=tmp/review-full-webkit-1-results > tmp/review-full-webkit-1.log 2>&1'
```

For reproduction, `tmp/integration-pages-build.sh` contains:

```sh
set -eu
npx vite build --base=/app/ --outDir=.cache/integration-pages-app
env SCRIBYRA_ROOT_SHELL=1 VITE_TEX_ASSET_BASE=/app/core/busytex npx vite build --base=/ --outDir=.cache/pages-root-shell
mv dist tmp/integration-root-dist
trap 'if [ -d dist ]; then mv dist .cache/integration-pages-app; fi; mv tmp/integration-root-dist dist' EXIT
mv .cache/integration-pages-app dist
node scripts/ci-pages.mjs
```

The local Pages server is `tmp/integration-pages-server.py` (run with
`nix develop -c python3 tmp/integration-pages-server.py`; record its exact PID):

```python
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.md': 'text/markdown', '.wasm': 'application/wasm'}
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory='.pages'))
with open('tmp/integration-pages-url', 'w') as f:
    f.write('http://127.0.0.1:%s/' % server.server_port)
server.serve_forever()
```

All **735 cases** were dispatched: **709 passed, 0 failed, 26 existing skips**.
Each engine passed its first full invocation; no full or partial rerun contributes
to these gate totals. All nine new cases pass in each engine (**27/27**). Chromium
skips six optional private-service cases and two engine-specific native-input
cases; Firefox and WebKit each skip the same six services and three native-input
cases. The exact optional-service names remain listed below. Local Alloy and
native companion ingestion ran and passed in every engine.

Product/test code stayed at `e49f257` throughout the full matrix; only this evidence
record changed during execution. Playwright closed its preview servers and browser
processes. The separately owned Pages server was stopped by exact PID **1060139**;
a final process check found no remaining browser, Node, Alloy, Scribyra test-service
or Python server processes, and a full worktree scan found no core dumps. Final
`git diff --check` passes. No push or deployment was performed.

Limits remain Linux synthetic coverage, software-rendered WebKit rather than
Safari/macOS, optional private-service skips, and the existing disconnected-peer
witness-ancestry boundary. The unchanged TeX package tests include the existing
public package-mirror case; compiler runtime assets were reused, not reprovisioned.
No new network destination, external account/service configuration, or private
credentials were used. No new decision is required from the owner. The architect keeps
milestones 5–7 under review until independent sign-off.


## Integrated behavior

Reviews use production identity anchors in every browser test. History's previously
skipped discussion gate now creates real comments and submitted proposals, erases the
original project, imports a complete backup offline in a clean profile, restores a named
version and asserts attached anchors, original thread state, pending suggestions and
visible local authority. It checks source/image bytes and deleted-image recovery too.

Restore projections select active semantic events before the feature reducers run.
Immutable records remain exportable evidence; copy/import authority is an explicit event,
not a rewrite of the original review. Restored insertion suggestions recompute their
identity binding, while already conflicted checkpoint proposals stay conflicted.
All three features use one device-local author identity. Review row updates now refresh
visible status and authority instead of retaining the initial draft label.

The experimental `window.scribyra.agent` description includes all mounted operations.
Real calls cover `thread.*`, `review.*`, `suggestion.*`, `history.*` and `backup.*`, including
five denied-rights calls through a restricted production dispatcher. Raw execute accepts
attachment maps for imports. Artifact reads route both review packages and backups.
The served recipe is 1,997 bytes, within its 2,000-byte budget.

Four additional browser cases cover shared comment/suggestion ranges through source
undo, acceptance and acceptance undo; restoring pending proposals and resolved threads;
a complete backup of that state; accepted-PDF freshness; and editing a comment while a
suggestion preview compiles. Reload and imported-copy UI assertions exercise persistence.

The separate contract amendment **`2a24e48`, “Amend preview dispatch contract for
concurrent annotation edits”**, allows readonly isolated preview work outside the durable
mutation queue. It retains initial revision validation, lifetime/cancellation checks,
immutable copied source and the shared compiler slot; it has no storage commit gateway.
The unit regression changes both source and comments during a controlled preview.

## Earlier integration acceptance (superseded by this review)

All toolchain commands use `nix develop -c`, with `TMPDIR="$PWD/tmp"` and core dumps
disabled for browser/server commands. The browser port is `SCRIBYRA_TEST_PORT=4601`.
Fixtures were generated once with `nix develop -c npm run fixtures`. Preview servers serve
this worktree's built `dist`; only their recorded exact PIDs are stopped.

Final units/build:

```sh
nix develop -c env TMPDIR="$PWD/tmp" RUST_TEST_THREADS=1 bash -c 'ulimit -c 0; npm test > tmp/integration-final-test.log 2>&1 && npm run build > tmp/integration-final-build.log 2>&1'
```

`npm test`: **155 native pass, 0 fail, 2 ignored; 367 JS/WASM pass, 0 fail,
6 optional-service skips** (373 JS cases, 398.37 seconds). The native suite includes
both frozen programs, and their bins/examples build. `npm run build` passes;
Vite's bundle stage took 13.81 seconds; the subsequent precache-fix rebuild passed
with a 13.54-second bundle stage. Existing dependency annotation warnings
remain. Logs: `tmp/integration-final-test.log`, `tmp/integration-final-build.log`,
`tmp/integration-final-build-2.log`.

Local Pages preparation used the same release WASM:

```sh
nix develop -c npx vite build --base=/app/ --outDir=.cache/integration-pages-app
nix develop -c env SCRIBYRA_ROOT_SHELL=1 VITE_TEX_ASSET_BASE=/app/core/busytex npx vite build --base=/ --outDir=.cache/pages-root-shell
# Temporarily place the /app build at dist, assemble, then restore the root dist.
nix develop -c node scripts/ci-pages.mjs
```

Those are the expanded build steps; the post-precache-fix repeat ran as:

```sh
nix develop -c bash -c 'ulimit -c 0; npm run build > tmp/integration-final-build-2.log 2>&1 && bash tmp/integration-pages-build.sh > tmp/integration-pages-build-2.log 2>&1'
```

Both Vite builds and assembly pass, including the post-fix repeat. A direct
filesystem check finds all 12 root-app, 12 `/app`, and 13 root-Pages precache paths. The assembled `.pages` is served only on loopback,
with `.md` as `text/markdown`; its URL is supplied as `SCRIBYRA_TEST_PAGES_URL`.
The existing pinned Alloy test dependency was provisioned with
`nix develop -c python3 scripts/telemetry-tools.py alloy` for the local ingestion specs;
no private collector or account is configured.

Each browser command runs all specs, one worker, with no fixture flags:

```sh
nix develop -c env SCRIBYRA_TEST_PORT=4601 SCRIBYRA_TEST_PAGES_URL="$pages_url" TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test --project=chromium --output=tmp/integration-final-chromium-results'
nix develop -c env SCRIBYRA_TEST_PORT=4601 SCRIBYRA_TEST_PAGES_URL="$pages_url" TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test --project=firefox --output=tmp/integration-final-firefox-results'
nix develop -c env SCRIBYRA_TEST_PORT=4601 SCRIBYRA_TEST_PAGES_URL="$pages_url" TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test --project=webkit --output=tmp/integration-final-webkit-results'
```

These are run sequentially inside one `nix develop -c bash tmp/integration-browser-matrix.sh`
with the same environment. Logs are `tmp/integration-final-{chromium,firefox,webkit}.log`;
retained traces use the separate output directories above.

Chromium's full run completed in 30.9 minutes: **213 pass, 7 fail, 8 skip**.
All seven failures were corrected test integration assumptions, with no assertion
removed: foundation scheduling host collision (2), old schema expectation (1),
and ambiguous telemetry recovery status (4). Targeted final reruns pass **2/2,
1/1 and 4/4**, respectively. All **220 distinct runnable Chromium cases** therefore
have passing evidence; the full run itself is not claimed failure-free.

```sh
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test tests/browser/foundation.spec.js --grep "typing during a long" --project=chromium --output=tmp/integration-foundation-focused-results'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test tests/browser/tree.spec.js --grep "v1 storage" --project=chromium --output=tmp/integration-tree-focused-results'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test tests/browser/telemetry-isolation.spec.js --project=chromium --output=tmp/integration-isolation-focused-results'
```

Private-service browser skips, one case per spec/engine: `telemetry-cloud`,
`telemetry-failures`, `telemetry-grafana`, `telemetry-native-storage`, `telemetry-runs`,
`telemetry-storage`. The six optional Node skips are
`telemetry-alert-sources.test.mjs`, `telemetry-ci-storage.test.mjs`,
`telemetry-grafana-alerts.test.mjs`, `telemetry-native-storage.test.mjs`,
`telemetry-operations.test.mjs` and `telemetry-runs-storage.test.mjs`.
No private state was configured or read. The actual local
Alloy ingress and native-ingress tests run. Platform skips select native input
adapters: Gecko/WPE tests skip in Chromium; Chromium CDP cases skip in Firefox
and WebKit, which each run their own native adapter.

Firefox's full run completed in **44.9 minutes: 215 pass, 4 fail, 9 skip**.
The collaboration fixture correction passed both cases; normal-key source replacement
and exact line assertions passed the cancellation and four telemetry isolation cases.
The final telemetry rerun passed **10/10 across Chromium/Firefox** in 8.9 minutes;
three earlier repeated Firefox cancellation checks also passed. All **219 distinct
runnable Firefox cases** have passing evidence; its full run is not claimed failure-free.

```sh
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test tests/browser/collaboration.spec.js --project=firefox --output=tmp/integration-sync-firefox-2-results'
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; npx playwright test tests/browser/telemetry.spec.js tests/browser/telemetry-isolation.spec.js --grep "cancelling a running engine|collection preserves saves" --project=chromium --project=firefox --output=tmp/integration-telemetry-final-results'
```

The restricted agent harness initially failed to import in WebKit because its injected
module was intercepted by the service worker. Only that case now blocks service workers;
the three application cross-feature cases and all offline specs still use their ordinary
settings. The final denied-rights case passes **3/3** (one per engine, 13.6 seconds):

```sh
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 bash -c 'ulimit -c 0; npx playwright test tests/browser/annotations-integration.spec.js --grep "agent discovers" --project=chromium --project=firefox --project=webkit --output=tmp/integration-denied-final-results'
```

WebKit's full run completed in **39.7 minutes: 217 pass, 2 fail, 9 skip**.
The denied-rights harness correction above passes. Its second failure was the binary
collaboration case: WebKit's service worker bypassed the HTTP route adapter. The final
fixture forwards blob traffic through an owned ephemeral HTTP proxy to the real Rust
sync service. It preserves production origin checks and exercises the browser's normal
network/offline path. Both collaboration cases pass in every engine: **6/6, 47.2 seconds**.

```sh
nix develop -c env SCRIBYRA_TEST_PORT=4601 TMPDIR="$PWD/tmp" __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 bash -c 'ulimit -c 0; exec npx playwright test tests/browser/collaboration.spec.js --project=chromium --project=firefox --project=webkit --output=tmp/integration-sync-all-final-results' > tmp/integration-sync-all-final.log 2>&1
```

All **219 distinct runnable WebKit cases** have passing evidence. Across the three
complete runs: **645 pass, 13 fail, 26 skip** out of 684 discovered cases. Corrections
and affected reruns establish **658 distinct runnable cases passing**, with no remaining
failed case. The full matrices were not repeated after the final test-harness corrections;
their original nonzero exits and failure counts remain recorded. The 26 skips comprise
18 optional private-service cases and eight engine-specific native-input/CDP cases.
All owned test browsers, sync/proxy listeners and preview/Pages servers were closed;
the final servers were stopped by exact PIDs 943476 and 943522. No core dumps remain.


## Earlier attempts and corrections

- Initial `npm test`: 155 native passes, two ignored subprocess fixtures; 364 JS passes,
  two failures, six optional skips. One historical restore fixture omitted required
  authority/proposer fields; the new integrated fixture omitted its manager map. Both
  were corrected. The chained build did not run after that failure.
- Focused normalized/integrated restore run: one pass, one failure before the proposer
  fixture correction. Normalized 30-cycle rerun: one pass in 392.8 seconds.
- First Chromium reviews/history/integration run: 23 passes, four failures, 30 not run.
  It exposed the stale review row and preview queue problems above, plus a duplicate
  harness import alias and a reload test that needed to reopen the project dashboard.
- Second Chromium run, adding agent-recipe: 59 passes, one failure. The backup test
  clicked an already-open Reviews panel closed after switching projects. Its helper
  now checks the panel state; no assertion was removed.
- Focused comments/reviews/agent/build-session units: 72 passes; integrated restore:
  one pass. Extending that restore case initially failed only on case-sensitive error
  wording; the assertion now checks the structured `anchor_detached` code and passes.
- Two intermediate production builds passed. `cargo fmt --all --check` failed on formatting differences in imported
  application modules and other existing files (first output: `Diff in crates/app/src/lib.rs:1`,
  including module order). No repository-wide formatting rewrite was made; the changed
  core Rust modules were formatted. The final scoped check passes:
  `nix develop -c rustfmt --check --edition 2024 crates/core/src/comments.rs crates/core/src/history.rs crates/core/src/reviews.rs`.
  The full-tree formatting check is not claimed green.
- The first full Chromium attempt passed ten cases, then was deliberately interrupted
  at offline recipe navigation (one interrupted, 217 not run). The strict Pages server
  exposed a nonexistent CSS-only JS chunk in the service-worker precache; Vite preview's
  HTML fallback had hidden the 404. Precache generation now runs after Vite removes
  those chunks. The app and Pages release were rebuilt before restarting the matrix.
- The next full Chromium attempt: 20 passes, one collaboration failure, one
  interrupted, 206 not run. Its fixed demo origin rejected the assigned port 4601.
  Like the existing commands fixture, collaboration now owns an ephemeral sync
  listener and adapts WebSocket/blob test requests to the existing allowed origin.
  Production origin checks and all assertions remain intact. Focused collaboration
  rerun: two passes in 11.7 seconds.
- Two foundation scheduling probes initially failed with `Command already registered`:
  their synthetic `history.name` collided with the now-installed history feature. The
  controlled handler now uses a separate host on the same document queue; production
  handlers and assertions remain unchanged. Focused Chromium rerun: two passes in
  17.5 seconds. Firefox/WebKit use the corrected harness in their full runs.
- The legacy tree test expected schema 5 after migration; foundation F correctly
  writes schema 6. Its expected version now matches the contract, retaining rollback,
  exact original bytes and pre-upgrade source export assertions. Focused Chromium
  rerun: one pass in 3.1 seconds. No production migration code changed.
- Four telemetry isolation modes selected every status element after A5 added a
  compilation status. Their recovery assertion now selects the existing named
  `Workspace notification`. Full Chromium isolation rerun: four passes in 2.6 minutes,
  including storage failures, recovery copies, offline compiles and diagnostic privacy.
- Firefox's collaboration asset case failed at offline reload with `NS_ERROR_OFFLINE`
  while the online blob interception remained installed. A readiness-only rerun still
  failed (one pass, one fail). That iteration waited for service-worker control and
  removed its completed HTTP transport interception before taking the browser offline.
  Both Firefox collaboration cases then pass (2/2, 19.9 seconds); assertions are unchanged.
- Firefox bulk `keyboard.insertText` after selection left the telemetry fixture's
  replacement source empty. Focus/whole-text and line/selection probes did not repair
  it: four additional failed checks, one interrupted and three not run are retained
  in `integration-telemetry-cancel-firefox*`, `integration-telemetry-cancel-diagnostic`
  and `integration-telemetry-selection` logs. Ordinary sequential key events plus
  exact line assertions pass three repetitions and the final 10-case rerun above.
  A separate default-Firefox native clipboard paste preserves exact two-line source
  (`nix develop -c env TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec node tmp/integration-firefox-paste.mjs'`: one pass).
  No production editor code changed; the failed automation input was not counted
  as a successful compile. Native composition coverage remains enabled.
- Final Chromium collaboration rerun after removing online interception: 2/2 in
  11.6 seconds. The WebKit injected-module failure and 3/3 denied-rights rerun are
  described above; no rights assertion was removed.
- The WebKit full summary exposed the second collaboration failure, which had been
  missed in streamed output. The ephemeral HTTP proxy replaces the earlier blob route
  adapter; the final six-case collaboration rerun above passes all engines, retaining
  transfer counts, exact dimensions, replacement, persistence and offline assertions.
- Pages browser tests expected the old recipe title. Their expectations now match the
  existing A5 title, `Scribyra agent (experimental)`; their behavior assertions remain.

## Limits

Linux Chromium, Firefox and software-rendered WebKit are synthetic browser coverage,
not Safari/macOS or real-device/network evidence. Quota/crash failures use injected
faults; small backup fixtures do not establish throughput at the 512 MiB format limit.
The [disconnected-peer anchor limit](comments.md#limits) remains:
missing undo witness ancestry is visibly detached and requires manual reattachment.
Attribution is descriptive rather than cryptographic. Review authority transfer beyond
explicit local restoration remains unavailable. Remote collaboration and encrypted
backup remain later milestones. No new decision is required from the owner by this integration;
R4/R6 and the previously listed product decisions remain open.

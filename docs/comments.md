# Milestone 5: comments

Current integration: Comments now run with the other local features and production anchors.
See [combined verification, corrections and limits](integration-567.md). Earlier branch-only
counts and integration caveats below are historical.

Implementation and evidence for [the annotation contract](annotations-design.md).
The review corrections below update the roadmap task and delivery evidence on this
branch as requested; the earlier implementation evidence remains historical.

## Delivered behavior

Threads and replies are immutable version-1 records in the project Y.Doc. Message
edits/redactions, resolve/reopen, public author renames and reattachments append
causal events. Rust validates payloads, scalar boundaries, anchor shapes, rights,
moderation ownership and the event DAG, and projects concurrent alternatives.
Concurrent decisions leave a thread open with a visible conflict. New decisions
must cover every observed head; a resolve with missing causal parents is rejected. Original bodies remain in history after redaction.
Bodies render as Leptos text nodes. Mentions contain author IDs only, with no
notification or network side effect. Local author preferences are device-local;
public attribution travels with records and is not authentication.

The Comments panel supports source selection, replies, edit/redact, resolve/reopen,
filters, explicit reattach confirmation, source navigation, local author names,
mentions, range highlights and accessible point markers. Ctrl/Command+Alt+M starts
a comment; Ctrl/Command+Enter sends; Escape closes the panel and returns focus.
Composition blocks shortcuts. Successful sends restore composer focus; save failures
focus Retry without taking focus from another active control. Drafts survive
validation and save errors. Opening another thread or starting a reattachment is
blocked while a draft or unsaved send is pending; sending therefore retains the
original discussion target. Navigating with an empty draft resets the composer to
reply mode and clears its message target, mentions and captured selection. Sending
an edit additionally checks that the target belongs to the displayed thread.
Messages awaiting a missing thread are counted visibly
and remain in recovery exports. Failed
local saves expose retry and a JSON discussion/draft recovery download; retry
flushes the existing mutation rather than creating another message. That recovery
JSON is not milestone 7's complete project backup. Ordinary source ZIPs still
contain accepted source only.

## Anchor and command interfaces

`web/comment-anchors.js` exports `anchors.capture(doc,fileId,start,end)`,
`anchors.resolve(doc,anchor)` and `anchors.rebind(doc,anchor,fileId,start,end)`.
Capture/rebind use current UTF-16 scalar boundaries and store relative positions,
compressed selected-item witnesses and bounded fallback context. Resolution is
`{status:'attached',start,end}` or `{status:'detached',reason}`. Partial deletion
narrows to surviving witnesses; the panel additionally labels it narrowed. No
text search automatically reconnects a deleted selection, even when replacement
characters are identical. Rename/move keeps file identity. Trash restoration
reconnects the same text identity. Duplicate files/folders acquire independent
identities and do not copy discussions. Only this adapter inspects Yjs structs.
Selections exceeding 4096 witness runs are rejected without sampling.

Actual undo/redo follows local redo links only within the foundation undo hook,
and appends replacement bindings with restored item identities before the
source operation finishes publishing its updates. Translation follows only
selected identities; interior insertions never become witnesses. Deleted witness runs remain in the binding during partial
restoration, so sequential undo can recover the entire original selection. Original
quote/context remain recovery aids rather than being recaptured from the highlight.
Those events survive peer updates and reload. Conflicting manual
reattachments remain detached until a new explicit decision covers all heads.

Before source undo/redo, the adapter rehearses the same stack on an isolated Y.Doc,
including local redo links and their struct boundaries. It validates the complete
binding events, change record and any new author profile against the existing
record/UTF-8 limits. The live source operation then publishes those prepared
records before its observers publish updates. A rejected rehearsal empties the
operation's stack only for that transaction and restores its original entries at completion; source,
revision and undo/redo history stay unchanged. The panel reports the rejection.
No exception escapes Yjs's `beforeTransaction` observer (which is outside its
transaction cleanup guard). This uses the existing foundation undo hooks without
changing their contract or the review-consumed anchor interface. Rehearsal copies
the document synchronously; large-project undo latency remains a performance limit.

The trusted internal v2 host advertises exactly nine implemented operations:
`thread.list`, `thread.get`, `thread.create`, `thread.reply`, `message.edit`,
`message.redact`, `thread.resolve`, `thread.reopen`, `anchor.reattach`. Reads need
`read`; mutations need `comment`, and modifying another author's message also
needs `review`. Every mutation has the foundation revision/replay/lifetime checks.
As specified, command success means applied in memory; the panel separately waits
for the existing local save queue. No companion or public agent API was added.

Lists expose pending-message counts, default to 50 and accept 1–100 items, with a 64 KiB JSON bound and revision/
filter-bound cursors. Lists omit bodies. Explicit thread reads page individual
message alternatives, then compact thread/anchor event summaries. Alternatives
carry `variantIndex`, `variantCount`, and `eventHeadsComplete`; clients collect
heads across pages before resolving a conflict. Decision summaries expose `isHead`
and `parentCount`. Anchor read metadata is bounded context, not the potentially
large witness array. Storage retains complete records and ancestry. UI lists and
message details also reveal additional items through More controls.

## Cleared-edit navigation verification

The cleared-edit correction resets empty composer navigation and checks edit
membership in the displayed thread before dispatch. Six new browser cases
cover new/reply/edit drafts, the exact edit → Clear draft → open B → send sequence,
redaction while editing, and rejection of a mismatched edit target. The five UI
navigation cases check both discussions again after reload. Anchor behavior is
unchanged; the existing point-comment test additionally waits for the documented
post-send composer focus before selecting source. No existing assertion was removed
or weakened.

Commands run from this worktree (browser runs use `SCRIBYRA_TEST_PORT=4501`):

```sh
nix develop -c npm run fixtures
nix develop -c npm run build
nix develop -c node --test tests/comments.test.mjs
SCRIBYRA_TEST_PORT=4501 nix develop -c npx playwright test tests/browser/comments.spec.js tests/browser/editor.spec.js --project=chromium
SCRIBYRA_TEST_PORT=4501 nix develop -c npx playwright test tests/browser/comments.spec.js tests/browser/editor.spec.js --project=firefox
SCRIBYRA_TEST_PORT=4501 nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/comments.spec.js tests/browser/editor.spec.js --project=webkit
SCRIBYRA_TEST_PORT=4501 nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/comments.spec.js --project=webkit --grep 'point comments have'
SCRIBYRA_TEST_PORT=4501 nix develop -c npx playwright test tests/browser/comments.spec.js --project=chromium --project=firefox --grep 'point comments have'
```

Fixtures and the production build passed. Comment unit tests passed 29/29 with
0 failures or skips. Final comments/editor runs passed 31/31 in Chromium,
31/31 in Firefox and 31/31 in WebKit (93 final passes, 0 failures or skips).
The WebKit full command ran three times: the first two results are below, and
the final run passed after commit `556fef3` synchronized the point test. Focused
point checks passed 1/1 WebKit and 2/2 Chromium/Firefox. Across all browser
invocations: 156 passes / 2 earlier failures / 0 skips. Commit `33dfa4a` contains
the app fix and six regressions. Full `npm test` and the frozen native suites were
not rerun for this scoped acceptance; their code is untouched. This is synthetic
Linux coverage, including Mesa WebKit, not Safari/macOS validation. No new decision
for the owner is introduced.

The first two WebKit runs each had 30 passes / 1 failure in the existing
point-comment case (`tests/browser/comments.spec.js:174`): after Backspace it
expected `Detached: associated item deleted`, but received
`main.texopen · attached · 1 messages` for 60 seconds. All six new cases passed
both times. The test selected source immediately after Send while successful
send schedules composer focus with `requestAnimationFrame`. It now waits for
that focus handoff before selecting and deleting source. The focused WebKit
check then passed 1/1. This supports a focus race as the cause (an inference);
the anchor implementation and every existing assertion remain unchanged.

## Review corrections verification

Commit `13cef5d` fixes the four independently reproduced findings. Seven new
unit cases cover interior insertion identity, sequential partial restoration,
redo of selected insertions, and atomic undo/redo rejection at both semantic
limits (including multiple anchors). Six new browser cases cover the three
identity sequences, both record-limit directions with IndexedDB saves and fresh
peer reloads, and actual reply-draft navigation from A to B. No existing test was
weakened, renamed or skipped.

All commands below ran through the flake; logs are in `tmp/comments-review-*.log`.
The three focused runs of `nix develop -c node --test tests/comments.test.mjs`
returned **22/22**, then **25 pass / 2 fail**, then **29/29**. The two intermediate
failures were the new record-limit assertions: `actual: StackItem`, `expected:
null`. Yjs had already captured the original stack array before the hook, so
replacing the manager property did not cancel mutation. Temporarily emptying and
restoring that same array fixed both directions. The final assertions compare
source/update bytes, command revision, stack identity and entries, then verify a
successful retry when sufficient metadata capacity exists.

Final full unit check: **141 Rust / 266 JavaScript-WASM passes, zero failures**;
**2 existing Rust ignores / 6 optional-service JS skips**. This includes the
frozen companion/folders builds and tests. Fixture generation and production
build both passed; Vite's build phase took 16.85 s. The browser matrix below uses
this build, port **4501**, and exactly `comments`, `editor`, and `local-tabs`.

| Final browser run | Passed | Failed | Existing platform skips | Time |
| --- | ---: | ---: | ---: | --- |
| Chromium | 33 | 0 | 0 | 1.8 min |
| Firefox | 32 | 0 | 1 | 2.6 min |
| WebKit, isolated output | 32 | 0 | 1 | 2.5 min |

Final browser total: **97 pass / 0 fail / 2 skips**, including **66/66 comments
executions**, of which **18** exercise the six new regressions. The two skips are
the unchanged Chromium-only CDP composition case in `local-tabs`; the comments
suite's native composition checks pass in all three engines.

The owned preview PID was **742830**, verified against this worktree's cwd and
stopped with `kill 742830`. The port is free, browser runs have exited, and the
core-dump scan found none. `git diff --check` passes. No push, deployment or
external service was used.

The first WebKit matrix returned **31 pass / 1 fail / 1 existing skip**. The
failure was teardown of `review probe limit-redo`, with:

```text
Error: browserContext.close: ENOENT: no such file or directory, open
  'test-results/.playwright-artifacts-0/traces/…-recording16.trace'
Error: ENOENT: no such file or directory, open
  'test-results/.playwright-artifacts-0/…zip'
```

Firefox and WebKit runs briefly overlapped in the same Playwright output
directory; trace-file cleanup contention is the inferred cause. The WebKit rerun
uses `--output=tmp/comments-review-webkit-results` without another active run.
No product code or test assertion changed for this rerun. The first failure log
remains `tmp/comments-review-webkit.log`.

Commands (each browser invocation is separate):

```sh
nix develop -c node --test tests/comments.test.mjs
nix develop -c npm run fixtures
nix develop -c env RUST_TEST_THREADS=1 TMPDIR="$PWD/tmp" npm test
nix develop -c npm run build
nix develop -c bash -c 'ulimit -c 0; echo $$ > tmp/comments-review-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4501 --strictPort'
nix develop -c env SCRIBYRA_TEST_PORT=4501 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/comments.spec.js tests/browser/editor.spec.js tests/browser/local-tabs.spec.js --project=chromium'
nix develop -c env SCRIBYRA_TEST_PORT=4501 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/comments.spec.js tests/browser/editor.spec.js tests/browser/local-tabs.spec.js --project=firefox'
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4501 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/comments.spec.js tests/browser/editor.spec.js tests/browser/local-tabs.spec.js --project=webkit'
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4501 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/comments.spec.js tests/browser/editor.spec.js tests/browser/local-tabs.spec.js --project=webkit --output=tmp/comments-review-webkit-results'
```

Limits: synthetic projects and Linux engines; no real Safari/macOS, remote-service
or large-project latency claim. Metadata is never silently pruned; exporting
recovery state does not itself free capacity. The source undo history remains
session-local, while persisted binding events restore peer/reload resolution.
Previously persisted incorrect bindings are not automatically inferred away; explicit
reattachment remains the recovery action. No decision from the owner is needed for
these corrections.

## Original implementation verification

- [x] Milestone 5: every case in the acceptance row passes in Chromium, Firefox
  and WebKit, with the requested existing regressions.

Logs are worktree-local under `tmp/comments-*.log`. The final unit run is **141 native passes / 0 failures /
2 existing ignores** and **259 JavaScript/WASM passes / 0 failures / 6 optional
service skips**, including **22 comments cases** and the shared trace regression.
The final production build passed (15.33 s Vite phase plus assets/WASM stages).

| Final check | Passed | Failed | Skipped / ignored | Timing / limit |
| --- | ---: | ---: | ---: | --- |
| Native Rust, including frozen crates | 141 | 0 | 2 ignored | Per-suite times in `comments-npm-test-6.log` |
| JavaScript/WASM | 259 | 0 | 6 optional-service skips | 14.08 s JS phase |
| Production build | 1 | 0 | 0 | 15.33 s Vite phase, plus assets/WASM |
| Chromium, eight specs | 41 | 0 | 0 | 2.8 min |
| Firefox, eight specs | 40 | 0 | 1 existing platform skip | 3.9 min |
| WebKit, eight specs | 40 | 0 | 1 existing platform skip | 3.9 min, Mesa software renderer |

The final browser matrix is **121 pass / 0 fail / 2 existing skips**, including
**48/48 comments executions** (16 cases per engine). Supplemental runs below are
not added to this total. The comments suite covers all acceptance-row groups:
Unicode boundaries and edits/deletion identity; point anchors; tree lifecycle and
duplication; undo/redo through durable peer reload; concurrent replies/decisions;
manual stale reattachment; keyboard/focus/native IME and light/dark accessibility;
offline reload and failed-save recovery. Additional cases check text-only rendering,
moderation rights, replay/closed hosts, bounded reads and oversized drafts.

Delivery record for the integrator (the roadmap was left untouched):

| Delivery | Actual final checks | Limits |
| --- | --- | --- |
| Milestone 5 — comments | 141 native / 259 JS / 121 browser passes; 0 final failures; 2 native ignores / 6 optional JS skips / 2 existing browser platform skips. Includes 48 comments browser executions. | Synthetic projects, injected quota faults, Linux browsers; no Safari/macOS, remote transport or complete-backup claim. |

All toolchain checks use the flake. WASM-producing commands finish before browser
checks. The final commands are:

```sh
nix develop -c env RUST_TEST_THREADS=1 TMPDIR="$PWD/tmp" npm test
nix develop -c npm run build
nix develop -c bash -c 'ulimit -c 0; echo $$ > tmp/comments-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4501 --strictPort'
nix develop -c env SCRIBYRA_TEST_PORT=4501 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/comments.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js tests/browser/accessibility.spec.js --project=chromium'
nix develop -c env SCRIBYRA_TEST_PORT=4501 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/comments.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js tests/browser/accessibility.spec.js --project=firefox'
nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 SCRIBYRA_TEST_PORT=4501 TMPDIR="$PWD/tmp" bash -c 'ulimit -c 0; exec npx playwright test tests/browser/comments.spec.js tests/browser/commands.spec.js tests/browser/local-tabs.spec.js tests/browser/storage.spec.js tests/browser/storage-upgrade.spec.js tests/browser/editor.spec.js tests/browser/companion.spec.js tests/browser/accessibility.spec.js --project=webkit'
```

The preview served this worktree's rebuilt `dist` on **4501**, owned PID
**481813**, checked against this worktree's cwd and stopped with `kill 481813`.
Browser fixtures closed their own contexts, custom native-input browsers and
servers. Core dumps were disabled for browser runs; the final scan found none.
`git diff --check` passes. No push, deployment or external service was used.

The ignored native cases are the subprocess crash fixture (exercised by its parent)
and optional Alloy integration. The six JS skips require private
Grafana/Alloy/GitLab infrastructure, which was not started. Existing browser
`local-tabs` native CDP composition remains Chromium-only. No existing assertion
was removed, weakened or skipped to make comments pass.


## Earlier checks and corrections

- The anchor-interface commit passed 8/8 JS cases after `npm run wasm`.
  A focused native `cargo test -p scribyra-core comments` passed 6/6
  (four new comment tests and two existing tests selected by the substring).
  Subsequent comment runs passed 15/15, then 18/19: a new orphan-anchor fixture
  incorrectly supplied empty event heads after undo had already appended a binding
  event. Supplying its observed heads made the 19/19 rerun pass. The assertions
  still require stale-head rejection and successful fresh reattachment.
- The first full `npm test` stopped with 103 native passes / 1 failure in the
  unchanged folders CLI diagnostic test. Its exported snapshot lacked the final
  successful `native_session` event. A direct isolated rerun failed 0/1 because
  `snapshot.json` was absent. These are consistent with its one-second export
  deadline under host contention; that cause is an inference. No frozen code or
  assertion changed. The next full run, with `RUST_TEST_THREADS=1`, passed
  141 native tests (2 existing ignores) and 255 JS tests (6 optional skips).
- The first Chromium comments-only run passed 13/13. The expanded eight-spec run
  had 38 passes / 3 failures. Two were new fixture assumptions: Playwright's
  `Control+Shift+z` did not reach CodeMirror redo on this Linux build (the redo
  stack remained intact), and CDP emitted a synthetic composition-end event.
  The fixture now sends the platform's Ctrl+Y redo and requires two trusted
  composition starts, correct cancel/commit, no mid-composition send and exact
  committed Unicode. Gecko/WPE additionally require every composition event to
  be trusted. No existing browser test was changed. A focused run had 1 pass /
  2 failures before Ctrl+Y was applied; the diagnostic redo run failed 0/1;
  the corrected redo case then passed 1/1.
- The third failure reproduced in the unchanged companion trace case. The
  foundation build coordinator cloned the recorder's identity-bound parent
  capability with compiler inputs; its WeakMap rejected the clone, dropping
  child pass spans. Separate shared commit **`4ff13d3`** changes only
  `web/build-session.js` and its unit suite: preserve that opaque context while
  copying compiler data. A real WASM recorder regression verifies the trace
  relationship and unchanged byte-copy isolation. Focused comments/build tests
  passed 23/23. No shared schema, app shell, model, command parser or frozen crate
  changed.
- The next Chromium matrix had 39 passes / 1 setup failure / 1 unrun case:
  the unchanged command fixture's fixed port 8787 was occupied. The listener was
  left untouched. Separate shared test-only commit **`b1c0ebf`** makes
  `tests/browser/commands.spec.js` request an ephemeral loopback port and forward
  its existing transport to that owned child. It preserves both race assertions
  and the frozen demo's address/origin policy. Focused rerun: **2/2 passed**.
- The first Firefox matrix had **38 pass / 2 fail / 1 existing skip**. Its native
  same-text insertion was optimized into no CRDT mutation; the fixture now performs
  an explicit deletion and insertion, asserting detachment both times. The other
  failure was offline navigation. Waiting for actual service-worker control
  strengthened readiness but did not alone fix it: the next matrix was **39 pass /
  1 fail / 1 skip**. The UI fixture was still installing unused harness routes;
  Firefox offline navigation failed under that interception. Production UI cases
  now use normal served assets; only the service-worker-blocked contract fixtures
  install harness routes. The isolated Firefox offline rerun passed **1/1**.
- A stronger post-send keyboard-focus assertion failed **0 pass / 1 fail** and
  confirmed that disabling the composer during save could leave focus on the body.
  Commit **`c285611`** restores composer/Retry focus while preserving another active
  control. Both theme cases and failed-save recovery now assert the focus targets.
- Final review bounded fallback-context extraction, exposed messages awaiting their
  thread and rejected resolved receipts with missing causal parents; three more
  unit cases bring comments to 22. A preliminary `npm test` failed during WASM
  compilation (`E0308`): a Leptos comparison needed braces inside the attribute.
  No tests ran in that invocation. After correction, two full runs passed
  **141 native / 259 JS**, with the same 2 ignores / 6 optional skips.
- After those fixes the final Chromium eight-spec run passed **41/41**. A further
  **41/41** run verified the final UI fixture without harness interception. Final
  Firefox and WebKit each passed **40**, with **1 existing platform skip** and no
  failures. Both engines include **16/16 comments cases**.
- Production builds used provisioned compiler assets (`Verified cached LuaLaTeX
  baseline and static components`). No TeX runtime download was requested.
  One initial shell redirection failed before `tmp` existed; it ran no check.
  The old foundation assertion that anchor capture was unsupported now asserts
  the implemented missing-file `anchor_detached` error.


## Limits

Disconnected-peer witness ancestry remains a known limit for milestone D to
revisit: comment on `b` in `abc`; disconnected peers A and B both delete `b`;
B undoes and redoes; merge; A undoes. Source returns to `abc`, but the comment
stays visibly detached. Manual reattachment remains available. The architect
accepted recording this fail-safe limit for now; milestone D must revisit witness
ancestry across peers. No test asserts that this is desired behavior.

Synthetic fixtures exercise real Yjs, Rust/WASM, IndexedDB and same-profile tabs.
Quota errors are injected IndexedDB exceptions, not physical disk exhaustion.
Linux Playwright WebKit uses Mesa software rendering and does not establish
Safari/macOS behavior. Native CDP, Gecko TextInputProcessor and the existing WPE adapter exercise
composition on this host; they do not establish physical IME coverage on other
operating systems. No large-project anchor
latency benchmark, authenticated identity, remote transport, encryption or complete
backup recovery is claimed. Separate-profile review-package exchange belongs to
milestone 6. Open roadmap items (R4/R6, A4 and independent security review)
are unchanged; comments require no new product decision.

## Device-local comment draft recovery — November 7, 2026

Comment, reply and message-edit composers checkpoint their text and target on every
input in the device-local `scribyra:comment-drafts:v1` preference. Reopening the
same project restores the composer, mentions and original thread/message target.
New comments retain a relative source anchor; a restored composer resolves that
anchor before submission. Starting another composer cannot replace a nonempty
draft's target. Multiple retained entries are offered newest first, with the next
entry restored after submitting or explicitly clearing the current one.

An unsent draft replaces an otherwise “Saved locally” indicator with “Comment
draft · not yet submitted”. All projects and other project navigation ask before
leaving; the unload guard requests the browser's usual warning on reload or close.
A durable submission clears its draft only after the project save completes. A
stored submission marker also prevents recovering the same message after a crash
between commit and cleanup. Failed saves keep the draft and existing Retry flow.
Clear draft and Cancel explicitly discard; exporting alone does not clear it.

Missing threads or deleted original source selections leave the text in the
composer with a plain recovery message. Sending and choosing a different target
are blocked; copy/export the text or clear it explicitly. Drafts never enter the
Y.Doc, source ZIPs, review exchange, project history or complete backups. The
explicit **Export discussion and draft** recovery download remains available.
Unaccepted TeX-link projects keep drafts in memory, with an export warning.

Limits are 64 KiB UTF-8 JSON per entry (including target/anchor metadata), 128
entries and 1 MiB total across projects. A rejected write never truncates text or
evicts a previous draft: the current text stays in memory, the last recovery copy
stays stored, and an error asks the person to export before leaving. Browser
storage deletion/private-session expiry still removes device preferences. Drafts
are not a synchronized collaboration feature; two tabs that independently start
drafts retain separate entries, while editing the same recovered entry in two
tabs has last-writer behavior.

### Draft recovery verification

All browser commands used this worktree's production `dist` on port 5601. The
owned preview server was started with:

```sh
nix develop -c sh -c 'echo $$ > tmp/comment-preview.pid; exec node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5601 --strictPort'
```

Verification commands:

```sh
nix develop -c npm run fixtures
nix develop -c npm run build
nix develop -c node --test tests/comments.test.mjs
nix develop -c env SCRIBYRA_TEST_PORT=5601 npx playwright test tests/browser/comments.spec.js --project=chromium --grep 'editing (comment|reply) draft survives|missing-thread recovery|draft recovery keeps|reload after a failed'
nix develop -c env SCRIBYRA_TEST_PORT=5601 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/comments.spec.js tests/browser/review-workspace.spec.js tests/browser/review-editor.spec.js tests/browser/editor.spec.js --project=chromium --project=firefox --project=webkit
git diff --check
```

The 18 lifecycle cases cover both new comments and replies through reload, tab
close and All projects in Editing, Reviewing and Viewing, in each engine. Five
additional cases cover orphan threads, size/quota errors with unchanged project
bytes, failed-submit reload and commit/cleanup interruption, deleted source
selections and failed-edit acknowledgement. Three store tests check project/thread
isolation, count/byte bounds and non-destructive storage failure.

Tab-close automation checks a cancelable unload event and then force-closes the
tab to model abrupt loss; it does not assert native browser prompt chrome. Reload
accepts any native unload dialog. All projects tests the real confirmation's
Cancel and Continue paths. These are synthetic Linux browser engines, not Safari
on macOS or a real-person tab-close trial. Full `npm test`, native/frozen companion
and folders suites, Pages, and remote services were outside this focused gate.

Fixtures passed once; four production builds passed. Both completed comment-unit
runs passed 33/33 with no skips. Two earlier unit invocations failed at module
startup because generated WASM was absent; they ran no comment assertions. The
focused Chromium command passed 9/9. The first broad attempt was stopped for the
edit-acknowledgement correction after 22 passes, one interrupted case and 244
unrun cases. The next attempt reached 81 passes, one assertion failure, one
interrupted case and 187 unrun cases. Its redacting-composer assertion still
expected the old “Saved locally” global label while an edit draft remained open.
That assertion now checks the new draft label **and** the separate durable
“Saved locally” comment status; the original navigation/message assertions remain.

The final uninterrupted acceptance run passed **270/270**, with no failures or
skips (16.6 minutes):

| Spec | Chromium | Firefox | WebKit |
| --- | ---: | ---: | ---: |
| `comments` | 55 | 55 | 55 |
| `editor` | 3 | 3 | 3 |
| `review-editor` | 10 | 10 | 10 |
| `review-workspace` | 22 | 22 | 22 |
| Total | 90 | 90 | 90 |

This includes all 69 new browser regression executions. Across completed and
interrupted attempts, 382 browser cases passed, one old-label assertion failed
and two cases were interrupted; the earlier unrun cases are not skips in the
final matrix. `git diff --check` passed. Both owned preview servers were stopped
by exact PID, and no browser or core dump was left in the worktree.

## Discussion on suggestions — November 7, 2026

Suggestion cards use the same reply composer, plain-text messages, avatars,
names, relative times and edit/delete menus as comment cards. All messages on a
suggestion count as replies. Editing, Reviewing and Viewing all allow discussion;
comment rights cannot accept, reject, withdraw, resolve or reattach a suggestion.
Collapsed cards show a reply count. Overview counts each suggestion once.

`thread.create` accepts `{suggestionId,body,mentions?}` instead of a source range.
`thread.reply` accepts either `{threadId,body,replyToId?,mentions?}` or
`{suggestionId,body,replyToId?,mentions?}`; the latter creates a thread on first
use. Mixed targets are rejected. `thread.list` can filter by the original
`suggestionId`; list/get expose that immutable identity and the derived
`displaySuggestionId`. Commands retain the existing revisions, replay, bounded
reads, ownership checks and trusted agent attribution. Independent first replies
can create multiple threads; the card shows every one, without rewriting IDs.

Unsent suggestion replies use the existing device-local draft journal. The
original proposal ID is retained even if the author revises the proposal while
the draft is open. A missing/restored-away target blocks submission and keeps
the text exportable. Sent messages travel with project history, complete backups
and review exchange; unsent device preferences remain excluded. Message bodies
always render as text, including HTML-looking content.

See [the design amendment](annotations-design.md#suggestion-discussion-amendment--7-november-2026)
and [verification](reviews.md#suggestion-discussion-verification) for migration,
resolved outcomes, commands, actual counts and limits.

## Direct-session reunion limit

D rechecks the disconnected-peer case. An anchor created only on an offline
peer is unknown to the profile doing a delete followed by undo. That profile
cannot publish a rebind for an anchor it has never seen. After reunion the text
can match exactly while the original witness items remain deleted; the anchor
stays **Detached**, with its quote available for explicit manual reattachment.
`tests/replication.test.mjs` checks that matching restored text does not silently
reattach this unknown anchor. Known-anchor undo still publishes the existing
bindings and travels with the same replicated document. No claim of universal
anchor survival across offline undo is made.

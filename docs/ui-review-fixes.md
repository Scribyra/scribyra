# Combined UI review corrections — November 7, 2026

Tree menus keep their opening command revision through every action and dismiss
when that revision changes. Actions also check synchronously, covering a click
before observers or animation frames run. Rename, move and duplicate keep the
same revision through their prompts. Ordinary file deletion still moves to
recoverable trash without a second confirmation, as requested by the architect;
folder deletion still confirms.

Native-select popups dismiss when the value, selected index, options or enabled
state changes, including property changes without DOM mutations. Selection
checks the captured state and whether the popup is still open before writing or
emitting input/change events. Regressions cover Tab, Enter, retained clicks,
Viewing's transaction guard and a real same-profile peer rename.

Reviewing consumes individual CodeMirror changes in reverse position order,
validates the resulting draft and editor text, then publishes the draft once.
Protected matches reject the complete editor transaction with a plain message.
Separate and adjacent matches become separate suggestions; intervening foreign
suggestions and accepted source remain intact. Thirty-two seeded production
sessions vary Unicode, replacement lengths, deletion, adjacent matches and
foreign proposals, and check refusal without draft changes plus persisted reload.

History retries focus until the target actually becomes the active element.
The narrow Versions regression holds a laid-out row at `visibility:hidden`
through the first attempt. Restoring the old stop-after-first-attempt behavior
in the served bundle makes that test fail with an inactive row; the bundle was
restored before acceptance runs.

## Verification

All commands ran through the flake, from this worktree. The preview served this
worktree's production `dist` on port 5451. Compiler assets and telemetry tools
were already provisioned; no runtime download or deployment was performed.

```sh
nix develop -c npm run fixtures
nix develop -c npm test
nix develop -c npm run build
nix develop -c node --test tests/review-input.test.mjs tests/integration-random.test.mjs
nix develop -c node --test --test-name-pattern='review replace-all transaction|projection|input|revision|deletion|insertion|authors|draft' tests/review-input.test.mjs tests/integration-random.test.mjs
nix develop -c node --test --test-name-pattern='review replace-all transaction' tests/integration-random.test.mjs
nix develop -c node --test tests/review-input.test.mjs
nix develop -c env SCRIBYRA_TEST_PORT=5451 npx playwright test tests/browser/menus.spec.js tests/browser/editor-search.spec.js tests/browser/history.spec.js --project=chromium --grep 'stale mode|property-only|peer rename|same-task revision|intervening foreign|collapses the version' --reporter=line
nix develop -c env SCRIBYRA_TEST_PORT=5451 npx playwright test tests/browser/history.spec.js --project=chromium --grep 'collapses the version' --reporter=line
nix develop -c env SCRIBYRA_TEST_PORT=5451 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/{tree,menus,editor-search,review-workspace,review-editor,history,accessibility}.spec.js --project=chromium --project=firefox --project=webkit --reporter=line
nix develop -c env SCRIBYRA_TEST_PORT=5451 __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/history.spec.js --grep 'collapses the version' --repeat-each=10 --project=chromium --project=firefox --project=webkit --reporter=line --output=tmp/ui-batch-fix/history-repeats
```

The narrow Versions test passed 30/30 repetitions: 10 each in Chromium, Firefox
and WebKit, with no skips. Both production builds and fixture generation passed.
The final uninterrupted seven-spec matrix passed 324/324: 108 each in Chromium,
Firefox and WebKit, with zero failures or skips. The completed `npm test` passed
162 native Rust and 1,109 JavaScript/WASM tests, with zero failures, including
all 512 production sequences and the 32 new replace-all seeds. It also built
the frozen companion and folders binaries/examples.

The two default Rust ignores are the subprocess worker fixture (invoked by its
crash-recovery parent test) and the optional real-Alloy test, for which
`SCRIBYRA_TEST_ALLOY` was not configured. Six JavaScript checks require private
Grafana/GitLab/service-stack configuration and retained their existing skips.
No browser acceptance case was skipped.

The preview was stopped by its exact recorded PID (3487266). Both browser
runners exited successfully; no core dumps or task servers remain.

Development evidence: the first focused unit run was stopped after four
reported passing sequences to narrow the selection; the next focused selection passed 70/70.
After adding adjacent matches, the seeded selection passed 32/32 and input tests
passed 15/15. The first six-case browser run passed four and failed two new
assertions: one counted DOM pieces split by search highlighting, the other
compared rendered `innerText` with CodeMirror's concatenated text nodes. They now
check unique suggestion IDs and the editor document, respectively. The corrected
six-case run passed 6/6. The existing tree migration assertion expected schema
7 after this combined branch introduced schema 8; it now expects 8 and retains
the exact recovery-byte checks. No existing test was weakened, skipped or
renamed. The first full unit run was interrupted to rerun against the final implementation
(162 native passes, two existing ignores and 101 reported JavaScript passes
before interruption; incomplete JavaScript results are not acceptance evidence).
The old-focus behavior probe intentionally failed 1/1 at `toBeFocused`, as expected.

An initial matrix attempt ran while `npm test` had regenerated the 134 MiB debug
WASM used directly by browser harnesses. It passed 16 cases, then recorded 14
Chromium history-harness page-closure failures; 294 cases did not run after a
controlled interruption. A subsequent production rebuild restored the 4.6 MiB
release WASM before the final matrix. The release app and harness assets must be
assembled after the unit command has generated development WASM.

The first release-artifact matrix passed 127, failed the stale schema assertion
once, and was interrupted in one Firefox case with 195 not run to apply that
correction and rerun the requested matrix.

Limits: Linux automation, with software-rendered WebKit; no real assistive
technology or other operating-system claim. The full browser suite is left to
the architect. The private telemetry services are not started by this task.
There is no new decision for the owner.

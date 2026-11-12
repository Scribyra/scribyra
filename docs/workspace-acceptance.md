# Workspace acceptance gate

Goal 1f.3 covers keyboard navigation and focus recovery, real composition input,
and a combined nested project containing Unicode paths, images and citations.
Missing files and source errors must keep the previous PDF visible; undo,
export/reload and offline recompilation must preserve the project. Concurrent
move/delete, save-failure and migration recovery checks remain required.

## Native composition evidence

All native probes run against the real CodeMirror/Yjs editor and durable browser
storage. The Unicode marker contains Japanese text, an astral character and a
combining accent. Exported UTF-8 bytes must contain the committed marker exactly
once without temporary composition text; undo/redo and reload preserve it.

- Chromium uses `Input.imeSetComposition` and `Input.insertText`. The browser
  reports trusted composition-start/update events; its CDP commit path reports
  the final composition-end event as untrusted. The probe explicitly ends the
  remaining protocol composition before testing shortcuts and durable state.
- Firefox uses Gecko's `nsITextInputProcessor` in a temporary browser profile.
  It creates and cancels one preedit, then commits another, and requires trusted
  composition events including both endings. The helper verifies Marionette's
  profile identity before executing privileged native input. Port 2828 is
  loopback-only and checked for an existing owner before launch; the browser,
  socket and temporary profile are closed afterward.
- Linux WebKit uses the stock Playwright WPE browser with a small test-only
  `WebKitInputMethodContext` implementation. GLib dispatches native preedit,
  cancellation and commit signals on the UI thread; the engine must emit trusted
  DOM composition events and preserve the same byte-exact editing behavior.
  `LD_PRELOAD` applies only to this isolated test browser. Private command files
  and the browser are removed afterward; no adapter ships with the static app.

These probes exercise browser input engines, not an operating-system candidate
popup. Linux WPE coverage does not establish macOS Safari or iOS behavior. The
flagged synthetic-key tests remain separate checks of application shortcut and
form policy; DOM dispatch alone is not native input evidence.

Gecko and WPE also receive Ctrl+Enter during native preedit and project search
after commit: compilation must stay idle during composition, then shortcuts must
work again. Gecko sends the preedit key through the same TextInputProcessor;
Playwright’s separate keyboard processor cannot own an active composition.

Application shortcuts and form actions check composition state and the legacy
229 key-code boundary. Editor shortcuts run through CodeMirror, including its
search panel. Ctrl/Command+Enter compiles without inserting a blank source line.

## Keyboard and semantic assessment

Acceptance covers F2 and row-menu rename, composition Enter suppression, Escape,
stable-ID focus restoration after rename, deletion/recovery, source and project
search shortcuts, outline navigation, tab navigation and pane resizing.

Axe scans the dashboard, editor and settings in both light and dark themes, plus
a compiled PDF with its controls and text layer. The WCAG 2 A/AA and 2.1 A/AA
rules are enabled without exclusions. Accessibility snapshots additionally check
that tree items and file tabs belong to their named composite widgets. Separate
row controls remain reachable without becoming invalid tree/tab children.

The assessment found and fixed low-contrast muted/syntax text, invalid composite
children, a file icon competing with its accessible name, a non-focusable source
scroll area, and focus loss after deletion. Automated scans and browser keyboard
tests are bounded evidence, not screen-reader or WCAG conformance certification.

## Combined project and recovery

The combined fixture includes a nested main, an accented input path, PNG bytes,
BibTeX citations and an empty folder. It requires successful compilation,
preserved previous PDF during missing-file/source failures, undo recovery,
byte-exact export and offline reload/recompilation in all three browser engines.
Existing suites cover tree operations, images, directory import/duplication,
concurrent commands, stale tabs, durable saves and migration rollback.

Validation: production build, 25 Rust core tests and 64 JavaScript tests pass.
Across the matrix and targeted rechecks, all 63 distinct applicable browser
scenarios pass. The final native/accessibility subset passes 17 cases, with four
intentional skips selecting the native adapter for its own engine. Chromium's
native probe and the combined compile/error/offline matrix also passed in the
broader run; the six cross-engine native-adapter skips do not leave an engine
without a native probe.

These are results across runs, not a single uninterrupted clean matrix. A test
sequence focused the source before a scheduled tree focus completed; removing a
redundant tree activation corrected that harness race. A parallel unit build
replaced generated WASM bindings while the tree suite was starting, causing
harness link errors; sequential build/test reruns passed all nine tree cases.
The folder recovery test exposed a real fallback-order bug that selected Project
root before available files; the corrected priority passes in all three engines.
Gecko's active input transaction requires its own keyboard processor, as described
above. The final checks ran after rebuilding and without concurrent asset writes.

The user-supplied IEEE ZIP was also re-imported unchanged in a fresh Chromium
context: IEEEtran downloaded from the live mirror and LuaLaTeX produced five
pages / 121,508 bytes. Private sources, PDF and logs remain in ignored `tmp/`.

Goal 1f.3 and the milestone-1 workspace foundation gate are complete within these
explicit browser/platform boundaries. Expanded package delivery, authenticated
transports, MCP and later roadmap milestones remain open.

References: [Chromium Input protocol](https://chromedevtools.github.io/devtools-protocol/tot/Input/),
[Gecko input-method guide](https://firefox-source-docs.mozilla.org/editor/IMEHandlingGuide.html),
[Gecko TextInputProcessor interface](https://github.com/mozilla/gecko-dev/blob/master/dom/interfaces/base/nsITextInputProcessor.idl),
[WebKit InputMethodContext](https://webkitgtk.org/reference/webkit2gtk/stable/class.InputMethodContext.html),
and [UI Events composition specification](https://w3c.github.io/uievents/#events-compositionevents).

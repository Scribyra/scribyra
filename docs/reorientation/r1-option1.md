# R1 Option 1: text-based browser automation as the default

This is the investigation baseline. [A1/A2 delivery](a1-a2.md) implements changes
1–6 and the project title from change 8, with new measurements and three-engine
checks. The original observations and measurements below are retained; real-tab
attachment and the other proposed changes remain outstanding.

## Verdict

Option 1 works today from a compiled project through to a recompile, but only with discipline. It is not yet a good default, for three reasons.

1. **Whole-page snapshots are too expensive.** One full S1-S7 run on the thesis returned 364 KB (about 90,000 tokens). One project search in an open sidebar makes a single snapshot 620 KB.
2. **Snapshots give wrong source line numbers.** CodeMirror blank lines are missing from snapshots, so line numbers cannot be paired with text. The S5 read failed 6 of 6 times on the thesis with snapshot-only routes.
3. **Reaching the user's tab is the hardest part, and the app cannot fix most of it.** A normal browser refuses CDP. Only the extension route attaches without a debug flag, and it asks the user to approve exposing the browser.

The 14 small and medium app changes in the [change list](#4-app-changes-needed-for-option-1-as-a-default) address the first two, and items 1-6 are the minimum. They do not implement comments or reviews, which milestones 5 and 6 still own.

## 1. Method

**Route used:** `@playwright/mcp` 0.0.84 (`npx`-installable, latest release on the test date), driven by a real stdio MCP client and running Chromium 156 headless. Bytes are the text of each MCP tool result.

**How close this is to what an agent receives:**
- The tool results are the real ones.
- The "agent" is a deterministic script. No model ran, so model latency, model mistakes, retries from misreading and cumulative context are **not measured**.
- The scripted parser is more reliable than a model at finding a value in 40 KB of YAML, so these figures flatter routes A and B.
- MCP tool definitions and client framing are measured separately or excluded.
- Tokens are chars/4 plus `gpt-tokenizer` cl100k. **cl100k is a proxy, not Claude's tokenizer.** No real Claude count was taken.

**Build:** production `vite build` of HEAD 102d6dc, using `web/pkg` and `public/core` from the main checkout, served on :5181 with a fresh isolated browser context for each flow. S2 is therefore a cold compile and S7 a warm one. Other R1 agents shared the host and some of my other experiments overlapped these runs, so treat `ms` as indicative. Byte counts were effectively identical across runs.

**Three routes, because "Option 1" covers very different costs:**

| Route | Reads with | Acts with | Needs |
|---|---|---|---|
| A, full snapshot | whole-page `browser_snapshot` | refs from the last snapshot | no app knowledge |
| B, scoped snapshot | `browser_snapshot {target}`, `browser_find` | role selectors | selectors learned in advance; some are CSS because no role exists |
| C, targeted DOM | `browser_evaluate` | `browser_run_code_unsafe` batches | agent-written JS and Playwright code, CSS selectors; tuned flags `--codegen none --snapshot-mode none` |

**Fixture definitions, which comparisons with other options should respect:**
- Runs: `missing-package` and `article` runs 1-3, `thesis` runs 5-7.
- `article` and `thesis` compile cleanly, so S5 uses a **synthetic** location (`main.tex:5`, `chapters/page-050.tex:6`).
- S6: `missing-package` removes the bad `\usepackage`, `article` renames a section, and `thesis` deliberately injects `\undefinedcmd`, so its S7 fails.
- S8 is an extra thesis step: read the first error and locate it. It is outside the S1-S7 totals.
- S0 is setup (navigate and Import ZIP), also outside the totals.
- S4 on a clean compile costs 0 because nothing is read. The only signal for "no warnings" is the absence of text in the status.
- Route A S4 and S8 cost 0 because they reuse the previous full snapshot. That cost is already counted in S3 and S7.

## 2. Results

### Totals, S1-S7 per run (median, range where it varied)

| Route | Fixture | Response bytes | ~tok chars/4 | cl100k | Trips | ms | Failed steps | Request bytes |
|---|---|---|---|---|---|---|---|---|
| A | missing-package | 136,140 | 33,976 | 44,808 | 21 | 16,276 (16,143-16,592) | 0/21 | 1,331 |
| A | article | 53,731 | 13,339 | 15,034 | 22 | 20,356 (20,179-21,178) | 0/21 | 1,407 |
| A | thesis | 363,671 (362,641-365,165) | 90,043 | 103,140 | 24-25 | 45,767 (44,222-47,090) | **3/21** | 1,624 |
| B | missing-package | 18,890 | 4,714 | 6,302 | 22 | 16,518 (16,176-16,619) | 0/21 | 1,922 |
| B | article | 8,428 | 2,099 | 2,715 | 21 | 20,224 (20,180-20,258) | 0/21 | 1,858 |
| B | thesis | 11,696 | 2,915 | 3,253 | 22 | 44,954 (44,832-46,466) | **3/21** | 1,995 |
| C | missing-package | 1,325 | 330 | 436 | 8 | 17,716 (17,627-18,146) | 0/21 | 2,968 |
| C | article | 1,101 | 273 | 396 | 6 | 21,060 (20,918-21,237) | 0/21 | 2,358 |
| C | thesis | 1,351 | 336 | 370 | 6 | 43,396 (42,224-45,854) | 0/21 | 2,453 |

**One-time session cost:** MCP `tools/list` is 21,070 bytes (5,268 chars/4, 4,465 cl100k) for 25 tools, on every route. That alone exceeds the S1-S7 response total of every route B and route C run. It is excluded from the totals above.

**Route C's request bytes matter.** It sends about twice as many bytes in agent-written code as it receives, and those are model output tokens. Compare routes on request plus response.

### Per step, median bytes (trips)

Full table with ranges, tokens and wall time is in `out/aggregate.md`, next to this report.

| Step | A missing | A article | A thesis | B missing | B article | B thesis | C missing | C article | C thesis |
|---|---|---|---|---|---|---|---|---|---|
| S0 setup | 3,628 (4) | 3,620 (4) | 3,619 (4) | 1,066 (3) | 1,058 (3) | 1,057 (3) | 497 (3) | 465 (3) | 465 (3) |
| S1 project, active file | 4,316 (1) | 5,455 (1) | 31,854 (1) | 1,092 (2) | 1,084 (2) | 1,083 (2) | 83 (1) | 75 (1) | 76 (1) |
| S2 compile, wait | 727 (2) | 728 (2) | 928 (2-3) | 723 (2) | 724 (2) | 692 (2) | 291 (1) | 264 (1) | 235 (1) |
| S3 status | 15,737 (1) | 5,899 (1) | 39,674 (1) | 485 (1) | 455 (1) | 432 (1) | 70 (1) | 42 (1) | 45 (1) |
| S4 diagnostics | 0 (0) | 0 (0) | 0 (0) | 631 (1) | 0 (0) | 0 (0) | 214 (1) | 0 (0) | 0 (0) |
| S5 go to line, ±5 | 32,639 (5) | 12,997 (5) | **115,570 (7) fail** | 12,832 (5) | 2,036 (4) | **3,661 (5) fail** | 365 (2) | 449 (1) | 713 (1) |
| S6 edit | 51,345 (9) | 21,983 (10) | 118,484 (10) | 1,861 (8) | 2,924 (9) | 4,638 (9) | 38 (1) | 38 (1) | 38 (1) |
| S7 recompile, status | 31,376 (3) | 6,669 (3) | 57,393 (3) | 1,266 (3) | 1,205 (3) | 1,190 (3) | 264 (1) | 233 (1) | 244 (1) |
| S8 extra, failed thesis | | | 0 (0) | | | 19,307 (2) | | | 356 (2) |

Compile time dominates wall time on every route: about 9 s (`missing-package`), 13 s (`article`) and 38 s (`thesis`) cold; 2-5 s warm.

### How size scales

- **Route A grows with the project.** The thesis has 102 tree items, 102 row-action buttons, and 101 options in the `Main document` select. A clean full snapshot goes from 5.5 KB (`article`) to 31.9 KB (`thesis`).
- **Route B stays flat except where it must read the log.** S3 is about 450 bytes on all three fixtures. S5 on `missing-package` and S8 on `thesis` jump to 12.8 KB and 19.3 KB, because the first error's line exists only inside the raw log.
- **Route C stays flat throughout**, at about 1.3 KB.

### Failures

Final run: 6 failed rows out of 225 measured step rows, all the same defect (below). Three more rows record the `tools/list` overhead and are not steps.

| Failure | Where | Evidence |
|---|---|---|
| **Wrong line mapping** | A and B, thesis S5, 6/6 | 23 gutter numbers against 12 text nodes. Only 6 of the 11 target lines are non-blank |
| `wait_for` hit its 30 s cap | A, thesis S2, runs 6 and 7 | `browser_wait_for` returned an error on a long compile, and the agent had to call again (the tool caps at 30 s) |

**Pitfalls hit during dry runs, then scripted around.** A real agent would have to discover each of them:

| Pitfall | Effect |
|---|---|
| `/^Compile/` also matches the status button `Compiled · 3.48 s · 1 page` | Strict-mode violation on every recompile after a success |
| Status name containing `:` changes YAML quoting (`'button "Missing TeX file: …"'`) | My first parser missed it and silently read the wrong button |
| First click on CodeMirror's `replace` only selects the match and reports nothing | The edit silently did not happen, and pressing Enter in Find did not help |
| Reading back the edit from a full snapshot | False positive: the Replace field and the PDF text layer also contain the new words |

## 3. UI audit

### Editor (CodeMirror 6.43)

| Finding | Evidence | Effect |
|---|---|---|
| **Blank lines are absent** from MCP snapshots | `page-050.tex`: gutter 1-23, 12 text nodes, ref numbers jump `e1142`→`e1144` | Gutter numbers cannot be paired with text. A compile error's line cannot be read reliably |
| Gutter and text are separate lists | Numbers precede `textbox "LaTeX source"` | Pairing is positional only |
| **Indentation and repeated spaces collapse** | `    indented  x` appears as `indented x` | Whitespace-sensitive source cannot be read or edited from a snapshot |
| **`browser_type` on the editor replaces the whole file** | It calls `fill`. A two-line file became `    indented  x`. No error | Data-loss hazard from the most obvious tool (undo may recover it; not tested) |
| **Plain `locator.ariaSnapshot()` shows no source at all** | `#code-editor` is 103 bytes with default mode, 2,447 with `mode:'ai'`, in both Chromium and Firefox | Text is visible only in MCP or AI mode. Default-mode tools see an empty editor |
| Virtualized to the viewport | 52 of 109 lines in thesis `main.tex` | Good for size. Lines off-screen need navigation first |
| No cursor position anywhere in the UI | Nothing reports the current line | The agent cannot confirm that go-to-line worked |
| Search panel names are generic and lowercase | `next`, `previous`, `all`, `replace`, `replace all`, `close`. `name="replace"` without exact matching hits two buttons | Fragile, and comes from CodeMirror |

### Other panels

| Panel | Names and roles | Output size |
|---|---|---|
| **Compile control** (`lib.rs:248`) | Name is `Compile ⌘ ↵`, includes the shortcut, and flips to `Cancel ⌘ ↵` on the **same button**. Clicking again during a build gave `Compilation cancelled` (confirmed; also Ctrl+Enter by code, `main.js:521`). Prefix collides with the status text. No `aria-busy` or state attribute: 0 found mid-build | Small |
| **Status** (`lib.rs:283`) | Unstable button whose name is the whole status, for example `Caching compiler · busytex.wasm · 31.0 / 31.0 MiB…`. `role=status` matches nothing, so the route needs the CSS `.editor-status`. Zero warnings is not stated, and failures have no page count | 432 bytes scoped |
| **Diagnostics list** (`lib.rs:282`) | Good: `list "Compilation issues"`. No file or line shown, though `Issue` has both fields, and no link to the source. On the thesis error the report has `line=1` and **no file** (`diagnostics.rs:280`) | 550 bytes for one issue. Not paginated |
| **Raw log** (`lib.rs:282`) | Unlabelled `<pre>`, no region, whitespace collapsed to one line in snapshots. `.diagnostics` is a CSS-only target. **Stays open after a later success** (`missing-package` S7 is 31 KB) | **Unbounded**: 10.7K chars (`missing-package`), 17.7K chars (thesis error). `browser_find` returns the entire node, 18.6 KB, to find `l.1` |
| **File tree** (`lib.rs:211-226`) | Good: `tree "Project files"`, full paths as names. But 101 identical `File actions` buttons sit outside the tree, reachable only through DOM structure | **Grows with files**: 10.1 KB tree, 16.0 KB with buttons, on 102 files |
| **Main document select** (`lib.rs:243`) | Clear name | **Grows with `.tex` files**: toolbar 4,350 bytes, mostly 101 options |
| **PDF preview** | Good toolbar names. `region "Page ⁨1⁩"` contains U+2068/U+2069 from pdf.js, so `role=region[name="Page 1"]` **fails** (`.page[data-page-number="1"]` works). Page text is a single block with no lines. Page count is `of 100` | Bounded by rendering: 3 pages with text at default zoom, 4 at 25%, 8 after a jump. About 1.4 KB per page. 100 page regions add about 4 KB |
| **Project search** (`lib.rs:405-406`) | Named region and status | **Largest hazard**: searching `Research` gave 1,000 hits and **580 KB scoped, 620 KB full**. Each hit carries its preview twice (name and child). App limit is 2,000 hits |
| **Outline** | Named | Small here (no headings detected at current-file scope); not tested with many headings |
| **Dialogs** | All 7 tested have role and name, and no unnamed controls. The file menu's dialog is named only after the file (`main.tex`). `Cancel` in any dialog can satisfy or block a `textGone:'Cancel'` wait (from code, not observed) | 451-6,169 bytes scoped. Scoping works with `role=dialog` or `dialog[open]` |
| **Dashboard** (`lib.rs:304`) | Project card name is noisy: `∫ f(x) dx LaTeX thesis 102 files · Nov 5`. Repeated `Project actions` buttons | 3,132 bytes with one project; other project counts not tested |
| **Page identity** (`index.html:2`) | Title is static and the URL has no project | Two open projects are indistinguishable in a tab list |

**Correction to an initial reading:** the dashboard's `A fresh page` button appears unnamed in MCP snapshots, but it has a real name in the browser (`A fresh page Make room for something new.`). MCP's AI mode omits it, so no app change is needed. The repo's axe spec (`tests/browser/accessibility.spec.js`, not rerun here) checks names and structure, and would not catch the agent problems above, such as missing blank lines or unbounded output.

### Can snapshots be scoped to a region?

**Yes.** `browser_snapshot` takes `target` (ref, role or CSS selector) and `depth`. On the compiled thesis:

| Target | Bytes | | Target | Bytes |
|---|---|---|---|---|
| Whole page | 40,935 | | `.editor-status` | 432 |
| `depth: 2` | 955 | | `role=tablist[name="Open files"]` | 209 |
| `depth: 3` | 1,390 | | `role=banner` | 810 |
| `depth: 4` | 8,641 | | `#code-editor` | 5,026 |
| `depth: 5` | 20,134 | | `role=textbox[name="LaTeX source"]` | 2,976 |
| `depth: 6` | 26,019 | | `role=region[name="PDF preview"]` | 9,109 |
| `role=tree[name="Project files"]` | 10,108 | | same, `depth: 2` | 980 |
| `role=region[name="LaTeX workspace"]` | 20,255 | | `.workspace-toolbar` | 4,350 |

In the failed thesis: whole page 63,097, `.diagnostics` 18,433, raw log 17,812, `list "Compilation issues"` 550.

Scoping works, with two gaps. The most-read regions (status, log, editor) have no role, so agents need CSS classes that the app does not treat as a contract. And `browser_find` looks like a bounded read but returns the whole matching node. No snapshot route can read part of a node, so a bounded read of the log needs page JS.

## 4. App changes needed for Option 1 as a default

Do not treat these as implemented: nothing in the product was changed. Sizes: S is a small local change, M touches several places or needs design. Line numbers are at 102d6dc; `lib.rs` is `crates/app/src/lib.rs` and `main.js` is `web/main.js`.

| # | Change | Where | Size | Fixes |
|---|---|---|---|---|
| 1 | **Make every source line and number addressable.** Add a line decoration carrying a per-line label or `data-line`, so blank lines survive and numbers pair with text. `title`-bearing generics do appear in snapshots (`generic "Changes synchronize…"`), which suggests this works; **prototype it first** | `main.js:241-252` | M | Thesis S5 failures |
| 2 | **Separate state from label on the compile control.** Stable names, `<kbd aria-hidden>`, `aria-busy`, and `data-state=idle\|running`. Decide whether Cancel should be a separate button, to stop double-clicks cancelling | `lib.rs:248`, `main.js:521` | S | Name collision, accidental cancel, text-based waits |
| 3 | **Real status element.** `role="status"` on the text, and a separately named button such as `Show compilation log` | `lib.rs:283` | S | CSS dependency, status name churn |
| 4 | **Always state outcome, pages and warnings.** For example `Compiled · 12.3 s · 1 page · 0 warnings`, `Failed · 1 error · 0 pages` | `main.js:390,396-398` | S | Absence as the only signal |
| 5 | **Show file and line on each issue, with a link to the source.** Set the file for source errors, not only the line | `lib.rs:282`, `diagnostics.rs:280` (and the `file` at `:245`, `:412`) | S UI, M file attribution | S5 and S8 log reads (12.8-19.3 KB) |
| 6 | **Keep the raw log out of the accessibility tree by default.** Closed `<details>`, a labelled region, and close it on success | `lib.rs:282`, `main.js:390,398` | S | Unbounded log, 31 KB S7 |
| 7 | **Paginate search results** (for example 50 at a time) and stop duplicating previews in name and text | `lib.rs:405-406` | M | 620 KB snapshot |
| 8 | **Project name in `document.title`**; project ID in the URL for addressable tabs | `index.html:2`, `main.js:121` `refreshDoc`, `main.js:183` `openProject`; URL part touches routing | S title, M URL | Tab identification (9 trips with 2 projects open) |
| 9 | **Visible cursor position**, `Ln 6, Col 1`, in the status bar (not live-announced) | `main.js:241` update listener, `lib.rs:283` | S | Confirming navigation and edits |
| 10 | **Unique row-action names**: `Actions for chapters/page-050.tex` | `lib.rs:226`; project cards `lib.rs:304` | S | 101 identical names |
| 11 | **Agent contract test with size budgets**: the shared scenario through MCP snapshots, asserting bytes per region and names. Update tests that use the current compile name | `tests/browser/` (new spec, plus existing `/^Compile(?: \|$)/` users) | M | Prevents silent regression, and the UI maintenance cost below |
| 12 | **Reduce large-project tree and select output**: collapse big folders by default; review the `Main document` select | `lib.rs:211-226,243` | M | Full snapshot growth; mostly helps route A |
| 13 | Clean PDF page names (strip isolates) and give pages an addressable name | `web/pdf.js:13` and the pdf.js l10n setup | S | Page scoping |
| 14 | Publish an **agent recipe**: never full snapshot, never `browser_type` on the editor, the selectors, how to wait, pinned MCP version, and flags | Later docs work (not `docs/` in this task) | S | Most token cost and the data-loss hazard, with no code |

Items 1-6 are the minimum. Item 14 is the cheapest and delivers the largest token saving. I did not measure the effect of these changes, so any reduction beyond the measured route differences would be an estimate.

**What the app cannot fix:** CodeMirror's search panel behaviour needs a custom panel or a different edit path; `browser_type` calling `fill` is tool behaviour; and tab attachment is browser policy.

## 5. Attaching to an existing user tab

| Route | Tested? | Result |
|---|---|---|
| Playwright `connectOverCDP`, browser launched with `--remote-debugging-port` and separate profile | **Tested** (Chromium 156 headless) | Works. Sees all tabs and live editor state. `close()` leaves tabs open |
| MCP `--cdp-endpoint`, same browser | **Tested** | Works, including compile in the existing tab with the user's edit intact (`USER_MARK_TWO` kept, 11.9 s). `browser_close` said "No open tabs" but all 4 tabs stayed open and state survived |
| **Normal browser, no debug flag** | **Tested** | **Cannot attach.** Port refused, no `DevToolsActivePort`. MCP returns `connect ECONNREFUSED` (167 bytes, 35 ms) |
| MCP `--extension` with Playwright Extension 0.5.0 (Web Store CRX, unpacked) | **Tested, partly simulated** | Works, with no debug port used by MCP. The human approval click and opening the connect page were driven by my harness |
| Flag on the default profile directory | **Tested on Chromium only** | Port opened on Nix Chromium 156 with a throwaway HOME. **Not tested on Google Chrome**, where Google says the switch is ignored since 136, and one project reports the same on 151 |
| `chrome://inspect/#remote-debugging` with auto-connect | **Not tested** | Documented for `chrome-devtools-mcp --autoConnect` on Chrome 144+, with per-session approval. Whether Playwright MCP can use it is unverified |
| Real headed Chrome or Edge, user-installed extension, debugger infobar, `hasFocus` in a real window | **Not tested** | No display on this host. In headless, every tab reports `visible` and `hasFocus: true`, so **"the tab the user is looking at" could not be determined** |

**Correct-tab findings (CDP):**
- `(current)` is not the user's tab. In two runs it was a Scribyra tab once and the unrelated `Banking` tab once, and the list order differs from creation order.
- Two Scribyra tabs had the same title and URL. Identifying one took 9 tool calls with 4 tabs open.
- **On the wrong tab, waits can falsely succeed.** `browser_wait_for {textGone:'Cancel'}` returned `Waited for Cancel` on a tab with no compile running. Selector calls did fail, which is what exposed it.

**Extension behaviour:** the user picks a tab on a connect page, and the client then lists only that tab (`tabs` returned 1), so the correct-tab problem largely disappears. The page warns that approval "exposes the entire browser to the client", including signed-in sessions and other tabs. A token can bypass the approval dialog afterwards. Latency was similar, first connection about 2.3 s after approval. I tested no multi-client case.

## 6. R1 ratings

Ratings are for Option 1 as measured today, with changes 1-6 where stated.

| Criterion | Rating | Evidence |
|---|---|---|
| **Setup** | Medium | MCP installs in seconds with one config entry. Debug-free attach adds a Web Store extension and an approval. Files outside the workspace root are rejected without `--allow-unrestricted-file-access` (tested), and each client needs roots or cwd set for imports |
| **Browser and agent compatibility** | Medium-good on Chromium, limited elsewhere | Chromium: full. Firefox 157 with Playwright 1.64.1: identical snapshot text sizes (editor 2,447 bytes, AI-mode body within 47 bytes), but compile not run there. MCP 0.0.84 could not drive the flake's Firefox or WebKit (revision mismatch: `Browser.setDownloadOptions` protocol error on Firefox). WebKit crashed on launch on this host in both MCP and library. Extension mode is Chrome and Edge only. **Tested only with a scripted MCP client**, no actual agent product |
| **Response size and token use** | Poor by default, good when scoped | Thesis S1-S7: A 90,043 tokens, B 2,915, C 336 (chars/4), plus 5,268 for tools. Worst single snapshot 620 KB |
| **Reliability** | Medium | After scripting around the pitfalls, 219 of 225 step rows passed, and all 6 failures are one defect. But 4 pitfalls occurred in dry runs, each silent or misleading, and a model was not tested |
| **Active-tab access** | Weak | Normal browser refused. CDP needs a debug launch and a separate profile, and cannot identify the active tab. The extension is the only workable route for an ordinary browser, and is only partly verified |
| **Permissions** | Weak, with no in-app boundary | CDP read a password field's value from an unrelated tab (`synthetic-secret`, tab 0). The extension warns of whole-browser exposure, and limits the tab list but not what that warning describes. `browser_run_code_unsafe` runs arbitrary code. **Scribyra cannot restrict any of this.** No stale-revision check, attribution or per-action consent exists on this route. An upside: it uses the same UI actions as a person, so those validations still apply, and a person can watch |
| **Offline behaviour** | Good | After preparing the project for offline use, `context.setOffline(true)`, reload, reopen and compile all worked (`Compiled · 8.18 s · 1 page`), and MCP tools ran normally. Simulated at browser level, without killing the server. `npx @playwright/mcp@latest` needs network unless installed and pinned |
| **Maintenance cost** | Medium-high | **UI side:** names and classes become an unversioned contract, so needs a test (change 11). **Tool side, measured between 0.0.40 and 0.0.84:** clicks went from `ref` to `target`; tools from 21 to 25, list from 12.5 KB to 21 KB; action responses from an inline snapshot (38.6 KB per action on thesis) to a file link (about 300 bytes). **Pin the version.** The old version on default timeouts also failed `wait_for` and `snapshot` at 5 s during the thesis compile |

## 7. Conclusions and open items

**Recommended default form:** route B for reading plus a published recipe, once changes 1-6 land. Then only long log reads would still need route C. Route C is cheapest on responses today, but it is effectively an unversioned API written by each agent against CSS classes, needing an "unsafe" tool. If Option 2 exists, route C's advantage should be compared with it directly, and the app's existing `window.scribyra.lastCompile` already holds most of what S3 and S4 want. I did not use it here because it is closer to Option 2.

**Do not use a full snapshot as a default on any project with more than a few files.**

**Not measured, and worth doing before R3:**
- Any real model driving these routes, including real Claude token counts and cumulative context.
- Attach in headed Chrome or Edge, including real extension approval and infobar behaviour.
- Whether the line-label idea in change 1 survives into snapshots.
- WebKit (crashed here) and a full Firefox compile through MCP.
- Comments and reviews (no such UI exists yet, milestones 5 and 6), which are part of the milestone's goal but cannot be scored.

## Files

All in ``:
- `r1-option1.json`: raw rows. Route is in `option`; cl100k and request bytes are in `note`. `tools_list` rows are session overhead, excluded from step totals.
- `r1-option1-measure.mjs`, `mcplib.mjs`, `mkzips.mjs`, `aggregate.mjs`: measurement.
- `audit.mjs`, `attach.mjs`, `attach2.mjs`, `ext-test.mjs`, `compat.mjs`, `engines*.mjs`, `oldmcp.mjs`: audit and attach experiments.
- `out/aggregate.md`, `out/audit.json`, `out/attach.json`, `out/audit-*.txt`, `out/transcripts/`: per-step tables, and the full text of each tool response per flow.

## Sources

- [Playwright MCP](https://github.com/microsoft/playwright-mcp), including README options, and the [Playwright Extension README](https://github.com/microsoft/playwright/tree/main/packages/extension#readme)
- [Changes to remote debugging switches to improve security](https://developer.chrome.com/blog/remote-debugging-port) (Chrome 136)
- [Connect your AI agent to your personal browser with auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) (Chrome 144+)
- [cua issue #2916](https://github.com/trycua/cua/issues/2916): field report on Chrome 151, one project's test

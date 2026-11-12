# R1 Option 2: in-page JavaScript command API

Measured 2026-11-05 at worktree base `102d6dc`, with a throwaway prototype (`r1-option2.patch`). Browser: headless Chromium 156 attached over CDP. Tools: `@playwright/mcp` 0.0.84, `chrome-devtools-mcp` 1.12.0.

## Verdict

**Not yet as a public, versioned contract. It is worth keeping as a thin internal adapter, and the decision should be revisited once the Option 1 numbers are in.**

- **What it does well.** The full seven-step scenario costs about 1,400 tokens (chars/4, request plus response) through Playwright MCP and does not grow with project size. Results on all 203 rows were correct. It also gives two things UI automation cannot easily give: revision-guarded edits and reads of lines the editor has not rendered.
- **What limits it.**
  - Roughly half of its read-side value is already available today, with no new code, through the undocumented `window.scribyra.action` and `lastCompile`.
  - The weakest step for an agent is not the transport. Diagnostics do not attribute errors to files and do not report LaTeX warnings. That gap affects every option and no API shape fixes it.
  - A public contract adds lasting obligations before R2 has settled comments, reviews, attribution and the companion's role.
- **Recommended order.**
  1. Fix diagnostics in Rust, for every option.
  2. Extract the shared operations the companion already implements into one bounded module.
  3. Expose that module as an unstable, opt-in surface only if Option 1 falls short on S5/S6 or token cost. Option 3 could adapt the same module.

**What would change this.** I did not have Option 1's numbers, so I cannot state the final ratio. Promote Option 2 if Option 1 uses more than about 3x the tokens on this scenario, or cannot do S5 and S6 reliably. The 3x threshold is my judgment, not a measurement. For scale, a single accessibility snapshot of the workspace costs 1,441 tokens on `article`, about the same as this entire scenario, and 10,097 on `thesis`. Whether Option 1 needs whole snapshots is for its engineer to report.

## How much is just exposing the existing boundary

Less than expected. The command contract covers project data only. Compile, diagnostics and navigation live outside it.

| Prototype method | Source | Share of existing contract |
| --- | --- | --- |
| `patchSource` | `text.patch` through `execute`, so Rust validation, `expectedRevision`, `requestId` and one transaction are all reused. The `find`/`replace` form is new. | Full, plus a convenience layer |
| `readSource` | `file.read`, then new line slicing. The contract returns the whole file. | Partial |
| `getStatus` | `project.inspect`, plus UI state and build summary | Partial |
| `compile`, `cancelCompile` | `runCompile({signal})`, the same closure the companion uses | Outside the contract |
| `getDiagnostics` | `state.buildIssues`, paginated | Outside the contract |
| `revealSource` | `activateFile` and an editor dispatch | Outside the contract |

The companion host already solves this mix in `web/companion-host.js` by injecting closures for compile, diagnostics and build result. The real reuse opportunity is extracting those operations so the companion, this API and a WebMCP adapter share them. Note that companion diagnostics return up to 1 MiB of log, which is not bounded enough for this purpose.

`window.scribyra` already exists with `action`, `lastCompile`, `composing` and `ready`. It is unversioned, undocumented and used by tests and measurement scripts. Any API decision has to account for it, since it stays reachable whether or not `v1` is enabled.

## Prototype

`web/agent-api.js` (95 dense lines, 9.2 KB, 3.7 KB gzipped) plus 8 lines in `web/main.js`. It is enabled by `localStorage['scribyra:agent-api']='1'` and exposes `window.scribyra.v1`:

`describe`, `getStatus`, `compile({waitMs})`, `cancelCompile({runId})`, `getDiagnostics({severity,offset,limit,detail})`, `readSource({fileId|path,startLine,endLine | line,context})`, `revealSource({fileId|path,line})`, `patchSource({expectedRevision,requestId,edits})`.

- It uses its own command host per document, with `read` and `write` capabilities only and a distinct `AgentOrigin`, so export stays unavailable and edits join the editor's undo.
- Methods resolve to `{version,projectId,revision,ok,value|error}`. Results are capped: 50 diagnostics per page, 200 lines or 16 KiB per read, 20 edits per patch.
- Two additions came from using it. LLMs are poor at counting UTF-16 offsets, so edits accept unique `find`/`replace`. Diagnostics carry a log-derived `logLine` where Rust gives no line.

Comments and reviews are not built. Contract sketch only:

```
addComment({projectId,expectedRevision,requestId,anchor:{fileId,start,end,before},body}) → {commentId,revision}
listComments({projectId,fileId?,state?,offset,limit})                                   → {total,items,nextOffset}
proposeChange({projectId,expectedRevision,requestId,edits,summary})                     → {reviewId,revision}
```

Proposals must never apply themselves: accepting one stays a user action. Anchors, author identity and review state depend on milestones 5 and 6 and R2.

## Measurements

**Method.** Each run used a fresh browser profile, so S2 is a cold compile and S7 a warm one. Project import happened outside the timed steps. Every step is one `evaluate` call, and each call would be one model turn for a real agent. Wall time excludes model latency. `request_bytes` is tool name plus JSON arguments for MCP, and script text for `page.evaluate`. Three runs each on `missing-package` and `article`, one on `thesis` (run 5). Batched mode combines S1–S5 and S6–S7 into two scripts.

**Totals for S1–S7: median [range].** Excludes tab attachment and tool definitions.

| Transport | Fixture | Response bytes | Request bytes | Tokens est. (req+resp) | cl100k (req+resp) | Calls | Wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Playwright MCP | missing-package | 4,736 | 736 | 1,371 | 2,139 [2,137–2,178] | 7 | 19.9 s [18.8–21.8] |
| Playwright MCP | article | 4,795 | 742 | 1,388 | 2,160 [2,155–2,170] | 7 | 28.0 s [23.1–29.5] |
| Playwright MCP | thesis (n=1) | 4,756 | 773 | 1,387 | 2,200 | 7 | 55.2 s |
| Chrome DevTools MCP | missing-package | 3,002 | 806 | 957 | 1,475 [1,442–1,514] | 7 | 17.1 s [16.9–17.5] |
| Chrome DevTools MCP | article | 3,122 | 812 | 988 | 1,537 [1,523–1,540] | 7 | 22.0 s [20.9–23.4] |
| Chrome DevTools MCP | thesis (n=1) | 3,054 | 843 | 978 | 1,540 | 7 | **127.6 s** |
| `page.evaluate` (library) | missing-package | 2,687 | 487 | 799 | 1,303 [1,293–1,333] | 7 | 17.2 s [14.0–41.9] |
| `page.evaluate` (library) | article | 2,807 | 495 | 831 | 1,359 [1,340–1,388] | 7 | 18.9 s [18.3–19.9] |
| `page.evaluate` (library) | thesis (n=1) | 2,737 | 522 | 821 | 1,400 | 7 | 49.6 s |
| Playwright MCP, batched | missing-package | 3,101 | 803 | 977 | 1,412 [1,387–1,414] | 2 | 18.0 s [17.8–23.4] |
| Playwright MCP, batched | article | 3,162 | 809 | 993 | 1,409 [1,408–1,425] | 2 | 23.3 s [21.0–24.8] |
| Playwright MCP, batched | thesis (n=1) | 3,118 | 839 | 991 | 1,453 | 2 | 49.8 s |
| DevTools MCP, batched | missing-package | 1,492 | 823 | 579 | 842 [839–860] | 2 | 18.2 s [15.5–18.7] |
| DevTools MCP, batched | article | 1,630 | 829 | 616 | 899 [892–913] | 2 | 25.0 s [20.3–27.0] |
| DevTools MCP, batched | thesis (n=1) | 1,557 | 859 | 605 | 884 | 2 | 116.7 s |

Byte ranges are omitted where a value did not vary. The cl100k counts do vary, because IDs are random. Full per-step rows are in `r1-option2.json`. The 41.9 s `page.evaluate` maximum comes from one S2 compile that took 38.8 s against 10.8–13.6 s in its other two runs. Its cause is unknown, and it occurred on the isolated port.

**Per step, Playwright MCP: response bytes / request bytes / median ms.**

| Step | missing-package | article | thesis (n=1) |
| --- | --- | --- | --- |
| S1 status, active file | 590 / 58 / 526 | 582 / 58 / 529 | 583 / 58 / 529 |
| S2 compile and wait | 682 / 56 / 13,220 | 681 / 56 / 19,650 | 683 / 56 / 43,516 |
| S3 read result | 846 / 58 / 515 | 836 / 58 / 525 | 839 / 58 / 517 |
| S4 first 10 diagnostics | 707 / 73 / 515 | 485 / 73 / 519 | 485 / 73 / 516 |
| S5 reveal, read ±5 lines | 687 / 204 / 542 | 980 / 204 / 545 | 904 / 206 / 560 |
| S6 small edit | 543 / 231 / 538 | 549 / 237 / 543 | 578 / 266 / 589 |
| S7 recompile, read status | 681 / 56 / 4,227 | 682 / 56 / 4,978 | 684 / 56 / 8,925 |

**Failures: 0 of 203 recorded rows in each of the two full passes.** Final `lastCompile.success` was true on all 35 runs of each pass. Separately, one dry-run attempt before the first pass failed at S2 with `page.evaluate: Target page, context or browser has been closed`. It did not recur and I did not determine the cause. That data is excluded.

### Stray clients on port 9333

The coordinator reported that the Option 3 engineer's scripts attached to my browser on CDP port 9333 by mistake. They listed tabs, took snapshots and called tools, and they report no navigation or edits.

**The tables above come from a full rerun on port 9533.** The first pass is kept as `r1-option2-first-pass-port9333.json`.

| Data | Port | Affected? |
| --- | --- | --- |
| First-pass matrix (203 rows) | 9333 | **Cannot tell per run.** Rows have no timestamps, so I cannot match them to the stray activity. No effect shows in the results (see below), and these rows are no longer the reported figures. |
| Dry run, including its one failure | 9333 | **Cannot tell.** A stray client could be involved in the `Target page ... closed` failure, but I have no evidence either way. Excluded from all figures. |
| Tool probe | 9333, rerun on 9533 | Tool definitions are identical on both ports. **The DevTools MCP tab list differed**, so I no longer rely on its order (see active-tab access). |
| Lifecycle, follow-ups, tool limits, engine checks | 9444, 9445, or none | Not on the reported port. I did not separately verify that no other client reached them. |

How I checked:
- **First pass alone:** 0 failures, no byte variation above 3 bytes within any group, and no timing outliers (maximum over 1.25x median and over 100 ms).
- **First pass against rerun:** every group's median response size matched within 3 bytes. So token and byte figures were not affected.
- **Timing:** the first pass was mostly faster than the rerun, not slower. The six groups that differed by more than 15% were all slower in the rerun, and all are dominated by compile time. Calls without a compile matched closely. So stray clients do not explain any slowness in the first pass, but differences of this size show that wall times here are noisy.
- **Rerun:** a page-target list taken at the end of each of the 35 runs showed only the app tab. This is a sample at one moment and cannot prove that no other client connected during a run. The rerun has its own timing outliers, including the 38.8 s compile, so it is cleaner in provenance but not quieter.

### Findings from the numbers

- **Size is flat.** A 100-page, 102-file project costs the same as a one-line one (4,756 vs 4,736 bytes). This is the main benefit, and it is a direct result of bounding.
- **Tool wrappers matter as much as the API.** Playwright MCP pretty-prints JSON and echoes the script back under "Ran Playwright code", so S1–S7 responses are 71% larger than the raw values (4,795 vs 2,807 bytes on `article`). A larger script costs twice: as request and again in the response. It also adds about 500 ms per call. DevTools MCP adds about 45 bytes and about 200 ms per call.
- **Chrome DevTools MCP slowed the large compile about 2.5x.** `thesis` compiles took about 94–117 s across five attempts with it attached, on ports 9333, 9445 and 9533, so the stray clients do not explain this. With Playwright MCP, `page.evaluate` or no tool, the same compile took about 39–44 s. `article` showed a much smaller gap. Polling did not cause it, as the compile was just as slow with 5 s polls. **Cause not determined.**
- **chars/4 undercounts here.** cl100k gives about 55–70% more on this UUID-heavy output. cl100k is a stand-in, since I had no Claude tokenizer available, so neither figure is an exact Claude count. Shorter IDs would be the cheapest optimisation.
- **S3 is redundant in practice.** `compile` already returns the result. Dropping S3 saves about 840 bytes per scenario on Playwright MCP.
- **Batching is a real advantage of `evaluate`.** It cuts seven calls to two and about 28–38% of estimated tokens. It also lets the agent run logic in the page between calls.
- **One-time costs, not in the totals.** Tool definitions: Playwright MCP 25 tools, 21,060 bytes (5,265 est.); DevTools MCP 32 tools, 28,918 bytes (7,230 est.). Option 1 pays the same if it uses the same server. `describe()`: about 1.0–1.2 KB, about 300 tokens. Tab discovery: about 96 bytes per call.

### Context measurements

| Measure | Bytes | Tokens est. | cl100k |
| --- | --- | --- | --- |
| Playwright `browser_snapshot`, `article` workspace | 5,810 | 1,441 | 1,640 |
| Playwright `browser_snapshot`, `thesis` workspace | 40,814 | 10,097 | 11,405 |
| DevTools `take_snapshot`, `article` | 4,850 | 1,206 | not captured |
| DevTools `take_snapshot`, `thesis` | 37,068 | 9,164 | 10,761 |
| Unfiltered `scribyra.lastCompile`, `article` | 169,396 | about 42,000 | not captured |
| Existing hooks, no new code: compile, status and issues | 313 request, 740 response | about 263 | not captured |

The Option 1 engineer owns the real comparison. These figures are only for scale. Snapshot size is not a full Option 1 cost, since targeted reads may avoid it.

The no-new-code row needs emphasis. This works today:

```js
async()=>{await scribyra.action('compile');const r=scribyra.lastCompile;return{ok:r.success,jobId:r.jobId,sourceRevision:r.sourceRevision,issues:(r.report?.issues||[]).map(i=>[i.severity,i.summary,i.line]),status:document.querySelector('.editor-status')?.innerText.split('\n')[0]}}
```

So S2–S4 need no new API, only a documented hook. What it cannot do without one: guarded edits, reading unrendered lines, and starting a compile with a distinguishable busy error (`action('compile')` while busy **cancels the running build**).

## Diagnostics gaps affecting every option

These are the most important findings for R2, and they come from `crates/core/src/diagnostics.rs` and live tests.

1. **Errors have no file.** A `source-error` carries `line` but never `file`. An error injected into `chapters/page-002.tex` of `thesis` returned `{"code":"source-error","summary":"Undefined control sequence.","line":1}`. An agent following S5 opens `main.tex:1`, which is the wrong file. S5 is only correct for single-file projects today.
2. **`missing-tex-file` sets `file` to the absent dependency**, `scribyra-does-not-exist.sty`, with no line. The prototype's `logLine` recovers the line but assumes the main file.
3. **LaTeX warnings are not reported.** With `\ref{nope}`, the log contains `LaTeX Warning: Reference`, yet `warnings` was 0 and `total` was 0. The S3 warning count therefore gives false reassurance. The count covers only report issues, not TeX warnings.
4. **Pagination has little to page through.** `total` never exceeded 1 in any scenario. It becomes useful only after item 3 is fixed.

S5 on `article` and `thesis` used a fixed line because there was no error. S5 on `missing-package` reads one line because the file has only one line.

## Lifecycle

All results below were observed on Chromium with the prototype, unless marked otherwise.

| Case | Result |
| --- | --- |
| **Discovery** | Feature-detect `window.scribyra?.v1`, then `describe()` for version, limits and methods. Agents need external documentation to know it exists: `evaluate` gives no discovery. |
| **Versioning** | Namespace per major (`v1`, `v2` side by side), additive changes within it. Unknown error codes must be treated as failures, matching the command contract. |
| **Page reload** | The API returns after module load, and returns `project_closed` on the dashboard. **The project does not reopen by itself and the API has no way to reopen it**, so the agent must click or a `listProjects`/`openProject` pair is needed. The revision epoch changes, so a pre-reload revision gets `revision_conflict`. The replay cache is lost, by design. |
| **Reload during compile** | The compile dies with the page and the tool call rejects with `Execution context was destroyed`. No result is recoverable. |
| **Service worker update** | Not exercised live. From `web/sw-template.js`: `skipWaiting` and `clients.claim` mean a new worker takes control, but the running page keeps its old JavaScript until reload. So a tab's API version only changes at reload, and agents should re-check `describe()` after any `project_closed`. |
| **Multiple projects** | One open project per tab. Passing another `projectId` gives `permission_denied`. Project switch during compile resolves `project_closed` with no late result. |
| **Same project in two tabs** | Each tab has its own revision epoch, so one tab's revision is rejected in the other (`revision_conflict`). Edits sync across and advance the other tab's revision. Builds are per tab, not per project. |
| **Wrong tab** | Caught for writes by the revision epoch. Reads have only the optional `projectId` guard, so agents should compare `projectId` from `getStatus`. On a non-Scribyra tab, a `ReferenceError` costs 34–296 bytes. |
| **Stale revision** | A user edit before the patch gave `revision_conflict` with source unchanged. |
| **Replay** | Retrying an offset-form patch returns the original receipt with no second application. A changed body with the same ID gives `request_id_reused`. **Defect: a retry of the `find` form fails with `revision_conflict`**, since find resolution runs before the replay lookup. Production must check replay first. |
| **Cancellation** | `compile({waitMs:0})` returns a `runId`. A second compile gives `browser_busy`. A wrong `runId` cancels nothing. The right one gives status `cancelled`, and a later compile succeeds. |
| **User control** | Clicking Cancel in the UI during an agent build resolves the agent's call as `cancelled`. Typing during a build gives `status:"ok", stale:true`. |
| **Undo** | Ctrl+Z reverts an agent edit, and Ctrl+Y restores it. Ctrl+Shift+Z did not redo in my test and I did not investigate why. |

**Promise or poll.** Use a promise with a bounded wait that falls back to polling, as the prototype does.

- Promises worked for 75 s through both MCP servers. With the promise, `thesis` costs one 370-byte response, against six calls and 2,477 bytes with 5 s polls.
- Promises have real limits. `evaluate` gives no progress events. The MCP TypeScript SDK's default request timeout is 60 s, so I raised it in my harness. Claude Code documents a 30-minute idle timeout for stdio servers and moves calls to the background after 2 minutes.
- A default `waitMs` of about 90 s would suit all of these. That figure is my judgment.

## What the user sees

- **Compile:** the same status line and PDF as a manual build, and the Compile button becomes Cancel.
- **Edit:** the text changes in the open editor, with a toast reading "A browser tool changed 1 source location in this project. Undo reverts it." (`r1-option2-visible.png`). The toast is dismissible and a later notice replaces it. There is no history.
- **Reveal:** moves the selection and may change the active tab. It interrupts someone who is typing, so it should stay a separate explicit call.
- **Reads:** completely invisible. The test confirmed no toast. The user cannot tell an agent is reading their project.

Production needs a persistent "agent connected/acting" indicator with an activity list and an off switch. That requires a Rust UI change, which the prototype could not make because `web/pkg` is shared read-only.

Not tested: an agent edit during IME composition. The companion has the same exposure.

## Security

**The API is not a security boundary, and neither is its enable flag.** My own harness turns it on by setting `localStorage` and reloading, and any agent with `evaluate` can do the same.

**What it does protect against: mistakes by a cooperating caller.**
- Writing over changes the agent has not seen (`expectedRevision`), and duplicate application (`requestId`).
- Acting on the wrong project or tab (project guard, revision epoch).
- Malformed, oversized or partly applied edits (Rust validation, one transaction).
- Accidental context floods (result caps).
- Export access, within this API only (no `export` capability).

**What it does not protect against: anything running as page script.** Tested:
- `Object.freeze` on the API does not stop `scribyra.v1` being replaced. A forged `getStatus` was returned successfully. An agent could therefore be lied to by other page code.
- IndexedDB (`scribyra-v1`) is directly reachable, bypassing every check.
- A same-origin iframe reaches `parent.scribyra.v1`.
- `evaluate` itself can run anything. MCP permissions apply per tool, so a user cannot allow only `scribyra.v1.*`. Playwright MCP annotates `browser_evaluate` as destructive.

**Same-origin and third-party code.**
- A sandboxed iframe without `allow-same-origin` was blocked (`SecurityError`), so isolating active content that way holds.
- The running workspace loaded no external scripts, and I found no embedded third-party code. Everything is bundled and same-origin, so a compromised npm dependency has full power with or without this API.
- The page sets no CSP meta tag (`csp: null`). I checked the page only, not hosting response headers.
- The presentation site is on a separate private domain, so its scripts cannot reach the app origin.
- From reading `mountEditor`, project images load into `<img>` via blob URLs, which do not execute scripts.
- Browser extensions injecting into the page's main world would have the same access. Not tested.

**A risk this API makes more direct: prompt injection.** Source text, file names and log text from imported projects go straight into the agent's context. This applies to all three options, but a clean JSON channel can read as more trustworthy. Documentation and results should label these fields as untrusted project content.

**Enable by default?** Keep it off by default, behind a visible setting. The reasons are user control, supportability and not committing to a contract, rather than security. Do not describe the setting as protection.

## Tool availability

| Tool | Evaluate available? | Measured | Size and time behaviour |
| --- | --- | --- | --- |
| **Playwright MCP** 0.0.84 | Yes, `browser_evaluate`. Also `browser_run_code_unsafe`. | Yes | Returned complete up to 5 MiB. At 10 MiB and 50 MiB the connection closed (`MCP error -32000`). I did not establish whether my client or the server was the limit. Promise held 75 s. An optional `filename` saves the result to a file. |
| **Chrome DevTools MCP** 1.12.0 | Yes, `evaluate_script`. Requires `pageId`. **Operators can turn it off with `--no-javascript-evaluation`**, which removes this option entirely. | Yes | Same pattern: complete up to 5 MiB, connection closed at 10 MiB. Promise held 75 s. |
| **Claude in Chrome** | Yes, `javascript_tool`, per the installed skill documentation. | **No.** It needs a real Chrome with the signed-in extension, which this headless LXC lacks. | No documented result limit that I could find. Sources conflict on whether output filters apply: a search summary cited Anthropic's safety article for this, but my direct reading of that article found no such statement. **Test whether long IDs or revision tokens get filtered.** |

**Client limits (Claude Code docs, not tested):** warning above 10,000 tokens, 25,000-token default limit (`MAX_MCP_OUTPUT_TOKENS`), text over 50,000 characters saved to a file. Every Option 2 response here is far below these. The `thesis` snapshot is at the warning threshold.

**Privacy note.** `chrome-devtools-mcp` sends usage statistics, and URLs from performance traces to CrUX, unless disabled. I passed `--no-usage-statistics --no-performance-crux`. The defaults are worth documenting in any setup guide, given that Scribyra promises local-first use.

## R1 criteria

| Criterion | Rating | Evidence |
| --- | --- | --- |
| **Setup** | Good, once the browser tool works | No install beyond the agent's browser tool. Enabling is one flag. The hard part is attaching to the user's real browser (see active-tab), which Option 1 shares. Discovery needs documentation. |
| **Browser/agent compatibility** | Good, partly unverified | Chromium through three transports. Firefox 157 passed the scenario through Playwright (`article`). **WebKit not measured:** on both attempts `newPage` closed before the app loaded, and each left a core dump from `WPEWebProcess` (Nix Playwright WebKit build). So the crash is in the browser process in this environment, before any Scribyra or API code ran. I deleted the dumps (5.7 GB each). Claude in Chrome not measured. DevTools MCP can disable evaluation. |
| **Response size and tokens** | Strong | About 1,400 tokens est. (about 2,150 cl100k) on Playwright MCP, about 980 (about 1,500) on DevTools MCP, 580–990 batched. Flat across project size. |
| **Reliability** | Good | 203/203 rows correct on 35 runs in each of two passes, plus one unexplained dry-run failure. Stable contract independent of UI labels. Weak points: reload loses the build, find-form retry defect, DevTools MCP compile slowdown. Correct transport does not make diagnostics correct (see gaps above). |
| **Active-tab access** | Same as Option 1, slightly safer | The API does not help reach a tab. Playwright MCP reports its own "current" tab and DevTools MCP needs a `pageId`, and neither identifies the tab the user is looking at. DevTools MCP's order and default selection differed between two probes: `about:blank` selected first on port 9333, the app first on port 9533. So an agent must select the tab explicitly and confirm it, whatever the cause of the difference. Attaching over CDP was tested. Real-profile routes exist (`--extension` for Playwright MCP, `--autoConnect` on Chrome 144+ for DevTools MCP) but were not tested. The revision epoch does catch wrong-tab writes. |
| **Permissions** | Weak | No permission can be scoped to the API. Consent is for arbitrary page script. A paired companion has real scoped grants and revocation, and this has neither. Claude in Chrome's per-site permission is also whole-site. |
| **Offline behaviour** | Good | With the network emulated offline, after one online compile: reload, reopen, status, compile, patch and recompile all succeeded. The API needs no network itself. Claude in Chrome's documented dependence on `bridge.claudeusercontent.com` is a limit of that tool. |
| **Maintenance cost** | Moderate, and lasting | See below. Low code cost, higher contract cost. |

## Maintenance estimate

**Measured:** 95 dense lines plus 8 wired into `main.js`. Public surface: 8 methods, about 30 result fields, 7 published limits, 2 new error codes (`browser_busy`, `ambiguous_match`) beside the contract's.

**My estimates, not measurements:** 300–450 lines of production code in a readable style, 15–25 unit tests against real WASM, and 8–12 browser scenarios on three engines. Many need a compile, at about 15 s cold. Add a contract document and a compatibility promise. Each UI-affecting change must then also keep this contract working, though it is much less exposed to label and layout changes than Option 1.

**Production needs beyond the prototype:**
- Diagnostics: file attribution, TeX warnings, and a separate bounded `getLog`.
- Replay lookup before `find` resolution, and an idempotent `compile`/job identity.
- `listProjects`, `openProject`, and a readiness signal after load.
- Search and tree reads, multi-file edits, and file creation (`files.add`) if agents need them.
- Shared operation module used by companion, API and WebMCP, with bounded companion diagnostics.
- Settings UI, persistent activity indicator, off switch, and agent attribution (R2).
- Shorter handles in place of repeated UUIDs, and removal of duplicate `activeFile`/`mainFile` IDs.
- Decide the future of the legacy `window.scribyra.action`/`lastCompile`, which tests rely on.
- Defined behaviour during IME composition and open dialogs.
- Live service worker update test, Claude in Chrome test, WebKit run.
- Telemetry and documentation, including untrusted-content labelling.
- Comments and reviews after milestones 5 and 6.

## Limits of this evidence

- Wall times include noise from other work on this shared host, which I did not isolate. The two passes differ by up to about 40% on some compile-heavy groups, so small timing differences between options should not be read as real. Compile times dominate and are not a property of the API. Bytes and token counts are stable.
- `thesis` has one reported run per mode, except that its DevTools MCP slowdown was seen in five attempts.
- Runs used headless CDP attachment and a scripted caller, not a live model. Real agent behaviour, such as retries and mistakes, was not measured, and no agent was asked to discover the API unaided.
- Not measured: Claude in Chrome, WebKit, live service worker update, IME composition, Option 1 itself, real Claude token counts.

## Files

All in ``:

- `r1-option2.json`: raw rows from the port 9533 rerun. Beyond the agreed schema: `transport`, `mode`, `tokens_cl100k`, `request_bytes`, `request_tokens_est`, `request_tokens_cl100k`.
- `r1-option2-first-pass-port9333.json`, `matrix-first-pass-port9333.log`, `r1-option2-probe-port9333.json`: first-pass data, kept for comparison. `matrix.log` has the rerun's target lists. `check-contamination.py` does the comparison.
- `r1-option2.patch`: the prototype.
- `measure-option2.mjs`, `measure-lib.mjs`, `run-matrix.mjs`: scenario measurement.
- `lifecycle-option2.mjs`, `followup-option2.mjs`, `probe-tools.mjs`: checks, with results in `r1-option2-lifecycle.json`, `r1-option2-followup.json`, `r1-option2-probe.json`.
- `summarize.py`: produces the tables above.
- `r1-option2-visible.png`: what the user sees after an agent edit.

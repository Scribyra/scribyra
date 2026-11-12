# R1 Option 3: WebMCP investigation

Date: 2026-11-05. All URLs were accessed on this date. Raw data: `r1-option3.json`.

## Verdict

**Do not ship WebMCP as Scribyra's main agent interface yet. It can be a thin optional adapter over the Option 2 API once the trigger at the end of this report is met.**

WebMCP worked better than the roadmap's "experimental" wording suggests. A real Claude Code agent discovered and ran page-registered tools through both Playwright MCP and Chrome DevTools MCP, finished S1-S7 and left the expected state in the page. All of that ran in a browser launched with `--enable-features=WebMCP`, attached over a debugging port.

Four things block adoption:

- **Availability:** without a flag or an origin-trial token, the API doesn't exist in Chromium. No shipping date is known.
- **Engines:** WebKit opposes it, and Firefox has only an older API shape behind prefs. Scribyra's test matrix covers all three.
- **Reliability:** a navigation during a tool call hung Chrome DevTools MCP until the client restarted. Playwright MCP limits WebMCP calls to 30 s.
- **Little added benefit:** the same MCP servers also offer script evaluation, which reaches an Option 2 API without flags. WebMCP adds discovery and schemas, not a stronger boundary.

### How to read the evidence labels

- **MEASURED:** run here, on this host, today.
- **PRIMARY:** stated by the owner (spec repo, Chrome, vendor docs, standards-position repo, package source).
- **CLAIMED:** a third party or a user report, not confirmed here.
- **NOT FOUND:** searched, with no primary statement either way.

## 1. Spec status

| Fact | Detail | Evidence |
| --- | --- | --- |
| Owner | W3C Web Machine Learning Community Group. Editors are from Microsoft and Google. | PRIMARY: [spec](https://webmachinelearning.github.io/webmcp/) |
| Maturity | Draft Community Group Report, 2 Nov 2026. "Not a W3C Standard nor is it on the W3C Standards Track." | PRIMARY: same |
| Activity | Last push 3 Nov 2026, 139 open issues and PRs | PRIMARY: [repo](https://github.com/webmachinelearning/webmcp) |
| Entry point | `document.modelContext`, `[SecureContext]`, `Exposed=Window` | PRIMARY: spec. MEASURED in Chromium 156 |
| Methods | `registerTool(tool, {exposedTo, signal})`, `getTools({fromOrigins})`, `executeTool(tool, input, {signal})`, plus `ontoolchange`, `ontoolactivated`, `ontoolcancel` | PRIMARY: spec |
| Tool shape | `name`, `title`, `description`, `inputSchema`, `outputSchema`, `execute(input, {signal})`, `annotations` (`readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging`) | PRIMARY: spec |
| Removal of a tool | Through the `AbortSignal` passed at registration. `unregisterTool()` is no longer in the spec. | PRIMARY: spec and history |
| Declarative forms | Removed from the spec "for now" on 8 Oct, but Chrome and Puppeteer docs still describe them | PRIMARY: [#338 commit 14ae813c](https://github.com/webmachinelearning/webmcp/commit/14ae813c), [Chrome docs](https://developer.chrome.com/docs/ai/webmcp), [Puppeteer guide](https://pptr.dev/guides/webmcp) |

**Breaking changes, from spec history (PRIMARY):**

| Date | Change |
| --- | --- |
| 2026-03-05 | `provideContext()` and `clearContext()` removed (#132) |
| 2026-03-26 | `registerTool()` gains an `AbortSignal` (#147) |
| 2026-03-27 | `unregisterTool()` removed from the proposal explainer (#156) |
| 2026-05-19, 05-27 | `ModelContext` scoped to `Document` and the getter moved there (#177, #184) |
| 2026-06-11 | `ModelContextClient` removed (#205) |
| 2026-07-21 | `annotations` moved into a separate object (#225) |
| 2026-08-14, 08-17 | `executeTool()` specified, then changed to accept an object rather than a JSON string (#226, #246) |
| 2026-10-08 | Declarative API removed (#338); `UnknownError` replaced by specific DOMExceptions (#339) |
| 2026-11-02 | `outputSchema` added (#254) |

Most guides and blog posts are out of date because of these changes. The issue listing below still has `requestUserInteraction` open, so human-in-the-loop isn't settled.

**Open issues that matter to Scribyra (PRIMARY: state read from the repo today):**

| Issue | Why it matters |
| --- | --- |
| [#313](https://github.com/webmachinelearning/webmcp/issues/313) privacy and security mitigations | Carries `privacy-needs-resolution`. Editors treat most mitigations as agent-side; a 27 Oct meeting resolution moved general guidance to a group to be chartered. |
| [#288](https://github.com/webmachinelearning/webmcp/issues/288) | An agent that both invokes tools and automates the page can complete the page's own approval step. A confirmation dialog alone isn't a barrier. |
| [#92](https://github.com/webmachinelearning/webmcp/issues/92) who owns validation | MEASURED below: nothing rejected invalid input before `execute`. |
| [#165](https://github.com/webmachinelearning/webmcp/issues/165) elicitation, [#204](https://github.com/webmachinelearning/webmcp/issues/204) | Human-in-the-loop is unresolved. |
| [#227](https://github.com/webmachinelearning/webmcp/issues/227) | Discovery across navigables. |
| [#74](https://github.com/webmachinelearning/webmcp/issues/74) WebExtensions API | No dedicated extension API. Extensions inject into the page or use `chrome.debugger`. |
| [#282](https://github.com/webmachinelearning/webmcp/issues/282) | No structured way to signal a refusal. Revision conflicts would need their own result shape. |
| [#236](https://github.com/webmachinelearning/webmcp/issues/236), [#348](https://github.com/webmachinelearning/webmcp/issues/348), [#158](https://github.com/webmachinelearning/webmcp/issues/158) | The feature's scope, and more API-shape proposals (a `Tool` interface, renaming `execute`). |

## 2. Browser support

| Browser | Status | Evidence |
| --- | --- | --- |
| Chromium 156 (nix `chromium` 156.0.8078.79 and Playwright `chromium-1248` 156.0.8078.4) | Absent by default. Present with `--enable-features=WebMCP`, `--enable-features=WebMCPTesting` or `--enable-experimental-web-platform-features`. Absent on an insecure origin even with the flag. `navigator.modelContext` is absent in all cases. | MEASURED |
| Chrome | DevTrial from 146. Origin trial from 149, approved to 156 and extended to 162. Flag: `chrome://flags/#enable-webmcp-testing`. CDP domain from 151 per Puppeteer. Chrome Status still reads "Proposed". | PRIMARY: [Intent to Experiment](https://groups.google.com/a/chromium.org/g/blink-dev/c/gmYffo5WOE8/m/OJxuQRP3AAAJ), [Intent to Extend, 28 Sep](http://www.mail-archive.com/blink-dev@chromium.org/msg17568.html), [Chrome docs, updated 7 Oct](https://developer.chrome.com/docs/ai/webmcp), [Chrome Status API](https://chromestatus.com/feature/5117755740913664), [Puppeteer guide](https://pptr.dev/guides/webmcp) |
| Chrome ship date | None known. The May intent estimated M157, but the later extension to 162 supersedes that. | PRIMARY for the milestones; the conclusion is mine |
| Origin-trial end date | 30 Mar 2027 | CLAIMED: [tracker](https://webmcp.com/ecosystem-tracker), run by a vendor with a product in its own comparison |
| Edge | Origin trial in Edge 150. "No public way to test WebMCP with Copilot in Edge" (maintainer, 6 Oct). | PRIMARY: [status page](https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md), [webmcp-labs #17](https://github.com/MicrosoftEdge/webmcp-labs/issues/17) |
| Firefox | Position **neutral**, labelled 3 Aug. Prototype meta-bug is open, behind a pref, with no target milestone. | PRIMARY: [standards-positions #1412](https://github.com/mozilla/standards-positions/issues/1412), [bug 2018306](https://bugzilla.mozilla.org/show_bug.cgi?id=2018306) |
| Firefox 157 (Playwright build) | Absent by default. With `dom.modelcontext.enabled` it has `navigator.modelContext` with `registerTool` and `unregisterTool`. Adding `dom.modelcontext.testing.enabled` adds `getTools` and `invokeTool`. **The entry point and call method differ from the spec.** The throwaway adapter registered and ran through `invokeTool`. | MEASURED |
| Safari/WebKit | Position **oppose**, recorded 11 Jun. Objections cover layer, consent, tracking, accessibility and venue. | PRIMARY: [WebKit #670](https://github.com/WebKit/standards-positions/issues/670) |
| WebKit in Playwright | **Couldn't measure.** Playwright WebKit 27.2 launches, then fails on this host: "Could not create EGL display". Playwright's source throws "WebMCP is not supported in WebKit." | Blocked here; PRIMARY: package source |
| Brave | Experimental support in Leo. | PRIMARY: status page |

Chrome Status also still shows Firefox and Safari as "No signal", which their own position repos contradict. Treat the position repos as correct.

## 3. Agent support

The path that matters is a local agent reaching an existing tab. In every case the agent side starts things: the page only registers tools and cannot contact an agent.

| Agent or tool | Discovers and calls page tools? | Evidence | Label |
| --- | --- | --- | --- |
| **Playwright MCP 0.0.84** | **Yes**, on by default, as `webmcp_<tool>`. Tools appear only after a snapshot, and `browser_tabs` alone doesn't surface them. Sends `tools/list_changed`. | S1-S7 3/3 runs | MEASURED; [docs](https://playwright.dev/docs/getting-started-mcp) |
| **Chrome DevTools MCP 1.12.0** | **Yes**, with `--categoryExperimentalWebmcp`, via `list_webmcp_tools` and `execute_webmcp_tool`. The list is also embedded in `list_pages`. | S1-S7 3/3 runs | MEASURED; [tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md) |
| **Claude Code 2.1.300**, headless | **Yes, through either server above**, with no bridge. Prompted to use the tools; final page state checked. | One run per server | MEASURED |
| Claude Code, interactive | Not tested. Playwright's tools arrive dynamically, and [#66084](https://github.com/anthropics/claude-code/issues/66084) reports stale deferred-tool lists after `tools/list_changed`. DevTools MCP's two tools are static, so it should avoid this. | | Risk |
| **Claude in Chrome** | **No native discovery reported.** The open request says the extension surfaces nothing and tools are reachable only through page scripting. No Anthropic reply; docs don't mention WebMCP. | [#76809](https://github.com/anthropics/claude-code/issues/76809), [#30645](https://github.com/anthropics/claude-code/issues/30645) (auto-closed as stale), [docs](https://code.claude.com/docs/en/chrome) | CLAIMED; not tested (no extension on this host) |
| Claude built-in browser or Cowork | Tracker says "works if asked". | [tracker](https://webmcp.com/ecosystem-tracker) | CLAIMED |
| **Codex / ChatGPT desktop built-in browser** | **Yes, documented.** "Site tools" with a per-call safety review, and an off switch in settings. | [OpenAI docs](https://learn.chatgpt.com/docs/webmcp) | PRIMARY; not tested |
| **Codex Chrome connector** | **No**, per an open request on Chrome 156. Built-in browser works in the same report. | [#57853](https://github.com/openai/codex/issues/57853) | CLAIMED |
| Codex CLI, Cursor, others through Playwright or DevTools MCP | Expected, since page tools are ordinary MCP tools on those servers. Playwright MCP's README lists these clients. | [Playwright MCP README](https://github.com/microsoft/playwright-mcp/blob/main/README.md) | Inferred; not tested |
| **Cursor built-in browser** | No official statement. | [Cursor docs](https://cursor.com/docs/agent/tools/browser) | NOT FOUND |
| Copilot in Edge | No public path. | webmcp-labs #17 | PRIMARY |
| Gemini in Chrome | "Coming soon, early 2027". Chrome docs separate their extension from it. | tracker | CLAIMED |
| Puppeteer | `page.webmcp`, experimental, Chrome 151+. | [guide](https://pptr.dev/guides/webmcp) | PRIMARY; not tested |

**Is a bridge needed?** Not on the debugging-port path (MEASURED). Bridges such as [MCP-B](https://docs.mcp-b.ai/explanation/native-vs-polyfill-vs-global) or the [AgentCat bridge](https://agentcat.com/guides/connect-webmcp-tools-claude-code-bridge-extension/) (an unpacked extension plus a local Node server) are another route, for an ordinary browser profile or where the polyfill is used. Neither was tested. A polyfill alone reaches no external agent without a compatible extension or relay.

**Attaching to the user's real tab was not tested.** My runs used a browser launched by the harness with a debugging port. Two routes remain unverified:

- DevTools MCP `--autoConnect`: Chrome 144+, enabled via `chrome://inspect/#remote-debugging` (PRIMARY: package option text).
- Playwright MCP `--extension`: needs the Playwright extension, Chrome or Edge only (PRIMARY: README).

On either route, the running Chrome also needs WebMCP enabled by flag or a page origin-trial token.

**User consent, in layers:**

1. Attaching: debugging port, `chrome://inspect`, or extension connect flow.
2. The MCP client's own tool permission. My headless runs pre-approved tools with `--allowedTools`, so no prompt appeared.
3. Browser: nothing was required when the tools ran. My runs were headless, so I can't say what a headed browser displays beyond that.
4. Page: the spec requires no prompt. Any confirmation is Scribyra's to build, subject to #288.

## 4. Security and requirements

| Topic | Finding | Label |
| --- | --- | --- |
| Secure context | Required. `http://scribyra.test` had no API with the flag on; loopback did. | MEASURED |
| Private domain | HTTPS on a private hostname exposed the API and 5 tools. Uses a self-signed cert with certificate errors ignored, so this tests hostname and scheme, not a real CA chain. | MEASURED |
| Offline PWA | **Works.** See the offline section under ratings. | MEASURED |
| Origin-trial token on a private domain | Not tested: requires registering a token. Scribyra's presentation and app domains are separate origins, so expect separate tokens if both need it. It's also unverified whether a token works with no network, or how it behaves in a cached shell after expiry. | Open |
| Cross-origin iframes | `tools` Permissions Policy defaults to `self`. Needs `allow="tools"` plus `exposedTo`, and the caller uses `fromOrigins`. `Permissions-Policy: tools=()` turns it off. | PRIMARY: spec §6.3.4 and §6.4 |
| Prompt injection | Spec: preventing manipulation is "primarily the responsibility of the agent's own security model". Hints are advisory, and sites can misstate them. | PRIMARY: spec §6.2 |
| Agent handling | Playwright MCP labels page tools untrusted in the description and output (MEASURED). OpenAI: a tool's claim to be read-only "isn't proof" (PRIMARY). | |
| Caller identity | The page's `execute` receives input and an abort signal, with no agent identity. Revision checks and any authorization remain Scribyra's job. | PRIMARY: IDL |
| Input validation | **None before `execute`.** Wrong types and unknown properties reached the handler through both servers. A third-party probe of Codex reports the same. | MEASURED; [CLAIMED for Codex](https://docs.mcp-b.ai/reference/webmcp/codex-site-tools) |
| Output size | **No limit seen.** A 2,000,061-character result reached the client through DevTools MCP. | MEASURED |
| Service workers | Tools are tied to the document and don't persist across navigations. WebKit objects to background service-worker tools. | PRIMARY: [questionnaire](https://github.com/webmachinelearning/webmcp/blob/main/security-privacy-questionnaire.md), WebKit #670 |

For Scribyra, LaTeX source, logs and diagnostics are all attacker-influenceable if a project is imported from elsewhere. Those tools need `untrustedContentHint`.

WebMCP also widens the existing boundary. `web/commands.js` says "There is no window/message/network listener", and `docs/commands.md` requires later hosts to authenticate and scope callers. A registered tool is callable by whichever agent has access to the tab, so registration has to be a user decision.

## Empirical results

**Setup (MEASURED):**

- `nix develop` gives Chromium 156.0.8078.79 and Playwright 1.64.1. MCP servers installed in the scratchpad only.
- Served the 4 Nov `dist` from the main checkout, read-only, so this build may not match HEAD. Adapter inlined into `index.html` at serve time, so `dist` is untouched.
- Each MCP client attached over CDP to a tab already holding the imported fixture.
- Adapter: 55 lines, 5 tools. It's at `opt3/webmcp-adapter.js`.

**Scenario, `fixtures/missing-package`, 3 runs per server, 42/42 steps passed.** Bytes are tool-result text and were identical across runs. Time is the median.

| Step | DevTools MCP bytes (~tokens) | ms | Playwright MCP bytes (~tokens) | ms |
| --- | --- | --- | --- | --- |
| S1 status and active file | 191 (48) | 5 | 260 (65) | 528 |
| S2 compile and wait | 360 (90) | 4,888 | 706 (177) | 5,813 |
| S3 status | 360 (90) | 3 | 469 (118) | 526 |
| S4 first 10 diagnostics | 507 (127) | 3 | 569 (143) | 525 |
| S5 read around line | 260 (65) | 4 | 323 (81) | 525 |
| S6 small edit | 106 (27) | 21 | 181 (46) | 538 |
| S7 recompile and status (2 calls) | 660 (165) | 3,070 | 1,117 (280) | 4,677 |
| **Total: 8 calls** | **2,444 (612)** | 7,994 | **3,625 (910)** | 13,132 |

Playwright's roughly 525 ms per call is consistent with its documented 500 ms `--timeout-settle`. The first compile in a fresh profile took 9-10 s.

**Discovery overhead, chars/4:**

| Item | Bytes | ~Tokens |
| --- | --- | --- |
| Adapter schemas alone (5 tools) | 1,599 | 400 |
| Playwright MCP `tools/list`, base (25 tools) | 21,104 | 5,276 |
| Playwright MCP with page tools (30 tools; delta 3,053) | 24,157 | 6,040 |
| Playwright snapshot needed to surface them | 5,910 | 1,478 |
| DevTools MCP `tools/list`, base (32 tools) | 29,705 | 7,427 |
| DevTools MCP with flag (34 tools; delta 1,100) | 30,805 | 7,702 |
| `list_webmcp_tools` | 1,921 | 481 |

`tools/list` figures are wire bytes including the JSON-RPC envelope.

**Real agent (Claude Code 2.1.300, Haiku, headless, one run per server, not a statistical comparison):**

| | DevTools MCP | Playwright MCP |
| --- | --- | --- |
| Outcome | Success; final page state correct | Success; final page state correct |
| Tool results (including discovery) | 11, 4,593 bytes | 13, 9,858 bytes |
| Input context on last API call (includes Claude Code's own prompt) | 24,769 tokens | 27,636 tokens |
| Output tokens / turns | 2,142 / 12 | 1,971 / 14 |
| Duration / cost | 32.5 s / $0.0061 | 42.5 s / $0.0064 |

Claude Code defers MCP schemas behind ToolSearch, so the table above overstates what it pays up front. The prompt told the agent to use page tools and how to surface them, so **unprompted discovery was not tested.**

**Limits on these numbers:**

- Compact results come from how the adapter is written. WebMCP doesn't produce them; an Option 2 API with the same bounds should return similar payloads, minus server wrappers. Compare with Option 2's measurements rather than crediting WebMCP.
- S5's "go to" was only a read. The missing-package diagnostic has no line number, so I read line 1. The fixture is a single line, so the ±5 window returned one line.
- The adapter uses the DOM, `window.scribyra` and CodeMirror's private `cmTile`, and has no revision check. It tests the transport, not a design to ship.

### Reliability (MEASURED)

| Test | DevTools MCP | Playwright MCP |
| --- | --- | --- |
| Reload during a pending call | **Never returned (40 s client timeout). Every later call on that client also timed out.** A new client worked. | Clean error in about 1 s: "Execution context was destroyed" |
| Tool sleeping 70 s | Returned at 70 s | **Fails at 30 s:** "Timeout 30000ms exceeded". Whether page work continues afterward was not checked. |
| MCP cancel of a pending call | **Page's `AbortSignal` didn't fire; `list_pages` waited 14 s** until the sleep ended. Matches [#3405](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/3405) and [#2934](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2934). | Not tested |
| Tool throws | Message and stack returned, `status: Error`, but `isError` false | Message lost: `UnknownError`. `isError` true. |
| Two concurrent compiles | Serialized: both completed (9.7 s and 10.5 s) | Not tested |
| Tools after reload | Same client was hung by the reload test; a new client saw them | Stale list until the next snapshot; calls still worked |
| Very new tool | "not found" once when called right after registration; fine after a short wait | Not tested |
| Output format | `output` was sometimes an object, sometimes a JSON string (same tool, cause unknown) | Consistent |

Chromium 156 still returned `UnknownError`, though the spec moved away from it on 8 Oct. That is implementation lag on a moving target.

Design consequences for any adapter: make `compile` start-and-poll rather than wait (cold compiles can exceed Playwright's 30 s), return refusals as data rather than throwing, validate input in Scribyra, and bound every output.

### What a real adapter would cost

A table-driven adapter over Option 2 could be small: about 60-100 lines plus JSON schemas (my estimate, based on the 55-line throwaway). Each tool would be a schema and a call to the shared API.

- **Maps directly:** `project.inspect`, `file.read`, `text.patch` with `expectedRevision` from `docs/commands.md`.
- **Missing:** command contract v1 has no `compile` or `getDiagnostics`. They live in `web/main.js` and the companion host, so Option 2 has to provide them first.
- **Adapter-only work:** registration lifecycle and opt-in, feature detection for `document` versus `navigator`, the origin-trial token, annotations, and shape changes as the spec moves.

I didn't build on the Option 2 prototype, as instructed.

## R1 ratings

| Criterion | Rating | Evidence |
| --- | --- | --- |
| **Setup** | Poor for users today, fair for developers | Needs a Chromium flag or origin-trial token, a debugging or extension attach, and an MCP config. App adapter itself is small. |
| **Browser compatibility** | Poor | Chromium only without prefs. Firefox has a different shape behind prefs, WebKit opposes. |
| **Agent compatibility** | Fair and improving | MEASURED: Claude Code through two servers. PRIMARY: ChatGPT/Codex built-in browser. No native route reported for Claude in Chrome, the Codex Chrome connector or Copilot in Edge. |
| **Response size, tokens** | Good, but mostly from adapter design | 612-910 tokens for S1-S7. Discovery adds 275-764 tokens of schemas over a 5,000-7,500 token server baseline, before deferral. |
| **Reliability** | Fair to poor | 42/42 on the happy path. DevTools MCP hang on navigation, Playwright's 30 s cap, cancellation not forwarded, API still changing. |
| **Active-tab access** | Fair | Reaches existing tabs, but "current" is the server's selection. After another tab was brought to front, Playwright still showed tab 0 and DevTools still showed page 1 as selected. Tools must confirm project identity. Headless caveat: both tabs reported `visible`. |
| **Permissions** | Weak unless Scribyra adds them | No spec prompt, no caller identity, no input validation; hints are advisory. Debug attach already grants arbitrary script, so WebMCP doesn't sandbox the agent. |
| **Offline** | Good | Stopped the only origin server (connection refused). Service worker reloaded the page; 5 tools re-registered; status, compile, diagnostics, edit and recompile all worked through Playwright MCP. Assets had been cached by an earlier compile. Token behavior not tested. |
| **Maintenance** | Moderate to high until shipped | Small code, but nine dated API-shape changes in 2026, origin-trial renewal, three engine states, and a second test matrix. |

## Not verified

- A real Chrome profile with `--autoConnect` or the Playwright extension, and whatever consent UI they show.
- An origin-trial token on Scribyra's domains, online or offline.
- Claude in Chrome, Codex, Cursor, MCP-B and bridge extensions; interactive Claude Code; unprompted discovery.
- WebKit on this host; Firefox through an MCP server rather than Playwright's library; a project larger than the fixture.
- Whether a 30 s Playwright limit is reachable by real compiles here. It is measured for a sleeping tool; the fixture compiled in 3-10 s.

## Process notes

- **Attached to another session's browser by mistake.** One `e2e.mjs` run and one debug script used CDP port 9333, which another session's Chromium already held (tab on `127.0.0.1:5182`). My own browser failed to bind without an error. Those clients listed tabs, took snapshots, and called tools that returned "not found"; they didn't navigate or edit. Discarded the results and deleted the logs. Later scripts use port 9183 and check that the CDP target is on port 5183 before attaching. The owner of that session may want to know.
- **Ports:** app servers stayed on 5183 as asked. Attaching required one extra debugging port, 9183.
- **Claude Code runs:** two headless Haiku runs on the owner's account, about $0.012 total, limited to the browser MCP server tools.
- **Worktree:** the first Playwright MCP run wrote `.playwright-mcp/` to the worktree, and I removed it. No commits, no `docs/` edits, no issues.

## Trigger to adopt

Ship the WebMCP adapter when **all** of these are observable:

1. **Browser:** Chrome Status shows WebMCP enabled by default in stable Chromium (Intent to Ship approved), so users need no flag. `document.modelContext` has had no breaking change across two consecutive stable milestones.
2. **Agent:** an agent the owner has selected reaches the user's existing tab in a normal Chrome profile and lists page tools without script evaluation. That means Claude in Chrome ships native discovery (#76809 resolved), or DevTools MCP's WebMCP category is no longer experimental with #2934 and #3405 fixed. Verified by repeating S1-S7 interactively and unprompted.
3. **Scribyra:** Option 2 has shipped with `compile` and diagnostics in the shared command layer, with start-and-poll compile. The adapter stays a thin mapping and adds no write path of its own.
4. **Safety:** registration is off by default, enabled by the user per tab or project, with visible activity and instant revocation. Reload, cancel and over-30 s tests pass. Stale-revision rejection, input validation and output bounds are tested through the adapter.
5. **Fallback:** Firefox and WebKit runs confirm that nothing registers or breaks when the API is absent, and Option 1 or 2 still completes the scenario.

**Cheaper earlier step:** if the owner wants earlier testing, a developer-only opt-in behind the `?webmcp` query or a settings switch is reasonable once condition 3 holds. An origin-trial token isn't justified yet, since it would expose tools to more agents before condition 4 exists.

**Re-check by:** the end of the Chrome 162 origin trial, the outcome of the W3C Agentic Web group charter, and any movement on #76809.

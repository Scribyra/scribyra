# R1 alternatives: other ways for a local agent to work with Scribyra

Date: 2026-11-05. All web sources were accessed on this date.

Evidence labels:
- **[repo]**: read in this repository.
- **[local]**: measured here; see section 2 for conditions.
- **[web]**: published source, linked. Vendor and community sources are named as such.
- **[inference]**: my judgement, not a verified fact.

## 1. Conclusion

The three options all answer "how does the agent reach the tab?" Most of the workflow may not need the tab, and a working route to it already ships.

- **The pinned compiler runs without a browser.** I ran the exact BusyTeX WASM from `dist/core/busytex` under Node with a 20-line shim. It produced a PDF of the same size as the browser build (3,265 bytes), and returned a log for a failing document.
- **The companion is already a working MCP-to-tab bridge.** It has revision checks, cancellation and a three-engine test matrix, and its compile result is small. The R1 table does not include it.
- **The real blocker is authority, not transport.** The project lives in IndexedDB/Yjs, so "the agent edits local files" has no path into the app today. None of the three options, nor any bridge, fixes that.

Top alternatives (detail in section 6):
1. **Folder-as-truth plus a headless `scribyra check` CLI** using the same pinned WASM.
2. **The existing companion as the structured path to the live tab**, extended rather than replaced.

Option 1 stays in both designs, as the fallback for seeing what the human sees.

## 2. Local measurements

**Conditions:** one run each, on a synthetic one-page document, in this LXC.
- Scripts: `exp/measure.mjs` and `exp/node-tex.mjs`.
- Browser run: headless Chromium 156, debug companion build, Node 22.
- Node compile run: Node 24.
- The app was served from a loopback origin, so **no LNA prompt was exercised**.
- These are bytes, not agent token counts. At roughly 4 characters per token [inference], 1 KB is about 250 tokens.

### Companion MCP through the real browser runtime

| Item | Serialized MCP result, bytes |
| --- | --- |
| `tools/list` (8 tools) | 4,269 |
| `inspect_project` (1 file) | 1,114 |
| `patch_text` | 1,164 |
| `compile_project`, success | 986 |
| `compile_project`, source error | 1,750 |
| `diagnostics` resource after the error | 12,797 |
| ARIA snapshot of `body`, editor open | 1,969 |
| ARIA snapshot of `body`, after the failed compile | 13,881 |
| PNG screenshot, 1440x1000 | 82,336 |

- Tool results carry the payload twice, as text and as `structuredContent` (`crates/companion/src/mcp.rs:280-281`) [repo]. Whether the model sees both depends on the client.
- Compile time was 8.9 s cold (fresh profile), 2.9 s warm, and 0.9 s for the failing document.
- The structured error was already useful: code, severity, line, summary and action.
- The diagnostics resource includes the log, capped at 1 MiB (`web/companion-host.js:29`) [repo]. That is a gap in the roadmap's bounded-results goal.
- I did not investigate why the ARIA snapshot grew sevenfold. The Option 1 owner should.

### Same BusyTeX files under Node, no browser

| Document | Init | Compile | Exit | Result |
| --- | --- | --- | --- | --- |
| `Hello MCP.` article | 1.2 s | 3.8 s | 0 | PDF 3,265 bytes (browser build: 3,265) |
| Undefined control sequence | 1.0 s | 1.9 s | 1 | No PDF; 11.9 KB log |
| `\usepackage{tikz}` | 1.1 s | 1.7 s | 1 | Structured `missing` list includes `tikz.sty` |

- Equal PDF size is suggestive, not proof. Byte identity was not compared.
- Package resolution was **not** ported. `web/compiler.js` runs the 65-pass resolve loop against browser workers and storage [repo]. This is the main remaining work.
- I did not run the Rust diagnostics (`crates/core/src/diagnostics.rs`) on these logs, so the structured report is not yet reproduced headlessly.

### Other observations
- The current `dist/` is built with base `/app/`. `companion --app dist` against it never reached a working app, and the Import ZIP step timed out. I served it under `/app/` instead. It needs a non-Pages build [local].
- `targetAddressSpace` appears nowhere in `web/`, `crates/` or `tests/` [repo]. The test helper's default origin is `http://127.0.0.1:4173` [repo]. So the hosted-HTTPS-to-loopback path is probably untested in the suite [inference].

## 3. Which steps need the tab?

| Step | Inherent need for a live tab? |
| --- | --- |
| Edit local files | No. Agents already do this. The missing piece is reconciliation into the app. |
| Compile | No. It is a function of sources and locked environment. Verified for the baseline set. |
| Diagnostics | No. They derive from the log. The parser is Rust. |
| Inspect PDF output | No. The agent can render or read the PDF itself, which covers most typography and figure checks without a browser [inference]. |
| Comment / review | Not inherently. It is data plus a human accept action. Blocked on milestones 5 and 6 under every option. |
| Keep the human's view current | Yes, but through a data path, not agent control of the UI. |
| See what the human sees | Yes. This is the only step that truly requires reaching the tab. |

## 4. Approaches

### Step coverage

Yes = works now. Partial = works with a stated limit. M5/M6 = needs those milestones first.

| Approach | Edit | Compile | Diagnostics | Comment | Review | See human view |
| --- | --- | --- | --- | --- | --- | --- |
| A. Folder + headless CLI | Yes on disk; tab needs reconciliation | Partial: no package resolution yet | Partial: log now, report to port | Sidecar, after M5 | Patch file, after M6 | No, own PDF only |
| B. Companion bridge | Yes, live model only | Yes | Yes | Add op after M5 | Add op after M6 | Partial: state/PDF, no pixels |
| C. File protocol via tab | Needs M4 | Yes, Chromium only | Yes, Chromium only | Sidecar, after M5 | Patch file, after M6 | Partial: tab writes a state file |
| D. Yjs peer | Yes, live | No | No | Natural, after M5 | Natural, after M6 | Partial: cursors only |
| E. Own extension | Via page | Yes | Yes | After M5 | After M6 | Yes |
| F. Agent in tab | Yes, browser copy only | Yes | Yes | After M5 | After M6 | Yes |

### R1 criteria

| Criterion | A. Folder + CLI | B. Companion | C. File protocol | D. Yjs peer | E. Own extension | F. Agent in tab |
| --- | --- | --- | --- | --- | --- | --- |
| Setup | One CLI plus runtime assets | Run, paste 64-hex code, grants, MCP config; repeat after reload | Pick folder, grant write | Server, room, peer client | Store install, native host | Paste API key |
| Browser coverage | None needed; tab side per M4 | All three on loopback; hosted: prompt in Chrome/Firefox, blocked in Safari | Chromium only | Same LNA limits unless hosted over TLS | One build per browser family | All, subject to CORS |
| Agent coverage | Any agent with a shell | MCP clients with header config | Any agent with file access | Needs a custom tool | MCP via own host | Only the built-in one |
| Response size | Agent chooses; stdout/JSON | Small compile result; fix diagnostics | Small files | Small | As B | Not applicable |
| Reliability | No tab lifetime risk | Tied to tab; revoked on reload | Tied to tab, permission, observer | No cross-client CAS | MV3 worker can idle | Tied to tab |
| Active-tab access | None | Bound to one project, not "active tab" | The tab holding the handle | Awareness only | Yes | Yes |
| Permissions | OS account; WASM limits TeX | Explicit grants, LNA | Directory grant | Server auth needed | Broad host access | Key in page |
| Offline | Yes, once assets exist | Yes, loopback | Yes | Yes if local | Yes if host is local | No, unless local model |
| Maintenance | Node path over a browser-tuned lib | Exists; adds per op | Protocol plus folder adapter | Internal schema becomes public | High | High; reverses a product rule |

"Offline" means Scribyra's side. A cloud model still needs a network [inference].

### A. Folder-as-truth plus headless compile

**Mechanism.** The agent edits the checkout with its own tools and runs `scribyra check`. That runs the same pinned WASM and environment lock, then prints a bounded JSON result with a log and PDF path on disk. The tab is the human's review surface, and catches up through the milestone 4 folder adapter.

**Requires.** The CLI, a JS runtime (emscripten output, so Node or similar), and engine/baseline assets. The whole `dist/core` is 315 MB, and the README says the baseline is about 43.5 MiB plus engine and metadata [repo].

**Offline.** Yes once assets are cached [inference].

**Verified.**
- Node compile, as in section 2 [local].
- `busytex.js` has an `ENVIRONMENT_IS_NODE` branch [repo].
- `scribyra-folders` already has connect/preview/prepare/apply with recovery, as manual snapshots with no watcher [repo: `docs/local-sync.md`].
- Playwright's own README calls CLI invocations more token-efficient because they "avoid loading large tool schemas and verbose accessibility trees" ([playwright-mcp](https://github.com/microsoft/playwright-mcp)). The often-repeated 114k vs 27k figure has only secondary sourcing, so I would not cite it.

**Inference.**
- Using this WASM rather than `latexmk` is the differentiator: same packages as the human's tab, no shell escape. Compare `vvbbnn00/overleaf-mcp`, which runs local `latexmk` and warns users to choose trusted projects ([repo](https://github.com/vvbbnn00/overleaf-mcp)).
- The risk is hidden browser assumptions in BusyTeX's resolver and in Scribyra's patched wrappers.

**Experiment.**
1. Port package resolution and the diagnostics report.
2. Run `fixtures/{article,biber,bibtex,missing-package,romanian,thesis,unicode}` headlessly and in the browser with the same lock.
3. Pass if: PDFs match after normalizing timestamps/IDs (or page count and text match where they cannot), diagnostic codes match, and an offline rerun works with a pre-filled cache.
4. Count agent tokens for one fix-and-recompile loop against B and Option 1.

### B. Existing companion as local bridge

**Mechanism.** Already shipped. An MCP client calls the loopback Rust server, which relays over WebSocket into the tab's shared command host. Pairing is bound to one project and origin [repo: `docs/exchange.md`, `web/companion-connection.js`].

**Requires.** The companion binary.

**Offline.** Yes.

**Verified.**
- Chrome gates loopback behind a `loopback-network` permission covering `fetch`, WebSocket and WebTransport. WebTransport needs `https://`. `ws://` to an IP literal or `localhost` is exempt from mixed-content blocking. `http://localhost` pages avoid LNA checks ([Chrome guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)).
- WebSocket enforcement arrived in Chrome 147 ([Phoronix](https://phoronix.com/news/Chrome-147-Stable-Released), [Citrix](https://support.citrix.com/external/article/CTX696569/chrome-147-and-edge-147-local-network-ac.html)).
- Firefox 153 enables LNA by default ([beta notes](https://www.firefox.com/en-US/firefox/153.0beta/releasenotes/)). WebSocket enforcement is tracked as fixed for 154 ([bug 2042339](https://bugzilla.mozilla.org/show_bug.cgi?id=2042339)). I found no final 154 release note.
- Safari "currently blocks requests to localhost resources" from secure public sites, per a comment on the still-open bug dated 2026-08-19 ([WebKit 171934](https://bugs.webkit.org/show_bug.cgi?id=171934)). This is a bug comment, not an Apple statement.

**Inference.**
- `--app` (a loopback origin) avoids all of this, but storage is per origin, so projects do not follow. That choice matters more than any option in the table.
- Pairing revoked on reload is a safe default, but it makes long agent sessions fragile. Stable client settings across reloads, with re-approval in the tab, would remove most of the friction.
- A stdio shim would reach clients that cannot set HTTP headers.
- The guide says to set `targetAddressSpace` on `http://` fetches, and the code does not. It may still work because `127.0.0.1` is a literal loopback address, but this needs testing, not assuming.

**Experiment.**
1. From the private HTTPS Pages origin, pair in headed Chrome, Firefox and Safari. Record the prompts, denial recovery and failure text.
2. Background the tab for 30 minutes with Memory Saver and Energy Saver on, then call `compile_project`. Sources on current freezing behaviour were weak, so this has to be observed. Pass if it completes or fails clearly, with no hang and no silent loss of grant.

### C. File protocol through the tab

**Mechanism.** The agent writes `.scribyra/requests/*.json`. The tab watches with `FileSystemObserver`, acts, and writes results. Comments live in sidecars or `.tex` magic comments.

**Requires.** No agent tooling beyond file access, but a Chromium tab holding a readwrite handle.

**Offline.** Yes.

**Verified.**
- `showDirectoryPicker` is Chromium-only. Mozilla's position is negative, WebKit is opposed on security grounds, and the feature is "very unlikely to ever become Baseline in this current form" ([web-features](https://web-platform-dx.github.io/web-features-explorer/features/file-system-access)).
- `FileSystemObserver` shipped in Chrome 133 ([web.dev](https://web.dev/blog/web-platform-02-2025), [caniuse](https://caniuse.com/mdn-api_filesystemobserver)), but MDN still marks it experimental and non-standard, with the spec PR pending ([MDN source](https://github.com/mdn/content/blob/main/files/en-us/web/api/filesystemobserver/observe/index.md?plain=1)).
- It can return `unknown` (rescan needed) or `errored` (per-origin limit, root removed, permission removed) ([Chrome blog](https://developer.chrome.com/blog/file-system-observer); this page predates shipping).
- Persistent permission arrived in Chrome 122 via "Allow on every visit". Access is auto-revoked after backgrounding unless the app is installed ([Chrome blog](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)). I could not confirm whether every-visit grants escape that revocation, because the page is ambiguous.
- Eclipse Theia's September 2026 PR is Chromium-only and detects no external changes elsewhere ([PR 18110](https://github.com/eclipse-theia/theia/pull/18110)).
- Scribyra requests only `mode:'read'` and copies into storage (`web/main.js:308-309`) [repo].

**Verdict [inference].**
- Reject it as the *command channel*. It adds a queue, permission recovery and lifetime handling, and fails in two of three supported engines. Any file in the checkout also becomes a request source, so a cloned repo could carry commands.
- Keep the *file formats*. Milestone 5 already calls for portable review exports, so a sidecar review file gives the agent a no-tooling way to propose comments.
- Avoid magic comments in `.tex` except as a stopgap. They pollute source, diffs and exports.
- A unified diff in `.scribyra/proposals/` is an inexpensive format for `proposeChange`, since agents already produce diffs.

**Experiment.**
1. Grant a folder in Chrome with "Allow on every visit".
2. Have an external process write 1,000 files, a parent rename and an atomic-save burst, with the tab foregrounded, then backgrounded for an hour.
3. Record missed events, `unknown` records and re-prompts.
4. Repeat installed as a PWA.

### D. Agent as Yjs collaborator

**Mechanism.** The agent's tool holds a Yjs replica and awareness state, and joins through the sync server. Edits appear live with presence.

**Requires.** The sync server and a peer client.

**Offline.** Yes on loopback.

**Verified.**
- `web/sync.js` hardcodes `ws://127.0.0.1:8787`, and the server has "no accounts or authorization" [repo].
- The pattern exists:
  - Electric's server-side peer uses a deliberately constrained tool set and relative anchors ([post](https://electric.ax/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs)).
  - `jupyter-collab-mcp` joins the shared document and appears in the collaborators panel, but warns that a CRDT "has no cross-client compare-and-swap" and that delivery is not persistence ([repo](https://github.com/lipa88/jupyter-collab-mcp)).
- A practitioner post lists agent-speed starvation, undo ownership and presence noise as things to design for ([DEV](https://dev.to/norfolkd/when-an-ai-agent-joins-your-yjs-room-three-assumptions-break-50h8)).
- Overleaf live-protocol servers show the same benefit: edits arrive as a co-author with no "file changed externally" toast ([Carlos0902](https://github.com/Carlos0902/overleaf-mcp)).

**Inference.**
- This is the best attribution and presence model, and the worst fit today:
  - It cannot compile.
  - It loses the stale-revision rejection the companion has.
  - It turns internal project schema 5 into a public contract.
  - It requires an authenticated relay, which is milestone 10, and interacts with encryption in milestone 11.
- Revisit it with milestone 10. Meanwhile, keep `type:'agent'` in awareness and an agent transaction origin in mind for R2, because those carry over.

**Experiment.** Run a Node peer against the demo server for a 10,000-word streamed insert while a Playwright "human" types. Measure input latency, undo isolation and journal growth.

### E. Own browser extension with native messaging

**Mechanism.** A Scribyra extension reaches a native host and injects commands into the page, sidestepping LNA.

**Verified.**
- Claude in Chrome uses this model: a native messaging host file, plus a WebSocket bridge at `bridge.claudeusercontent.com`. It requires a direct Anthropic plan, is unsupported on WSL, opens new tabs, and its service worker can idle and drop the connection ([docs](https://code.claude.com/docs/en/chrome), [network](https://code.claude.com/docs/en/network-config.md)).
- Playwright's extension connects to existing tabs on Chrome/Edge only ([README](https://github.com/microsoft/playwright-mcp)).

**Verdict [inference].** Do not build one. Existing extensions are Option 1 transports already. Building our own adds store publishing per browser family for what is mainly an LNA workaround. Reconsider only if experiment B shows LNA is unusable.

### F. Agent in the tab

**Mechanism.** The page runs the agent loop against a provider API.

**Verified.**
- The Anthropic API allows browser calls only with an explicit header, and some organizations cannot use it ([docs](https://platform.claude.com/docs/en/manage-claude/authentication)).
- Scribyra states "no built-in language model", and provider output cannot edit the project or trigger follow-up calls [repo: `docs/mcp-providers.md`].
- tldraw's agent kit keeps model keys in a worker ([kit](https://tldraw.dev/starter-kits/agent)).

**Verdict [inference].** Dead end for this goal. It replaces the user's local agent, has no access to local files, and reverses a documented boundary. It could be a separate future feature.

### Dropped briefly

- **DevTools attach:** not a distinct alternative. It is a transport for Options 1 and 2. It needs Chrome 144+, a `chrome://inspect` toggle and a consent dialog on each session, with an automation banner ([Chrome blog](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)).
- **postMessage / embedded host:** `web/commands.js` deliberately has no window, message or network listener [repo]. It needs a host page that no agent provides.
- **MCP Apps:** UI in a host's sandboxed iframe ([spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)). Excalidraw's official server uses it ([repo](https://github.com/excalidraw/excalidraw-mcp)). It does not fit a large compile runtime or per-origin project storage, or terminal agents [inference]. A small build-result card might work later.
- **Chrome built-in agents (Gemini auto browse, Prompt API):** not the user's local agent, and access is gated ([Chrome I/O recap](https://developer.chrome.com/blog/chrome-at-io26)). WebMCP is the relevant part, and it is already covered.
- **Desktop shell (Tauri/Electron):** removes the browser restrictions but contradicts the static, no-install product promise [inference].
- **WebTransport bridge:** adds certificate handling over WebSocket and is still LNA-gated [inference, partly web].

## 5. Precedent

| Tool | How agents reach it | Lesson |
| --- | --- | --- |
| Jupyter | REST/RTC to a server the browser is also a client of ([mcp-jupyter](https://github.com/block/mcp-jupyter)) | Without RTC, sync is a manual reload and save. Execution stays visible to the human. |
| Overleaf (unofficial) | Git bridge, or live OT using session cookies | Git bridge is paid and batched. Live OT is experimental and can break. `create_comment` anchors on a quote that must occur exactly once, which is a good agent-facing API. Agent comments are signed `Co-authored by`. |
| Figma | Hosted server; write-to-canvas is remote-only and beta ([docs](https://developers.figma.com/docs/figma-mcp-server/)) | The desktop server remains for enterprise needs. No deprecation notice found. Community plugin-plus-WebSocket bridges exist ([example](https://github.com/southleft/figma-console-mcp)). |
| Blender, Ableton | In-app socket plus an external MCP server (community listings, e.g. [Blender](https://glama.ai/mcp/servers/e2ur9nqn4n)) | Same shape as the companion. Loopback binding, tokens and single-client contention are the recurring concerns. No independent audits found. |
| Excalidraw, tldraw | Official: MCP Apps. Community: stdio plus WebSocket to a local canvas ([example](https://github.com/yctimlin/mcp_excalidraw)) | Official efforts render new canvases in the host rather than driving an open tab (inference for Excalidraw; its page does not say). tldraw removed `@tldraw/ai` in favour of a starter kit (search result for the [v4 notes](https://tldraw.dev/releases/v4.0.0), not read in full). |
| VS Code for the Web | Browser sandbox; Microsoft recommends desktop, Codespaces or tunnels for real execution ([docs](https://code.visualstudio.com/docs/remote/vscode-web)) | No official statement on MCP in vscode.dev found. Real work moves to a local host. |
| Obsidian | Filesystem vs REST plugin | Practitioners favour direct files when files are the truth. One REST-based server was archived with that argument ([proofsh](https://github.com/proofsh/obsidian-mcp)). This is opinion; no benchmark found. |

**Pattern [inference].** Agents integrate easily when the browser is merely a client of an authority they can reach (Jupyter, Overleaf, Figma's cloud, a folder). When the authority is inside the app, tools need a bridge (Blender, Ableton). Scribyra is currently the second kind, by choice of IndexedDB. Making the folder an authority moves it toward the first kind.

## 6. Recommendation

### Pick 1: Folder-as-truth plus `scribyra check`

- Serves editing, compile, diagnostics and PDF inspection with no browser tool, no MCP schema cost, no LNA, and any agent with a shell.
- Gives real results in all environments, including when no tab is open.
- Depends on milestone 4 reconciliation for the human's tab to follow. That dependency already exists and is required for the stated workflow regardless.
- **With Option 1:** Option 1 handles only "see what the human sees", UI checks and layout review in the app, used by exception. Screenshot use falls naturally, since agents can render the PDF for most layout checks [inference].

### Pick 2: Companion as the structured route to the live tab

- It exists, and it is the only option here with verified structured writes, stale-revision rejection, undo separation and cancellation in all three engines.
- Add: comment and review ops after milestones 5 and 6, bounded diagnostics, surviving reloads, stdio access, and project/selection state.
- Keep it optional, as the product promise requires.
- **With Option 1:** independent. Both call the shared command layer. Option 1 is the no-install path; the companion is the reliable path. Options 2 and 3 become thin adapters over the same commands if they prove worthwhile.

### Existing companion users

Nothing needs to break. Picks 1 and 2 are additive and the tool contract can stay. Retiring the companion is not realistic anyway: the roadmap assigns it portable folder watching (M4), local Git access (M8) and stdio providers [repo]. The gate question is better put as "the companion is not *required* for agent work, but remains supported."

### Suggested order [inference]

1. Run the compile parity experiment. It is cheap and decides Pick 1.
2. Run the hosted LNA and backgrounded-tab experiments. They decide how much to rely on any tab route.
3. Decide authority (next section) before finalizing R1.

## 7. Flaws in the roadmap's framing

1. **It compares transports before settling authority.** The workflow says "editing local project files", but the app's authority is IndexedDB/Yjs, and the companion "never reads a separate disk copy". Local-file edits and browser operations are currently two different projects. R1 comes before the R2 work that determines what is being operated on. Authority should be decided first: folder as truth, tab as truth, or a defined mode for each.
2. **The incumbent is missing from the comparison.** The gate asks about the companion's future, but the three-way table has no row for it. Any option should have to beat its measured baseline.
3. **It treats the tab as necessary for compilation.** The roadmap says "compiling in the open webapp" as a given. Section 2 shows this is not a technical requirement, at least for the baseline set.
4. **"Compact results" is attached to the wrong layer.** Response size mostly follows from command result design, not transport. The compile result is small over MCP, and the diagnostics resource is large over the same MCP. Fixing the shared command results helps every option.
5. **Comments and review are not an integration question.** Milestones 5 and 6 define them, and the roadmap admits this. Listing them as workflow steps invites overrating options that cannot deliver them yet. No option can be evaluated on them until a schema exists, though anchor design should borrow from Overleaf's quote anchors.
6. **"Active tab" may be the wrong target.** The companion binds to a project, which is safer than whichever tab is focused. Same-profile tabs already sync committed revisions [repo], so an agent-opened tab in the same profile should propagate edits to the human's tab, though not necessarily its PDF preview [inference]. That weakens the "correct existing tab" concern for extension-based tools, but not for a Playwright-launched separate profile.
7. **Origin is an unlisted variable.** Hosted HTTPS and loopback-served Scribyra behave very differently for prompts, Safari access and storage. "Browser compatibility" cannot be scored without saying which origin. Scribyra's three-engine promise also conflicts with any Chromium-only folder dependency, so the gate should state which capabilities are allowed to be Chromium-only.
8. **"Offline" needs defining.** Scribyra can be fully offline while a cloud model or an extension bridge is not. Claude in Chrome lists a required network bridge host, for example. Score Scribyra's side and the agent's side separately.

## 8. Evidence gaps

- No real agent token measurements. All figures are bytes.
- No test of the real LNA prompts, backgrounded tabs or `FileSystemObserver` behaviour. Sources on current Chrome freezing rules were secondary and were not relied on.
- Firefox 154 WebSocket enforcement rests on a Bugzilla entry; Safari's behaviour on a bug comment.
- Chrome 147 dating rests on secondary sources (Phoronix, Citrix); the Chrome guide itself gives no versions.
- Many MCP servers cited are young community projects, and their README claims were not tested. Several listings and practitioner posts are unaudited.
- One low-quality claim about Chrome 156 removing an enterprise LNA opt-out could not be confirmed and is excluded.

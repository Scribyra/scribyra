# Reorientation decision record

Decided November 5, 2026 by the owner, for [milestone R](roadmap.md#milestone-r-reorientation). This records the direction and its evidence. It does not complete the milestone: the checks under [open work](#open-work) can still change the outcome.

## Decision

Scribyra keeps an "open it and it works" flow. A local or remote AI uses its own browser tool to work in the open tab, and Scribyra ships no additional program for this.

| Subject | Decision |
| --- | --- |
| Source of truth | The project in browser storage. The agent edits, compiles, comments and reviews through the tab, in all three browser engines. |
| Option 1: accessible UI automation | Included by default, as the no-setup route. |
| Option 2: in-page command API | The structured route, because the companion is no longer planned to provide one. It starts as a shared internal module and is not a public, versioned contract until R4 has passed. |
| Option 3: WebMCP | Not shipped now. It may become a thin adapter over the same commands; see [adoption conditions](reorientation/r1-option3.md#trigger-to-adopt). |
| Rust companion (`scribyra-companion`) | Discontinued November 8, 2026 (the owner's decision). The code stays in the repository for its tests, reachable only behind the test-only `localStorage['scribyra-companion-dev']` switch; the editor no longer offers or contacts it. (Previously frozen pending R4.) |
| `scribyra-folders` | Frozen: it stays in the repository and keeps working, with no new features. Removal needs R4 to pass and a separate explicit approval. |
| `scribyra-sync` | The optional, self-hostable remote service, not a local install. It will also provide the connection service for direct sessions. |
| Live local-folder linking | Not selected for now. It would be Chromium-only without the companion. |
| Headless `scribyra check` CLI | Not selected. It would be another thing to install. |

**Existing companion users:** the editor no longer offers pairing or contacts a local address. Pairings lived only in tab memory and were never stored, so there is nothing to migrate and no project data is affected.

## Consequences

These roadmap dependencies assumed the companion and need replanning under R3. Nothing in them has been rescoped yet.

- **Milestone 4:** portable folder watching, atomic writes, recovery after sleep, and the LAN hub in 4c.
- **Milestone 3 client:** local stdio providers. Direct HTTP providers are unaffected.
- **Milestone 8:** operating on a local repository. Browser-contained repositories and HTTP remotes remain possible, and an agent can still run Git itself in any real folder.
- **Milestone 9:** companion-watched Zotero exports.

Comments and reviews still have to be built under milestones 5 and 6, then exposed as commands.

The [roadmap](roadmap.md#order-of-work) now holds the proposed replanning: 4b is parked, 4c's browser route moves to direct sessions, and milestones 8 and 9 start from their browser routes.

## Main risk

Everything depends on the agent reaching the tab the person is actually using:

- A normal browser refuses CDP.
- `--cdp-endpoint` connects but cannot identify the person's tab.
- The extension route attaches, but only with a simulated approval click so far.
- Claude in Chrome is unmeasured.
- A browser launched by the agent uses a separate profile, so it cannot see the person's projects.

If R4 fails, some local bridge may be needed after all, although not necessarily in Rust.

## Evidence

Seven-step scenario on the 100-page `fixtures/thesis`, request plus response, estimated as characters ÷ 4 with Chromium 156 and scripted clients. No model ran in these routes, which flatters snapshot routes because a script reads large output more reliably than a model.

| Route | Est. tokens | Grows with project | Failed steps |
| --- | --- | --- | --- |
| Option 1, full snapshots | ~91,000 | Yes | 3 of 21 |
| Option 1, scoped snapshots | ~3,400 | Partly | 3 of 21 |
| Option 1, targeted page scripts | ~950 | Barely | 0 of 21 |
| Option 2, Playwright MCP, code echo off | ~1,150 | No | 0 |
| Option 2, DevTools MCP | ~980 | No | 0 |

WebMCP passed 42 of 42 steps on `fixtures/missing-package`, but its 612–910 tokens exclude requests, so it is not comparable with this table.

Findings that shaped the decision:

- **A stable API does not save tokens.** Option 2 sends about a third of the model output of targeted scripts (773 vs 2,453 bytes), but total cost is similar. Its value is revision-checked edits, independence from CSS selectors and reads of lines the editor has not rendered.
- **Tool flags matter.** Option 2 originally measured ~1,390 because Playwright echoed code back. Route C of Option 1 had that turned off. The ~1,150 above comes from a coordinator rerun with matching flags, in [`option2-normalized-rows.json`](reorientation/data/option2-normalized-rows.json).
- **Snapshots give wrong source positions.** Blank CodeMirror lines vanish, so reading around an error failed 6 of 6 times on the thesis across the snapshot routes. `browser_type` replaces the whole file.
- **Diagnostics are weak on every route.** Errors do not name a file, and LaTeX warnings report 0.

Limits of this evidence:

- Each Option 2 thesis setup has one run, and the normalized rerun covers Playwright only.
- cl100k counts run 55–70% higher on Option 2's ID-heavy output, and neither figure is Claude's real count.
- Option 2's reported tables come from a rerun, because another engineer's scripts attached to its first browser by mistake. Sizes matched the first pass within 3 bytes.
- DevTools MCP slows thesis compiles about 2.5× for an unknown reason.
- The WebMCP report says Playwright MCP caps calls at 30 seconds, but a 41.5-second compile succeeded in the rerun. This is unresolved, so compile should be start-and-poll regardless.
- WebKit crashed before the app loaded in the Option 2 check.
- Measurement scripts were not retained, so the raw data below can be inspected but not rerun as is.

Full reports, with sources: [Option 1](reorientation/r1-option1.md), [Option 2](reorientation/r1-option2.md), [Option 3](reorientation/r1-option3.md), [alternatives](reorientation/r1-alternatives.md). The Option 2 report recommends less than this decision does, and the alternatives report argues for keeping the companion; both were written before this decision. Throwaway prototype: [`r1-option2.patch`](reorientation/r1-option2.patch). Raw measurements: [`data/`](reorientation/data/).

## Later investigations

Run after the decision, on the same day. Neither changes it. Neither ran a real model or used real networks, and neither has been confirmed by a real-world test.

**Could an AI plugin help? The instructions help, not a package.** ([Report](reorientation/r1-plugin.md), [draft and experiment](reorientation/plugin-draft/))

- A plugin cannot fix tab attachment, cannot reach a remote agent, and adds little on tool-schema cost because Claude Code already defers those definitions (about 790 tokens against 5,265, estimated).
- Instructions can pay off: a thin skill costs about 50 tokens at start and 620 when activated, while one avoided full snapshot of the thesis saves about 10,100. Whether a model would otherwise take that snapshot is unmeasured.
- So the app serves a recipe at `/agent.md`. A thin skill is packaged only if a real-model experiment justifies it, and no MCP server, hooks, `bin/` or browser extension ship.

**Could people in a café collaborate on their own laptops? Only partly.** ([Report](reorientation/r1-collaboration.md), [field-test page](reorientation/field-test.html))

- WebRTC synced real projects between Chromium and Firefox with no install or server, using a manual exchange. The thesis took about 50 ms on a virtual network, and a rejoin took 62–84 bytes. Five people converged.
- Client isolation defeats every browser-side option tested. No measured figure says how many cafés use it, so only a field test can tell.
- The connection is encrypted, but that is not "end-to-end encrypted collaboration": anyone tampering with the invite can sit in the middle unless people verify a code, and there is no group membership, removal, attribution or encryption at rest.
- So this is an opportunistic transport beneath the same replication and encryption design as milestones 10 and 11, and it would replace 4c's browser route.
- [Real-network tests](reorientation/r1-collaboration.md#addendum-real-network-with-real-firewalls-2026-11-05) later showed that with default firewalls both sides must send within seconds, so a manual exchange is too slow. The owner chose an optional, self-hostable connection service for this.

## Open work

**R4, real-tab test (first).** With real Claude Code and a real Chrome profile, including a human approval, complete compile, read diagnostics and a small edit on a project already open in that person's tab. Record the attachment route, the tokens used and any failures. Run it with no plugin, because none must be needed. Also try a new tab in the real profile, which sidesteps identifying the tab if the tool allows it. Worth noting if reached: DevTools MCP `--slim`, the cheapest route measured, and Claude in Chrome, which remains unmeasured. Passing is required before the command API or the companion's status changes further.

**R5, remote-agent experiment (after R4).** Can an unrelated AI, with no setup, compile LaTeX through Scribyra?

| Agent has | Expected result |
| --- | --- |
| A browser tool | Should work: it opens the app and compiles in the page. |
| Chat only | A link carrying the source in its URL fragment compiles in the person's browser. The fragment is not sent to the server. Suits short documents. |
| Web fetching only | Not possible on a static site. Out of scope. |
| A shell, no browser | Possible but rarely the best choice. Not targeted. |

The experiment adds a `#tex=` entry that opens a new scratch project and never touches existing work, plus a compact status result and the PDF as a download rather than base64. A real remote browser agent then compiles from a deployed test URL, recording download cost, memory limits and whether sandbox networks block it.

The repository stays private, and public launch requires a later explicit instruction. The owner made the Pages site reachable without sign-in on November 6, 2026, so an agent can now reach it for this experiment. Wider discoverability (`llms.txt`, indexing) waits for public launch, and whether agents would choose Scribyra unprompted is unproven.

**R6, café field test (any time).** Two real laptops on real networks, using the [field-test page](reorientation/field-test.html), hosted privately at `/field-test/` on the Pages site, and [these steps](reorientation/r1-collaboration.md#two-laptop-test). It does not block the milestone's gate, and its result decides whether direct sessions are built.

**Order:** the [roadmap](roadmap.md#order-of-work) holds the order, confirmed by the owner on November 5, 2026.

# Scribyra product roadmap

Implementation roadmap, restructured November 5, 2026 from the [Reorientation decision](reorientation.md) and its investigations. The owner confirmed the order and the feature mapping that day. Nothing was dropped: unfinished requirements stay in their milestones, and earlier delivery evidence is in the [delivery record](#delivery-record).

The product is a static browser application, with optional self-hostable remote services. All features remain available in the free self-hosted edition; managed hosting charges for operated resources and service. The [static architecture study](static-architecture-study.md) explains feasibility, browser measurements, Rust choices and unresolved experiments. This roadmap specifies outcomes and release gates rather than calendar promises. Most milestones are substantial product work; existing prototype support is not equivalent to a finished feature.

## Where we stand

| Area | State |
| --- | --- |
| **Delivered** | Workspace (1), TeX component delivery (2), MCP server and client (3), live same-browser tabs (4a), bounded diagnostics and addressable compile/source UI (A1–A2), the served agent recipe/contract (A3), experimental shared agent commands (A5), comments (5), reviews (6), and restorable history (7), whose integrated gates are under review. |
| **Current** | Milestone R stays open on R4 and R5, and T on its hosting decisions. Everything before D that needs no decision from the owner is delivered. The owner started D on November 7: its off-by-default implementation is under review; the real-network acceptance gate stays open. |
| **Works in the tab today** | Edit, compile, read diagnostics, comment, review, restore and back up. A real model completed edit, compile and diagnostic tasks in a [test browser](reorientation/a3-trials.md), but no agent has yet attached to a person's real tab. |
| **Not built** | Git, Zotero, durable remote sync and project encryption. Direct sessions remain experimental pending field acceptance. |
| **Paused** | Telemetry (T), with its remaining work below, and folder synchronization (4b). |
| **Discontinued** | `scribyra-companion`: discontinued November 8, 2026 (the owner's decision). The editor no longer offers or contacts it; the code stays in the repository, reachable only through the test-only `localStorage['scribyra-companion-dev']` switch, so its tests keep running. |
| **Frozen** | `scribyra-folders` keeps working, with no new features. Removal needs R4 to pass and a separate explicit approval. |

### Main uncertainties

1. **Can an agent reach the tab a person is actually using?** Everything in the agent direction depends on this. R4 tests it. If it fails, some local bridge may be needed after all.
2. **Do real shared networks let machines reach each other?** Client isolation blocks every browser-side route, and that is the network's decision to respect. R6 tests real networks.

## Beta gate

Agreed with the owner on November 7, 2026. The beta is a public, free, local-first LaTeX editor with comments, reviews, history, backups and an AI working in the tab. Direct collaboration stays experimental and off by default. Remote sync, encryption, Git, Zotero and paid hosting come later, and aren't claimed.

**Must resolve**

- [x] Mac, Safari and Windows: the owner decided on November 10, 2026 to launch with them stated as not yet tested. The presentation site says so; testing follows after launch.
- [ ] Large real projects: performance and backup size measured. **Measured November 10, 2026, but not ticked: the results are not yet acceptable** ([large projects](large-projects.md)). A 305-page thesis with 40 MB of figures and a 3 MiB file work in Chromium, Firefox and WebKit, now that the compile limit is 10 minutes (it compiles in about 4 minutes). Long editing histories do not: history grows by about 414 bytes per typed character, and after 5,000 saves typing lags, History opens in 40–60 s and a complete backup needs a clean-up first. Fixing that changes how history is stored, which is the owner's decision.
- [ ] The owner's own trial use on real work.
- [ ] Repository made public, after an audit of its history. The owner has agreed to this for the beta; the switch waits for the launch instruction.
- [ ] Clean up what people see: no plaintext sync demo, frozen tools out of the way, presentation claims true.
- [ ] Privacy page, third-party and TeX licence notices.
- [ ] Telemetry prompt deployed, with one real record checked.
- [ ] A way to report problems.
- [ ] Launch switch: search indexing and public wording, on the owner's instruction.

**Should resolve, needn't block:** R4 and R5, the first-run experience, Grafana's free plan after its trial, and moving the CI runner off the agent host.

## Order of work

Numbered milestones keep their identities and relative order; new work has a letter. Milestones 4b and 4c leave the sequence for the reasons given below, with their requirements retained.

| Order | Milestone | Status | Delivery boundary | Release gate |
| --- | --- | --- | --- | --- |
| Done | 1. Complete the basic workspace | Complete | Static app | Real projects survive folder operations, asset replacement, export, reload, and failed compilation. |
| Done | 2. Download TeX components as needed | Complete | Static app and static package repository | A fresh browser downloads the required dependency set and then recompiles it offline. |
| Done | 3. MCP server, then MCP client | Complete; companion discontinued | Static UI and optional Rust companion; remote endpoints optional | An external client can inspect and safely edit an authorized project through the same commands as the UI. |
| Done | 4a. Live browser tabs and local recovery | Complete | Same-browser messaging | Tabs reconcile without silently discarding data. |
| **1 — now** | **[R. Reorientation](#milestone-r-reorientation)** | Direction recorded; R4 and R6 next | Architecture review and documented decision | A real agent completes the workflow in a person's real tab without a Scribyra install; feature dependencies and the revised implementation order are recorded. |
| 2 | [A. Agent-ready tab](#milestone-a-agent-ready-tab) | A1–A3 and experimental A5 delivered; real-tab gate remains | Static app only | An agent with no plugin edits, compiles and reads useful diagnostics in the tab, and a contract test keeps its instructions true. |
| 3 | [T. Telemetry, diagnostics, tests and Grafana](#priority-milestone-t-telemetry-diagnostics-and-grafana) | Deferred until R closes | Static client instrumentation/local debug tools; optional Rust/native instrumentation and self-hosted collection/storage/Grafana | A real failing operation and test run can be traced from dashboards to safe diagnostic evidence; offline use and telemetry failures leave editing/saving/compilation intact. |
| Done | 5. Comments | Complete | Static app; transport only for exchange | Anchors survive edits and renames; deleted selections become visibly detached. |
| Done | 6. Reviews and proposed changes | Complete | Static app; transport only for exchange | Suggestions remain outside the accepted source until explicitly accepted. |
| Done | 7. Restorable history | Complete | Static app; optional backup destination | A complete project, including assets and discussion state, restores after browser storage is erased. |
| 6 | [S. Self-hostable service](#milestone-s-self-hostable-service) | Delivered November 6, 2026; deployment limits recorded | Optional Rust service plus database and blob storage | A person can install and upgrade the service from documentation, and it stores and relays only opaque data with limits, health checks and a versioned protocol. |
| 7 | [D. Direct browser sessions](#milestone-d-direct-browser-sessions) | New; connection route decided | Static app plus optional self-hostable connection service | Two to five people sync on a network that permits it, the app says plainly when a network does not, and public wording claims no more than was tested. |
| 8 | 8. Remote and local Git | Queued; companion discontinued | Static UI; compatible HTTP endpoint/proxy | Ordinary Git tools recognize exported repositories, and branch/merge operations do not corrupt live projects. |
| 9 | 9. Application plugins and Zotero | Queued; companion discontinued | Static extension delivery; provider access as needed | A permission-limited Zotero integration updates citations without overwriting unrelated source. |
| 10 | 10. Connect to remote backup, sync, and collaboration | Queued | Static UI plus optional Rust service | Authenticated devices reconnect, catch up, and distinguish local saves from remotely durable saves. |
| 11 | 11. End-to-end encrypted backup and sync | Queued | Encryption on clients; opaque remote storage and relay | Recovery, device addition, revocation, offline edits, and tampering are tested together. |
| 12 | 12. Presentation website and public launch | Queued; private presentation deployed | Static HTML/assets; hosting account/billing service when used | Public claims match shipped capabilities and self-hosting installs are independently reproducible. |
| Parked | 4b. Folder synchronization | Paused | Browser folder adapter, or the discontinued companion | Concurrent edits and external file changes reconcile without silently discarding data. Live folder linking is [not selected](reorientation.md#decision) for now, because without the companion it would be Chromium-only. |
| Replaced | 4c. Paired local devices | Queued | Frozen LAN hub, or browser route through D | Its browser route moves to D. Its gate of disconnect and rejoin moves with it. SSH/VPN-assisted connections stay unscheduled. |

## Open decisions

| Decision | Needed for | Recommendation |
| --- | --- | --- |
| Run the real-model experiment, starting with a small pilot | A4 | Run the pilot once A3 is done. |
| Licence for a skill folder, if one is ever packaged | After A4 | Nothing is needed unless the experiment justifies a package. |
| Commission an independent security review | Strong encryption claims in milestone 11 | Decide when milestone 11 is scheduled. |

## What works where

This is the R2 mapping. "Tab" means it needs nothing beyond the browser and the agent's own browser tool.

| Capability | Route after this decision | State |
| --- | --- | --- |
| Edit, compile, read results, export | Tab | Exists, including bounded source-attributed diagnostics and counted warnings (A1–A2). Real-tab attachment is unproven (R4). |
| Revision-checked edits | Tab, through the shared command module | Available through the experimental shared v2 adapter (A5); the discontinued companion kept its v1 path. |
| Undo after an agent edit | Tab | Shared-command patches use `AgentOrigin` with isolated per-file undo groups, including unopened files (A5). |
| Agent attribution | Tab | A5 patches record agent/owner author IDs and session change records. Descriptive, not cryptographic; discussion/review attribution remains with those features. |
| Comments and reviews | Tab, then exposed as commands | Delivered locally with production anchors and shared agent commands; see [integration evidence](integration-567.md). |
| History and restore | Tab, with an optional backup destination | Delivered locally, including complete backup recovery of discussion state; see [integration evidence](integration-567.md). |
| Collaboration, same network | Tab plus an optional self-hostable connection service, on networks that permit it | Prototype only, outside the app: D. |
| Collaboration, any network | Optional remote service | Missing: milestones 10 and 11. Only a service gives durability and works on isolated networks. |
| Direct HTTP MCP providers | Tab | Exists. |
| Local stdio MCP providers | Companion | Discontinued November 8, 2026. Nothing replaces it. |
| MCP server for external clients | Companion | Discontinued November 8, 2026. Agents use the tab instead. |
| Live local-folder linking | Chromium-only in the browser (the companion route is discontinued) | Not selected. Import and export still work. |
| Git in a local repository | Companion | Discontinued November 8, 2026. An agent can still run Git itself in any real folder. |
| Git in the browser, HTTP remotes | Tab | Missing: milestone 8. |
| Zotero, watched exports | Companion | Discontinued November 8, 2026. |
| Zotero, file import and Web API | Tab, where a browser connection works | Missing: milestone 9. |
| Headless compile (`scribyra check`) | None | Not selected: it would be another install. |

**Existing companion users:** the companion was discontinued on November 8, 2026 (the owner's decision). The editor no longer shows its pairing dialog or contacts a local address. Pairings were never stored, so no project data is affected; the browser forgets any session when the tab closes.

## Confirmed product choices

- LuaLaTeX is the only supported compiler for now; additional engines are deferred.
- Downloadable components in milestone 2 mean TeX packages, fonts, engines, and compiler tools. Application extensions have their own later milestone.
- MCP works in both directions, exposing Scribyra first and connecting to external MCP servers second.
- The browser application remains independently useful without installation or an account. AI agents work through the open tab with their own browser tools, without a Scribyra install. The Rust companion is discontinued (November 8, 2026, the owner's decision); see the [decision record](reorientation.md).
- Reorientation is the current priority; telemetry/metrics, debugging, test reporting and Grafana remain required under milestone T. Instrumentation and diagnostic exports must remain useful locally; centralized collection is configurable and the complete stack is free to self-host. Document contents, credentials and private paper artifacts are excluded from telemetry by default.
- Comments, reviews, and history first work locally. Their interfaces and data structures must survive later remote collaboration and encryption.
- The presentation page means the product website, documentation, and hosting explanation. Beamer authoring belongs to compiler compatibility; a slide designer would be separate scope.
- Agents get instructions from the app, not from a package. The recipe is served by the app, and Scribyra ships no MCP server, hooks, `bin/` or browser extension for agents. See the [plugin investigation](reorientation/r1-plugin.md).
- Direct collaboration is an opportunistic transport beneath the same encrypted replication design as milestones 10 and 11. It complements the remote service and does not replace it. See the [collaboration investigation](reorientation/r1-collaboration.md).

## Working rules

LuaLaTeX is the only supported compiler for now. Split substantial work into reviewable goals. A goal is done only after its acceptance checks pass and its implementation is committed and pushed. The repository stays private. The owner made the Pages site publicly reachable without sign-in on November 6, 2026; it stays out of search indexes, and this is not the public launch, which requires a later explicit instruction. No milestone is complete merely because its baseline or presentation exists. Record remaining limitations alongside the implementation rather than silently narrowing the roadmap.

## Milestone R: Reorientation

Current milestone, added November 5, 2026. Review how Scribyra should support a local AI agent working alongside a person, with compact structured results and screenshots only when visual inspection is useful. The desired workflow includes editing the project through the open webapp, compiling there, reading diagnostics, leaving anchored comments and proposing review changes. The [decision record](reorientation.md) replaces the original assumption that the agent edits local project files.

### Tasks

- [x] **R1. Evaluate the three browser integration options below.** Compare setup, browser/agent compatibility, response size and token usage, reliability, access to the user's active tab, permissions, offline behavior and maintenance cost. Done: see the [decision record](reorientation.md). Option 1 is the default, a command API is the structured route, and WebMCP is deferred. Real-agent and real-browser validation moved to R4. Two later investigations added to it: [collaboration](reorientation/r1-collaboration.md) and [AI plugins](reorientation/r1-plugin.md).
- [x] **R2. Map the workflow to delivered and missing features.** Distinguish local filesystem access from controlling the active browser project. Identify shared-folder reconciliation, comment/review models, revision checks, undo and agent attribution requirements. Companion capabilities are decided: it is frozen and existing users keep working. Done: see [what works where](#what-works-where).
- [x] **R3. Record the direction and implementation order.** Document the chosen approach (or combination), acceptance checks and dependencies on milestones 4–6. Retain unfinished telemetry and later milestones, and explicitly record any approved scope changes. Done: the direction and [order of work](#order-of-work) are recorded, with milestones 4, 8 and 9 replanned.
- [ ] **R4. Real-tab test.** Real Claude Code and a real Chrome profile, including a human approval, complete compile, read diagnostics and a small edit on a project already open in that person's tab. Run it with no plugin, and also try a new tab in the real profile. Do first. [Details](reorientation.md#open-work).
- [ ] **R5. Remote-agent experiment.** After R4 and milestone A, test whether an unrelated AI can compile LaTeX through Scribyra with no setup, using a browser tool or a `#tex=` link. The Pages site is now reachable without sign-in, so this no longer needs a separate deployment. [Details](reorientation.md#open-work). A plugin has no role here, because the agent cannot install anything in advance. The link entry and scripted browser preparation are [delivered and checked](reorientation/r5.md); the real remote trial remains open.
- [x] **R5a. Fix the TeX link review findings.** Reject synthetic approval events, retain untrusted provenance across clones and recovery, and keep new links and their recovery copies in memory until acceptance. Five unapproved visits leave zero stored projects. [Checks and threat model](reorientation/r5.md#review-follow-up-r5a); the real R5 trial remains open.
- [ ] **R6. Real-network test.** Between two real machines on a shared network, measure whether direct connections work, using the [field-test page](reorientation/field-test.html) and the [report](reorientation/r1-collaboration.md). The owner's goal is people collaborating where the network already permits it, such as an office or home; cafés were only an example. Scribyra does not try to get around a network's or firewall's restrictions: where devices cannot reach each other, the app says so plainly. This does not block the gate; its results inform how milestone D is built. First results from two real machines on home Wi-Fi are [recorded](reorientation/r1-collaboration.md#addendum-real-network-with-real-firewalls-2026-11-05): with default firewalls, a manual exchange only works if it finishes within a few seconds. [Through the connection service](reorientation/r1-collaboration.md#addendum-through-the-connection-service-2026-11-07), the same machines connected in 26 of 32 trials; Firefox offering to Chromium is the weak case. Still to run: Safari on a Mac, Windows to Mac, and a real office network.
- [x] **R6a. Repair the field-test human-delay flow.** Defer B's local answer; replace the final click race with an armed wall-clock start, a shared explicit boundary and live clocks. Keep the pre-start typed address, attempt identity, fresh-attempt recovery and candidate/start diagnosis. The [follow-up evidence](reorientation/r1-collaboration.md#r6a-follow-up--scheduled-starts-and-clock-diagnosis) records 48/48 scheduled connection/20 MiB trials, the signed skew table and 105/105 UI checks; the earlier 96 click-start trials remain historical evidence. This fixes the test page; R6's real-network gate remains open.

### Three browser integration options

| Option | Mechanism | Benefits | Limits and evaluation questions |
| --- | --- | --- | --- |
| 1. Text-based browser automation | An existing browser tool uses accessible element names/roles and targeted DOM text to operate the UI. Playwright MCP can use accessibility snapshots without screenshots. | Uses ordinary controls; can exercise the same workflow as a person; no dedicated Scribyra native service. | Large snapshots can still consume tokens. Check editor/PDF accessibility, stable selectors, bounded panel reads, UI changes and connection to the correct existing tab. |
| 2. Scribyra JavaScript command API | A versioned in-page interface exposes operations that the agent's browser tool invokes, for example through Playwright `page.evaluate()`, returning bounded JSON. | Direct operations and compact results; avoids rediscovering controls for each action; can share the UI's command validation and revision handling. | Requires an API contract, documentation, browser-tool access and lifecycle handling. It is not an HTTP endpoint an external process can call without a browser connection. Permission checks must live in shared command handling; this API does not sandbox a browser tool that already has arbitrary page-script access. |
| 3. WebMCP | The page registers structured tools for a compatible browser/agent to discover and execute in the active tab. | Standardization path for explicit operations; could adapt the same command implementation as option 2. | Proposed standard with experimental browser/tooling support as of this review. Verify actual supported versions and discovery/invocation in the selected agents; retain a fallback. It does not make the tab an ordinary HTTP/stdio MCP server. |

R1's outcome: UI automation by default, then a shared command API. WebMCP may later become a thin adapter over the same commands.

Example proposed operations are `compile`, `getDiagnostics`, `addComment` and `proposeChange`. A compile result could contain only status, project revision, page count and warning count; detailed diagnostics would be requested separately. Bound result sizes, paginate lists and avoid returning full source, logs or page snapshots by default. Measure actual response sizes and token usage with the chosen agent rather than promising a reduction without evidence. Screenshots may still be useful for typography, figure placement and other PDF layout reviews.

All three options require the AI's tooling to reach the intended browser tab/session. They can avoid a Scribyra-specific companion for app operations, but do not remove the agent's browser tooling or give the webapp permission to launch arbitrary local programs. A page-level API must not bypass project scoping, stale-revision rejection, normal transactions, cancellation or visible user control.

### Current implementation and decision gate

Browser compilation, diagnostics and PDF preview exist. The existing companion exposes structured compile/read/write/export operations; it does not implement comments or reviews. Folder import currently copies files into browser storage; live shared-folder editing/reconciliation remains incomplete. Comments and reviews have since passed their integrated milestones 5 and 6 gates; the real-tab attachment experiment remains separate.

Gate: complete R1–R5 (R6 informs milestone D and does not block this gate) with an explicit comparison of all three options, a recorded architecture decision, compatibility and measurement evidence (or clearly identified experiments still required), and a revised implementation sequence. Document which capabilities require local software, which work entirely in the tab, and what happens to existing companion users. Documenting this milestone alone does not complete it.

Sources checked November 5, 2026: [Playwright MCP accessibility-based automation](https://github.com/microsoft/playwright-mcp), [Playwright in-page JavaScript execution](https://playwright.dev/docs/evaluating), [Chrome WebMCP proposal and trial](https://developer.chrome.com/docs/ai/webmcp), and [Puppeteer experimental WebMCP support](https://pptr.dev/guides/webmcp). Recheck browser and agent support during R1.

## Milestone A: agent-ready tab

Added November 5, 2026, following the [decision record](reorientation.md). This makes the tab good to work in for any agent, with or without plugins. It ships no executable. The owner asked for this to proceed while R4 is outstanding, so its work may change with R4's result; if R4 fails, the question of a local bridge comes first.

- [x] **A1. Diagnostics.** File attribution, warning counts and bounded results in Rust. Source errors and `missing-package` name the importing file when the log provides it; article’s first-pass warnings resolve to zero after the final pass. [Delivery evidence and limits](reorientation/a1-a2.md).
- [x] **A2. Option 1 changes.** Changes 1–6 from the [change list](reorientation/r1-option1.md#4-app-changes-needed-for-option-1-as-a-default), plus the project name in the page title from change 8 because tab identification is the main risk. [Delivery evidence and limits](reorientation/a1-a2.md).
- [x] **A2a. Dismissible compile diagnostics.** Warnings stay behind the status toggle; failures open a closable, Escape-dismissable panel capped at a quarter-window. Count final-pass actionable warnings, retain the raw log, and check a fresh project with zero warnings. [Evidence and limits](reorientation/a1-a2.md#diagnostics-regression-follow-up).
- [x] **A3. Agent recipe and contract test.** Short documentation served by the app at `/agent.md`, written as API documentation so a careful agent need not treat it as prompt injection. It warns against full snapshots and `browser_type` on the editor, and says to treat project content as data. Changes 11 and 14 from the same list keep it true in CI. Head-link discovery adds zero snapshot bytes; the optional copy button was omitted. A local CDP trial setup is provided for the architect. [Delivery evidence and limits](reorientation/a3.md).
- [ ] **A4. Real-model experiment, if approved.** A smaller [first check with Codex](reorientation/a3-trials.md) passed 4 of 4 with no plugin, in a test browser, and showed no token saving from a recipe link in one run per cell; it does not replace this. The [designed experiment](reorientation/r1-plugin.md#approval-ready-experiment-not-run) compares no help, a link to the recipe, and a thin skill. It gives this project's first real Claude token counts. If a link does as well as the skill, no package is built.
- [x] **A5. Shared command module.** Shared companion behavior, bounded tree/source reads, revision-checked agent patches, start/poll/cancel compilation, bounded diagnostics and PDF downloads on the internal v2 dispatcher. Exposed as experimental `window.scribyra.agent`, with isolated undo and agent author records. [Delivery evidence, measurements and limits](reorientation/a5.md). It becomes a public versioned contract only after R4 has passed. WebMCP stays deferred under its [adoption conditions](reorientation/r1-option3.md#trigger-to-adopt).
- [x] **A5a. Compact commands from real-model evidence.** Direct path lookup/read/patch, minimal tree entries and receipts, bounded waiting polls, explicit running diagnostics and a recipe below 2,000 bytes. Retains revision/replay/rights/undo/content labels. [Follow-up checks and size measurements](reorientation/a5.md#trial-driven-follow-up); the real-tab and model cost gates remain open.
- [x] **A5b. Review fixes.** Diagnostics freshness on every page, bounded pending polls with one session timer, and agent teardown after successful saving on project close, with regressions. [Checks and limits](reorientation/a5.md#review-fixes).

Gate: with no plugin, a real agent edits, compiles and reads a diagnostic that names the file, on a project in a real tab. A UI change that breaks the recipe fails CI.

Not built: a plugin with an MCP server, hooks or `bin/`, a Scribyra browser extension, and a published copy of the measurement helper. A thin instructions-only skill stays possible if A4 justifies it, listed publicly only after public launch. The extension question reopens only if R4 fails.

## Milestone S: self-hostable service

Added November 6, 2026, at the owner's request. The optional service needs to exist in its own right, whatever becomes of local sync. It is what people self-host and what the later paid offering runs: one Rust service plus a database and blob storage, with every feature free when self-hosted. This builds its foundation so D, 10 and 11 extend it rather than replace it. It succeeds the plaintext `scribyra-sync` experiment.

- [x] **S1. Design.** Protocol versioning, opaque storage and relay, identity boundaries, and the envelope shared with D, 10 and 11, written before implementation.
- [x] **S2. Foundation.** Configuration, persistence, health and readiness checks, limits, structured logs, allowed origins and graceful upgrade.
- [x] **S3. Connection service.** Opaque live exchange for milestone D, which is what real-network tests showed D needs.
- [x] **S4. Self-hosting.** Container and NixOS deployment, with documented install, upgrade, backup and restore, followed from a clean host.
- [x] **S5. Security-review capacity fixes.** Authenticate before upload bodies; partition transfers and live rooms by tenant; retain bounded download bytes through send completion; test a runnable TLS proxy. [Regression evidence, defaults and deployment limits](service.md#security-review-follow-up-6-november-2026).
- [x] **S6. Second security review and runtime deployment.** Partition request admission by source and authenticated namespace, give health independent rate capacity, and bound connections/rate before TLS. Run the built image rootless and boot the NixOS module under software QEMU. [Attack regressions, executed commands and host limits](service.md#second-security-review-and-runtime-deployment-6-november-2026).

Delivered on this branch: [design](service-design.md) and [operations, commands and evidence](service.md). The install/upgrade/restore gate used fresh directories. Follow-up checks also ran the pinned image rootless (host loopback, cgroups disabled in this LXC) and booted the NixOS module under software QEMU; published container networking remains unverified here. D and milestones 10–12 remain open.

Gate: following only the documentation, a clean host runs the service and two clients exchange opaque data through it. Tests show that stored objects reveal no content, abuse limits hold, and a restart loses no acknowledged data. Accounts, memberships and billing stay in milestones 10 and 12. Public claims of encrypted storage wait for milestone 11.

## Milestone D: direct browser sessions

Added November 5, 2026. Two or more people on a shared network, such as an office or home, each running Scribyra on their own machine, sync directly over WebRTC with nothing to install on their machines. They find each other through an optional, self-hostable connection service, which the owner chose on November 5, 2026 after real-network tests; document data still travels directly between browsers. Ordinary WebRTC connection behaviour is used; working around a network's restrictions is out of scope. The [investigation](reorientation/r1-collaboration.md) found this works where a network lets devices reach each other and cannot work under client isolation. The original virtual-network results did not authorize product delivery. The owner started the off-by-default implementation on November 7; **field acceptance remains open**: if most venues isolate clients, the relay in milestone 10 takes priority and this stays niche.

This replaces the browser route of 4c. The session exists only while tabs are open, and a browser still cannot serve the app to a peer: first use needs internet, and the app must already be cached to join offline.

[Design and branch evidence](direct-sessions-design.md): trusted full editors only, manually configured service and separately provisioned relay capability, 113-byte binary invites, Chromium offerer for mixed pairs, explicit comparison codes, and no ICE servers. D1, D2 and D4 are delivered. D3 has local-context implementation evidence and one [real two-machine trial](direct-sessions-design.md#real-two-machine-trial-november-9-2026) on a single home network (8 of 8 mixed Firefox/Chromium sessions converged); it stays open for other networks, client isolation and the measurements below. D5 remains open. The superseded manual SDP timing/typed-address/camera ladder below is not implemented or claimed.

- [x] **D1. Shared replication layer.** Transport-independent, for D and milestones 10 and 11. It needs two-way state-vector sync on connect and periodically (the prototype hit a silent stall without it), chunked framing, hash-verified blob requests and the validation pipeline in `web/local-tabs.js`.
- [x] **D2. Identity and envelope design.** Written before either transport is built, so there is only one cryptographic design. It covers a per-profile Ed25519 identity bound to the connection fingerprints, a committed comparison code, signed relayed signaling, and the envelope milestone 11 will use.
- [ ] **D3. Direct transport and invites.** *Partly measured:* the [real two-machine trial of November 9, 2026](direct-sessions-design.md#real-two-machine-trial-november-9-2026) ran Firefox and Chromium on a wired desktop and a Wi-Fi laptop behind one home router, through the connection service; 8 of 8 mixed sessions connected in 99–181 ms after the codes and converged. One network on one day: no client isolation, guest or office network, delay sweep or Safari, so this stays open. [Real-network results](reorientation/r1-collaboration.md#addendum-real-network-with-real-firewalls-2026-11-05) require an exchange that completes within seconds, because both sides must send at nearly the same time. **Decided: an optional, self-hostable connection service carries the live exchange**, built into `scribyra-sync` so that one self-hosted Rust service covers this and milestone 10. It only passes opaque connection details and must not be able to read or alter a session: its operator sees addresses, timing and who pairs with whom, and swapped fingerprints must be detected through verification. Earlier requirements that follow are superseded where they assume a manual exchange; a manual invite may remain as a fallback only if it passes real-network tests. WebRTC with no ICE servers by default. A compact invite targeting about 120 bytes, pasted first and QR second; remeasure it with the delayed exchange flow. Keep human copying outside the connection timer: defer B's local answer, then use a measured scheduled start (field-test page: Arm once each, convey A's exact half-minute boundary to B, B starts one second later). Record clock readings and apparent offsets, measure skew tolerance and reject missed starts explicitly. Test 0–180-second exchange delays in all four Chromium/Firefox pairings, with and without camera-style raw candidates. Stage a typed address before starting; a failed peer needs a fresh attempt. Include attempt IDs, elapsed status and Start over. The connection ladder needs its own timer because Chromium may give no failure signal, but a timeout alone is not proof of network isolation: distinguish a missed start window, discovery and reachability failure, then offer a typed-address retry, camera permission, hotspot, relay or update file. See the [human-delay evidence](reorientation/r1-collaboration.md#addendum--human-reply-delay-2026-11-05).
- [x] **D4. Sessions.** Full mesh up to five people, rejoin, and one connection per browser profile through Web Locks. Auto-compile must not fire on peers' edits. Before sharing, show what is shared, because updates include the trash with deleted files' full text. Checked for local contexts only. A project restored in place can be shared only as a cleaned copy; see [remaining limits](direct-sessions-design.md#remaining-limits).
**Decided by the owner, November 8, 2026** ([details](direct-sessions-design.md#decisions-8-november-2026-off-means-off)):
1. *Off means off.* With direct sessions never turned on, no key, no `scribyra-direct` database, the author ID `main` produces and no D field in any project, backup, export or history; a regression compares this byte for byte with `main`. The key is created only when the person turns sessions on (or does so to join an invitation). Earlier records and decisions show to peers as claimed or unverified, never as approvals, and Share says so before sharing. Turning sessions off stops D and keeps the key, which Share can delete.
2. *Restored projects share only as a cleaned copy.*
3. *Any full editor can redact others' messages or close their reviews*; the signed event names who did.

- [ ] **D5. Acceptance.** Real networks and devices, with real Safari, Windows and Mac, and real sleep. Chrome's Local Network Access prompt, if it applies. Offline package differences between laptops.

Gate: all of the above, plus visible status that never suggests peers are a backup, and agent edits that are marked for other participants.

**Allowed wording after a good field test:** "Connects directly between browsers on your network, using a connection service you can host yourself. The connection is encrypted by WebRTC. Check the code to confirm who you are connected to. Works only on networks that allow devices to reach each other."

**Not allowed yet:** "end-to-end encrypted collaboration", "secure against your network", "works in any café", and removal or revocation guarantees. These wait for milestone 11's gate and independent review.

## Foundations inside milestone 1

Introduce the shared Rust project model and a versioned command interface while completing the workspace. UI actions, MCP, plugins, folder import, and Git should eventually call the same operations. This is the first useful Rust migration, rather than a wholesale rewrite of the editor.

Use stable IDs for projects, folders, files, comments, and revisions. Model folder parentage explicitly, including empty folders; derive filesystem paths for export and compilation. Define duplicate-name, case-collision, Unicode, concurrent-move, and deletion behavior. A file's identity must survive a rename.

Separate immutable image/font/PDF blobs from frequently changing text and metadata. Keep an incremental durable update journal and periodic checkpoints from this milestone. The history interface remains milestone 7, but waiting until then to preserve history would make earlier edits unrecoverable.

Reserve versioned transport envelopes, device identity, authorization boundaries, and a ciphertext storage interface now. Ship encryption later, but avoid making server-side plaintext document merging a permanent dependency.

Migrate existing IndexedDB projects with a recovery copy and round-trip checks. Maintain one authoritative text model per running client; do not mirror every keystroke into competing JavaScript and Rust documents.

## Milestone 1 scope

First implementation slice: the shared Rust tree validator, schema-v2 migration with an atomic recovery copy, nested accessible tree, subtree rename/move, recoverable deletion, atomic uploads, empty-directory ZIP round trips, and local image preview/replacement are implemented. Validation: 27 browser tests pass across Chromium, Firefox, and WebKit, including actual multi-engine compilation, offline restart, migration rollback on disk-full errors, folder operations, and image replacement; 21 Rust/JavaScript unit tests also pass. This completes the bounded tree/asset goal, not milestone 1 as a whole. The first slice used full paths with stable node IDs. Goal 1c has since replaced those paths with parent/name records and added conflict recovery; goal 1b delivered the incremental journal. Goal 1e.1 delivered duplication, directory-picker import and drag/drop, including empty directories when supported and explicit fallback guidance. Goal 1e.2 added reviewed literal-reference rewrites and relative figure insertion. Goal 1e.3 delivered stable tabs, project-wide search and reviewed replacements, literal outlines, editor/project settings and keyboard commands. Goal 1e.4.1 delivered PDF text selection, page navigation, search, position-preserving zoom and bounded rendering. Goal 1e.4.2 adds line-level source/PDF navigation through Rust/WASM SyncTeX queries, exact compiled-revision guards and nested Unicode input handling. The integration gate remains below.

Build an accessible nested tree with create, rename, move, duplicate, delete/recover, selection, drag/drop, and keyboard navigation. Support folder imports where available and ZIP imports everywhere. Preserve empty directories and binary bytes on export.

Add image previews and dimensions, replace/download controls, relative-path insertion for figures, and useful views for bibliography, CSV, and other text assets. Keep potentially active asset formats isolated. Folder moves should identify likely broken LaTeX references and offer a reviewed rewrite; macro-generated paths cannot be updated reliably by a simple search.

Finish multiple editor tabs, project-wide search/replace, outline navigation, keyboard commands, main-file selection, engine settings, and project settings. Improve the PDF viewer with text selection/search, page navigation, and source/PDF synchronization where engine output supports it. Make missing dependencies, document errors, compiler failures, and warnings distinguishable.

- [x] **1e.3a. Theme the editor find/replace panel.** Use workspace tokens, compact accessible icon controls, bounded match counts and themed match outlines in light/dark and narrow windows. Preserve CodeMirror commands and keyboard shortcuts; Reviewing replaces become suggestions and Viewing refuses them. [Implementation and limits](architecture.md#editor-workspace).
- [x] **1e.3b. Correct the combined UI review findings.** Keep menu revisions through every action, reject stale select commits, replace individual Reviewing matches atomically and retry Versions focus until it succeeds. [Evidence and limits](ui-review-fixes.md).

Gate: exercise a multi-folder project with Unicode names, nested inputs, images, citations, a missing file, and a source error in all three supported browser engines. Include actual IME and keyboard accessibility checks. A move/delete collision or failed save must offer recovery rather than claim success.

## Milestone 2 scope

Generate a versioned static TeX repository at build time. Publish sharded filename indexes, package/dependency manifests, immutable archives, checksums, upstream notices, and engine/format compatibility metadata. No package installation server is required during compilation.

Start with a small engine and baseline format, then fetch the required packages, language files, fonts, and tools. Add bounded missing-file resolution, resumable downloads, cancellation, progress, installed-package inspection, user package overrides, and actionable unsupported-tool diagnostics. Replace the Romanian special case with the general mechanism without losing its regression coverage.

Record an exact compilation environment lock. Offer **Prepare this project for offline use**, an offline-readiness indicator, cache size controls, and export/import of an offline package set. Separate discardable package caches from irreplaceable project data.

Gate: test class-loaded packages, multilingual Babel, font dependencies, Biber, the supported engine, a corrupt archive, an interrupted download, an actual missing filename, and a repeated missing request. Engine acceptance currently covers LuaLaTeX, following the confirmed product choice above; additional engines remain deferred. Measure bytes transferred and peak memory against the current large-bundle baseline. A package mirror update must not silently change a locked project's compilation environment.

## Milestone 3 scope

*Delivered. The companion was discontinued on November 8, 2026 (the owner's decision); the editor no longer offers it or local stdio providers, and its code remains only for tests.*

Introduce a small Rust companion with authenticated browser pairing and an MCP endpoint. Start with resources for the project tree, source, bibliography, diagnostics, and build results. Expose tools for search, file creation, revision-checked patches, compilation, and export. Editing operates on the active project through the command API; it must not edit an unrelated disk copy behind the browser's back.

Provide read-only access and explicit project scopes. Mutating tools return a concrete diff or transaction result and reject stale expected revisions. Compilation initially requires the browser's compiler to be available; return that limitation clearly when no runtime is connected. A native compile backend can be added separately.

Then add an MCP client: browser-compatible HTTP connections when supported, and stdio/local connections through the companion. MCP support does not require a built-in language model. External tools and services receive only user-authorized project data.

Gate: test an external MCP client, denied access, revoked pairing, concurrent edits during a proposed patch, cancellation, and browser disconnect. Test the supported protocol revisions against real clients rather than copying an obsolete transport example.

## Priority milestone T: telemetry, diagnostics and Grafana

Make Grafana the common view for operational and development evidence: runtime
metrics, structured logs/events, correlated traces, resource measurements, debug
sessions and automated test/CI results. Remaining implementation is deferred while
Reorientation is current. Preserve this milestone's acceptance requirements, the
original local-sync gate and all later product requirements.

### Required work when the goal resumes

The selected dashboard URL is **https://telemetry.scribyra.com**. Its management
service account has been checked, and the existing collector token has accepted
a synthetic metric, log and trace. All three were successfully queried back
through Grafana. The verified Cloud OTLP endpoint is
`https://otlp-gateway-prod-eu-central-0.grafana.net/otlp`; protocol/authentication
settings are saved in the operator's private credentials file outside the
repository. These checks sent data directly to Cloud: they did not deploy Alloy
or instrument Scribyra.

The following are required milestone deliverables, not optional follow-up work:

- [ ] **Webapp gathering.** Implement the Rust/WASM telemetry contract and browser
  adapters, instrument real webapp/worker operations and useful usage counters,
  and provide collection/export settings, local event inspection/debugging and
  reviewable diagnostic-bundle export. Include real exceptions/rejections through
  safe error categories. Preserve offline operation and keep gathering bounded.
- [ ] **Collector deployment.** Configure and run Grafana Alloy as the initial
  collector, with a reproducible self-hosted alternative compatible with standard
  OpenTelemetry. Load ingestion credentials at runtime on the collector/server;
  retain separate Grafana management credentials. Cloud tokens must never enter
  the browser bundle, source exports or diagnostic exports. Existing direct probes
  are connection checks, not a substitute for the collector pipeline.
- [ ] **Browser-to-collector route.** Configure and verify a browser-compatible
  ingestion route. Official browser builds now use Faro directly (below);
  the optional native/CI ingress at `https://ingest.telemetry.scribyra.com` still
  requires DNS/HTTPS and deployment. Handle allowed origins, authentication
  appropriate to deployment,
  rate/body/queue limits, sampling and dropped-event reporting. Make the endpoint
  configurable for self-hosting and verify disconnected/slow/rejecting behavior.
- [x] **First-run telemetry consent.** Builds with an explicitly configured
  ingestion address name it in a nonblocking, all-off consent card. Gate performance,
  errors and usage independently; persist choices and permanent refusal per
  browser origin, bound unanswered reminders, and allow immediate revocation in
  Diagnostics. Unconfigured builds show no card and send nothing. Keep credentials
  out of browser bundles and provide bounded, origin-checked anonymous ingress.
  Delivered locally November 7, 2026; official Faro destination selected below.
  [Commands, evidence and limits](telemetry.md#local-controls-and-evidence).
- [x] **Official Faro consent transport.** Official Pages builds select the public
  Grafana Cloud Frontend Observability collector; ordinary source/self-hosted
  builds stay unconfigured. Project validated consent categories into Faro JSON
  with no SDK, automatic capture, user identity, persistent IDs or replay. Name
  the third-party destination and link collection details in the prompt and
  presentation privacy text. Verify exact fields, category gating, pre-consent
  silence and seeded privacy against a local fake collector in all three engines.
  No external collector request/deployment; architect’s real consented record and
  provider retention/access/budget review remain. [Fields and evidence](telemetry.md#what-is-sent-to-faro).
- [ ] **Grafana provisioning.** Create a Scribyra folder and version-controlled
  dashboards/data-source bindings for application usage and health, compilation,
  downloads/cache, storage/recovery, existing MCP/sync paths, collector health and
  test/CI results. Include links between correlated events, traces and diagnostics.
  Distinguish synthetic/test evidence from real application activity.
- [ ] **Retention, access and alerts.** Configure and document available retention,
  resource/cardinality budgets and private access for dashboards/diagnostics.
  Provision and test useful failure, latency and collector-delivery alert rules,
  including no-data/stale-data behavior. Verify the self-hosted settings as well as
  what the selected Cloud stack supports.
- [ ] **End-to-end evidence.** Trigger real supported application actions and
  controlled failures in the production webapp, follow them through the collector,
  and query their metrics/logs/traces in Grafana. Test privacy/redaction, controls,
  offline/failure isolation and overhead. Add actual Rust/JavaScript/browser/CI
  results and reproducible setup/upgrade instructions. Profiling remains part of
  the wider resource-diagnostics scope where the runtime supports it; a working
  metric/log/trace token does not establish profiling ingestion.

The existing scope and acceptance gate below still apply in full. Do not mark
milestone T complete on the strength of credentials, synthetic probes, local-only
instrumentation or dashboard templates alone. Do not resume implementation while
the overall goal is paused.

### Delivery sequence

1. **T1 — shared contract and local tools.** Define a versioned Rust schema for
   events, counters, distributions, operations and correlation identifiers. Keep
   browser I/O and clock/runtime integration behind adapters. Add bounded buffers,
   collection/export controls, event inspection, a local debug timeline and safe
   support-bundle export. A user must be able to diagnose offline failures without
   an account or collector. Raw TeX logs remain separate from safe telemetry.
2. **T2 — instrument the actual paths.** Cover startup/version/build identity,
   user-triggered compilation and worker passes, package preparation/download/
   verification/retry/cache activity, PDF preparation, storage commits/quota/
   migrations/recovery, command validation and MCP/provider operations. Include
   the existing local-tab/native-session/sync paths without resuming unfinished
   folder features. Record typed success/failure/cancellation, duration, byte and
   bounded resource measurements where available. Follow one operation across
   browser, worker and optional companion, including late results/restarts.
3. **T3 — provision collection and Grafana.** Supply an optional reproducible
   self-hosted collector, metrics/log/trace storage and Grafana with versioned data
   sources, dashboards and useful failure/performance alerts. The starting stack
   to validate is OpenTelemetry/OTLP collection, Prometheus metrics, Loki logs,
   Tempo traces and Grafana OSS; pin compatible versions during implementation.
   Prefer maintained integrations over rewriting a collector or dashboard server.
   Native instrumentation and shared policy should use Rust where practical;
   browser exporters may use maintained JavaScript adapters when SDK/runtime
   compatibility warrants them.
4. **T4 — test and development evidence.** Collect actual Rust, JavaScript and
   browser suite/run outcomes, durations, failures, skipped cases, build/revision
   identity and available performance measurements. Distinguish local runs from
   GitLab CI and synthetic fixtures from application usage. Link a failed test or
   traced operation to its safe diagnostic artifact. Include repeatable fault
   scenarios, regression views and instructions for reproducing failures locally.

Grafana is the query/visualization layer, with dedicated metric/log/trace backends
rather than an application database; see the primary documentation for
[Grafana OSS](https://grafana.com/docs/grafana/latest/fundamentals/),
[Loki](https://grafana.com/docs/loki/latest/get-started/overview/) and
[Tempo](https://grafana.com/docs/tempo/latest/). Validate native and browser
instrumentation against the current
[Rust](https://opentelemetry.io/docs/languages/rust/) and
[browser](https://opentelemetry.io/docs/languages/js/getting-started/browser/)
OpenTelemetry support before choosing exporters. Browser and native capabilities
must be measured separately; the roadmap does not assume identical SDK support.

### Local T4g acceptance in parallel

The owner explicitly authorized this local work while Reorientation remains current;
it does not change the order above or activate credential-dependent services.

- [x] **Native exporter overhead.** Measure fresh release CLI/service processes
  with collection disabled/local/remote using the T4e method, retaining raw
  measurements and limits.
- [x] **Failure isolation and offline acceptance.** All four collector modes pass
  editing, durable saves, cancellation, compilation, cache/recovery and reviewed
  offline support export in Chromium, Firefox and WebKit. Retained exact package,
  save/recovery and rejected/cancelled MCP failures also pass in all engines.
- [x] **Operational audit.** Audit every acceptance-gate line against evidence and
  run missing local checks, including full-duration alert transitions. See the
  [matrix and execution record](telemetry-acceptance.md).
- [x] **Prepare continuous publication and persistent ingestion.** Ship opt-in
  deployment artifacts and the [credential-bound runbook](telemetry-deployment.md).
  Prepared does not mean deployed.
- [ ] **Architect activation.** Select hosting/storage/backup/notification policy
  with the owner, activate private HTTPS ingestion/DNS and protected CI variables,
  observe direct publication by real jobs, and verify managed shortcut permissions.
  These steps require credentials and were not executed locally. T stays open.

### Static delivery, data boundaries and operations

The editor remains a static deployment. Local instrumentation, debug views and
exported support evidence work without a server. Centralized ingestion, retained
queries/alerts and the Grafana service are optional dynamic components; their
dashboard/configuration artifacts can be shipped as static release files. Provide
local development startup and deploy/upgrade/retention instructions for the full
free self-hosted stack. A hosted telemetry service may be a deployment option,
not a feature dependency or a required Grafana Cloud account.

Use explicit settings for collection/export destinations and useful presets for
development/test versus normal use. Source and self-hosted builds have no default
external telemetry endpoint. An official build may explicitly name a destination,
but sends nothing without per-category consent; unconfigured builds show no
consent prompt. No collector credential enters the static build. Keep local buffers and
export queues bounded, provide sampling/drop counters and storage limits, and
handle a disabled, unreachable, slow or rejecting collector without blocking a
save, compile or project recovery. Configure authentication, browser origins,
retention and access to diagnostic artifacts as part of the stack.

Approved structured telemetry fields must exclude paper contents, raw source/TeX logs,
project/file names, local paths, prompts/provider payloads, credential-bearing URLs
and tokens. Use safe operation/error categories and correlation IDs;
avoid per-project/file identifiers as metric labels and keep label cardinality
bounded. Test redaction with seeded source strings and secrets, including error
messages and headers. Raw browser traces/screenshots and private-paper harnesses
must not become automatic telemetry or CI uploads. More detailed developer
diagnostics require explicit controls and a reviewable export boundary.

### Acceptance gate

- A reproducible self-hosted stack receives real metrics, structured events and
  traces from supported Scribyra runtime paths and actual test runs. Provisioned
  Grafana views distinguish no data, live activity, failures and stale ingestion;
  a seeded dashboard alone is not evidence of integration.
- A failed compile/package request, failed save/recovery, rejected or cancelled
  MCP operation and a failing synthetic test can be followed through correlated
  evidence without exporting document contents or secrets. Native sessions are
  observed through their delivered API/CLI; the unfinished browser folder UI is
  not assumed to exist.
- Local diagnostics/support export work offline. Disabling telemetry and stopping,
  slowing or rejecting collection preserves editing, durable saves, cancellation,
  compilation and existing cache/recovery behavior.
- Rust/JavaScript/browser checks exercise schema bounds, privacy/redaction,
  correlation, event delivery/drop behavior and actual ingestion/querying. Measure
  startup, compilation, transfer and memory overhead with collection disabled and
  enabled, and record the method and limits alongside the results.
- CI dashboards reflect real run IDs/revisions/results with controlled artifact
  access, retention and reproducible failure links. Complete setup/export/upgrade
  documentation is shipped; all features remain available to self-hosters.

## Milestone 4 scope

*Replanned November 5, 2026: same-browser tabs are delivered as 4a. Folder synchronization (4b) is parked, because live folder linking is not selected and the companion is frozen (since discontinued, November 8, 2026). The browser route for local devices (4c) moves to [milestone D](#milestone-d-direct-browser-sessions). The requirements below are retained and would apply if this work resumes. Delivered 4b evidence stays valid.*

Implement same-origin, same-profile tab synchronization first. Coordinate storage writers so two tabs cannot replace each other's persisted state. This needs no server.

Add a browser folder adapter as an enhancement where permissions and APIs allow it. The companion supplies portable directory watching, atomic writes, rename handling, restart recovery, and reconciliation after sleep. An external editor and Scribyra can both work on a checked-out folder; conflicting simultaneous changes need a visible merge workflow.

For local devices, allow an explicitly paired LAN companion/hub or an SSH/VPN-assisted connection. Use the same project identity and replication contract planned for remote sync. A normal browser cannot automatically become an always-running LAN server.

Gate: change a file externally while editing it, rename its parent folder, disconnect a device, suspend/resume, and restart the companion. Binary conflicts retain both versions. Sharing raw IndexedDB files or a live SQLite database through a file-sync tool is not the synchronization design.

## Milestones 5 and 6 scope

- [x] **Foundation F: reserve collaboration schema and feature boundaries.** Internal v2 dispatch, schema-6/DB-7 recovery migration, guarded object commits and disabled feature mounts. [Contract](annotations-design.md#ownership-and-the-prerequisite-foundation-f); [verification and limits](foundation-f.md). Feature gates remain separate.
- [x] **Foundation F review corrections to `5d27827`.** Own prepared buffer bytes; await and serialize durable v2 dispatch with guarded commits/retries; share the cancellable build coordinator with isolated result destinations. [Evidence and limits](foundation-f.md#review-corrections-to-5d27827).
- [x] **Foundation F second review corrections to `adf7ad0` and `893a98f`.** Confirm receipts/replay at the storage boundary, preserve later edits, cancel closed-host waits after active transactions terminate, and resume pending accepted-source compilation after either build path. [Evidence and limits](foundation-f.md#second-review-corrections-to-adf7ad0-and-893a98f).
- [x] **5. Correct reviewed comment anchors, undo limits and draft navigation.** Preserve selected witness lineage through undo/redo without adopting inserted text; preflight complete binding updates against semantic limits; guard discussion drafts. [Regression evidence and limits](comments.md#review-corrections-verification).
- [x] **5. Fix cleared-edit navigation and record the disconnected-peer limit.** Reset empty composer targets on thread navigation, reject edits outside the displayed thread, and cover composer modes through reload. Record witness ancestry across disconnected peers for milestone D without changing anchor behavior. [Evidence and limits](comments.md#cleared-edit-navigation-verification).
- [x] **5. Persist device-local comment drafts and guard leaving.** Recover comment/reply targets across reload, tab close and All projects in every mode; keep orphan text recoverable, bound local storage and exclude drafts from project transfers. [Commands, evidence and limits](comments.md#draft-recovery-verification).

- [x] **5/6. Discussion on suggestions.** Reply in every editor mode; retain original discussion through revisions, decisions, undo, recovery and exchange, with agent attribution. [Contract](annotations-design.md#suggestion-discussion-amendment--7-november-2026); [evidence and limits](reviews.md#suggestion-discussion-verification).
- [x] **5/6. Suggestion discussion review fixes.** Validate restored thread identities, reject supersession cycles, retain incomplete cards, and exchange the selected discussion with decision claims as evidence. Strengthen randomized reply ownership and soften accessible author marks. [Verification and limits](reviews.md#suggestion-discussion-review-follow-up--november-7-2026).

- [x] **Milestone 6 review-finding corrections.** Preserve pre-batch suggestion conflicts through undo/redo and peer reload; bound imports before reading; disable reviews until production anchors are available. [Evidence and limits](reviews.md#review-finding-corrections-november-5-2026). That branch-only limitation is superseded by the integrated gate below.

- [ ] **Milestone 5 integrated gate.** Architect review pending; the earlier partial-rerun evidence did not close this gate. Production anchors, thread UI/commands, restore and suggestion acceptance pass together in all three engines. Keep the disconnected-peer witness limit. [Combined evidence and limits](integration-567.md).
- [ ] **Milestone 6 integrated gate.** Architect review pending; the earlier partial-rerun evidence did not close this gate. Production anchors replace browser contract fixtures; proposals, authority, exchange, acceptance undo and isolated preview pass together with comments/history in all three engines. [Combined evidence and contract amendment](integration-567.md).
- [x] **5/6/7 integration-review repairs.** Reject suggestion-anchor reattachment; restore complete undo witnesses and effective event bindings; carry trusted agent attribution and preview jobs through the production route. Nine new production cases pass in all three full engine runs. Milestones 5–7 remain **Integrated; gate under review** for architect sign-off. [Exact commands, failures, counts and limits](integration-567.md#integration-review-corrections-november-6-2026).
- [x] **5/6/7 second integration-review repairs.** Retire stale undo/redo groups at replacement boundaries and verify rehearsed source before commit; restore effective comment bindings on redo; preserve trusted history actors separately from owner authority. Add 512 seeded production sequences and fix the deferred comment-save focus race found by the full matrix. Milestones 5–7 remain **Integrated; gate under review**. [Exact commands, failures, counts and limits](integration-567.md#second-integration-review-corrections-november-6-2026).

- [x] **5/6/7 third integration-review repairs.** Preserve trusted importer and retry sessions, retain original contributors, exclude imported claims from history decisions, and make seeded selection reproducible while auditing actor-writing routes. All requested acceptance checks pass; milestones 5–7 remain **Integrated; gate under review**. [Evidence and limits](integration-567.md#third-integration-review-corrections-november-6-2026).

- [x] **5/6/7 restore witness ownership repair.** Map surviving checkpoint selection witnesses into restored identities without adopting interior insertions or changing the quote; detach unavailable mappings. Audit copy/backup paths and strengthen all 512 random seeds with independent ownership checks. Requested unit/build and comments/history/reviews checks pass in all three engines; integrated gates remain under architect review. [Exact commands, negative control and limits](integration-567.md#restore-witness-ownership-correction-november-6-2026).

*Agents reach these through the [shared commands](#milestone-a-agent-ready-tab), for example `addComment` and `proposeChange`, and their work needs attribution. Proposals never apply themselves.*

Comments contain threads, replies, authors, resolved/reopened status, stable file IDs, and anchors tied to text positions plus fallback context. Mentions work as local metadata first; email/push delivery waits for an optional service. Portable review exports allow asynchronous exchange without a permanent server.

Reviews add proposed insertions/deletions/replacements, accept/reject controls, a review queue, and optional preview compilation of proposed changes. The ordinary compile action uses accepted source. A stale suggestion must be rebased or marked conflicted rather than applied at the old numeric offset. Acceptance creates a normal attributed transaction.

Gate: test anchors across edits, file moves, deleted selections, restore operations, and suggestion acceptance by two peers. Distinguish editing rights from commenting/reviewing rights in the schema before offering those roles remotely.

## Milestone 7 scope

Expose automatic checkpoints, named versions, text and asset diffs, authorship, restore-to-copy, and deliberate restore into the current project. Retention and compaction must preserve every version still advertised as restorable.

Maintain two exports: ordinary source ZIPs for interoperability, and a complete Scribyra backup containing identity, comments, reviews, retained history, asset references, and environment locks. Keep provider credentials and device secrets out of ordinary project exports. Recovery keys need a separate explicit backup flow.

- [x] **M7 review repairs.** Reject incomplete or unsafe retained backups before export, offer source ZIP recovery, and normalize discussion restore projections without recursive event embedding. [Implementation and checks](history.md#review-repairs-november-5-2026).
- [x] **M7 remaining review findings.** Inspect serialized deleted/pending Yjs content before backup export/import; calculate causal heads independently so a clean explicit restore supersedes concurrent boundaries, and reject unresolved targets before advertising or planning recovery. [Checks and limits](history.md#remaining-review-findings-november-5-2026).
- [ ] **Integrated discussion recovery gate.** Architect review pending; the earlier partial-rerun evidence did not close this gate. The enabled real-comments/reviews case imports a complete backup offline into a clean profile and restores byte-exact source/assets, attached anchors, thread state, pending proposals and visible local authority in all three engines. Current restoration and backups of resolved threads are covered too. [Combined evidence and limits](integration-567.md).

Gate: restore an old version with deleted images and comments into a clean profile. A restore into an actively shared project is a new change; applying an old CRDT update is not a rewind operation.

## Milestone 8 scope

*Replanned November 5, 2026: the companion route is frozen (since discontinued, November 8, 2026), so browser-contained repositories and direct HTTP remotes become the starting point. An agent can still run Git itself in any real folder. Original text follows; the local-repository route resumes only if the companion does.*

Ship one Git interface with multiple transports. Start with the companion operating a normal local repository and pushing/pulling ordinary HTTPS or SSH remotes. Add browser-contained repositories and direct HTTP remotes where useful; a self-hostable CORS proxy is an optional bridge for incompatible hosts, not a mandatory central dependency.

Support clone/import, status, diff, stage/commit, fetch/pull/push, branch selection, conflict resolution, and remote configuration. Export an immutable project revision for each commit. Keep source/package locks separate from private device state; define whether comments and reviews are included before writing them to Git.

Checkout and merge use isolated working state before publication into a shared project. Git is an interoperability/history tool, not the per-keystroke collaboration transport. Defer LFS, submodules, advanced rebasing, and signing until the baseline works.

Gate: verify repositories using standard Git, test a real remote through the chosen transport, handle a divergent branch and binary conflict, and recover from an interrupted operation without losing current edits.

## Milestone 9 scope

*Replanned November 5, 2026: companion-watched exports are frozen (the companion was since discontinued, November 8, 2026), so Zotero starts with file import and Web API connections. This milestone extends the app; it is not how external agents reach the tab.*

Publish a versioned extension manifest and capability API: commands, import/export formats, sidebar panels, bibliography sources, diagnostics, and compiler adapters. Extension artifacts and their registry can be static. Installation includes version pinning, permissions, disable/remove, and rollback.

Prefer Rust/WASM extensions with explicit host imports. Use declarative UI or isolated UI frames; arbitrary same-origin JavaScript receives too much authority to be the default plugin format. Plugin access to decrypted source and outbound network destinations is explicit.

Zotero ships in increasing depth: BibTeX/BibLaTeX file import; companion-watched Better BibTeX exports; library selection and refresh through supported Web/local API connections. Preserve stable citation keys and local changes. Test metadata and attachment access separately; one successful API call does not establish that every endpoint works directly from the browser.

Gate: a denied plugin cannot read unrelated projects, access credentials, or contact arbitrary hosts. Zotero refresh is repeatable and offers a diff before conflicting changes are applied.

## Milestones 10 and 11 scope

*[Milestone D](#milestone-d-direct-browser-sessions) designs the replication layer and envelope these milestones share. D does not satisfy them: only a service gives durability, catch-up without overlap and reliability on isolated networks. Invites, membership, awareness and acknowledgements should be shared.*

Build remote connection management, pairing/invites, memberships, roles, reconnect/catch-up, awareness, durable acknowledgements, quotas, deletion, and complete export. Display **Saved on this device** separately from **Backed up remotely**. Keep the self-hosted deployment small enough for one Rust service plus a database and blob directory/object store.

The target server stores opaque updates and blobs. Authorized clients merge text, validate operations, and produce checkpoints. Milestone 10 validates transport and service behavior in a limited beta; public claims of encrypted storage wait for milestone 11. Do not market the existing plaintext sync demo as production sharing or end-to-end encryption.

Milestone 11 delivers device keys, per-project encryption, authenticated membership, encrypted attachments/history, secure invitations, key rotation, recovery, revocation, and lost-device handling. Define what metadata remains visible. Remote compilation and external integrations are separate trust decisions because their execution endpoints may need plaintext.

Gate: recover from a fresh device, add and revoke a collaborator, reconcile long-offline edits, reject tampering/replays, test compaction with stale clients, and verify that stored remote objects reveal no document content. Commission independent review before making strong public security promises. TLS alone does not satisfy this milestone.

## Milestone 12 scope

Ship a static, accessible product website with demos, screenshots, documentation, self-hosting guides, downloads, changelog, feature parity, and clear privacy/hosting descriptions. Generate crawlable HTML at build time. Keep the app's storage origin stable when changing the marketing website.

Paid hosting adds account, billing, metering, and operations endpoints as part of the hosted service. It runs the same connection and sync service that anyone can self-host, for people who would rather not run it themselves; choosing it is explicit, and the endpoint stays configurable. No runtime license checks or paid-only product features enter the self-hosted client or server. Maintain install/upgrade/backup/restore instructions for the same released versions.

Gate: someone can deploy the static app independently, add the remote service only when wanted (the companion is discontinued), and restore/export their data without the managed platform.

## Suggested additions and deferrals

Include a small template library, citation insertion, crash recovery, environment locking, and accessible PDF navigation in the relevant early milestones. Add reproducible build/source artifacts and package provenance to the release process throughout.

Evaluate native local compilation before offering a hosted compiler: it solves unsupported tooling while keeping source on the user's machine. WebRTC peer sessions needed a measured reason to prefer them over the relay design. The reason found is no server and no internet, on permissive networks only; reliability still favours the relay. See [milestone D](#milestone-d-direct-browser-sessions). Consider project-wide LaTeX language services once the file and command model is stable.

Defer rich-text LaTeX editing, built-in AI authoring, a complete editor/PDF/TeX rewrite, arbitrary native plugins, and a slide designer. Each creates a separate product or compatibility burden and is not required by the requested roadmap.

## First implementation slice

Start milestone 1 with the Rust project/tree model, explicit folder nodes, migration of existing projects, an accessible tree, and image preview/replacement. Establish the command boundary and blob references alongside it. Then complete the basic editor/PDF loop before moving to the downloadable TeX repository. Keep the existing compiler and editor behind adapters while these changes land.

## Delivery record

Rows retain the evidence and limits at each delivery. Later integration rows supersede earlier branch-only gate caveats.

Status and evidence for each goal, retained from earlier roadmap versions.

Milestone T's completed instrumentation and retained browser/native/CI evidence remain valid. Native exporter overhead, continuous managed HTTPS/CI publication and the operational acceptance matrix remain pending; see the delivery rows below. Folder synchronization remains paused and incomplete; do not continue it automatically. Its companion-based parts are parked. The private presentation → pipeline-built app release was verified in GitLab pipeline 3028249673 and deployed release web-47; both custom domains are registered, with DNS verification still pending at the last check. The workspace, pinned LuaLaTeX delivery and both MCP directions have passed their gates.

| Goal | Status | Acceptance evidence |
| --- | --- | --- |
| 1e.3b. Combined UI review corrections | Complete; architect review pending | Menu revision guards, stale-select refusal, individual atomic Reviewing replacements and successful-focus retries. `npm test`: 162 Rust / 1,109 JS-WASM pass, 0 fail (2 existing ignores / 6 optional private-stack skips); fixtures and two production builds pass. Requested tree/menus/editor-search/review-workspace/review-editor/history/accessibility: 108/108 per engine, 324/324 total, 0 fail/skip. Narrow Versions repeats: 10/10 per engine, 30/30 total; restored old focus behavior fails as expected. Includes 32 new randomized replace-all seeds. Corrected the stale schema-7 expectation to schema 8, retaining exact recovery checks. Earlier assertion/harness failures and interrupted runs are [recorded](ui-review-fixes.md). Linux/software-WebKit; full browser suite left to architect. |
| 1e.3a. Editor find/replace theme | Complete; architect review pending | Fixtures once and 6 production builds pass. `npm test`: 161 Rust / 1,062 JS-WASM pass, 0 fail (2 ignored subprocess fixtures / 6 private telemetry-stack skips). Required editor-search/editor/accessibility/review-workspace: 40 passing cases per engine, 120 distinct cases, no browser skips; includes 27 new search checks. Full run: 96 pass / 24 connection refusals after preview SIGTERM; restarted preview and WebKit rerun: 40/40. Focused Chromium: 9/9; earlier development attempts: 8 failures and 4 interrupted runs. Baseline/final light/dark, no-results, Reviewing and narrow screenshots inspected locally. Counts cap at 10,000; existing single-selection policy retained. Reviewing axe scopes search controls/matches: an extra full-page probe found existing deleted-text contrast of 4.35:1 and Review-toggle naming failures outside this change. Linux/software-rendered WebKit; no real assistive-technology claim. |
| D. Experimental direct browser sessions | D1/D2/D4 delivered; D3 real-network measurement partly done ([one home network](direct-sessions-design.md#real-two-machine-trial-november-9-2026)); D5 open | Fixtures once, 9 production builds; `npm test` 161 Rust / 1,069 JS-WASM pass, 0 fail (2 existing ignores / 6 optional-service skips). Final replication/local-tabs 22/22 incl. 64 randomized five-replica schedules. Required reviews/comments/local-tabs/editor: 292 pass / 2 existing skips; final direct: 21 pass / 6 intentional skips, plus 9 service-rejoin/tamper/replay and 1 agent-label passes. Earlier 13 browser failures and 2 pre-WASM module-import failures retained in [commands, measurements and limits](direct-sessions-design.md#delivery-commands-and-evidence-7-november-2026). Six mixed-engine links chose Chromium offers and passed locally; no real-network/device/sleep evidence or shipping claim. Second adversarial review: `npm test` 161 Rust / 1,087 JS-WASM pass, 0 fail; browsers 354 pass, 0 fail, 15 recorded skips across three engines; [findings, limits and results](direct-sessions-design.md#second-adversarial-review-november-7-2026). Real-network trial script ready, not yet run on the two machines. Merged with schema-8 `main`: browsers 507 pass, 0 fail, 18 recorded skips; Pages four specs 12/12; [merge notes](direct-sessions-design.md#merge-with-main-at-schema-8-november-7-2026). Merged with `main` at `a6cf985` (two-tab fixes kept from main and proven for peers; Reload asks before leaving a live session; off means off unchanged): `npm test` 169 Rust / 1,180 JS-WASM pass, 0 fail; full browser suite Chromium 444/0/9, Firefox 437/0/16, WebKit 428/0/25 (pass/fail/skip); Pages 13/13; [merge notes](direct-sessions-design.md#merge-with-main-two-tab-fixes-companion-retirement-update-notice-november-9-2026). |
| 5. Device-local comment draft recovery | Complete; architect review pending | Fixtures once and four production builds pass; final comments unit tests 33/33 (two completed runs). Required comments/review-workspace/review-editor/editor: 90/90 per engine, 270/270 total, 0 failures/skips; 69 new regression executions. Earlier attempts: 112 browser passes, one outdated status assertion failure and two interruptions; two unit starts failed before WASM generation. Updated the old status assertion while retaining a durable-save check. Bounded device preferences, orphan target protection and unchanged project bytes; Linux automation, native prompt chrome and full/native suites not claimed. [Exact commands and limits](comments.md#draft-recovery-verification). |
| Final combined review fixes | Implementation delivered; acceptance not passed | Durable review-input journal, ordered acceptance/survivor bindings, schema-7 migration/export-before-update and Viewing restore-as-copy. Final `npm test`: 161 Rust / 1,059 JS-WASM pass, 0 fail (2 existing ignores / 6 optional-service skips); production and Pages builds pass. One uninterrupted 906-case browser run: 867 pass / 7 fail / 32 existing skips (Chromium 290/2/10, Firefox 289/2/11, WebKit 288/3/11); all 21 requested regressions pass. Missing pinned IEEEtran and Alloy account for 6 failures; WebKit local WebRTC accounts for 1. Final run blocks external HTTP; earlier attempts made upstream package requests, recorded as a constraint violation. No shipping claim; checkboxes unchanged. [Commands, failures and limits](reviews.md#final-review-fixes--november-7-2026). |
| Review input corrections | Acceptance passed; architect sign-off pending | Fresh post-disk-exhaustion rerun: `npm test` 158 Rust / 995 JS-WASM pass, 0 fail (2 existing ignores / 6 optional-service skips); fixtures and production build pass. Required seven browser specs: 95/95 in each engine, 285/285 total, no skips. Old `4b70ddf` input layer fails 30/54 boundary cases; final layer passes 54/54. First fresh run exposed rank-rounding (993 JS pass / 1 fail); deterministic regression failed before exact Rust JSON parsing, then focused checks passed 23/23. Linux engines only; retained drafts remain device-local and older readers reject the optional order field. Checkboxes unchanged. [Commands, failures and limits](reviews.md#review-input-corrections-november-6-2026). |
| R6a. Scheduled field-test start follow-up | Complete; real R6 gate open | Final page: 48/48 delayed connections + 20 MiB acknowledgments (four pairings, 0/30/180 s, two A modes, open LAN and multicast-blocked typed fallback); skew 98/112 connect + transfer, 14 connection failures; 105/105 Firefox/Chromium/WebKit UI checks, 1/1 typed-wait smoke, verifier and hashes pass. Four window-extension probes fail as retained alternatives. No reliable nonzero symmetric skew tolerance; A must convey the exact boundary to B. Synthetic Linux, Firefox raw preference, no Firefox 151/real-network claim. [Evidence and limits](reorientation/r1-collaboration.md#r6a-follow-up--scheduled-starts-and-clock-diagnosis). |
| F. Reserve collaboration schema and feature boundaries | Complete; feature stubs only | Final `npm test`: 137 Rust / 219 JS pass, 0 fail (2 ignored subprocess fixtures / 6 optional-service skips); production build passes. Required six browser specs plus foundation: Chromium 34 pass, Firefox 33 pass / 1 platform skip, WebKit 33 pass / 1 platform skip. Includes 42/42 foundation browser checks: schemas 1–5, exact recovery bytes/locks/assets, injected quota rollback, blocked upgrade, stale writers, guarded commits, internal v2 and annotation/PDF separation. No visible feature or public API; synthetic fixtures and Linux engines only. [Commands, prior failures, timings and limits](foundation-f.md). |
| F. Reserve collaboration schema and feature boundaries | Complete; feature stubs only | Final `npm test`: 137 Rust / 219 JS pass, 0 fail (2 ignored tests / 6 optional-service skips); production build passes. Required six browser specs plus foundation: Chromium 34 pass, Firefox 33 pass / 1 platform skip, WebKit 33 pass / 1 platform skip. Includes 42/42 foundation browser checks: schemas 1–5, exact recovery bytes/locks/assets, injected quota rollback, blocked upgrade, stale writers, guarded commits, internal v2 and annotation/PDF separation. No visible feature or public API; synthetic fixtures and Linux engines only. [Commands, prior failures, timings and limits](foundation-f.md). |
| F. Review corrections to `5d27827` | Complete; feature gates unchanged | `npm test`: 137 Rust / 238 JS pass, 0 fail (2 Rust ignores / 6 optional-service skips); production build passes. Requested foundation/commands/storage/storage-upgrade/editor/runtime specs: Chromium 42, Firefox 42, WebKit 42 pass; 126 total, 0 fail/skip. Includes 57 new browser regression executions for buffer ownership, gateway-backed durable handlers and isolated build destinations. Injected quota faults, controlled compiler contention, Linux engines only; no preview UI claim. [Exact commands, initial failures and limits](foundation-f.md#review-corrections-to-5d27827). |
| F. Second review corrections to `adf7ad0` / `893a98f` | Complete; feature gates unchanged | `npm test`: 137 Rust / 242 JS pass, 0 fail (2 Rust ignores / 6 optional-service skips); production build passes. Requested foundation/commands/storage/storage-upgrade/editor/runtime specs: 48 pass per engine, 144 total, 0 fail/skip. Includes 18 new regression executions for post-guard typing and boundary receipts, never-settling closed hosts with transaction termination, and pending auto-compile through actual main-module scheduling. Real IndexedDB; controlled compiler timing and injected quota faults; Linux engines only. [Exact commands, prior failures and limits](foundation-f.md#second-review-corrections-to-adf7ad0-and-893a98f). |
| 5. Comment review corrections | Complete | `npm test`: 141 Rust / 266 JS pass, 0 fail (2 existing ignores / 6 optional-service skips); fixtures and production build pass. Required comments/editor/local-tabs: Chromium 33, Firefox 32, WebKit 32 pass; 97 total, 0 final failures / 2 existing platform skips, including 66 comments executions and 18 new browser regressions. Focused comments: 29/29 final. Earlier 2 unit failures and 1 WebKit trace-teardown failure are retained in [commands and evidence](comments.md#review-corrections-verification). Synthetic Linux projects; synchronous undo preflight copies the document; existing incorrect bindings need explicit reattachment. |
| 5. Cleared-edit navigation correction | Complete | Fixtures and production build pass; comment unit tests 29/29. Final comments/editor: Chromium 31, Firefox 31, WebKit 31 pass (93/93, 0 skips). Earlier WebKit runs: 30 pass / 1 point-comment failure each, twice; added a focus-handoff assertion without removing existing assertions, then full WebKit 31/31 and focused checks 3/3. All browser runs: 156 pass / 2 earlier failures. [Exact commands and limits](comments.md#cleared-edit-navigation-verification). Linux synthetic coverage; disconnected-peer witness ancestry remains detached with manual reattachment and must be revisited in D; full/native suites not rerun. |
| R6a. Field-test human-delay repair | Complete; real R6 gate open | Original-page matrix: 42/48 connect and transfer, 6 fail. Final page: 96/96 connection + 20 MiB trials across four pairings, six delays, two A candidate modes, open LAN and multicast-blocked typed fallback; 28/28 UI checks and one portable-harness smoke pass. Rejected alternatives/orders and harness setup failures retained. Linux Firefox 157/Chromium 156 only; Firefox raw mode uses a preference as well as fake capture. No real-network or Firefox 151 diagnosis, WebKit or app-suite claim. [Evidence and limits](reorientation/r1-collaboration.md#addendum--human-reply-delay-2026-11-05). |
| R. Reorientation | Current, direction recorded | [Decision record](reorientation.md): browser storage is the source of truth, Option 1 is the default, a command API is the structured route, WebMCP is deferred, and the companion and `scribyra-folders` are frozen. The real-tab test and later experiments remain. [Tasks and decision gate](#milestone-r-reorientation). |
| R5. Remote-agent experiment preparation | Preparation delivered; real trial open | Consent-gated, bounded `#tex=` scratch entry, tested gzip/base64url helper, existing compact agent results/PDF downloads and recipe within 2,000 bytes. `npm test`: 138 Rust / 259 JS pass, 0 fail (2 ignored / 6 optional-service skips); production build passes. Chromium/Firefox/WebKit: 8 pass each, 24 total (15 new link checks + 9 recipe regressions), 0 fail/skip; covers offline, existing-project preservation, hostile input and fragment privacy. Standalone helper/decoder runs 6/6 plus CLI round-trip 1/1. Linux scripted checks only; no model, deployment, real-profile or real remote-agent trial. R5 stays unticked. [Exact commands, evidence and limits](reorientation/r5.md). |
| R5a. TeX link review fixes | Complete | Trusted-event approval, inherited document provenance and memory-only staging until acceptance, including recovery and failed-save retry. `npm test`: 138 Rust / 260 JS pass, 0 fail; 2 Rust ignored and 6 optional-service skips. Five production builds pass. Final link/recipe acceptance: 11/11 per engine, 33 total, 0 fail/skip; includes five unapproved visits with every project database store empty. Additional focused/storage/intermediate checks: 13 Chromium and 12 JS passes. Linux scripted checks only; no real remote trial or Safari-on-Mac claim. R5 remains open. [Commands and limits](reorientation/r5.md#review-follow-up-r5a). |
| A1–A2. Diagnostics and agent-addressable tab | Complete | Bounded Rust file attribution/warning counts, source-line labels, stable Compile/separate Cancel, named status/log controls, issue source links and project titles. Final `npm test`: 134 Rust / 195 JavaScript pass (2 ignored / 5 skipped); production build passes. Chromium/Firefox/WebKit: 226 broad, 15 focused and 3 local Pages passes (244 executions, 238 distinct cases); 8 platform and 15 optional-service skips. Scoped S1–S7 bytes measured before/after; no model/token or real-profile attachment claim. Source virtualization and unavailable log locations remain explicit. [Exact commands, measurements, failures and limits](reorientation/a1-a2.md). |
| A3. Agent recipe and contract | Complete; real trials remain | Base-aware, offline-precached Markdown and head discovery; recipe-derived selectors/state literals, scoped snapshot budgets and local CDP trial setup. `npm test`: 134 Rust / 195 JavaScript passes (2 ignored / 6 skipped); production and Pages builds pass. Final browsers: 33 passes across Chromium/Firefox/WebKit (24 local Pages + 9 root recipe); setup smoke 1 pass. Recipe 1,476 bytes / 369 estimated tokens (chars/4); head 60/64 bytes, snapshot delta 0. Three earlier browser failures corrected; no model or human-profile trial. CI selects both agent specs in Chromium only. [Exact commands, measurements, corrections and limits](reorientation/a3.md). |
| A5. Experimental shared agent commands | Complete; R4/public-contract gate open | `npm test`: 138 Rust / 250 JS pass, 0 fail (2 ignored / 6 optional-service skips); production build passes. Required agent-recipe/agent-surface/commands/companion specs: 13 pass per engine, 39 total, 0 fail/skip. Includes offline warm edits/compiles, stale revision rejection, unrendered thesis reads, isolated undo, cancellation/revocation and the unchanged companion trace assertion. S1–S7 measured on three fixtures: 4,503 / 3,882 / 4,311 semantic-result bytes, with intermediate polling and discovery reported separately; largest scenario receipt 1,111 bytes, largest discovery page 6,539. Linux scripted browsers, no new model/token/R4 claim. Earlier failures and the shared trace-context correction are retained. [Exact commands and limits](reorientation/a5.md). |
| A5a. Trial-driven command compaction | Complete; R4/model-cost gates open | `npm test`: 138 Rust / 253 JS pass, 0 fail (2 ignored / 6 optional-service skips); build and formatting pass. Required four browser specs: 13 per engine, 39 total, 0 fail/skip. Scripted rerun: 25 rows, 6/6 expected compile outcomes; describe 613 pretty characters, recipe 1,987 bytes, thesis discovery 1,305 pretty characters; S1–S7 minified bytes 3,347 / 2,726 / 3,155 with all intermediate polls separate. Reviewed two existing real-agent traces; no new model/token/R4 claim. [Evidence, exact commands and limits](reorientation/a5.md#trial-driven-follow-up). |
| A5b. Agent review fixes | Complete; R4/public-contract gate open | `npm test`: 138 Rust / 256 JS pass, 0 fail (2 ignored / 6 optional-service skips); focused agent regressions 13/13, production build and formatting pass. Required four browser specs: 14 per engine, 42 total, 0 fail/skip, with unchanged size budgets. Regressions cover stale diagnostic pages, a 5,000-call bounded poll storm/shared timer, early timer delivery and quota-failed close recovery. Frozen companion revocation/trace checks retained. Earlier timer and companion failures are recorded; Linux scripted checks only, no new model/R4 claim. [Exact commands and limits](reorientation/a5.md#review-fixes). |
| 1a. Tree and asset baseline | Complete | Rust validation, migration recovery, folders/assets; 27 browser and 21 unit tests passed. |
| 1b. Durable local project foundation | Complete | Atomic journal/checkpoints, merge-safe saves and deletion markers. 19 JavaScript tests and 24 browser checks passed across Chromium/Firefox/WebKit, including offline compilation and failed-write recovery. |
| 1c. Stable parent-based tree | Complete | Schema-v3 Rust graph, independent conflict repair and journaled migration. 35 unit tests and all 36 browser tests passed. Original user ZIP validated locally: 75 files, 18 folders, no conflicts. |
| 1d. Immutable asset storage | Complete | Schema-v4 assets use shared Rust SHA-256 and atomic deduplicated storage/history. 10 Rust and 31 JavaScript unit tests, the Rust/Yjs sync integration test, and all 39 browser tests passed. Original user ZIP: all 75 files (21 binary) survived save/reload/export byte for byte. |
| 1e.1. Complete file workflows | Complete | Independent subtree duplication, folder imports and drag/drop, atomic failures, empty directories and Unicode paths. Production build, 22 targeted unit tests and 18 Chromium/Firefox/WebKit browser checks passed; virtual-file drops have a WebKit regression test. |
| 1e.2. Review file references | Complete | Shared Rust literal-reference review, stale-plan rejection, figure cursor insertion and project-scoped auxiliary writes. Fresh-wrapper reproducibility, 12 Rust and 45 JavaScript tests, and all 51 browser tests passed, including nested-main compilation, denied external writes, Lua font caches and offline restart. |
| 1e.3. Editor workspace | Complete | Persistent tabs/preferences, relative cursor restoration, Rust search/outline workers, reviewed atomic replacements with batch undo, settings and keyboard navigation. Production build, 13 Rust and 49 JavaScript tests, 51 browser regression checks and 9 focused editor rechecks passed across Chromium/Firefox/WebKit, including offline analysis. |
| 1e.4.1. PDF reading workspace | Complete | PDF.js text selection, links, page/search controls, preserved zoom/position, resizing, keyboard access and bounded canvases. Production build; 6 PDF acceptance tests, 9 editor regressions and 3 multi-engine/offline compilation matrices passed across Chromium/Firefox/WebKit. |
| 1e.4.2. Source/PDF navigation | Complete | Memory-only Rust/WASM SyncTeX queries, line-level forward/inverse controls, nested Unicode sources and compiled-revision guards. Production build, 17 Rust and 51 JavaScript tests, 92 upstream native tests plus its doctest, 9 PDF/navigation browser checks and final controls rechecks passed across Chromium/Firefox/WebKit. The 100-page fixture query also returned the correct final page. |
| 1f. Workspace integration gate | Complete | Versioned command/transport contracts and encryption/auth boundaries; real native input in all three browser engines, keyboard/semantic checks and multi-folder compile/recovery acceptance. Detailed evidence below. |
| 1f.1. Shared project commands | Complete | Rust command schema, scoped grants, revision/replay guards, atomic source edits and UI routing. The final checkpoint was rebuilt and verified alongside the LuaLaTeX/package slice: 22 Rust and 62 JavaScript checks plus command/browser scenarios across Chromium, Firefox and WebKit. Additional workspace integration evidence is recorded below. |
| 1f.2. Runtime and transport contracts | Complete | Scoped build IDs/revisions and cancellation through PDF preparation; previous preview/download rollback; Rust/WASM v1 incoming exchange validation with independent command, plaintext-replication and opaque-storage grants. 25 Rust / 64 JavaScript checks, production build and targeted Chromium/Firefox/WebKit runtime/PDF/navigation checks pass; page-input draft race fixed and rechecked. See [acceptance and boundaries](exchange.md). Active authenticated/encrypted transports remain later milestones. |
| 1f.3. Workspace acceptance | Complete | Native Chromium, Gecko and Linux WPE composition, durable Unicode round-trips, keyboard/focus recovery, light/dark semantic and contrast audits, and combined image/citation/error/offline compilation. 25 Rust / 64 JavaScript checks; all 63 applicable browser scenarios pass across the matrix and targeted rechecks. [Evidence and platform boundaries](workspace-acceptance.md). |
| 2. Downloadable TeX packages (first slice) | Complete | LuaLaTeX-only UI/commands, upstream catalog with verified repackagings, Rust archive verification, browser downloads/cache/retry and visible package receipts. New package/IEEEtran acceptance checks pass in Chromium/Firefox/WebKit; the final Romanian offline recheck passes. Private IEEE ZIP compiles unchanged to 5 pages. See [scope, limitations and validation](tex-packages.md), including the 81 browser scenarios across runs and one initial PDF navigation timing failure that passed on rerun. |
| 2. Expanded TeX component delivery | Complete | Smaller baseline, static file/font/tool delivery, resumable downloads, verified metadata/archives, locks and portable offline preparation pass the supported LuaLaTeX gate. Engine/format pins and frozen-catalog verification close the final audit. [Acceptance and retained boundaries](tex-packages.md#pinned-compiler-format-and-delivery-acceptance). |
| 2a. Environment locks and portable supplemental packages | Complete | Shared Rust lock/runtime validation and bounded bundle verification, revision-checked project locks, locked builds from a fresh baseline, full warm-worker receipts, cache inspection/removal, progress/cancellation and atomic archive import/export. 27 Rust / 70 JavaScript tests pass; 43 broader browser regressions and 24 final lock/migration/storage checks pass across Chromium/Firefox/WebKit. Private IEEE paper locks and recompiles offline unchanged (5 pages). [Scope and validation](tex-packages.md). Goal 2b adds full runtime preparation and lean delivery; resumable downloads remain in 2c. |
| 2b. Smaller LuaLaTeX baseline and complete runtime preparation | Complete | Native Rust builds a 43.53 MiB baseline (86.6% reduction), 2,276 immutable components and a font-family index. Verified compiler/Biber preparation, offline inspection/repair and cache clearing pass. 32 Rust / 79 JavaScript tests, 55 broader browser cases and 12 final Chromium/Firefox/WebKit rechecks pass. Private IEEE ZIP compiles online/offline unchanged to 5 pages; all 53 files export byte-exactly. Corrected thesis still compiles to 36 pages. [Scope, sizes and validation](tex-packages.md#smaller-lualatex-baseline-and-static-components-goal-2b). |
| 2c. Expanded delivery gate | Complete | Sharded metadata, resumable transfers, cache limits, language/font/tool diagnostics, compiler/format pins, offline portability and measured transfer/process-memory evidence satisfy the supported release gate. |
| 2c.1. Sharded metadata and offline portability | Complete | Startup metadata falls from 2,518,077 to 105,307 bytes (95.8%). Rust builds 512 immutable shards and resolves incrementally. Metadata-bearing bundles verify the full root/shard/archive chain in Rust and import atomically, including quota/eviction rollback. 36 Rust / 88 JavaScript checks pass; 48 broader browser cases and 18 final Chromium/Firefox/WebKit rechecks pass. Cleared-cache offline bundle imports compile a new project; private IEEE sources remain byte-exact and compile online/offline. [Scope and evidence](tex-packages.md#sharded-metadata-and-offline-portability-goal-2c1). |
| 2c.2. Resumable transfers and cache limits | Complete | Bounded public checkpoints for runtime, metadata and archives; exact range/full-hash verification; Rust cache policy, configurable budgets and header-based inventories; reload-safe cancellation. 38 Rust / 105 JavaScript checks and 21 final Chromium/Firefox/WebKit scenarios pass, following 137 broader passes. Both private-paper acceptance checks pass; IEEE sources remain byte-exact and compile online/offline to 5 pages. [Scope, evidence and transport performance boundary](tex-packages.md#resumable-transfers-and-cache-limits-goal-2c2). |
| 2c.3. Component compatibility and measurements | Complete | Real multilingual/font/Biber/override and format-version cases pass. Actual payload/process-memory measurements, HTTP/2 recovery, qualified WPE HTTP/1 throughput and separate preparation/execution limits are recorded. |
| 2c.3a. Compatibility and actionable diagnostics | Complete | Fourteen verified optional language/support archives, explicit prerequisite validation, project package/font precedence, shared Rust reports, distinct timeout/resolution failures and nested Biber paths. Production build and fresh-wrapper/idempotence check pass; 45 Rust / 111 JavaScript tests, 45 Chromium/Firefox/WebKit scenarios and two private-paper checks pass. Unchanged IEEE ZIP compiles online/offline to 5 pages; all 53 files export byte for byte. [Scope and validation](tex-packages.md#compatibility-and-actionable-diagnostics-goal-2c3a). |
| 2c.3b. Transfer, memory and expanded delivery acceptance | Complete | 27 measured trials include nine server-enforced offline reload/compiles; cold compiler payload falls 79.2%. Declared dependencies match all 4,218 runtime pins. LuaHBTeX/format identities, frozen catalog checks and strict version policy close the audit. Final build/wrapper checks, 49 Rust / 119 JavaScript tests, 45 browser scenarios and two private-paper checks pass. Historical upstream HTTP re-fetch remains unavailable; retained-input builds work, and exact local-input refresh is supported. [Acceptance and boundaries](tex-packages.md#pinned-compiler-format-and-delivery-acceptance). |
| 3. Rust companion and MCP | Complete | Both directions pass: paired live-browser resources/tools, direct browser HTTP providers and configured native stdio providers. Real modern/legacy interoperability, grants, revisions, revocation, cancellation, process cleanup and all three browser engines satisfy the defined gate. [Server](exchange.md#optional-rust-companion-and-mcp-server) and [client evidence/limits](mcp-providers.md). |
| 3a. Paired Rust companion and MCP server | Complete | Live browser-backed resources/tools, mutual pairing proofs, scoped grants, revision/replay guards, cancellation and temporary export transfer. Official modern/legacy clients pass; production build, 50 Rust / 126 JavaScript checks, 30 browser cases and both private-paper checks pass. [Contract, limits and validation](exchange.md#optional-rust-companion-and-mcp-server). |
| 3b. MCP client and provider connections | Complete | Browser HTTP and Rust stdio clients, separate provider grants, reviewed source disclosure/tool calls, inert results, scoped cancellation/revocation and owned process cleanup. Production/release builds, 51 Rust / 132 JavaScript checks and 36 browser cases pass. [Setup, supported transports and validation](mcp-providers.md). |
| T. Telemetry, diagnostics, tests and Grafana | Deferred, incomplete | Correlated metrics/logs/traces, local debugging/support evidence, test/CI reporting and provisioned Grafana dashboards, with a fully self-hostable stack. Management access and direct synthetic ingestion/readback are verified; runtime instrumentation is verified; Alloy/collector deployment, dashboards and T4 acceptance remain required. [Resume checklist, scope and acceptance gate](#priority-milestone-t-telemetry-diagnostics-and-grafana). |
| T1. Telemetry contract and local diagnostics | Complete | Shared Rust/WASM v1 schema, 256-record/64-KiB buffer, explicit collection/export controls, correlated local timeline and exact-preview offline JSON export. Production build, 65 core Rust checks, 9 JavaScript/WASM checks and 2 Chromium scenarios pass, including a real failed compile, source exclusion and continued editing/saving. Firefox/WebKit, broader runtime coverage, centralized ingestion and measured overhead remain in T2–T4. [Contract, evidence and boundaries](telemetry.md). |
| T2. Runtime and service instrumentation | Complete | Browser/WASM workers, compile/package/cache/storage flows, MCP/companion and existing sync paths; typed failures, latency/size/resource evidence and cancellation/recovery correlation. |
| T2a. Browser, compiler workers, downloads and storage | Complete | Build identity and startup duration, actual correlated compiler/package worker observations, PDF preparation, command validation, durable save/migration/recovery outcomes, verified download/retry/cache evidence and memory-capacity measurements. Production build, 66 core Rust / 69 JavaScript checks and 4 Chromium scenarios across runs pass, including offline compile/PDF, actual engine cancellation/restart and failed compilation. [Coverage, measurement limits and retained work](telemetry.md#t2a-browser-compiler-workers-downloads-and-durable-storage). |
| T2b. Remaining runtime/service paths and correlation | Complete | Internal TeX/BibTeX/Biber invocation evidence, service-worker/metadata cache details and workspace workers; MCP/providers, optional companion/native sessions, existing local-tab/sync paths; real rejection/cancellation/restart correlation without resuming folder features. |
| T2b.1. Bounded worker and runtime-preparation observations | Complete | Individual TeX/BibTeX/index and actual Biber calls, search/outline/SyncTeX workers, metadata/cache/eviction details, client-bound service-worker preparation relay, bounded streaming and drop reports. Production build, 66 core Rust / 67 JavaScript checks and 7 Chromium scenarios across runs pass. [Coverage, evidence and boundaries](telemetry.md#t2b1-bounded-worker-and-runtime-preparation-observations). |
| T2b.2. Service/native observations | Complete | MCP/providers, companion/native sessions and existing local-tab/sync paths; authenticated trace negotiation, typed permission/rejection/cancellation outcomes and bounded optional native file export. Production build, 70 core / 32 folder / 2 sync Rust checks, 73 JavaScript checks and 20 Chromium scenarios pass. [Scope and evidence](telemetry.md#t2b2-service-and-native-observations). Folder features remain paused. |
| T2b.3. Implicit transfers and instrumentation verification | Complete | Startup and lazy Biber transfers with zero runtime-cache budget; actual loader bytes/checksum outcomes alongside bounded resource timing; initial cache-control readiness fix. Production build, 71 core / 79 JavaScript checks; resumption adds 18 passing browser cases and one platform-specific IME skip. A real native companion → browser → TeX worker trace passes in Chromium, Firefox and WebKit. [Evidence and measurement limits](telemetry.md#t2-resumption-and-instrumentation-verification). |
| T3. Self-hosted ingestion and Grafana | Deferred, partial delivery | Grafana Alloy/collector deployment, safe browser ingress, reproducible optional storage stack, provisioned data sources/dashboards, retention/budget/access settings, alert rules and verified application ingestion/readback. |
| T3a. Optional browser export, Rust privacy ingress and Alloy transport | Complete | Current-tab opt-in destination/token, bounded trace sampling/queue/retry/drop reporting, shared validated wire batches, authenticated Rust ingress, maintained OTLP protobuf mapping and pinned Alloy forwarding. Real compile/offline ingestion checks pass in all three browsers. Persistent storage, native exporters, Grafana and managed deployment remain required. [Transport scope and limits](telemetry.md#t3a-optional-browser-export-and-validated-alloy-ingress). |
| T3b. Storage, native export and Grafana deployment | Deferred, incomplete | Reproducible self-hosted backends, native export adapters, provisioned dashboards/alerts, retention/access controls, managed ingress and actual stored-query evidence. |
| T3b.1. Private self-hosted storage and persisted readback | Complete | Pinned Prometheus/Loki/Tempo, bounded Alloy forwarding, private single-node launcher and retention settings. Actual Chromium compile metrics/logs/correlated worker traces are queried before and after a full stack restart, with private-content checks. Grafana, native export and managed deployment remain open. [Evidence and limits](telemetry.md#t3b1-self-hosted-storage-and-persisted-readback). |
| T3b.2. Grafana views and evaluator integration | Complete | Pinned private Grafana OSS with versioned datasources, overview/health views and six alert rules. Real browser failure trace and normal-to-firing alert checks pass; real evaluator no-data/error probes pass. Private views are also deployed to the managed Grafana instance. Cloud ingestion/alerts, native export and remaining acceptance gates remain open. [Evidence](telemetry.md#t3b2-grafana-views-and-evaluator-integration). |
| T3b.3. Alloy Cloud application readback | Complete | Runtime-only collector credentials and bounded Cloud profile; real successful/failed compiles in Chromium, Firefox and WebKit queried through managed Grafana with exact worker correlation and privacy checks. Fixed-label ingress health is also ingested. This verifies the loopback browser route to Cloud; persistent managed HTTPS/DNS deployment and Cloud alert evaluation remain open. [Evidence](telemetry.md#t3b3-real-application-ingestion-through-alloy-into-cloud). |
| T3b.4. Native remote export | Complete | Default-off bounded Rust HTTP/TLS publisher, fixed status/drop/sampling reporting, private token files, finite retries and bounded DNS work. Native CLI/sync HTTPS checks pass; real native companion → browser → TeX worker export through Rust ingress/Alloy passes in all three browsers. Native retained-query evidence is verified by T4d; persistent managed deployment and remaining T4 gates stay open. [Evidence](telemetry.md#t3b4-bounded-native-remote-export). |
| T4. Test, CI and observability acceptance | Deferred, incomplete | T4a/T4b typed provenance, safe actual suite reporting, stored self-hosted/Cloud test views and private CI artifacts are implemented and locally verified. T4c source-aware first-failure alerts are deployed and evaluated in private self-hosted/Cloud Grafana, with managed notification routes configured dashboard-only. T4d retained native CLI/sync and MCP → browser → worker chains pass in both storage profiles and all three browsers, including collector-off/restart readback. T4e adds 27 browser overhead trials/108 compiles and verifies actual private GitLab jobs/deployed web-47. T4f verifies authenticated private CI artifacts, expiry policy and exact retained CI data in both profiles, including restart/collector-off readback and deployed log-panel queries. [Actual CI evidence](telemetry.md#t4f-authenticated-gitlab-artifacts-and-retained-ci-queries). T4g completes local native measurements and operational/fault/offline checks; persistent managed HTTPS/continuous CI activation, managed permissions/DNS and profiling/notification limits remain open. [Measured browser overhead and live release evidence](telemetry.md#t4e-browser-overhead-and-verified-private-release). [Evidence](telemetry.md#t4b-stored-test-run-views-and-ci-integration). Rust/JavaScript/browser suite results and regressions in Grafana, correlated synthetic failure scenarios, reproducible diagnostic exports, privacy/failure/overhead/offline checks and self-hosting instructions. |
| T4g. Local telemetry acceptance in parallel | Local work delivered; T incomplete | November 5: `npm test` 129 Rust / 194 JavaScript passes (2 ignored / 6 skipped); real-Alloy check 1 pass; private-stack Node 4 + targeted 20 passes; original-timer operational alert check 1 pass in 943 s. Browser storage 3/3, expanded run 26/27, then virtualized-log click fix 3/3 across all engines: all 30 distinct cases have passing final evidence. Restart readback passes for native/browser/test-run data without republishing. Final native measurement 9 trials / 540 HTTP operations / 16 accepted batches; two NixOS deployment profiles evaluated. [Exact commands, calibration failures and gate audit](telemetry-acceptance.md), [measurements and limits](telemetry-overhead.md#native-exporter-overhead), [credential-bound activation](telemetry-deployment.md). No deployment/push or external credentials; persistent HTTPS/direct CI, managed permissions/DNS, notification/profiling limits remain open. |
| 4. Local synchronization | 4a complete; 4b parked; 4c replaced if R6 passes | Live same-profile tabs first, then browser/native folders and paired local devices. External edits, rename/sleep/restart reconciliation and visible conflict recovery remain required. |
| 4a. Live browser tabs and local recovery | Complete | Committed heads, metadata-only wakeups/resume polling, source/assets, local undo and IME guards. Binary losses and deleted open copies have independent recovery projects; failed writes/upgrades remain atomic. Production build, 51 Rust / 144 JavaScript checks, 97 broader browser cases and 34 final rechecks pass. [Scope, counts and platform boundaries](local-sync.md). |
| 4b. Browser and Rust companion folder synchronization | Parked; requirements retained | Shared reconciliation and scoped native inspection first; explicit folder grants, portable watching/atomic writes, conflict-review UI, renames and restart/sleep recovery remain required. |
| 4b.1. Shared reconciliation and scoped inspection | Complete | Rust three-way text/tree/binary plans, native/WASM interoperability, stale/tampered review rejection and read-only native folder snapshots. Production build, 79 Rust / 147 JavaScript checks and 31 Chromium/Firefox/WebKit regressions pass (two CDP-only input skips). [Contract and boundaries](local-sync.md#folder-reconciliation-foundations). This does not complete folder sync. |
| 4b.2. Folder adapters and visible conflict recovery | Paused, partial delivery | Native scoped sessions persist baselines, retain reviewed versions and resume journaled writes, with Linux atomic replacement and separate project-save confirmation. Production build, 101 Rust / 149 JavaScript checks and 18 browser regressions pass; a private-paper copy passes native reconciliation. Companion grants/watchers, browser directory permissions and the live review/apply UI remain required. [Native transaction contract](local-sync.md#native-folder-sessions-and-recoverable-writes). |
| 4b.3. Folder synchronization acceptance | Queued | Real external concurrent edits and parent moves, preserved binary versions, revoked permissions, companion restart/sleep/resume and browser fallback coverage. This remains part of the original milestone-4 gate. |
| 4c. Paired local devices | Browser route moves to [D](#milestone-d-direct-browser-sessions) if R6 passes; hub frozen | Authenticated LAN or SSH/VPN-assisted connections using the shared project/replication contract, with disconnect/rejoin acceptance. |
| 5–11. Comments through encrypted collaboration | 5–7 complete; 8–11 queued, in the [order of work](#order-of-work) | Each milestone retains its scope and release gate; [5–7 integration evidence](integration-567.md). |
| 12. Release readiness | Queued | Private presentation already deployed; finish reproducible releases, self-hosting/upgrade/backup documentation and honest feature claims. |
| 5/6/7. Shared annotations and history design | Design complete; implementation queued | [Implementation contract](annotations-design.md): schema/migration, anchors, attributed reviews, retained history/backups, internal agent commands, prerequisite foundation and parallel file ownership. Code references read; final document is 486 lines. Two line-limit checks and one staged whitespace check pass; 0 product tests/builds/browser checks run (docs-only). Gates remain unproven; serialized review acceptance requires its designated authority, and real-device/encryption checks remain later milestones. |
| 6. Review-finding corrections | Delivered; M5 integration remains open | 141 Rust / 263 JS/WASM pass (2 ignored / 6 optional-service skips); build passes; explicit-fixture reviews 31/31 in Chromium, Firefox and WebKit; default production-panel checks 3/3. Initial frozen-folders lock failure passed isolated and full reruns. Production reviews remain disabled until M5 anchors land; no production proposal gate or Safari/macOS claim. [Exact commands, output and limits](reviews.md#review-finding-corrections-november-5-2026). |
| 7. History review repairs | Complete within review scope; discussion integration gate unproven | Replay/head equality and all retained-generation secret checks before export, source ZIP fallback through the existing command, immutable event references and shared Rust restore projection. Final checks: 145 native pass / 0 fail / 2 ignored; 280 JS/WASM pass / 0 fail / 6 optional-service skips; production build passed; history/storage/storage-upgrade passed 22/22 runnable per engine (66 pass, 0 fail, 3 named integration skips). One earlier WebKit status-refresh race failed, was fixed and passed the final matrix. A 30-cycle restore regression passes; frozen crates unchanged. [Exact commands, supplemental counts and limits](history.md#review-repairs-november-5-2026). |
| 7. Deleted-content and concurrent-restore review repairs | Complete within review scope; discussion integration gate unproven | Serialized Yjs checks cover retained updates and uncatalogued checkpoint objects; shared Rust causal heads permit explicit resolution, with target projection preflight. Final: 146 native / 308 JS/WASM pass, 0 fail, 2 existing ignores / 6 optional-service skips; production build passed; history/storage 23/23 runnable per engine (69 pass, 0 fail, 3 existing integration skips). Earlier shared-output browser attempts had 6 trace-teardown failures; isolated reruns passed. Frozen crates unchanged. Structural secret detection only; conflicted historical targets remain unavailable. [Exact commands, intermediate counts and limits](history.md#remaining-review-findings-november-5-2026). |
| 5. Integrated comments | Complete | 84/84 final comment cases across Chromium/Firefox/WebKit, with production anchors, Unicode/edit/move/delete/undo, peer reload, drafts, native input and accessibility. Cross-feature acceptance/restore checks pass too. The disconnected-peer witness limit remains explicit. Shared suite counts, earlier failures and [integration evidence](integration-567.md). |
| 6. Integrated reviews and proposed changes | Complete | 93/93 final production-anchor review cases across all three engines; no browser anchor fixture flag. Authority races, portable exchange, conflict-preserving undo and real isolated previews pass. All 12 distinct cross-feature/agent cases have passing evidence after one WebKit harness-loading correction (3/3 denied-rights rerun). Shared checks and [contract amendment/evidence](integration-567.md). |
| 7. Integrated restorable history | Complete | 66/66 final history cases across all three engines, including 3/3 formerly skipped real-discussion gates: clean-profile offline complete-backup import and byte-exact restoration with attached anchors, thread state, pending proposals and visible authority. Resolved-thread/current-restore and combined backup cases pass. Small synthetic backups, injected faults and Linux engines; [evidence and limits](integration-567.md). |
| 5/6/7. Combined regression acceptance | Historical; superseded by review corrections | Final units: 155 native pass / 2 ignored, 367 JS/WASM pass / 6 optional-service skips, 0 fail; production and local Pages builds pass. Complete browser runs: Chromium 213 pass / 7 fail / 8 skip, Firefox 215 / 4 / 9, WebKit 217 / 2 / 9. All 13 failed cases pass affected reruns; 658 distinct runnable cases now have passing evidence, 26 private-service/platform skips. Final collaboration 6/6, denied-rights 3/3 and Chromium/Firefox telemetry 10/10 reruns pass. Full matrices were not repeated after final test-harness corrections; full-tree formatting remains non-green, scoped core formatting passes. [Exact commands, attempts and limits](integration-567.md). |
| 5/6/7. Production-route integration review corrections | Complete | Rebased onto `main` with TeX-link consent preserved. `npm test`: 155 native / 371 JS/WASM pass, 0 fail, 2 existing native ignores / 6 optional-service skips; production build and local Pages preparation pass. Uninterrupted full browser runs: Chromium 237/0/8, Firefox 236/0/9, WebKit 236/0/9 (pass/fail/skip): **709 pass, 0 fail, 26 existing skips**, with no gate reruns; all nine new production regressions pass in each engine (27/27). Pre-fix eight failures and two corrected new-test mistakes remain recorded. Frozen crates unchanged; Linux synthetic/software-rendered WebKit, private-service and disconnected-peer limits remain. [Evidence and exact commands](integration-567.md#integration-review-corrections-november-6-2026). Architect decides Complete status. |
| 5/6/7. Second production integration review corrections | Complete | Stale replay refusal, verified source mutations, atomic redo bindings and trusted history authorship; deferred-focus race fixed. `npm test`: **155 native / 894 JS/WASM pass, 0 fail**, 2 existing ignores / 6 optional-service skips, including **512 seeded sequences / 12,288 steps** and 11 deterministic regressions. Production/local Pages builds pass. Final uninterrupted full matrix: Chromium **242/0/8**, Firefox **241/0/9**, WebKit **241/0/9** (pass/fail/skip): **724 pass, 0 fail, 26 existing skips**; all 39 production integration cases pass. Earlier interrupted runs, the fixed WebKit failure and harness errors are recorded. Frozen crates unchanged; small-model, Linux/software-WebKit, private-service and disconnected-peer limits remain. [Evidence and exact commands](integration-567.md#second-integration-review-corrections-november-6-2026). Architect decides Complete status. |
| 5/6/7. Third production integration review corrections | Complete | Trusted importer/retry sessions and original contributors; imported evidence excluded from history decisions; reproducible thread selection and expanded actor invariants. `npm test`: **156 native / 898 JS/WASM pass, 0 fail**, 2 existing ignores / 6 optional-service skips, including 512 seeds and an independent-UUID repeat check. Production/local Pages builds pass. One uninterrupted full matrix: Chromium **245/0/8**, Firefox **244/0/9**, WebKit **244/0/9** (pass/fail/skip): **733 pass, 0 fail, 26 existing skips**; all **48** production integration cases pass, including **9** new import/actual UI Retry cases. Development fixture and imported-evidence failures are recorded. Frozen crates unchanged; Linux/software-WebKit, synthetic quota, small-backup, private-service and disconnected-peer limits remain. [Exact commands and evidence](integration-567.md#third-integration-review-corrections-november-6-2026). Architect decides Complete status. |
| 5/6/7. Restore witness ownership repair | Complete | Surviving original intervals and quotes preserved through restore; copy/backup paths audited. Final `npm test`: **156 native / 902 JS/WASM pass, 0 fail**, 2 existing ignores / 6 optional-service skips, including 512 strengthened seeds plus repeat check. Fixtures/build pass; comments/history/reviews **85/85 per engine (255/255, no skips)**. Negative control fails as expected; focused checks 4/4 and stable metadata 7/7 pass. Initial unit failure from overlapping WASM builds is recorded; clean full rerun passes. Frozen crates unchanged. Linux/software-WebKit and small fixtures; no migration of previously rewritten bindings. Full matrix left to architect. [Commands and limits](integration-567.md#restore-witness-ownership-correction-november-6-2026). |
| A2a. Dismissible compile diagnostics regression | Complete | Status toggle, Close/Escape, 25dvh scrolling panel, final-pass actionable warnings and complete raw logs; fresh projects have zero warnings/no panel. `npm test`: 157 Rust / 902 JS pass, 0 fail (2 existing Rust ignores / 6 optional-service skips); fixtures and two production builds pass. Required agent-surface/agent-recipe/workspace/acceptance/runtime/accessibility: Chromium 23, Firefox 22, WebKit 22 pass; 67 total, 0 fail / 2 CDP-only skips in one run on port 5001. Initial formatter edition mismatch corrected. Recipe stays below 2,000 bytes; fixture diagnostics budget tightened to 4,000. Linux/software-WebKit, bounded log parsing; no real-tab/model/full-browser-suite claim. [Exact commands, corrected warning assertions and limits](reorientation/a1-a2.md#diagnostics-regression-follow-up). |
| S1–S4. Self-hostable opaque service | Delivered; architect review pending | Design committed first; authenticated Rust service, SQLite + fsynced blobs, bounded ephemeral relay, verified client, pinned Nix image definition and NixOS module. Broad `npm test`: 154 Rust / 915 JS pass, 0 fail (2 existing ignores / 6 optional-service skips); final service 12/12 and retained demo Rust 2/2 pass after isolated hardening. Build/fixtures pass; connection/security Chromium + Firefox 6/6, WebKit crypto 2/2, retained collaboration/commands 12/12 across all engines. Rebuilt release clean-directory install/reinstall/restore 9/9; three SIGKILL/restart cycles preserve acknowledged bytes. Packaging/module evaluated; container/NixOS boot and real networks untested. Initial folder-lock and Chromium-permission failures, interrupted offline Nix build and final-check scopes are recorded in [service evidence](service.md#delivery-evidence). No deployment or push; accounts, membership, project encryption and billing remain later work. |
| S5. Service capacity security fixes | Complete; deployment limits recorded | `npm test`: 156 Rust / 920 JS pass, 0 fail (2 existing ignores / 6 optional-service skips). Service regressions 16/16; release install/restore 9/9; verified self-signed TLS proxy 13/13; Chromium/Firefox 6/6 and WebKit crypto 2/2. Paused-download RSS growth 16.1/8.0 MiB, below 48 MiB bound. Default response budget 32 MiB; tenant upload/room/connection quotas. Image build failed on a pinned dependency hash; Docker/Podman absent. Linux synthetic checks, no real-network or container-run claim. [Commands, failures and limits](service.md#security-review-follow-up-6-november-2026). |
| S6. Second service security review and runtime deployment | Complete within reviewed scope | `npm test`: 156 Rust / 924 JS/WASM pass, 0 fail (2 existing ignores / 6 optional-service skips). Service 20/20, install/restore 9/9, verified TLS proxy 20/20; Chromium/Firefox 6/6 and WebKit crypto 2/2. Per-source pre-auth/anonymous and authenticated namespace request budgets, independent health, explicit proxy trust, pre-TLS connection/connections-per-second admission. Eight-second replenished partial-handshake probe: 8,144 attempts, observed peak 16 sockets, 30 successful health/download pairs from another IP. Online image build and original dependency-hash verification pass; rootless read-only image install/write/restart/read-back 7/7; NixOS module boots and passes under software QEMU (140.89 s). LXC has no `/dev/net/tun` or KVM: container used host loopback and disabled cgroups; published networking/resource enforcement, ARM, real networks and direct compiler bootstrap rebuild unverified. No push/deployment; [exact commands, failures and limits](service.md#second-security-review-and-runtime-deployment-6-november-2026). |
| T. First-run telemetry consent | Complete locally; followed by Faro delivery below | Nonblocking all-off card only in configured builds; Rust category projection, per-origin choices/refusal/reminder bounds, Diagnostics revocation and anonymous origin-checked bounded ingress. Final `npm test`: **163 native / 1,069 JS/WASM pass, 0 fail**, 2 existing ignores / 6 private-stack/CI skips. Fixtures once; six production builds and NixOS syntax parse pass; insecure endpoint build rejected as expected. Required seven-spec browser gate **135/135 (45 per engine)**; final lifecycle/consent recheck **39/39**, configured-card served recipe **9/9**, restored-default smoke **1/1**, no browser skips/failures. Initial interrupted runs recorded; existing tests unchanged. Twelve uncommitted 1366×768 light/dark screenshots; editor views inspected in all engines and card shortened. Linux/software-WebKit, mocked consent collector, no NixOS activation/hosted deployment/abuse-load claim; host/operator/origins/retention remain the owner’s decision. [Commands and evidence](telemetry.md#local-controls-and-evidence); [activation](telemetry-deployment.md#anonymous-browser-consent-ingestion). |
| T. Official Faro consent transport | Complete locally; live provider check remains | Official Pages Faro JSON, Rust consent/privacy projection, third-party wording and collection link; ordinary builds stay unconfigured, editor entry dismisses draft choices. Final `npm test`: **163 native / 1,074 JS/WASM pass, 0 fail**, 2 existing ignores / 6 optional-service skips. **144 distinct browser cases** have passing evidence: 81 unchanged bulk passes + final **63/63** (21 per engine); Pages **11/11**. Two ordinary + two Pages builds; fixtures once; focused Faro 5/5 twice, runtime identity 1/1, folders diagnostics 1/1; insecure HTTP build rejected. Initial failures and two updated consent-layout titles are documented. Limits: aggregate reruns, Linux/software-WebKit, optional-service skips, observed native concurrency flake; no live collector, private credentials, push or deployment. The owner retains provider retention/access/budget and consented live-record/readback review. [Commands, fields and evidence](telemetry.md#faro-validation-evidence-november-7-2026); [configuration](telemetry-deployment.md#official-pages-destination). |
| 5/6. Discussion on suggestions | Complete | Immutable suggestion-targeted threads, shared reply UI, resolved outcomes, recovery/exchange and attributed agent commands; schema 8 with tested schema-7 recovery migration. Fixtures and two production builds pass. Full units: **162 native / 1,073 JS/WASM pass**, 0 fail, 2 existing ignores / 6 optional-service skips, including 512 strengthened seeds. Final release discussion checks 59/59; required nine specs **189/189 per engine (567 pass, 0 fail, 0 skip)**; migration checks 18/18; four final screenshots inspected. Earlier composer defect fixed; intermittent WebKit history-focus failure passed unchanged repeats and full rerun; Firefox exit 143 superseded by clean full rerun. Linux/software-WebKit and device-local draft limits remain. [Exact commands, attempts and evidence](reviews.md#suggestion-discussion-verification). |
| 5/6. Suggestion discussion review fixes | Complete within review scope | Forged restore/cycle/exchange regressions, 512 strengthened seeds, incomplete cards and five-author light/dark marks. Final: **162 native / 1,077 JS/WASM pass**, 0 fail, 2 existing ignores / 6 optional service skips; build and fixtures pass; seven requested specs **183/183 per engine (549 pass, 0 fail, 0 skip)**. First WebKit run had one existing History focus failure; complete unchanged rerun passed. Six screenshots inspected; minimum deletion contrast **4.87:1 light / 5.76:1 dark**. Linux/software-WebKit, descriptive attribution and same-lineage merge limits remain; debug-WASM stress cost and all intermediate attempts are [recorded](reviews.md#suggestion-discussion-review-follow-up--november-7-2026). |

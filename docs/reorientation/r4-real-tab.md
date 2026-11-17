# R4: a real agent in a person's tab

November 17, 2026. Approved by the owner the same day, with a budget of about ten real agent runs. This is the first time a real Claude Code agent worked in a persistent browser profile that a person had already set up, with projects in IndexedDB and the tab left open by that person. It also contains a small A4 pilot. Harness, prompts and per-run summaries are in [`data/r4/`](data/r4/).

## Method

**Browser.** Chromium 156 (from the flake) ran headed under Xvfb on this host (the agent LXC, not the owner's laptop). It used a persistent `--user-data-dir` and `--remote-debugging-port=9622`, bound to 127.0.0.1. It was started once and stayed up for every run, so service workers, the TeX cache and IndexedDB carried over the way they do for a person.

**The person.** [`person-setup.mjs`](data/r4/person-setup.mjs) attached to that browser and acted the way a person would. It opened https://app.scribyra.com/, declined telemetry, started the sample paper, and imported `coastal-survey` (five files: `main.tex`, three `sections/*.tex`, `references.bib` with BibTeX) from a ZIP. Each project was compiled once. Between runs, [`person.mjs`](data/r4/person.mjs) did everything through the UI: opening projects, switching modes, typing, accepting suggestions and reading files back. The tab was always left where the run needed it.

**The agent.** Each run was `claude -p` (Claude Code 2.1.300, `--model sonnet`, which resolved to `claude-sonnet-5-5`), set up as follows ([`run.sh`](data/r4/run.sh)):
- **Browser tool:** `@playwright/mcp@0.0.84` through `npx` from the nixpkgs node, with `--cdp-endpoint http://127.0.0.1:9622`, so the agent drove the existing browser and tab.
- **Tools:** `--strict-mcp-config --tools "" --allowedTools 'mcp__playwright__*'`, so the agent had no shell, file or web tools.
- **Isolation:** `--setting-sources ""` and an empty working directory outside any repository. A check confirmed that no CLAUDE.md, memory or git status reached the model.
- **Limits:** `--max-turns 40 --max-budget-usd 1.50`.

The prompts are short and written the way a person would ask ([`prompts/`](data/r4/prompts/)). Except in the A4 arms, they never mention the API or `/agent.md`.

**Verification.** After each run the person checked the result through the UI. The checks were: reload, reopen the project from the dashboard (so the content came from IndexedDB), read each file back from the editor, compile, and look at the History author line.

## Results

Costs are the CLI's `total_cost_usd`. "Input" is all input tokens: uncached, cache-write and cache-read. Turns and tool calls come from the stream. Results above about 200,000 characters were screenshots, which are counted as images rather than text.

| Run | Case | Route | Outcome, checked from the person's side | Turns | Tool calls (errors) | Input tokens | Output | Cost | Wall |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| r1 | Happy path (A4 "no help") | UI | Correct: 12→14 in `sections/results.tex`, 2 pages, 0 warnings, survives reload | 17 | 16 (0) | 204,388 | 1,575 | $0.105 | 54 s |
| r2 | Introduced `\emhp` error | UI | Correct: named `sections/method.tex` line 6 from the diagnostics panel, fixed it, recompiled. **First `browser_type` replaced the whole file**; the agent undid it | 19 | 18 (0) | 232,395 | 2,107 | $0.090 | 41 s |
| r3 | Tab in Reviewing mode | UI | Edit became a suggestion; the agent left it for the person; **the person accepted it** and it compiled. Whole-file overwrite, undone. Suggestion credited to the person, not the agent | 24 | 23 (1) | 270,153 | 2,233 | $0.137 | 68 s |
| r4 | Person typing 14 lines in the same file during the run | UI | No lost edits: all 14 lines plus the sentence, once. Whole-file overwrite, undone. **Could not confirm the build** (see below) | 33 | 32 (3) | 305,070 | 3,130 | $0.152 | 132 s |
| r5 | Tab on the other project | UI | Correct: went to the dashboard, opened `coastal-survey`, changed the date, 2 pages; sample paper unchanged. Whole-file overwrite, undone | 34 | 33 (1) | 450,485 | 2,781 | $0.161 | 96 s |
| a4-link | r1 task + recipe URL | API | Correct; History shows "By Agent". Navigated the person's tab to `agent.md` and back | 9 | 8 (0) | 100,573 | 958 | $0.047 | 28 s |
| a4-thin | r1 task + "use window.scribyra.agent; see /agent.md" | API | Correct; read the recipe with `fetch`; History shows "By Agent" | 7 | 6 (0) | 86,693 | 890 | $0.036 | 27 s |
| f1 | r1 again, local build with an in-page pointer | UI | Correct. The agent **saw the pointer and ignored it on purpose** as page text it had not been asked to follow | 13 | 12 (2) | 185,629 | 1,715 | $0.081 | 68 s |
| f3 | Reviewing + thin instruction, local fixed build | API | Correct: `patchSource` returned a suggestion credited to "Agent"; the person accepted it in the review panel; History shows "By Local author, Agent" | 8 | 7 (0) | 96,828 | 1,053 | $0.047 | 34 s |

One more run, `a4-thin-invalid` ($0.044), is excluded because of a harness error: the person's reset had failed, so the change was already there. The agent correctly reported that it had nothing to do.

**Total: 10 runs, $0.899.** Three harness checks on Haiku cost a further $0.003. The A4 pilot has one valid run per arm.

### A4 pilot (same task, three conditions)

| Condition | Found the API | Tool calls | Input tokens | Cost | Wall | Incidents |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| No help (r1) | No | 16 | 204,388 | $0.105 | 54 s | None in this run (4 of the 6 no-help runs overwrote a whole file) |
| Link to `/agent.md` | Yes, by navigating the tab | 8 | 100,573 | $0.047 | 28 s | Left the person's page and came back |
| Thin instruction | Yes, by `fetch` | 6 | 86,693 | $0.036 | 27 s | None |

With help, the agent used about half the tokens, a third to a half of the cost and half the time. Its edit was revision-checked and credited to the agent. A link alone was almost as good as the thin instruction, but it led the agent to navigate the person's tab. These are single runs, so this is a direction, not a measurement of variance.

## Failure modes

1. **No agent found the API by itself, in 6 of 6 runs.** The `<link rel="alternate">` in the head never reaches an accessibility snapshot, and no agent looked for it. They all fell back to UI automation, which worked but cost more.
2. **`browser_type` on the editor replaced the whole file in 4 of 6 no-help runs** (r2, r3, r4, r5). Each time the agent noticed, pressed Ctrl+Z, and checked the result. No data was lost, but in r4 this happened while the person was typing in the same file. `agent.md` already warns against this, but nobody read it.
3. **UI-route edits are credited to the person.** History said "Local author" for r1–r5, and the r3 suggestion was the person's. Agent attribution, revision checks and isolated undo only apply on the API route.
4. **Compiling while the person types gives no PDF.** The app compiled successfully, but because the source had changed during the build it showed "Compiled · pages unavailable · source changed, compile again" and no preview. The agent in r4 could not confirm a page count and said so. This is deliberate in `web/main.js` (an out-of-date PDF is not shown), so it is not changed here. Whether a stale PDF should still be shown with a label is a product question.
5. **The recipe link made the agent navigate the person's tab** (a4-link, f3). bfcache brought the project back both times, but a page that cannot be restored would drop the person on the dashboard.
6. **The recipe's "in-memory" misled.** After a4-link the agent told the person the edit "isn't saved anywhere else". It was in fact saved to IndexedDB like any edit.
7. **Through the API, Reviewing mode was bypassed.** `agent.patchSource` ignored the person's mode, so in Reviewing it would have changed accepted source directly. In Viewing it would have edited a project the person had locked. This was found by reading the code after r3 and confirmed by a unit test that fails without the fix.

A note on the live app: it was redeployed during r1 (the module hash changed and the tab showed "Update available"). The person reloaded before r2. `agent.md` was the same before and after.

## What changed

- **Agent patches follow the person's mode** (`web/agent-commands.js`, `web/main.js`). In **Reviewing**, `patchSource` validates the edits as before but proposes each one as a suggestion. The suggestions go in a review named "Agent suggestions", one per agent session, and are credited to the agent. The receipt is `{count:0, suggested, suggestionIds, reviewId}`, and accepted source is unchanged until the person accepts. In **Viewing** it fails with `viewing_mode`. Replaying the same request ID returns the same receipt without proposing twice. Covered by a new unit test in `tests/reviews.test.mjs`, which fails before the change, and by a new `agent-recipe` browser test. That browser test proposes in Reviewing, has the person accept in the panel, checks that Viewing refuses, and checks that Editing applies directly. Confirmed with a real agent in f3.
- **`public/agent.md`** (1,998 bytes, budget 2,000) changed in five ways:
  - It now says to fetch the recipe rather than navigate the person's tab.
  - "In-memory" is replaced by "saved".
  - It documents the Reviewing and Viewing behaviour.
  - Two phrases are dropped to stay within budget: "Fragment cleared" and "Offline needs cached assets" (both from the TeX-link section).
  - "Recheck on reload" is dropped because a closed session already returns `project_closed`.
- **Tried and reverted: an in-page pointer.** A visually hidden line in the editor footer, "AI agents: read fetch('agent.md')…", appeared in the snapshot. The f1 agent saw it and **deliberately ignored it** as page text it had not been asked to follow. That is the right instinct for an agent to have, and it means the page cannot announce its own API to a careful agent. It would only add noise for screen-reader users, so it was removed. **Discovery has to come from the person or their agent setup, not from the page.**

## Human approval

**For the agent API, the app asks the person to approve nothing.** In Editing mode, patches, compiles and PDF downloads run immediately. The only approval step that applies to agent work is **Reviewing mode**. There the agent's change becomes a suggestion, and the person clicks **Accept** (or Reject) in the review panel. That is the approval exercised in r3 and f3. TeX links have their own "Allow and compile" step, which R4 does not use.

On the agent side, `--allowedTools` granted the Playwright tools ahead of time. An interactive Claude Code session would instead ask the person to approve each tool the first time it is used. That prompt was not exercised here.

## Gate

R4 asks for a real Claude Code agent in a real Chrome profile, with a human approval, to complete an edit, a compile and a diagnostic on a project already open in the person's tab, with no plugin. **On this host that is met:**
- all six no-help runs made their edits and compiled, though in r4 the agent could not confirm the result while the person typed;
- r2 found its error from a diagnostic that named the file and line;
- an approval was exercised in r3 and f3;
- no edit the person made was lost, including while they typed during r4;
- it worked when the tab was on the wrong project.

**It is not met on the owner's own machine,** which is what "a person's real tab" means in the roadmap. Not covered here:
- **Branded Chrome with his day-to-day profile.** Since Chrome 136, remote debugging on the default profile needs a separate `--user-data-dir`, or the newer chrome://inspect toggle with its per-connection "Allow" prompt. Neither was tested.
- **Other agent routes.** The new-tab route, DevTools MCP `--slim` and Claude in Chrome were not tried.

R4 is therefore left unticked in the roadmap, with this evidence linked.

## Limits

- **Host and browser:** a Linux LXC, Chromium rather than Chrome, under Xvfb, with a profile that held only Scribyra. A real profile would also have other sites and tabs open.
- **Sample size:** one model (Sonnet) and one run per cell. Prompts were in English and the tasks were small.
- **Builds:** the fixes were confirmed against a local preview (`http://127.0.0.1:4492`) in the same profile, not the live app, because nothing was deployed.
- **Concurrency:** the concurrency run used UI automation, so it did not exercise the API's `revision_conflict` path. The person's typing was scripted.
- **Results data:** per-run summaries are in [`data/r4/results/`](data/r4/results/). The full streams stay in the local `tmp/r4/runs/`.

## Verification

All commands ran through the flake (`nix develop -c`):

- **`npm test`.** The first run stopped at one Rust failure: `telemetry::native::tests::optional_export_is_atomic_private_and_excludes_its_path`, a 3-second flush timeout. This branch changes no Rust. The test failed once more on its own while the host was busy, then passed when the full suite was rerun. That rerun did every step after `npm run wasm` with `--no-fail-fast`: all cargo suites passed; the companion, folders and sync builds succeeded; and the node suites ran 1,237 tests with 1,231 passing, 0 failing and 6 skipped.
- **Agent specs.** `agent-recipe` and `agent-surface` passed in Chromium, Firefox and WebKit, 33 of 33, after the in-page pointer was reverted. WebKit used software rendering.
- **New unit test.** It fails on the previous `web/agent-commands.js`.

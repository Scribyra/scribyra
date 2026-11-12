# Real-model trials of the tab

November 5, 2026. A first check that a real model can use the tab with no plugin. **This is not R4:** it used a headless Chromium with a disposable profile, attached over `--cdp-endpoint`, with no person and no approval click. It is also not A4: the model was GPT-6.1 Sol at medium effort through Codex, not Claude.

Each trial ran from an empty folder with no user configuration and a read-only shell sandbox, with `@playwright/mcp` 0.0.84 at default flags as the browser tool and the project already open. The prompts are in [`run.sh`](data/trials/run.sh). The `pointer` arm added one sentence giving the `/agent.md` link. Results were checked by reading the tab after each run, and the edit trial's answers against the fixture. Raw results: [`a3-real-model.json`](data/trials/a3-real-model.json).

| Task | Arm | Correct | Tool calls | Tool result chars | Largest result | Uncached input tokens | Total input tokens | Seconds |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Diagnose and fix `missing-package` | plain | Yes | 12 | 36,229 | 16,493 | 22,837 | 289,973 | 84 |
| Diagnose and fix `missing-package` | pointer | Yes | 20 | 11,219 | 1,946 | 25,278 | 333,374 | 95 |
| Read and precise edit, 100-page thesis | plain | Yes | 14 | 48,995 | 30,890 | 25,209 | 278,265 | 79 |
| Read and precise edit, 100-page thesis | pointer | Yes | 10 | 43,022 | 28,583 | 31,602 | 363,634 | 117 |

## Findings

- **Four of four completed correctly, including with no recipe.** Each named the right file and line or the right line text and blank count, made the exact edit, and reported the page and warning counts that the tab showed.
- **The recipe did not reduce total cost in these runs.** It cut tool result size by about two-thirds on the small fixture and 12% on the thesis, but total and uncached input tokens were higher in both pointer runs. This is one run per cell, so it is not evidence that the recipe is harmful or useless.
- **The agents reached for page scripts.** Three of four used `browser_run_code_unsafe`, and the thesis runs each had a result above 28,000 characters. That supports building the structured command module (A5) and should inform the recipe's editing guidance, which is thin today.

## Limits

One run per cell, one model, default flags, no decoy tabs and no hostile content. Token figures are Codex's own usage counts across a whole turn, including resent context, so they are not comparable with the earlier scripted estimates. A real profile, a real approval and identifying the correct tab remain for R4.

The first four attempts failed in the harness, not the app: Codex refused MCP calls under `approval_policy="never"` until the server's tools were set to approve. They are excluded. An agent running this way needs that setting.

## With the command API (A5)

Same tasks and setup, using the `pointer` arm against `window.scribyra.agent`. All four runs completed correctly. The improved API added path lookup, a compact `describe()`, a bounded compile wait and smaller receipts, driven by what the first API run showed.

| Task | API version | Tool calls | Tool result chars | Largest result | Uncached input tokens | Total input tokens | Seconds |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Diagnose and fix `missing-package` | First | 16 | 27,121 | 6,913 | 26,110 | 370,942 | 69 |
| Diagnose and fix `missing-package` | Improved | 13 | 18,295 | 8,476 | 34,089 | 266,281 | 53 |
| Read and precise edit, 100-page thesis | First | 16 | 46,856 | 30,920 | 42,323 | 392,787 | 98 |
| Read and precise edit, 100-page thesis | Improved | 12 | 41,204 | 18,238 | 26,609 | 288,753 | 77 |

These are single runs. The improved API was faster and used fewer total input tokens than the first API and than the earlier `pointer` runs, but not clearly fewer than the `plain` runs, and uncached input on `missing-package` rose. The thesis prompt asks to open the file, which leads to snapshots the API does not need. Its case rests more on revision-checked edits and reads of any file than on token savings. The final review fixes after these runs were not retested with a model.


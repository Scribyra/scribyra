# Server compile engines: WebAssembly and native TeX Live

Measured 19 November 2026 on branch `feature/wasm-compile`, after Paul's decision of that day to compile on the server with **the browser's own WebAssembly TeX engine**, keeping native TeX Live only if the numbers demand it. `deployment.compile_engine` selects `wasm` (default) or `native` ([service](service.md#server-compile), [design section 6](org-sync-design.md#6-server-compile)).

**Recommendation: keep the WebAssembly engine as the only engine we offer; do not offer native TeX Live as a "fast" option, and delete it after one release.** Every document compiles on the server to the same pages and text as in the browser, and native's output was the same too, so native would add no capability. Its speed lead is real but bounded: 1.3–3.3× on small documents and 1.7–1.8× (about 100 s more: 3.9 against 2.2 minutes) on the 305-page thesis. It costs a second TeX distribution to secure, patch and keep in step: 2.6 GB for a TeX Live that compiles all five documents, against 0.5 GB for Node and the runtime. Most of the WebAssembly engine's extra time has a known cause we can fix (below).

## Method

- **Same host, same sandbox.** `crates/compile/examples/bench.rs` runs each document through `Bubblewrap::run`: bwrap, the seccomp filter, rlimits, and a cgroup v2 per job with one CPU (`cpu.max` 100000/100000). One job runs at a time per engine.
  - The host was shared: a 32-core LXC with a load of about 20 from other work. The WebAssembly and native series overlapped in time. Each job is pinned to one CPU, so this mostly shows up as spread (min–max below).
- **WebAssembly.** The compile runtime (`scripts/wasm-compile-runtime.mjs`) under Node 22.23.4 from nixpkgs, with `memory_mib` 4096.
  - **Cold:** a new, empty package cache for every run, filled from the bundled archives and the TeX Live mirror (`tlnet.yihui.org`, the browser's default) during the job.
  - **Warm:** one cache, filled by an untimed first run.
- **Native.** `texliveMedium.withPackages [biber biblatex siunitx beamer pgf booktabs]` from the same nixpkgs (TeX Live 2025), LuaLaTeX with Biber for the two Biber documents. Native has no package cache: its tree is installed.
- **Engine.** Both engines run LuaLaTeX. The WebAssembly engine is LuaLaTeX only, like the browser.
- **Runs.** Median of 5 runs; for the thesis, median of 3 per series.
  - "CPU" is the job cgroup's `cpu.stat`.
  - "Peak" is its `memory.peak`: every process plus the scratch tmpfs.
  - "Passes" counts LuaLaTeX runs, including the failing runs that discover missing packages.
- **Documents.** `node scripts/compile-benchmark-docs.mjs` writes them deterministically:
  - **sample:** the app's sample paper.
  - **article:** a 13-page article: 12 sections, equations, booktabs tables, a figure, 80 references with biblatex and Biber, hyperref.
  - **beamer:** a 39-page Madrid deck: overlays, blocks, columns, TikZ.
  - **tikz:** 40 TikZ pictures (plots, trees, graphs, shading, patterns, decorations) on 13 pages.
  - **thesis:** the 305-page thesis of [large projects](large-projects.md) (`scripts/large-projects.mjs`): 1.46 MB of source, 60 figures (40 MB), siunitx, biblatex and Biber.
- **Browser.** For the browser column, `tests/browser/compile-benchmark.spec.js` imports each document as a ZIP into the built app in Chromium, compiles once (a fresh tab: the first compile in that tab) and downloads the PDF.
- **Comparison.** `scripts/compile-benchmark-compare.mjs` compares the PDFs' page counts and their text, extracted with pdf.js as the app's viewer does.
- **Medians.** `node scripts/compile-benchmark-report.mjs target/compile-benchmark/out/*.jsonl` computes them.

To reproduce:

```sh
nix develop -c node scripts/compile-benchmark-docs.mjs
nix develop -c node scripts/wasm-compile-runtime.mjs target/wasm-compile-runtime
SCRIBYRA_WASM_RUNTIME=$PWD/target/wasm-compile-runtime nix develop -c cargo run -p scribyra-compile --example bench -- target/compile-benchmark/docs target/compile-benchmark/out 5 3 wasm
SCRIBYRA_BENCH_TEXLIVE=<texlive with biber> nix develop -c cargo run -p scribyra-compile --example bench -- target/compile-benchmark/docs target/compile-benchmark/out 5 3 native
SCRIBYRA_COMPILE_BENCHMARK=$PWD/target/compile-benchmark/out nix develop -c npx playwright test compile-benchmark --project chromium
nix develop -c node scripts/compile-benchmark-compare.mjs target/compile-benchmark/out
```

## Time

Wall-clock seconds, median (min–max), with CPU seconds and LuaLaTeX passes. Server rows are inside the sandbox on one CPU; the browser row is one compile in Chromium.

| Document | WASM, cold cache | WASM, warm cache | Native TeX Live | Browser (Chromium) | WASM ÷ native |
| --- | --- | --- | --- | --- | --- |
| sample (1 page) | 15.2 (14.9–15.5), CPU 15.1, 4 passes | 14.9 (14.5–15.3), CPU 14.9 | 11.6 (10.7–20.2), CPU 11.5, 2 passes | 17.6 | 1.3× |
| article + Biber (13 pages) | 41.4 (40.2–47.0), CPU 40.0, 7 passes | 40.2 (39.5–41.1), CPU 40.0 | 22.1 (21.5–25.5), CPU 22.1, 3 passes | 47.8 | 1.8× |
| beamer (39 pages) | 65.4 (63.4–65.7), CPU 64.7, 8 passes | 62.7 (57.8–63.8), CPU 62.6 | 18.8 (18.4–29.4), CPU 18.6, 2 passes | 90.6 | 3.3× |
| tikz (13 pages) | 50.1 (49.0–50.4), CPU 49.8, 5 passes | 49.7 (48.7–50.2), CPU 49.7 | 16.7 (16.5–17.0), CPU 16.5, 1 pass | 65.5 | 3.0× |
| thesis + Biber (305 pages) | 242.6 (238.5–247.2), CPU 239.3, 8 passes | 230.9 (230.1–242.2), CPU 230.3 | 134.9 (132.0–139.3), CPU 131.7, 3 passes | 271.7 | 1.7–1.8× |

What the numbers say:

- **The cache barely matters.** The cache's temperature changes little: 1–4 %. Bundled packages come from the runtime's own disk, and the few mirror packages are small. A cold cache costs a fetch, not a compile.
- **Most of the gap is extra passes, not slower TeX.**
  - On the server every job starts from the engine's baseline, like a browser's first compile in a fresh tab. It runs LuaLaTeX until the first missing file, installs the package and starts again, once for each round of missing packages.
  - BusyTeX's pipeline also reruns more eagerly than the native driver: 7–8 passes against 2–3.
  - The pass counts include the short failing discovery passes, so time per pass does not compare the engines. The extra full passes, not the engine's speed per pass, are most of the difference.
- **Native LuaLaTeX pays about 10 s per job** to build luaotfload's font database in the job's scratch. That is why the 1-page sample takes 11.6 s natively. A pre-built, read-only font cache would bring native down to a few seconds for small documents. That was not built or measured here. It is the remaining argument for a "fast" engine.
- **The browser is a little slower than the server's WebAssembly engine** for the same document. It also loads the engine and fetches packages.

## Memory

Peak memory of the job's cgroup (every process plus scratch), maximum over the runs:

| Document | WASM | Native |
| --- | --- | --- |
| sample | 602 MiB | 178 MiB |
| article | 857 MiB | 147 MiB |
| beamer | 703 MiB | 170 MiB |
| tikz | 590 MiB | 144 MiB |
| thesis | 942 MiB | 301 MiB |

- **Where the memory goes.** Node itself, the engine's WebAssembly heap and the 45 MB LuaLaTeX baseline unpacked into the engine's in-memory file system together put a WebAssembly job at 0.5–0.9 GiB: 3–5× native. Keep `memory_mib` at 1536 or more (the default is 2048), and size worker pods at about 1 GiB per concurrent job plus Node's overhead.
- **The engine's own ceiling.** This BusyTeX build caps its WebAssembly heap at **576 MiB**: Emscripten's `MAXIMUM_MEMORY`, not wasm32's 4 GB. A document that needs more fails with `limit_memory` and a log saying so; `crates/compile/tests/wasm.rs` checks that message. None of the five documents came close. Raising the cap means rebuilding BusyTeX with a larger `MAXIMUM_MEMORY`, up to 4 GB.

## Size

What a worker image needs besides the service binary and bubblewrap:

| | Size | Compiles all five documents |
| --- | --- | --- |
| **WASM: compile runtime** (engine 32 MB, LuaLaTeX baseline 45 MB, Biber 31 MB, catalog metadata 20 MB, release `scribyra_app_bg.wasm` 5 MB, driver modules; bundled package archives 189 MB) | about 330 MB, of which 189 MB is the bundled package set | yes (with the mirror or a filled cache for packages outside the bundled set) |
| **WASM: Node 22 closure** (plus bash and coreutils for the sandbox wrapper: 235 MB) | 197 MiB | |
| **WASM total** | **about 0.55 GB** | |
| Native: `texliveSmall` (the dev shell's tree before this change) | 597 MiB | no: no Biber, no siunitx, so the article and thesis fail |
| Native: `texliveMedium` | 2580 MiB | no: no Biber |
| Native: `texliveMedium` + biber, biblatex, siunitx, beamer, pgf, booktabs (benchmarked) | 2628 MiB | yes |
| Native: `texliveFull` | 5989 MiB | yes |

The package cache adds what jobs fetch: at most the catalog's archives, a few GB. In practice it holds tens of MB.

## Output equality

Page counts, and whether the extracted text of every page is identical:

| Document | Pages: WASM / browser / native | WASM = browser | WASM = native |
| --- | --- | --- | --- |
| sample | 1 / 1 / 1 | identical | all but the date: `\today` is 19 Nov 2026 in both WebAssembly engines, 14 Nov 2023 natively (the native runner sets `SOURCE_DATE_EPOCH` to the job's queue time; the WebAssembly engine uses the clock, as the browser does); word overlap 98.4 % |
| article | 13 / 13 / 13 | identical (13 of 13 pages) | identical |
| beamer | 39 / 39 / 39 | identical | identical |
| tikz | 13 / 13 / 13 | identical | identical |
| thesis | 305 / 305 / 305 | identical (305 of 305 pages) | identical |

- **The server's WebAssembly engine and the browser produce the same document.**
  - The byte sizes differ by at most a few dozen bytes: PDF IDs and dates.
  - The browser spec `org-compile.spec.js` ("the server's WebAssembly engine makes the same PDF pages as the browser's") checks this for page count and first-page text in Chromium, Firefox and WebKit.
- **Native TeX Live matches too.** For these documents native also lays out the same pages, because both are TeX Live 2025-era LuaLaTeX. That holds only while the two distributions stay in step. Diverging package versions are exactly the "compiles differently on the server" problem the decision removes.

## Why not keep native as a "fast" engine now

- **It would be a second supported engine.** Native means a second TeX distribution in the worker image, five to eleven times the WebAssembly engine's size for full coverage. It also brings its own CVE stream, its own package set (a project that compiles in the browser may not compile natively, and the reverse), and its own sandbox allow list for Perl/Biber and the TeX binaries.
- **The WebAssembly engine's gap has cheap, engine-independent fixes**, which help the browser as well:
  - **Preinstall a project's known packages.** Start each job with the packages the project's last successful compile installed, as a warm browser tab does. That removes the 1–3 failing discovery passes, and the server already stores `result.packages`.
  - **Align BusyTeX's rerun policy with the native driver's** (stop when the `.aux` is unchanged).
  - **Cache Node's compiled WebAssembly code** across jobs (each job compiles the 32 MB module anew).
- **Correctness does not need native.** Nothing measured requires it: every document compiled, within the new default budgets (`cpu_seconds` 300, `wall_seconds` 600; the thesis takes about 4 minutes), and the memory ceiling was not approached.

Revisit only if, after those fixes, a deployment needs sub-10-second compiles of large documents. Then measure native with a pre-built luaotfload cache before reviving it.

## Sandbox layering for the WebAssembly engine

These are the layers, outermost first. The details are in [service.md](service.md#webassembly-engine).

1. The job's cgroup: memory, pids, one CPU, CPU budget.
2. bwrap: no network, no `/proc`, read-only Node closure, runtime and package cache, tmpfs `/work`.
3. The unchanged seccomp allow list. Node needs nothing more; IPv4 and IPv6 sockets fail with `EPERM`.
4. rlimits, with `RLIMIT_DATA` instead of `RLIMIT_AS`. V8 reserves about 10 GiB of guard regions per WebAssembly memory.
5. Node's permission model: reads of `/runtime`, `/cache` and `/work` only; no writes, child processes, workers or addons.
6. The engine's in-memory file system with Scribyra's write guard.

Packages enter only through the worker. It verifies size and SHA-512 against the pinned catalog when it writes an entry and whenever a job asks again, and the catalog checks every archive again inside the job.

**Independent review.** An adversarial review of this layering found no escape and nothing of high severity. All of the following are fixed:

- **Medium: the fill channel could make the worker do unbounded work.**
  - The worker now fetches each entry once (a per-entry lock).
  - It runs at most four fills at once.
  - A job may fetch at most 256 MiB.
  - Entries already verified are remembered instead of rehashed.
- **Medium: mirror redirects could take the worker to other hosts or schemes.** There are no redirects now, https is required off loopback, and members see no mirror error text.
- **Low: `importScripts` decoded `%2e%2e%2f` after the prefix check.**
- **Low: a document could fake the "needs more memory" result with `\typeout`.** Only the engine's own stderr report counts now. A test checks the spoof.
- **Low: temporary cache files were neither exclusive nor cleaned up.** They are now random, created with `O_EXCL`, removed on error and swept at start.
- **Low: no memory rlimit applied when the job ran unconfined.** `RLIMIT_DATA` now applies, and a V8 out-of-memory abort counts as `limit_memory`.
- **Info: the mirror URL check was a string prefix.** It is now parsed.
- **Info: `runtime.json` did not pin every file**, and the assembler hard-linked the checkout. It now pins every file's digest and copies unless `--link`.

Two findings are documented rather than changed:

- **The shared cache tells a job which packages earlier jobs used.** Give each tenant its own cache volume where that matters.
- **Node's permission model follows symlinks.** The runtime holds none: the assembler refuses them.

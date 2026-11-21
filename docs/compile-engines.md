# Server compile engines: WebAssembly and native TeX Live

Measured 19 November 2026 on branch `feature/wasm-compile`, after Paul's decision of that day to compile on the server with **the browser's own WebAssembly TeX engine**, keeping native TeX Live only if the numbers demand it. `deployment.compile_engine` selects `wasm` (default) or `native` ([service](service.md#server-compile), [design section 6](org-sync-design.md#6-server-compile)).

**Recommendation: keep the WebAssembly engine as the only engine we offer; do not offer native TeX Live as a "fast" option, and delete it after one release.** Every document compiles on the server to the same pages and text as in the browser, and native's output was the same too, so native would add no capability. Its speed lead is real but bounded: 1.3–3.3× on small documents and 1.7–1.8× (about 100 s more: 3.9 against 2.2 minutes) on the 305-page thesis. It costs a second TeX distribution to secure, patch and keep in step: 2.6 GB for a TeX Live that compiles all five documents, against 0.5 GB for Node and the runtime. Most of the WebAssembly engine's extra time had a known cause, now fixed: see [Engine speed and memory](#engine-speed-and-memory-november-21-2026), which brings the WebAssembly engine to native's pass counts (tikz: 2 against native's 1, since a pass that creates the `.aux` is followed by one that reads it).

## Engine speed and memory (November 21, 2026)

Paul approved two fixes on November 21 that this benchmark found. Both are in the shared driver (`web/compile-driver.js`) and the BusyTeX patches (`scripts/patch-busytex.mjs`), so the browser and the server's Node runner get them alike. On branch `feature/engine-speed`, the driver refactor was ported from `feature/org-sync-v2` first, unchanged, so the two branches share it.

**Fewer passes.** Three causes, three fixes:

- **Reruns as latexmk decides them** (`scripts/tex-passes.mjs`, embedded in the pipeline). BusyTeX ran an initial pass, the bibliography, up to three reruns while the log said "Rerun…", then one more "final" pass: four passes for a one-page document. Now TeX runs, Biber/BibTeX and makeindex run when their input changed (`.bcf`, the `.aux` citation lines, `.idx`), and TeX runs again only while a generated file that it opened, or looked for and did not find, changed in the last round: `.aux` (and included chapters' `.aux`), `.toc`, `.lof`, `.out`, `.bbl` and the like. Files only other programs read (`.bcf`, `.run.xml`, `.idx`) never cause a rerun by themselves. When nothing TeX reads changed, another pass would read the same input and produce the same pages, so the last pass is the document's fixpoint. Rerun warnings alone no longer cost a pass, and a changed table of contents reruns even when LaTeX prints no warning (BusyTeX's pattern list would have stopped early there). The bound is five passes.
- **Packages before the first pass.** TeX stops at the first missing file, so each job discovered a document's packages one failing pass at a time (BusyTeX's pipeline restarts at the first pass after each install). Before the first pass the driver now installs:
  1. the packages the project's last successful compile installed. The browser remembers them per project on the device (`web/project-packages.js`, names only, per catalog snapshot, 200 projects); the server runner takes them per job (`compile({packages})`, `--packages a,b`), which the service can fill from the stored `result.packages`;
  2. the classes, packages, Beamer themes, TikZ/PGF/pgfplots libraries and BibTeX styles the source names literally (`web/tex-requirements.js`: `\documentclass`, `\usepackage`, `\RequirePackage`, `\LoadClass`, `\usetheme`, `\usetikzlibrary`, `\bibliographystyle`…, comments stripped, project files excluded) that the engine's own tree does not have (asked of the engine: `scribyra_present`);
  3. for each of those, the catalog's declared dependencies (its `dependencies` data) that the engine lacks, transitively. A dependency of which any file is already in the engine's tree is never installed over it, and dependencies resolve through their files, so a compiler-matched component wins over the mirror's archive exactly as it does after a failing pass.
  Anything the scan cannot see (a package named through a macro, a conditional load) is still found by a failing pass, and then remembered.
- **One round, fetched together.** A round's archives (the plan, checked against the 64-package / 96 MiB limit first) are fetched four at a time and written into the engine in plan order.

**Memory.** The 576 MiB cap was the pinned `busytex.wasm`'s own declared maximum: its memory section says 1024 pages (64 MiB) initially and at most 9216 pages (576 MiB), Emscripten's `MAXIMUM_MEMORY` for that build with `ALLOW_MEMORY_GROWTH`; the glue (`busytex.js`) repeats it as `getHeapMax()`, which both heap growth and C's `emscripten_get_heap_max()` use. The memory is defined in the module, not imported. Neither the compiled code nor any pin depends on the maximum, so no rebuild is needed (`scripts/wasm-memory.mjs`):

- the pipeline rewrites the memory section's maximum while the module streams in (`WebAssembly.compileStreaming` still streams; the section is buffered only until it has passed). The file on disk and every checksum that pins it (runtime assets, the catalog's compatibility record, environment locks) are unchanged; the patched glue changes the adapter identity, as any glue patch does;
- the glue's `getHeapMax()` returns `Module.scribyraHeapMax`, the same value;
- the ceiling is **2 GiB − 64 KiB** (32767 pages). This glue was linked without Emscripten's 4 GB support: above 2 GiB, pointers handed to JavaScript would turn negative. 2 GiB − 64 KiB is also Emscripten's own default maximum for growable memories, so browsers routinely accept it. Memory still starts at 64 MiB and grows only as a document needs it; small documents reserve nothing more.

Defaults:

| Where | Ceiling | Why |
| --- | --- | --- |
| Desktop browsers (Chromium, Firefox, Safari) | 2 GiB − 64 KiB | 64-bit engines reserve address space for any wasm32 memory anyway; growth commits only what is used. |
| Phones, tablets (iOS/iPadOS, Android) and devices reporting `navigator.deviceMemory` < 4 | 1 GiB | iOS ends a web page's process (WebKit's WebContent) at about 1.5 GiB on most iPhones and caps typed arrays and WebAssembly memory together at 2 GiB (the Gigacage); WebKit reports have pages killed, not refused, when `memory.grow` exceeds what the OS allows ([WebKit bug 269777](https://bugs.webkit.org/show_bug.cgi?id=269777), [221530](https://bugs.webkit.org/show_bug.cgi?id=221530)). A killed tab loses the clear message, so phones stop earlier, cleanly. |
| Server (Node runner) | 2 GiB − 64 KiB (`--engine-memory-mib`) | Size the job's `memory_mib` at 3072 or more for documents near the ceiling: Node and the in-memory file system add 0.3–0.4 GiB to the engine heap. |

A document that needs more ends with a message naming the limit, in the browser ("The document needs more memory than the TeX engine can use (2047 MiB, the most this build of the engine can address). Simplify the document or split it into parts.", with the desktop figure on phones) as on the server (`memoryMessage`, status `memory`). If the browser or machine refuses memory below the ceiling, the message says so and suggests closing tabs. Only the engine runtime's own stderr report counts, never TeX output (`\typeout`).

**Going past 2 GiB needs a rebuild, and it was not done here.** wasm32 allows 4 GiB, but this glue must then treat every pointer as unsigned (Emscripten does that when `MAXIMUM_MEMORY` exceeds 2 GB at link time). That means relinking BusyTeX: building TeX Live's engines from source with the matching Emscripten, which `texlyre-busytex` 1.4.1 does not ship as a reproducible recipe (its binary carries no producers section naming the toolchain) and nixpkgs does not package. A rebuilt engine also changes the binary every pin and the prebuilt LuaLaTeX format are matched to (`lualatex-manifest.json` `compatibility`), so the format and catalog compatibility record would be regenerated with it. That is hours of CPU and several GB of build tree per attempt on this shared host, for memory that phones cannot use and no benchmark document needs (the largest, the thesis, peaks at 229 MiB). If a real project needs more than 2 GiB, the plan is: pin the BusyTeX sources and an Emscripten release in a flake input, build with `-sMAXIMUM_MEMORY=4GB -sALLOW_MEMORY_GROWTH`, regenerate the format and compatibility pins, and keep the browser default at 2 GiB.

### Results

Measured November 21, 2026 on the same shared host as above (load 15–20 from other work), before (`76815f0`, the port plus instrumentation) and after the changes, with the same five documents. Medians of 5 runs, the thesis 3. Raw runs: [measurements/engine-speed](measurements/engine-speed/).

**Server (Node runner).** `scripts/compile-benchmark-node.mjs`: the runner without the sandbox, one job per process (each starts from the engine's baseline, as a server job does), wall seconds, peak RSS of the process, and the engine's WebAssembly heap at the end (it only grows, so it is the peak). "Warm + project packages" passes the names the project's previous compile installed.

| Document | Passes | Cold cache (s) | Warm cache (s) | Warm + project packages (s) | Peak RSS (MiB) | Engine heap (MiB) |
| --- | --- | --- | --- | --- | --- | --- |
| sample | 4 → **2** | 10.4 → **7** | 10.2 → **7.1** | 7.3 | 459 → 458 | 191 → 191 |
| article | 7 → **3** | 31 → **21.9** | 32.5 → **21.7** | 22.3 | 617 → 650 | 159 → 191 |
| beamer | 8 → **2** | 59.2 → **26.2** | 60.2 → **26.7** | 27.1 | 641 → 508 | 191 → 191 |
| tikz | 5 → **2** | 45.8 → **29.2** | 45.9 → **28.6** | 28.7 | 576 → 471 | 159 → 159 |
| thesis | 8 → **3** | 230.8 → **167.8** | 224.5 → **167.3** | 168.8 | 943 → 942 | 229 → 229 |

**Browser.** `tests/browser/compile-benchmark.spec.js`, all three browsers at once against the built app, seconds from the Compile click to the result:
- **cold**: the first compile in a fresh profile (no package cache, no project memory, the compiler starting);
- **reopen**: the page reloaded and the project opened again: a new compiler, the profile's package cache and, after the change, the project's remembered packages;
- **recompile**: a second compile in the same tab, compiler and packages warm.

| Document | Scenario | Passes | Chromium (s) | Firefox (s) | WebKit (s) |
| --- | --- | --- | --- | --- | --- |
| sample | cold | 4 → **2** | 17.8 → **13.8** | 20.3 → **16.8** | 20.2 → **16.1** |
| sample | reopen | 4 → **2** | 12.4 → **9** | 14.6 → **10.5** | 14.3 → **10.6** |
| sample | recompile | 4 → **2** | 7.2 → **4** | 7.7 → **4.4** | 8 → **4.2** |
| article | cold | 7 → **3** | 43.8 → **34.2** | 51.4 → **46.4** | 51.2 → **42** |
| article | reopen | 7 → **3** | 35.5 → **25.9** | 38.8 → **29.7** | 41.5 → **32.4** |
| article | recompile | 4 → **3** | 27.2 → **20.9** | 28.6 → **22.1** | 30.9 → **24** |
| beamer | cold | 8 → **2** | 93.5 → **45** | 106.5 → **50.1** | 85.1 → **46.9** |
| beamer | reopen | 8 → **2** | 89.8 → **38** | 103.5 → **40.3** | 79.4 → **37.6** |
| beamer | recompile | 4 → **2** | 62.5 → **35.4** | 71.6 → **34.5** | 57.7 → **31.7** |
| tikz | cold | 5 → **2** | 69.2 → **44.4** | 79.9 → **48.3** | 71.8 → **47.8** |
| tikz | reopen | 5 → **2** | 62.9 → **39.1** | 70.2 → **39.9** | 63.1 → **41.9** |
| tikz | recompile | 3 → **2** | 50.5 → **35.5** | 53.5 → **34.5** | 52.1 → **35.5** |
| thesis | cold | 8 → **3** | 277.9 → **221.4** | 305.1 → **237.8** | 291.5 → **222.4** |
| thesis | reopen | 8 → **3** | 211.4 → **161.4** | 230.4 → **176.9** | 277.5 → **211.2** |
| thesis | recompile | 4 → **3** | 202.1 → **155.2** | 206.8 → **163.7** | 263.2 → **203.3** |

What the numbers say:

- **Passes now match native TeX Live** for the sample (2), the article (3), Beamer (2) and the thesis (3); TikZ takes 2 against native's 1. The failing discovery passes are gone: packages are installed before the first pass whenever the source names them.
- **Time falls with the passes**: Beamer 1.8–2.6× faster, TikZ 1.4–1.8×, the sample 1.2–1.9×, the article 1.1–1.4×, the thesis 1.25–1.4× (Node 231 → 168 s, Chromium cold 278 → 221 s). Against native TeX Live's 135 s the server's thesis is now 1.2× rather than 1.7×.
- **The remaining gap is time per pass**, not passes: LuaTeX in WebAssembly is slower than native per pass, and each job still loads and compiles the 32 MB engine.
- **Project memory** matters for packages the source does not name literally; for these five documents the source scan already finds everything, so "warm + project packages" and "reopen" equal the plain warm case (the reopen gain is the passes).
- **Memory is unchanged** for these documents (engine heap 159–229 MiB; peak RSS the same or lower, except the article at +33 MiB). The raised ceiling costs nothing until a document needs it.

### Output equality

PDFs before and after are the same for all five documents, in the Node runner and in each browser: same page count and identical extracted text on every page (`node scripts/compile-benchmark-compare.mjs target/compile-benchmark/out node-before node-after`, and the browsers' `before-<browser>` against `after-<browser>`).

### Tests

- `tests/compile-passes.test.mjs`: the rerun policy against a simulated TeX (two passes for a plain document, a changed `.toc` reruns without a warning, warnings alone do not, Biber once per changed `.bcf`, the five-pass bound, failures), the source scan, and the per-project package memory.
- `tests/wasm-engine.test.mjs`: the real engine under Node, offline: two passes for a plain document and for a table of contents (filled), Biber with packages installed up front and no failing pass, a package found by a failing pass and then remembered (three passes, then two), a document needing about 1 GiB compiling (1056 MiB heap; the pinned build failed it at 576 MiB), and one needing 2.4 GiB failing with the memory message.
- `tests/engine-memory.test.mjs`: the memory-section rewrite on the real `busytex.wasm` (valid, streamed and buffered alike), the ceiling's bounds, the browser defaults by device, and the message.
- `tests/browser/engine-speed.spec.js`, in Chromium, Firefox and WebKit: the sample paper in two passes, the remembered package after a reload, a 1 GiB document compiling and a 2.4 GiB one failing with the message.
- Benchmark: `scripts/compile-benchmark-node.mjs` (Node, one job per process; cold, warm and per-project caches; peak RSS) and `tests/browser/compile-benchmark.spec.js` (cold, reopen and recompile per browser), summarised by `scripts/compile-benchmark-report.mjs`.

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
- **The engine's own ceiling.** This BusyTeX build declared a WebAssembly heap of at most **576 MiB**: Emscripten's `MAXIMUM_MEMORY`, not wasm32's 4 GB. Since November 21 the pipeline raises it at load time to 2 GiB − 64 KiB (see [Engine speed and memory](#engine-speed-and-memory-november-21-2026)). A document that needs more fails with `limit_memory` and a log saying so; `crates/compile/tests/wasm.rs` checks that message. None of the five documents came close.

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
  - **Preinstall a project's known packages.** Done on November 21: packages remembered per project and named in the source are installed before the first pass. The server runner takes them per job (`--packages`); the service passing its stored `result.packages` remains to wire up on `feature/org-sync-v2`.
  - **Align BusyTeX's rerun policy with the native driver's.** Done on November 21, latexmk-style: native's pass counts for four of the five documents; tikz takes 2 against native's 1, because a new `.aux` is always read back once.
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

## What operators change

**Worker image.** Add:

- Node 22 from nixpkgs, with its store closure and a bash. The closure is a `closureInfo` of `nodejs_22 bash coreutils`, given in `SCRIBYRA_NODE` and `SCRIBYRA_WASM_CLOSURE`, as the development shell sets them.
- The compile runtime: `node scripts/wasm-compile-runtime.mjs /opt/scribyra/compile-runtime` from a built checkout, set as `compile_runtime`. Build it in the image, read-only. It copies files by default and must contain no symlinks.

A TeX Live tree is no longer needed. Keep `texlive` only for `compile_engine: "native"`.

**Package cache volume.** Mount a writable directory for the worker process as `compile_cache`:

- A ReadWriteMany volume shared by the workers keeps it warm across pods.
- An `emptyDir` works too, but is cold after a restart.
- It grows to tens of MB in practice, bounded by the catalog's archives.
- Give each tenant its own volume where the shared cache's side channel matters.

**Network.** Workers need egress to `deployment.tex_mirror` (HTTPS) for packages outside the bundled set. With `tex_mirror: ""` they need none, but only bundled packages compile.

**Limits.** The defaults are now `cpu_seconds` 300 and `wall_seconds` 600. Keep `memory_mib` at 1536 or more, and size worker pods at about 1 GiB per concurrent job.

**Metrics.** Watch `scribyra_compile_package_requests_total{result}`. A rising `rejected` count means cache entries failed their checksum.

## Tests

- **`nix develop -c cargo test -p scribyra-compile --test wasm`**: the real sandbox, Node and runtime.
  - compile success with cross-references
  - diagnostics naming `chapters/bad.tex:2`
  - a missing package fetched once through the cache from a fixture mirror on loopback, then warm
  - a tampered cache entry refused and removed, and a mirror serving the wrong archive refused
  - Biber
  - cancellation with no leftovers
  - CPU and wall limits
  - the engine's memory ceiling, the job's memory limit, and a `\typeout` spoof
  - TeX unable to reach host files or the runtime
  - Node in the sandbox with no network (seccomp `EPERM`, no DNS) and reads only of its three trees (no writes, no child processes)
- **`node --test tests/wasm-compile.test.mjs`**: the worker-shaped context, cross-realm messages, `importScripts` and fetch confinement, the cache host and the server log.
- **`cargo test -p scribyra-sync --test compiles`**: the existing suite, pinned to `native`, plus a worker test of the default engine.
  - Biber with a bundled package through the cache
  - `pdf.engine` `lualatex`, `texlive` `wasm-…`
  - diagnostics in the stored log
  - a runaway document at the CPU limit with the worker still ready
  - package-cache metrics without names
- **Browser:** `org-compile.spec.js` runs with the WebAssembly engine in Chromium, Firefox and WebKit. Its new test compiles a multi-page document on the server and in the browser and expects the same page count and first-page text.

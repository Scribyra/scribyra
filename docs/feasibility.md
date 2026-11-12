# Feasibility results — November 2, 2026

**Decision: continue with the Rust/Leptos application and local WASM compilation.** The required compiler corpus works in Chromium, Firefox, and WebKit, including an offline reload. The provisional warm-compilation targets are met on this development machine. First-use package size and low-memory behavior need more work before a public launch; these results do not justify adding server compilation by default.

## Measured compilation

Single sequential samples on an AMD Ryzen 7 7800X3D (16 logical CPUs), 32 GB RAM, NixOS/Linux 6.18.34. The static assets were served over loopback. Chromium 156, Firefox 157, and WebKit 27.2 were driven by Playwright 1.64.1. All three use the same pinned TeXlyre-BusyTeX 1.4.1 / TeX Live 2026 assets.

| Scenario | Chromium | Firefox | WebKit |
| --- | ---: | ---: | ---: |
| Article, first compiler preparation + compile | 18.44 s | 15.85 s | 18.08 s |
| Article, warm worker | **0.58 s** | **0.71 s** | **0.55 s** |
| Unicode/fontspec, XeLaTeX, restarted worker | 9.55 s | 6.76 s | 4.54 s |
| Unicode/fontspec, LuaLaTeX, restarted worker | 9.08 s | 5.51 s | 4.20 s |
| BibTeX, restarted worker | 7.33 s | 3.81 s | 2.50 s |
| Biber, restarted worker | 11.00 s | 6.89 s | 5.96 s |
| 100-page multi-file document, restarted worker | 7.82 s | 11.59 s | 2.95 s |
| 100-page document, warm worker | **0.98 s** | **1.03 s** | **0.98 s** |
| Article after offline page reload | 7.28 s | 3.61 s | 2.59 s |

The 100-page fixture is deliberately simple, with 100 separate source files. It validates multi-file compilation and PDF handling, not the cost of a thesis containing hundreds of complex TikZ figures. Timing ends at compiler completion; PDF rendering is verified separately. These are individual measurements, not medians or percentiles. Cold preparation on an actual internet connection will be slower than the loopback measurements.

Machine-readable results and exact timing fields are in [measurements/browsers.json](measurements/browsers.json). Reproduce with `npm run fixtures`, `npm run build`, `npm run test:e2e`, then `npm run report`.

## Download, storage, and responsiveness

- The application WASM is approximately **381 KB** uncompressed, approximately **126 KB gzipped**. Removing its debug name section reduced it from 3.66 MB. The JavaScript bundle is approximately 908 KB uncompressed / 284 KB gzipped; PDF.js's separate worker is approximately 1.26 MB uncompressed. HTTP compression depends on the deployment.
- The compiler distribution archive is **521,748,902 bytes** and expands to approximately **686 MiB** on disk. The original measurements below used the extra collection (approximately 326 MiB) plus the combined engine (approximately 32 MiB). Goal 2b now generates a 43.53 MiB LuaLaTeX data baseline, with remaining components fetched as needed; see [current delivery sizes](tex-packages.md#smaller-lualatex-baseline-and-static-components-goal-2b). Biber loads separately when needed. Not all host distribution files are downloaded by each browser.
- IndexedDB and the service worker both retain some compiler data. This duplicates storage intentionally for the initial offline experiment; package granularity and cache ownership should be optimized.
- A 16 ms main-thread interval probe recorded maximum observed gaps of approximately **56 ms in Chromium**, **26 ms in Firefox**, and **601 ms in WebKit** during first preparation. Warm article gaps were 26/24/82 ms respectively. WebKit's initial pause and subsequent larger timer gaps warrant profiling; this probe is not a direct typing-latency percentile and may include browser scheduling effects.
- Chromium reported approximately **9–16.5 MB of main-thread JavaScript heap** at the measured points. This excludes compiler worker memory, WASM linear memory, browser cache storage, and renderer allocations. Firefox/WebKit did not expose this metric. Full peak process memory and modest-laptop/mobile performance remain unmeasured; do not use the main-thread figure as the app's total RAM requirement.

## Verified behavior

- Real pdfLaTeX/XeLaTeX/LuaLaTeX output, equations, images, Unicode Latin text, resolved cross-references, BibTeX/Biber output, and a 100-page document.
- Application reload with networking disabled, local project recovery, and a successful offline compilation using the previously prepared assets.
- Source edits persisted across reloads; file renames preserve document identity; source ZIPs round-trip text and binary bytes.
- Two independent browser profiles exchange edits and live cursors in all three engines.
- JavaScript Yjs updates merge through Rust Yrs; concurrent and disconnected edits converge; SQLite state survives a server restart; malformed updates do not corrupt it.
- Missing packages produce compiler logs. Runaway jobs can be cancelled, followed by a successful compilation. Failed jobs retain the previous successful PDF.
- Keyboard navigation, Unicode input, theme switching, pane resizing, and explicit storage-failure reporting were exercised. A simulated full disk does not display “Saved locally.” Real OS-level IME composition across input methods and assistive-technology usability still need human testing.
- The optional synchronization container builds and serves its health endpoint while running as a non-root user with a read-only root filesystem, dropped capabilities, and loopback-only publication.

Rust tests, ZIP/CRDT model tests, browser checks, and the dependency audit are documented in the README. The dependency audit reported no known vulnerabilities at implementation time. This is not a production security review.

## Next decisions supported by the evidence

1. Keep local compilation as the default. Warm compilation is comfortably below the provisional 5-second article and 30-second thesis targets on this machine.
2. Optimize first useful PDF: evaluate the basic collection and engine-specific builds, download packages by need, and avoid unnecessary duplicate caching. Measure on an ordinary laptop and a constrained network before deciding on a server fallback.
3. Keep SwiftLaTeX as a comparison candidate behind the compiler adapter. Its small release is not a complete offline distribution; see [the evaluation](swiftlatex.md).
4. Build production project identity, permissions, history, comments, suggestions, and HTTPS Git integration only after accepting the prototype's download and memory tradeoffs. The loopback sync demonstration must not be exposed as a public service.

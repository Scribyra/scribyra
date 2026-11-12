# SwiftLaTeX evaluation

Inspected on 2026-11-02 in response to the request to evaluate [SwiftLaTeX/SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX). This is a source/API evaluation, not a claim of having benchmarked SwiftLaTeX.

## Findings

- SwiftLaTeX already implements the central architectural idea: pdfTeX and XeTeX compiled to WebAssembly, running in browser workers. Its API accepts in-memory files, a main-file name and a compilation request, returning PDF bytes and logs. There is no need to rewrite TeX in Rust. [README](https://github.com/SwiftLaTeX/SwiftLaTeX/blob/87dfb950eb9c8e9dcd4ee2a3ac97fbbbacfc618a/README.md)
- The latest published release returned by GitHub is `v20022022`, published February 20, 2022; its ZIP is 2,357,859 bytes. That is an engine release archive, **not a complete offline TeX installation**. Packages and formats still need to be fetched or supplied. The inspected repository head was `87dfb950eb9c8e9dcd4ee2a3ac97fbbbacfc618a`, dated June 18, 2024. These observations do not prove the code is unusable, but warrant validation against current package distributions and browsers. [Releases](https://github.com/SwiftLaTeX/SwiftLaTeX/releases)
- Its `setTexliveEndpoint` hook supports a self-hosted package service. This can reduce the first download by loading only required packages. Offline compilation then depends on explicitly retaining the corresponding package set. [Package server](https://github.com/SwiftLaTeX/Texlive-Ondemand)
- The documented engines are pdfTeX and XeTeX; LuaTeX is not part of the documented engine set. The README describes an incomplete ICU dataset affecting locale linebreaking in XeTeX. Full compatibility with every Overleaf project should not be assumed.
- The inspected TypeScript wrapper needs hardening for this application's lifecycle: `closeWorker()` sends a graceful shutdown message rather than calling `Worker.terminate()`, and worker error handlers do not consistently reject pending operations. Runaway cancellation and failure recovery should use a wrapper that owns the worker directly. [PdfTeXEngine source](https://github.com/SwiftLaTeX/SwiftLaTeX/blob/87dfb950eb9c8e9dcd4ee2a3ac97fbbbacfc618a/pdftex.wasm/PdfTeXEngine.tsx)
- The repository README declares AGPL-3.0, but that wrapper has an EPL-2.0 / GPL-2.0-with-Classpath-exception notice. Preserve and review component-level notices before incorporating source; a repository-level label does not erase third-party terms.

## Decision for this milestone

Use **TeXlyre-BusyTeX 1.4.1** as the baseline because its exposed API includes the agreed pdfTeX, XeTeX, LuaTeX and Biber workflows and a consistent TeX Live 2026 package bundle. Its large initial download is an explicit feasibility concern, not a hidden cost. [BusyTeX API and limitations](https://github.com/TeXlyre/texlyre-busytex)

Keep the compiler adapter independent of the UI and document model. A later SwiftLaTeX experiment can implement the same project snapshot / progress / result interface and run the same fixtures. Compare equivalent warmed package sets and documents; comparing a small engine ZIP with a full bundled TeX distribution would be misleading.

Recommended next comparison: SwiftLaTeX pdfTeX with a pinned self-hosted package set versus BusyTeX's basic collection and engine-specific WASM builds. Measure first useful PDF, repeated compilation, downloaded bytes, missing-package behavior, offline restart, Unicode behavior and hard cancellation. Do not replace the working baseline until the required corpus passes.

# Third-party software

Scribyra's application code is AGPL-3.0-only. Dependencies retain their own licenses. Cargo.lock and package-lock.json pin the selected versions and their registry source/integrity information.

| Component | Role | Upstream license |
| --- | --- | --- |
| Leptos | Rust DOM UI | MIT |
| wasm-bindgen | Rust/browser bindings | MIT OR Apache-2.0 |
| CodeMirror 6 and bindings | Source editor | MIT |
| Yjs / y-codemirror.next | CRDT and editor binding | MIT |
| Yrs | Rust CRDT implementation | MIT |
| unicode-normalization | Portable project name comparison | (MIT OR Apache-2.0) AND Unicode-3.0 |
| axe-core / @axe-core/playwright (development only) | Automated accessibility regression checks | MPL-2.0 |
| @playwright/test (development only) | Browser acceptance and disposable-profile measurements | Apache-2.0 |
| fake-indexeddb (development only) | Storage transaction regression tests | Apache-2.0 |
| PDF.js | PDF rendering, text layers, viewer cache, links and document search | Apache-2.0 |
| TeXlyre-BusyTeX 1.4.1 | WASM compiler API | AGPL-3.0-or-later |
| TeXlyre-BusyTeX build / BusyTeX | TeX engine build and wrappers | Component-specific; upstream includes AGPL and MIT software |
| TeX Live 2026 | Engines, packages, fonts and tools | Multiple component licenses; retain distribution notices |
| Babel Romanian 1.2m | Downloaded language package and test fixture | LPPL-1.3-or-later; original runtime and sources in `vendor/tex/babel-romanian` |
| Optional TeX language support | Unmodified Babel, encoding and hyphenation runtime/source archives | Component-specific; recipe, checksums and catalogue license identifiers in `scripts/tex-support.json`, original notices and sources in `vendor/tex/support` |
| fflate / idb | ZIP handling / IndexedDB wrapper | MIT / ISC |
| synctex-parser 0.1.1 | Rust SyncTeX queries, locally adapted for memory-only WASM | MIT; source, license and provenance in `vendor/synctex-parser` |
| flate2 | Bounded SyncTeX gzip decompression | MIT OR Apache-2.0 |
| regex | Shared Rust Unicode search and replacement planning | MIT OR Apache-2.0 |
| lzma-rust2 | Bounded Rust/WASM XZ decoding | Apache-2.0 |
| lz4_flex (build only) | Rust decoding/repacking of Emscripten TeX data | MIT |
| ttf-parser (build only) | Font family names for downloadable components | MIT OR Apache-2.0 |
| tar | Memory-only TeX archive reading | MIT OR Apache-2.0 |
| algorithmicx | Download regression fixture | LPPL-1.3; unmodified style sources in the test archive |
| sha2 | Shared Rust asset and package checksums | MIT OR Apache-2.0 |
| rmcp 3.8.0 | Optional Rust companion MCP server/client and protocol transport | Apache-2.0 |
| @modelcontextprotocol/client 2.4.0 | Browser HTTP provider client and independent protocol interoperability tests | Apache-2.0; retain upstream MIT contribution notices |
| @modelcontextprotocol/sdk 1.32.2, aliased as mcp-client-legacy (development only) | Independent legacy-protocol interoperability tests | MIT |
| ws (development only) | Browser WebSocket adapter for native companion integration tests | MIT |
| hmac / base64 / uuid / url | Companion pairing proofs, export transfer, identities and origin parsing | MIT OR Apache-2.0 |
| tower-http | Restricted-origin demo/companion HTTP transport and optional static serving | MIT |
| Axum, Tokio, rusqlite | Demo/companion transport and demo storage | MIT / MIT / MIT |

The pinned compiler release is https://github.com/TeXlyre/texlyre-busytex/releases/tag/assets-v1.4.1. Source and build instructions are available at https://github.com/TeXlyre/texlyre-busytex and https://github.com/TeXlyre/texlyre-busytex-build. The compiler archive SHA-256 is `4f63731fe4ec9238d877846074ab424350add6f6e956944def389e6752d2c78b`.

`scribyra-assets` selects a LuaLaTeX baseline and creates supplemental runtime
components from that verified distribution. Original TeX/font file bytes are
preserved, with generated filename indexes. The build retains `LICENSE.TL`,
`LICENSE.CTAN` and `release-texlive.txt` as standalone static files under
`core/busytex/`, as well as inside the baseline. The content-addressed file
manifest records selected paths, sizes and SHA-256 checksums; the component
index records archive SHA-512 checksums and source-distribution provenance.
These build tools do not replace the upstream engines or font libraries.

The native builder also verifies the small, selected support set in
`vendor/tex/support` and publishes its unmodified archives as optional static
components. The recipe pins each revision, size and SHA-512 checksum together
with the compiler identity. These are public upstream sources and runtime inputs,
separate from generated compiler data. Retain the archives, their original source
notices and `vendor/tex/support/NOTICE` when distributing this support set.

The Biber adapter embeds `scripts/biber-project.mjs` to preserve relative project
paths and bibliography file bytes, including distinct files sharing a basename.
The virtual filesystem adapter records successful project file opens for
diagnostics; it does not change package or font contents.

`scripts/patch-busytex.mjs` applies local fixes to the extracted JavaScript wrappers: preserve failing process exit codes, use visible TeX errors on every pass, distinguish Biber logs from TeX logs, and enable Biber's `--output-safechars` workaround for [upstream accent encoding issue #36](https://github.com/TeXlyre/texlyre-busytex-build/issues/36). The wrapper also embeds `scripts/virtual-fs-guard.mjs` to scope engine writes to the virtual project and scratch space (including a seeded Lua font cache) while permitting project-internal parent-relative auxiliary paths. The wrappers also collect missing Kpathsea lookups and install verified TeX packages into a compiler-only tree. The Biber JavaScript loader also bypasses its duplicate Emscripten data cache so the verified compiler cache controls its storage. The WASM compiler binaries remain unchanged. Supplemental Babel source provenance and archive checksums are recorded in `vendor/tex/babel-romanian/PROVENANCE.md`.

The test-only `tests/native/wpe-ime.c` adapter is Scribyra code implementing WebKit’s public [InputMethodContext API](https://webkitgtk.org/reference/webkit2gtk/stable/class.InputMethodContext.html). It uses the public class ABI prefix declared by [WebKitInputMethodContext.h](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/glib/WebKitInputMethodContext.h.in); no WebKit implementation is copied or bundled. GLib/GObject (LGPL-2.1-or-later) is linked only into this local test adapter.

SwiftLaTeX was evaluated but is not bundled. Generated sample text, test documents, UI illustrations and fixture images are repository-owned. There are no remotely loaded fonts, analytics scripts, or stock-image assets.

Before public binary distribution, ship the required dependency notices and corresponding source/build materials for the exact compiler binaries used. This local feasibility build is not a completed release/distribution audit.

The optional compiler-worker observation patch constructs bounded numeric and
categorical diagnostics separately from normal compiler results. It preserves
compiler inputs, outputs and exceptions and leaves the WASM binaries unchanged.
The unmodified 3-KiB worker from the verified 1.4.1 archive is retained under
`tests/fixtures/compiler/` with its source/archive hashes for fresh patch and
idempotence checks without redownloading the full compiler archive.

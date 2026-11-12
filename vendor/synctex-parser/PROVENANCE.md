# Vendored SyncTeX parser

Source: [synctex-parser 0.1.1](https://crates.io/crates/synctex-parser/0.1.1), from the [upstream Rust project](https://github.com/DavidLapous/synctex-parser). Download URL: `https://static.crates.io/crates/synctex-parser/synctex-parser-0.1.1.crate`.

Archive SHA-256, verified against crates.io's release metadata: `1cf43c74b3f0b3cdfcd617a79db0221ad5a8391b0be72c19939f8baf316c6190`.

The upstream MIT license and copyright notices are retained in `LICENSE`. This directory contains the release's Rust source, normalized Cargo manifest, README and license; it does not bundle a native SyncTeX executable. Cargo.lock pins dependencies. This local adaptation preserves the upstream query algorithms and adds:

- An opt-in `memory-only` feature, enabled by Scribyra. Filesystem metadata, canonicalization and file opening are unavailable, including on native builds using this feature. The browser uses reader-based APIs with absolute compiler paths and no source snapshot or word heuristics.
- Target guards around Unix file metadata/open flags, portable encoded path bytes, and unsupported-operation results on targets without these facilities, enabling `wasm32-unknown-unknown` compilation.
- Browser-mode parsing limits: 16 MiB metadata, 250,000 forward nodes and 128 nested boxes. The application separately bounds decompression and records, validates input paths against its compilation manifest, and kills a query worker after five seconds.
- Native filesystem tests disabled only in memory-only builds; two upstream test fixture paths use `CARGO_MANIFEST_DIR` so they also work as a workspace member. Formatting follows `cargo fmt`.

Keep fixes small and reviewable against the registry archive. Replacing mature PDF rendering or TeX engines with new Rust implementations is not part of this adaptation.

## Verification

The application tests in `crates/core/src/synctex.rs` and `tests/source-map.test.mjs` exercise reader queries in native Rust and WASM, compressed metadata integrity/limits, nested Unicode paths, and manifest restrictions. `tests/browser/source-map.spec.js` uses actual pdfLaTeX, XeLaTeX and LuaLaTeX output in each supported browser, including offline restart and stale-map invalidation.

For the upstream native tests, run `cargo test -p synctex-parser --no-default-features` with the canonical `synctex` CLI on PATH; its randomized comparison test calls that CLI. Browser-mode tests run through `npm test`.

The independent canonical reference used during this port was [jlaurens/synctex](https://github.com/jlaurens/synctex) at commit `04cf8e3e8665ff203248d7af78ee1129afbc1b64`. It was built locally from `synctex_main.c`, `synctex_parser.c` and `synctex_parser_utils.c` using `-DSYNCTEX_STANDALONE` and zlib. Its hardcoded standalone zlib include was replaced with `<zlib.h>` for this build. It is not distributed here. The fixture directory records the geometry comparisons.

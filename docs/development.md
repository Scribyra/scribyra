# Development, self-hosting and delivery

How to build, test, measure and self-host Scribyra. For what the app does, see
the [README](../README.md) and the [feature reference](features.md); for how to
contribute, see [CONTRIBUTING](../CONTRIBUTING.md).

## Run locally

With Nix (recommended on NixOS):

```sh
nix develop
npm ci
npm run assets
npm run fixtures
npm run build
npm run preview
```

Open **http://127.0.0.1:4173**. Choose **Start with a sample paper**, then **Compile**. The first compile initializes LuaLaTeX with a 43.5 MiB baseline data set plus engine and metadata. Missing packages and fonts download as needed from verified metadata shards; later compiles reuse the worker. `npm run assets` downloads a pinned, SHA-256-verified 522 MB upstream archive, extracts approximately 686 MiB, and uses Rust to generate the smaller baseline and static components. The resulting `dist/` is approximately 310 MiB; the browser fetches the components it needs. Documents never go to a compilation server.

For frontend development:

```sh
npm run wasm
npm run dev
```

Re-run `npm run wasm` after Rust UI changes. Vite handles JavaScript/CSS changes. Offline support is enabled in production builds (`npm run build` / `npm run preview`), not in Vite development mode.

`npm run tex:catalog:check` verifies the retained runtime archive pins and dated
dependency source offline. Builds also verify the pinned LuaHBTeX binary and
prebuilt format; their identities are visible in **More tools** → **TeX environment**.

After building, `npm run measure:runtime` reports generated asset sizes.
`npm run measure:browser -- --runs=3 --output=tmp/runtime-browser.json` measures
actual uncompressed response payloads, sampled Linux browser-process memory,
worker/WASM capacity and cold/warm/offline compilation. It starts its own
loopback server and uses disposable profiles with a public synthetic article.
See the [measurement method and limits](tex-packages.md#browser-transfer-and-memory-measurements-goal-2c3b).
`npm run measure:recovery -- --runs=3 --seconds=12` reproduces interrupted
downloads with persistent and closing HTTP connections, recording slow outcomes.
Use `--protocol=https` or `--protocol=h2` to compare TLS transports (requires OpenSSL),
and `--rate=153600 --seconds=420` for a deliberately slow resumed transfer.

Without Nix: use Rust 1.99.1 with the `wasm32-unknown-unknown` target, Node.js 22.23 or newer, Python 3, a C compiler (for SQLite), `tar`, and `wasm-bindgen-cli` **0.2.129**. The CLI version must match Cargo.lock. All runtime/compiler dependencies are open-source; the application does not need a SaaS account, API key, or license server.

## Checks

```sh
cargo test -p scribyra-core -p scribyra-sync
npm test
npm run test:sync
npm run test:wrappers
npm run build
npm run test:e2e
```

The Nix shell supplies Playwright's patched browsers. Without Nix, run `npx playwright install --with-deps` first. Browser tests include actual TeX compilation and need `npm run assets` and `npm run fixtures`. Run one browser with `npm run test:e2e -- --project=chromium`. Benchmarks are written under `test-results/`. Native composition acceptance includes Chromium CDP, Gecko TextInputProcessor, and a Linux WPE input-method adapter. The WPE test needs GLib/GObject development headers and `pkg-config` (included by the Nix shell). The Gecko test uses an isolated temporary browser profile and loopback Marionette port 2828; it refuses to run when the port is already occupied and verifies the profile before privileged input. These adapters are test-only and are never included in the static app. See [workspace acceptance](workspace-acceptance.md) for coverage and platform limits.

## Optional two-client sync demo

In a second terminal:

```sh
nix develop
cargo run -p scribyra-sync --example plaintext-demo
```

The Axum server listens on `127.0.0.1:8787` and persists Yrs document state and immutable binary assets to `scribyra-sync.sqlite` (override with `SCRIBYRA_SYNC_DB`). It intentionally has **no accounts or authorization**. It accepts browser origins only from the documented local development/preview ports; keep it local.

To share one existing project between two independent browser profiles:

1. The demo is hidden in normal use. In each profile, run `localStorage.setItem('scribyra-plaintext-demo','1')` in the browser console and reload.
1. Open the project in the first profile and choose **Sync demo**. Enter a fresh room name.
2. In the second profile, create a disposable project, delete its starter file, and connect to the same room.
3. Both profiles receive the shared files. Open the same source file and edit concurrently. Live cursors appear as the peers exchange awareness updates.
4. Disconnect one profile, edit, then reconnect to exercise conflict-free merging. Restart the server to verify durable recovery.

Connecting merges documents. Starting two independently seeded projects in the same room intentionally retains both file identities; it is not production project-sharing UX. No persistent synchronization connection is made until you explicitly connect. Browser copies stay locally available after disconnecting.

The demo is a loopback-only Cargo example, excluded from release service images.
`npm run sync` now starts the authenticated opaque service; it does not accept
this demo protocol. See [service installation and operations](service.md).

## Self-hosting

Serve `dist/` on HTTPS (localhost HTTP is allowed for development). It contains the application and compiler assets. Use `application/wasm` for WASM and JavaScript MIME types for `.js` / `.mjs`. Configure no-cache for `index.html` and `sw.js`, and long-lived caching for hashed app assets. Provide disk/storage bandwidth appropriate for the bundled TeX assets. No cross-origin isolation headers or shell execution are required.

The compiler path defaults to `/core/busytex`; set `VITE_TEX_ASSET_BASE` at build time to another **same-origin path** when necessary and serve the generated `core/busytex/` contents there. The build configures the service worker to match. Compiler-matched static components are preferred; packages absent from that collection can download from an existing TeX Live mirror using pinned checksums. See [package downloads and mirror configuration](tex-packages.md). Packages requiring native shell commands or unavailable fonts/tools fail with a log; no server fallback silently uploads source.

For efficient download resume, static hosting should support byte ranges with an accurate `Content-Range`. Cross-origin package mirrors should expose that header through CORS. Servers that only return full responses still work; Scribyra restarts and verifies the complete pinned file.

Portable package bundles include their pinned metadata, allowing import with an empty metadata cache while offline. Sources and compiler assets remain separate.

After compiling successfully, choose **TeX environment → Prepare this project for offline use**. This verifies and saves the compiler, baseline, Biber helpers and supplemental packages, then locks the project environment. Readiness is checked against actual cache contents; browser storage eviction can require preparation again. **Clear compiler cache** and package cache controls do not delete project sources. Upgrades that change the compiler fingerprint require explicitly unlocking and compiling again before creating a new lock.

`npm run assets`, `npm run dev`, and `npm run build` apply the checked-in wrapper fixes automatically. These preserve the original TeX error, stop before running bibliography tools on a failed document, and avoid corrupt accented bibliography names using Biber's safe-character output. Compiler wrapper caching follows the app build while the larger immutable TeX data stays cached across upgrades. The bundled collection still does not contain every TeX Live package.

Keep the same origin when upgrading if you want to preserve browser projects. Back up local source ZIPs independently. For the sync demo, use SQLite's backup API or stop the server before copying its database; do not copy a live database without its WAL state.

## Project structure

- `crates/app`: Leptos UI and typed view state, compiled to WASM.
- `crates/core`: portable project types, tree commands, migration normalization, and path validation.
- `crates/assets`: native Rust baseline/component builder and font metadata index.
- `crates/sync`: optional opaque Rust service, SQLite metadata and blob storage; the plaintext Yrs experiment is a separate loopback-only example.
- `web`: browser adapters for CodeMirror, Yjs, storage, compilation, PDF rendering, and offline caching.
- `fixtures`, `tests`, `scripts`: reproducible documents, automated checks, asset preparation, and benchmark tooling.

See [architecture](architecture.md), the [project command contract](commands.md), [runtime and exchange contracts](exchange.md), [workspace acceptance evidence](workspace-acceptance.md), [feasibility results](feasibility.md), and [SwiftLaTeX evaluation](swiftlatex.md).

Future work is organized in the [product roadmap](roadmap.md), supported by the [static architecture and Rust feasibility study](static-architecture-study.md). These describe proposed milestones, separate from shipped prototype features. Browser capability measurements can be reproduced with `node scripts/capabilities.mjs` in the Nix shell while the preview server is running.

## Presentation site, app and CI

The presentation is at **https://scribyra.com/** and the app at **https://app.scribyra.com/**, both served by GitHub Pages. Neither needs sign-in, and both may be indexed by search engines; `robots.txt` points to a small `sitemap.xml` for scribyra.com. The staging site (https://dev.scribyra.com/, see [delivery](delivery.md)) stays out of search indexes; its `noindex`/`robots.txt` directives are indexing preferences, not access control. The app's address from before the custom domains, `https://scribyra-aca39a.gitlab.io/app/` (the project was on GitLab until November 2026), now asks for a GitLab sign-in; see [delivery](delivery.md). No installation or local server is needed to use the deployment. The first compile downloads its required pinned TeX assets; warmed/prepared projects can work offline. Each production deployment creates a GitHub Release `web-N`; `/app/release.json` identifies the exact commit and workflow run. Unfinished features remain unfinished regardless of a release build.

The `site/` directory remains the presentation source. For a local deployment preview, run `npm run build:pages`, then `python3 -m http.server 4175 --directory .pages`. The app's assets and service worker stay under `/app/`, leaving the presentation outside its offline cache. CI pins Node/Rust/wasm-bindgen, verifies compiler archives, caches extracted compiler/dependency files and discards the large downloaded archive. The assembled release is about 330 MiB, below GitHub Pages' 1 GB site limit. Opening the app uses the latest successfully deployed production build.

The source repository, https://github.com/Scribyra/scribyra, is public, as is the Pages site. CI is GitHub Actions (`.github/workflows/`): pull requests run `suite / test` (production Pages build, Rust, JavaScript, Pages browser suite in Chromium) on GitHub-hosted runners with Nix (`nix develop .#ci`, a leaner shell with the same toolchain). A push to `dev` deploys staging at https://dev.scribyra.com/; a push to `main` deploys https://app.scribyra.com/ (this repository's GitHub Pages site) and https://scribyra.com/ (the same release, published by the `scribyra-site` repository, because GitHub Pages allows one custom domain per repository) and creates a GitHub Release `web-N`. Details, settings and rollback: [delivery](delivery.md). The page distinguishes working prototype features from the roadmap.

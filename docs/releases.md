# Private browser releases

The presentation's **Open app** links use `app/` on the same private Pages site.
The browser loads a static production build, not a repository checkout or ZIP.
GitLab member authentication remains required for Pages; Scribyra itself does not
require an application account. Compilation and project storage remain local.

Each default-branch pipeline builds and publishes one matching presentation/app
release. `deploy-web` uses a digest-pinned Node 24.18.0 image, Rust 1.99.1 and
checksum-pinned wasm-bindgen 0.2.129. A fresh runner downloads the checksum-pinned
BusyTeX archive once; extracted assets and tool/dependency caches are reused on
warm runners. The archive is removed before cache upload. No private papers,
browser traces, vault files or telemetry credentials enter the Pages artifact.

The build uses `/app/` as its Vite base. Compiler URLs, precache entries, offline
navigation fallback and service-worker scope all follow that base. The root
presentation is outside the app worker's scope. Default root-path self-hosting
continues to use `/`. The assembly script hard-links release files where possible,
without creating another full copy. The approximately 320-MiB distribution
compresses to 260,883,297 bytes with ZIP level 1 in the local size check. This fits
GitLab.com's [1-GiB artifact limit](https://support.gitlab.com/hc/en-us/articles/23156779679004-Error-413-Request-Entity-Too-Large-Error-when-uploading-artifacts).

Build artifacts are maintainer-only and expire after one day. The active Pages
deployment has no expiry. Deployments are serialized, and interruptible obsolete
pipelines are cancelled when a new commit arrives. A failed build does not replace
the active Pages deployment. The release registration job uses its scoped
`CI_JOB_TOKEN` to create `web-<pipeline number>` against the built commit, with a
browser-app link. `/app/release.json` records the version, commit, pipeline URL and
release identifier; it contains no credentials.

Local reproduction:

```sh
npm run build -- --base=/app/
node scripts/ci-pages.mjs
python3 -m http.server 4175 --bind 127.0.0.1 --directory .pages
```

In another terminal, set the browser executable override if required, then run:

```sh
SCRIBYRA_TEST_PAGES_URL=http://127.0.0.1:4175/ \
  npx playwright test tests/browser/pages.spec.js --project=chromium
```

Validation on November 4, 2026: the production Rust/WASM/Vite `/app/` build passes,
as do sixteen runtime/identity JavaScript checks. Three browser scenarios pass,
one each in Chromium, Firefox and WebKit: open the presentation link, import a
seeded project, compile to PDF, verify `/app/` worker scope, reload offline,
reopen the retained project and compile again. No application assets/compilers
are requested from the wrong root paths. No TeX archive was downloaded locally.

The first real GitLab.com pipeline, release registration and authenticated Pages
readback remain to be verified. Local release tests do not prove that deployment
has succeeded. GitLab.com API access is pending. Repository and Pages visibility must remain private.

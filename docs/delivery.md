# Delivery: branches, workflows, releases

How Scribyra changes reach staging and production. The code is at
https://github.com/Scribyra/scribyra; CI runs on GitHub Actions (GitHub-hosted
runners) and every site is served by GitHub Pages. Until November 2026 the project
lived on GitLab (`gitlab.com/urundead-labs/scribyra`, now archived); releases
`web-1` to `web-95` were built there. The app's address from before the custom
domains, `https://scribyra-aca39a.gitlab.io/app/`, no longer serves the app to
the public: on November 20, 2026 it redirected to a GitLab sign-in. The app's
"could not load" message still links to it (`legacyApplication` in
`ops/pages/domains.json`).

## Branch model

| Branch | Role | Who writes to it |
| --- | --- | --- |
| `main` | Production. Every push deploys `https://app.scribyra.com/` and `https://scribyra.com/` and registers a `web-N` release. | Merges only, by maintainers |
| `dev` | The next release candidate. Every push deploys staging at `https://dev.scribyra.com/`. | Merges only, by maintainers |
| `feature/<name>` | One change. Pull request into `dev`. | Anyone with Write access |
| `hotfix/<name>` | An urgent production fix, branched from `main`. Pull request into `main`. | Anyone with Write access |

Nobody pushes to `main` or `dev` directly and nobody force-pushes them (the
rulesets below enforce it). Every merge needs a passing `suite / test` and resolved
threads, and is a merge commit. Release tags `web-N` are created only by CI;
`N` is `SCRIBYRA_RELEASE_BASE` (1000) plus the `production` workflow's run number,
so numbers only grow (the first GitHub release was `web-1001`). The update notice
relies on that: it tells an open tab about a release with a higher number, and
`plan` fails rather than build a number below the newest `web-*` tag.

**Who merges.** For now the architect agent merges release and hotfix pull requests
itself once `suite / test` passes and all threads are resolved. The owner can take
over any merge at any time: reviewing, commenting (an open thread blocks the
merge), merging himself, or asking the architect to stop.

## Workflows

| Workflow | Trigger | Runs |
| --- | --- | --- |
| `checks.yml` | pull request into `dev` or `main` | `suite / test` on the merge result; a newer push cancels the older run |
| `suite.yml` | called by the others | one job `test` on `ubuntu-24.04`: free disk, Nix (`nix develop .#ci`), caches, production Pages build, Rust, JavaScript, Pages browser suite in Chromium; optionally the staging build. No secrets. |
| `staging.yml` | push to `dev`; manual run on `dev` | `plan` (label `dev-<N>-<sha8>`), `suite / test` with the staging build, `deploy dev.scribyra.com` (pushes to `scribyra-staging`) |
| `production.yml` | push to `main`; manual run on `main` | `plan` (label `web-<N>`), `suite / test`, `deploy app.scribyra.com` (`actions/deploy-pages`), `publish scribyra.com` (pushes to `scribyra-site`), `register release` (GitHub Release `web-N`), `back-merge`. Runs are serialized and never cancelled. |

| Command | Effect |
| --- | --- |
| `gh workflow run production.yml --ref main` | Same as a push: redeploy `main` as a new release |
| `gh workflow run production.yml --ref main -f release=web-N` | Rollback (below): no release, no back-merge |
| `gh workflow run staging.yml --ref dev` | Redeploy staging |

Every action is pinned by commit SHA; workflows start from `permissions: {}` and each
job asks only for what it uses. No secret reaches a job that runs `npm` or build
scripts: the deploy keys live in environments used only by jobs that check out,
unpack and push. Caches are saved only by pushes to `dev` and `main`, never by pull
requests. Telemetry summaries (counts and outcome only) are uploaded as artifacts
for one day.

## A feature

```sh
git fetch origin
git switch -c feature/outline-panel origin/dev
# work, commit
git push -u origin feature/outline-panel
gh pr create --base dev --head feature/outline-panel \
  --title "Add the outline panel" --body "What and why; how it was tested."
```

The pull request title becomes the changelog line (the merge commit reads "Merge
pull request #N from Scribyra/feature/…" plus the title). When `suite / test` passes
and threads are resolved, a maintainer merges with **Create a merge commit**
(`gh pr merge --merge --delete-branch`). The push to `dev` deploys staging; check
the change at `https://dev.scribyra.com/`.

## A release (`dev` → `main`)

1. Check staging at `https://dev.scribyra.com/` (the Staging badge names the
   release, e.g. `dev-1042-1a2b3c4d`).
2. Generate the changelog (every pull request merged into `dev` since the latest
   `web-N` tag, grouped into features, fixes and production fixes merged back)
   and open the release pull request:

   ```sh
   git fetch origin --tags --prune
   # tests.md: the link to dev's passing run and any manual checks done on staging
   node scripts/release-changelog.mjs --tests tests.md > release.md
   gh pr create --base main --head dev --title "Release $(date +%Y-%m-%d)" \
     --body-file release.md --label release
   ```

3. When `suite / test` passes and threads are resolved, the architect merges
   (`gh pr merge <number> --merge`, never `--delete-branch`: `dev` must survive).
4. The push to `main` deploys production and creates the release `web-N`.
   `back-merge` finds nothing to do, because `dev` already has everything on `main`.

## A hotfix

```sh
git fetch origin
git switch -c hotfix/crash-on-import origin/main
# fix, add a test, commit
git push -u origin hotfix/crash-on-import
gh pr create --base main --head hotfix/crash-on-import \
  --title "Fix the crash on ZIP import" --label hotfix
```

When it passes, the architect merges it with a merge commit. The push to `main`
deploys production, registers the next `web-N`, and `back-merge` opens (or reuses)
the pull request `main` → `dev`, titled "Back-merge main into dev: …", label
`back-merge`, opened by `github-actions[bot]`. Merge it with a merge commit and
without deleting `main`. Its own check run waits for a maintainer's **Approve and
run** (events made with `GITHUB_TOKEN` need approval), but `main`'s commit already
carries `suite / test` from the production run.

`back-merge` decides from Git alone: it acts only when `main` has changes `dev`
lacks (`git diff origin/dev...main` is not empty). If Actions may not open pull
requests, the job ends with a warning and prints the `gh pr create --head main
--base dev …` command to run by hand.

**If the back-merge has conflicts**, resolve them on a branch made from `dev`, then
close the automatic pull request:

```sh
git fetch origin
git switch -c backmerge/main-into-dev origin/dev
git merge origin/main          # resolve, commit
git push -u origin backmerge/main-into-dev
gh pr create --base dev --head backmerge/main-into-dev \
  --title "Back-merge main into dev" --label back-merge
```

## A rollback

Production: redeploy an earlier release from its tag:

```sh
gh workflow run production.yml --repo Scribyra/scribyra --ref main -f release=web-N
```

It rebuilds that commit, runs the suite and deploys both domains. It registers no
release and does not back-merge, so the release list and the changelog base stay
correct. The redeployed build carries a new, higher number, so open tabs are told a
newer version is ready and reload into the rolled-back one.

Then make it durable with a hotfix (usually `git revert -m 1 <merge commit>` on a
`hotfix/` branch), because the next push to `main` would deploy the broken change
again.

Staging: re-run the `deploy dev.scribyra.com` job of an earlier `staging` run (its
site artifact is kept 7 days), or merge a revert into `dev`.

## Hosting

Browser storage (IndexedDB projects, the service worker and its caches) belongs to
an origin. Every user's projects live in `https://app.scribyra.com`, so its scheme,
host and paths (`/sw.js`, `/release.json`, `/app/`) must never change. GitHub Pages
serves one custom domain per repository, so the same release goes to two sites and
the generated `domain-router.js` shows the app on `app.scribyra.com` and the
presentation everywhere else (`scribyra.com/app/` keeps working too):

| Domain | Pages site of | Published by |
| --- | --- | --- |
| `app.scribyra.com` | `Scribyra/scribyra` | `production` → `actions/deploy-pages` from the tested artifact (no secret) |
| `scribyra.com` | `Scribyra/scribyra-site` | `production` pushes the same release as `public/` with a deploy key; that repository's `pages.yml` (from `ops/pages/github-pages.yml`) deploys it |
| `dev.scribyra.com` | `Scribyra/scribyra-staging` | `staging` pushes the staging site as `public/` with a deploy key; its `pages.yml` (from `ops/staging/github-pages.yml`) deploys it |

All three repositories are public (GitHub Pages on GitHub Free needs it), build and
deploy Pages from GitHub Actions, have their custom domain set in the repository and
**Enforce HTTPS** on (GitHub issues the certificates). `scribyra-site` and
`scribyra-staging` hold only the built site, written by CI only; their `pages.yml`
is installed by a maintainer and CI never writes it (`scripts/deploy-staging.mjs`
keeps `.github/` untouched). If a template in `ops/` changes, update it in the
target repository by hand. The deploy jobs pin `github.com`'s host key from
`ops/github/known_hosts`.

GitHub Pages limits: site ≤ 1 GB (the release is about 330 MiB), deployments time
out after 10 minutes, no custom headers (nothing needs them), soft bandwidth limit
100 GB per month. Bandwidth is the real risk: a first compile downloads about
100 MB per new browser. If traffic approaches it, put a cache or CDN in front of
`/app/core/` with the same paths.

### DNS (Cloudflare, zone `scribyra.com`)

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `@` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` | DNS only |
| AAAA | `@` | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` | DNS only |
| CNAME | `app` | `scribyra.github.io` | DNS only |
| CNAME | `dev` | `scribyra.github.io` | DNS only |
| TXT | `_github-pages-challenge-scribyra` | the value GitHub shows for the organisation's verified domain | N/A |

The TXT record keeps `scribyra.com` a verified domain of the organisation, which
protects every subdomain against takeover. Keep the hosts "DNS only": proxying stops
GitHub from issuing certificates. Do not flatten the CNAMEs and avoid wildcard
records. Leave the mail records (MX, SPF, DKIM, provider verification) and
`telemetry.scribyra.com` untouched when editing Pages DNS. To add a domain, set it in
the repository first, then point DNS at GitHub.

## Repository settings

`Scribyra/scribyra`:

- **Merging**: merge commits only (no squash or rebase; a squashed release would
  make every later back-merge conflict), merge commit title and message from the
  pull request (`MERGE_MESSAGE` / `PR_TITLE`, which the changelog reads),
  **Automatically delete head branches** on, auto-merge off, default branch `main`.
  Labels `release`, `hotfix`, `back-merge`.
- **Ruleset "main and dev"** (branches `main`, `dev`, no bypass actors): no
  deletion, no force push, pull request required (zero approvals, threads must be
  resolved, merge method `merge`), required status check `suite / test` from GitHub
  Actions (not strict: the push run on `dev`/`main` tests the merged commit again
  before it deploys).
- **Ruleset "release tags"** (`web-*`): no deletion, no update, no force push. By
  convention nobody pushes `web-*` tags by hand.
- **Actions**: allowed actions **selected** (GitHub-owned plus
  `cachix/install-nix-action@*`), **Require actions to be pinned to a full-length
  commit SHA**, default workflow permissions **read**, **Allow GitHub Actions to
  create and approve pull requests** on (also at organisation level; `back-merge`
  needs it), fork pull request workflows require approval for all external
  contributors.
- **Variables**: `SCRIBYRA_RELEASE_BASE` = `1000` (above the last GitLab release,
  `web-95`; never lower it), `SCRIBYRA_TELEMETRY_SESSION_RATE` (one of `1`, `0.5`,
  `0.25`, `0.1`, `0.01`; production only, default `1`), optionally
  `SCRIBYRA_BACKMERGE_ASSIGNEES` (comma-separated logins).
- **Environments**: `github-pages` (`deploy app.scribyra.com`), `staging`
  (branch `dev` only; secret `SCRIBYRA_STAGING_DEPLOY_KEY`, write deploy key of
  `scribyra-staging`), `production-site` (branch `main` only; secret
  `SCRIBYRA_SITE_DEPLOY_KEY`, write deploy key of `scribyra-site`). Each secret is
  the base64 of an Ed25519 private key, one line; generate the pair on a trusted
  machine and delete the files after storing it.

`scribyra-site` and `scribyra-staging`: Pages from Actions with their custom domain
and Enforce HTTPS, the same Actions policy (default permissions read, may not
create pull requests), issues, wiki and projects off, and a ruleset that forbids
deleting `main` (CI pushes with the deploy key, so no pull request rule).

## Staging at dev.scribyra.com

- **Separate origin.** Staging projects never mix with production projects at
  `app.scribyra.com`; projects move between them only by ZIP export and import.
- **Hosts.** `ops/pages/domains.staging.json` replaces the production domain file
  for the staging build: the root app lives at `https://dev.scribyra.com/` (the same
  root-shell layout as `app.scribyra.com`, with `/app/` alongside).
- **Release label.** `dev-<N>-<short sha>`, in the app bundle and in
  `release.json`. The update notice orders releases by number within a channel, so a
  staging tab is told about newer staging builds and never about production ones
  (and the reverse).
- **No telemetry.** `npm run build:staging` drops every `VITE_TELEMETRY_*` and
  `SCRIBYRA_CI_INGRESS_*` variable, the Vite config refuses a staging build that has
  a collector address, and `scripts/staging-pages.mjs check` fails if any file
  contains it.
- **Not indexed.** Every page has `<meta name="robots" content="noindex, nofollow">`
  and `robots.txt` disallows everything (GitHub Pages cannot send an
  `X-Robots-Tag` header); production's `sitemap.xml` is removed.
- **Marked.** The app shows a fixed "Staging" badge and prefixes the tab title with
  "Staging · "; every site page starts with a Staging banner.
- **Build locally:** `nix develop -c npm run build:staging` writes
  `.cache/staging/site` and runs the check.
  `SCRIBYRA_STAGING_REPOSITORY=<ssh url> nix develop -c node scripts/deploy-staging.mjs .cache/staging --dry-run`
  commits it in `.cache/staging-repo` without fetching or pushing.

## Runner disk

One suite run peaks at about 11 GB: Nix store for the CI shell 3.4 GB, `target/`
and the cargo registry about 3.8 GB, `public/core` 0.94 GB (plus a 0.52 GB archive
while extracting), `node_modules` and `~/.npm` 0.3 GB, `dist/` and
`.cache/staging` 0.65 GB, artifact tars 0.7 GB, cache archives while saving about
1 GB. The standard public-repository runner documents a 14 GB SSD, so `suite` first
deletes toolchains it never uses (Android SDK, .NET, GHC, CodeQL, PowerShell, Swift:
about 30 GB) with plain `sudo rm -rf` and prints `df -h /` before and after. There
is no Nix store cache: everything comes from `cache.nixos.org`, leaving the 10 GB
Actions cache for npm, BusyTeX (`public/core`) and cargo. `suite` has
`timeout-minutes: 90`.

## Upkeep

- `scribyra-site` and `scribyra-staging` keep one commit per deployment; identical
  files are stored once, so they grow by changed files only (about 100 MB when the
  compiler changes). GitHub recommends Pages source repositories stay under 1 GB;
  when one approaches it, restart its history from a maintainer's machine: clone it,
  `git checkout --orphan fresh && git commit -qm "Restart history"`, and push
  `fresh:main` with `--force` (its ruleset forbids deleting `main`, not force
  pushes).
- Rotate a deploy key by adding a new key to the target repository, updating the
  environment secret, then removing the old key.
- Watch Pages bandwidth against the 100 GB per month soft limit.

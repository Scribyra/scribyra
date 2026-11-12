# Moving Scribyra from GitLab to GitHub

The plan to move `gitlab.com/urundead-labs/scribyra` (code, CI, GitLab Pages) to
GitHub (code, GitHub Actions on GitHub-hosted runners, GitHub Pages) without a
gap for users and without changing the app's origin. The owner approved starting
the move; the architect runs it with the access listed in "What Paul creates".
Until the cut-over is done, GitLab stays the source of truth and
`.gitlab-ci.yml` keeps working; nothing in this branch changes GitLab behaviour.

Names used below: organisation `ORG=scribyra` (see "What Paul creates"),
repositories `scribyra` (code and the app), `scribyra-site` (the published
presentation, written by CI only) and `scribyra-staging` (the published staging
site, written by CI only).

## The hard constraint: the app origin

Browser storage (IndexedDB projects, the service worker and its caches,
localStorage) belongs to an origin: scheme + host + port. Every user's projects
live in `https://app.scribyra.com`. The move keeps that origin exactly: same
scheme, same host, same paths (`/sw.js`, `/release.json`, `/app/`), so the
browser sees one site whose files changed, which is what every release already
is. Nothing is lost and nothing has to be exported.

Two older origins also hold projects and stay served:

- `https://scribyra.com/app/`: the same release is published on the presentation
  domain, so this path keeps working on GitHub too (see the design below).
- `https://scribyra-aca39a.gitlab.io/app/` (the address before the custom
  domains): it stays on GitLab Pages. Do **not** delete the GitLab project or its
  Pages deployment; archive it (step 9). The app's "could not load" message links
  there.

## Hosting design

GitHub Pages serves one site per repository with at most one custom domain. GitLab
serves both domains from one site and `domain-router.js` picks the shell by host
name. The same artifact therefore goes to two GitHub Pages sites:

| Domain | Served by | How it is published |
| --- | --- | --- |
| `app.scribyra.com` | Pages site of `ORG/scribyra` (the code repository) | `production` workflow → `actions/deploy-pages` from the tested artifact (OIDC, no secret) |
| `scribyra.com` | Pages site of `ORG/scribyra-site` | the same artifact, pushed as `public/` by the `production` workflow with a deploy key; that repository's workflow (`ops/pages/github-pages.yml`) deploys it |
| `dev.scribyra.com` | Pages site of `ORG/scribyra-staging` | staging site pushed as `public/` by the `staging` workflow with a deploy key; its workflow (`ops/staging/github-pages.yml`) deploys it |

Why this way round: the app is the domain whose origin must never break, so it
is the main repository's own site, deployed atomically by `actions/deploy-pages`
from the exact artifact the suite tested. The presentation can lag the app by a
minute or two (its repository's own workflow) without harm.

Why the same full artifact on both domains: it is byte-for-byte what GitLab serves
on both today. The router shows the app on `app.scribyra.com` and the
presentation everywhere else, and `scribyra.com/app/` (an origin some early users
may have used) keeps working. A presentation-only artifact would be smaller but
would break that path; it can be considered later, separately.

Why not one repository with the app under a path of `scribyra.com`: that changes
the app's origin to `https://scribyra.com` and loses every project. Not an option.

Why deploy keys and not cross-repository artifacts: `actions/deploy-pages` can only
deploy the repository the workflow runs in, and starting another repository's
workflow needs a token with write access there (`GITHUB_TOKEN` cannot). A deploy
key reaches exactly one repository, needs no machine user or App, and is what
staging already uses on GitLab. CI never writes the target repository's workflow
file: a maintainer installs it once, and `scripts/deploy-staging.mjs` keeps
`.github/` untouched on every deployment.

All three repositories must be **public**: GitHub Pages on GitHub Free needs public
repositories. `scribyra-site` and `scribyra-staging` hold only the built,
AGPL-licensed site that is public anyway.

### GitHub Pages facts this relies on

Checked on 2026-11-12:

- **Limits** ([GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)):
  published site ≤ 1 GB, deployments time out after 10 minutes, soft bandwidth
  limit 100 GB per month, source repository recommended ≤ 1 GB; the 10 builds per
  hour soft limit does not apply to custom Actions workflows. No per-file limit is
  stated for Actions deployments. The assembled release is 331 MiB, 2,876 files
  (measured 2026-11-12); the largest files are `busytex.wasm` (31 MiB) and the
  LuaLaTeX data bundle (43.5 MiB), under the limits and under Git's 50 MB warning
  and 100 MB hard limit for the deploy-key pushes.
- **Bandwidth is the one real risk.** A first compile downloads roughly 100 MB of
  compiler data per new browser. 100 GB per month is on the order of a thousand
  new browsers a month. It is a soft limit (GitHub contacts the owner); if traffic
  approaches it, put Cloudflare's cache in front of the compiler files or move
  `/app/core/` to a CDN with the same paths. GitLab Pages stated no such limit.
- **Response headers**: GitHub Pages does not support custom headers. Nothing
  here needs them. There is no `_headers` or `_redirects` file; the app does not
  use cross-origin isolation (COOP/COEP) or `SharedArrayBuffer`
  (`docs/measurements/static-capabilities.json` records `crossOriginIsolated:
  false` on the current hosting); the service workers are registered at their own
  directory (`/sw.js`, `/app/sw.js`), so no `Service-Worker-Allowed` header is
  needed; staging uses `<meta name="robots">` and `robots.txt`, never
  `X-Robots-Tag`. GitHub Pages serves `.wasm` as `application/wasm` (needed by
  `WebAssembly.instantiateStreaming`), `.md` as `text/markdown`, answers byte
  ranges with `206` and `Content-Range` (download resume), and sends
  `Cache-Control: max-age=600` like GitLab Pages does today (checked with `curl -I`
  against a `github.io` site and `app.scribyra.com`).
- **Custom domain and HTTPS**
  ([managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site),
  [HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)):
  add the domain in the repository first, then point DNS (prevents takeover). Apex:
  A `185.199.108.153`–`185.199.111.153`, AAAA `2606:50c0:8000::153`–`8003::153`
  (also listed in `https://api.github.com/meta`, key `pages`); subdomains: CNAME to
  `ORG.github.io` (never the repository name). With an Actions deployment no
  `CNAME` file is needed or read. The Let's Encrypt certificate is requested only
  after the DNS check passes, i.e. after DNS points at GitHub; then
  **Enforce HTTPS** can be turned on. Avoid wildcard DNS records. Verify the
  domain at organisation level first.
- **The certificate window.** Because GitHub cannot obtain the certificate before
  DNS points at it, each host has a short window (usually minutes, documented as
  "may take some time") in which HTTPS answers with GitHub's default certificate.
  Existing app users are not affected: their service worker answers navigations
  from its cache, and a failed update check is treated as offline. New visitors in
  that window see a certificate error. Mitigation: switch at a quiet hour, one host
  at a time, app first, with TTL 60 so a rollback is quick; restart provisioning by
  removing and re-adding the domain if it has not finished after ~15 minutes.
  Proxying through Cloudflare would hide the window but stops GitHub from ever
  issuing its certificate (its DNS check would see Cloudflare addresses), so DNS
  stays "DNS only", as today.
- **Project site path.** Before a custom domain is set, a project site lives at
  `https://ORG.github.io/scribyra/`, a sub-path the root-absolute release cannot
  run under, and once the domain is set that address redirects to the domain. The
  pre-switch check therefore talks to GitHub's Pages servers directly with the
  real host name (step 5), not to `github.io`.

## Workflows

| Workflow | Trigger | Runs |
| --- | --- | --- |
| `checks.yml` | pull request into `dev` or `main` | `suite / test` (below). A newer push to the same pull request cancels the older run. |
| `suite.yml` | called by the others | One job `test` on `ubuntu-24.04`: free disk, Nix, caches, `npm ci`, compiler assets, native binaries, `ci-telemetry.py build` (the Pages release), `rust`, `javascript`, Pages release check, `browser-pages` in Chromium; optionally the staging build and artifact uploads. No secrets. |
| `staging.yml` | push to `dev`; manual run on `dev` | `plan` (label `dev-<base+run>-<sha8>`), `suite / test` with the staging build, then `deploy dev.scribyra.com` (environment `staging`): pushes the site to `scribyra-staging`. A newer push cancels a running suite, never a deploy. |
| `production.yml` | push to `main`; manual run on `main` (empty input: redeploy; `web-N`: rollback) | `plan` (label `web-<base+run>`, refuses a number below the newest tag), `suite / test` with the telemetry rate, `deploy app.scribyra.com` (`actions/deploy-pages`), `publish scribyra.com` (environment `production-site`), `register release` (GitHub Release `web-N`, not on rollback), `back-merge` (not on rollback). Whole runs are serialized and never cancelled. |

Equivalence with `.gitlab-ci.yml`: `test` ↔ `checks`/`suite`, `deploy-staging` ↔
`staging`, `deploy-web` ↔ `production` (suite + deploy + publish-site),
`register-web-release` ↔ `register release`, `back-merge` ↔ `back-merge`, "Run
pipeline on tag `web-N`" ↔ `gh workflow run production.yml -f release=web-N`.
Telemetry summaries (closed-schema JSON/JUnit) are uploaded for one day; on a
public GitHub repository any signed-in user can download artifacts (GitLab
limited them to maintainers), and the summaries hold counts, outcome and revision
only. On GitHub `telemetry-run.py` records them as `local_test` (its CI identity is
GitLab's); publication stays off in CI on both forges.

**Release numbers.** GitLab numbered releases by pipeline IID (the last is
`web-95`). GitHub numbers are `SCRIBYRA_RELEASE_BASE + run number` of the workflow;
with the base at 1000 the first GitHub release is `web-1001`, staging
`dev-1001-…`. Numbers must only grow: the update notice tells an open tab about a
release with a higher number. `plan` fails rather than build a number below the
newest `web-*` tag. The tags `web-1`…`web-95` move with the history, so the
changelog's base stays right.

**Security.** Every action is pinned by commit SHA (version in a comment); the
top-level `permissions: {}` and each job asks only for what it uses
(`contents: read` for the suite; `pages: write` + `id-token: write` for the
deployment; `contents: write` for the release; `pull-requests: write` +
`issues: write` for the back-merge). No secret reaches a job that runs `npm` or
build scripts: deploy keys live in the `staging` and `production-site`
environments and are used by jobs that only check out, unpack and push. Checkouts
do not persist credentials. Caches are saved only by pushes to `dev` and `main`,
never by pull requests, so a pull request cannot poison what production restores.
`actionlint` 1.7.12 and `zizmor` 1.32.0 (`--persona=pedantic`) pass; the only
suppression is zizmor's `self-repository` hint for `./.github/workflows/suite.yml`
(the new `$/` form is not yet understood by actionlint, and a local reusable
workflow is read from the caller's own commit).

**The back-merge pull request** is opened by the workflow's `GITHUB_TOKEN`; no bot
user is needed. Two consequences: the repository (and organisation) setting
**Allow GitHub Actions to create and approve pull requests** must be on (API field
`can_approve_pull_request_reviews`); without it the job ends with a warning and
prints the `gh pr create` command. And events created with `GITHUB_TOKEN` start
other workflows only after approval: a `pull_request` run for that pull request
waits for a maintainer's **Approve and run**
([GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)).
The required check is satisfied anyway: the pull request's head is `main`'s
commit, which already carries `suite / test` from the `production` run.

### Nix and caching on hosted runners

| Option (status 2026-11) | Verdict |
| --- | --- |
| `cachix/install-nix-action` v31.11.5 | **Used.** Upstream Nix, flakes on, `GITHUB_TOKEN` for GitHub fetches, maintained. |
| `DeterminateSystems/nix-installer-action` v23 / `determinate-nix-action` v3.24 | Works, installs Determinate Nix (Determinate's distribution, not upstream). No advantage here. |
| `DeterminateSystems/magic-nix-cache-action` v15 | Back after its 2025 shutdown (it moved to the v2 Actions cache API), but its own announcement calls it "decent but not great"; it pushes users to the paid FlakeHub Cache. |
| `nix-community/cache-nix-action` v7.0.2 | Works with the installer above (Nix ≥ 2.24). Would store the whole `/nix` (3.4 GB unpacked) in the 10 GB repository cache. |
| Cachix / FlakeHub Cache | Paid or account-bound; nothing here builds from source that is not already in `cache.nixos.org`. |

**Chosen: no Nix store cache.** Every path of the CI shell comes from
`cache.nixos.org` (Fastly), which is about as fast as restoring a 2 GB tarball from
the Actions cache, and it leaves the repository's 10 GB cache for what is slow to
rebuild. Only the Rust toolchain wrapper from `rust-overlay` is assembled locally
(seconds). The new `devShells.ci` drops Rust docs/clippy/rustfmt, Firefox/WebKit,
nginx and haproxy: 3.4 GB of Nix store instead of 5.6 GB, same versions.

Caches (`actions/cache` v6.1.0, restore and save as separate steps, saved only on
pushes to `dev`/`main`):

| Cache | Path | Key |
| --- | --- | --- |
| npm | `~/.npm` | `package-lock.json` |
| BusyTeX | `public/core` (saved right after `npm run assets`, before any build writes to it) | `scripts/assets.mjs` + `scripts/patch-busytex.mjs` (the pinned version and checksum live there) |
| cargo | `~/.cargo/registry/{index,cache}`, `~/.cargo/git/db`, `target` | `flake.lock` + `Cargo.lock` + run id, restoring the newest with the same locks |

Pull requests restore from their base branch's caches. Old cargo entries are
evicted least-recently-used.

### Runner disk

Measured on the build host for one full suite run (production build, staging
build, browser suite) with the CI shell:

| Item | Size |
| --- | --- |
| Nix store, CI shell | 3.4 GB |
| `target/` (wasm release, debug tests and bins, release asset tool) + `~/.cargo/registry` | 2.8 GB + up to 1 GB |
| `public/core` (+ 0.52 GB archive while extracting, then deleted) | 0.94 GB |
| `node_modules` + `~/.npm` | 0.3 GB |
| `dist/` (`.pages/` hard-links into it), `.cache/staging` | 0.32 GB + 0.33 GB |
| Artifact tars in `$RUNNER_TEMP` (full copies: production 329 MiB, staging about the same) | 0.7 GB |
| Cache archives while saving (cargo, compressed) | about 1 GB |
| **Peak** | **about 11 GB** |

The standard public-repository runner documents a 14 GB SSD; the image leaves
roughly that free on `/`. `suite` therefore first deletes toolchains the job never
uses (Android SDK, .NET, GHC, CodeQL, PowerShell, Swift: about 30 GB) with plain
`sudo rm -rf` (no third-party action) and prints `df -h /` before and after.

### Expected run time

Measured on the build host (10 cores) with the CI shell: Rust native binaries
and tests from cold about 6 minutes in total, wasm release build 1 minute, Pages
build 81 s, Rust suite 44 s, JavaScript suite 20 minutes (it dominates; many
seeded integration sequences), Pages browser suite 3 minutes, staging build 37 s.
A hosted runner has 4 vCPUs, so the JavaScript suite will be slower. Expected:

| Run | Estimate |
| --- | --- |
| Setup: free disk, Nix (3.4 GB from cache.nixos.org), `npm ci`, caches | 3–5 min |
| Compiler assets: warm cache / cold (522 MB download + extract) | 0.5 / 2 min |
| Cargo: warm cache / cold | 1–2 / 6–8 min |
| Builds + Rust + JavaScript + browser suite | 30–40 min |
| **Pull request check, warm caches** | **about 40 min** |
| **Production** (+ artifact upload, deploy-pages 2–4 min, site push 2 min) | **about 45–50 min** |

Measure the first real runs and adjust `timeout-minutes: 90` if needed. The
JavaScript suite could be split across a matrix later; it was kept as one job to
match GitLab exactly and to build once.

## What Paul creates

1. **The organisation.** Proposal: `scribyra` (the product's name; repositories
   read `github.com/scribyra/scribyra`, the Pages host is `scribyra.github.io`).
   `urundead-labs` is the alternative if the company should own several products.
   **Both names already exist on GitHub** as organisations without public
   repositories (`URunDEAD-Labs`, created 2026-10-26; `Scribyra`, created
   2026-11-04). If Paul created them, use `Scribyra`; if not, they are taken and a
   different name is needed (e.g. `scribyra-app`), and every `ORG` below and
   the `CNAME` targets change with it. Plan: GitHub Free. Paul's account is the
   owner; set organisation profile email `contact@scribyra.com`, add a second
   owner or recovery codes so the organisation cannot be lost with one account.
2. **The three public repositories**, empty (no README, licence or `.gitignore`):
   `scribyra`, `scribyra-site`, `scribyra-staging`. Creating them himself means the
   architect's token needs no organisation-wide rights.
3. **The architect's identity.** A machine account (e.g. `scribyra-architect`;
   GitHub allows one machine account per person) invited to the organisation as
   **Member**, with the **Admin** role on the three repositories only. Admin is
   needed for rulesets, Pages, environments and deploy keys.
4. **A fine-grained personal access token** of that account. Resource owner: the
   organisation. Repository access: **only** `scribyra`, `scribyra-site`,
   `scribyra-staging`. Expiry: 90 days (renew after the move with fewer rights, see
   below). Repository permissions:

   | Permission | Access | Used for |
   | --- | --- | --- |
   | Metadata | Read | mandatory |
   | Contents | Read and write | push history, branches, tags; read releases |
   | Workflows | Read and write | push `.github/workflows/*` (the code and the two target repositories) |
   | Administration | Read and write | repository settings, rulesets, deploy keys, Actions permissions, immutable releases |
   | Pages | Read and write | enable Pages (workflow builds), custom domain, Enforce HTTPS, read certificate state |
   | Environments | Read and write | `staging`, `production-site` and their branch policies |
   | Secrets | Read and write | the two deploy keys (environment secrets) |
   | Variables | Read and write | `SCRIBYRA_RELEASE_BASE`, `SCRIBYRA_TELEMETRY_SESSION_RATE`, `SCRIBYRA_BACKMERGE_ASSIGNEES` |
   | Actions | Read and write | start, re-run and watch workflow runs; approve runs |
   | Pull requests | Read and write | open and merge pull requests (the architect merges, as today) |
   | Issues | Read and write | labels (`release`, `hotfix`, `back-merge`), issue tracker |
   | Commit statuses | Read | check results before merging |
   | Deployments | Read | watch Pages deployments |

   No organisation permissions and no account permissions. If the organisation
   requires approval of fine-grained tokens, Paul approves it. After the move the
   token can drop Administration, Pages, Environments, Secrets, Variables and
   Workflows write (keep Contents, Pull requests, Issues, Actions). A GitHub App
   installed on the three repositories with the same repository permissions is
   the alternative if Paul prefers no machine account; it acts as
   `app-name[bot]` and its tokens last one hour.
5. **Organisation settings** (Settings, owner only; the UI is the documented
   route for domain verification):
   - **Pages → Verified domains → Add a domain** `scribyra.com`. GitHub shows a TXT
     record `_github-pages-challenge-ORG.scribyra.com`; the architect creates it
     (step 2) and Paul clicks **Verify**. This protects every subdomain against
     takeover.
   - **Actions → General**: allow actions from the organisation's repositories and
     **selected** actions: GitHub-owned plus `cachix/install-nix-action@*`; check
     **Require actions to be pinned to a full-length commit SHA**; workflow
     permissions **Read repository contents**; check **Allow GitHub Actions to
     create and approve pull requests** (otherwise the repository cannot turn it
     on); fork pull request workflows: **Require approval for all external
     contributors**.
   - Member privileges: base permission **Read**; members cannot create public
     repositories or change visibility; disallow forking of private repositories
     (none exist).
6. **Cloudflare**: nothing new. The existing token that edits the `scribyra.com`
   zone (`CF_TOKEN`, zone id `Z`) is enough.

## Cut-over, in order

Shell setup for the architect (token read from a file, never echoed):

```sh
export GH_TOKEN="$(cat ~/.secrets/github-scribyra.token)"   # the fine-grained token
ORG=scribyra; R=$ORG/scribyra
CF=https://api.cloudflare.com/client/v4
cf() { curl -sSf -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' "$@"; }
```

### 1. A day before: lower the DNS TTLs

`@` (A) and `app` (CNAME) are on automatic TTL (300 s). Set 60 s so a switch and a
rollback take a minute:

```sh
for name in scribyra.com app.scribyra.com; do
  cf "$CF/zones/$Z/dns_records?name=$name" | jq -r '.result[] | "\(.id) \(.type) \(.content)"'
done
# for each record id printed:
cf -X PATCH "$CF/zones/$Z/dns_records/<id>" --data '{"ttl":60}'
```

Announce a merge freeze on GitLab `main` and `dev` from step 3 until step 8, so
GitLab and GitHub build the same commits.

### 2. Organisation domain verification

After Paul added the domain (above), create the TXT record he was shown, then he
clicks **Verify**:

```sh
cf -X POST "$CF/zones/$Z/dns_records" --data \
  '{"type":"TXT","name":"_github-pages-challenge-'"$ORG"'","content":"<value shown by GitHub>","ttl":60}'
dig +short TXT "_github-pages-challenge-$ORG.scribyra.com"
```

### 3. Repositories, history and settings (Actions off)

Keep Actions disabled until everything is configured, so the first pushes start
nothing:

```sh
for repo in scribyra scribyra-site scribyra-staging; do
  gh api -X PUT "repos/$ORG/$repo/actions/permissions" -F enabled=false
done

# History: main, dev and the release tags from GitLab (not other branches).
git clone --mirror git@gitlab.com:urundead-labs/scribyra.git /tmp/scribyra-move.git
git -C /tmp/scribyra-move.git push "https://x-access-token:$GH_TOKEN@github.com/$R.git" \
  refs/heads/main:refs/heads/main refs/heads/dev:refs/heads/dev 'refs/tags/web-*:refs/tags/web-*'
rm -rf /tmp/scribyra-move.git

gh api -X PATCH "repos/$R" \
  -f description="Scribyra: LaTeX editor in the browser. https://scribyra.com/" \
  -f homepage=https://scribyra.com/ -F has_wiki=false -F has_projects=false \
  -F allow_merge_commit=true -F allow_squash_merge=false -F allow_rebase_merge=false \
  -F allow_auto_merge=false -F delete_branch_on_merge=true \
  -f merge_commit_title=MERGE_MESSAGE -f merge_commit_message=PR_TITLE \
  -F web_commit_signoff_required=false
gh api -X PATCH "repos/$R" -f default_branch=main
for l in release hotfix back-merge; do gh label create "$l" --repo "$R" --force; done
```

Merge commits only: the changelog reads "Merge pull request #N from ORG/branch"
plus the pull request title (`merge_commit_message=PR_TITLE`), and a squashed
release would make every later back-merge conflict. "Automatically delete head
branches" never deletes `main` or `dev`: the rulesets below forbid their deletion
(check after the first release merge that `dev` is still there).

**Rulesets** (branch: `main` and `dev`; tag: `web-*`):

```sh
gh api -X POST "repos/$R/rulesets" --input - <<'JSON'
{"name":"main and dev","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/heads/main","refs/heads/dev"],"exclude":[]}},
 "bypass_actors":[],
 "rules":[
  {"type":"deletion"},
  {"type":"non_fast_forward"},
  {"type":"pull_request","parameters":{"required_approving_review_count":0,
    "dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,
    "require_last_push_approval":false,"required_review_thread_resolution":true,
    "allowed_merge_methods":["merge"]}},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,
    "do_not_enforce_on_create":true,
    "required_status_checks":[{"context":"suite / test","integration_id":15368}]}}]}
JSON
gh api -X POST "repos/$R/rulesets" --input - <<'JSON'
{"name":"release tags","target":"tag","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/tags/web-*"],"exclude":[]}},
 "bypass_actors":[],
 "rules":[{"type":"deletion"},{"type":"update"},{"type":"non_fast_forward"}]}
JSON
gh api "repos/$R/rulesets"    # check
```

`integration_id` 15368 is the GitHub Actions app, so only Actions can satisfy
`suite / test`. Pull requests are required (no direct pushes, also for admins: no
bypass actors), threads must be resolved, merge commits only. Zero approvals
matches GitLab Free today; the architect merges. `strict` is off: like GitLab
Free, the push run on `dev`/`main` tests the merged commit again before it
deploys. Release tags cannot be moved or deleted. Restricting **creation** of
`web-*` to CI alone would need the GitHub Actions app as a bypass actor (actor id
15368, type `Integration`); whether a `GITHUB_TOKEN` release passes that is not
documented, so test it once on a throwaway `web-test-*` pattern before adding a
`creation` rule. Until then, by convention, nobody pushes `web-*` tags by hand
(as on GitLab Free). Optionally turn on **immutable releases** (Settings →
General → Releases) so a published release and its tag cannot change.

**Actions settings, variables, environments:**

```sh
gh api -X PUT "repos/$R/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
gh api -X PUT "repos/$R/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors

gh variable set SCRIBYRA_RELEASE_BASE --repo "$R" --body 1000
gh variable set SCRIBYRA_TELEMETRY_SESSION_RATE --repo "$R" --body 1   # 1, 0.5, 0.25, 0.1 or 0.01
gh variable set SCRIBYRA_BACKMERGE_ASSIGNEES --repo "$R" --body scribyra-architect  # optional, comma-separated logins

for env in staging:dev production-site:main; do
  name=${env%%:*}; branch=${env#*:}
  gh api -X PUT "repos/$R/environments/$name" --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
  gh api -X POST "repos/$R/environments/$name/deployment-branch-policies" -f name="$branch" -f type=branch
done
```

`SCRIBYRA_RELEASE_BASE` must stay above the last GitLab release: 1000 leaves room
for GitLab releases made before the freeze. `SCRIBYRA_TELEMETRY_SESSION_RATE`
replaces the GitLab CI/CD variable of the same name; production only.

**Deploy keys** (one per target repository, generated on a trusted machine,
private half stored base64 as an environment secret, then deleted):

```sh
for pair in scribyra-staging:staging:SCRIBYRA_STAGING_DEPLOY_KEY scribyra-site:production-site:SCRIBYRA_SITE_DEPLOY_KEY; do
  IFS=: read -r repo env secret <<<"$pair"
  ssh-keygen -t ed25519 -N '' -C "$repo-deploy" -f deploy
  gh repo deploy-key add deploy.pub --repo "$ORG/$repo" --allow-write --title "$ORG/scribyra CI"
  base64 -w0 deploy | gh secret set "$secret" --repo "$R" --env "$env"
  shred -u deploy; rm deploy.pub
done
```

The deploy jobs pin `github.com`'s host key from `ops/github/known_hosts` (GitHub's
published Ed25519 key, fingerprint `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`).

**Target repositories** (`scribyra-site`, `scribyra-staging`): one first commit
with their Pages workflow and README, Pages from Actions, same Actions policy, a
ruleset that keeps `main` from being deleted (CI pushes with the deploy key, so no
pull-request rule there):

```sh
for pair in scribyra-site:ops/pages/github-pages.yml:ops/pages/README.site.md scribyra-staging:ops/staging/github-pages.yml:ops/staging/README.md; do
  IFS=: read -r repo workflow readme <<<"$pair"
  d=$(mktemp -d); git -C "$d" init -q -b main
  mkdir -p "$d/.github/workflows"; cp "$workflow" "$d/.github/workflows/pages.yml"; cp "$readme" "$d/README.md"
  git -C "$d" add -A; git -C "$d" commit -qm "Add the Pages workflow"
  git -C "$d" push -q "https://x-access-token:$GH_TOKEN@github.com/$ORG/$repo.git" main
  rm -rf "$d"
  gh api -X PATCH "repos/$ORG/$repo" -F has_issues=false -F has_wiki=false -F has_projects=false \
    -f description="Published site of $ORG/scribyra. Written by CI only."
  gh api -X PUT "repos/$ORG/$repo/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
  gh api -X POST "repos/$ORG/$repo/rulesets" --input - <<'JSON'
{"name":"main","target":"branch","enforcement":"active","bypass_actors":[],
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "rules":[{"type":"deletion"}]}
JSON
done
```

The site and staging README says the content is written by CI. If a
`pages.yml` template changes later, update it in the target repository by hand
(CI never writes it).

**Pages with custom domains, before DNS moves** (adding the domain first is
GitHub's takeover protection; the DNS check fails until step 6, which is
expected):

```sh
gh api -X POST "repos/$R/pages" -f build_type=workflow
gh api -X PUT  "repos/$R/pages" -f cname=app.scribyra.com
gh api -X POST "repos/$ORG/scribyra-site/pages" -f build_type=workflow
gh api -X PUT  "repos/$ORG/scribyra-site/pages" -f cname=scribyra.com
gh api -X POST "repos/$ORG/scribyra-staging/pages" -f build_type=workflow
gh api -X PUT  "repos/$ORG/scribyra-staging/pages" -f cname=dev.scribyra.com
```

Then turn Actions on (selected actions, SHA pinning) for all three:

```sh
for repo in scribyra scribyra-site scribyra-staging; do
  gh api -X PUT "repos/$ORG/$repo/actions/permissions" -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
  gh api -X PUT "repos/$ORG/$repo/actions/permissions/selected-actions" --input - <<<'{"github_owned_allowed":true,"verified_allowed":false,"patterns_allowed":["cachix/install-nix-action@*"]}'
done
```

### 4. First deployment on GitHub

This branch has to be on GitLab `main` and `dev` before step 3 (it changes nothing
on GitLab: merge it through the usual merge requests before the freeze), so the
history pushed to GitHub already carries the workflows. With Actions now on,
start both workflows by hand on those commits:

```sh
gh workflow run staging.yml --repo "$R" --ref dev
gh workflow run production.yml --repo "$R" --ref main     # empty release: deploy main as web-1001
gh run watch --repo "$R" "$(gh run list --repo "$R" --workflow production.yml -L1 --json databaseId -q '.[0].databaseId')"
```

Expected: `suite / test` passes, `deploy app.scribyra.com` and `publish
scribyra.com` succeed, the site repository's `pages` run succeeds, release
`web-1001` exists (`gh release view web-1001 --repo "$R"`), `back-merge` reports
nothing to do.

### 5. Verify on GitHub's servers, before DNS

DNS still points at GitLab, so ask GitHub's Pages servers directly with the real
host names. HTTP works before the certificate exists; HTTPS needs `-k` (GitHub's
default certificate) until step 6:

```sh
GH_IP=185.199.108.153
for host in app.scribyra.com scribyra.com dev.scribyra.com; do
  curl -sS --resolve "$host:80:$GH_IP" "http://$host/release.json"
done
curl -skS --resolve app.scribyra.com:443:$GH_IP -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://app.scribyra.com/sw.js
curl -skSI --resolve app.scribyra.com:443:$GH_IP https://app.scribyra.com/app/core/busytex/busytex.wasm \
  | grep -iE '^HTTP|content-type'     # 200, application/wasm
```

`release.json` must name `web-1001` (app and presentation) and `dev-1001-…`
(staging), with the GitHub run URL in `pipeline`. Then a real browser against
GitHub with the real origin, in a throwaway profile:

```sh
chromium --user-data-dir="$(mktemp -d)" --ignore-certificate-errors \
  --host-resolver-rules="MAP app.scribyra.com $GH_IP, MAP scribyra.com $GH_IP" \
  https://app.scribyra.com/
```

Check: the app opens, a sample project compiles (compiler download works), reload
offline works, `https://scribyra.com/` shows the presentation and its **Open app**
goes to `https://app.scribyra.com/`.

### 6. Switch DNS, one host at a time (quiet hour)

Order: `app`, then the apex, then `dev`. After each, wait for GitHub's
certificate, then enforce HTTPS:

```sh
id=$(cf "$CF/zones/$Z/dns_records?type=CNAME&name=app.scribyra.com" | jq -r '.result[0].id')
cf -X PATCH "$CF/zones/$Z/dns_records/$id" --data '{"content":"'"$ORG"'.github.io","proxied":false,"ttl":60}'

# certificate: wait for state "approved" (re-add the domain if stuck after ~15 min)
watch -n 20 "gh api repos/$R/pages --jq '.https_certificate.state, .protected_domain_state'"
gh api repos/$R/pages/health --jq '.domain | {is_pointed_to_github_pages_ip, is_cname_to_github_user_domain, is_https_eligible}'
gh api -X PUT "repos/$R/pages" -f cname=app.scribyra.com -F https_enforced=true
```

Apex: delete the GitLab A record, create GitHub's four A and four AAAA records
(DNS only):

```sh
old=$(cf "$CF/zones/$Z/dns_records?type=A&name=scribyra.com" | jq -r '.result[] | select(.content=="35.185.44.232") | .id')
for ip in 185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153; do
  cf -X POST "$CF/zones/$Z/dns_records" --data '{"type":"A","name":"@","content":"'"$ip"'","proxied":false,"ttl":60}'
done
for ip in 2606:50c0:8000::153 2606:50c0:8001::153 2606:50c0:8002::153 2606:50c0:8003::153; do
  cf -X POST "$CF/zones/$Z/dns_records" --data '{"type":"AAAA","name":"@","content":"'"$ip"'","proxied":false,"ttl":60}'
done
cf -X DELETE "$CF/zones/$Z/dns_records/$old"
# then the same certificate wait and https_enforced=true on $ORG/scribyra-site
```

Staging: point `dev` at `$ORG.github.io` the same way (it is a CNAME to
`urundead-labs.gitlab.io` today), wait for the certificate, enforce HTTPS on
`$ORG/scribyra-staging`.

Leave untouched: the mail records (MX, SPF `v=spf1 include:zohomail.eu ~all`,
Zoho verification, DKIM), `telemetry.scribyra.com`, and for now the
`_gitlab-pages-verification-code*` TXT records (rollback needs them).

### 7. Verify on the real addresses

```sh
for host in app.scribyra.com scribyra.com dev.scribyra.com; do
  dig +short "$host"; curl -sS "https://$host/release.json" | jq -c '{release, revision, pipeline}'
  curl -sSI "http://$host/" | grep -i '^location'      # → https://
done
curl -sSI https://app.scribyra.com/sw.js | grep -iE 'content-type|cache-control'
```

In a browser profile that used the app before the switch: the projects are still
on the dashboard, the update notice offers the new release (`web-1001` > `web-9x`),
reloading picks it up, a compile works, offline reload works. Then a fresh
profile: first compile downloads the compiler and succeeds.

### 8. End the freeze on GitHub

From now on all work happens on GitHub (`docs/delivery.md`, GitHub sections). Raise
TTLs back to automatic after a week.

### 9. Retire GitLab (after a week without rollback)

1. Last commit on GitLab `main` (without a pipeline): a README pointer.

   ```sh
   printf '# Moved\n\nScribyra now lives at https://github.com/%s/scribyra.\nThis repository is archived.\n' "$ORG" > README.md
   git commit -am "Point to the GitHub repository" && git push -o ci.skip origin HEAD:main
   ```

   (The protected-branch rule must allow this one push, or do it through a merge
   request whose pipeline is skipped.)
2. Remove the custom domains from the GitLab project (Deploy → Pages) and then
   the `_gitlab-pages-verification-code` and `_gitlab-pages-verification-code.app`
   TXT records. Keep the Pages deployment itself:
   `https://scribyra-aca39a.gitlab.io/app/` must keep serving its users.
3. Unregister the `scribyra-nix` runner from both GitLab projects; archive
   `urundead-labs/scribyra-staging` and `urundead-labs/scribyra`
   (Settings → General → Advanced → Archive). Check afterwards that
   `https://scribyra-aca39a.gitlab.io/app/` still answers; if archiving stopped
   Pages, unarchive and leave the project read-only through its protected
   branches instead.
4. Remove `.gitlab-ci.yml`, `ops/staging/gitlab-ci.yml`, `ops/staging/known_hosts`
   and the GitLab sections of `docs/delivery.md` in a normal pull request.

A live GitHub → GitLab mirror is not worth it: pull mirroring is a GitLab paid
feature and a push mirror from GitHub would need a GitLab token in GitHub. The
archived project with its pointer is the "read-only mirror".

## Rollback of the move

Until step 9, GitLab still holds both custom domains with valid certificates.
Rolling back is DNS only:

```sh
id=$(cf "$CF/zones/$Z/dns_records?type=CNAME&name=app.scribyra.com" | jq -r '.result[0].id')
cf -X PATCH "$CF/zones/$Z/dns_records/$id" --data '{"content":"urundead-labs.gitlab.io","ttl":60}'
# apex: delete the 4 A + 4 AAAA GitHub records, re-create A @ 35.185.44.232 (DNS only)
```

Within a minute users are back on GitLab Pages; their projects are untouched in
either direction (same origin). One effect: tabs that already saw `web-1001` are
not told about GitLab's lower-numbered release by the update notice; they get it
on the next navigation through the normal service-worker update. GitLab's Let's
Encrypt renewals need DNS pointed at GitLab, so do not leave a rollback window
open for more than ~60 days.

Rollback of a **release** on GitHub (unchanged idea from GitLab):
`gh workflow run production.yml --repo "$R" --ref main -f release=web-N`.

## How users are affected

- **App users** (`app.scribyra.com`): not at all. Same origin, so the same
  IndexedDB projects, service worker registration and settings. The new service
  worker is a normal update; the update notice reports `web-1001` as newer and
  reloads into it. During the certificate window the installed service worker
  serves the cached app; only the update check fails, as when offline.
- **Presentation visitors** (`scribyra.com`): same pages. A first visit inside the
  apex's certificate window may show a certificate warning; keep that window
  short (quiet hour, watch the state).
- **`scribyra.com/app/` users** (if any): same origin and same paths, unaffected.
- **Legacy `scribyra-aca39a.gitlab.io/app/` users**: unaffected; it stays on
  GitLab Pages. They still need ZIP export → import to move to `app.scribyra.com`,
  as before.
- **Staging** (`dev.scribyra.com`): a separate origin, unchanged; staging projects
  may be reset anyway.
- **Search engines**: same URLs, `robots.txt` and `sitemap.xml`.

## Blockers and open points

- **Organisation name**: both proposed names exist already (see above). Needs
  Paul's confirmation that they are his.
- **Certificate window**: a few minutes of HTTPS errors for new visitors per host
  is unavoidable with GitHub-issued certificates; see the mitigation above.
- **Bandwidth soft limit** of 100 GB/month: watch it after launch.
- **Not verified here** (needs the real GitHub repositories): the first hosted
  runner timings and disk use, deploy-key pushes to GitHub, ruleset behaviour for
  `GITHUB_TOKEN`-created release tags, and that "Automatically delete head
  branches" leaves `dev` alone. Each is a step above with a check.

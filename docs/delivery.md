# Delivery: branches, pipelines, releases

How Scribyra changes reach staging and production. The model was approved by the
owner; the architect agent applies the settings below after the launch reset
(`docs/launch-cleanup.md`), when `main` starts again from the published history.

> **Moving to GitHub.** The project is moving from GitLab to GitHub (GitHub Actions,
> GitHub Pages); the plan and its commands are in [github-move.md](github-move.md).
> The branch model below stays the same on both. **Until the cut-over, GitLab is
> where work happens**: the sections marked *GitLab* apply. After it, use the
> section "On GitHub" and the GitHub columns; the GitLab sections are removed when
> GitLab is archived.

## Branch model

| Branch | Role | Who writes to it |
| --- | --- | --- |
| `main` | Production. Every push deploys `https://app.scribyra.com/` and `https://scribyra.com/` (GitLab Pages; on GitHub: the Pages sites of `scribyra` and `scribyra-site`) and registers a `web-N` release. | Merges only, by Maintainers |
| `dev` | The next release candidate. Every push deploys staging at `https://dev.scribyra.com/` (Pages of the staging project/repository). | Merges only, by Maintainers |
| `feature/<name>` | One change. Merge request (GitHub: pull request) into `dev`. | Anyone with Developer (GitHub: Write) access |
| `hotfix/<name>` | An urgent production fix, branched from `main`. Merge request (pull request) into `main`. | Anyone with Developer (Write) access |

Nobody pushes to `main` or `dev` directly and nobody force-pushes them. Every merge
needs a passing pipeline and resolved threads. Release tags `web-N` are created only
by CI (`register-web-release`); `N` is the pipeline IID, so numbers only grow. On
GitHub `N` is `SCRIBYRA_RELEASE_BASE` (1000) plus the `production` workflow's run
number, so the first GitHub release, `web-1001`, is above every GitLab one.

**Who merges.** For now the architect agent merges release merge requests
(`dev` → `main`) and hotfix merge requests itself once their pipeline passes and all
threads are resolved. The owner does not need to click Merge, and can take over any
merge at any time: reviewing, commenting (an open thread blocks the merge), merging
himself, or asking the architect to stop.

## What each pipeline runs (GitLab)

Pipelines run only for merge requests, pushes to `main` and `dev`, and manual runs
(`workflow:rules` in `.gitlab-ci.yml`). Pushing a feature or hotfix branch without a
merge request starts nothing. Every job runs on the project runner (tag
`scribyra-nix`, shell executor, `nix develop`).

| Event | Jobs |
| --- | --- |
| Merge request (any source → `dev` or `main`) | `test`: production build, Rust, JavaScript, Pages browser suite in Chromium |
| Push to `dev` | `test`, then `deploy-staging` (staging build, pushed to the staging project, whose `pages` job publishes it) |
| Push to `main` | `deploy-web` (the same suite, then production GitLab Pages), `register-web-release` (creates `web-<IID>`), `back-merge` |
| Run pipeline on tag `web-N` | `deploy-web` only: rollback (below) |
| Run pipeline on `main` or `dev` | Same as a push: redeploy |

The `test` suite equals what production deployed with before this change. Merge
request pipelines test the source branch; GitLab Free has no merged-results
pipelines, so the push pipeline on `dev`/`main` tests the merged commit again before
it deploys.

## A feature (GitLab)

```sh
git fetch origin
git switch -c feature/outline-panel origin/dev
# work, commit
git push -u origin feature/outline-panel
glab mr create --source-branch feature/outline-panel --target-branch dev \
  --title "Add the outline panel" --description "What and why; how it was tested." \
  --remove-source-branch --yes
```

The merge request title becomes the changelog line, so write it for readers. When
the pipeline passes and threads are resolved, a Maintainer merges with a merge
commit (keep GitLab's default merge commit message: the changelog reads it). The
branch is deleted on merge. The push to `dev` deploys staging within one pipeline;
check the change at `https://dev.scribyra.com/`.

## A release (`dev` → `main`, GitLab)

1. Check staging at `https://dev.scribyra.com/` (the Staging badge names the
   release, e.g. `dev-412-1a2b3c4d`).
2. Generate the changelog and open the release merge request. The changelog lists
   every merge request merged into `dev` since the latest `web-N` tag, grouped into
   features, fixes and production fixes merged back:

   ```sh
   git fetch origin --tags --prune
   # tests.md: the link to dev's passing pipeline and any manual checks done on staging
   node scripts/release-changelog.mjs --tests tests.md > release.md
   glab mr create --source-branch dev --target-branch main \
     --title "Release $(date +%Y-%m-%d)" --description "$(cat release.md)" \
     --label release --remove-source-branch=false --yes
   ```

   `--remove-source-branch=false` matters: `dev` must survive the merge (GitLab
   also refuses to delete a protected branch).
3. The merge request pipeline runs the full suite. When it passes and threads are
   resolved, the architect merges (merge commit, no squash). The owner may review
   or merge instead.
4. The push to `main` deploys production and creates the release `web-<IID>`.
   `back-merge` finds nothing to do, because `dev` already has everything on `main`.

## A hotfix (GitLab)

```sh
git fetch origin
git switch -c hotfix/crash-on-import origin/main
# fix, add a test, commit
git push -u origin hotfix/crash-on-import
glab mr create --source-branch hotfix/crash-on-import --target-branch main \
  --title "Fix the crash on ZIP import" --label hotfix --remove-source-branch --yes
```

When its pipeline passes and threads are resolved, the architect merges it. The push
to `main` deploys production, registers the next `web-N`, and the `back-merge` job
opens a merge request `main` → `dev` (or reuses an open one, which updates by
itself), titled "Back-merge main into dev: …", label `back-merge`. Merge it like any
other merge request into `dev`, with a merge commit and without deleting `main`.

`back-merge` decides from Git alone: it runs on every push to `main` and acts only
when `main` has changes `dev` lacks (`git diff origin/dev...main` is not empty).

**If the back-merge has conflicts**, resolve them on a branch made from `dev`, then
close the automatic merge request:

```sh
git fetch origin
git switch -c backmerge/main-into-dev origin/dev
git merge origin/main          # resolve, commit
git push -u origin backmerge/main-into-dev
glab mr create --source-branch backmerge/main-into-dev --target-branch dev \
  --title "Back-merge main into dev" --label back-merge --remove-source-branch --yes
```

**If `SCRIBYRA_BACKMERGE_TOKEN` is not set** (fallback), `back-merge` ends with exit
code 42, shown as a warning, and prints the command to open the merge request by
hand: `glab mr create --source-branch main --target-branch dev --title "Back-merge
main into dev" --remove-source-branch=false --yes`. The architect runs it after every
hotfix.

## A rollback (GitLab)

Production: redeploy an earlier release from its tag. In **Build → Pipelines → Run
pipeline**, choose the tag `web-N` (or `POST /projects/88410471/pipeline?ref=web-N`).
Only `deploy-web` runs: it rebuilds that commit, runs the suite, and publishes it to
GitLab Pages. It registers no release, so the release list and the changelog base
stay correct. The redeployed build carries a new, higher release number, so open
tabs are told a newer version is ready and reload into the rolled-back one.

Then make it durable with a hotfix (usually `git revert -m 1 <merge commit>` on a
`hotfix/` branch), because the next push to `main` would deploy the broken change
again.

Staging: retry `deploy-staging` in an earlier `dev` pipeline (it rebuilds that commit
and publishes it), or merge a revert into `dev`.

## Staging at dev.scribyra.com (GitLab)

Staging is published by a second project, `urundead-labs/scribyra-staging` (private
repository, public Pages), whose only content is the built site. Cloudflare Pages
cannot host it: it caps each file at 25 MiB, and the build has larger compiler files
(`busytex.wasm` 31 MiB, the LuaLaTeX data bundle 44 MiB). GitLab Free cannot pass
artifacts between projects (`needs:project` is Premium), so the site travels by Git:

1. `deploy-staging` (main project, on `dev`) runs `npm run build:staging`, then
   `scripts/deploy-staging.mjs`, which commits the site as `public/` (plus the staging
   project's `.gitlab-ci.yml` from `ops/staging/`) on top of the previous deployment
   and pushes it to the staging project's `main` with an SSH deploy key. The
   checkout lives in the runner's cache (`.cache/staging-repo`) and fetches with
   depth 1, so a push sends only changed files; unchanged compiler files are never
   re-sent.
2. The push starts the staging project's `pages` job (same `scribyra-nix` runner),
   which checks the folder and publishes it.

Properties of the staging build:

- **Separate origin.** Browser storage is per origin, so staging projects never mix
  with production projects at `app.scribyra.com`. Projects can move between them
  only by ZIP export and import.
- **Hosts.** `ops/pages/domains.staging.json` replaces the production domain file
  for the staging build: the root app lives at `https://dev.scribyra.com/` (the same
  root-shell layout as `app.scribyra.com`, with `/app/` alongside). The generated
  `domain-router.js` opens the app on `dev.scribyra.com` and the presentation site on
  any other host, such as the staging project's own `*.gitlab.io` address. Its
  `presentation` entry is a placeholder until that address is known (step 6 of the
  staging project setup); until then the site's "Open app" links open `/app/`.
- **Release label.** `dev-<pipeline IID>-<short sha>`, in the app bundle and in
  `release.json`. The update notice orders releases by number within a channel, so
  a staging tab is told about newer staging builds and never about production ones
  (and the reverse). The service worker and the update check use the root path
  (`/sw.js`, `/release.json`) exactly as on `app.scribyra.com`.
- **No telemetry.** `npm run build:staging` drops every `VITE_TELEMETRY_*` and
  `SCRIBYRA_CI_INGRESS_*` variable, and the Vite config refuses a staging build that
  has a collector address. `scripts/staging-pages.mjs check` fails the job if any
  file contains the collector address.
- **Not indexed.** Every page has `<meta name="robots" content="noindex, nofollow">`
  and `robots.txt` disallows everything (GitLab Pages cannot send an
  `X-Robots-Tag` header), and production's `sitemap.xml` is removed. This holds
  while production allows indexing (production `robots.txt` allows crawling and
  names its sitemap).
- **Marked.** The app shows a fixed "Staging" badge and prefixes the tab title with
  "Staging · "; every site page starts with a Staging banner.
- **Build locally:** `nix develop -c npm run build:staging` writes
  `.cache/staging/site` and runs the check.
  `nix develop -c node scripts/deploy-staging.mjs .cache/staging --dry-run` commits
  it in `.cache/staging-repo` without fetching or pushing.

## GitLab settings (architect, after the launch reset; GitLab)

Project `urundead-labs/scribyra`, ID `88410471`, gitlab.com Free. Run with a token of
a Maintainer or Owner:

```sh
GL=https://gitlab.com/api/v4; P=88410471
H="PRIVATE-TOKEN: $GITLAB_TOKEN"     # never echo it
```

1. **Create `dev`** from the reset `main`:

   ```sh
   curl -sSf -X POST -H "$H" "$GL/projects/$P/repository/branches" -d branch=dev -d ref=main
   ```

2. **Merge settings.** Merge commits (keeps `dev` and `main` related, which the
   back-merge check and changelog rely on; a squashed release would make every later
   back-merge conflict), squash never, pipelines must succeed, a skipped pipeline does
   not count, all threads resolved, delete source branch by default:

   ```sh
   curl -sSf -X PUT -H "$H" "$GL/projects/$P" \
     -d merge_method=merge -d squash_option=never \
     -d only_allow_merge_if_pipeline_succeeds=true -d allow_merge_on_skipped_pipeline=false \
     -d only_allow_merge_if_all_discussions_are_resolved=true \
     -d remove_source_branch_after_merge=true \
     -d auto_cancel_pending_pipelines=enabled \
     -d ci_forward_deployment_enabled=true \
     -d ci_pipeline_variables_minimum_override_role=maintainer
   ```

   Keep the default merge commit template; the changelog parses it.

3. **Protected branches.** No direct push, merge by Maintainers, no force push.
   Remove an existing rule first (the launch procedure re-protects `main`; a 404
   here is fine):

   ```sh
   for b in main dev; do
     curl -sS -X DELETE -H "$H" "$GL/projects/$P/protected_branches/$b"
     curl -sSf -X POST -H "$H" "$GL/projects/$P/protected_branches" \
       -d name=$b -d push_access_level=0 -d merge_access_level=40 \
       -d unprotect_access_level=40 -d allow_force_push=false
   done
   curl -sSf -H "$H" "$GL/projects/$P/protected_branches"    # check
   ```

4. **Protected tags** `web-*`, created by Maintainers only. CI creates them through
   the release API with the job token, which acts as the user whose merge started
   the pipeline, so that user (the architect's account) must be a Maintainer. Free
   plan cannot restrict tag creation to CI alone; by convention nobody pushes
   `web-*` tags by hand.

   ```sh
   curl -sSf -X POST -H "$H" "$GL/projects/$P/protected_tags" -d name='web-*' -d create_access_level=40
   ```

5. **CI/CD variables** (Settings → CI/CD → Variables). Enter secret values in the UI
   with Visibility **Masked and hidden** and **Protect variable** checked, so only
   pipelines on `main`, `dev` and `web-*` tags see them. API equivalent, reading the
   value from a file so it never appears in shell history:

   | Key | Value | Flags |
   | --- | --- | --- |
   | `SCRIBYRA_STAGING_DEPLOY_KEY` | base64 of the staging deploy key's private key (see "Staging project") | masked and hidden, protected |
   | `SCRIBYRA_BACKMERGE_TOKEN` | the back-merge bot's personal access token | masked and hidden, protected |
   | `SCRIBYRA_BACKMERGE_ASSIGNEE_IDS` | optional, comma-separated GitLab user IDs to assign back-merges to | protected |

   ```sh
   curl -sSf -X POST -H "$H" "$GL/projects/$P/variables" -d key=SCRIBYRA_STAGING_DEPLOY_KEY \
     --data-urlencode "value@staging-deploy.b64" -d masked_and_hidden=true -d masked=true -d protected=true
   curl -sSf -X POST -H "$H" "$GL/projects/$P/variables" -d key=SCRIBYRA_BACKMERGE_TOKEN \
     --data-urlencode "value@backmerge-token.txt" -d masked_and_hidden=true -d masked=true -d protected=true
   ```

6. **Approvals.** Required approvals and approval rules are paid features. On Free,
   the enforceable gates are the protected branches (only Maintainers merge), passing
   pipelines and resolved threads: any open thread the owner leaves blocks the merge.

7. **Release merge requests** need nothing else: merge request pipelines come from
   `.gitlab-ci.yml`, not from a project setting.

### The back-merge token

`CI_JOB_TOKEN` cannot create merge requests (its API access is limited to a few
endpoints such as releases, packages and artifacts). Project and group access
tokens on gitlab.com require Premium. So the back-merge uses a **personal access
token of a dedicated bot user**, kept in a masked, hidden, protected variable:

1. The owner creates a gitlab.com user, e.g. `scribyra-bot`, and adds it to the
   project with role **Developer** (it can open merge requests; it cannot merge into
   or push to `main`/`dev`, and it has access to nothing else). Free private groups
   on gitlab.com are limited to five members; check the count, since the bot takes a
   seat while the group is private.
2. Signed in as the bot: User settings → Access tokens → name `scribyra-back-merge`,
   expiry at most one year (set a reminder to rotate), scope **`api` only**. `api`
   is the narrowest scope that can create merge requests; `write_repository` covers
   Git only. Its reach is bounded by the bot's Developer role on this one project.
3. Store it as `SCRIBYRA_BACKMERGE_TOKEN`.

Without the bot, the fallback is the manual command printed by the job (above).
Using the owner's own token instead is not recommended: `api` on his account reaches
every project he owns.

## Staging project (architect, once; GitLab)

Uses the same `GL`, `H` and `P` as above; the token needs Owner or Maintainer on the
`urundead-labs` group (ID `146311520`). DNS uses the existing Cloudflare token that
can edit the `scribyra.com` zone (`CF_TOKEN`, zone ID `Z`).

1. **Create the project**: private repository, public Pages, no shared runners
   (the group's shared minutes are spent), nothing else enabled:

   ```sh
   curl -sSf -X POST -H "$H" "$GL/projects" \
     -d name=scribyra-staging -d path=scribyra-staging -d namespace_id=146311520 \
     -d visibility=private -d pages_access_level=public -d builds_access_level=private \
     -d shared_runners_enabled=false -d public_jobs=false \
     -d issues_access_level=disabled -d merge_requests_access_level=disabled \
     -d wiki_access_level=disabled -d snippets_access_level=disabled \
     -d container_registry_access_level=disabled -d packages_enabled=false \
     -d description="Published staging site of urundead-labs/scribyra (dev.scribyra.com). Written by CI only."
   S=<id from the response>
   ```

2. **Give it the `scribyra-nix` runner.** A project runner can serve several
   projects; a locked one cannot be added, so unlock it for the moment:

   ```sh
   curl -sSf -H "$H" "$GL/projects/$P/runners?type=project_type"   # R = id of the scribyra-nix runner
   curl -sSf -X PUT  -H "$H" "$GL/runners/$R" -d locked=false
   curl -sSf -X POST -H "$H" "$GL/projects/$S/runners" -d runner_id=$R
   curl -sSf -X PUT  -H "$H" "$GL/runners/$R" -d locked=true
   ```

3. **Create `main` and leave it unprotected.** Free plan cannot allow a deploy key
   to push to a protected branch (that needs the Premium `allowed_to_push` list), and
   GitLab protects a new default branch automatically:

   ```sh
   curl -sSf -X POST -H "$H" "$GL/projects/$S/repository/files/README.md" \
     -d branch=main -d commit_message="Start the staging site" \
     --data-urlencode "content@ops/staging/README.md"
   curl -sS  -X DELETE -H "$H" "$GL/projects/$S/protected_branches/main"
   ```

   Only group members can write to it, and nothing there is source: the next deploy
   replaces it.

4. **Deploy key** with write access to this one repository. Generate it on a
   trusted machine, register the public half, store the private half (base64, one
   line, so GitLab can mask it) in the main project, then delete the files:

   ```sh
   ssh-keygen -t ed25519 -N '' -C scribyra-staging-deploy -f staging-deploy
   curl -sSf -X POST -H "$H" "$GL/projects/$S/deploy_keys" -d title=scribyra-dev-deploy \
     --data-urlencode "key@staging-deploy.pub" -d can_push=true
   base64 -w0 staging-deploy > staging-deploy.b64
   curl -sSf -X POST -H "$H" "$GL/projects/$P/variables" -d key=SCRIBYRA_STAGING_DEPLOY_KEY \
     --data-urlencode "value@staging-deploy.b64" -d masked_and_hidden=true -d masked=true -d protected=true
   shred -u staging-deploy staging-deploy.b64; rm staging-deploy.pub
   ```

   A deploy key reaches only the project it is added to: it cannot read or write
   the main project or anything else. Pipelines started by its pushes run as the
   user who added the key, so add it with the architect's account (Maintainer).
   `deploy-staging` checks the server against the pinned gitlab.com host key in
   `ops/staging/known_hosts` (from GitLab's published fingerprints).

5. **Custom domain, DNS and TLS.** Add the domain with automatic Let's Encrypt
   certificates, read its verification code, create the two DNS records (DNS only,
   not proxied, like `app`), then verify:

   ```sh
   curl -sSf -X POST -H "$H" "$GL/projects/$S/pages/domains" -d domain=dev.scribyra.com -d auto_ssl_enabled=true
   curl -sSf -H "$H" "$GL/projects/$S/pages/domains/dev.scribyra.com"   # verification_code
   CF=https://api.cloudflare.com/client/v4
   curl -sSf -X POST "$CF/zones/$Z/dns_records" -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
     --data '{"type":"CNAME","name":"dev","content":"urundead-labs.gitlab.io","proxied":false,"ttl":1}'
   curl -sSf -X POST "$CF/zones/$Z/dns_records" -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
     --data '{"type":"TXT","name":"_gitlab-pages-verification-code.dev","content":"gitlab-pages-verification-code=<code>","ttl":1}'
   curl -sSf -X PUT -H "$H" "$GL/projects/$S/pages/domains/dev.scribyra.com/verify"
   ```

   | Type | Name | Content | Proxy |
   | --- | --- | --- | --- |
   | CNAME | `dev` | `urundead-labs.gitlab.io` | DNS only |
   | TXT | `_gitlab-pages-verification-code.dev` | the exact value GitLab generated | N/A |

   GitLab issues the certificate after the domain verifies and the first Pages
   deployment exists; check `auto_ssl_failed` is false and `certificate` is present
   in the domain's API response. Do not flatten the `dev` CNAME. The existing
   records (`@`, `app`, their verification TXT records, mail) stay untouched.

6. **First deployment.** Push or merge to `dev` (or run a pipeline on `dev`). Then
   read the staging project's own Pages address (`GET /projects/$S/pages`, field
   `url`, a `*.gitlab.io` address) and set it as `presentation` in
   `ops/pages/domains.staging.json` through a merge request into `dev`.

## On GitHub (after the cut-over)

The same model with pull requests. Workflows: `.github/workflows/checks.yml`
(every pull request into `dev`/`main`: `suite / test`), `staging.yml` (push to
`dev`), `production.yml` (push to `main`, manual redeploy and rollback),
`suite.yml` (the shared suite). Settings, rulesets and secrets:
[github-move.md](github-move.md). The required check is `suite / test`; merges
are merge commits only, threads must be resolved.

| Event | Jobs |
| --- | --- |
| Pull request into `dev` or `main` | `suite / test` (on the merge result) |
| Push to `dev` | `suite / test` with the staging build, then `deploy dev.scribyra.com` (pushes to `scribyra-staging`) |
| Push to `main` | `suite / test`, `deploy app.scribyra.com` (`actions/deploy-pages`), `publish scribyra.com` (pushes to `scribyra-site`), `register release` (GitHub Release `web-N`), `back-merge` |
| `gh workflow run production.yml --ref main` | Same as a push: redeploy as a new release |
| `gh workflow run production.yml --ref main -f release=web-N` | Rollback: rebuild and deploy that tag, no release, no back-merge |
| `gh workflow run staging.yml --ref dev` | Redeploy staging |

**A feature:**

```sh
git fetch origin
git switch -c feature/outline-panel origin/dev
# work, commit
git push -u origin feature/outline-panel
gh pr create --base dev --head feature/outline-panel \
  --title "Add the outline panel" --body "What and why; how it was tested."
```

The pull request title becomes the changelog line (the merge commit message is the
title: "Merge pull request #N from scribyra/feature/…" plus the title). When
`suite / test` passes and threads are resolved, a maintainer merges with
**Create a merge commit** (`gh pr merge --merge --delete-branch`).

**A release:**

```sh
git fetch origin --tags --prune
node scripts/release-changelog.mjs --tests tests.md > release.md   # reads #N and older !N entries
gh pr create --base main --head dev --title "Release $(date +%Y-%m-%d)" --body-file release.md --label release
gh pr merge <number> --merge          # never --delete-branch for dev
```

**A hotfix:** branch from `origin/main`, `gh pr create --base main --label hotfix`,
merge with a merge commit. The push to `main` deploys, registers the release and
opens (or reuses) the pull request `main` → `dev`, label `back-merge`, opened by
`github-actions[bot]`. Its own check run waits for **Approve and run** (events made
with `GITHUB_TOKEN` need approval), but `main`'s commit already carries
`suite / test` from the production run. Merge it with a merge commit. Conflicts:
as on GitLab, resolve on a `backmerge/main-into-dev` branch from `dev` and close the
automatic one. If the job warns that Actions may not open pull requests, run the
printed `gh pr create --head main --base dev …` command.

**A rollback:** `gh workflow run production.yml --repo scribyra/scribyra --ref main -f release=web-N`,
then make it durable with a revert on a `hotfix/` branch. Staging: re-run the
`deploy dev.scribyra.com` job of an earlier `staging` run (its site artifact is
kept 7 days), or merge a revert into `dev`.

**Staging on GitHub** works like the GitLab staging project: `scribyra-staging`
(public: GitHub Pages on the Free plan needs public repositories) receives the site
as `public/` from the `staging` workflow with the `SCRIBYRA_STAGING_DEPLOY_KEY`
deploy key, and its own `pages.yml` (installed once from
`ops/staging/github-pages.yml`; CI never writes it) publishes it. Locally:
`SCRIBYRA_PAGES_FORGE=github node scripts/deploy-staging.mjs .cache/staging --dry-run`
with `SCRIBYRA_STAGING_REPOSITORY` set.

## Upkeep

- GitHub: `scribyra-site` and `scribyra-staging` keep one commit per deployment, like
  the GitLab staging project. GitHub recommends Pages source repositories stay under
  1 GB; when one approaches it, restart its history from a maintainer's machine:
  clone it, `git checkout --orphan fresh && git commit -qm "Restart history"`, and
  push `fresh:main` with `--force` (its ruleset forbids deleting `main`, not force
  pushes). Rotate a deploy key by
  adding a new key, updating the environment secret, then removing the old key.
- The staging repository keeps one commit per staging deployment; identical files
  are stored once, so it grows by the changed files only (mostly the app bundle, and
  about 100 MB when the compiler changes). To start it over, on the runner host:
  `git -C .cache/staging-repo checkout --orphan fresh && git -C .cache/staging-repo commit -qm "Restart staging history"`
  and push `fresh:main` with `--force` using the deploy key, then run housekeeping in
  the staging project (Settings → General → Advanced → Housekeeping).
- The runner keeps `.cache/staging` (the built site) and `.cache/staging-repo`
  (about twice the site size) between jobs.
- Rotate `SCRIBYRA_BACKMERGE_TOKEN` before it expires; a failing `back-merge` job
  with HTTP 401 means it has. To rotate the deploy key, add a new key, update
  `SCRIBYRA_STAGING_DEPLOY_KEY`, then remove the old key.

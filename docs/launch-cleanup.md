# Launch cleanup: making the repository public

At the beta launch the public repository starts fresh: `main` becomes one commit
holding the current tree, and the earlier history moves to a private archive
project. The GitLab project itself stays the same, so Pages, the custom domains
(`scribyra.com`, `app.scribyra.com`), the project runner and the CI settings
carry over unchanged.

The current tree is already clean (the `launch-cleanup` commit): no private host,
network or path details, no credential-handling notes, neutral wording for
decisions, no captured third-party MCP tool schemas, and local agent settings
ignored.

## Setup

Run from a fresh directory with `git`, `glab` (authenticated to gitlab.com as a
project Owner) and `jq`.

```sh
export GITLAB_HOST=gitlab.com
P=urundead-labs%2Fscribyra          # URL-encoded project path for the API
A=urundead-labs%2Fscribyra-archive
SRC=git@gitlab.com:urundead-labs/scribyra.git
ARC=git@gitlab.com:urundead-labs/scribyra-archive.git
```

## Switch day, in order

### a. Archive the full private history and verify it

```sh
# New private project in the same group.
GID=$(glab api groups/urundead-labs | jq .id)
glab api -X POST projects -f name=scribyra-archive -f path=scribyra-archive \
  -f namespace_id=$GID -f visibility=private

# Every branch and tag from GitLab, plus local-only agent branches.
git clone --bare $SRC scribyra-archive.git
cd scribyra-archive.git
git fetch $SRC '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
git fetch <path-to-a-local-clone-with-agent-branches> '+refs/heads/agent/*:refs/heads/agent/*'
git push $ARC --all && git push $ARC --tags
git bundle create ../scribyra-before-launch.bundle --all   # offline copy

# Verify: same branches and tags with the same commit IDs.
diff <(git ls-remote --heads --tags $ARC | sort) <(git for-each-ref --format='%(objectname)	%(refname)' refs/heads refs/tags | sort)
git clone -q $ARC ../archive-check && git -C ../archive-check fsck --full
cd ..
```

Also start a project export, which keeps releases, pipelines metadata and
settings that Git does not hold, and download it once it finishes:

```sh
glab api -X POST projects/$P/export
glab api projects/$P/export | jq .export_status        # wait for "finished"
glab api projects/$P/export/download > scribyra-project-export.tar.gz
```

### b. Merge `launch-cleanup` into `main`

`launch-cleanup` sits directly on top of `main`, so this is a fast-forward.
Freeze all other merges from here until step h.

```sh
git clone $SRC scribyra && cd scribyra
git merge --ff-only origin/launch-cleanup
git push -o ci.skip origin main
```

### c. Create the single public commit

```sh
export GIT_AUTHOR_NAME='Paul Schuldesz' GIT_AUTHOR_EMAIL=paul.schuldesz@urundead.win
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
C=$(git commit-tree 'main^{tree}' -m 'Scribyra beta')
test "$(git rev-parse "$C^{tree}")" = "$(git rev-parse 'main^{tree}')" && echo same-tree
git log --format='%H %an <%ae> %s' -1 $C; git rev-list --count $C    # expect 1
```

Before continuing, run the pattern scan from the agent workspace
(`scratch-cleanup/tools/scan.py . $C`) and expect zero hits apart from the
author identity.

### d. Replace `main`

```sh
glab api -X PATCH projects/$P/protected_branches/main -f allow_force_push=true
git push --force -o ci.skip origin $C:refs/heads/main
glab api -X PATCH projects/$P/protected_branches/main -f allow_force_push=false
glab api projects/$P/protected_branches/main | jq '{allow_force_push, push_access_levels, merge_access_levels}'
```

If the PATCH is refused, unprotect and re-protect instead:
`glab api -X DELETE projects/$P/protected_branches/main`, push, then
`glab api -X POST projects/$P/protected_branches -f name=main -f push_access_level=40 -f merge_access_level=40 -f allow_force_push=false`.

### e. Delete every other branch and tag on the remote

```sh
git ls-remote --heads origin | awk '{print $2}' | grep -vx refs/heads/main \
  | xargs -r -n 20 git push origin --delete
git ls-remote --tags origin | awk '{print $2}' | grep -v '\^{}$' \
  | xargs -r -n 50 git push origin --delete
git ls-remote origin    # expect only HEAD and refs/heads/main
```

Deleting a `web-*` tag also deletes its GitLab release. That is intended: those
releases describe archived commits and pipelines.

### f. Remove what keeps old commits reachable, then prune

Pipelines (`refs/pipelines/*`, job logs, artifacts), merge requests
(`refs/merge-requests/*`) and deployments (`refs/environments/*`) each hold old
commits. Delete them all, then prune.

```sh
for id in $(glab api --paginate "projects/$P/pipelines?per_page=100" | jq '.[].id'); do
  glab api -X DELETE projects/$P/pipelines/$id; done
for iid in $(glab api --paginate "projects/$P/merge_requests?state=all&per_page=100" | jq '.[].iid'); do
  glab api -X DELETE projects/$P/merge_requests/$iid; done
for id in $(glab api "projects/$P/environments?per_page=100" | jq '.[].id'); do
  glab api -X POST projects/$P/environments/$id/stop -f force=true
  glab api -X DELETE projects/$P/environments/$id; done
glab api "projects/$P/pipelines?per_page=1" | jq length                    # expect 0
glab api "projects/$P/merge_requests?state=all&per_page=1" | jq length     # expect 0
glab api -X POST "projects/$P/housekeeping?task=prune"
```

The environments come back on the next deployment. Pages stays published
throughout; deleting pipelines does not unpublish the current deployment.

### g. Check that old commits are gone

```sh
for sha in <old main tip> <a web-* tag commit> <the first commit>; do
  printf '%s ' $sha; glab api projects/$P/repository/commits/$sha >/dev/null 2>&1 && echo STILL-THERE || echo 404; done
```

Take the IDs from the archive (`git -C scribyra-archive.git rev-parse main
web-84`, `git rev-list --max-parents=0 main`). Every one must be a 404. If one is
still served, re-run step f (look for a leftover pipeline, merge request or
environment) and housekeeping, and do not continue until all are 404.

### h. Go public, on the owner's launch instruction only

```sh
glab api -X PUT projects/$P \
  -f public_jobs=false -f builds_access_level=private \
  -f wiki_access_level=disabled -f snippets_access_level=disabled \
  -f container_registry_access_level=disabled -f packages_enabled=false
glab api -X PUT projects/$P -f visibility=public
glab api projects/$P | jq '{visibility, public_jobs, builds_access_level}'
```

`public_jobs=false` stays off permanently: every job on the project runner
prints the runner's host name and local build path. The published tree already
carries the beta wording and the indexing switch: `site/*.html` have no
`noindex` meta, `site/robots.txt` allows crawling (except the `/field-test/` lab
page) and names `site/sitemap.xml`, while staging builds stay `noindex` and
disallow everything. Its first `main` pipeline redeploys Pages and registers the
first public release (`web-<pipeline IID>`; IIDs keep increasing, so no old tag
name is reused).

## Rollback

- **Before step h** (still private): force-push the archive's `main` and push its
  tags back (`git -C scribyra-archive.git push --force $SRC main && git -C
  scribyra-archive.git push $SRC --tags`), with force push allowed as in step d.
  Deleted pipelines, job logs, merge requests and releases do not come back; the
  project export from step a keeps their record.
- **After step h**: set visibility back to private first
  (`glab api -X PUT projects/$P -f visibility=private`), then restore as above.
  Anything already fetched publicly cannot be withdrawn, so step g is the gate.

## Existing clones, worktrees and agent branches

- Every existing clone, including the agent worktrees, keeps the old history
  locally. The new `main` shares no commit with it, so `git pull` fails with
  "unrelated histories".
- **Never push an old branch, tag or `main` from these clones to the public
  project again**: one push republishes the archived history. Point their push
  URL at the archive or disable it:
  `git remote set-url --push origin git@gitlab.com:urundead-labs/scribyra-archive.git`
  (or `no-push`).
- Start new work from a fresh clone. To carry over unfinished work, export it
  as patches (`git format-patch`) or rebuild the branch on the new `main` with
  `git diff old-main..branch | git apply`.
- Links to old commit IDs in notes or issues resolve only in the archive project.

## CI after the switch

The project runner (shell executor with Nix, tag `scribyra-nix`) runs on the agent
host and is registered to this project, so it keeps working. Its build directory
refetches the new `main` on the next job, and its caches (`public/core`,
`target`, `node_modules`, `.cache`) stay valid because the tree is unchanged.
Pages, both custom domains and their certificates stay attached to the project.

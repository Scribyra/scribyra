# GitHub and GitLab plugin

`com.scribyra.github-gitlab`, in the official registry. It links a project to a branch,
and optionally a folder, of a GitHub or GitLab repository. **Pull** brings in the branch's
latest commit after the person reviews every change. **Push** commits the project's
changes as one commit, which only lands if nobody pushed meanwhile.

It talks to the hosts' REST APIs, which answer browsers (CORS), so it needs no Git
protocol, proxy or server. Full Git in the browser, with history, is designed separately
in [git-in-browser.md](git-in-browser.md).

Code:

- `plugins/github-gitlab/src/` holds the plugin:
  - `main.js`: flows and dialogs.
  - `hosts.js`: REST clients.
  - `sync.js`: pull and push plans.
  - `paths.js`: paths, exclusions and the secret scan.
  - `sha1.js`: Git blob ids.
  - `store.js`: device-local data.
- `web/line-diff.js` holds line diffs and the three-way merge, shared with the host.
- The capability API additions it uses are in [plugins.md](plugins.md#capability-api-v1).

Tests:

- `tests/git-sync.test.mjs` covers diff, merge, paths, plans and blob ids.
- `tests/browser/git-sync.spec.js` uses the fakes in `tests/helpers/fake-git-hosts.mjs`.

## Using it

1. **Install.** In a project, open More tools → Plugins → Browse official plugins →
   GitHub and GitLab. Consent shows what it may do:
   - read every file of the open project, including binary files;
   - add, change and delete files in changes the person confirms;
   - contact `https://api.github.com` and `https://gitlab.com`;
   - ask for self-hosted GitLab servers;
   - keep secrets;
   - show dialogs, a More tools item and a status item.
2. **Link.** More tools → GitHub and GitLab → **Link to a repository…** asks for:
   - the host: GitHub, GitLab.com, or a self-hosted GitLab address;
   - the repository (`owner/name` or `group/…/name`; a pasted address works);
   - the branch (default: the repository's default branch);
   - a folder (optional);
   - an access token.

   **Check access** verifies the token, the repository and the branch, and says what the
   token can do. **Link and pull** saves the link and starts the first pull.
3. **Status.** A status item above the project shows `repository[ › folder] · branch ·
   N local changes`. After any contact with the host it also shows `· M new commits on
   GitHub` or `· up to date`. Its tooltip repeats that text, which a narrow window cuts
   short, and gives the last sync time and commit. Its buttons
   are **Pull**, **Push** and **Check**. Check asks the host for new commits without
   changing anything.
4. **Pull** and **Push**, below. More tools → GitHub and GitLab also has:
   - exclusion patterns;
   - "check for new commits when this project opens" (off by default: the plugin contacts
     the host only when asked);
   - **Unlink**;
   - removing saved tokens.

**Projects from Open in Scribyra links.** Such a project records its source
([open-links.md](open-links.md#provenance)). The plugin reads it with `project.source` and
offers **Link to this repository** in the status item, with **Not now**. The link dialog
is then prefilled with the host, repository, ref and folder. The import commit becomes
the last synced commit. The first pull is therefore a true three-way merge against what
was imported, not a comparison of two unrelated trees.

## Tokens: the narrowest that work

The link dialog explains each choice and links to the token page.

| Host | Recommended | To pull only | Why |
| --- | --- | --- | --- |
| GitHub | **Fine-grained personal access token**: Repository access → *Only select repositories* (this one); Repository permissions → **Contents: Read and write**. GitHub adds *Metadata: Read-only* itself. Set an expiry. Create at `https://github.com/settings/personal-access-tokens/new`. | Contents: Read-only | The Git database endpoints (refs, commits, trees, blobs) need Contents read; creating blobs, trees, commits and moving refs need Contents write. Changing `.github/workflows/` would also need Workflows: write; the plugin then reports GitHub's refusal. |
| GitLab | **Project access token** for this project only (project Settings → Access tokens), role **Developer** (Maintainer for a protected branch), scope **`api`**. Alternative: a personal access token with `api`. | `read_api` | GitLab's REST endpoints for the tree, raw blobs, compare and commits accept only `read_api`/`api`. `read_repository` allows the Repository Files API and Git over HTTP. `write_repository` "does not support API authentication", so neither can push from a browser. On GitLab.com, project tokens need a paid tier; there a personal token with `api` is the option, and it reaches all of that person's projects. |

**Check access** reads `/personal_access_tokens/self` on GitLab and warns when a token has
only `read_api`. On GitHub, a token's permissions are not readable, so the dialog says
what pushing needs.

### Where the token goes

The token is saved with `secrets.set {name, value, origin}` as a **bound secret** for the
host's API origin:

- `https://api.github.com`, `https://gitlab.com`, or the self-hosted origin.

From then on the plugin does not hold it:

- It asks the host to authenticate a request with `net.fetch {auth:{secret, header}}`.
- Scribyra adds `Authorization: Bearer …` (GitHub) or `PRIVATE-TOKEN: …` (GitLab) only
  when the request's origin is the bound one.
- `secrets.get` returns `null` for a bound secret.

A plugin bug or a hostile self-hosted server therefore cannot get the GitHub token sent
anywhere but api.github.com.

The token is kept only in `scribyra-plugin-secrets` on this device. The link record
(`projectData`) holds only the account's name. Neither is part of the project, so neither
reaches:

- history, backups, exports or direct sessions;
- diagnostics or telemetry;
- the repository.

The browser spec checks all of these, and checks that every request carrying the token
went to the fake API origin.

## Sync model

The link stores the last synced commit and, per project path, a record:

- `remote`: the blob id in the branch's tree at that commit;
- `base`: the blob id the local file is based on;
- `mode`;
- `hash`: the host's fingerprint of the local file when it equalled `base`;
- `local`: whether the file existed here.

From these, without downloading anything:

- **Local state** comes from comparing fingerprints: unchanged, modified, added, deleted
  or absent.
- **Remote state** comes from comparing the new tree's blob ids with `base`: unchanged,
  added, changed or removed.
- Comparing a local file with a remote blob needs the file's Git blob id:
  `SHA-1("blob <size>\0" + bytes)`, in JavaScript, because the sandbox has no
  `crypto.subtle`.

A record's `base` can lag behind its `remote`. That happens when the person said
**Not now**, or when a change is still a suggestion in Reviewing. That path then counts as
"to pull" and cannot be pushed until it is pulled.

### Pull and conflicts

| Remote | Local | Result |
| --- | --- | --- |
| added/changed | unchanged or absent | **Take theirs**, unless the person picks **Not now** |
| removed | unchanged | **Delete here too**, or Not now |
| added/changed | modified/added | Same content → nothing to do; else **conflict** |
| changed | deleted here | **Conflict** |
| removed | modified | **Conflict** |
| removed | deleted/absent | Nothing to do |

**Three-way merge.** The base is the last synced version of the file, fetched by its blob
id. Local is the project's file. Remote is the new commit's.

The pull dialog lists conflicts first, then changes. Each file shows badges: Added, Changed
or Removed on the host; Changed or Deleted here; Binary. Each file also shows line diffs,
with numbers, `+`/`−` signs and screen-reader labels. For a conflict there are two diffs,
your changes and theirs, both against the base. The choices per file are:

- **Keep mine**: the local version stays and will be pushed next time.
- **Take theirs**.
- **Combine both**: offered only when `merge3` is clean, that is, when the two sides
  changed lines that neither overlap nor touch.
- **Edit the result**: a text area pre-filled with the merge and Git-style markers
  (`<<<<<<< mine (this project)`, `||||||| base (last sync)`, `=======`,
  `>>>>>>> theirs (GitHub)`).
  - Applying is refused while a marker line remains.
  - Binary conflicts offer only mine or theirs.

**Apply selected** is refused until every conflict has a choice. Nothing is overwritten
silently.

When the person applies, the chosen changes go to the host as **one `project.apply`**:

- The host checks each file's fingerprint against what the plugin read. A file edited
  while the dialog was open stops the pull.
- It runs the whole set on a copy of the project first.
- It then applies it in a single transaction.
- Deleted files go to Restore last deletion.

The sync records then advance per path. Taken paths get the new base. Kept-mine paths
also get the new base, so the local version counts as a change to push, and so do combined
or edited results that differ from theirs. Not-now paths keep their old base.

**Modes.**

- **Editing** applies everything.
- **Reviewing**:
  - Text changes to existing files become suggestions in a review called "GitHub and
    GitLab suggestions". They are credited to "GitHub and GitLab (plugin)". The host
    splits each file's change into one suggestion per changed block.
  - Added, deleted and binary files are not applied. The notice lists them as needing
    Editing.
  - Their bases do not advance, so the next pull offers them again. Once a suggestion is
    accepted, the next pull finds the file already equal to theirs.
- **Viewing** refuses pull and push. The status buttons are disabled with the reason, and
  the panel's buttons give the same notice.

**Not synced, and listed in the pull dialog:**

- symbolic links;
- submodules;
- Git LFS pointers;
- files over 16 MiB;
- paths that differ only in letter case from a local file;
- text that is not UTF-8;
- unsafe paths (below);
- excluded paths.

Pull never deletes a local file because the remote has a symlink, submodule or LFS
pointer there.

### Push

1. **Refusal when the remote moved.** Push first reads the branch head. If it is not the
   last synced commit, the push stops: "main on GitHub moved since your last sync
   (abc1234 → def5678). Pull first; Scribyra never force-pushes."
2. **Review.** The push dialog lists every local change since the last sync, with a diff
   against the base, and a box to tick for each.
   - Files whose content holds an access token or private key cannot be ticked. The scan
     covers GitHub `ghp_`/`github_pat_`, GitLab `glpat-`, `-----BEGIN … PRIVATE KEY-----`,
     AWS and Slack key formats.
   - Files whose names look like credentials start unticked: `.env*`, `*.pem`, `*.key`,
     `id_rsa`, `.netrc`, `credentials.json` and similar.
   - Files over 6 MiB cannot be ticked.
   - Files the project stores as binary because their name has no text extension
     (`.env`, `.scribyraignore`, `Makefile`) are shown as a text diff when they are UTF-8
     and at most 1 MiB. They are still pushed byte for byte.
   - Excluded files are listed separately.
   - The commit message is required. The person chooses the linked branch or a new branch
     (validated against Git's ref-name rules).
3. **Commit.**
   - **GitHub** (Git database API):
     - Each binary file becomes a blob (`POST git/blobs`, base64).
     - Text goes inline into `POST git/trees` on `base_tree` = the synced commit's tree, in
       batches of at most 6 MiB, each tree built on the last. A deletion is `sha: null`.
     - Then `POST git/commits` with `parents: [synced commit]`.
     - Then `PATCH git/refs/heads/<branch> {sha, force: false}`. GitHub moves the branch
       only as a fast-forward. If anyone pushed after the check, GitHub answers 422 and
       the branch is unchanged. Our commit stays unreferenced, and the notice says to pull.
     - A new branch is `POST git/refs`.
   - **GitLab** (`POST /projects/:id/repository/commits` with `actions`):
     - Each `update` and `delete` carries `last_commit_id`, read with
       `HEAD repository/files/:path?ref=<synced commit>` (`X-Gitlab-Last-Commit-Id`).
       GitLab refuses the whole commit if someone changed that file meanwhile ("The file
       has changed since you started editing it").
     - A `create` fails if the file appeared.
     - If someone pushed unrelated files in the gap, GitLab applies our commit on top, and
       the plugin sees a parent that is not the synced commit. It then keeps the link at
       the old commit and asks for a pull, so their changes are never taken for synced.
     - A new branch uses `start_sha`.
     - The plugin never sets `force`.
4. **After.** The pushed paths' records take the new blob ids, computed locally. The link
   follows a new branch.

**Size limits.** A plugin request carries at most 8 MiB.

- GitHub: at most 6 MiB per pushed file; there is no total limit beyond the project's
  64 MiB.
- GitLab: a commit is one request, so at most 6 MiB of changed content per push.
- Pulled files: at most 16 MiB each, the host's response limit.
- GitHub trees: refused when truncated, at over 100,000 entries. The plugin lists only the
  linked folder's tree.
- GitLab listings: at most 20,000 entries.

### What is never pushed

- **Comments, reviews and history** are not project files, so they cannot be pushed.
  This is the decision, and it is deliberate:
  - they hold private discussion and other people's identities;
  - their CRDT form is not reviewable in Git;
  - a repository is often more public than a project.

  To share them, use a complete backup.
- **App metadata:**
  - the plugin's link and records;
  - `.scribyra-sync*` state (refused as a path in both directions);
  - `.git/` paths;
  - tokens.
- **Excluded files:** `.scribyraignore` in the project root, with `.gitignore` rules (`#`,
  `!`, trailing `/`, anchoring `/`, `*`, `?`, `**`), plus the link's own patterns. They
  apply to pull and push. `.scribyraignore` itself is an ordinary file and is pushed.
- **Secrets:** see the scan above.

## Paths from remote trees

Every remote path is untrusted. Before use it must pass the project's path rules
(`paths.js` `pathProblem`, mirroring `crates/core` `valid_path`):

- at most 240 UTF-8 bytes;
- no `..`, `.`, empty segment or leading `/`;
- no `\`, `:` or NUL;
- no control, bidirectional or zero-width characters;
- no `.git` or `.scribyra-sync*` segment.

A failing path is listed as refused. Only paths inside the linked folder map to project
paths. The host checks every path again in `project.apply`, with `assertPath`, the Rust
tree command and the copy-first trial.

## Requests

All requests go through the host's fetch proxy: exact granted origins, `https:`,
`credentials: 'omit'`, no redirects, no referrer.

- **GitHub**, on `https://api.github.com`:
  - `GET /user`, `/repos/{o}/{r}`;
  - `/git/ref/heads/{branch}`, `/git/commits/{sha}`, `/git/trees/{sha}[?recursive=1]`;
  - `/git/blobs/{sha}` with `Accept: application/vnd.github.raw+json`;
  - `/compare/{base}...{head}`;
  - `POST /git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`;
  - `PATCH /git/refs/heads/{branch}`.
  - Authenticated limit: 5,000 requests an hour. Rate-limit replies (403/429 with
    `x-ratelimit-remaining: 0` or `retry-after`) become "try again after HH:MM".
- **GitLab**, on `<origin>/api/v4`:
  - `GET /user`, `/personal_access_tokens/self`;
  - `/projects/:id`, `/repository/branches/:b`;
  - `/repository/tree?recursive&pagination=keyset` (following `Link` only within the same
    API), `/repository/blobs/:sha/raw`, `/repository/compare`;
  - `HEAD /repository/files/:path`;
  - `POST /repository/commits`.

A typical pull makes 3 + (files changed) requests. A push makes 2 + (binary files) + (tree
batches) + 2 requests on GitHub, and 2 + (changed files) + 1 on GitLab.

**CORS.** Both hosts allow `Authorization` and `PRIVATE-TOKEN` from any origin without
credentials (GitHub's documented preflight; GitLab's `Rack::Cors` config for `/api/*`).
GitLab exposes `X-Gitlab-Last-Commit-Id`. A self-hosted GitLab works as long as it keeps
GitLab's default API CORS.

**Self-hosted GitLab.** Its origin is not in the manifest. When the person enters it, the
plugin asks with `net.requestOrigin`, and **Scribyra** shows its own dialog: "Allow GitHub
and GitLab to contact gitlab.example.org?", with a warning for local-network addresses.
An allowed origin is kept in the plugin's record and listed in the Plugins manager with
**Remove**.

## Security review

An independent adversarial review (November 22, 2026) covered:

- token handling;
- scope;
- path traversal from remote trees;
- conflict application;
- pushes of unintended files;
- denial of service.

It found no way for the token to reach an origin other than its bound one. It confirmed six
bugs and listed further hardening. All were fixed, with regression tests: in
`tests/git-sync.test.mjs`, in `tests/browser/plugins.spec.js` ("review: change globs…")
and in the specs above.

| Finding | Severity | Fix |
| --- | --- | --- |
| `project.write.change` also widened `project.patch`. A plugin could rewrite any matching file silently, without a dialog. | high | `project.patch` stays limited to owned and picked files. Files reached only through `change` are changed only with `project.apply`. |
| `project.apply` needed only "activation", which any host request gives, for example a status-item button. | medium | `project.apply` needs a click inside the plugin's own dialog in the last minute. One click covers one change set. |
| Revoking `secrets` did not stop the host adding a bound secret to requests. | medium | `net.fetch {auth}` needs `secrets` too. |
| A remote symlink, submodule or large file was forgotten. A local file at that path was then pushed over it on GitHub. | medium | Skipped remote entries are remembered (`skip`), and pushing to such a path is blocked and listed. The same holds for LFS pointers and non-UTF-8 text found on download. |
| Pull and push dialogs could exceed Scribyra's dialog bounds and fail on ordinary files: 2,000-character lines, 6,000 diff lines, 2,000 parts, 200-character labels. | medium | Lines are cut at 1,000 characters. Each dialog spends a budget of 4,000 diff lines. More than 120 files switch to a compact list. Labels are shortened. |
| GitLab protection failed open. A missing `X-Gitlab-Last-Commit-Id` dropped the per-file check. A missing `Link` header cut the file list, so missing files looked deleted. | medium | Both now stop with an explanation. A `Link` to another address is refused. |
| Remote names differing only in case or Unicode form made every pull fail. | low | Skipped as "differs only in letter case". |
| A GitLab blob over 16 MiB aborted the whole pull. | low | Skipped as large, per file. |
| The Myers diff kept every frontier, about 128 MB for a pathological file, on the main thread in Reviewing. | low | Only the reachable window is kept, and at most 1,500 edits before a coarse fallback (about 9 MB). |
| Files stored as binary (`deploy.sh`, `Makefile`) skipped the secret scan. | low | They are decoded and scanned when they are UTF-8. |
| A 6 MiB file encodes to just over the 8 MiB request limit. Escaped JSON could grow text batches past it. | low | The limit is 5.5 MiB per file. Request bodies are measured as the JSON sent. Text over 1 MiB goes as a blob. |

**Hardening, also done:**

- Removing an allowed origin deletes the secrets bound to it, so allowing it again does not
  revive a token.
- `net.requestOrigin` allows one prompt at a time. After a Cancel, it needs a new gesture
  and a 2 s pause.
- The local-network warning now covers `0.0.0.0`, `100.64.0.0/10`, IPv4-mapped IPv6 and
  single-label names. It no longer flags public names such as `fdroid.org`.
- Status text refuses control, bidirectional and zero-width characters.
- Bytes are copied at the host boundary, so a view's whole buffer never travels with it.
- Bound secrets must be printable ASCII, so they are header-safe.
- A header error never echoes the secret.

**Accepted and documented:**

- In Reviewing, a failure part-way through a set of suggestions leaves the earlier ones.
  They are only suggestions, and the next pull offers the rest.
- An imported project's recorded source is shown as recorded. Linking it still checks
  access with the host and, for a new origin, asks.

## Verification results

See [Verification](#verification) at the end.

## Limits

- No history beyond the last synced commit: no log, blame or branch list. Pull is a
  snapshot merge against the last sync, not a Git merge commit. The commits made are
  ordinary single-parent commits.
- Renames are a deletion plus an addition; comments anchored in a renamed file stay with
  the deleted file.
- Line endings and encodings are kept byte for byte. Text that is not UTF-8 is not synced.
- A file's mode is kept (100755 stays executable on GitHub). New files are 100644.
- GitLab's per-file check closes the race for changed files. A concurrent push of
  unrelated files is merged by GitLab and detected afterwards (above).
- The Reviewing flow needs a second pull after suggestions are accepted.
- Real GitHub and GitLab were not contacted. The fakes follow the public documentation;
  error texts the documentation does not give are the ones the hosts are widely seen to
  send.

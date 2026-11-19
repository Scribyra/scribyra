# Open in Scribyra links

A link or badge on a repository that opens Scribyra with that repository imported,
after the person confirms. It is core (no plugin) and works for public GitHub and
GitLab repositories and for any ZIP file whose host allows cross-origin downloads.
Private repositories will come with the Git plugins.

Code: `site/open-link-format.js` (format, shared by the app and the generator page),
`web/open-link.js` (planning, ZIP reading, main-file detection, provenance),
`web/open-link-fetch.js` (network), `web/open-link-dialog.js` (confirmation).
Generator: `site/open.html` (`https://scribyra.com/open.html`). Tests:
`tests/open-link.test.mjs`, `tests/browser/open-link.spec.js` with
`tests/helpers/fake-forges.mjs`.

## Link format, version 1

```
https://app.scribyra.com/#open?repo=github.com/OWNER/REPO
https://app.scribyra.com/#open?repo=github.com/OWNER/REPO&ref=v1.2&path=paper&main=main.tex&name=My%20paper
https://app.scribyra.com/#open?repo=gitlab.com/GROUP/SUBGROUP/PROJECT&ref=main
https://app.scribyra.com/#open?repo=https://gitlab.example.org/GROUP/PROJECT
https://app.scribyra.com/#open?zip=https://example.org/paper.zip&main=paper.tex
```

| Option | Meaning |
|---|---|
| `repo` | `github.com/OWNER/REPO`, `gitlab.com/GROUP/…/PROJECT`, or `https://HOST/GROUP/…/PROJECT` for a self-hosted GitLab. `https://` and a `.git` suffix are accepted. Any host other than github.com is treated as GitLab. |
| `zip` | An `https://` address of a ZIP file (encode `?`, `&` and `#` in it). Exactly one of `repo` and `zip`. |
| `ref` | Branch, tag or commit SHA (Git's ref-name rules). Default: the default branch. Repositories only. |
| `path` | A folder inside the repository or ZIP to import; the rest is ignored. |
| `main` | The main `.tex` file, relative to `path`. Default: detected (below). |
| `name` | The project name (at most 160 characters). Default: the repository name, plus the folder. |
| `v` | Optional; `1`. A future incompatible format uses `v=2`, which this version refuses with “needs a newer version”. |

Values are percent-encoded (`+` is not a space-safe character; write `%2B`). Unknown or
repeated options, `..` or empty path segments, backslashes, control or bidirectional
characters, credentials in addresses, IP-address hosts and local or private network
names (`localhost`, `.local`, `.internal`, `.home.arpa`, …) are refused before anything
else happens. Links are at most 4,096 characters.

**Why a fragment (`#open?…`), not `/open?repo=…`.** Both app addresses are static
GitHub Pages sites. A path such as `/open` needs its own file on the server, and the
same release artifact also serves the presentation site; a query string is sent to
GitHub Pages and Cloudflare with every request. The fragment needs no server route,
works at `https://app.scribyra.com/`, the legacy `/app/` address and offline through
the service worker, is never sent to any server (so hosting logs do not record which
repository someone opened), and matches the existing `#tex=` and `#direct=` links.
The app removes it from the address bar before startup, so reloading does not ask again.

## What happens

1. **Confirmation, no network.** The dialog shows the host, repository, ref, folder,
   main file and project name, with a link to the source page, and says which hosts
   checking will contact. Buttons: **Check repository** (or **Check ZIP file**) and
   **Cancel**. If this browser already imported the same source (same host,
   repository, ref and folder, compared case-insensitively), it offers **Open existing
   copy** and **Import again** instead.
2. **Check.** The browser asks the host for the commit and file list (GitHub) or
   downloads the archive (GitLab, ZIP), then shows the commit, file count, total size
   and everything that will be skipped, grouped by reason. Buttons: **Import**,
   **Import and compile**, **Cancel**.
3. **Import.** Files are downloaded (GitHub) or extracted, checked again, and a new
   local project is created and opened. **Import and compile** then compiles the main
   file; **Import** never compiles. A notice reports anything skipped during download.

Import buttons ignore synthetic (untrusted) clicks. A link can do nothing else: no
option runs a command, changes settings, compiles without the button, or touches
another project.

### Requests

| Source | Check | Import |
|---|---|---|
| GitHub | `GET api.github.com/repos/O/R/commits/{ref or HEAD}` with `Accept: application/vnd.github.sha`; `GET …/git/trees/{sha}?recursive=1`; the root `.gitattributes` from raw.githubusercontent.com if present | `GET raw.githubusercontent.com/O/R/{sha}/{path}` per file, 6 at a time |
| GitLab | `GET /api/v4/projects/{id}`, `…/repository/commits/{ref}`, `…/repository/tree?recursive=true&pagination=keyset&ref={sha}&path=…` (100 per page), `…/repository/archive.zip?sha={sha}&path=…` | extracted from the archive already received |
| ZIP | one `GET` of the address | extracted |

All are simple CORS `GET`s (no preflight) with `credentials: 'omit'` and
`referrerPolicy: 'no-referrer'`. Everything is fetched at the resolved commit, so files
cannot change between check and import.

### What the real hosts allow (checked November 19, 2026)

Unauthenticated requests with `Origin: https://app.scribyra.com`:

- `api.github.com` (commits, git/trees): `Access-Control-Allow-Origin: *`; exposes
  `X-RateLimit-Limit/Remaining/Used/Reset/Resource`, `Retry-After`, `Link`, `ETag`.
  Limit 60 requests an hour per IP (`x-ratelimit-limit: 60`, resource `core`).
- `raw.githubusercontent.com`: `Access-Control-Allow-Origin: *`; not counted against
  the API limit.
- `codeload.github.com` (the zipball that `/zipball` redirects to):
  `Access-Control-Allow-Origin: https://render.githubusercontent.com` only, so a
  browser on another origin cannot read it. Hence trees + raw.
- `gitlab.com/api/v4` (project, commits, tree, `files/…/raw`, `repository/archive.zip`):
  `Access-Control-Allow-Origin: *`; exposes `Link`, `X-Total*`, `X-Next-Page`, but
  **not** the `RateLimit-*` headers or `Retry-After` (unauthenticated API limit 500 a
  minute, `throttle_unauthenticated_api`). The tree has no sizes; the archive has a
  single top folder `<project>-<ref>-<sha>[-<path>]/` and is streamed without
  `Content-Length`.

Not verified: what a throttled gitlab.com reply (429) looks like cross-origin. The app
handles both a readable 429 and a failed request with the same message.

### Limits and skipped content

| Rule | Behaviour |
|---|---|
| 512 files, 64 MiB (the project bounds) | If the total is over 64 MiB, the largest non-source files are skipped first and listed; if the sources alone exceed it, or there are more than 512 files, the import is refused with a hint to use `path=`. |
| Files over 16 MiB | Skipped and listed. |
| Archives over 96 MiB, listings over 20,000 entries, GitLab folders over 4,096 entries, truncated GitHub trees | Refused. |
| Git LFS | Pointers are reported, not imported: predicted from the root `.gitattributes` (`filter=lfs`) on GitHub, read from small archive entries on GitLab/ZIP, and checked again on every download. |
| Submodules, symbolic links | Reported as not imported (Git modes `160000`, `120000`; Unix link mode in ZIPs). |
| Unsafe names | `..`, absolute paths, backslashes, drive letters, control characters, names that are not UTF-8, `.git/` and `.scribyra-sync` content are refused and listed. Names that differ only by case or Unicode normalization refuse the import. |
| ZIP layout | Encrypted entries and unsupported compression are skipped; ZIP64, split archives, duplicate names and damaged directories are refused. Each entry is inflated in 4 KiB steps and refused as soon as it produces more than its declared size, so a ZIP bomb never expands. |
| Text | `.tex`, `.bib`, `.sty`, `.cls` and other text extensions must be UTF-8; others are skipped and reported after download. Everything else is imported byte for byte as binary. |
| `.gitattributes` | Never applied: no LFS smudge, `eol` or `working-tree-encoding` conversion. GitLab archives honour `export-ignore`; such files are reported as left out. |
| Rate limits | GitHub: “GitHub allows 60 requests an hour from your network without signing in… Try again after HH:MM (in about N minutes)”, from `x-ratelimit-reset` or `Retry-After`. GitLab: “limiting requests… try again in a minute or two”. **Try again** stays available. |

### Main file

`main=` wins when that file was imported. Otherwise Scribyra picks among `.tex` files
containing `\documentclass` and `\begin{document}` outside comments: non-`standalone`
classes first, then the shallowest, then `main.tex`, then alphabetical order. If none
is found the project has no main file and **Import and compile** does not compile.

## Provenance

The project keeps `meta.importSource`:

```json
{"version":1,"kind":"github","host":"github.com","repo":"o/r","url":"","ref":"main",
 "commit":"<sha>","path":"paper","main":"main.tex","archiveSha256":"","importedAt":1795000000000}
```

(`url` and `archiveSha256` for ZIP links.) Public facts only: never tokens, cookies or
the person's identity. It travels with backups and local tabs; a direct-session peer
can send it only with a well-formed value and only to an empty project
(`web/replication.js`). Future Git plugins can offer to link the project to that
repository for pulling and pushing. Separately, this browser keeps
`scribyra:open-links:v1` in local storage (source → project IDs) for **Open existing
copy**.

Privacy: [privacy page](../site/privacy.html), “Things only you can start”. Telemetry:
none ([telemetry](telemetry.md)).

## Badge and generator

`https://scribyra.com/badge.svg` (light), `badge-dark.svg`, and shields-style
`badges/flat.svg`, `badges/flat-square.svg`, `badges/for-the-badge.svg`. Each SVG has a
`<title>` and `aria-label` “Open in Scribyra”. Markdown:

```markdown
[![Open in Scribyra](https://scribyra.com/badge.svg)](https://app.scribyra.com/#open?repo=github.com/OWNER/REPO)
```

`https://scribyra.com/open.html` builds the link from a pasted repository page (it
understands `/tree/REF/DIR`, `/blob/REF/FILE.tex`, GitLab `/-/tree/…`, `git@` clone
addresses and `.zip` addresses) and gives Markdown, HTML and reStructuredText snippets
with copy buttons and a preview. It runs entirely in the page and contacts nothing.

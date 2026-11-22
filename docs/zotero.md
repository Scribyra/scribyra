# Bibliographies and Zotero

Milestone 9 starts with references. A person can import a `.bib` file from any
reference manager, or link a project file to a Zotero library and refresh it later.

**Since November 19, 2026, Zotero is a plugin** (`plugins/zotero`, [plugins.md](plugins.md)).
Install it from **More tools** → **Plugins** → **Browse official plugins**. Its
behaviour is unchanged. It runs in the plugin sandbox and holds only the permissions
its manifest lists:

- read `*.bib`, `*.tex` and `*.ltx` in the open project;
- create `*.bib` files and change only those it created;
- contact `https://api.zotero.org` only;
- device-only secrets;
- dialogs, a More tools item, tree actions and the bar above linked files;
- citation suggestions.

**Import bibliography…** stays built in (`web/bibliography-import.js`). Checking and
importing a `.bib` file is ordinary file import: it works with any reference manager,
offline, contacts nobody and needs no secret, so it is core and not a plugin.

When someone who used the built-in Zotero updates, `web/plugin-migration.js` acts on
start, and only if the old `scribyra-zotero` database exists:

1. It installs the official Zotero plugin from the bundled, signed registry.
2. It moves the keys into the plugin's secrets, the links into its per-project data,
   and the linked files into its ownership.
3. It deletes the old database and says so in a notice.

The links keep working. The browser tests check that with data in the old format.

## Import a bibliography

In the file tree's menu (right-click the project root or a folder, or its **⋯**
button), choose **Import bibliography…** and pick one or more `.bib` files: BibTeX,
BibLaTeX, a Zotero export or a Better BibTeX export. Dropping a `.bib` file on the
tree, or uploading one, runs the same check.

- The file is imported byte for byte, so citation keys stay exactly as written
  (`web/bibtex.js` only reads). A leading UTF-8 byte-order mark is dropped.
- Before importing, Scribyra reads every entry the way BibTeX does and lists
  problems with their line numbers: unclosed entries, missing commas between
  fields, missing or uncitable keys, duplicate keys, fields without a value,
  unmatched braces or quotation marks (errors), and duplicate fields or undefined
  `@string` macros (warnings). Reading resumes at the next line starting with `@`,
  so one broken entry does not hide the rest. The person chooses **Import anyway**
  or **Cancel import**.
- A name already in use gets a free one (`refs.bib` → `refs-2.bib`), and the notice
  says so. Importing contacts nobody.

## Link to Zotero

**Link to Zotero…** (tree menu, or **More tools** → **Zotero**, both added by the plugin) creates a new `.bib`
file filled from a Zotero library:

1. The person enters their Zotero user ID or username and an API key. The dialog
   links to [zotero.org/settings/keys](https://www.zotero.org/settings/keys) and
   explains the scope: a private key with only **Allow library access**, no write
   or notes access, and **Read Only** for groups. **Check key** asks
   `GET /keys/current`; the key must belong to the entered account. A key with write
   access works, with a note that a read-only key is safer.
2. They choose **My Library** or a group the key can read (`GET /users/<id>/groups`),
   optionally a collection (`GET <library>/collections`, shown as paths such as
   `Thesis › Chapter 2`), the format (BibLaTeX for biblatex/Biber, or BibTeX), and
   the new file's name (`zotero.bib` by default).
3. **Link and import** fetches every top-level item as Zotero's own export
   (`<library>[/collections/<key>]/items/top?format=json&include=biblatex&itemType=-attachment`,
   100 per page, following `Link: rel="next"`). Notes have no export and are
   skipped. If the library version changes between pages, the fetch restarts.
   Entries are written sorted by key behind a two-line comment header; duplicate
   generated keys get `a`, `b`, … as Zotero does. The library version
   (`Last-Modified-Version`) is remembered.

The file is an ordinary project file: it compiles, works offline, enters history,
exports and replicates like any other. A bar above it shows the link and a
**Refresh from Zotero** button. `\cite{` completion reads it like any `.bib` file
and shows author, year, title and file.

### Where the key lives

Keys and links are kept by Scribyra for the Zotero plugin only, apart from projects
(`scribyra-v1`); the plugin itself has no storage of its own (`plugins/zotero/src/store.js`):

| Where | Contents |
| --- | --- |
| `scribyra-plugin-secrets`, secret `key-<userID>` | the API key |
| `scribyra-plugins`, plugin storage `accounts` | Zotero user ID, username, whether the key can write |
| `scribyra-plugins`, project data `link:<fileId>` | library, collection, format, library version, and per Zotero item the citation key, entry and version last written |

No other plugin can read them: the host keys them by the plugin's id from its own
record.
A link record refuses to hold a key. Nothing here is part of a project, so the key
never reaches project storage, history, `.scribyra-backup` files, source ZIPs,
direct sessions, diagnostics or telemetry. **More tools** → **Zotero** lists linked
files (**Refresh**, **Unlink**) and saved keys (**Remove key**). Deleting a project
removes its links on this device. Uninstalling the plugin removes its keys and links.
Clearing site data removes everything.

Because links are device-local, a linked file exported, restored or opened on
another device is an ordinary `.bib` file there until it is linked again.

### Where requests go

Only `https://api.zotero.org`, from the browser, when the person links or refreshes
(`plugins/zotero/src/api.js`). The origin is a constant in the plugin, and a pagination
link to any other host stops the fetch. The host's fetch proxy also refuses any other
origin, and the sandbox has no network access of its own. Requests send `Zotero-API-Version: 3` and `Zotero-API-Key`, omit
cookies and the referrer, refuse redirects and are not cached. The service worker
ignores cross-origin requests. `Backoff` and `Retry-After` are honoured, and 403,
404, 429 and 503 are explained in plain words. The privacy page lists Zotero under
things only the person can start.

## Refresh from Zotero

Refresh is a three-way merge by Zotero item key (`plugins/zotero/src/sync.js`). The base is
what Scribyra last wrote for each item.

1. `GET …/items/top?format=versions&itemType=-attachment` with
   `If-Modified-Since-Version: <remembered version>`. `304 Not Modified` means
   **up to date**; no other request is made. Otherwise the answer lists every item
   still in the library or collection, so trashed items and items removed from the
   collection are seen as removed (the `since`/`deleted` pair would miss collection
   membership changes).
2. Items whose version moved past the base, and new ones, are fetched with
   `itemKey=…` (at most 50 per request).
3. Each entry is compared with the base on both sides, ignoring layout and field
   order. Changed only in Zotero: take Zotero's. Changed only here: keep the file's.
   Changed on both: a conflict. Entries the person added by hand, comments and
   ordering are never touched; edits are applied as exact text patches.

If the person edited the linked file since the last refresh, or a removal would
leave a `\cite` without an entry, the **Refresh from Zotero** dialog shows every
added, changed and removed entry with a field-by-field table (this file / Zotero)
and a choice per entry. Conflicts default to this file's version; removing a cited
entry defaults to keeping it. **Keep all of this file** and **Cancel** are always
there; nothing changes until **Apply choices**. Kept entries record Zotero's
version as seen, so the same change is not offered again. Without local edits the
changes apply directly and the notice counts them.

**Stable citation keys.** Entries are tracked by item key, not citation key. When
Zotero's generated key changes (for example after a title edit), the old key stays
if any `.tex` file cites it, or if the person chose their own key; otherwise the
entry follows Zotero. A key renamed in the file is recognised by its unchanged
content and kept. A key that would collide with another entry gets a suffix. After
applying, the notice lists cited keys that no bibliography defines any more.

**Offline.** Refresh checks `navigator.onLine` first and says that refreshing needs
a network connection while the file stays usable. A failed request says Scribyra
could not reach api.zotero.org and that nothing changed.

## Modes

| | Editing | Reviewing | Viewing |
| --- | --- | --- | --- |
| Import bibliography | yes | no | no |
| Link to Zotero | yes | no | no |
| Refresh from Zotero | yes | no | no |
| Unlink, remove key | yes | yes | yes |

Reviewing records suggestions that someone accepts line by line. An import creates
a file, which the tree already refuses in Reviewing, and a refresh replaces many
entries at once after its own per-entry review; turning it into a set of suggestions
would ask a reviewer to re-decide choices the person already made in the diff.
So both are editor-only. The menu items and the bar button are disabled with the
reason. The plugin refuses them with the same messages if they are reached another way,
and the host independently refuses plugin writes in Viewing and plugin-created files in
Reviewing. Unlinking and removing a key
change only this device.

## Telemetry

Zotero adds no telemetry operation. The Zotero plugin sources, its built package and
the plugin host never call the recorder (`tests/telemetry-consent.test.mjs`). The file changes a refresh makes go through
the local-only `command` and `storage_commit` operations like any edit.

## Verification

Unit tests (`tests/zotero.test.mjs`, part of `npm test`) cover the reader and its
problem reports, cite-key extraction, fingerprints, the merge (no local edits,
conflicts in both directions, hand-made entries, cited and uncited key changes,
local renames, deletions, collisions, repeatability) and the API client against the
fake server over HTTP (headers, paging, conditional versions, 50-key batches, 403,
404, 429, offline, foreign pagination links).

`tests/helpers/fake-zotero.mjs` implements the endpoints above from the
[Web API v3 documentation](https://www.zotero.org/support/dev/web_api/v3/basics)
and [syncing guide](https://www.zotero.org/support/dev/web_api/v3/syncing): keys,
groups, collections, items with `format`, `include`, `itemKey`, `itemType`, `since`,
`limit`/`start`, `Link`, `Total-Results`, `Last-Modified-Version`,
`If-Modified-Since-Version`, trash, 403/404/429. Its CORS headers copy what
api.zotero.org sent to one anonymous preflight on November 17, 2026 (no key, no
library data). Tests never contact Zotero.

`tests/browser/zotero.spec.js` runs in Chromium, Firefox and WebKit. An init script
sends the app's `https://api.zotero.org` requests to the fake on another loopback
port, so they are real cross-origin requests checked by the browser; a fake without
CORS headers is blocked in all three engines. Chromium and Firefox send preflights
to the fake; Playwright's WebKit does not, though it still enforces the response
headers. The specs link a collection, check the file, the bar and `\cite{`
completion; refresh with a conflicting local edit, a cited key that Zotero renames,
an addition and a cited removal, choose per entry, refresh again (304), cancel, and
keep all; refresh without edits, offline and rate-limited; refuse in Viewing and
Reviewing; remove the key and unlink; import malformed and clean `.bib` files by
menu and by drop.

Since the plugin port, each test first installs the official plugin through the Plugins
manager and its consent dialog. The import test installs nothing, because import is
built in. Two more tests cover the update:

- data in the built-in format moves into the plugin and keeps refreshing;
- a browser that never used Zotero installs and fetches nothing.

The tests search every IndexedDB database except `scribyra-plugin-secrets`, plus
`localStorage`, `sessionStorage`, the source ZIP, the complete backup and Diagnostics,
for the key. They also check that only requests to the fake carried it.

Results on November 17, 2026 (built in): unit tests 18/18; the six Zotero browser tests pass in all three engines, and with `workspace`, `editor`, `accessibility`, `menus` and `pages-domains` 40/40 per engine. Screenshots of the link dialog, the refresh diff, the linked file and the import report in light and dark were reviewed during development.

Results as a plugin, November 19, 2026: the eight Zotero browser tests pass in all three engines. See [plugins.md](plugins.md#verification-results) for the full counts.

Not covered: the real api.zotero.org from a browser (the shapes come from the
documentation and one header probe), very large libraries beyond the 10,000-entry
page cap, and the Zotero desktop connector or local API.

## Next

Group libraries are supported for reading; per-group key scopes are taken from
`/keys/current`. Next steps: linking an existing `.bib` file, carrying a link in the
project so collaborators can refresh with their own keys, the Zotero desktop local
API (`localhost:23119`) for offline libraries, and attachment access, tested
separately as the roadmap requires. The plugin system will expose bibliography
sources through the same import, merge and review steps.

# Plugins

Milestone 9 makes Scribyra extensible without giving extensions the app's authority.
A plugin is a small package someone installs in their browser. It runs in a sandbox
that has no access to the app's origin, and it can do only what its manifest declares
and the person agreed to. Zotero is the first plugin. It used to be built in
([zotero.md](zotero.md)).

Summary:

- **Packages** hold a versioned manifest and code (JavaScript, optionally with
  WebAssembly).
- **Sources.** Packages come from the **official registry**, a signed static index
  published with the site. In **developer mode**, a package can also be sideloaded
  from a URL.
- **Sandbox.** Code runs in a dedicated Web Worker inside a sandboxed, opaque-origin
  iframe with a deny-all Content Security Policy. It reaches the app only through
  **capability API v1**, a versioned message protocol on a private `MessagePort`.
- **Checks.** The host checks every call against the granted permissions, the open
  project, the person's mode (Viewing, Reviewing, Editing) and, later, the
  organisation's allow-list.
- **UI.** Plugin UI is declarative. The app renders it with its own theme, focus
  handling and accessibility.
- **Consent.** Nothing runs unless it is installed and enabled. Installing shows the
  permissions and asks. An update that adds permissions asks again. Permissions can
  be revoked. Uninstalling removes the plugin's data and secrets. Nothing is fetched
  from a registry until the person opens the plugin browser.

These defaults are deliberate and easy to change; see [Open decisions](#open-decisions).

## Modules

| File | Role |
| --- | --- |
| `web/plugin-manifest.js` | Pure. Validates manifests and packages, normalises permissions, compares permissions between versions, matches file globs, describes permissions in plain words, evaluates the organisation policy. |
| `web/plugin-registry.js` | Pure. Canonical JSON, registry signature check (ECDSA P-256 / SHA-256, WebCrypto), package integrity (SHA-256). |
| `web/plugin-store.js` | IndexedDB `scribyra-plugins`: installed plugins, packages, grants, per-plugin and per-project data, file ownership. IndexedDB `scribyra-plugin-secrets`: device-only secrets. |
| `web/plugin-sandbox.js` | Builds the sandbox iframe, its worker and the runtime the plugin sees (`scribyra` global). |
| `web/plugin-host.js` | The capability API: one instance per running plugin, with every check. |
| `web/plugin-ui.js` | The declarative dialog renderer, the consent dialog and the **Plugins** manager. |
| `web/plugin-catalog.js` | The bundled official registry and its packages, loaded only when the plugin browser opens. |
| `web/plugin-migration.js` | Moves the built-in Zotero's keys and links into the Zotero plugin. |
| `plugins/zotero/` | The Zotero plugin's source. `plugins/dist/` holds the built packages and the signed registry. |
| `scripts/plugins.mjs` | Builds, packs, signs and verifies plugin packages and the registry. |
| `templates/plugin-js/`, `templates/plugin-rust/` | Starting points for plugin authors. |

## Package and manifest

A package is one JSON file, `<id>-<version>.scribyra-plugin.json`:

```json
{
  "format": "scribyra-plugin",
  "formatVersion": 1,
  "manifest": { "...": "see below" },
  "files": { "main.js": "…source text…" },
  "binary": { "engine.wasm": "…base64…" }
}
```

A single file keeps integrity simple: one SHA-256 covers everything that will run.
The installed package is stored in IndexedDB, so it runs offline and stays exactly
the version the person accepted (**version pinning**). Nothing updates by itself.

### Manifest v1

```json
{
  "manifestVersion": 1,
  "id": "com.scribyra.zotero",
  "name": "Zotero",
  "version": "1.0.0",
  "publisher": "Scribyra",
  "description": "Link a .bib file to a Zotero library and refresh it.",
  "homepage": "https://scribyra.com/plugins/zotero",
  "api": 1,
  "main": "main.js",
  "permissions": {
    "project.read": { "files": ["*.bib", "*.tex", "*.ltx"] },
    "project.write": { "create": ["*.bib"], "pick": false },
    "network": ["https://api.zotero.org"],
    "secrets": true,
    "ui.dialog": true,
    "ui.command": true,
    "ui.fileAction": true,
    "bibliography": true
  },
  "contributes": {
    "commands": [{ "id": "open", "label": "Zotero", "hint": "Link a library, refresh, keys" }],
    "fileActions": [
      { "id": "link", "label": "Link to Zotero…", "hint": "Creates a .bib you can refresh",
        "icon": "link", "when": { "target": "folder" }, "modes": ["editing"] },
      { "id": "refresh", "label": "Refresh from Zotero", "icon": "restore",
        "when": { "target": "file", "tag": "linked" }, "modes": ["editing"] }
    ]
  }
}
```

Validation is strict. Unknown fields and unknown permissions are errors, so a manifest
cannot ask for something the consent dialog would not show. The rules:

- `manifestVersion` must be `1`. A later manifest version is refused with "needs a
  newer Scribyra".
- `id` is reverse-DNS: lowercase letters, digits and hyphens, at least two segments,
  at most 64 characters.
  - `com.scribyra.*` is reserved for the official registry. A sideloaded package
    cannot claim an official id, and cannot replace an installed plugin from another
    source.
- `version` is semantic versioning (`major.minor.patch`, optional pre-release).
- `api` is the capability API major version. This build speaks `1`.
- `main` names a file in `files`. The worker runs it as a classic script, so a
  module-based plugin is bundled first (the templates do this).
- `name` is at most 40 characters, `publisher` at most 60 and `description` at most
  300. `homepage` must be an `https:` URL.
- Labels in `contributes` are at most 60 characters. There are at most 8 commands and
  12 file actions.
- Package size is limited to 4 MiB.

### Permissions

| Permission | Shape | What it allows | Shown at install as |
| --- | --- | --- | --- |
| `project.read` | `{files: [glob…]}` | List and read text files of the **open project** whose path matches a glob. Never other projects, binary assets, history, comments, or the project list. | "Read files in the open project matching *.bib, *.tex, *.ltx" |
| `project.write` | `{create: [glob…], pick: bool}` | Create files whose path matches `create`. Change only files it created, or files the person picked for it (`pick`). Respects modes. | "Create *.bib files and change the files it created" |
| `network` | `["https://host[:port]"]` | Requests through the host's fetch proxy to exactly these origins. `https:` only. No wildcards, credentials or redirects. | "Contact https://api.zotero.org" |
| `secrets` | `true` | Device-only storage for keys and tokens, for this plugin only. | "Keep secrets such as API keys on this device" |
| `ui.dialog` | `true` | Open dialogs described declaratively and rendered by Scribyra. | "Show dialogs" |
| `ui.command` | `true` | Add the items in `contributes.commands` to **More tools**. | "Add items to More tools" |
| `ui.fileAction` | `true` | Add `contributes.fileActions` to the file tree menu. Tag files and show a bar above a file it can read. | "Add actions to the file tree and a bar above its files" |
| `completion` | `true` | Contribute command and environment names to LaTeX completion. | "Suggest LaTeX commands while you type" |
| `bibliography` | `true` | Contribute citation records (key, author, year, title) to `\cite{` completion. | "Suggest citations while you type" |

Every plugin can always do these, with no permission:

- Keep its own non-secret settings on this device (`storage`, 1 MiB).
- Keep data for the open project on this device (`projectData`, 4 MiB per project).
- Show a short notice.
- Learn the mode, whether a project is open, the active file's id (only if it can read
  that file), and whether the device is online.

`ui.panel` (a sandboxed iframe for rich UI) is reserved. Version 1 rejects it with a
clear error until a plugin needs more than declarative dialogs.

## Sandbox

**Choice: a Web Worker inside a sandboxed, opaque-origin iframe.** Neither half is
enough alone:

- A **Worker** created by the app runs in the app's origin, even when started from a
  `blob:` URL. It could open `scribyra-v1`, read every project and send cookies.
- A **sandboxed iframe** (`sandbox="allow-scripts"`, no `allow-same-origin`) gets an
  opaque origin. That means no IndexedDB, Cache Storage, localStorage, cookies or
  access to the parent's DOM. But its document has a DOM, and so has WebRTC
  (`RTCPeerConnection` can reach STUN servers that CSP does not cover), `<a ping>`,
  nested frames and self-navigation.

So the host creates, per plugin, an `<iframe sandbox="allow-scripts" srcdoc=…>`:

- It is hidden, `aria-hidden` and outside the tab order.
- Its document carries a Content Security Policy in a meta tag:
  `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; form-action 'none'; base-uri 'none'`.
- Its only script is Scribyra's bootstrap. The bootstrap accepts exactly one message
  from `parent`: the plugin code and a `MessagePort`. It starts a **dedicated Worker**
  from a `blob:` URL and hands it the port.

The plugin's code runs only in that Worker. It has no DOM and no WebRTC. Its origin is
opaque (`self.origin === "null"`), so `indexedDB` and `caches` raise `SecurityError`.
It inherits the CSP, so `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
`WebTransport` and `importScripts` from any host fail. `'wasm-unsafe-eval'` lets it
compile WebAssembly; `eval` and `new Function` are not allowed.

As a second layer, the runtime deletes those globals and `Worker`/`SharedWorker`
before the plugin's code runs. The browser tests check both layers in Chromium,
Firefox and WebKit.

`srcdoc` keeps the sandbox inside the app bundle. It works offline, on the
root-domain shell and on GitHub Pages, which cannot send headers. If the app adds its
own CSP later, `srcdoc` inherits it as well, which can only restrict the sandbox
further. The app's CSP would then need `frame-src 'self'` (for `about:srcdoc`) and
`worker-src blob:`.

The only channel is the `MessagePort`. The host never listens to `window` messages
from plugins, and each port belongs to one plugin instance, so a plugin cannot speak
as another. Disabling, uninstalling, closing a project or a plugin error removes the
iframe, which ends its worker immediately.

## Capability API v1

Every message is structured-cloneable JSON:

```js
// plugin → host, request
{ scribyra: 1, type: 'request', id: 7, method: 'project.read', params: { fileId: 'f1' } }
// host → plugin, response
{ scribyra: 1, type: 'response', id: 7, result: { id: 'f1', path: 'refs.bib', text: '…' } }
{ scribyra: 1, type: 'response', id: 7, error: { code: 'permission_denied', message: '…' } }
// host → plugin, event (no reply)
{ scribyra: 1, type: 'event', event: 'project.opened', data: { transient: false } }
// host → plugin, request the plugin answers (UI callbacks)
{ scribyra: 1, type: 'request', id: 'h3', method: 'fileAction.run', params: { action: 'link', fileId: null, directory: 'refs/' } }
```

Rules on every call:

- The host rejects messages that are not this shape and methods it does not know.
- Every message's data is measured by a bounded walk before anything else. Only plain
  JSON data is accepted (bytes only for `net.fetch` bodies), up to 8 MiB. A typed array,
  `Map` or other object is refused at once, so a plugin can neither freeze the page by
  making the host serialise something huge nor pass large data as small.
- At most 64 requests can be in flight per plugin. More are refused with
  `rate_limited`.
- A plugin's answer to a host request (for example `fileAction.run`) times out after
  10 minutes, so a dialog that stays open is fine.
- Calls that redraw are paced to one every 50 ms per plugin: `ui.files.decorate`,
  `ui.dialog.update`, `bibliography.set` and `completion.set`. The app redraws for
  plugins at most once per frame.
- Notices are shown as "<Plugin>: text", with at most 30 per 10 seconds per plugin.
- **Activation.** Opening a dialog or a file picker, and switching the open file,
  require activation. Activation comes only from the person's gestures: choosing the
  plugin's command, menu item or bar button, or clicking or changing something in its
  dialog. It lasts one minute.
  - Pending requests, Escape and dismissal do not extend it.
  - After the person uses **Dismiss**, the plugin cannot open a dialog again until a new
    gesture, and not for at least 2 seconds.
  - The **Dismiss** button is drawn by Scribyra, so it always works.

The runtime wraps this in the `scribyra` global:

```js
scribyra.call(method, params, {signal})   // a request; resolves to result, or throws an Error with .code
scribyra.on(event, handler)               // events
scribyra.handle(method, handler)          // answer host requests
scribyra.files                            // the package's own files: text or Uint8Array (WASM)
```

### Methods (plugin → host)

| Method | Needs | Params → result |
| --- | --- | --- |
| `app.context` | — | → `{api:1, mode, project:{open, transient, activeFileId}|null, online}` |
| `ui.notify` | — | `{text}` (≤ 500 chars) → `{}`; shown in the workspace notification |
| `storage.get` / `set` / `delete` / `keys` | — | `{key[, value]}`; JSON values; 1 MiB per plugin |
| `projectData.get` / `set` / `delete` / `keys` | open project | the same, for this plugin and the open project only; 4 MiB per plugin per project |
| `project.files` | `project.read` | → `[{id, path, owned}]` for readable text files only |
| `project.read` | `project.read` | `{fileId}` → `{id, path, text}` |
| `project.freePath` | `project.write` | `{path}` → a free path like `zotero-2.bib`; the path must match `create` |
| `project.create` | `project.write` | `{path, content}` → `{id, path}`; path matches `create`; Editing only |
| `project.patch` | `project.write` | `{fileId, edits:[{start, end, before, after}]}` → Editing `{applied}`; Reviewing `{suggested, reviewId}`; Viewing refused |
| `project.pick` | `project.write.pick` | `{title, files:[glob]}` → `{id, path}` or `null`; the person chooses; grants read and write to that file |
| `project.activate` | readable file | `{fileId}` → `{}`; opens the file in the editor |
| `secrets.get` / `set` / `delete` / `keys` | `secrets` | `{name[, value]}` (strings ≤ 4 KiB, ≤ 32 names) |
| `net.fetch` | `network` | `{url, method?, headers?, body?, requestId?}` → `{status, statusText, headers:[[k,v]], body}` |
| `net.abort` | `network` | `{requestId}` |
| `ui.dialog.open` / `update` / `close` | `ui.dialog` | `{spec}` → `{dialogId}`; `{dialogId, spec}`; `{dialogId}` |
| `ui.files.decorate` | `ui.fileAction` | `{fileId, tags:[…], bar:{label, text, actions:[{id,label,title,modes}]} \| null}` on a readable file |
| `bibliography.set` | `bibliography` | `{entries:[{key, type?, author?, year?, title?}]}` (≤ 20,000) |
| `completion.set` | `completion` | `{items:[{kind:'command'\|'environment', name, detail?}]}` (≤ 2,000) |

### Host → plugin

| Kind | Name | Data |
| --- | --- | --- |
| event | `project.opened`, `project.closed` | `{transient}` / `{}` |
| event | `project.activeFile` | `{fileId}`, or `null` if the plugin cannot read it |
| event | `project.mode` | `{mode}` |
| request | `command.run` | `{command}`: a `contributes.commands` id |
| request | `fileAction.run` | `{action, fileId, directory}`. `fileId` is `null` for the tree root and is given only if readable; `directory` is the folder path the action was chosen on |
| request | `fileBar.run` | `{action, fileId}` |
| event | `dialog.event` | `{dialogId, type:'click'\|'change'\|'cancel', control, values:{controlId:value}}` |

### Enforcement points

1. **Install and update** (`plugin-manifest.js`, `plugin-registry.js`). The manifest
   must be valid. An official package must match the signed registry's SHA-256. The
   organisation policy must allow it. The person consents to the permissions shown.
2. **Start** (`plugin-host.js`). Only installed, enabled and policy-allowed plugins
   start, and only while a project is open. Only the code stored at install runs.
3. **Every call** (`plugin-host.js`).
   - The method must be known. Its permission must be granted and not revoked.
   - Paths must match the globs. File ids must be live text files of the open project
     that match `project.read`. Writes are limited to owned or picked files.
   - The mode decides writes: Viewing refuses all writes. In Reviewing, patches become
     suggestions credited to the plugin, and `project.create` is refused, as the tree
     refuses it.
   - A transient TeX-link project refuses writes and `projectData`.
   - Calls are refused once the project the plugin was started for has closed.
4. **Network** (`net.fetch` in the host).
   - The URL's origin must be exactly one granted origin. The scheme must be `https:`;
     `http://127.0.0.1` is accepted only for sideloaded development plugins whose
     manifest lists it.
   - Requests go out with `credentials:'omit'`, `referrerPolicy:'no-referrer'`,
     `cache:'no-store'` and `redirect:'error'`.
   - `Cookie`, `Authorization` to another origin, `Origin`, `Referer`, `Host` and
     other forbidden headers are dropped.
   - The response is limited to 16 MiB.
   - The sandbox CSP makes this the only way out.
5. **UI** (`plugin-ui.js`). Plugin text is set with `textContent`, never parsed as
   HTML. Links must be `https:` and are shown with `rel="noopener noreferrer"`. Specs are
   bounded to 2,000 nodes.
   - Plugins cannot pass for Scribyra. Dialogs show "<Plugin> plugin" (adding
     "developer, unverified" for sideloaded ones), file bars show the plugin's name, More
     tools hints end with it, and notices start with it.
   - Labels equal to Scribyra's own items (for example "MCP providers" or "Delete") are
     refused, as are names with control, bidirectional or zero-width characters.
     "Scribyra" in a name or publisher is reserved for official plugins.
   - Contributed citation keys must be BibTeX keys, with no spaces, braces, commas or
     backslashes, so accepting a completion cannot insert TeX the plugin chose.

### Modes

The person's mode applies to plugins as to the agent API (`web/agent-commands.js`):

| | Editing | Reviewing | Viewing |
| --- | --- | --- | --- |
| `project.read`, `project.files` | yes | yes | yes |
| `project.patch` | applied | a suggestion in a review titled "<Plugin> suggestions", credited to the plugin | refused, `viewing_mode` |
| `project.create` | yes | refused, `reviewing_mode` | refused, `viewing_mode` |
| File actions and bar buttons with `modes:["editing"]` | enabled | disabled, with the reason | disabled, with the reason |

A plugin's suggestions use an author record of kind `agent` named "<Plugin name>
(plugin)". As for the agent, the author id is drawn per running session: a random id,
or one derived from the local author when direct sessions are on. Each session's
suggestions collect in one review.

In Editing, plugin changes go through the same project command as the person's own
edits, so history credits them to the person, as it did for the built-in Zotero. The replicated collaboration
schema is unchanged; peers on older versions read it as an agent. A dedicated `plugin`
actor kind is a schema change for later.

## UI contribution model

- **More tools.** **Plugins** opens the manager. Each enabled plugin's
  `contributes.commands` follow it, labelled as the plugin declares, for example
  **Zotero**. Choosing one sends `command.run`.
- **File tree menu.** `contributes.fileActions` appear after the built-in items.
  - `when.target` is `root`, `folder` or `file`. `when.files` is a glob. `when.tag`
    is a tag the plugin set with `ui.files.decorate`.
  - `modes` lists where the item is enabled. Elsewhere it is disabled with the same
    reason the tree gives.
- **File bar.** `ui.files.decorate` can show one bar above a file. It has an
  accessible name (`label`, e.g. "Zotero link"), text and buttons; Zotero shows
  **Refresh from Zotero**.
- **Dialogs.** A spec is a tree of nodes. Each node has a `type` and, if interactive,
  an `id`:
  - `heading`, `text` (tone `note`, `warning` or `muted`), `link` (`https:` only)
  - `field` (`text`, `password`, `select`, `checkbox`), `group` (a fieldset with a
    legend and `disabled`), `section`
  - `list`, `table` (caption, columns, rows of strings)
  - `choice` (a radio group), `status` (a polite live region)
  - `actions` (buttons: `primary`, `danger`, `disabled`)

  `update` replaces the spec, and the renderer keeps elements by `id`. Focus, caret and
  typed values survive an update unless the plugin changes that field's `value`. A
  password field's value is sent with events but never echoed into a later spec.
  Escape sends `cancel`; the plugin decides whether to close.

All of it uses the app's classes (`modal`, `button`, `input`) and theme tokens, so light
and dark, focus rings and contrast follow the app. The accessibility specs run axe on
the manager, the consent dialog and plugin dialogs.

## Registry

The official registry is `plugins/dist/registry.json`. It is bundled with the app as
a Vite asset and fetched from the same origin only when the person opens **Browse**
in the Plugins manager. Later it can move to `plugins.scribyra.com` with the same
format.

```json
{
  "signed": {
    "registryVersion": 1,
    "name": "Scribyra plugins",
    "keyId": "scribyra-plugins-dev-2026-11",
    "plugins": [{
      "id": "com.scribyra.zotero", "name": "Zotero", "publisher": "Scribyra",
      "description": "…",
      "versions": [{
        "version": "1.0.0", "api": 1,
        "package": "com.scribyra.zotero-1.0.0.scribyra-plugin.json",
        "sha256": "…64 hex…", "size": 61234,
        "permissions": { "…": "the manifest's, repeated for review" }
      }]
    }]
  },
  "signature": { "alg": "ECDSA-P256-SHA256", "keyId": "scribyra-plugins-dev-2026-11", "value": "…base64 (IEEE P1363 r‖s)…" }
}
```

- **Signature.** The signature covers the canonical JSON of `signed`: object keys
  sorted, no whitespace, strings as `JSON.stringify` writes them. The app pins the
  public keys it trusts in `web/plugin-registry.js` (`TRUSTED_REGISTRY_KEYS`), and an
  unknown `keyId` is refused. ECDSA P-256 was chosen over Ed25519 because WebCrypto
  supports it in every engine the app supports.
- **Integrity.** A package must hash to the registry's `sha256` and repeat the
  registry's `id`, `version` and `permissions`. Otherwise it is refused before
  consent.
- **Building and signing.** `node scripts/plugins.mjs build` bundles each plugin
  under `plugins/` with esbuild and writes the packages.
  `node scripts/plugins.mjs sign --key <pem>` writes the registry with hashes and the
  signature. `npm test` checks that:
  - the signature verifies against the pinned key;
  - every hash matches;
  - each package's code matches a fresh build of its source, so changed source
    without a re-signed registry fails.
- **Keys.** The current key is a development key held on the build agent, outside the
  repository. Paul replaces it with a production key kept offline before the registry
  is public ([Open decisions](#open-decisions)).

**Developer mode** is a switch in the Plugins manager. Turning it on shows a red
warning. It reveals **Install from URL**, which takes an `https:` URL (or
`http://127.0.0.1`/`localhost` for local development) of a `.scribyra-plugin.json`
package.

- Such a package is not signed or reviewed. Its consent dialog says so in a red
  warning, with the URL and the package's SHA-256.
- It is labelled **Developer** wherever it is listed.
- Turning developer mode off disables, but does not remove, sideloaded plugins.

## Flows

**Install.**

1. **Browse** (or **Install from URL**) fetches the package and checks its integrity
   and manifest.
2. It checks the organisation policy.
3. The consent dialog shows the name, version, publisher, source, description and
   each permission in plain words. **Install** grants exactly these permissions;
   **Cancel** stores nothing.
4. The plugin is stored enabled, and starts if a project is open.

**Update.** **Check for updates** in the manager reads the registry. If a newer
version exists, **Update to x.y.z**:

- It verifies the new package the same way.
- If the new version asks for permissions the old one did not have, or wider ones (more
  globs or origins), the consent dialog lists **only what is new** and asks again.
- If not, it updates after one confirmation.

The previous package is kept, so **Roll back to x.y.z** restores it. Its stored bytes
are hashed again before it runs.

**Enable and disable.** A switch per plugin. Disabled plugins never start, and their
menu items and bars disappear. Data stays.

**Revoke and re-grant.** Each permission has **Revoke** in the manager. A revoked
permission makes the matching calls fail with `permission_denied`, and the plugin is
restarted so it cannot keep what it already cached. Revoking `ui.command` or
`ui.fileAction` also removes those items. A revocation is kept across updates and
rollbacks: a new version does not ask for it again, and only **Grant again**, after
consent, restores it.

**Sideloaded updates.** A newer package of a developer plugin from the same site (scheme,
host and port) is an update. A package with the same id from another site is refused
until the old one is uninstalled, since it would inherit the plugin's data and secrets.

**Uninstall.** This stops the plugin and deletes everything it owns on this device:

- its record, its packages (current and previous) and its grants;
- its `storage` and its `projectData` in every project;
- its file ownership records and its secrets.

Files it created stay in the projects as ordinary files.

**Project deleted.** Every plugin's `projectData` and ownership for that project are
deleted.

## Organisation allow-list (hook)

Organisation deployments ([org-sync design](org-sync-design.md) on
`feature/org-sync-v2`) will deliver a plugin policy with `GET /v1/deployment`:

```json
{ "plugins": { "userInstall": false, "developerMode": false,
               "allow": [{ "id": "com.scribyra.zotero", "versions": "^1.0.0", "sha256": ["…"] }] } }
```

`web/plugin-manifest.js` has `policyDecision(policy, candidate)`, which is evaluated:

- when browsing, where disallowed plugins are shown as blocked;
- at install, update and enable;
- at every start, so a policy change stops a plugin that is already installed.

Until the deployment endpoint exists, the policy comes from the build:
`VITE_SCRIBYRA_PLUGIN_POLICY`, JSON, unset meaning "personal browser: allow official,
allow developer mode". A self-hoster can already lock plugins down this way.

The service-side work is:

- config `deployment.plugins` and a CRD twin `spec.plugins` validated by CEL;
- include it in `policy_hash`;
- an audit event when a person enables or updates a plugin;
- a read-only view in Admin → Settings.

## Threat model

Assets: project sources (all projects on the device), history, comments, keys and
tokens (Zotero's, MCP providers', direct-session identity), cookies (none today),
the person's trust in the UI, and the network destinations their data reaches.

| Threat | Mitigation |
| --- | --- |
| Plugin reads other projects or app storage | Opaque origin: no IndexedDB, localStorage or Cache Storage. Host calls are scoped to the open project and read globs. No project ids or project list are exposed. |
| Plugin reads another plugin's secrets or data | Secrets and data are keyed by the plugin id taken from the host's own instance record, never from a message. Each plugin has its own port. |
| Plugin contacts an arbitrary host | Sandbox CSP `connect-src 'none'`; network globals deleted; the proxy allows only exact granted origins, without redirects. |
| Plugin exfiltrates through other channels (images, navigation, WebRTC, forms) | The plugin runs in a Worker: no DOM, no WebRTC. The iframe CSP allows no images, styles or forms. The sandbox omits `allow-popups`, `allow-top-navigation` and `allow-forms`. |
| Plugin reads cookies or the DOM | Opaque origin, cross-origin frame, Worker without DOM. |
| Plugin writes outside its scope | Writes are checked against ownership, picks and create globs, and go through the project command layer with Rust validation. |
| Plugin acts against the person's mode | The mode is checked on every write. Reviewing writes are suggestions credited to the plugin. |
| Plugin impersonates Scribyra UI | Declarative rendering only. Dialog titles carry the plugin's name. No HTML from plugins. |
| Tampered registry or package | Pinned-key signature over the registry; SHA-256 per package; packages stored at install. |
| Malicious update | No automatic updates. New permissions ask again. Rollback is available. |
| Denial of service (loops, floods, modal spam) | The worker is isolated from the UI thread. Messages are measured by a bounded walk. In-flight limits, redraw pacing and notice limits apply. Dialogs need a fresh gesture, and Dismiss always closes. Plugins with persistent errors are stopped. Disabling always works because the manager never waits for the plugin. |
| Sideloaded malware | Off unless developer mode is on, with a loud warning. Unsigned code is labelled. Official ids are reserved. The organisation policy can forbid it. |
| Secrets leaking into projects, backups or telemetry | Secrets are in their own database, outside the project, history, backups, exports, diagnostics and telemetry. Plugin modules never call the telemetry recorder (`tests/telemetry-consent.test.mjs`). |

**Not defended:**

- A plugin that legitimately reads `*.tex` and may contact its origin can send those
  files there. The consent dialog says so plainly.
- Timing side channels (Spectre) between the opaque-origin frame and the app: the app
  is not cross-origin isolated.
- A malicious browser extension.
- A person who accepts a malicious developer plugin.

## The agent API and plugins

The agent API (`window.scribyra.agent`, [commands.md](commands.md), `public/agent.md`)
was the model:

- It is project-scoped and versioned.
- It returns structured `{code, message}` errors.
- Its patch semantics are the same: offsets, `before` and `after`. Reviewing turns
  edits into suggestions credited to a non-human author, and Viewing refuses.

The difference is trust. The agent API serves an agent the person runs in their own
browser tool, which already controls the tab. It has owner rights in the page's realm.
A plugin is third-party code, so it gets an explicit, narrower capability set across
an origin boundary.

The two do not call each other in v1. A later version could let the agent list
plugins and run their commands, which would show the same consent.

## Telemetry and privacy

Plugins add no telemetry operation. Plugin modules never import the recorder, and
plugin failures are shown to the person, never reported. `site/privacy.html` lists
plugins under "things only you can start": a plugin you install can contact the
origins its permissions name, and nothing else.

## Writing a plugin

- **JavaScript or TypeScript.** Start from `templates/plugin-js/`: `manifest.json` and
  `src/main.js`. `node scripts/plugins.mjs pack templates/plugin-js` bundles it into
  `dist/<id>-<version>.scribyra-plugin.json`. Serve the folder (for example
  `npx vite preview`, or any static server with CORS), turn on developer mode, and
  install it from its URL.
- **Rust to WebAssembly.** Start from `templates/plugin-rust/`, a `cdylib` with no
  imports except what you declare.
  1. `cargo build --release --target wasm32-unknown-unknown`.
  2. Copy the module into `assets/` and pack it with
     `node scripts/plugins.mjs pack templates/plugin-rust`, together with the small
     JavaScript shim in `src/main.js`. The shim passes text in through the module's
     `alloc`/`count_words`/`dealloc` exports and makes the capability calls.
     WASM code never touches the network or project directly: the host imports it sees
     are only the functions the shim passes in (`env.log` in the template). That keeps
     the authority explicit.

**Notes for authors.**
- `crypto.subtle` and `crypto.randomUUID` are missing in Chromium's sandbox, which does
  not count the opaque-origin worker as a secure context. `crypto.getRandomValues`
  works. The Zotero plugin hashes with a small SHA-256 in JavaScript
  (`plugins/zotero/src/sha256.js`).
- `eval` and `new Function` are blocked.
- `project.freePath` tells a plugin whether paths matching its `create` globs exist.
- Commands and file actions run only while their `ui.*` permission is granted.

## Security review

An independent adversarial review of the sandbox and the capability enforcement found
10 confirmed bugs, none of them a sandbox escape. Each was fixed, with a regression test.

| Finding | Severity | Fix |
| --- | --- | --- |
| Request size measured by `JSON.stringify` on the main thread: a huge typed array froze the page; a `Map` passed as tiny | high | Bounded walk over plain JSON data only |
| Rollback restored a revoked permission | medium | Revocations kept in the record, across updates and rollbacks |
| A plugin tree action fell through into Import folder (missing `break`) | medium | `break`; test that no file picker opens |
| Contributed citation keys could carry TeX into files through completion | medium | Keys limited to BibTeX key characters |
| Notices, More tools items and file bars were unattributed (spoofing) | medium | "<Plugin>:" on notices, plugin name on items and bars, Scribyra item names and hidden characters refused |
| A dismissed dialog granted activation, so a plugin could reopen modals forever | medium | Activation from gestures only; a 2 s pause and a new gesture needed after Dismiss |
| Redraw calls unthrottled | medium | Paced per plugin; app redraws coalesced per frame |
| A sideload from another URL took over an installed plugin and its secrets | low–medium | Another site is a conflict until the old plugin is uninstalled |
| Revoking `ui.command`/`ui.fileAction` left the items working | low | Contributions and their dispatch need the grant |
| `**/main.tex` matched `domain.tex` | low | `**/` matches whole folders |

Lower-risk items also fixed:

- Store writes are checked after a plugin stops.
- The file picker closes when its plugin stops.
- Consent says when an origin is on this computer or the local network.
- The runtime also removes `WebSocketStream` and `FontFace`. A test shows a worker started in
  the sandbox frame inherits the deny-all CSP.
- Migration respects the policy and takes the highest compatible version.
- Package file names cannot be `__proto__` or similar.
- "Scribyra" in a plugin's name or publisher is reserved for official plugins.

Accepted and documented:

- `project.freePath` shows whether paths matching the plugin's create globs exist.
- In Editing, history credits plugin edits to the person.

## Verification results

On November 19, 2026, Linux, software-rendered WebKit, against the final code:

- **`nix develop -c npm test`:** Rust 171 pass, 0 fail, 2 existing ignores; JavaScript and
  WASM 1,275 tests: 1,269 pass, 0 fail, 6 existing optional-service skips. This includes
  `tests/plugins.test.mjs` 19/19 and `tests/zotero.test.mjs` 18/18.
  - An earlier run under concurrent browser load failed once in the unrelated folders CLI
    test `explicit_native_diagnostics…`. It passed alone (4/4), and the full rerun
    without load passed.
- **Browser specs**, together: `plugins` (6), `zotero` (8), `workspace`, `editor`,
  `accessibility`, `menus`, `agent-surface`. Chromium 51/51, Firefox 51/51, WebKit 51/51.
- **After `npm run build:pages`:** `pages-domains` 2/2 per engine, and
  `python3 scripts/ci-telemetry.py browser-pages` 14/14.
- **Builds:** `npm run build`, the Pages build and the final `npm run build` pass.
- **Screenshots** in `docs/screenshots/plugins/`, light and dark, were reviewed: the
  manager (empty, installed, developer mode), consent, a template plugin's dialog, and
  Zotero's link dialog, linked file and refresh diff. Reviewing them found stray "null"
  text and broken radio layout, both fixed with a regression check.

What the plugin specs prove in all three engines:

- **Consent.** Nothing is fetched or run before install, and Cancel installs nothing.
- **Lifecycle.** Install, disable, enable, reload and uninstall, with all data and secrets
  removed.
- **A malicious plugin is refused:**
  - It runs in an opaque origin with no DOM, storage, network globals, eval or cookies.
  - It cannot read another project, files outside its globs, another plugin's key, data
    or links, or contact undeclared, credentialed or app origins.
  - It cannot write outside its scope, or open dialogs or files without a gesture.
  - It cannot use HTML or `javascript:` links in dialogs.
  - In Viewing it is refused. In Reviewing its changes become suggestions credited to
    "Probe (plugin)".
  - The sandbox frame itself and a worker inside it are blocked by the CSP.
- **Review regressions:** the cases in the table above.
- **Updates.** Re-consent asks only for new permissions. Rollback, revoke and grant again
  work, and a revocation survives rollback.
- **Developer mode.** Turning it off stops sideloaded plugins. Official ids are reserved.
  A takeover from another site is refused.
- **Tampering.** A tampered official package is refused.
- **Templates.** Both run: JavaScript, and Rust compiled to WASM with cargo in the test.

Not covered:

- Real-world review of third-party plugins.
- The organisation policy delivered by a deployment; it is a build setting today and
  unit-tested only.
- Real assistive technology.
- `ui.panel`.

## Open decisions

For Paul (`needs::decision`):

1. **Migration consent.** People who linked Zotero before this update get the Zotero
   plugin installed and enabled automatically, with its permissions granted, so their
   links keep working. They see a one-time notice pointing to the manager. The
   alternative is asking at first use.
2. **Signing key custody.** The registry is signed with a development key held on the
   build agent, outside the repository. A production key should be generated offline
   and its public half pinned in `web/plugin-registry.js`. Who holds it?
3. **Registry hosting.** It is bundled with the app now. Should it move to
   `plugins.scribyra.com` (GitHub Pages), and should third-party plugins be accepted
   into it, with which review?
4. **Actor kind.** Plugin suggestions use the `agent` author kind, named "<Plugin>
   (plugin)". A dedicated `plugin` kind changes the replicated schema.
5. **`ui.panel`.** Reserved; ship a sandboxed iframe panel only when a plugin needs
   rich UI?

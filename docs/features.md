# What works

The complete list of what the public beta does today, with keyboard shortcuts,
diagnostics and AI tooling. The [README](../README.md) has the short version
and screenshots; the [roadmap](roadmap.md) has what comes next.

## Features

- Project dashboard and search; nested folders with keyboard navigation; file/folder create, rename, move, duplicate, delete and restore; atomic file/folder imports and drag/drop moves/uploads; main-file selection, themes, and resizable source/PDF panes.
- Stable file tabs with per-session cursor/selection restoration and per-file undo. Tabs, font size, indentation, wrapping and auto-compile preferences persist on this device. Project settings control the name, main document and engine.
- Rust project search with Unicode, case/whole-word options, regular expressions, selectable replacement previews and cross-file batch undo/redo. Source outlines navigate literal headings. Search and outline work offline in cancellable workers.
- Reviewed literal LaTeX reference updates when moving/renaming files or folders. Choose individual edits, move without edits, or cancel; stale reviews are rejected. Macro-generated and custom search paths require manual review.
- Image previews with dimensions, download and validated replacement that preserves the project path. PNG/JPEG/PDF figures can be inserted at the remembered source cursor using paths relative to the main document. Empty folders and binary bytes survive source ZIP export/import.
- Anchored comment threads, causal resolution, proposed source changes with explicit authority-checked acceptance and isolated preview compilation. Named history, reviewed restoration, compaction and complete `.scribyra-backup` files preserve discussion and assets offline. See [integration evidence and limits](integration-567.md).
- Experimental direct browser sessions behind an off-by-default Share setting, with a manually configured connection service and trusted full editors. Local browser checks and remaining real-network gates are recorded in the [direct-session design](direct-sessions-design.md).
- Automatic live synchronization between tabs in the same browser profile, with local-only undo, verified assets, resume/polling fallback and visible recovery projects for competing binary versions or deletion. [Local sync scope](local-sync.md); folder and paired-device adapters remain upcoming.
- Local project text and assets stored in IndexedDB with visible save status. Binary assets are checksum-verified and deduplicated across files, projects and durable revisions. Shared Rust tree validation and stable IDs preserve text/undo identity across folder moves. Existing projects migrate with an atomic recovery copy, exportable from the project menu.
- Browser-worker LuaLaTeX, BibTeX, Biber, and multiple passes for cross-references using TeXlyre-BusyTeX 1.4.1 / TeX Live 2026.
- On-demand TeX package downloads with Rust/WASM archive verification and offline caching, multilingual Babel support, BibLaTeX/Biber, and actionable compilation diagnostics. [Downloaded packages](tex-packages.md) use compiler-matched static components and an existing TeX Live mirror without changing project files or ZIP exports.
- A TeX environment dialog locks the compiler/adapters/catalog and supplemental package versions, inspects/removes cached archives, caches a locked set with progress/cancellation, and verifies portable package-bundle export/import. Lock metadata stays with the journaled project; source ZIPs remain source-only. Bundles contain supplemental packages, with the app/compiler assets prepared separately. See [environment locks and package transfer](tex-packages.md).
- Manual compilation and optional 1.8-second debounced automatic compilation. Cancellation terminates the worker; later compilation recreates it. A cumulative 180-second compiler-execution budget stops runaway jobs; component preparation uses separate download/processing limits.
- Source ZIP export/import, PDF download and compilation logs. The PDF reader has selectable text, internal links, page navigation, case/whole-word search, fit-width/fit-page controls and zoom that preserves position. Offscreen canvases are evicted; failed compilation keeps the previous PDF visible. Rust SyncTeX queries connect source lines and PDF locations for LuaLaTeX, including nested Unicode paths; editing invalidates the mapping until the next compilation.
- Resumable verified downloads for compiler assets, metadata and TeX archives. Device cache limits and interrupted-download controls are in **TeX environment**; zero disables caching while online compilation remains available.
- Offline application shell and cached compiler packages after first preparation. Browser storage remains subject to user deletion; persistent-storage requests and source ZIP backups are available.
- [Open in Scribyra links](open-links.md) and badges import a public GitHub or GitLab repository (any ref, folder and main file) or a CORS-enabled ZIP after a confirmation that shows the source, size and what will be skipped. Nothing is fetched before Check and nothing compiles before Import and compile; the project records its source for future Git plugins. Generator: `https://scribyra.com/open.html`.
- Project imports are limited to 64 MiB expanded, 512 files and 1024 total file/folder entries. Recoverable deleted contents also count toward the project byte limit. Traversal, absolute paths, encrypted archives, symlinks, and malformed ZIP metadata are rejected.
- Bibliographies: **Import bibliography…** checks BibTeX/BibLaTeX files (Zotero and Better BibTeX exports too) and reports malformed entries by line before importing them unchanged. **Link to Zotero…** creates a `.bib` file from a Zotero library or collection through the Zotero Web API with a read-only key kept only on this device; **Refresh from Zotero** keeps cited citation keys stable and shows a per-entry diff before changing anything edited locally. `\cite{` completion shows author, year and title from every `.bib` file. [Bibliographies and Zotero](zotero.md).

## Keyboard shortcuts

**Ctrl/⌘ + Enter** compiles or cancels. **Ctrl/⌘ + F** searches the source. **Ctrl/⌘ + Shift + F** opens project search, **Ctrl/⌘ + Shift + O** opens the outline, and **Alt + W** closes the current file. Focus a file tab and use Left/Right or Home/End to switch files; Delete closes that tab. **Tab** indents. **Alt + Enter** jumps from the source line to the PDF; **Ctrl/⌘ + click** a PDF location jumps back to its source line. The PDF toolbar arrow (or Alt + Enter with the PDF focused) uses selected PDF text or the visible page. Navigation is line-level and depends on the engine’s SyncTeX output. In the PDF preview, Ctrl/⌘ + F opens PDF search; Enter/Shift + Enter move between matches and Escape closes search or clears the PDF selection. Focus the PDF container and use Left/Right or Home/End to navigate pages. Focus the pane divider and use the arrow keys to resize it. Use `/` on the dashboard to focus project search. In the tree, arrow keys navigate/expand/collapse, Home/End jump, F2 renames, and Delete removes a node. Use **Project root** before adding at the top level; otherwise creation/upload uses the selected directory. Drop onto a folder to import or move there, or onto Project root to move to the top level. **Duplicate** creates independent text and file identities. Folder import preserves empty directories when the browser supplies directory handles; the file-input fallback explains that empty folders require ZIP import.

## AI agents and MCP providers

AI agents work with an open project through the tab itself, using their own
browser tools. The editor serves a short recipe at `/agent.md` describing the
experimental `window.scribyra.agent` interface; see the
[project command contract](commands.md) and the
[decision record](reorientation.md).

**More tools** → **MCP providers** connects the open project to compatible HTTP
MCP servers whose address you enter. Source disclosure and tool calls require
explicit actions, and connections and tokens stay in memory until the project
closes; see [provider setup, permissions and limits](mcp-providers.md).

The Rust companion app is discontinued (November 8, 2026). The editor no longer
offers it and never contacts a local companion. Its code remains in
`crates/companion` only so its tests keep running.

## Local diagnostics

Open **Diagnostics** (in the projects sidebar, or **More tools** → **Diagnostics** in a project) to enable a bounded local event timeline and review a safe
JSON support export, including while offline. Collection and export are off by
default. No collector is required; broader instrumentation and Grafana integration
remain in progress. Official Pages builds offer separate, all-off category consent
for Grafana Cloud, a third-party service. Source-tree and self-hosted builds have
no destination or prompt unless configured. See [controls, exact fields and validation](telemetry.md).

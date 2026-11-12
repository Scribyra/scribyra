# LuaLaTeX and downloadable TeX packages

Scribyra currently supports **LuaLaTeX only**, with BibTeX/Biber as bibliography
helpers. Existing pdfLaTeX/XeLaTeX project settings migrate on opening, with a
notice. Source files are preserved; engine-specific source may need changes.
The pinned BusyTeX binary still contains other engines internally. They are
not exposed or accepted by Scribyra's compiler or project-settings commands.

## Static delivery, existing repositories

The browser first uses compiler-matched components generated from the pinned
upstream distribution and served alongside the static app. Other missing runtime
packages download directly from the existing
[TeX Live mirror maintained by Yihui Xie](https://tlnet.yihui.org/).
No package installation server is needed. The static components let us remove
files from the initial download without depending on an advancing mirror to
retain their exact versions. External requests contain only the public archive
name, without credentials or a referrer. The mirror sees the requester's IP and
the requested package; source remains on the device.

The repository retains about 1 MiB of compressed upstream catalog input, generated from the
[TeX Live 2026-03-02 database](https://texlive.info/tlnet-archive/2026/03/02/tlnet/tlpkg/texlive.tlpdb.xz).
It records 4,218 runtime packages, filenames, revisions, sizes, and SHA-512
container checksums. The native builder merges this input with compiler components
and publishes a 112,442-byte manifest plus filename/package shards. The browser
loads only required shards; the original catalog is no longer an eager app asset. This snapshot retains the March 1 compiler baseline's
LaTeX (76924) and luaotfload (74324) revisions, while incorporating the March 2
archive repackaging. The compiler is still the pinned BusyTeX 1.4.1 distribution.
Verify the frozen catalog offline with `npm run tex:catalog:check`. Historical
upstream refresh uses `npm run tex:catalog` (or exact local inputs, below); it verifies the
upstream database SHA-256 before changing the checked-in artifact. Reviewed
archive repackagings are listed in `scripts/tex-package-repacks.json`: the generator
verifies both archive hashes and compares every runtime file byte-for-byte before
accepting a replacement. IEEEtran r79618 is accepted this way because all ten
runtime files match baseline r59672. This does not permit unverified updates.

A November 2, 2026 comparison with the default mirror database found matching
checksums for 2,849 of these 4,218 packages; this is an availability indicator,
not a claim that all of them compile in WASM. The default mirror advances
independently. A package with different bytes or
an unavailable old version is **rejected**, not silently upgraded. Self-hosters
can set `VITE_TEX_PACKAGE_REPOSITORY` at build time to an HTTPS repository with
matching `archive/<package>.tar.xz` files (including the reviewed repackagings)
and browser CORS support. The historical
texlive.info archive itself did not provide CORS in our checks; it cannot simply
be substituted for browser downloads. An existing suitable mirror or a
self-hosted static mirror/proxy can supply matching archives. No proxy is
required for matching packages available from the default mirror.

## Compile and cache flow

1. Compile the unmodified project locally in the LuaLaTeX worker.
2. On failure, resolve explicit missing-file/language/module/font diagnostics against
   the pinned catalog. Structured Kpathsea missing lookups cover additional
   paths; LuaTeX bypasses the upstream hook in some cases. Nothing is downloaded
   after a successful compile merely because an optional probe failed.
3. Fetch a package archive asynchronously, enforce download bounds, verify its
   SHA-512, decode XZ, and read TAR entries using Rust/WASM in a separate worker.
   Preserve catalogued TeX Directory Structure paths; never run install scripts,
   extract host files, follow links, or install native binaries.
4. Install runtime files into a compiler-only TeX tree, then retry compilation.
   Explicit prerequisites in the reviewed support recipe install first; other
   dependencies are discovered through subsequent missing-file failures. This
   is demand-driven file resolution, not a full `tlmgr` implementation.
5. Store verified compressed archives in separate IndexedDB storage, keyed by
   checksum. Validate cached bytes again before installation. Reloaded projects
   can use cached packages offline. Storage failure permits the current compile
   but is reported in the package log; browser deletion/eviction loses caches.

Compiled results include package receipts (name, revision, checksum, download
versus cache, persistence result). Installed package contents never enter project files,
Yjs updates, source exports, or collaboration traffic. Environment lock metadata
(package identities and checksums, without archives) is shared with the project. Switching projects or
cancelling terminates the compiler worker; later use reloads packages from cache.

## Project environments and portable supplemental packages

Open **TeX environment** after compiling unchanged sources successfully. **Lock
current environment** pins the LuaLaTeX distribution archive, effective compiler
adapters, catalog bytes/snapshot, and every supplemental package loaded in the
current worker. Warm-build receipts include earlier installations too; this is a
conservative set, not a claim of a minimal dependency closure. A lock is a shared
project setting preserved by the journal/checkpoints and replication model.
Project schema 5 prevents older builds from reopening it while silently ignoring
the lock. Schema-4 projects migrate with the existing atomic recovery copy and
checkpoint machinery; sources and lock metadata are retained. Close/reload older
already-open clients before using the upgraded project.
`environment.set` uses the same Rust command validation, write grant and expected
revision as other project mutations.

Locked compilation starts a fresh worker from the immutable baseline, validates
the runtime/catalog identity and all package metadata, preloads exactly the
locked supplemental set, then compiles. A new missing package cannot be fetched
silently. Explicitly unlock, compile successfully, and review/lock the updated
set. A lock from an incompatible build is rejected before loading the compiler;
use its matching build or explicitly unlock. These version locks do not freeze
project source, external inputs or PDF timestamps, and are not a promise of
byte-identical PDFs.

The dialog lists locked/observed packages and the shared archive inventory, with
per-archive removal, cache clearing, byte progress and cancellable caching of the
locked set. Archive controls affect the separate public package/metadata cache; compiler
controls also clear verified runtime assets. They do not change project storage.
Source files, assets, history and locks are retained. Cached bytes are verified
again when used; a count of cache entries alone does not prove offline readiness.

**Export environment lock** writes a version-1 JSON lock; import validates it
against the current build. Source ZIP export remains source-only. Keep the lock
or package bundle alongside a source ZIP when transferring a project this way.

**Export package bundle** verifies the cached archives and exports the lock plus
its exact compressed packages and required metadata shards. **Import package bundle** validates the full
bounded container, runtime identity, metadata proofs, every archive checksum and runtime-file list
in Rust before writing any cache entry. Archive and metadata writes/evictions are one atomic
IndexedDB transaction, including quota-failure rollback. Applying the project
lock then uses its captured revision; if the project changed meanwhile, that
mutation is refused (verified public archives may remain cached). Corruption,
truncation, extra data and incompatible runtime metadata are rejected.

Current portable `.scribyra-tex` bundles use `SCRIBYRA-TEX` followed by byte 2.
A big-endian u32 lock length and UTF-8 version-1 JSON lock come first, followed by
a u32 metadata count. Each metadata record has a u32 path length, its public
artifact path, a u32 byte length and its bytes. Archive fields then use u32 byte
lengths in sorted locked-package order. Metadata paths are content-addressed
manifest/shard names, not host paths. Importing never executes archive contents.

Limits are 64 KiB of lock JSON, 96 MiB of archives, 24 MiB of metadata, at most
66 metadata records (one root, up to 64 package shards and an optional dependency manifest), 128-byte metadata
paths and 16 KiB of framing overhead. The root is limited to 256 KiB; each shard
to 2 MiB. The root SHA-256 must equal the runtime's catalog fingerprint. Its
package-shard pins authenticate the file lists used for Rust archive validation.
Missing, duplicated, changed, undeclared and merely rehashed replacement records
are rejected. This supports offline import without a pre-existing catalog cache.

Version-1 bundles require their matching older Scribyra build or re-export from
that environment; current browser imports require the metadata-bearing format.
Environment JSON locks remain version 1, with strict build/catalog matching.
The bundle contains public TeX packages and metadata only. Project sources and
the app/compiler runtime are transferred or prepared separately. Full-runtime
preparation is available in **TeX environment → Prepare this project for offline use**.

## Boundaries and remaining work

- The LuaLaTeX data baseline is 43.53 MiB. The upstream combined engine binary
  remains unchanged; Scribyra exposes only LuaLaTeX.
- Limits: 32 MiB compressed per package, 64 MiB XZ dictionary, 96 MiB expanded
  archive, 64 supplemental packages / 96 MiB compressed per job (including cache
  loads), at most 65 compile attempts, and 192 MiB of installed supplemental files
  per worker. A cumulative 600-second budget covers compiler calls across all
  passes. Component preparation has separate download/processing limits and
  remains cancellable; active transfers do not consume the compiler budget.
- Default cache budgets are 128 MiB for archives, 32 MiB for metadata, 256 MiB
  for compiler runtime and 128 MiB for interrupted downloads. Device settings can
  lower or raise them; zero disables a cache. These disposable caches are separate
  from project sources, assets and history. See [resumable transfers and cache limits](#resumable-transfers-and-cache-limits-goal-2c2).
- File lookup prefers compiler-matched distribution files and LuaLaTeX TDS paths,
  refusing equally ranked ambiguous owners. Known OpenType/TrueType family names
  can resolve against the generated font index. Arbitrary system fonts and
  external module loaders are not guaranteed to work.
- The supported release has one prebuilt LuaLaTeX format and exact package pins.
  Browser format rebuilding, arbitrary native tools and a version-selection UI
  are not implemented. Upstream declarations do not authorize installing native
  tools or entire collections. Transfer and memory measurements are recorded below.
  Shell escape stays disabled. Portable package bundles
  include metadata but do not include engine binaries or a minimal dependency closure.
- There is no claim that every CTAN package works in this WASM compiler or that
  the user's original imported thesis compiles unchanged.

The Rust implementation is in `crates/core/src/packages.rs`; the browser network,
cache and cancellation adapters are `web/tex-packages.js`, `web/tex-metadata.js`
and `web/tex-cache.js`. Portable metadata proof verification is in
`crates/core/src/portable.rs`. `scripts/patch-busytex.mjs`
reproducibly patches the pinned wrappers; `npm run test:wrappers` verifies that
fresh extraction and repeated patching produce identical installed files.

## Validation of the first download slice

The production build and fresh-wrapper/idempotence check pass. There are 22
Rust core tests and 62 JavaScript tests, including the actual WASM decoder,
corrupt cache/archive bytes, archive path/link rejection, request bounds,
cancellation signals, and storage quota failure. The catalog regeneration check
reproduces the identical compressed artifact from the pinned upstream database.

Across the production-build runs, all 81 distinct browser scenarios passed in
Chromium, Firefox and WebKit, including the new package and IEEEtran cases.
The initial Chromium matrix had one PDF page-navigation timing failure; its
isolated rerun passed without a navigation change. A WebKit fault-injection test
was corrected to intercept fetch before service-worker handling. A real WebKit
offline failure was fixed by waiting for service-worker control before the first
compiler-wrapper requests. The Romanian/Biber/offline regression passed again
on the final build. These results span the full matrix and targeted rechecks,
not a single uninterrupted clean matrix run.

New acceptance checks cover corrupted downloads, cancellation, whole-package
installation (`algpseudocode` plus `algorithmicx`), nested mains, unchanged source
exports, IEEEtran's verified repackaging, and offline restarts. Package receipts
appear at the beginning of the log and in the status line even when a subsequent
source error stops compilation. The final package checks passed in all three
browsers, and the final build, 22 Rust / 62 JavaScript checks, wrapper reproduction,
and catalog/repack regeneration checks passed.

The user's original local thesis downloads Romanian support but still reports
its pre-existing `Improper discretionary list` custom-class error. The previously
corrected ZIP compiles with LuaLaTeX into 36 pages (2,299,089 PDF bytes), reusing
the package cache. Neither private ZIP was changed or committed.

The second user-supplied IEEE paper compiles unchanged with the verified IEEEtran
repackaging: 5 pages, 121,508 PDF bytes. The PDF and diagnostic report remain
local under ignored `tmp/`; the private ZIP was not changed or committed.

## Environment delivery validation (goal 2a)

The production build, 27 Rust tests and 70 JavaScript tests pass. Coverage includes
strict/duplicate/versioned locks, exact runtime/catalog checks, actual WASM archive
and portable-container verification, truncated/corrupt/extra bytes, bounded byte
arrays, write grants/revision rejection, journaled lock restoration, schema-4 to
schema-5 recovery copies, future/stale-writer rejection, byte progress and cache
quota rollback including an eviction from a full 128 MiB cache. An isolated Vite
probe verifies that changing a compiler adapter refreshes the development runtime
identity; unit tests use small adapter fixtures and do not need the large compiler
archive.

A production browser matrix passed 43 cases (two engine-specific Chromium CDP
allocation skips) across Chromium, Firefox and WebKit, including on-demand
packages, live IEEEtran, compiled-PDF accessibility, combined Unicode/image/
citation/offline recovery, cancellation and previous-PDF rollback. The final
schema/diagnostic refinements then passed 24 lock, migration, storage, tree and
concurrent-command cases across those engines. These suites overlap and ran
across checkpoints; this is not a claim of one all-inclusive final matrix.

The environment acceptance test exercises warm-worker package accumulation,
explicit locking, export/import, cancellation, corrupted bundles, a native
IndexedDB quota failure, preservation of a different prior lock after failed
imports, byte-exact source ZIPs, offline reload, and refusal of an undeclared
package with the previous PDF retained. The dialog also passes the enabled axe
WCAG A/AA rules without exclusions.

The private IEEE paper was re-imported unchanged in a fresh browser, locked,
exported and recompiled offline: five pages and 121,508 PDF bytes. Its 89,916-byte
supplemental bundle and JSON lock remain local under ignored `tmp/`, together
with the PDF/report. No private document was committed.

Goal 2a completed environment transfer. Goal 2b below adds a smaller baseline,
immutable distribution components and complete compiler preparation. The full
milestone 2 remains open for sharded metadata, resumable downloads, configurable
cache quotas, broader font/tool compatibility and transfer/peak-memory work.

## Smaller LuaLaTeX baseline and static components (goal 2b)

`cargo run --release -p scribyra-assets` verifies the original loader/data hashes,
reads their structured Emscripten indexes without executing JavaScript, and
reconstructs a LuaLaTeX-only data collection. The checked-in
`scripts/lualatex-baseline.json` selects core packages, the prebuilt format,
hyphenation, Lua font loader/cache, fonts and configuration. Generated `ls-R`
indexes describe only retained files. LZ4 framing uses the existing Emscripten
package API. The original combined engine binary remains unchanged.

The remaining runtime files become deterministic XZ/TAR components with
disjoint paths; large font collections split into bounded pieces. Distribution
ownership is derived from the pinned catalog, with unowned files grouped by TDS
directory. Their descriptors record `origin: distribution` and a readable label.
Resolution prefers these known versions over an external mirror. All archives
pass the same Rust SHA-512, XZ and safe TAR validator used for upstream packages.
They install into the compiler-only tree and never enter source exports.

Font aliases come from OpenType/TrueType family, full and PostScript names read
by native Rust `ttf-parser`. Shared Rust Unicode normalization matches explicit
missing-family errors to known components; arbitrary unknown families are not
guessed. This currently covers fonts already in the upstream compiler collection.

| Artifact | Bytes | MiB |
| --- | ---: | ---: |
| Previous extra data preload | 341,568,560 | 325.75 |
| LuaLaTeX baseline data | 45,641,875 | 43.53 |
| Expanded baseline (3,566 files) | 74,311,252 | 70.87 |
| All initial core assets, including engine and component index | 80,862,579 | 77.12 |
| Biber helper assets, loaded separately | 31,793,487 | 30.32 |
| All 2,276 optional archives (stored on the host) | 188,063,020 | 179.35 |

These are actual file sizes from the build, before HTTP compression, not a
promise of total network transfer or a peak-memory measurement. The baseline
data is 86.6% smaller. The builder still needs the full upstream archive as input;
the deployment prunes the original basic/recommended/extra preloads and obsolete
generated artifacts. At goal 2b, the component index was about 1.39 MiB and loaded
as one file. Goal 2c.1 replaces eager loading with the sharded metadata below. App assets and the separate upstream
catalog are additional. The native builder hashes cached outputs before reuse.

The goal-2b deployed directory was 308,443,945 bytes (294.16 MiB). Its hashes and
sizes are archived in [runtime-assets.json](measurements/runtime-assets.json). Reproduce
the report after building with
`node scripts/measure-runtime.mjs > docs/measurements/runtime-assets.json`.

**Prepare this project for offline use** verifies/caches core assets and Biber,
verifies supplemental archives, and applies a revision-checked environment lock.
The service worker stores runtime assets by SHA-256 and rechecks cached bytes.
It rejects truncated, oversized and modified responses, removes corrupt entries,
and can reuse earlier cache contents only after exact verification. A quota
failure permits verified online compilation but never reports offline readiness.
Package archives bypass service-worker caching and stay in the Rust-verified
IndexedDB package cache. The metadata loader also uses bounded reads and pinned hashes. The original
monolithic catalogs were checked this way at goal 2b; current compilation uses
the manifest/shards described below.

The dialog checks locked projects automatically and exposes **Check offline
availability** and **Clear compiler cache**. Clearing compiler caches also tries
to remove the older Emscripten preload database, and reports when an older tab
blocks removal. These operations do not touch project storage or package bundles.
Readiness is a check of current storage, not a guarantee against later eviction.
The app requires a production build on HTTPS or localhost for offline preparation.

This baseline changes compiler/catalog fingerprints. Earlier locks remain
explicitly incompatible; unlock, recompile and review a new lock when upgrading.
`dist/core/busytex/` contains standalone TeX distribution notices and a hashed
file provenance manifest. Original TeX/font bytes are preserved.

### Goal 2b validation

The final production build passes 28 core Rust tests, four native asset tests
and 79 JavaScript tests. The native tests reconstruct files across mixed LZ4
blocks, reject inconsistent framing, reproduce component archives and unpack
them with the actual runtime verifier. JavaScript tests execute the service
worker and preload templates with real streaming/crypto APIs: changed sizes and
hashes, corrupt caches, safe legacy reuse, quota failures, same-origin credentials,
component-cache bypass and preservation of source/shell caches are covered.
Fresh-wrapper reproduction remains byte-identical; a subsequent native build
verifies and reuses all cached generated outputs.

A broader production run passed 55 browser cases across Chromium, Firefox and
WebKit, with two expected Chromium-specific input skips. Coverage includes the
compilation matrix (Unicode, BibTeX, Biber, thesis and offline restart), Romanian
custom classes, live IEEEtran, package cancellation/corruption, environment
locks/bundles, source preservation, PDF controls/navigation and cancellation
rollback. Following the final asset-path/credential refinement, all 12 focused
runtime/font/cache/Romanian cases passed again across those engines. These are
the broader checkpoint plus final focused rechecks, not one full matrix on the
final build. The final checks include real CacheStorage corruption, readiness
invalidation and repair, compiler-cache clearing, font-family downloads and a
fresh offline locked compile.

The private IEEE ZIP compiles unchanged online and after offline reload to five
pages (121,508 PDF bytes); all 53 imported source/asset files export with identical
SHA-256 hashes. Its nine compiler-distribution components and IEEEtran archive
are cached and verified. The original thesis still reports its existing custom
class `Improper discretionary list` error; the previously corrected copy compiles
to 36 pages (2,299,089 bytes). Original ZIPs are not modified or committed. Private
reports and PDFs remain under ignored `tmp/`.

This completes the bounded goal 2b. Goal 2c.1 below addresses sharded metadata. Milestone 2 still requires
resumable transfers, configurable cache limits, broader font/tool diagnostics and
transfer/peak-memory measurements before advancing to MCP.

## Sharded metadata and offline portability (goal 2c.1)

The native Rust builder publishes 256 filename shards and 256 package shards.
A SHA-256-derived byte chooses each bucket; filenames retain their exact case
and UTF-8 spelling. A small pinned root lists shard hashes/sizes and known font
families. A baseline-only compile fetches this root and no package shards. On a
missing-file failure, Rust extracts lookup keys, the worker fetches matching
filename indexes and candidate package records, and Rust applies the same TDS,
origin and ambiguity rules as the full catalog. Source errors such as undefined
commands and the known discretionary-list error do not trigger optional probes.

Package records merge incrementally into the Rust catalog. Duplicate identical
records are idempotent; conflicting records/snapshots fail before mutation.
JavaScript receives compact receipts rather than every runtime filename. Fetch
concurrency is limited to four; failed shard requests can retry. Every response
has a bounded size and SHA-256 check before parsing/merging.

Metadata uses a reserved namespace in the existing package-cache database, with
a separate 32 MiB budget. It bypasses HTTP/service-worker caching; persisted
bytes are verified on each read. Corrupt or missing records can recover online.
Offline readiness includes the root and every package shard needed by the lock,
in addition to verified archives and compiler/Biber assets. Cache presence alone
is not sufficient. Clear-compiler-cache also clears metadata; clear-package-cache
clears archives and metadata. Project storage is independent.

The new portable bundle embeds only its required root and package shards. Rust
verifies the complete root → shard → package → archive chain before returning
anything for caching. Import can bootstrap an empty metadata cache while offline,
and all archive/metadata writes and prior evictions share one transaction. A
quota failure leaves the prior caches and project lock intact. Successful cache
storage precedes the revision-checked project-lock update.

| Metadata artifact | Bytes | Scope |
| --- | ---: | --- |
| Previous eager catalogs | 2,518,077 | Upstream gzip plus distribution JSON |
| New startup root | 105,307 | 6,494 packages, 168,604 basenames and font routing |
| Filename shards | 6,807,909 | All 256 stored on the host; fetched as needed |
| Package shards | 10,883,912 | All 256 stored on the host; fetched as needed |
| Largest shard | 498,585 | Below the 2 MiB bound |

The root is 95.8% smaller than the earlier eager metadata payload. These are
file/body sizes before HTTP compression, not total transfer or peak-memory
measurements. The static deployment grows to approximately 310 MiB because it
also stores filename indexes. Full hashes/sizes are recorded in
[the current shard report](measurements/runtime-shards.json); reproduce with
`node scripts/measure-runtime.mjs > docs/measurements/runtime-shards.json` after
building. This remains static file delivery, with no package-installation server.

The production build and fresh-wrapper reproduction pass. There are 31 Rust core
checks (including portable proof validation), five native asset checks and 88
JavaScript checks. Coverage includes incremental/idempotent merges, immutable
conflict rejection, complete filename ownership in generated shards, real WASM
archive verification, corrupted persisted metadata and online recovery, bounded
responses, overlapping requests sharing four download slots, and atomic rollback
of both prior archive and metadata evictions after a failed write.

A broader production run passed all 48 compilation/runtime/environment cases in
Chromium, Firefox and WebKit. Following the final shared-concurrency refinement,
18 focused environment/runtime cases passed again across those engines. These
are a broad checkpoint and final rechecks rather than one full matrix on the final
build. The offline portability case clears all package/metadata records, injects
a failure specifically when metadata would be written, verifies an empty cache
and unchanged project lock, restores a bundle without networking, checks readiness
and compiles a newly imported project. No metadata HTTP request is made during
that restoration. The environment dialog also passes its existing axe audit.

The private IEEE ZIP was rechecked online/offline: five pages, 121,508 bytes, all
53 files exported byte-exactly and the original ZIP unchanged. The original thesis
still reports its existing discretionary-list error; its previously corrected copy
compiles to 36 pages (2,299,089 bytes). Private inputs/reports/PDFs remain ignored.

Goal 2c.1 is complete. The full milestone-2 gate remains open for resumable
transfers, configurable cache limits, broader component diagnostics and actual
transfer/peak-memory comparisons before MCP.


## Resumable transfers and cache limits (goal 2c.2)

Compiler assets, metadata and supplemental archives now share a bounded public
asset downloader. Interrupted bytes survive a reload in IndexedDB. Progress
continues from the durable prefix, and the next request asks for exactly
`Range: bytes=<saved>-`. Cancellation stops the active transfer and keeps its
checkpoint; **TeX environment** lists interrupted transfers with per-item and
whole-list discard controls. No package server or authenticated install API was
added: all compiler/component files can still be served as static assets.

A bounded list of unfinished operation UUIDs stays in tab session storage. A
reload/history navigation uses those same-origin cancellation capabilities to
stop transfers left by the previous document, even when the browser rejected
fetch before delivering `pagehide`. Completed transfers remove their token;
failed/cancelled tokens are discarded on the next recovery. This stores no
source, URL or credentials. A new tab with copied session storage clears the
copied tokens without cancelling its opener. Cross-origin and unknown-token
cancellation requests are ignored.

A resumed response must be HTTP 206 with an exposed `Content-Range` matching the
saved offset, final byte and pinned total, and must use identity encoding.
Servers can ignore Range, returning a full HTTP 200 instead; that response is
consumed from zero. Missing/malformed range headers, HTTP 416 and a CORS failure
cause one full-request fallback. A failed offline fallback preserves the previous
checkpoint. Waiting 30 seconds without headers or another byte also aborts the
transfer and preserves its checkpoint, independently of the overall compilation
timeout. Cross-origin mirrors must allow public GET requests; exposing
`Content-Range` enables efficient resume, while mirrors without it can still
serve full downloads. This follows the [HTTP range semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)
and the [Fetch CORS rules](https://fetch.spec.whatwg.org/#http-cors-protocol).

Only content pinned by size and SHA-256 (runtime/metadata) or SHA-512 (archives)
can use the downloader. Its storage keys contain algorithm, digest and size,
never a project path, request URL, credentials or source text. Checkpoints store
at most 256 KiB per hashed chunk, committing progress every 1 MiB and on a caught
interruption. Chunk hashes detect corrupt stored prefixes; the complete pinned
digest is always checked before returning executable/compiler bytes. A resumed
digest failure drops the prefix and retries from zero once. Archives still pass
the independent Rust SHA-512/XZ/TAR verification before installation.

Web Locks release transfer ownership automatically after a reload where
available; a 30-second IndexedDB lease is the fallback. Concurrent clients can
fetch independently when another owns a checkpoint, but cannot overwrite or
erase its progress. Interrupted entries expire after seven days, are capped at
256 records, and share a configurable byte budget. Quota failure or a disabled
partial cache permits a verified online download without claiming saved progress.
A checkpoint can lose its latest in-memory tail if the browser is killed before
a transaction commits. Resume depends on retained storage and server behavior;
it is not a promise that every failed request saves bandwidth.

Cache limits are device preferences, validated by the shared Rust policy. The
UI accepts whole MiB, with these defaults and supported maxima:

| Cache | Default | Maximum |
| --- | ---: | ---: |
| Package archives | 128 MiB | 2,048 MiB |
| Metadata | 32 MiB | 256 MiB |
| Compiler runtime | 256 MiB | 2,048 MiB |
| Interrupted downloads | 128 MiB | 512 MiB |

Zero disables a cache. Applying a lower limit evicts older public data and
invalidates the displayed offline result; it does not alter sources, history or
environment locks. A limit smaller than the required environment can prevent
successful offline preparation while online compilation continues. These are
application budgets, not reserved browser disk quotas, and exclude the app
shell, project data, transient download buffers and browser storage overhead.
Actual browser eviction can still remove prepared assets.

The public package database upgrades from version 1 to 2 with a small header
index. Inventory and eviction planning read headers instead of materializing all
archive bodies. Archive/metadata body writes, header changes, evictions and
settings share their relevant IndexedDB transaction. Runtime CacheStorage and
partial storage are pruned separately; an interrupted cleanup reports that the
preferences were saved and asks for a retry. CacheStorage does not provide a
global atomic budget transaction across concurrent clients.

The service worker removes the older unbounded compiler CacheStorage cache on
activation, and unrecognized legacy compiler paths bypass caching. The Biber wrapper uses the verified runtime cache rather than a
second large `EM_PRELOAD_CACHE` copy. Applying limits and clearing compiler data
also remove those legacy stores. An older tab can block deletion of its preload
database; the UI reports that condition and asks for the old tabs to close.
Fresh pinned wrapper extraction and repeat patching remain reproducible; engine
WASM binaries are unchanged. An adapter fingerprint change requires explicitly
unlocking an older environment and preparing its replacement.

Implementation: `crates/core/src/cache.rs` defines policy and deterministic
archive/metadata eviction. `web/download-state.js` contains the shared browser,
worker and service-worker adapter; `web/tex-cache.js` maintains the body/header
transactions. The checked-in JSON defaults are checked against Rust in tests.

The production build, Rust formatting and fresh pinned-wrapper/idempotence checks
pass, with 33 Rust core tests, 5 Rust asset tests and 105 JavaScript tests. Cases
cover exact durable offsets, SHA-256/SHA-512 retries, hidden/malformed/encoded
range responses, HTTP 416, offline fallback, corrupt checkpoints and complete
hashes, cancellation, idle timeouts, disabled caches, quota failure, concurrent
ownership, expiry, version-1 cache migration and blocked upgrades. Failed body
writes and eviction/settings updates roll back together; inventory does not scan
archive bodies.

A broader browser run passed 137 scenarios with six platform-specific skips.
It also exposed a WPE WebKit transport performance issue after a deliberately
reset HTTP keep-alive connection: resumed bytes were correct but arrived around
120 KiB/s, exceeding the existing 180-second job limit. The fault fixture now
uses `Connection: close` to isolate checkpoint/range behavior; diagnostic runs
then resumed the same data and compiled within seconds. This is a test-server
choice, not a deployment requirement. Recovery performance on persistent
connections and slow-transfer/job-timeout diagnostics remain explicit work for
goal 2c.3. The 30-second idle timeout handles absence of progress; it does not
limit the total duration of a transfer that continues receiving bytes.

The final production build passes **21 focused browser checks** across Chromium,
Firefox and WebKit: exact-offset resume after disconnect/cancel/reload produces
real PDFs; new tabs cannot cancel copied session capabilities; zero cache limits
preserve byte-exact sources without claiming offline readiness; lock, quota,
portable-bundle and offline recovery scenarios pass. The Firefox reload case
also covers fetch rejecting before `pagehide`, the ordering that initially lost
its cancellation marker. These final checks resolve the failures found in the
preceding browser runs; the persistent-connection performance boundary above
remains in goal 2c.3.

The unchanged private IEEE ZIP compiles online/offline to **5 pages / 121,508
bytes**, downloading its required supplemental package set. All **53 source
files** export byte for byte, and the original ZIP hash is unchanged. The
original thesis still reports its existing `Improper discretionary list` source
error; the separate compatibility copy compiles to **36 pages / 2,299,089
bytes**. Both private acceptance scenarios pass. Papers, PDFs and local test
reports remain ignored and are not committed.

Goal 2c.2 is complete. Full milestone 2 still requires the broader component
diagnostics and actual transfer/peak-memory measurements in goal 2c.3 before
MCP starts.

## Compatibility and actionable diagnostics (goal 2c.3a)

The asset builder verifies a reviewed set of fourteen optional upstream runtime
archives (510,892 compressed bytes) and seven corresponding source archives
(195,584 bytes). `scripts/tex-support.json` pins revisions, sizes, SHA-512 checksums,
compiler identity, license identifiers, language aliases and explicit prerequisites.
The original archives live in `vendor/tex/support`; their file contents are not
rewritten. They publish as optional content-addressed static files, outside the
initial LuaLaTeX data baseline. General package downloads still use the existing
TeX Live mirror.

This set covers French, German, Greek and Russian Babel support and associated
encoding/hyphenation files. Romanian retains its existing download regression.
Language aliases resolve through verified metadata rather than assuming every
Babel option is also a filename: Russian, for example, loads `russianb.ldf`.
Greek font encoding installs before its dependent language package. Locks must
include every explicit prerequisite; imported partial locks are rejected before
compilation. Other TeX Live dependency metadata is retained as provenance, not
interpreted as an instruction to install the complete distribution graph.

Selected static inputs avoid dependence on a mirror retaining old versions.
The November compatibility check found that the moving mirror had replaced the
pinned French archive. The historical database endpoint also returned an HTML
bot challenge instead of the pinned database. The catalog generator still
requires the exact expected database checksum; an HTML response cannot replace
it. Ordinary builds use checked-in verified inputs and do not require this
endpoint. This follows TeX Live's distinction between moving repositories and
[frozen releases](https://www.tug.org/texlive/acquire.html).

`crates/core/src/diagnostics.rs` classifies compiler evidence in Rust, shared by
WASM workers and a future companion. The compilation log shows a summary,
explanation and suggested action alongside the full raw log. Distinct issues
cover missing TeX files, project assets, fonts and font metrics; unsupported
external tools/engines/assets; format mismatches; bibliography and source errors;
package transfer failures; environment mismatches; and the overall compilation
deadline. Source, project-asset and external-tool failures suppress unrelated
optional package probes. Missing-glyph warnings remain visible after successful
compilation; Scribyra does not claim to choose a suitable font automatically.

Successful virtual filesystem reads record which project `.sty` and `.cls`
files were actually opened. These produce informational override notices, with
bounded evidence collection. Project packages and path-selected OTF files retain
precedence over downloaded components. Main documents with uppercase `.TEX` or
multiple dots keep their correct auxiliary filenames. Biber stages bibliography
sources with their original project paths and bytes, relative to the control
file's directory, including uppercase `.BIB` and distinct sources with the same
basename.

The compiler-execution deadline (180 seconds until November 10, 2026, now 600; see [large projects](large-projects.md)) is reported separately from manual cancellation and
the download idle timeout. A timed-out job preserves project source and the last
successful PDF. Download checkpoints can be reused on retry. The subsequent
execution-budget change below excludes component preparation from that deadline.

Format rebuilding, native tools, user-selected package versions, generated
bibliography files and full TeX Live dependency closure remain outside this
compatibility slice. Goal 2c.3b retains transfer/memory measurements, persistent
connection recovery and the remaining milestone-2 acceptance audit before MCP.

Validation on November 3, 2026: the production build and fresh-wrapper/idempotence
check pass; 39 core Rust tests, six asset-builder tests and 111 JavaScript tests
pass. The final 45-scenario browser run passes in Chromium, Firefox and WebKit.
It covers class-loaded multilingual support and offline reload, project package
and binary-font precedence with byte-exact source exports, actionable font/tool/
asset failures, timed-out worker recovery with the previous PDF retained, nested
Biber sources, live IEEEtran downloads, archive corruption/cancellation, locks,
portable offline environments and cache repair/removal.

Both private-paper checks also pass. The unchanged IEEE ZIP compiles online and
offline to five pages (121,508 PDF bytes), with all 53 imported source files
exported byte for byte and the original ZIP unchanged. The original thesis still
reports its existing `Improper discretionary list` source error; the separate
compatibility copy compiles to 36 pages (2,299,089 PDF bytes). Private papers,
generated PDFs and local reports remain ignored and are not shipped in the
repository. This completes goal 2c.3a; milestone 2 remains open.

## Browser transfer and memory measurements (goal 2c.3b)

`npm run measure:browser -- --runs=3 --output=tmp/runtime-browser.json` starts
a disposable loopback static server and runs three fresh browser processes and
profiles for each of three modes in Chromium, Firefox and Linux WPE WebKit:

- **Original collection:** the pinned `texlive-extra` loader/data and current
  wrappers/SDK, compiling a synthetic article with `amsmath` twice.
- **Smaller baseline:** the identical harness and document with the generated
  LuaLaTeX loader/data, also compiled twice.
- **Current app:** ZIP import of the same document, cold and warm compilation,
  verified offline preparation, then reload and compilation with the server
  refusing all network connections as well as Playwright offline mode.

The first two modes isolate the collection change. They do not recreate an
older Scribyra editor. The app mode includes its UI, PDF rendering, Rust workers,
verification and storage; its overall memory peak also includes offline
preparation and a third compilation. These are different workloads and must
not be presented as a direct old-editor/new-editor comparison.

The server counts response-body bytes written over uncompressed loopback HTTP.
This is actual payload delivery, distinct from generated file sizes; it excludes
HTTP headers/TLS overhead and is not a compressed-internet transfer estimate.
Request records identify bytes and completion, with separate cold/warm/preparation/
offline totals. Browser-managed service-worker update checks can bypass
Playwright's offline flag, so the server also refuses their connections during
the offline phase. The report records blocked attempts and requires zero bytes
served for offline compilation.

The sampler reads the spawned browser process tree every 250 ms using Linux
`status` and `smaps_rollup`. Reported peaks are observed lower bounds. Summed RSS
counts shared pages more than once; PSS proportions them, following the
[Linux process memory definitions](https://www.kernel.org/doc/html/latest/filesystems/proc.html).
Workers can share processes, so this does not label process RSS as an individual
worker's memory. Measurement-only weak-reference hooks observe WASM instances,
growth and message/phase boundaries without retaining discarded memories.
Linear-memory capacity is separate from resident memory. Chromium additionally
samples isolate heap and ArrayBuffer/external-string backing storage through
[CDP Runtime.getHeapUsage](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage).
Firefox/WebKit have no equivalent public Playwright endpoint in this tool.
Instrumentation overhead is included, no explicit GC is requested, and trials
run serially. No existing browser profile or private paper is opened.

The benchmark verifies the original loader/data SHA-256 pins before comparing
them. Compiler runtime verification remains active in the app. Large verified
worker assets are unchanged; the probe uses runtime inspection for the compiler
and small instrumented measurement-only app workers. `npm run measure:runtime`
also separates distribution archives from the reviewed runtime/source support
archives, rather than omitting the latter from deployment accounting.

### Measured results

The [raw browser measurements](measurements/runtime-browser.json) contain 27
trials on Linux 6.18.34 / Ryzen 7 7800X3D / 32 GB RAM, with three observations
per browser/mode. All cold/warm compiles and all nine server-enforced offline
reload/compiles succeeded. [Generated deployment sizes](measurements/runtime-delivery.json)
are recorded separately. Values below are medians; MiB means 1,048,576 bytes.
The raw `revision` identifies the application checkout; the measurement tools
and reports are versioned together in this checkpoint.

| Identical compiler harness | Original collection | Smaller baseline |
| --- | ---: | ---: |
| Cold response payload, all three browsers | 364.08 MiB | 75.75 MiB |
| Final compiler WASM linear capacity | 191.19 MiB | 159.31 MiB |
| Chromium sampled peak PSS | 1,551.6 MiB | 851.3 MiB |
| Firefox sampled peak PSS | 2,643.7 MiB | 1,175.5 MiB |
| Linux WPE sampled peak PSS | 2,605.6 MiB | 1,077.6 MiB |
| Chromium compiler isolate heap peak | 21.81 MiB | 5.24 MiB |
| Chromium compiler backing-storage peak | 658.80 MiB | 173.76 MiB |

Cold compiler payload falls **79.2%**, including the engine/loader rather than
only the data file. Sampled peak PSS falls about 45–59% within each browser for
this harness. These figures cover one small synthetic article; they do not
establish costs for every paper or device, nor rank browser implementations.

| Complete current app | Cold response payload | Cold sampled peak PSS | Overall sampled peak PSS |
| --- | ---: | ---: | ---: |
| Chromium | 84.71 MiB | 1,193.3 MiB | 1,317.7 MiB |
| Firefox | 84.71 MiB | 1,460.2 MiB | 1,729.0 MiB |
| Linux WPE | 84.69 MiB | 1,356.0 MiB | 2,136.7 MiB |

The overall app peak includes warm compilation, Biber/runtime preparation and
offline reload. All offline phases served **zero bytes**, with blocked browser
update/navigation attempts retained in the report. Full preparation fetched
about 30.3 MiB beyond the cold minimal-paper run. The highest individual app PSS
sample was 2,403.7 MiB; verification/storage/preparation remain substantial
memory costs and deserve targeted profiling. The deployment itself is
326,167,115 bytes, with optional components kept on the host and fetched on
demand. Reviewed support adds 510,892 runtime bytes and 195,584 source bytes;
these are accounted separately from the initial data baseline.

The production app/compiler assets were unchanged during this measurement
checkpoint. The 15 focused browser checks pass across Chromium, Firefox and
WebKit: exact-offset disconnect/cancel/reload recovery with real PDFs, zero
cache budgets preserving sources, and the deliberate repeated-font-path error.
They complement the preceding compatibility gate, rather than reclassifying a
slow persistent-connection observation as a passing recovery test.

### Expanded-delivery audit before the compiler-profile checkpoint

At the preceding measurement checkpoint, goal 2c.3b and milestone 2 remained open. Existing acceptance proves the smaller
baseline, sharded metadata, verified on-demand files/fonts and Biber, explicit
prerequisites, environment locks/bundles, cache controls, offline preparation,
project overrides and actionable errors. The additional font-path browser
regression exercises a real repeated missing-font request: after the indexed
family is installed, an invalid project `Path` stops with `resolution-stalled`
and each archive is requested once.

The subsequent checkpoint adds declared dependency manifests and separates
component preparation from the compiler execution budget, as detailed below.
The remaining gate at that point was the format/package-version and regeneration audit,
resolved by the compiler-profile checkpoint below.
Historical HTTP catalog regeneration currently returns an HTML challenge;
ordinary builds verify retained source inputs and need no access to that endpoint.
The runtime-archive pins are preserved; the Git database below supplies declarations
and file ownership, not replacement archive checksums. Native format rebuilding
and arbitrary package-version selection are not implemented. The compiler-profile checkpoint below records that scope and its verification.

Native platform executables and browser format rebuilding remain stated
boundaries; the current app runs LuaLaTeX, BibTeX/Biber and supported WASM tools.
This historical audit did not mark the expanded delivery milestone complete.
The acceptance decision below covers the supported LuaLaTeX release and preserves
the project's remaining roadmap.

## Declared dependencies and slow preparation

The native Rust builder now verifies a retained, dated upstream database in
`vendor/tex/catalog/texlive-master-2026-03-02.tlpdb.xz`. Its repository, commit,
Git blob, compressed SHA-256 and raw SHA-256 are pinned in
`scripts/tex-dependencies.json`; the original bytes are preserved. The source is
`Master/tlpkg/texlive.tlpdb` at commit
`bf6f72cb7d8f9a6c32e01288fbfa3da83560dbab` in the full TeX Live Git mirror
[referenced by TUG](https://www.tug.org/texlive/svn/) and
[documented on the TeX Live list](https://ftp.tug.org/pipermail/tex-live/2026-September/052592.html).
The native Git transport was accessible when the historical HTTPS database was
blocked. A partial bare fetch with `--filter=tree:0` and
`--shallow-since=2026-03-01T00:00:00Z`, followed by a lazy fetch of this one blob,
retrieved the metadata without a full distribution checkout. No network access
to that mirror is required during ordinary builds.

Every one of the **4,218** frozen runtime package revisions and complete runtime
file lists matches this source. The IEEEtran repack uses its recorded original
runtime revision for that comparison. The source adds **8,418** dependency nodes
including collections, schemes and tool packages, after excluding four
`00texlive.*` installation/settings records. Fourteen current support archives
supply separate overrides with their verified revisions/checksums, upstream
names and tested `requires` prerequisites. Base declarations remain available
alongside these overrides; a newer archive's declarations are not attributed to
an older compiler component.

The generated manifest is **889,299 bytes**, content addressed and pinned by the
111,848-byte catalog root. It is loaded on demand, not during initial compilation.
**TeX environment → Download catalogue dependency manifest** exports the public
JSON. Installed package details retain the source package/revision and distinguish
explicitly empty upstream declarations from absent metadata. Of 6,499 advertised
package/component entries, 6,481 have verified declaration provenance; 18
compiler-derived `dist--extra-*` components lack an upstream package owner and
remain explicitly without provenance. They are not represented as a proven empty
dependency graph. The full database and archive prerequisites are validated in
Rust, including names, sizes, references and bounded cyclic closures.

These are upstream declarations, not a proof of every file a TeX document can
request. Collections may contain other engines or native binaries; `.ARCH`
templates are reported as architecture requirements and never installed as
browser executables. The browser keeps demand-driven file resolution and installs
reviewed runtime prerequisites first. It does not eagerly download entire TeX
Live collections. Offline preparation caches the manifest; portable bundles carry
and verify it with the root/shard/archive chain, reject a missing or incompatible
graph, and restore it atomically with the packages. Locks from the preceding
adapter/catalog remain incompatible by design: use the matching build or
explicitly unlock and review a newly compiled environment.

Compiler execution now has a **cumulative budget across compiler calls**: 180
seconds when introduced, raised to 600 seconds on November 10, 2026 because a
generated 250-page thesis needs four to six minutes ([large projects](large-projects.md)). Preparing runtime assets or downloading packages does not consume that
budget. Existing download idle limits, bounded package processing and manual
cancellation remain active. A real WPE HTTP/2 trial with the resumed response
paced to 153,600 bytes/second compiled successfully after **286.985 seconds**,
including verification and compilation. The browser regression also advances
the clock past 180 seconds during a held runtime transfer, then finishes the same
job; a separate runaway-TeX case still times out and preserves the previous PDF
and source.

[Transport observations](measurements/transport-recovery.json) retain the measured
runtime identities and public synthetic inputs. These precede the dependency
manifest change and complement the earlier 18 HTTP observations:

- HTTP/1 over TLS: 18 trials across three browsers and two connection modes;
  17 compiled within the 12-second observation window. One persistent WPE trial
  was still transferring at 117,289 bytes/second and was manually cancelled.
- HTTP/2 over TLS: all nine trials negotiated HTTP/2, resumed the exact prefix,
  verified the full asset and compiled. This establishes the tested configuration,
  not a universal hosting-performance guarantee.
- Controlled plaintext WPE comparison: all three 8 KiB range-chunk trials
  compiled, while all three 64 KiB trials were still transferring at roughly
  118 KB/second after eight seconds. Socket observations during the slow state
  showed a 24 KiB receive window and a sender limited by that window for more
  than 99% of the interval. This supports a transport/window/packetization
  interaction; disabling checkpoint writes did not resolve it.

HTTPS alone is not a demonstrated fix for this Linux WPE behavior. HTTP/2 is the
best-tested hosting configuration here. Slow active downloads can now complete
without using up the compiler budget. Browser, OS and server packetization
remain relevant to throughput; no application-side TCP fix is claimed.

Validation for this checkpoint on November 3, 2026: production build and fresh
wrapper/idempotence verification pass; **47 Rust tests** (40 core, seven native
asset-builder) and **115 JavaScript tests** pass. All **51 browser scenarios**
pass across Chromium, Firefox and Linux WPE WebKit, including lazy metadata,
dependency export, portable offline import, cache repair and both deadline cases.
The private IEEE ZIP compiles unchanged online and after an offline reload to
five pages (121,508-byte PDF); all 53 imported source files export byte-for-byte
and the original ZIP hash is unchanged. The original thesis retains its
`Improper discretionary list` source error; a separate corrected copy still
compiles to 36 pages. Private sources, test harnesses and generated PDFs remain
ignored and are not included in the repository.

A final HTTP/2 confirmation using the dependency-manifest build also passes in
all three browsers: exact-offset 206 responses, full verification and real PDFs.
Its runtime identity and response records are included as `currentManifestHttp2`
in the transport report; it is separate from the nine earlier protocol trials.

## Pinned compiler, format and delivery acceptance

The supported browser compiler is **LuaHBTeX 1.24.0**, exposing LuaLaTeX through
one prebuilt `luahblatex` format. `scripts/tex-compiler.json` records the engine
binary, format path/size/SHA-256, source distribution, release-pinned package
policy, and the absence of browser format rebuilding and shell escape. The
native builder verifies the actual 32,507,525-byte WASM binary and 5,654,663-byte
format against those pins before publishing the effective catalog. Both the
compiler manifest and catalog root carry the profile. Rust validates the profile
against the active runtime and binary before package metadata is merged; portable
bundle imports validate it against their authenticated runtime/catalog chain.
**TeX environment → Compiler and catalog identity** displays the implementation,
format and format checksum.

A real expl3 dependency-version failure can attempt a diagnostic pipe before
printing its usual mismatch error. This runtime disables such commands. The
shared Rust report recognizes that specific `ExplLoaderFileDate` failure, explains
the format boundary and suppresses optional package downloads. An unrelated
piped-command failure is not classified as a format mismatch. The browser case
changes the format's expl3 date token, runs the actual installed expl3 loader,
checks the resulting failure, preserves the previous PDF/source, undoes the edit
and compiles successfully again.

The supported package-version workflow is an exact release pin plus explicitly
reviewed support overrides and runtime-identical repacks. Unlocking permits a new
observed package set in the current release; it does not select an arbitrary
TeX Live version. A different release has a different runtime/catalog identity.
Importing an incompatible lock or silently changing archive bytes is refused.
Rebuilding a format with different kernel files is a compiler-release build task,
not a missing-package recovery operation. A runtime version picker, arbitrary
format generation, other engines and native executables are outside the confirmed
LuaLaTeX browser release. These limits do not replace the milestone's required
file/font/tool downloads, locks or offline behavior.

The milestone-2 acceptance audit maps the original scope to evidence:

| Requirement | Implementation and verification |
| --- | --- |
| Static engine/format and package manifests | Native compiler/format pins, 2,276 immutable distribution components, 512 filename/package shards, public source/license notices and verified dependency declarations. Root hashes authenticate the metadata. |
| Smaller initial baseline | The pinned data collection is reduced from 325.75 MiB to 43.53 MiB; measured cold compiler payload falls from 364.08 to 75.75 MiB. Reports retain their exact measured runtime identities. |
| On-demand files, classes and dependencies | Real Romanian/algorithm packages, live IEEEtran, class-loaded multilingual Babel, tested prerequisites and missing-filename retries. Successful optional probes trigger no downloads. |
| Fonts and tools | Indexed OpenType families, project font/package precedence, nested case-sensitive Biber paths and distinct same-named bibliographies. Unsupported native tools, assets and fonts have actionable reports. |
| Bounded retries and version failures | Repeated font-path failures stop after one installation per archive. Genuine expl3 version-check failures stop without unrelated downloads and preserve the previous PDF. |
| Integrity and mirror changes | Rust verifies SHA-512/XZ/TAR contents, file paths and complete runtime lists. Corrupt archives fail; caches are revalidated; locks reject runtime/catalog drift and undeclared packages. |
| Progress, resume and cancellation | Exact-offset range recovery after disconnect/cancel/reload, full final hashes, bounded checkpoints and visible byte progress. A 287-second active transfer completes outside the separate compiler execution budget. |
| Inspection and cache controls | Per-package/source-revision receipts, dependency export, removal, independent cache budgets, corruption detection/repair, zero-budget online operation and preserved project storage. |
| Offline project preparation | Runtime/Biber and locked public packages/metadata are verified on-device; a new project imports a portable package bundle with cleared caches and compiles offline. |
| Portable locks and bundles | Rust validates the runtime/root/profile/shard/archive chain. Atomic cache imports roll back on quota failures and reject corrupted, missing or extra records. Source ZIPs remain source-only. |
| User projects and source preservation | The unchanged IEEE ZIP compiles online/offline to five pages with 53 byte-exact source exports. The thesis source error remains explicit; its separately corrected copy compiles to 36 pages. |
| Transfer and memory evidence | 27 serial browser trials include nine server-enforced offline app reload/compiles. Process PSS/RSS and WASM/worker measurements are distinguished; desktop-only sampling limits remain documented. |
| Transport limits | Linux WPE can be slow on some HTTP/1 transfers. HTTP/2 exact-offset recovery passes in the tested matrix; active transfers no longer consume the compiler budget. No universal TCP-performance fix is claimed. |
| Reproducible retained inputs | Frozen compressed/raw catalog hashes and all 4,218 dated source identities are verified offline; native generation verifies the compiler collection and retained support archives. Historical HTTP refresh remains a separately documented maintainer operation. |

### Catalog verification and upstream refresh

Ordinary builds regenerate the effective static components and metadata from
retained, pinned inputs. They do not query an advancing package database.
`scripts/tex-runtime-catalog.json` now pins both the compressed runtime catalog
and its decoded JSON, including source provenance and all 4,218 archive entries.
The independent dated Git database checks every original runtime revision/file
list; it supplies declarations, not replacement archive checksums.

Run `npm run tex:catalog:check` to verify these inputs with the native Rust tool.
The check reads local files and does not update pins. `npm run build` then
regenerates/verifies the effective repository and embeds the exact runtime/profile.
A changed catalog or compiler binary is rejected before it can become an
unreviewed update to a locked environment.

The historical HTTP endpoint currently returns an access-denied HTML page. The
public rsync service advertises only its historic module and does not expose the
daily archive module; FTP and the uncompressed HTTP variant did not recover the
required source in this audit. This does not prevent retained-input builds, but
means a fresh historical HTTP re-fetch was not verified at this checkpoint.
The original upstream extraction/repack comparison was verified during the first
package-delivery slice, as recorded above. Do not substitute today's database.

For a maintainer who has the exact original public database and old/replacement
repack archives, upstream regeneration can run entirely from local inputs:

```sh
npm run tex:catalog -- --database /path/to/texlive.tlpdb.xz --archives /path/to/archive-inputs --check
```

Archive input filenames are `<sha512>.tar.xz`, allowing both revisions of a repack
in one directory. This still verifies the original database SHA-256, both archive
SHA-512 pins and every repacked runtime byte. `--check` compares regenerated JSON
without writing; a regular refresh retains the existing gzip bytes when the JSON
is identical, and atomically replaces the output when a reviewed input changes.
`--output` selects a separate review artifact. Updating the frozen pin file is a
separate reviewed source change. HTML or another snapshot is rejected before
changing the output; a regression test verifies both the existing output and the
checked-in catalog survive that failure.


Final validation on November 3, 2026: **49 Rust tests** (41 core and eight native
asset-builder), **119 JavaScript tests**, production build, offline catalog check,
repeat cached-asset verification and fresh-wrapper/idempotence check pass. All
**45 browser scenarios** pass across Chromium, Firefox and Linux WPE WebKit,
including the genuine expl3 failure, source/PDF preservation and recovery, live
IEEEtran, corrupt archives, multilingual/fonts/Biber and portable offline imports.
Both private-paper checks pass again with the new profile: unchanged IEEE online/
offline with 53 byte-exact sources, and the original thesis error plus the separate
36-page corrected copy. Private papers, harnesses and PDFs remain ignored.

This completes the milestone-2 gate for the confirmed pinned LuaLaTeX browser
release. It does not claim arbitrary CTAN/native-tool compatibility, runtime
format rebuilding, a package-version picker, low-memory/mobile acceptance or a
working historical HTTP source re-fetch. The actual static input/build workflow
and those boundaries are stated above. MCP, local sync, review/history, Git,
extensions, remote collaboration/encryption and release readiness remain required
later roadmap milestones; the overall project goal remains active.

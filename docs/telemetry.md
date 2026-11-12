# Telemetry and local diagnostics

Milestone T is delivered in the T1–T4 sequence in [the roadmap](roadmap.md#priority-milestone-t-telemetry-diagnostics-and-grafana).
This document records implemented behavior and its acceptance evidence. Central
collection, broad runtime coverage, dashboards and CI integration remain later
deliveries; local diagnostics alone do not complete milestone T.

## Local controls and evidence

Source-tree and self-hosted builds have no ingestion address, destination label or
disclosure link: `scripts/official-telemetry.mjs` holds them, and only
`npm run build:pages` injects them as `VITE_TELEMETRY_INGEST_URL`,
`VITE_TELEMETRY_DESTINATION_LABEL` and `VITE_TELEMETRY_ABOUT_URL`. Official releases
select Grafana Cloud Frontend Observability (Faro) in the EU region. The prompt names
it and links [What Scribyra collects](../site/telemetry.html), a plain page
on the Pages site that Diagnostics also links. A self-hoster can set
`VITE_TELEMETRY_INGEST_URL` to their own Faro receiver or existing anonymous ingress;
the prompt then names that exact address and does not inherit the official label.

Every category starts off. Save choices enables only the chosen categories;
No thanks persists refusal. Closing or ignoring sends nothing. Opening a project
dismisses the unanswered prompt and discards draft checks without granting consent;
the choices remain in Diagnostics (projects sidebar, or More tools in a project). An unanswered prompt can appear on one subsequent
visit, then stops. A second tab leaves the first tab's prompt and draft alone until
someone decides. The prompt is a strip docked to the bottom of the dashboard. It
reserves its height, so dashboard controls scroll clear of it, and dismissing returns
focus to where it came from, then to Diagnostics, then to More tools, then to the first visible button.
Diagnostics always offers the same choices when a destination exists. Turning off any
category aborts current delivery and drops queued records; other tabs on this origin
apply changes too. Choices persist per browser profile/origin and exact destination.
A changed destination requires fresh consent.

**Consent fails towards not sending.** Consent is re-read from storage before every
record is admitted and every request is sent, so clearing site storage in the same tab
stops delivery at once with no reload. Consent that cannot be read, or that is
malformed, is no consent. If a choice cannot be written, typically because
`localStorage` is full, the stored value is removed, which also stops peer tabs and
later reloads. If it cannot be removed either, a tab and session tombstone refuses
that exact value. The new choice then applies to this tab only, with a warning, and a
reload sends nothing without another choice. A tab where only `setItem` fails keeps
that in-memory choice until reload, and a same-tab storage clear cannot be detected
in that one state because the stored value is already absent. A tombstone cannot reach
a tab opened in a new session if a value could be neither rewritten nor removed. If
preferences cannot be stored, the automatic prompt stays hidden so reminders cannot
repeat indefinitely.

| Category | Remote fields beyond shared metadata |
| --- | --- |
| Performance and timing | Rounded duration, size range and worker memory range |
| Errors and failures | Failure outcome and fixed error category; no error messages or logs |
| Feature usage | Operation occurrence and rounded count |

Rust validates and projects each record before the anonymous exporter receives
it (`consent_record` in `crates/core/src/telemetry.rs`). Each operation is classified
by an exhaustive match, so a new operation stays local until someone classifies it:

| Class | Operations | Remote behaviour |
| --- | --- | --- |
| Local only | `storage_commit`, `local_tabs`, `command`, `workspace_search`, `source_outline`, `source_map`, `sync`, `sync_connect`, `sync_io`, `sync_http`, `sync_observation_drop`, `mcp`, `companion_http`, `companion_connection`, `provider`, `native_session`, `test_run`, `telemetry_drop`, `telemetry_snapshot_drop`, `telemetry_delivery` | Never sent under any consent. They fire per edit, keystroke, search, command or prompt. Save failures are therefore not reported, except quota through `storage_quota`. |
| Failure signal | `exception`, `rejection`, `storage_quota`, `retry`, `recovery` | Their names reveal a failure, so they require the failures category. |
| Lifecycle | `startup`, `worker_startup`, `compile`, `worker_pass`, `tex_pass`, `bibliography_pass`, `index_pass`, `package_prepare`, `download`, `verify`, `cache`, `cache_evict`, `pdf_prepare`, `runtime_transfer`, `storage_read`, `migration` | Sent for the categories chosen. |

Experimental direct sessions add no operation to this list. Signalling, WebRTC
connections, identities, invites, rooms, peers, comparison codes, signatures and
authority requests record nothing (`tests/telemetry-consent.test.mjs` checks that the
direct modules and `web/service-client.js` never call the recorder). Changes a peer
or the local person makes during a session go through the same `command` and
`storage_commit` operations as any edit, both local only. A competing binary version
preserved from a peer is the existing `recovery` failure signal, sent only with the
failures category and carrying no project, session or peer detail. The telemetry
session ID (below) is unrelated to direct sessions and never derived from them.

Start records are omitted; error outcomes/categories are removed without error
consent, and measurements are filtered independently. Every sent value is coarse;
local diagnostics keep exact values.

| Value | Sent as | Why |
| --- | --- | --- |
| `bytes` | Rounded down to a power of four | Compiled PDF size must not trace the document. 1158 of 2297 catalog archive sizes were unique, so exact sizes revealed the package list; the whole catalog now falls into at most eleven buckets. |
| `memory_bytes` | Rounded down to a power of two | Capacity grows in steps; the scale is what matters. |
| `duration_ms`, `count` | Rounded down to 1, 2 or 5 × a power of ten | Scale is enough for performance work. |
| Time | Clock origin floored and relative time rounded up, each to the minute; the Faro mapper floors the sum again | Exact timing is never needed remotely. Rounding relative time up keeps a duration below it, which batch validation requires. |

Shared metadata is the operation/runtime, random trace/span IDs, rounded relative time
and app build identity. Shared metadata is retained only in admitted records. Existing
ingress batches include their clock origin and delivery counters; Faro maps these to
timestamps and fixed delivery attributes (below). Timing/failure records necessarily
also reveal that an operation ran. No document contents, file/project names, paths,
prompts, tokens or credentials enter this schema. No persistent visitor identifier,
cookies, authorization header or referrer is sent. The host still sees the
connection's IP address and normal browser request metadata.

Remaining inference, stated on the disclosure page too: with auto-compile on, a
compile follows a pause in typing, so compile records show roughly which minute one
ran. A PDF's scale, within a factor of four, is sent with Performance. The number and
order of package downloads within a compile trace are visible, though sizes are
bucketed and identical records within a minute collapse.

Consent starts gathering future observations without enabling local diagnostics
or reviewed exports. Existing explicit token-based per-tab connections remain
separate. Events collected locally before consent are never replayed remotely.
The official collector is selected; live ingestion/readback is reserved for the
architect’s consented check. No request to Grafana was made for this delivery. See
[activation and limits](telemetry-deployment.md#official-pages-destination).

### What is sent to Faro

The JSON body contains `meta` and only the nonempty category arrays below.
All records first pass the existing closed Rust schema and consent projection;
the Faro projection revalidates the entire batch in Rust/WASM. No Faro SDK or
automatic instrumentation is installed. Wire shapes were checked November 7
against Grafana’s [transport body](https://github.com/grafana/faro-web-sdk/blob/main/packages/core/src/transports/types.ts),
[measurements](https://github.com/grafana/faro-web-sdk/blob/main/packages/core/src/api/measurements/types.ts),
[events](https://github.com/grafana/faro-web-sdk/blob/main/packages/core/src/api/events/types.ts),
[exceptions](https://github.com/grafana/faro-web-sdk/blob/main/packages/core/src/api/exceptions/types.ts),
[metadata](https://github.com/grafana/faro-web-sdk/blob/main/packages/core/src/metas/types.ts)
and [fetch transport](https://github.com/grafana/faro-web-sdk/blob/main/packages/web-sdk/src/transports/fetch/transport.ts).

| Scope | Exact fields |
| --- | --- |
| Every body | `meta.sdk = {name: "scribyra", version}` (the app version; the collector refuses a body without `meta.sdk.version`); `meta.session.id` (see below); `meta.app.name = "scribyra"`; when validated build identity exists, `version`, `release` (`clean` / `local-changes`), optional `gitHash` (revision), optional `bundleId` (compiler adapter SHA-256) |
| Shared per record | `timestamp` (ISO UTC, clock origin + relative observation time); `trace: {trace_id, span_id}` (random operation correlation); `context` or event `attributes`: `runtime`, `source` (official app: `application`), optional `parent_span_id`, `dropped` and `sampled` (decimal strings, delivery deltas repeated within a batch), `sampling_rate` (the build's share of sessions that send: `1`, `0.5`, `0.25`, `0.1` or `0.01`; the same for every record of a build) |
| Performance and timing | `measurements[]`: `type` (closed operation name), `values` (only present coarse numeric `duration_ms`, `bytes`, `memory_bytes`), `timestamp`, `trace`, `context` |
| Errors and failures | `exceptions[]`: `type` (closed operation name), `value` (fixed error category, default `unknown`), `timestamp`, `trace`, `context` with `outcome = "failure"`. No error message or stack trace. |
| Feature usage | `events[]`: `name` (closed operation name), `timestamp`, `trace`, `attributes`, with optional coarse `count` (decimal string). An event records the occurrence even when no count metric exists. |

`timestamp` is ISO UTC rounded to the minute. Combined consent can project one filtered
observation into several arrays. Failure-signal operation names are omitted without
error consent. No `logs`, OTLP `traces`, `user`, `page`, browser fingerprint,
URLs, stack frames, persistent IDs, session attributes, session cookies or replay are
added. No raw
exception, console, document, path, file/project name, token or project object reaches
this mapper.

#### Faro session ID

The production collector refuses every body without a session: with no
`X-Faro-Session-Id` header it answers `400 missing X-Faro-Session-Id header, activate
the SessionInstrumentation`, and with the header but no `meta.sdk.version` it answers
`400 no SDK version`. An earlier revision of this page said no session ID was
required; that was wrong, and every record was refused. The architect's November 8
probe with the captured payload got `202 Accepted` once the header, an equal
`meta.session.id` and `meta.sdk` were present, and the collector's preflight allows
`content-type,x-faro-session-id`.

The session ID is 16 lowercase hex digits from `crypto.getRandomValues`, drawn for
itself alone: it is not derived from, and does not correlate with, the request
budget, build identity, trace/span/batch IDs or time. It lives only in the transport's
memory, never in `localStorage`, `sessionStorage`, IndexedDB, Cache Storage or a
cookie, so each page load and each tab gets a new one. It is replaced after at most
four hours, and also when local diagnostics are cleared or consent changes. Within that
window it links the records one tab sent; that is all it reveals. A new session's
first batch reports no `dropped`/`sampled` counts from the session before it.

Until November 9, 2026 the cap was one hour. Grafana bills Frontend Observability by
session and ends a session itself after at most four hours (or 15 minutes of
inactivity), almost certainly keyed on this ID (not confirmed), so a one-hour cap split one sitting into up to
four billed sessions without telling anyone anything new. The four-hour cap matches
Grafana's. The privacy cost: one ID can now link up to four hours of one tab's
coarse records (for example how many compiles one afternoon sitting had), instead of
one hour. It still cannot link two page loads, two tabs, or anything across a reload,
consent change or clear, because nothing about it is ever stored. Focus, visibility
and tab switches do not rotate it. Budget figures are in
[the free-plan budget](telemetry-deployment.md#grafana-cloud-free-plan-budget).

#### Session sampling

An anonymous session decides once, when it first has a consented record to send,
whether it sends anything at all. The decision is a fixed function of the session's
own random ID (`sessionSampled` in `web/telemetry-session.js`: the last eight hex
digits, read as a fraction of 2³², below the rate), so it never flips mid-session,
and a session sent at a lower rate is also sent at every higher one. Consent comes
first: without it nothing is recorded or decided. A session that is not sampled
sends nothing, not even an empty request; its records are counted locally only
(`unsampled` in the transport status), and Diagnostics says this tab's session was
not picked. A batch that outlives its session into an unsampled one is dropped.
Grafana's session count therefore scales with the rate, rather than every session
sending a few records.

The rate is fixed at build time: `VITE_TELEMETRY_SESSION_RATE`, which the official
Pages build takes from the CI variable `SCRIBYRA_TELEMETRY_SESSION_RATE` (default
`1`; allowed `1`, `0.5`, `0.25`, `0.1`, `0.01`; anything else fails the build, and an
invalid value reaching the app disables telemetry instead). It is recorded in each
batch's `delivery.sessionRate` and as `sampling_rate` on every Faro record, so a
dashboard estimates true counts by dividing by it. Token-based per-tab connections
always use `1`. How to change it is in
[the deployment guide](telemetry-deployment.md#changing-the-session-sampling-rate). A retry that crosses
a rotation is re-projected so the header and `meta.session.id` always agree. Rust
accepts only that shape, so no other value can be injected through it. `meta.session`
carries `id` only: no `attributes`, no `user`. The Faro SDK's own ID format was not
checked (its source is not vendored here); the probe showed the collector accepts this
shape.

The fetch sends only `Content-Type: application/json` and, to Faro,
`X-Faro-Session-Id`; it omits credentials/referrer and rejects redirects. Faro accepts any 2xx; existing ingress still requires 202. Retries
retain identical bytes, and duplicates at the receiver are accepted rather than
deduplicated.

`Idempotency-Key` was removed because nothing relied on it. Grafana's public SDK source
was read on November 7, 2026: tag `v1.19.0` of `transports/fetch/transport.ts` sends
`Content-Type` plus optional `x-api-key` and `x-faro-session-id`; `main` also adds
`Idempotency-Key`. `application/json` needs a preflight, as the SDK's own requests do.
The production collector's preflight allows exactly `content-type,x-faro-session-id`,
which is what Scribyra asks for.

If the collector still refuses a body (`400`, `409`, `413`), the tab stops sending,
drops what is queued and reports it: Diagnostics shows "Delivery failing: the
destination rejected these records" under the telemetry choices, with sent, waiting
and failed counts. A `401`/`403` reads "the destination refused this site". A
refusal never counts as sent.

Anonymous delivery has limits beyond the existing queue (128 records / 32 KiB),
32-record batches, 64-KiB encoded-body ceiling, five-minute age, three attempts and
eight-second timeout:

| Limit | Value |
| --- | --- |
| Deduplication | A record identical after coarsening, ignoring random IDs, is admitted once per minute |
| First send | At least 5 seconds after a record arrives |
| Spacing | At least 15 seconds between requests, so arrival times cannot echo typing |
| Session budget | 240 requests per tab session, carried across reloads in `sessionStorage`, then silence |
| Circuit breaker | Three consecutive failures pause 60 seconds, doubling to at most 30 minutes; one failed probe reopens it; the fifth trip stops the session. A success resets it |
| `Retry-After` | Honoured up to 30 minutes |

Consent changes cannot reset the budget or breaker. Explicit token-based per-tab
connections keep their earlier retry behaviour and are not subject to these limits.
Revocation aborts delivery and discards queued work. Offline, 429, rejection and
delivery errors stay silent; remote telemetry never blocks app work. Closing/reloading
can lose queued data, more often now that sending waits.

### Privacy review regressions

`tests/browser/telemetry-consent.spec.js` drives a real browser against a local fake
collector, in Chromium, Firefox and WebKit. It seeds canaries in the project name, file
name, source, pasted text and error text, then types 17 keys at known gaps and pastes
repeatedly, with local diagnostics on to prove saves really fired with growing sizes.
Payloads must carry no canary, no local-only operation, no exact local size and only
minute timestamps and bucketed values. Other cases cover real quota exhaustion with a
peer tab and reload, unremovable and unreadable consent, same-tab clearing, a second
tab, focus, layout at 1024×600 and 390×740, a strict cross-origin preflight, an error
loop against 2xx, 500, 429 and dropped sockets, a default-build string scan and the
disclosure page. `tests/telemetry-faro.test.mjs` covers the breaker and budget on a fake
clock. The real browser path for failure-signal gating uses a recovered copy; `retry`
itself is covered in Rust and through actual WASM only.

### Faro validation evidence (November 7, 2026)

Earlier evidence in this section predates the privacy review fixes. It describes the
then-current delivery timing and the since-removed `Idempotency-Key`.


Since November 8 every fake Faro collector in the tests rejects as production does:
a missing `X-Faro-Session-Id` header or `meta.sdk.version`, or a header that differs
from `meta.session.id`, gets a `400` with production's message (the mismatch message
is our own; production was not seen answering one), and a preflight asking for any
header beyond `content-type,x-faro-session-id` gets no CORS grant. The browser tests
scan every storage area for the session ID and compare IDs across reloads and tabs.

The local HTTP fake collector checks exact fields for all eight category combinations,
headers, seeded-secret rejection, stable retry bytes/key, 2xx/429/403 behavior,
sampling, queue/age/attempt bounds and abort-on-revocation. Browser consent tests
serve the configured app and fake collector over real local HTTP and inspect each
category independently,
pre-consent silence, persistence/revocation, failures/offline saving and the official
third-party wording/docs link. Official-address requests are blocked in tests.
Existing authenticated ingress and isolation tests remain in place.

The first single-worker seven-spec run stopped after **19 passes, 2 failures,
1 interruption and 122 unrun cases**. Chromium blocked the loopback collector
because the configured app document had been synthetically fulfilled by Playwright.
Serving both app and fake collector over real HTTP fixed the test fixture with
browser security enabled; the subsequent Chromium consent-only run passed
**16/16**, including all independent category payloads, accessibility and offline /
rejecting-collector saving. No consent/privacy assertion was weakened. Its command:

```sh
SCRIBYRA_TEST_PORT=6101 nix develop -c npx playwright test tests/browser/telemetry-consent.spec.js --project=chromium
```

The first full `npm test` passed **163 native / 1,073 JavaScript/WASM checks**,
with **1 JavaScript failure**, 2 existing native ignores and 6 optional-service
skips. The isolated Vite runtime-identity fixture had not copied the newly imported
`web/telemetry-destination.js`; Vite reported `Could not resolve
"./web/telemetry-destination.js"`. Adding that config dependency to the fixture’s
copy list fixed it; `nix develop -c node --test tests/runtime-identity.test.mjs`
then passed **1/1**. The full unit gate was rerun; no test was weakened or skipped.

A second unit invocation overlapped the browser gate and stopped in the frozen
folders CLI diagnostic-snapshot assertion: **123 native passes / 1 failure**;
later native suites and JavaScript did not run. The isolated unchanged assertion
passed **1/1** with:

```sh
nix develop -c cargo test -p scribyra-folders --test cli explicit_native_diagnostics_preserve_cli_output_and_exclude_inspected_content -- --exact
```

That overlapping browser run ended at **139 passes / 1 setup failure / 4 unrun**.
`npm test` regenerated `web/pkg` while a WebKit workspace worker held older JS
bindings, causing `WebAssembly.Instance(): ... function import requires a callable`
in `tests/helpers/core.mjs`. This was validation ordering, not an app failure.
Final validation keeps WASM generation and browser imports separate. No frozen
crate code, assertion, timeout or test selection was changed to obtain a pass.

The first assembled-Pages check passed **10/11** and found a real UI obstruction:
the unanswered card intercepted the thesis file-tree click. Opening a project now
dismisses the card without saving draft checks or granting consent. The two
light/dark consent-layout scenario titles were updated for that behavior; they
retain the dashboard accessibility audit and add draft-discard, no-request and
editor/review-control assertions. The existing Pages thesis workflow is unchanged;
no forced click, timeout increase or weakened assertion was used.

The configured Pages recheck passes **11/11** in Chromium, including the unchanged
thesis interaction, both app shells, no pre-consent requests and offline compile.
The normal source build was then restored. Exact Pages commands (the local server
selected port 33199; the Pages test variable points to its presentation root):

```sh
nix develop -c python3 -u -m http.server 0 --bind 127.0.0.1 --directory .pages
SCRIBYRA_TEST_PORT=6101 SCRIBYRA_TEST_PAGES_URL=http://127.0.0.1:33199/ nix develop -c npx playwright test tests/browser/{pages,pages-domains,agent-recipe,agent-surface}.spec.js --project=chromium --workers=3
nix develop -c npm run build
```

The server line runs in a separate terminal; use its printed port in the test URL.
The owned server was stopped by its exact PID after testing.

Final validation passes: `npm test` **163 native / 1,074 JavaScript/WASM**, **0
failures**, 2 existing native ignores and 6 existing optional-service skips. The
last affected-browser run passes **63/63**, 21 per engine, with no failures/skips:
all 48 consent cases and all 15 workspace cases, including the previously blocked
WebKit file. Combined with the **81 unchanged cases** that passed in the bulk
run, every one of the **144 distinct required browser cases** has passing final
evidence (48 per engine). This is aggregate evidence after the recorded reruns,
not a claim of an uninterrupted green 144-case invocation. Pages passes **11/11**.

Direct build commands: `npm run build` **2 passes**, `npm run build:pages` **2
passes**, fixtures **1 pass**; spec-internal configured Vite bundles also built
successfully. The two focused `node --test tests/telemetry-faro.test.mjs` runs
pass **5/5 each**, including against release WASM. Standalone `npm run wasm`
passes; runtime-identity **1/1** and unchanged folders-diagnostics **1/1** pass
as recorded above. A deliberately insecure configuration is rejected before
bundling (expected exit 1, `Use HTTPS, or loopback HTTP, with /collect[/id] or the
ingestion path.`):

```sh
nix develop -c npm run wasm
nix develop -c node --test tests/telemetry-faro.test.mjs
VITE_TELEMETRY_INGEST_URL=http://example.invalid/collect nix develop -c npx vite build --outDir .cache/faro-invalid-build
```

No real collector or private credentials were used; no push, deployment or new
TeX runtime download was performed. The Cloud CORS/rate settings are supplied facts, not a live provider audit.
The architect’s consented live record/readback, retention/access/budget review
and existing wider milestone-T work remain. Existing OTLP dashboards/native/CI
routes are separate; Faro dashboard parity is not claimed. Linux synthetic
projects/software-rendered WebKit and the optional-service skips remain limits.
The intermittent native diagnostic assertion under overlapping load is recorded;
no frozen crate code or timeout was changed. All owned servers/browsers are
closed, no core dumps remain, and disposable consent fixture bundles were removed.
The ordinary `dist` build is restored with no default destination. Earlier consent-only evidence below
describes the preceding delivery, whose mock collector is now replaced by the
local HTTP fake for the Faro cases.

```sh
nix develop -c npm run fixtures
nix develop -c npm test
nix develop -c npm run build
SCRIBYRA_TEST_PORT=6101 nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/{telemetry-consent,telemetry,telemetry-isolation,accessibility,workspace,agent-recipe,agent-surface}.spec.js --project=chromium --project=firefox --project=webkit --workers=3
nix develop -c npm run build:pages
SCRIBYRA_TEST_PORT=6101 nix develop -c env __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1 npx playwright test tests/browser/{telemetry-consent,workspace}.spec.js --project=chromium --project=firefox --project=webkit --workers=3
```

### Previous consent delivery evidence

Consent validation, November 7, 2026: final `npm test` passes **163 native and
1,069 JavaScript/WASM checks**, with zero failures, two existing native ignores
(the subprocess crash fixture and opt-in real-Alloy check) and six existing
private-stack/CI skips. The seven required browser specs pass **135/135**,
45 per engine, with no skips. After the page-show/startup retention adjustment,
the final consent spec passes **39/39**, 13 per engine, using the same browser
command with only `tests/browser/telemetry-consent.spec.js` and `--workers=3`.
The configured-build served recipe passes **9/9**, three per engine, with the
unanswered card present and the existing response budgets intact. Six
`npm run build` invocations pass, including that configured build and restoration
of the default build. A final default smoke check passes **1/1**; its command is
`SCRIBYRA_TEST_PORT=6101 nix develop -c npx playwright test tests/browser/telemetry-consent.spec.js --project=chromium --grep 'unconfigured source'`.
The restored bundle contains no test ingestion address. Fixtures were generated
once. No push, deployment, external collector or private credentials were used.
All 12 light/dark dashboard/editor screenshots at 1366×768 are retained locally
under `.cache/telemetry-consent-*-1366x768.png`; editor views were visually inspected
in all engines and the card was shortened after the initial inspection.

The initial consent-only Chromium run passed 10/10 before the later hardening.
Earlier broad unit/browser runs were deliberately interrupted for the error-only
operation-name and storage hardening; the browser run had 10 passes, one
interruption and 121 unrun cases. These are not claimed as complete gates. No
existing test was weakened, renamed or newly skipped. NixOS syntax parsing passes;
NixOS activation and hosted ingestion were not attempted. The following unsafe
build is deliberately rejected before bundling (exit 1):

```sh
nix develop -c nix-instantiate --parse ops/telemetry/ingestion.nix
VITE_TELEMETRY_INGEST_URL=http://example.invalid/v1/browser-events nix develop -c npx vite build --outDir .cache/consent-invalid-build
```

The preceding build rejected it with `VITE_TELEMETRY_INGEST_URL requires HTTPS (or loopback HTTP), no credentials, and /v1/browser-events.` The shared Faro/ingress validator now also permits `/collect[/id]`.
Linux/software-rendered WebKit, synthetic projects, mocked browser-consent collection
and the private-stack skips remain the limits; no real Safari/hosted-service claim.

### Local diagnostics

Open **Diagnostics** from the projects sidebar, or from **More tools** in the project top bar. Collection and export
are disabled by default. Enable **Collect local diagnostics**, reproduce the
problem, then use **Refresh timeline**. **Allow reviewed diagnostic export** enables
**Export preview**, which downloads exactly the displayed JSON. Events arriving
after that preview do not enter the download until the preview is refreshed.
Local inspection and export need no account, network or collector.

Preferences persist on this browser origin. Events remain only in the current
tab's memory, including when switching projects; closing or reloading the tab
discards them. Disabling collection clears the buffer and counters. **Clear
diagnostics** also discards them. Clearing or changing controls invalidates
in-flight diagnostic spans so a later completion cannot reintroduce old evidence.
The export control is separate from collection. Review a bundle before sharing;
operation timings and correlation still describe application activity.

The browser integration records startup through WASM initialization and UI mount
(if collection was enabled before reload), compilation attempts, worker processing,
PDF preparation, project commands, durable storage operations, migration/recovery,
package lookup/cache use and verified archive downloads. The timeline distinguishes
browser and worker runtimes. Error messages, stacks, filenames, URLs and rejection
payloads never become telemetry fields. See the delivery boundaries below.

## Shared v1 contract

`scribyra_core::telemetry` owns validation, buffering, clearing and export gates.
The `TelemetryRecorder` WASM class exposes the same recorder. A separately validated
optional build identity contains a numeric release version, Git revision, dirty
flag and compiler-adapter hash; it never contains a branch, path, remote or URL. Browser clocks,
random identifiers and preference storage live in `web/telemetry.js`; there is no
telemetry network I/O or destination in this delivery. Native callers can use the
Rust recorder without a browser or collector.

Records contain only the schema version, runtime and operation enums, typed
outcome and optional error category, random trace/span/parent IDs, monotonic
session-relative milliseconds and numeric measurements. There is no free-form
message or attribute map. Unknown fields/enum values, invalid or all-zero IDs,
unsupported versions, negative/non-finite/out-of-range numbers, duplicate
measurements and oversized records are rejected with fixed errors that do not
echo input. IDs must be generated independently of project/file identities and
must never be used as metric labels.

| Bound | Limit |
| --- | --- |
| Build identity | 256 UTF-8 bytes; closed fields, numeric version and hexadecimal hashes |
| Input record | 2,048 UTF-8 bytes before parsing |
| Retained events | 256 |
| Retained serialized event bytes | 64 KiB |
| Measurements per event | 4 distinct kinds |
| Measurement value | Finite, nonnegative, at most 2^53 − 1 |
| Relative timestamp | At most one year in milliseconds |
| Correlation IDs | 32 lowercase hex trace digits; 16 span/parent digits; nonzero |

The buffer evicts oldest events before exceeding either retention bound. Its
snapshot exposes serialized bytes, evicted-record count and rejected-record
count. Counts saturate rather than overflowing. The byte count covers serialized
events, not Rust allocator overhead or the snapshot envelope. Fixed record/count
bounds also bound that overhead. Events can outlive their parent after eviction;
the UI must not imply that an incomplete trace is complete.

Measurements are duration samples (`duration_ms`), byte or memory samples
(`bytes`, `memory_bytes`) and counter increments (`count`). T3 will aggregate
samples into distributions and bounded-label metrics. Trace IDs cross adapter
boundaries explicitly through the returned context; each child gets a new span.
Repeated completion is ignored. Child spans require a live context from this
recorder generation. Worker evidence is accepted only by its pending browser
span, with matching trace and parent IDs, a distinct child ID, bounded time/size,
worker runtime and Rust schema validation. Completed or revoked spans reject
late events; an old parent cannot start children after clearing or disabling.
Adapter/recorder/preference-storage failures are
isolated from application operations. Export failures surface locally.

Raw compiler logs remain in the existing separate compiler-log UI. The live log
shown while a compile runs (`web/compile-log.js`) is the same local data: the page
reads the worker's ordinary print messages, keeps at most 2 MiB in memory for the
open tab, and never stores it or passes it to telemetry or an exporter. Step names
in the status bar are local display text, not telemetry operations. Sources,
project/file names and paths, provider content, request headers, credentials and
arbitrary error strings are not accepted by the telemetry schema. Diagnostic
exports do not contain raw logs, screenshots, browser traces or paper artifacts.

## Verification

`cargo test -p scribyra-core` checks schema bounds, seeded private-field rejection,
buffer eviction, clearing and export policy. `npm run test:telemetry` builds the
actual WASM recorder and tests its privacy/retention/export behavior plus browser
adapter correlation, disabled collection, revoked spans and failure isolation.
`tests/browser/telemetry.spec.js` exercises controls, reviewed export while offline,
real failing compilation, correlation, source exclusion and continued editing.
The production browser results are recorded in the roadmap when verified.

Remaining milestone acceptance includes expanded runtime/native instrumentation,
standard exporters and safe ingress, an operating collector/storage/Grafana stack,
application ingestion/query readback, dashboards/alerts/retention/access settings,
actual test/CI reporting, measured overhead, and the full T4 failure/offline gate.

## T2a: browser, compiler workers, downloads and durable storage

The first T2 delivery implements the following paths without adding a destination
or collector dependency:

| Path | Implemented evidence |
| --- | --- |
| Startup | Module-body/WASM-init/mount duration, release version, Git revision and dirty flag, compiler-adapter identity |
| Compilation | Existing build-session attempt, typed success/source failure/cancellation, initialization and runtime-preparation durations, subsequent package-resolution attempt counts |
| Compiler worker | Measured worker-side compile-call duration, output bytes, available engine linear-memory capacity; linked browser RPC span and cancellation |
| Package worker | Worker-side metadata/package processing and archive verification, correlated to a pending browser request; worker failures, request timeout/cancellation and late-result rejection |
| Package cache | Hit/miss count for archive lookups, verified-prefix reuse bytes, save outcome and logical archive bytes |
| Download adapter | Logical verified byte count, actual fallback attempt count, digest-verification spans and integrity/network/idle-timeout/cancellation outcomes |
| PDF | Preparation duration and input PDF bytes under the initiating build trace |
| Project commands | Shared validator/dispatch success counts, permission/revision/category failures, without command arguments or request/project/file IDs |
| Storage | Durable save/read/revision/delete outcomes, encoded update bytes, project-schema migration and independent recovery; quota failure recorded after the original rollback path |

The classic compiler worker is patched reproducibly from its retained pinned
3-KiB source fixture. It emits only constructed safe observations; its ordinary
compiler results/log channel remains separate. Worker observation failure cannot
replace a compiler result or exception. Numeric memory evidence is the current
WASM linear-memory capacity, not process RSS, live allocations or total browser
memory. Download byte samples describe the completed logical asset (including a
verified resumed prefix), not compressed on-the-wire traffic. Retry counters
count attempts, not eventual successes.

Worker durations use worker clocks. Their timeline offsets are aligned to browser
request dispatch, rather than claiming synchronized independent clocks. The
browser span also measures scheduling/message-transfer time. Abrupt termination
can leave a worker start without a terminal worker event; the browser RPC and
build cancellation close independently. Clearing/reconfiguring diagnostics
revokes the whole in-flight trace for further local collection.

The existing compiler-adapter fingerprint includes wrapper/adapter code. This
delivery therefore changes that fingerprint; existing environment locks still
require their matching app/runtime or an explicit unlock and review. Telemetry
does not bypass an environment lock or rewrite it automatically.

T2 remains incomplete. The next delivery below adds detailed browser worker
evidence. Remaining work includes MCP/providers, companion/native sessions and
existing local-tab/sync paths, implicit compiler asset transfers when runtime
preparation is skipped, and the associated cross-runtime permission/cancellation/
restart correlation. The paused folder UI
is outside this work. T3–T4 still require collectors/exporters, deployed ingestion,
Grafana provisioning/readback, actual test/CI reporting and full measured
privacy/failure/offline/overhead acceptance.

T2a validation: the production build passes, as do 66 core Rust checks and 69
JavaScript/WASM checks (17 telemetry-specific plus 52 adjacent regressions).
Four Chromium scenarios pass across runs: offline reviewed export, failed
compilation with worker memory/correlation and continued editing, successful
worker/PDF preparation and offline recompilation, and real engine-loop
cancellation followed by a new worker. The successful-compilation fixture was
initially invalid TeX (unescaped underscores); it was corrected and that scenario
passed on recheck. Firefox/WebKit and measured collection overhead remain in the
wider acceptance work.

The new tests execute the actual WASM recorder and freshly patched classic worker,
reject seeded private fields/forged worker records/late generations, exercise real
permission and revision checks, and check quota rollback and independent recovery.
The existing competing-download test now holds an actual Web Lock when available:
Node versions exposing Web Locks can otherwise correctly reclaim a lease whose
supposed owner has no lock. Both the original code and instrumented code showed
the old fixture mismatch; the fixed scenario covers actual ownership.

## T2b.1: bounded worker and runtime-preparation observations

Dedicated search, outline and SyncTeX workers now return measured, correlated
observations through their existing request IDs. Cancelled/replaced requests
cannot publish later evidence. Neither a query, heading, path, source text nor
worker exception message enters their telemetry channel.

The compiler records individual synchronous LuaLaTeX/BibTeX/index invocations and
actual asynchronous Biber `run` calls. A backend check that skips Biber produces
no Biber invocation span. Wrappers preserve arguments, return values and original
exceptions and restore the methods after each compile. Compiler command names,
arguments, logs, bibliography contents and BBL output stay outside telemetry.
The integration gate executes real BibTeX and Biber and checks their ordinary
compiler logs alongside the corresponding safe span.

Metadata operations pass an explicit observer through root/shard loading,
verification, cache writes and committed evictions. Shared download/metadata
promises retain their original concurrency budget; observations belong to the
request that initiates the shared work. Cache hit counts describe lookup reuse;
a separate verification outcome establishes byte integrity. Cache write failures
(including quota), verified download bytes, retry attempts and actual eviction
counts/bytes are recorded without names, hashes, paths or URLs as event labels.

Each worker request can stream at most 128 observation records, followed by a
single two-record drop report. Compiler/package requests also return their two
aggregate worker records. Callers accept only small frames for an active request
and validate each record in Rust. The diagnostics status shows worker drops from
retained reports separately from local-buffer eviction. The 256-record/64-KiB
local buffer still applies; dropped/evicted evidence can leave incomplete traces.

Runtime preparation observes service-worker downloads, cached-byte verification,
cache writes and evictions over a private MessagePort. Registration uses the
existing preparation UUID and is bound to the initiating browser client. The
worker retains at most 32 registrations, with a 30-minute idle expiry and explicit
owned closure; another client cannot read or close that observation stream.
Status/clear requests carry their observations on their existing private port.
No telemetry context is added to network headers, compiler responses or cached
assets. Existing runtime cache/cancellation capabilities retain their rules.

Registration and final acknowledgement are independent of asset preparation.
Unsupported or restarted workers cannot hold a build waiting for telemetry. An
unacknowledged closure records an unavailable relay after one second and closes
its ports. This is a diagnostic-delivery failure, separate from the application
operation. The relay observes explicit preparation: implicit engine-worker asset
requests when prewarming is skipped still need coverage before T2 is complete.
No collector or remote export destination is configured by this delivery.

Validation: production build; 66 core Rust checks; 67 targeted JavaScript/WASM
checks; seven Chromium scenarios across runs. Browser evidence includes offline
compile/PDF and reviewed export, actual engine cancellation/restart, failed
compilation, real search/outline/SyncTeX worker results, service-worker download
correlation, and real BibTeX/Biber runs. The initial BibTeX fixture omitted its
publisher and returned a warning exit status; the complete fixture passed on
recheck. Biber counting was then tightened to actual execution, with a successful
production recheck. Tests also prove registration ownership/cap/release,
per-request drop bounds, quota/integrity outcomes, cancellation/late-response
rejection, optional-relay timeout isolation and seeded-content exclusion.

MCP/provider/native/live-sync instrumentation, omitted transfer paths, remaining
browser platforms, deployed ingestion/Grafana and the full T4 acceptance remain
required. Folder synchronization stays paused.


## T2b.2: Service and native observations

The shared Rust schema now covers the optional companion, the existing native
folder-session CLI, local-tab merges and the loopback sync demo. This instruments
existing functionality; folder synchronization development remains paused.
Browser MCP spans contain child commands, search-worker calls and compilation.
Provider connection/request spans preserve values and exceptions; an MCP tool's
`isError` result is a failure even when its HTTP response succeeds. Only fixed
categories enter diagnostics. Arguments, results, source, provider names/URIs,
project identifiers, credentials, error text and filesystem paths are excluded.

The companion advertises diagnostic protocol 1 during pairing. A supporting
browser opts into it during its authenticated WebSocket handshake. Only these
sessions receive the native request's strict random trace/span IDs; older peers
keep their existing packet shape. The browser adopts IDs only after Rust checks
the session, project and sequence. Invalid optional diagnostic metadata is
ignored without granting permissions or rejecting an otherwise valid operation.
Local provider requests carry IDs only to a supporting authenticated companion;
external HTTP providers receive no added context or diagnostic headers.

Native collection defaults off. Set `SCRIBYRA_DIAGNOSTICS=1` to collect in the
same 256-record/64-KiB recorder. Additionally set `SCRIBYRA_DIAGNOSTICS_DIR` to
explicitly enable local JSON export. Choose a directory outside project/sync
roots. Each process creates a random private child directory (0700 on Unix)
and atomically replaces its single `snapshot.json` (0600). No network export
occurs. Keep or remove these process directories according to local retention
needs; later invocations do not overwrite earlier support evidence.

A background thread writes at most four snapshots per second. Its queue holds
only the latest pending snapshot, alongside at most one active write; request
handling never performs disk I/O. Coalescing reports `telemetry_snapshot_drop`
counts and `nativeDelivery.skippedSnapshots`; output failures increment
`nativeDelivery.writeFailures` on a subsequent successful write. These counters
measure snapshot delivery, separately from event-buffer eviction. Export failure
leaves application results unchanged. The companion and CLI make a bounded
one-second flush attempt on normal shutdown. Abrupt process termination can lose
the last pending snapshot. `SCRIBYRA_BUILD_REVISION` accepts only a full hex
revision; `SCRIBYRA_BUILD_DIRTY=0` explicitly marks it clean. Unknown revisions are
marked dirty, with no environment or filesystem details in the envelope.

Local-tab spans describe actual head merges/deletions and failures; unchanged
polling creates no merge records. Recovery saves inherit the merge's context.
The browser sync demo records connection attempts, blob HTTP operations,
integrity verification and incoming merges. Outgoing update spans finish at the
durable acknowledgement. Tracking is limited to 32 receipts; excess observations
produce `sync_observation_drop`, leaving the abandoned spans incomplete while
preserving acknowledgement ordering. Reconnect/close cancels retained spans;
stale socket callbacks cannot complete a newer connection's observations. Native
sync spans measure durable merge/ack handling and room HTTP outcomes. Sync's
existing wire protocol carries no diagnostic context, so browser and native sync
traces remain independent. Download HTTP spans currently end at response headers;
subsequent body/integrity/merge work is covered by the incoming operation.

Validation: production build; 70 core, 32 folder and 2 sync Rust checks (including
the existing subprocess crash fixture exercised by its parent test); 73 targeted
JavaScript/WASM checks; 20 Chromium scenarios. Tests include
real authenticated native-to-browser MCP and browser-to-native stdio-provider
correlation, actual Rust/Yjs sync acknowledgement and persistence, legacy-peer
fallback, malformed optional context, permission/cancellation/revision failures,
local-tab merges and seeded-content exclusion. Full T2 acceptance still requires
implicit compiler transfers and remaining browser platforms. Alloy deployment,
Grafana and T4 acceptance remain required.


## T2b.3: Implicit runtime transfers

Compiler startup now has an explicit `worker_startup` request scope. The initial
worker request carries its private trace context before the pinned runner posts
it; its ordinary initialization/progress/result/error protocol is preserved.
Initialization and each compile own a Resource Timing observer. They report
`runtime_transfer` intervals even when prewarming is skipped, such as a zero
runtime-cache budget, including lazy Biber transfers during compilation. Pending
entries are drained before readiness/results close the browser scope. Cancelled,
cleared or replaced browser scopes continue to reject late evidence.

The observer reads only entry type, monotonic start/end, encoded body size and
HTTP response status. It never reads resource names/URLs, server timing,
headers or response bodies; fetch, XHR, importScripts and WebAssembly streaming
remain untouched. `duration_ms` measures the browser's complete resource
interval; `bytes` is reported encoded body size, which can be zero/unavailable
and is **not** a physical network-bandwidth measurement. With service workers,
this interval includes the client's interaction with the worker rather than the
worker's internal network timing. Detailed preparation/verification/cache spans
remain separately available on the existing explicit-preparation relay.
See the [Resource Timing specification](https://www.w3.org/TR/resource-timing/)
for those browser measurement limits.

Firefox can suppress sizes/timing for service-worker-handled resource entries.
To retain useful byte evidence, the baseline loader also observes its existing
stream read and SHA-256 verification, and Biber observes its existing assembled
ArrayBuffer. These emit `download`/`verify` spans using actual body-buffer lengths;
they add no body reads or copies. An explicit observer is passed through the
pipeline and Module into those loaders, then restored after each compile. Raw
Resource Timing and loader download measurements are separate operations and
must not be summed together as network traffic.

A known HTTP error maps to fixed `network` failure. A known 2xx/3xx response maps
to success; absent/zero status uses the neutral `observed` outcome, which does
not imply that a request succeeded. Application startup/compile outcomes still
report whether the actual operation worked. A missing/unsupported observer adds
an unavailable `telemetry_delivery` record and leaves compilation unchanged.
Disabled collection creates no Resource Timing observer. Resources share each
request's existing 128-record budget and bounded drop report with tool spans;
no separate retained resource queue or network/body buffers are introduced.

Production, cross-platform and regression validation is in progress. T3–T4
remain required, including actual collector deployment, managed/self-hosted
readback, test/CI reporting, access/alerts and measured overhead acceptance.


### Pause checkpoint: November 4, 2026

Paused at the user's request, with the implementation preserved as work in
progress. The production build passes, as do 71 core Rust checks and 79 targeted
JavaScript/WASM checks. All five installed compiler wrappers are byte-identical
on a repeat patch; the fresh pinned worker fixture also verifies patch
idempotence and unchanged results when collection is disabled.

An initial broad Firefox/WebKit run exposed two Firefox gaps: suppressed resource
sizes, and cache controls accepting input before initial settings had loaded.
Actual loader byte observations and initially disabled cache controls address
those gaps. WebKit initially could not create an EGL display; installing and
selecting a software Mesa renderer allowed actual pages to run. These are fixes
under verification, not grounds to claim the entire browser gate complete.

The final 24-case telemetry rerun advanced through all eight Chromium and eight
Firefox cases and through WebKit's real Biber case without a reported failure.
It was explicitly stopped at case 22, WebKit cancellation/restart, so there is
no final aggregate result. WebKit cancellation/restart, failed-compile and
zero-budget transfer checks still need a completed run. The broader WebKit
MCP/provider/local-tab workflows also require execution with the working renderer.
Retain the existing requirement to demonstrate a real compile trace through
companion, browser and worker together; current tests also establish individual
boundaries separately. T2 is not marked complete.

The headless browser executable overrides are configurable in
`playwright.config.js`: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`,
`PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH`, and `PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH`.
This NixOS host additionally needs `LIBGL_ALWAYS_SOFTWARE=1`,
`EGL_PLATFORM=surfaceless`, and `__EGL_VENDOR_LIBRARY_FILENAMES` pointing to Mesa's
`share/glvnd/egl_vendor.d/50_mesa.json` for WebKit. Browser packages and software
rendering dependencies were installed from the Nix binary cache after checking
their disk budgets; no TeX runtime archive was downloaded. Generated browser
crash dumps were removed and excluded from Git. Existing runtime/build assets
remain available for resumption.

T3–T4 remain pending. The roadmap's previously verified private Grafana
credentials file and the host/DNS setup for `ingest.telemetry.scribyra.com` were
not located in this environment; a clarification is pending. Local self-hosted
implementation can proceed independently when work resumes. No credentials or
raw diagnostic artifacts belong in commits or automatic telemetry uploads.


## T2 resumption and instrumentation verification

Resumed from `93c81ae`. The three previously unfinished WebKit scenarios now
pass: cancellation/restart, failed compilation with continued editing, and
zero-budget implicit runtime transfers. The broader WebKit companion,
HTTP/stdio-provider and local-tab/recovery workflows also pass. This resumption
run completed with 15 passes and one intentional skip: the native Chromium IME
case is only supported in Chromium. The earlier Chromium/Firefox telemetry
cases and WebKit's first five telemetry cases were retained from the interrupted
run, whose lack of an aggregate verdict remains recorded above.

A new actual-browser integration runs a real MCP compile with native and browser
collection enabled. It asserts the complete span relationship: native companion
MCP request → browser MCP host → browser compile → compiler RPC → executed TeX
pass, with the same trace ID. It also checks the native exported snapshot and
browser record together for source text, file/project names, project IDs,
credentials and local paths. This test passes in Chromium, Firefox and WebKit
(three additional completed passes). It uses the real compiler and PDF result,
rather than a synthetic compile callback.

Together with the successful production build, 71 core Rust checks, 79 targeted
JavaScript/WASM checks and wrapper idempotence evidence recorded at the pause,
these results complete T2's instrumentation delivery. Resource Timing's browser
limits, local-buffer/worker drops and native snapshot coalescing remain explicit;
this does not establish collector delivery or the full observability gate.

T3–T4 remain required: bounded configurable exporters, privacy/authentication
boundaries, deployed Alloy and the self-hosted backends, managed ingestion,
Grafana provisioning/access/alerts, actual test/CI reporting and measured
failure/offline/overhead acceptance. Folder feature development remains paused.


## T3a: Optional browser export and validated Alloy ingress

This delivery implements the first transport path: the production browser app →
authenticated Rust privacy ingress → Grafana Alloy → an operator-selected OTLP
receiver. The test receiver is a bounded, loopback-only protocol evidence sink.
Persistent storage, Grafana queries/dashboards/alerts, native remote export and
managed HTTPS/DNS deployment remain required in T3b; this is not the full T3 gate.

### Browser controls and failure isolation

Remote collection defaults off and has no built-in destination. In **Diagnostics**,
enable local collection, enter the host's `/v1/events` endpoint and its ingest-only
64-character hexadecimal token, select all/10%/1% trace sampling, then connect.
HTTPS is required except on loopback. The destination and token remain in memory
for the current tab; neither enters project data, localStorage, the local support
export, or a static build. This token is separate from Grafana management and
Cloud-ingestion credentials. Reviewed file export remains an independent control.

Only records accepted by the existing Rust/WASM recorder reach the exporter.
Sampling is deterministic by random trace ID, preserving a trace's decision.
The waiting queue holds at most 128 records / 32 KiB; one in-flight batch holds
up to 32 additional records plus its envelope. Retained transport data stays below
70 KiB. Oldest waiting records are dropped on overflow or after five minutes.
Requests are asynchronous, time out after eight seconds, and retry at most three
times with backoff/jitter. Retries preserve the exact batch body and ID. Permission
or invalid-payload responses pause sending until reconnection. No raw response
body or exception message is recorded.

Disabling collection, disconnecting or leaving the page aborts active sending,
drops queued records and forgets the token. Clearing diagnostics also invalidates
old spans and drops unsent records, while retaining the explicitly configured
connection for subsequent operations. Already accepted host records follow the
host's retention policy. Live status shows sent, pending, dropped and sampled-out
counts without exposing the token. Drop/sampling deltas also accompany later
batches; no delivery event is recursively published through its own exporter.

### Rust policy, authentication and budgets

`crates/core/src/telemetry/transport.rs` defines a deny-unknown-fields v1 batch:
random hexadecimal batch ID, tab/process origin Unix milliseconds, optional
validated public build identity, bounded numeric delivery counts and approved
events. Body size is 64 KiB; event count is 1–64; each event retains the existing
2-KiB/schema/ID/measurement limits. Event timestamps must be within the last day
and at most five minutes ahead of the ingress clock. Invalid identity, timeline,
private fields or any bad event reject the whole batch before forwarding.
These timestamps describe telemetry operations, not document timestamps.

The new `scribyra-telemetry` binary defaults to `127.0.0.1:8789`. It requires a
runtime token file, compares token digests in constant time, and accepts only an
explicit list of canonical HTTPS/loopback origins (up to 16). Native authenticated
clients can omit Origin. CORS allows only POST/OPTIONS and Authorization/Content-Type.
The endpoint rejects query strings, compressed bodies and unsupported media types.
Replies use fixed categories and never echo request/collector content.

There are eight body-read slots, a two-second read deadline, a global authenticated-body four-request
per second / sixteen-request burst budget, and one active forwarding transaction.
Busy forwarding returns retryable 503 rather than queueing more transactions.
Each of the three Alloy requests has a two-second deadline and a bounded 16-KiB
response. A 256-entry receipt cache records body hashes and per-signal acceptance;
retries resend only unacknowledged signals, and conflicting reuse of an ID returns
409. The cache is in-memory and finite: expiry/restarts or ambiguous downstream
acknowledgements can still produce duplicates or lost observations. This is a
bounded, best-effort telemetry path, with explicit loss/status reporting.

`/metrics` exposes fixed-label ingress counts, accepted event count and last success
time for local scraping. Only `/v1/events` should be routed through an external
TLS ingress; health/metrics and collector interfaces belong on the private side.
The Rust-to-Alloy URL is an operator-configured internal HTTP root endpoint.
All Cloud credentials and external TLS/export configuration belong on Alloy/the
server, never in the browser. Full production deployment profiles remain in T3b.

### Maintained OTLP types and measurement semantics

Exporter selection was checked against the official [Rust support status](https://opentelemetry.io/docs/languages/rust/)
and [browser instrumentation guide](https://opentelemetry.io/docs/languages/js/getting-started/browser/).
The latter describes browser instrumentation as experimental. The existing manual,
closed Rust policy stays authoritative; the ingress uses maintained
[`opentelemetry-proto` 0.33.1](https://docs.rs/opentelemetry-proto/0.33.1/opentelemetry_proto/)
message models and Prost instead of enabling generic browser/network instrumentation.
This preserves original trace/span IDs and avoids adding URL/host/process metadata.

All approved events become structured OTLP logs; terminal records become spans.
Started-only records do not fabricate completed spans, and `observed`/cancelled
spans retain unset status. Counters and bounded explicit-bucket histograms cover
observed operation completions, duration, bytes and memory samples. Memory and
byte measurements retain their operation-specific limits described in T2.
Metric labels are only fixed runtime, operation, outcome and error categories;
trace IDs, build revisions, endpoints and project/file identifiers are excluded.
Build identity remains on logs/traces. Sampling/loss means these counters describe
received observations, not an exact census of all activity.

Metrics use ingress-serialized delta intervals. The pinned Alloy profile converts
them to cumulative temporality with `otelcol.processor.deltatocumulative`, limited
to 2,048 streams and fifteen-minute staleness. This component is experimental in
Alloy 1.21.3 and explicitly requires `--stability.level=experimental`. The smoke
forwarding profile has an eight-request exporter queue and disables downstream
retry to make failures finite and visible during verification. Production storage,
retention/retry and managed profiles remain to be provided.

### Local setup and verification

`ops/telemetry/tools.lock.json` pins Alloy 1.21.3 and its upstream archive SHA-256.
`python3 scripts/telemetry-tools.py alloy` fetches only that selected executable,
verifies the archive, discards it after extraction and checks the cached binary
on reuse. The Linux/amd64 binary occupies approximately 543 MiB; no TeX archive
is downloaded. Existing Rust/browser/runtime outputs are reused.

For the browser integration fixture, first build the app, then run:

```sh
npm run build
npm run test:ingestion -- --project=chromium
```

The script builds the ingress and bounded OTLP test-sink example, installs/reuses
pinned Alloy, and exercises the actual browser. Repeat with `--project=firefox`
and `--project=webkit` using the browser/renderer setup above. The fixture creates
an ephemeral private token file, runs all services on loopback, and removes its
state on exit. It is protocol evidence, not a Grafana/storage substitute.

For an operator-controlled receiver, start Alloy with the explicit forwarding
profile and private listen addresses, then set these ingress runtime variables:

```text
SCRIBYRA_INGRESS_TOKEN_FILE=/private/operator/path/ingress.token
SCRIBYRA_TELEMETRY_BIND=127.0.0.1:8789
SCRIBYRA_ALLOY_URL=http://127.0.0.1:4318
SCRIBYRA_ALLOWED_ORIGINS=http://127.0.0.1:4173
```

Generate the token with a cryptographically random 32-byte source and store its
hexadecimal representation with owner-only file permissions outside source/sync
roots. The binary prints readiness/address only. Alloy's forwarding profile uses
`SCRIBYRA_OTLP_LISTEN` and `SCRIBYRA_OTLP_FORWARD`; launch it with
`--disable-reporting --stability.level=experimental` and a private `--storage.path`.
Validate configuration with the pinned Alloy binary's `validate` command first.
Grafana/Cloud tokens are not accepted as browser configuration examples.

Validation completed on November 4, 2026:

- Production WASM/Vite build passes. The final UI correction also passes a fresh
  Vite build.
- 73 core Rust checks and six ingress/protobuf/HTTP checks pass. The real-Alloy
  test, normally ignored without an explicit tool path, was run separately and
  passes all three signals and cumulative metric conversion.
- 79 JavaScript telemetry/command/storage/companion/provider/local-tab checks pass.
- Six final browser scenarios pass across Chromium, Firefox and WebKit: actual
  compile ingestion through the authenticated Rust service and pinned Alloy,
  offline editing/save/compile, persistent input errors and existing local
  collection/reviewed export controls. Full captured protobuf models contain no
  seeded paper text, filenames, endpoint or token.

The supplied credentials resolve the previously missing Grafana
management access. A read-only probe of `telemetry.scribyra.com` succeeds for the
organization, permissions and datasource APIs; dashboard, folder, datasource and
alert-rule write capabilities are present. Existing managed Prometheus, Loki and
Tempo datasources are available. Secret values are not retained
in this repository. This verifies access, not provisioning or stored application
queries. T3b and T4 acceptance, including actual stored query/readback and managed
ingress deployment, remain open.


## T3b.1: Self-hosted storage and persisted readback

The private single-node profile now supplies actual retained storage independent
of a Cloud account: Prometheus 3.15.1, Loki 3.7.9 and Tempo 3.1.1, behind the same
pinned Alloy 1.21.3 and authenticated Rust ingress. Exact upstream release archive
sizes/checksums are versioned. The installer handles ZIP and tar.gz without
extracting unrelated archive members, removes archives and verifies cached binary
hashes. All four tool executables together occupy approximately 940 MiB; 66 GiB
remained free after installation. No TeX runtime archive was downloaded.

`storage.alloy` sends each signal to the maintained backend's OTLP/HTTP endpoint;
metrics retain the bounded delta-to-cumulative processor. Each signal exporter
has an eight-request queue, one consumer and fifteen-second retry budget.
`telemetry-stack.py` starts existing local binaries, waits for all five services,
stops children on failure/shutdown and retains an owner-only state directory. A
state-directory lock prevents concurrent launchers. Every HTTP/gRPC/OTLP listener
binds to loopback; this was checked against actual process/socket state. The
launcher does not install a public route or change other services on the host.

Prometheus has seven-day / 512-MB TSDB retention (WAL/head overhead is additional).
Loki/Tempo have seven-day time retention. Time retention is asynchronous, and a
host filesystem quota/volume is still needed for a hard byte ceiling. Vendor
usage reporting is disabled. Tempo 3 monolithic mode needs no Kafka; its live WAL
and shutdown-marker paths are explicitly under the state directory rather than
unwritable system defaults. This is a single-node reproducible profile; production
host packaging, resource quotas, backup and availability remain deployment work.
See [operator instructions](../ops/telemetry/README.md) for setup, ports, budgets,
private token handling and reproducible queries.

Validation on November 4, 2026:

- The pinned real backends and Alloy reach readiness using the checked-in configs.
- The Chromium storage integration test passes. It imports a seeded paper,
  compiles through the actual app/TeX worker, and queries Prometheus for the
  successful compile counter, Loki for its approved event, and Tempo for the same
  compile/TeX-pass trace. Full returned data excludes seeded paper contents,
  filenames, endpoint and ingest token. After adding exact trace-ID assertions,
  the final run passes again (one scenario, approximately seventeen seconds).
- `telemetry-readback.py` verifies the actual-browser evidence before shutdown.
  All five services were then stopped and restarted using the same state
  directory; the historical metric, log and compile/worker trace remain queryable
  and correlated. Readback submits no new events and uses the original evidence's
  timestamp/trace ID.
- All newly installed tools pass cached executable hash verification. Python and
  JavaScript syntax checks and `git diff --check` pass.

This completes stored-query evidence for this local Chromium scenario. Cross-engine
transport/offline checks are recorded in T3a; this is not a claim that all T3/T4
acceptance gates pass. Grafana OSS provisioning/queries, managed dashboard/alerts,
managed HTTPS ingestion, native remote exporters and full test/CI/failure/overhead
acceptance remain required. Folder feature work stays paused.


## T3b.2: Grafana views and evaluator integration

Grafana OSS 13.3.0 is pinned to its official Linux archive size and SHA-256.
The bootstrap verifies its complete required distribution and a per-file cached
hash manifest, discards the archive, bounds extraction and rejects unsafe archive
members. Required assets add approximately 1.4 GiB; total observability tools use
2.3 GiB, with 64 GiB free after installation. No TeX archive was downloaded.

The optional `--grafana` launcher profile binds to loopback and requires a generated
owner-only password. It disables anonymous access, signup, SMTP, plugin downloads
and vendor reporting/update checks; unrelated inherited Grafana environment
variables cannot override the private profile. File provisioning supplies three
maintained datasources, one folder, linked operations/health dashboards and six
failure/latency/delivery/staleness rules. Operator setup and missing-data semantics
are documented in [the operations guide](../ops/telemetry/README.md).

On November 4, 2026, a fresh Grafana instance provisions successfully, with one
Scribyra folder, three datasources and six healthy evaluated rules. A fresh actual
Chromium compile passes retained backend readback. The final Grafana browser
integration passes (approximately 1.9 minutes): login/rendering, every provisioned
panel query through Grafana's datasource API, stored success metrics/logs/worker
trace through Grafana, three real failed compiles, normal-to-firing failure alert,
and correlated failed compile/worker evidence. Returned data excludes seeded
paper contents, filenames and both ingest/login secrets. Browser credential traces,
screenshots and video are disabled for this check.

A separate real-evaluator integration passes (approximately eighteen seconds),
using a temporary, explicitly synthetic-validation rule group: absent optional
application observations remain normal, required absent data fires, and a query
error is visible as an error. The group is removed afterward. This is evaluator
evidence, not fabricated application usage. The final dashboard queries separate
dropped/sampled counters to avoid duplicate-label evaluation errors.

The user also requested an easy observability dashboard. The overview now starts
with activity/failure/latency/last-activity cards and clear missing-data guidance,
followed by operation charts and approved events/traces. The same versioned views
are published at the private managed Grafana:

- `https://telemetry.scribyra.com/d/scribyra-operations`
- `https://telemetry.scribyra.com/d/scribyra-delivery`

Deployment verifies the stored panel definitions, dedicated folder with default
Viewer/Editor grants removed, disabled public-dashboard configuration and rejected
anonymous dashboard API access. Management credentials are obtained only at
runtime and are absent from source/artifacts. This
publication does not prove Cloud application ingestion or alert provisioning.
Cloud collection/query evidence, managed HTTPS ingress, native exporters,
sustained operational fault/overhead and actual test/CI evidence remain required.


## T3b.3: Real application ingestion through Alloy into Cloud

`cloud.alloy` and the launcher's `--cloud` profile now supply the real authenticated
browser → Rust policy ingress → Alloy → managed OTLP gateway path. Cloud tenant/
ingestion credentials are runtime-only owner-readable files. Grafana management
credentials stay separate and are used only by deployment/query verification,
never in browser settings, app builds or telemetry. Token values are secret-typed
in Alloy. No new tools or TeX distribution were installed/downloaded for this
slice; 64 GiB remained free.

Cloud forwarding preserves the existing closed protobuf mapping and bounded
2,048-stream cumulative conversion. It has an eight-request queue, one consumer,
a five-second request timeout and fifteen-second retry budget. A separate private
scrape admits only `up` and fixed ingress request/event/last-success metrics; job
and instance values are fixed, not hostnames, paths or listen addresses. Actual
Cloud query evidence confirms the fixed `scribyra-ingress` instance label.

The pinned Alloy 1.21.3 binary rejects the newer `client_auth` block at component
construction, even with literal synthetic credentials. Configuration-only validate
passes but runtime construction fails. Synthetic startup probes isolate this
compatibility issue; the maintained component's supported top-level auth
arguments work with runtime `local.file` sources. The versioned profile records
this compatibility choice for upgrade review. No credential value appears in the
configuration or startup diagnostics published as evidence.

Validation on November 4, 2026:

- The production `/app/` release is served by the assembled local Pages preview.
  Real browser actions import a synthetic private paper, connect the optional
  exporter and compile through the actual TeX worker. Grafana's managed datasource
  proxy APIs return the new successful compile metric, structured events and
  compile/worker trace. A deliberate undefined-command compile is then observed
  as a typed failure with its own correlated worker trace.
- All three supported engines pass: Chromium, Firefox and WebKit. Final trace
  assertions match the original compile span/trace IDs and actual TeX-pass parent
  links, rather than searching only for a span-name string. Query responses exclude
  seeded paper contents, filenames, destination and the separate ingest, collector
  and management tokens. Failed privacy assertions expose only boolean results.
- The launcher’s self-hosted/Grafana branch still reaches readiness, and its
  previously stored browser metric/log/trace evidence passes readback after these
  launch-profile changes. Python/JavaScript syntax and diff checks pass.
- The managed dashboard's stored panel definitions and private access are
  reverified. Its existing Loki datasource already links trace IDs to the managed
  Tempo datasource. Overview guidance explicitly distinguishes these controlled
  browser observations on synthetic papers from natural user activity. T4 must
  still add structured test/CI provenance and run views.

This is stronger than the earlier direct synthetic Cloud probes: actual supported
app operations cross Alloy and are queried back. It does not prove the deployed
GitLab Pages build or the proposed public browser route. Managed ingress DNS is
still absent, and persistent host/DNS access is pending. The temporary test
collector stops and its runtime Cloud credentials are discarded after verification;
it is not a continuously deployed ingestion service. Managed alert provisioning/
evaluation, native remote exporters, actual CI reporting and the full operational
failure/overhead gates remain required. GitLab.com API access is still pending;
no work is resumed on folder synchronization.


## T3b.4: Bounded native remote export

The shared native adapter now optionally sends accepted v1 batches to the same
privacy ingress as the browser. Existing companion, read-only folder CLI and sync
service instrumentation uses it without adding document/path/header fields or
resuming folder feature work. Explicit collection + destination + private ingest
file are required; disabled collection does no token-file/network work. The
maintained native-only HTTP/TLS dependency is exact-pinned `ureq` 3.5.1 with Rustls
and platform certificate verification. The WASM app dependency graph contains no
ureq/Rustls/ring. Settings, encoded queue budgets, retries, sampling and shutdown
limits are documented in [the operations guide](../ops/telemetry/README.md).

The publisher bounds waiting payloads to 128 records / 32 KiB plus one up-to-32-
record batch, uses a nonblocking producer lock, five-minute age limit, two-second
request deadlines and three frozen-body attempts. Accepted batch/trace/span IDs
are preserved. Redirects never receive credentials; Authorization is marked
sensitive; raw response/error text is discarded. Native snapshots report fixed
status categories and numeric delivery/sampling/drop counts. Local support files
remain independently available, including updated delivery counters after bounded
flush. Endpoint/token/path are absent from both transport batches and snapshots.

SDK review found that the default timed system resolver could leave one detached
OS lookup per timed-out retry. A small exact-version adapter delegates resolution
to that same maintained resolver synchronously on at most one outstanding helper
thread per publisher. The HTTP caller times out while a stalled lookup retains its
slot; subsequent attempts cannot create additional lookup threads. The OS lookup
is not forcibly cancellable. A controlled blocked-resolver test verifies that 100
retries do not add lookups, and the slot becomes reusable after completion.

Validation on November 4, 2026:

- 118 ordinary Rust checks pass across core, telemetry ingress, companion, folders
  and sync; two environment/explicit-tool checks remain ignored, not counted as
  passes. Core contributes 59 unit + 19 integration checks. The final nine native
  checks cover disabled collection, file/HTTP failure isolation, queue pressure,
  frozen retries, private schema, sampling, strict config, redirect refusal,
  updated local support metadata and bounded stalled DNS work.
- 53 targeted JavaScript/runtime/companion/provider/sync checks pass, with one
  explicitly skipped private-Grafana integration requiring an operator-started
  stack. The three native API checks also pass after the final adapter changes:
  actual CLI inspection over trusted HTTPS, disabled/untrusted-TLS isolation, and
  actual sync blob GET/PUT outcomes excluding private room/content/hash values.
  Disposable CA and leaf certificates are separate; TLS verification stays on.
- Three final Chromium/Firefox/WebKit scenarios pass with the production `/app/`
  release preview and real native companion. A real MCP compile exports native,
  browser and worker spans through authenticated Rust ingress and pinned Alloy;
  exact trace and parent-span links join native MCP → browser MCP → compile → TeX
  work. Full captures exclude seeded paper text, names, project IDs, pairing/MCP
  capabilities, ingest token and endpoint/filepath. Browser trace/video/screenshots
  are disabled for this credential-bearing integration.
- Native programs build with the locked dependency graph. Syntax/diff checks pass;
  approximately 63 GiB remains free. Existing build/runtime assets are reused and
  no TeX archive is downloaded.

The native integration queries the real Alloy protocol fixture; it is not a claim
of retained native Cloud evidence or persistent HTTPS deployment. Broad native/
browser overhead and operational fault gates, explicit test/CI provenance, actual
GitLab release verification and Cloud alert evaluation remain required. GitLab.com
API access and managed ingress hosting/DNS details are still pending.
All later product milestones and the folder implementation pause are retained.

## T4a: Typed test-run evidence and activity provenance

The transport envelope now distinguishes `application` (including older clients
that omit the field), `local_test`, `ci` and `synthetic`. Browser configuration is
explicit and current-tab only; native adapters read the closed
`SCRIBYRA_TELEMETRY_SOURCE` enum. Automated browser fixtures select `local_test`
unless the approved runner supplies another source. The new fixed OTLP
`scribyra.source` attribute allows queries to separate controlled activity from
application usage. This label describes reported provenance; it is not proof that
a request came from a trusted CI runner.

`POST /v1/runs` uses the existing bearer authentication, origin checks, receipt
cache, forwarding limits and bounded retries. Shared Rust validation accepts at
most 4 KiB of closed-schema run evidence: random run ID, suite/browser enums,
source, build version/revision/dirty flag, numeric timing, process outcome/exit
code, optional framework counts and optional numeric GitLab job context. Raw
stdout, stderr, names, paths, messages, headers and arbitrary URLs are rejected.
CI source requires project/pipeline/job IDs and other sources forbid them. IDs
and revision are log/trace attributes, never metric labels. Run ID is the trace ID;
retrying changed counts under the same ID conflicts rather than double-counting.
Run/case counters and a duration histogram have fixed enum labels. A missing
framework summary omits counts rather than inventing zero passing cases.

`scripts/telemetry-run.py` executes an allowlisted real suite, drains and discards
raw child output, projects framework numeric totals and asks the shared Rust
`scribyra-telemetry validate-run` command to validate the artifact. It writes only
owner-readable JSON plus a JUnit record for the **suite process** to ignored
`.telemetry/`. The JUnit record does not pretend to enumerate individual cases;
actual available case counts are in JSON. Playwright uses a content-free reporter
and temporary trace-disabled output that is removed after the run. The wrapper
preserves failed/cancelled process status even when optional publication fails.
Synthetic pass/fail presets execute real Node assertions and are labelled
`synthetic`, not application activity. Framework counts are observations from a
trusted local process, not an attestation or a tamper-proof test framework.

Local validation on November 4, 2026 covers the shared Rust policy and ingress
(87 passing checks, one explicit ignored integration), passing and deliberately
failing Node suite processes, actual Rust/JavaScript suite summaries, unavailable
collector isolation, private JSON/JUnit files and seeded failure-text exclusion.
The release build and local presentation → `/app/` compile/offline flow are
rechecked through the safe Playwright reporter. Operational dashboard source
selectors, retained test-run query/readback, CI jobs/artifacts, regression views
and the remaining fault/overhead gates are still pending. No GitLab CI execution
or deployed release verification is claimed from these local runs.

## T4b: Stored test-run views and CI integration

The versioned private `scribyra-test-runs` dashboard now separates local tests,
reported CI context and synthetic assertions, with suite/browser selectors. It
shows observed process failures, case outcomes (including skipped/cancelled/todo
and the flaky subset), cumulative runs and duration mean/p95. Missing observations
are explicitly unknown. Sparse run counters use the latest sample in the selected
time range, and retained readback queries use the original observation time, so
Prometheus instant-query staleness is not mistaken for data loss. The operations
dashboard defaults to application source;
a source selector exposes controlled activity separately. Older unlabeled batches
are omitted by explicit source selections. Collection health stays independent of
source, so operators can diagnose the shared ingress.

Safe log summaries retain the exact run ID, counts and build identity. Run ID is
the Tempo trace ID and the JSON/JUnit artifact basename. Self-hosted Loki has a
run-log → suite-trace link and, for numeric GitLab job context, a link to this
project's private `.telemetry/` job artifacts. These use Grafana's supported
[derived fields](https://grafana.com/docs/grafana/latest/datasources/loki/configure/).
Managed dashboard provisioning can optionally add the same two named fields with
`--run-links`, preserving unrelated datasource settings and existing links. The
current managed token receives HTTP 403 specifically for the Loki datasource PUT;
the three dashboards are successfully deployed and remain private. Cloud trace
results are available in the dashboard's correlated traces panel; adding its
log-line shortcuts remains an operator permission task.

The existing private Pages pipeline now builds the native prerequisites, executes
the safe production-build, Rust, JavaScript and Chromium presentation/offline
presets, and uploads only `.telemetry/*.json` and `.xml` summaries with maintainer
access and one-day retention, including failed jobs. The JUnit report represents
suite processes; detailed numeric case counts remain in JSON. The Rust preset now
covers core, telemetry, assets, companion, folders and sync, matching the existing
approved host packages. Chromium is the only CI engine installed; its pinned
Playwright cache is reused. All three engines remain locally verified. Pipeline
publication is optional and requires explicitly configured endpoint + private
GitLab file variable; credentials and document/test output are not artifacts.

Verified on November 4, 2026:

- The actual approved Rust preset reports 129 passed and two ignored checks.
  The actual Node suite reports 194 passed and two explicitly skipped private-
  stack integrations. The production-build preset succeeds, and the CI helper's
  Chromium presentation → app → compile → offline reload/compile scenario passes.
  These are local executions of pipeline commands, not evidence of a GitLab job.
- Actual Rust and deliberately failing synthetic runs cross ingress and real
  Alloy into Prometheus/Loki/Tempo. Through Grafana's datasource proxies, stored
  case counters, exact safe JSON and correlated traces match their artifacts.
  All queries in all three dashboards execute successfully against real backends.
  Readback-only verification passes after a full stack stop/restart using the same
  run IDs, without republishing. The rendered Chromium dashboard follows the
  failing run's log link to its `test_run` trace.
- The same real Rust/failing-assertion ingestion and stored-query checks pass in
  Grafana Cloud through the Cloud Alloy profile. All managed dashboard panel
  queries pass, anonymous access is rejected, and seeded failure text plus ingest,
  Grafana and local operator credentials are absent from queried evidence. The
  verification collector is stopped and its temporary Cloud credentials removed.
- Existing cached binaries/assets are reused; no TeX archive is fetched, and
  approximately 63 GiB remains free.

A live GitLab.com job, its uploaded artifacts and deployed release still require
verification. Persistent managed HTTPS/DNS hosting, Cloud log shortcut permissions,
source-aware production/test alert acceptance, native retained-query evidence,
performance baselines/overhead and the full operational fault/offline matrix
remain open. The goal is active; folder feature implementation remains paused.

## T4c: Source-aware failure alerts

The versioned self-hosted and managed configurations now contain seven rules.
Application operation failures, sustained compile p95 and exporter-loss rules
select application source. CI suite failures have a separate rule requiring CI
source, `test_run` and a typed run ID. Shared ingress availability, delivery and
idle/stale rules retain their source-independent meaning. Optional application/CI
no-data remains normal, required ingress absence alerts, and query errors remain
errors rather than silently appearing healthy.

Failure rules count safe Loki records in a bounded window instead of relying on
an increase between two counter samples. A single sparse failed operation/test is
therefore observable immediately. The operations overview's recent-activity and
failure cards, and its failure chart, use the same safe log records so the first
observation is not hidden. Counts are records, not unique users or unique traces.
CI failures describe observed suite failures in the last hour, including typed
run identity; they do not establish an authenticated GitLab job by themselves.

`telemetry-grafana.py --apply --alerts` provisions only the seven owned rules in
the private Scribyra folder, checks existing ownership, verifies stored policies/
queries and sets the versioned 30-second evaluation interval. Managed rules stay
active while direct notification settings reference an owned all-time UTC mute.
The generated route and interval can be inspected without sending a message or
changing organization contact points/policies. Notification delivery to an email,
chat or webhook receiver is not part of this validation. Mute timing is a routing
property, not the global active/suppressed status of an alert; see the upstream
[Alertmanager routing explanation](https://github.com/prometheus/alertmanager/issues/3513).

The controlled source integration executes a real failing Node assertion, follows
its typed run through ingress/Alloy, evaluates source-selected clones of both
failure formulas, and checks that production application/CI rules exclude that
synthetic activity. Probes require fresh evaluation timestamps and scope the
query to that exact run, so prior retained test activity cannot produce a pass.
Probe groups are removed after verification. Managed probes additionally check
the server-generated direct mute route and stored per-rule bindings; this is
configuration evidence, not a claim of receiver delivery. Browser failure tests
use local-test source and a separate controlled query group; the production app
rule remains normal. Credential-bearing ingestion/storage tests now explicitly
disable trace/video/screenshots and use boolean secret-exclusion assertions.

Validation on November 4, 2026:

- The actual failed-assertion source/evaluator integration passes locally and in
  Grafana Cloud. Fresh controlled probes fire for the exact safe run; production
  application/CI rules stay normal. The first failed test is counted once without
  a second counter sample. Temporary probe groups are removed.
- All seven managed production rules have healthy evaluations, verified stored
  source queries and active/unpaused configuration. Their all-time mute interval,
  per-rule settings and generated direct route are verified. Actual notification
  delivery is deliberately not exercised; generic Alertmanager active/suppressed
  state is not used as evidence of mute timing.
- Local required/optional no-data and query-error probes pass. Chromium performs
  actual successful and failed compiles, reads retained metrics/logs/traces,
  executes every dashboard panel query and confirms the source-selected failure
  probe fires while the production application rule remains normal. Six targeted
  transport/runner checks also pass. The final nested `/app/` build is restored
  and assembled Pages assets reuse the existing compiler cache.
- The self-hosted and verification-only Cloud collectors are stopped after their
  checks and temporary Cloud credential files are removed.
  Approximately 63 GiB remains free; no TeX archive is downloaded.

The active goal still requires persistent managed HTTPS/DNS hosting, native
retained-query evidence, measured startup/compile/transfer/memory overhead and the
complete fault/offline acceptance matrix. GitLab.com API access is still
pending; actual pipeline/job artifacts and the deployed release remain unverified.
Managed Loki log shortcuts still require datasource-write permission. No later
product milestones or unfinished folder features are resumed.

## T4d: Retained native CLI, sync and cross-runtime MCP evidence

Actual native read-only inspection and the delivered sync HTTP API now have
repeatable retained-query acceptance checks. CLI inspection succeeds for a real
private fixture and fails for an absent root without changing source files.
Sync GET-before-PUT fails, PUT succeeds and GET returns the original bytes. Local
support records for both outcomes match the stored safe Loki bodies; matching
span IDs and metrics are queried through private Grafana datasource proxies.
Fixtures, paths, source text, digests, room names, capabilities and credentials
are checked for exclusion. This exercises existing APIs, not unfinished folder
synchronization or its browser UI.

The retained browser scenario uses the actual native companion and MCP client to
inspect and compile a browser project. Its exact compile record comes from the
browser's local diagnostic preview, rather than an arbitrary shared-backend
match. Native MCP → browser MCP → compile → worker-pass → TeX-pass IDs and parent
links are checked in stored Tempo data. Native metrics and matching safe logs are
queried independently. Chromium, Firefox and WebKit all execute this flow against
self-hosted storage and Grafana Cloud; the tests do not stop at an OTLP sink.

A private readback mode launches no native client or browser operation. It uses
the original observation time for sparse historical metrics, original trace/span
IDs for logs/traces, and hashes of the approved event values to detect changed
stored records. These hashes are test integrity checks, not signatures or proof
of authenticated CI execution. Native/worker source attributes are also checked. Metric sample timestamps must
belong to the original scenario, so an older retained counter is insufficient.
The verification clients and privacy ingress share one host/clock domain.
The same four CLI/sync outcomes and three browser chains remain queryable after a
full self-hosted stack restart and after the verification-only Cloud collector is
stopped, without republishing their events.

Validation on November 4, 2026:

- The native CLI/sync acceptance passes against real self-hosted and Cloud
  backends. All three browser engines pass exact local-record, stored metric/log/
  trace, cross-runtime parent-chain and private-value exclusion checks in both
  profiles. Readback-only checks pass after local restart and with the Cloud
  collector stopped.
- The existing three native HTTPS/API checks also pass: trusted TLS transport,
  disabled/untrusted-TLS failure isolation and actual sync HTTP outcomes. They
  now explicitly classify automated activity rather than silently using the
  application default.
- The source checks initially found stale companion/sync executables that omitted
  the source envelope. Rebuilding the delivered binaries fixed the mismatch;
  assertions were kept strict. The documented test command builds prerequisites
  first, reusing Cargo outputs. This matters because a test harness build alone
  does not guarantee that an existing standalone executable was replaced.
- Readback uses explicit operator state, HTTPS or loopback HTTP, no redirects,
  bounded responses/timeouts and private credentials. Native child environments
  omit readback management tokens, Cloud bindings and vault sessions. Browser
  trace/video/screenshots are disabled; verification-only Cloud browser artifacts
  and credential files are deleted after use. Only safe IDs, enum outcomes,
  observation times and approved-record hashes are retained as test evidence.
- Existing compiler assets, browser engines and telemetry tools are reused. The
  local native verification state occupies about 8 MiB, the Cloud collector state
  about 44 KiB, and approximately 63 GiB remains free. No TeX archive is fetched.

Persistent managed HTTPS/DNS deployment, actual GitLab jobs/artifacts/release,
measured startup/compile/transfer/memory overhead and the full operational fault/
offline matrix remain required. Managed Loki run-log shortcuts still lack
write permission. The goal remains active; folder feature work stays paused.

## T4e: Browser overhead and verified private release

The [repeatable overhead harness](telemetry-overhead.md) runs the actual assembled
Pages app in independent browser processes/profiles with collection disabled,
local recording enabled, and full-sampling remote export through the delivered
Rust ingress and pinned Alloy. It records actual build identity and keeps native
collector memory separate from browser process-tree memory. The
[raw measurements](measurements/telemetry-overhead.json) contain all 27 trials,
phase timings/bytes, memory sample counts, browser versions, mode medians and
within-repetition percentage changes.

Three repetitions in Chromium, Firefox and WebKit pass: 108 successful compiles,
including 27 after network-blocked reloads. All nine remote trials query their
exact cold compile span in Alloy's OTLP verification destination. This destination
is a bounded sink, not retained Grafana storage; T3/T4d provide retained-query
evidence separately. Disabled collection records no events or export requests;
enabled local records stay within the shared 256-record/64-KiB limits without
schema rejections. Every offline reload/compile writes zero asset response bytes.
At completion, the sink's latest bounded capture window excludes the seeded
source marker, ingest token and endpoint; this is not a claim of retaining every
OTLP record from all trials. Existing privacy acceptance remains separate.

Median values (three trials per row; warm timing averages two compiles per trial):

| Browser | Collection | Startup ms | Cold compile s | Warm compile s | Offline compile s | Peak browser PSS MiB | Attempted export body KiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chromium | Disabled | 388 | 9.14 | 3.10 | 6.88 | 1168 | 0.0 |
| Chromium | Local | 432 | 9.03 | 3.04 | 6.83 | 1142 | 0.0 |
| Chromium | Remote | 372 | 9.01 | 3.05 | 7.08 | 1131 | 97.2 |
| Firefox | Disabled | 1331 | 13.27 | 3.71 | 8.46 | 1553 | 0.0 |
| Firefox | Local | 1123 | 13.22 | 3.70 | 8.67 | 1545 | 0.0 |
| Firefox | Remote | 1228 | 13.19 | 3.65 | 8.57 | 1570 | 93.9 |
| WebKit | Disabled | 520 | 10.53 | 3.21 | 7.76 | 1872 | 0.0 |
| WebKit | Local | 508 | 10.61 | 3.13 | 7.85 | 1910 | 0.0 |
| WebKit | Remote | 521 | 10.72 | 3.20 | 8.13 | 1901 | 94.0 |

Whole-trial median asset response bytes are 122,994,116 in Chromium and
122,864,940 in WebKit for every mode. Firefox's disabled/local medians are
122,994,116; its remote median is 123,026,410, an observed increase of 32,294 bytes
(0.026%). The report does not retain request lists to establish the cause of that
small variation. Telemetry request bodies are counted separately. A request
attempt need not have a matching response before offline mode/reload; exact cold
compile delivery is verified, not lossless export of every event.

These are headless Linux desktop measurements of one public synthetic article on
uncompressed loopback HTTP. Browser process-tree PSS/RSS is sampled every 250 ms;
peaks are lower bounds, not worker-only heap or exact maxima. Native collector
memory and Node driver memory are excluded. Startup excludes connecting the
remote destination, which happens after startup through the UI. OS file pages
are warm/shared across trials. Small sample size and run-to-run variation prevent
attributing the startup differences or negative timing/memory changes solely to
telemetry. No statistical-significance, mobile, internet-transfer or native
exporter overhead claim is made. The measured app identifies revision `08f368e`
with `dirty: true`: measurement helpers were present while rebuilding; runtime
telemetry production code was unchanged. All services/profiles are closed and
only safe numerical/build evidence is retained. Approximately 62 GiB remains free;
existing compiler/browser/Alloy/Cargo assets are reused without a TeX download.

GitLab.com API access is now available.
[Pipeline 3028249673](https://gitlab.com/urundead-labs/scribyra/-/pipelines/3028249673)
for `08f368e` succeeds: production build, 129 Rust passes plus two skips, 194
JavaScript passes plus four skips, and both real Chromium Pages scenarios. The
actual safe CI summaries are read from the authenticated job trace. The deployed
`app/release.json` confirms `web-47` and that revision; the registered browser-app
release asset points to the live `/app/` app. Authorized requests retrieve the
published host router, root module, offline worker and legacy application;
anonymous release requests redirect to GitLab authentication. Repository and
Pages access are verified private. This closes the live pipeline/release check,
not actual CI-summary ingestion into Grafana or individual artifact access checks.

Both requested custom domains are registered with automatic certificates enabled.
Their activation remains pending DNS TXT verification; the release link keeps the
working GitLab Pages address. See [domain operations](pages-domains.md).
Persistent managed HTTPS ingestion, native exporter overhead, full operational
fault/offline acceptance, actual authenticated CI-artifact retention/access and
CI ingestion/query evidence remain required. Managed Loki shortcuts still lack
datasource-write permission. Milestone T stays active; folder feature work and all
later milestones retain their existing scope/order.

## T4f: Authenticated GitLab artifacts and retained CI queries

[The actual CI-artifact acceptance](telemetry-ci-evidence.md) now verifies real
private GitLab jobs, rather than inferring CI execution from typed fields alone.
Four suite artifacts from pipeline `3028249673` are ingested/queryable in the
self-hosted profile; four from successful pipeline `3029032282` are ingested and
queryable in the managed profile. Authenticated API job context, artifact context,
revision and shared Rust schema agree. Anonymous artifact requests return 404;
actual one-day expiry metadata is checked. The project's latest-successful-artifact
override was enabled and is now disabled, so it cannot bypass configured expiry.
Repository/Pages visibility remains private; the live contact-page release is
verified successful. Future artifact deletion was not waited for.

All four original safe bodies match retained logs, fresh metrics/case counts and
correlated CI traces with original execution timestamps. The deployed dashboard's
CI filter and log query return the actual records. Readback passes after a full
local storage/Grafana restart and with the Cloud collector stopped, without
republishing. Safe report snapshots and query receipts are retained in
[measurements/ci-artifacts.json](measurements/ci-artifacts.json). These snapshots
are evidence of prior authenticated reads, not signatures or a new authentication
check when an original artifact has expired.

The delayed real CI report exposed Loki's unflushed historical-query boundary:
metrics arrived, but the log was invisible until flush. Setting only the querier
window was insufficient in filesystem/TSDB mode because the ingester store
lookback takes precedence. Matching both at 25 hours fixes immediate queries for
reports within the contract's 24-hour arrival limit; newly ingested older suite
records pass without a flush. Original execution timestamps are preserved.
Managed-provider historical ingester settings are not changed; Cloud acceptance
uses the recent completed job. Existing stream/query/retention budgets remain.

The ordinary JavaScript suite passes: 194 passed, five explicitly skipped private
integrations, 199 total. The actual CI integration passes in both storage profiles,
including retained-query mode and the deployed log-panel query. Credentials remain
runtime-only, temporary credentials are deleted, and only
individual small safe JSON files are downloaded. No TeX archive is fetched.

This closes actual CI-artifact provenance/access/expiry-policy and retained-query
evidence. It is explicit operator import of genuine reports; continuous direct CI
publication still requires persistent managed HTTPS ingestion and CI ingest file
variables. Native exporter overhead, full failure-isolation/offline acceptance,
managed Loki shortcut permissions and custom-domain DNS verification remain open.
Milestone T stays active, and unfinished folder synchronization stays paused.


## T4g: Local overhead, failure isolation and operational audit

The owner authorized this local work in parallel with Reorientation. It does not
change roadmap order or activate remote infrastructure. The
[line-by-line operational matrix and exact execution record](telemetry-acceptance.md)
audit all five acceptance-gate lines and six required deliverables, distinguishing
historical Cloud/GitLab evidence from this run's private self-hosted checks.

The [native measurement method/results](telemetry-overhead.md#native-exporter-overhead)
apply T4e's fresh-process, rotated disabled/local/remote modes, actual ingress/Alloy,
transfer counting and sampled process-tree memory separately to release native
CLI/sync workloads. Nine final trials pass: nine read-only inspections, 540 actual
SQLite HTTP operations and 16 accepted export batches. Median CLI wall time is
32.5 ms disabled, 33.1 ms local and 272.4 ms remote; remote time includes the
existing bounded coalescing/shutdown flush. Native service PSS medians are
4.47/4.55/5.18 MiB. Startup varies widely; no statistical/performance-budget claim
is made. Browser compilation remains T4e; no native compiler exists. Raw numerical
trials retain executable fingerprints, actual repository identity and limits.

All 12 disabled/stopped/slow/rejecting browser scenarios pass across Chromium,
Firefox and WebKit, including quota rollback/backup/retry, durable edits, engine
cancellation/restart, binary-preserving peer-deletion recovery, verified offline
preparation and network-blocked reload/save/compile/support export. Seven actual
failure records per browser match exact stored safe Loki bodies, Tempo spans and
fresh metrics: package/compile failures, quota save, failed recovery and rejected/
cancelled real MCP. This exposed a missing recovered-copy observation; that action
now wraps its existing save in a correlated recovery span without changing save
semantics. [Safe failure receipts](measurements/telemetry-failures.json) retain
approved-record hashes, not document digests or authenticated CI signatures.

The private evaluator passes original latency/loss/delivery/outage/stale formulas
and pending durations, with nine [firing/recovery receipts](measurements/telemetry-operational-alerts.json).
The test uses explicit synthetic latency/loss records, real ingress rate rejection,
a paused/resumed exact ingress PID, and ten real idle minutes plus five pending
minutes for staleness. It completes in 943 seconds. Temporary groups are removed;
notification delivery and 30-minute latency recovery are not exercised.

Final ordinary acceptance passes 129 Rust tests (two ignored) and 194 JavaScript
tests (six explicit integration skips); the ignored real-Alloy case passes
separately. Five skipped private integrations are exercised explicitly; live CI
artifact authentication remains credential-gated. Storage browser checks pass
3/3; the expanded run passes 26/27, then the Grafana virtual-row scroll race is
fixed and its unchanged run-ID/trace-link assertions pass 3/3 engines. All 30
distinct scenarios have passing final evidence. Native/support/test-run/browser
queries also pass after a complete storage restart with the release-built ingress,
without republishing. The execution record includes earlier calibration failures
and excluded timing runs rather than counting them as green measurements.

The [persistent-ingestion and continuous-CI runbook](telemetry-deployment.md)
ships opt-in NixOS/systemd/nginx artifacts, exact private routes, runtime-only Cloud
credential loading, protected GitLab file-variable commands, verification and
upgrade/rollback/token-rotation steps. Both NixOS profiles evaluate; neither is
deployed. No external credential/service, push, DNS or Cloud/GitLab change is used
for this delivery. Existing TeX/browser assets are reused; pinned observability
tools are verified in the private worktree cache. All owned servers/browsers stop.

T remains incomplete: the architect must activate and verify persistent private
HTTPS ingestion and continuous direct CI publication, finish managed Loki shortcut
permissions and DNS checks, and agree hosting/storage quota/backup/receiver policy
with the owner. Continuous profiling ingestion and notification delivery are unproven;
supported resource evidence is bounded timing/bytes/WASM capacity and sampled
RSS/PSS. Frozen companion/folder capabilities are unchanged.

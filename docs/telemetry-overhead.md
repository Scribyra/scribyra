# Browser telemetry overhead

`npm run measure:telemetry` compares the actual Pages application with collection
**disabled**, **local diagnostics enabled**, and **remote export enabled** at 100%
sampling. The remote path uses the delivered Rust privacy ingress and pinned Alloy,
then checks the exact successful compile span in the real OTLP destination. The
sink is a bounded verification destination, not retained Grafana storage; retained
storage acceptance is documented separately in [telemetry.md](telemetry.md).

## Reproduce

Reuse the existing compiler assets, Cargo outputs and installed browser engines.
Check disk space before building. With the project's Rust/wasm-bindgen toolchain
and Playwright browser executables configured:

```sh
cargo build -p scribyra-telemetry --bins --examples --locked
npm run build:pages
python3 scripts/telemetry-tools.py alloy
ulimit -c 0
npm run measure:telemetry -- --runs=3
```

The Alloy tool command reuses a verified installed pin; it downloads only when
missing. The benchmark does not fetch TeX archives or install browsers. It serves
the existing release files over loopback and creates disposable browser profiles.
Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, `PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH` and
`PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH` for existing executables when needed. This
Linux WebKit environment also requires its software EGL configuration, as in the
existing browser acceptance setup. Set a valid `TMPDIR` for Cargo if the shell's
temporary build directory has expired.

The default runs three repetitions × three browsers × three modes: 27 independent
browser processes/profiles. `--browser=chromium --runs=1` is a calibration run, not
the full gate. Each repetition rotates the mode order. Trials run serially; avoid
other builds/browser suites while collecting results.

Each trial measures navigation to the landing controls, a cold-worker compile,
two warm compiles, offline preparation, then a network-blocked reload and compile.
Collection is selected before startup. The remote destination is connected through
the actual UI after startup because credentials are tab-scoped; startup therefore
compares disabled collection against local recording, without remote connection
setup. All three modes execute the same project and UI workflow.

The browser context and asset server both refuse the network during the offline
phase. A pass requires a successful PDF, zero asset response bytes while offline,
the expected enabled/disabled local recorder behavior, bounded local records, no
schema rejections, and actual remote compile delivery for remote trials. The
harness uses a synthetic document and checks source/token exclusion in the final
bounded OTLP capture window. Retained privacy acceptance is separate. It opens no user profile or project. No raw source, logs, screenshots,
traces, request bodies, tokens, endpoint addresses or profile paths enter the
measurement report. Ephemeral ingest credentials and services are removed/stopped
in cleanup paths.

## What the numbers mean

Results are written to `.cache/telemetry-overhead.json`; `--output` is restricted
to `.cache`. The report records actual build identity, browser versions, host CPU,
method, per-trial phase timings/bytes and memory sample counts. A failed trial is
recorded as a failure and stops the run; it does not become a timing sample in a
successful final summary.

- Wall times include Playwright dispatch/polling and visible PDF readiness.
  Compiler-reported duration is separate. Startup ends when Import ZIP is visible.
- Asset bytes are actual uncompressed HTTP response body bytes written on
  loopback, including service-worker activity and in-flight writes at boundaries.
  Whole-trial bytes include setup/inspection; phase sums may omit those intervals.
  Headers, TLS and internet compression/latency are excluded. Export POST body
  bytes count attempted browser payloads separately, not downstream OTLP volume.
- Browser process-tree RSS/PSS is sampled every 250 ms. RSS double-counts shared
  pages; PSS apportions them. Peaks are observed lower bounds, not exact maxima.
  A phase with no sample has null peaks. The process tree includes browser,
  renderer and worker processes; these are not worker-only JS heap measurements.
  Startup memory includes context creation before navigation timing begins.
  Native ingress/Alloy and the Node driver are outside the sampled process tree,
  though their CPU contention can affect timings.
- Summaries report mode medians and the median of within-repetition percentage
  changes against disabled collection. Warm timing is each trial's mean of two
  warm builds before the cross-trial median. With three observations, negative
  changes and small differences can be ordinary run-to-run noise; they are not
  evidence that telemetry improves performance or has zero cost.
- These results cover one synthetic article on headless Linux desktop. OS file
  pages are shared/warm across trials. There is no mobile, internet-network,
  statistical-significance, native exporter cost or exact allocation claim.

Measured results and remaining acceptance work are recorded in
[the T4 evidence](telemetry.md#t4e-browser-overhead-and-verified-private-release).

## Native exporter overhead

`npm run measure:telemetry:native -- 3 .cache/t-local/native-overhead.json` applies
the T4e method separately to the delivered native exporter. Build prerequisites
inside the flake, reusing installed tools:

```sh
nix develop -c cargo build --release -p scribyra-folders -p scribyra-sync --bins --locked
nix develop -c cargo build -p scribyra-telemetry --bins --examples --locked
nix develop -c python3 scripts/telemetry-tools.py alloy
nix develop -c npm run measure:telemetry:native -- 3 .cache/t-local/native-overhead.json
```

Three repetitions rotate disabled/local/remote order. Each trial launches fresh
release-built `scribyra-folders inspect` and `scribyra-sync` processes with the
collection configuration installed before startup. Read-only inspection hashes
32 synthetic 25-KiB files. Sync startup ends at its listening message; the fixed
workload runs 30 sequential PUT/GET pairs of a 64-KiB blob against actual SQLite,
with a ten-millisecond driver pause per pair. Every returned body must match.
PUTs reuse one digest and deduplicate data; this is not bulk-write throughput.
There is no native compiler; T4e measures compilation in the browser.

CLI time includes process startup, inspection and the existing bounded shutdown
flush. Service workload time includes HTTP, SQLite, driver scheduling and pauses;
the 1.5-second export drain is separate. Local collection uses its bounded
in-memory recorder, with optional diagnostic disk snapshots disabled in every
mode. The remote route counts attempted native JSON POST bodies, then uses the
real debug-built Rust ingress and pinned Alloy forwarding to a bounded OTLP
decoding sink. Each remote trial requires newly observed successful
`native_session` and `sync_http` span IDs and excludes seeded fixture values,
token and endpoint. This verifies fresh protocol delivery, not retained Grafana
storage or lossless delivery of every event; T4d and the retained-query acceptance
establish storage separately.

The harness uses the same 250-ms Linux process-tree RSS/PSS sampler as T4e,
excluding the Node driver, ingress and Alloy. Short inspections can exit between
samples: missing live CLI memory observations are null, not zero overhead.
Service memory includes startup/workload/drain, with per-phase sample counts
retained. Peaks are sampled lower bounds, not allocations or exact maxima.
The raw report includes release executable SHA-256 identities, actual revision/
dirty state, toolchain, collector pin, mode medians and median within-repetition
percentage changes from disabled collection. A separate calibration run is not
included in final measurements.

Run trials serially after other local checks stop. OS file caches are shared and
warm, and this is a shared engineering host; unrelated host activity cannot be
excluded. Three observations of one synthetic workload do not support statistical
significance, internet/TLS latency, companion MCP performance, collector memory,
native compilation or mobile claims. Small/negative differences can be noise.
Remote CLI shutdown can visibly include the exporter's 250-ms coalescing delay;
it must not be presented as general application editing latency.

Measured November 5, 2026: nine final trials pass, covering nine inspections and
540 successful sync HTTP requests. All 16 attempted remote batches are accepted;
each remote trial verifies fresh native/sync success spans through Alloy. Disabled
and local modes attempt zero export requests. All nine CLI trials have at least
one live memory sample; future shorter inspections may have none.

| Collection | CLI wall ms | Service startup ms | 60-request workload ms | Peak native service PSS MiB | Attempted export body KiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Disabled | 32.5 | 185.4 | 537.7 | 4.47 | 0.0 |
| Local | 33.1 | 172.7 | 523.7 | 4.55 | 0.0 |
| Remote | 272.4 | 757.7 | 640.6 | 5.18 | 26.8 |

Values are medians of three observations per mode. Median within-repetition
changes for remote versus disabled are +739.4% CLI wall time, +70.6% startup,
+12.1% workload and +14.7% sampled service PSS. These paired statistics differ
from ratios of mode medians. Startup varies from 101–1,514 ms disabled and
316–1,327 ms remote; the small noisy sample cannot attribute those differences
solely to the exporter. The consistent short-CLI increase (32.5 to 272.4 ms at
the mode medians) includes the existing coalescing/shutdown flush. No performance
budget or statistical-significance claim was established.

[All nine raw trials](measurements/telemetry-native-overhead.json) record repository
revision `c6e85ce` with `dirty: true` (pending evidence/docs), release executable
hashes, Rust/Node versions, Alloy v1.21.3 and the debug ingress profile. Native Rust
production code is unchanged by this delivery. Browser compilation overhead stays
in T4e. A three-trial calibration and a successful nine-trial candidate overlapping
storage startup are excluded; the final nine run after owned browser/build/
storage checks stop. The shared host still permits unrelated activity. All trial
processes, helper credentials and fixtures are cleaned up.

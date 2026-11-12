# Scribyra telemetry operations

The browser remains static and collection/export defaults off. The optional Rust
ingress enforces the shared closed schema before data reaches Alloy. Keep backend
and collector interfaces private. Authenticated `/v1/events` and optional test/CI `/v1/runs` are candidates
for TLS routes; such routes are not installed by the local launcher.

## Private single-node storage

The pinned Linux/amd64 tools are Alloy 1.21.3, Prometheus 3.15.1, Loki 3.7.9 and
Tempo 3.1.1. Upstream release archive checksums and exact sizes are in
`tools.lock.json`. The installer verifies downloads and cached executables,
extracts the selected executable (or the complete required Grafana distribution)
and removes the archive. The four storage/collector binaries
occupy about 940 MiB together. Optional Grafana OSS 13.3.0 adds approximately
1.4 GiB including its required web assets. Check free space before installing or building.

```sh
python3 scripts/telemetry-tools.py alloy
python3 scripts/telemetry-tools.py prometheus
python3 scripts/telemetry-tools.py loki
python3 scripts/telemetry-tools.py tempo
python3 scripts/telemetry-tools.py grafana
cargo build -p scribyra-telemetry --locked
python3 scripts/telemetry-stack.py --state "$HOME/.local/state/scribyra-telemetry" --grafana
```

Run commands from the repository root. The launcher uses the debug ingress build;
the opt-in [persistent deployment module/runbook](../../docs/telemetry-deployment.md)
selects `--ingress-binary target/release/scribyra-telemetry` instead. A 0700 state
directory holds the random 0600 ingress token, backend WALs/blocks and bounded
private startup logs. Preserve this directory for restarts. A filesystem lock
prevents two launchers using the same state. Ctrl-C/SIGTERM stops children and
retains data; an unexpected child exit stops the other children. No automatic
restarts or archive downloads happen in the launcher.

Every listener uses loopback. The default port base is 18789:

| Offset | Service |
| --- | --- |
| 0 | Authenticated ingress (`/v1/events`), health and metrics |
| 1 | Alloy administration |
| 2 | Alloy internal OTLP/HTTP |
| 3 | Prometheus query API and OTLP receiver |
| 4, 5 | Loki HTTP and internal gRPC |
| 6, 7, 8 | Tempo HTTP, internal gRPC and OTLP/HTTP |
| 9 | Optional Grafana OSS (login required) |

Use `--port-base` to select a different contiguous block, and `--origin` for the
canonical browser origin (default `http://127.0.0.1:4173`, or the port from
`SCRIBYRA_TEST_PORT` when set). In Diagnostics, enable
local collection and connect to `http://127.0.0.1:18789/v1/events` using the token
from the private state directory. Do not use Grafana management/Cloud tokens.
Token values belong outside source, project exports, logs and screenshots.

Alloy converts bounded delta metrics to cumulative and forwards each signal to
its maintained native OTLP endpoint. Export queues hold eight requests per
signal, with one consumer and a fifteen-second retry budget; process exits can
lose queued observations. Ingress acceptance acknowledges collector acceptance,
not durable backend storage. The readback check below verifies stored data.

Prometheus uses seven-day / 512-MB TSDB retention; the size limit excludes some
WAL/head overhead. Loki and Tempo use seven-day time retention with filesystem
storage. Time retention is asynchronous and is not a hard byte quota. Supply a
dedicated filesystem quota/volume and monitoring before sustained use. This
single-node profile is a reproducible development/small-installation starting
point; availability, backups, production object storage and enforced host resource
budgets require deployment decisions. Vendor usage reporting is disabled.

## Actual application readback

Build the app, start the stack as above, then run the browser test with the same
state directory. Set browser executable overrides as required by the environment.

```sh
npm run build
SCRIBYRA_TEST_STORAGE_STATE="$HOME/.local/state/scribyra-telemetry" \
  npm run test:storage -- --project=chromium
python3 scripts/telemetry-readback.py --state "$HOME/.local/state/scribyra-telemetry"
```

For a different port base, also set `SCRIBYRA_TEST_STORAGE_PORT_BASE` for the test
and pass `--port-base` to readback. The test imports a seeded private paper,
compiles through the real worker, queries all three backends, verifies a common
compile/TeX trace, and checks stored responses for seeded document contents,
filenames, endpoint and token. It writes only safe evidence metadata to the state
directory. The readback command uses that trace and historical metric timestamp;
stop/restart the stack with the same directory and rerun it to test persistence.
No new telemetry is submitted by the readback command.

Protocol-only forwarding tests still use `forward.alloy` and the bounded fixture
sink. They do not prove storage, Grafana or deployment acceptance. Retained native Cloud-query evidence, managed HTTPS
ingestion and the remaining T4 gates remain to be delivered.

Endpoint/configuration choices follow the official
[Prometheus OTLP guide](https://prometheus.io/docs/guides/opentelemetry/),
[Loki OTLP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/), and
[Tempo 3 monolithic example](https://github.com/grafana/intro-to-mltp/blob/main/tempo/tempo.yaml).
Tempo 3 uses a live-store and backend scheduler rather than the legacy
ingester/compactor configuration; this monolithic profile needs no Kafka.


## Grafana views and alert evaluation

With `--grafana`, open `http://127.0.0.1:18798/` and log in as `operator` using
`grafana-admin.password` in the private state directory. The launcher generates
this password once; it does not print it. Anonymous access, signup, SMTP, plugin
preinstallation and vendor reporting/update checks are disabled. Inherited
`GF_*` variables cannot override this private profile. SQLite uses WAL mode.

Versioned provisioning installs three datasources, a Scribyra folder, an operations
overview, collection-health and test-run views. Overview cards show received activity,
observed failures, compile p95 and age of the last activity, followed by operation,
resource, log and trace panels. Labels and descriptions distinguish missing data,
sampling, idle clients and delivery failures; missing telemetry is not a success
signal. Log trace IDs link to Tempo, and Tempo links back to approved Loki events.

Seven 30-second evaluation rules cover application-source operation failures, reported CI suite failures, sustained compile
p95 above 30 seconds (at least five completions), unreachable/absent ingress,
rejected/unavailable delivery, idle/stale ingestion after earlier activity, and
application-source exporter loss. Failure rules count safe Loki records directly,
including the first sparse failure; CI failures additionally require a typed run ID.
Application-data and CI rules treat no data as normal because export is
optional; ingress availability treats no data as alerting. Query errors remain
visible as errors. Stale activity can mean deliberately disabled or idle clients;
it does not mean a save failed. Alert instances are visible in Grafana. Configure
an operator-approved contact point separately; this profile sends no email.

For a reproducible failure transition, start with a fresh test state directory,
run the storage test to produce successful application data, then:

```sh
SCRIBYRA_TEST_STORAGE_STATE=/private/test-state npm run test:grafana -- --project=chromium
SCRIBYRA_TEST_STORAGE_STATE=/private/test-state node --test tests/telemetry-grafana-alerts.test.mjs
```

The browser check performs real failed compiles labelled `local_test`, verifies a
source-selected controlled rule firing, and checks that the production application
rule stays normal, with stored correlated failure evidence. It disables trace/video/screenshots
to avoid retaining login credentials. The Node integration check installs a
separate synthetic-validation rule group, verifies optional/required no-data and
query-error behavior in the real evaluator, then deletes that group. Its results
are not application events. Both write only safe evidence metadata to the test
state directory. Sustained latency/staleness/delivery fault and notification
routing gates are still separate acceptance work.

For an existing private Grafana Cloud organization, `telemetry-grafana.py --url
https://YOUR-GRAFANA-HOST` validates the three existing managed datasources and
prints a dashboard plan. Set `SCRIBYRA_GRAFANA_TOKEN` through a private runtime
credential binding and add `--apply` to publish the versioned views. It uses only
the dedicated `scribyra-telemetry` folder, removes default Viewer/Editor grants
(organization administrators retain access), verifies stored panels and blocked
anonymous/public-dashboard access, and never prints or persists the token. It
does not alter managed datasources unless `--run-links` is explicitly selected.
Add `--alerts` to provision the seven owned Cloud rules in the same private folder,
with 30-second evaluation and source filters. These rules are active but their
notification routes reference the dedicated all-time `scribyra-dashboard-only`
mute interval. Contact points and organization notification policies remain
unchanged. Alert states remain visible without sending messages; an operator can
deliberately configure delivery later. Cloud Alloy provisioning is separate.


## Alloy → managed Cloud profile

Cloud is optional. The self-hosted stack above remains independent of it. To use
an explicitly selected HTTPS OTLP gateway, supply owner-only runtime files for its
username/tenant ID and write-only ingestion token, outside the repository and
project/sync roots:

```text
SCRIBYRA_CLOUD_OTLP_URL=https://YOUR-OTLP-GATEWAY/otlp
SCRIBYRA_CLOUD_USERNAME_FILE=/private/operator/cloud.username
SCRIBYRA_CLOUD_TOKEN_FILE=/private/operator/cloud.ingest-token
```

Export these variable names through the host's private environment binding, then:

```sh
python3 scripts/telemetry-stack.py --cloud \
  --state "$HOME/.local/state/scribyra-cloud-collector" \
  --origin https://YOUR-APP-HOST
```

This starts only the authenticated Rust ingress and pinned Alloy, with no local
backend or Grafana installation required. It does not expose a public listener or
create DNS/TLS. The browser still needs its separate ingest token and `/v1/events`
URL; it never receives Cloud or Grafana management credentials. All listeners stay
on loopback. Use a TLS reverse proxy exposing only `/v1/events` when deploying to
remote browsers. The proposed managed hostname remains undeployed pending its
host/DNS setup.

The Cloud profile keeps the same bounded delta-to-cumulative conversion and an
eight-request exporter queue, one consumer, five-second request timeout and
fifteen-second retry budget. It also scrapes only the fixed ingress request/event/
last-success metrics and `up`, with a 64-sample scrape limit. Job/instance labels
are fixed `scribyra-ingress`; real discovery/listen addresses are not exported.
This is a single-ingress profile; multiple collectors must not concurrently write
the same cumulative metric streams. Collector acceptance is still best effort,
not an acknowledgement of durable Cloud storage.

Alloy 1.21.3 has a measured authentication compatibility issue: the documented
`client_auth` block fails component construction with “no credential source
provided”, for both literal and file credentials. This pin uses the supported
legacy top-level username/password arguments instead. `local.file` loads the
runtime files; the token value is secret-typed. Recheck the newer block on upgrade.
Configuration-only validation does not catch this runtime failure; startup and
actual authenticated export are both tested.

For explicit managed integration verification, start the collector and the
assembled local Pages preview. Supply a separate owner-only management token
file to the **test process**, not to the app or collector configuration:

```text
SCRIBYRA_TEST_CLOUD_STATE=/private/collector-state
SCRIBYRA_TEST_CLOUD_PORT_BASE=18789
SCRIBYRA_TEST_PAGES_URL=http://127.0.0.1:4175/
SCRIBYRA_TEST_GRAFANA_URL=https://YOUR-PRIVATE-GRAFANA
SCRIBYRA_TEST_GRAFANA_TOKEN_FILE=/private/operator/grafana-management-token
```

Run `npx playwright test tests/browser/telemetry-cloud.spec.js --project=chromium`
(or Firefox/WebKit with the appropriate browser overrides). The test invokes real
success/failure compilation on synthetic private papers, queries metrics/events/
traces through Grafana and checks exact worker correlation, fixed ingress health
labels and private-content/token exclusion. Credential/privacy assertions report
booleans instead of dumping failed response bodies or secret values. Browser
traces/video/screenshots are disabled. Safe evidence metadata remains in the
private collector state directory. These are real app operations driven by tests,
not natural user-activity measurements or direct fabricated OTLP probes.


## Optional native runtime export

The companion, existing folder CLI and sync demo use the same Rust native adapter.
Remote delivery defaults off. Configure all three variables explicitly for the
native process:

```text
SCRIBYRA_DIAGNOSTICS=1
SCRIBYRA_TELEMETRY_ENDPOINT=https://YOUR-INGRESS/v1/events
SCRIBYRA_TELEMETRY_TOKEN_FILE=/private/operator/ingress.token
SCRIBYRA_TELEMETRY_SAMPLE_PERCENT=100
```

Use the ingress-only 64-hex token, not a Cloud or Grafana token. Its file must be
regular, at most 66 bytes including a final newline, and owner-only on Unix. HTTPS
is required except on literal loopback/localhost. Embedded credentials, query
strings/fragments and other paths are rejected. The endpoint is bounded to 2 KiB.
Missing/invalid settings disable remote delivery with a fixed configuration status;
collection disabled means no token-file read or HTTP worker. Settings/token are
read once; restart the process after changing them. Supported trace sampling
percentages are 100, 10 and 1; keep browser/native percentages aligned when a
complete cross-runtime trace is needed.

Only records accepted by the Rust recorder enter the transport. The producer uses
a nonblocking queue lock; contention/overflow drops observations rather than
waiting for I/O. The waiting queue is bounded to 128 records / 32 KiB of encoded
payload, with one batch of up to 32 records. Records expire after five minutes.
These are encoded-payload budgets, excluding object/HTTP/TLS runtime overhead.
A burst coalesces for at most 250 ms or until 32 records are ready. Requests run
on a separate thread with two-second global deadlines, at most three identical
batch attempts and short bounded backoff. Redirects are never followed. The
private authorization header is marked sensitive; response bodies and transport
exception text are discarded. Permission/schema failures block further sends
until the process is restarted with corrected configuration. Delivery is best
effort; finite ingress receipts and ambiguous acknowledgements can still cause
loss/duplicates. Sampling and drop deltas accompany subsequent accepted batches.

The maintained `ureq` 3.5.1 client uses Rustls and the platform certificate verifier,
including the platform CA environment, and preserves its normal proxy/NO_PROXY
support. No certificate verification bypass is installed. A bounded resolver
adapter delegates to the SDK/OS resolver but allows only one outstanding lookup
per publisher, so a stalled system lookup cannot accumulate threads on retries.
The OS lookup itself cannot be forcibly cancelled; the caller still respects its
request deadline, subsequent lookups fail quickly while it remains outstanding,
and the queue stays bounded. This adapter uses the exact-pinned SDK's unversioned
resolver interface and must be revalidated during upgrades. These HTTP/TLS
libraries are native-target dependencies and are absent from the WASM app graph.

`Native::snapshot()` and optional local support snapshots include safe
`remoteDelivery` counters/status, never destination/token/filepath. The optional
`SCRIBYRA_DIAGNOSTICS_DIR` still controls independent private local files. Bounded
flush reserves half its budget for local output when both destinations are used,
then captures final remote counters in the support snapshot. The companion and
folder CLI retain their existing one-second shutdown budget; a failed export does
not change operation/CLI exit results. The sync demo exports continuously while
running; abrupt termination can lose its final queued batch. `SCRIBYRA_SYNC_PORT`
allows an ephemeral test port (`0`), with the existing default 8787 retained.

Reproduce native transport checks with `npm run test:native-telemetry` (OpenSSL CLI
is needed only to create the disposable test CA; set `SCRIBYRA_TEST_OPENSSL` if it
is not on PATH). For actual native companion → browser → worker ingestion, build
the app and run `npm run test:ingestion:native -- --project=chromium`, with Firefox/
WebKit repeats. To use the assembled `/app/` release preview instead, also set
`SCRIBYRA_TEST_PAGES_URL=http://127.0.0.1:4175/`. The fixtures create private tokens,
use real pinned Alloy, query full captured OTLP and clean up their own processes.
This protocol fixture proves delivery/correlation, not retained native Cloud-query
or the remaining T4 failure/overhead acceptance gates.

### Safe local test-run reporting

Build the shared validator once with `cargo build -p scribyra-telemetry --locked`.
Then run an approved suite, for example:

```sh
python3 scripts/telemetry-run.py --suite rust
python3 scripts/telemetry-run.py --suite javascript
python3 scripts/telemetry-run.py --suite browser --browser chromium
python3 scripts/telemetry-run.py --suite build
```

These commands use existing dependencies, binaries and runtime assets; they do
not install browser engines or TeX archives. Rust tools must be available on PATH;
native TLS checks additionally require OpenSSL (or `SCRIBYRA_TEST_OPENSSL`). The
JavaScript preset runs the versioned Node suite after its normal build prerequisites
have been prepared. `browser-pages` requires an assembled release served at
`SCRIBYRA_TEST_PAGES_URL`; without it the scenario is correctly reported skipped.

Only `.telemetry/<runId>.json` and `.xml` are retained. JSON contains closed-schema
counts/identity/timing; XML represents the overall process outcome. Failure output
and test names are discarded. Read the process exit status for success/failure.
Review the safe JSON artifact for available counts; absent counts mean unknown.
No publication is enabled by default. To publish, add an explicit HTTPS
`--endpoint https://<operator-host>/v1/runs --token-file <private-ingest-file>`;
loopback HTTP is accepted for local validation. The token file must contain the
64-hex ingest token and have owner-only permissions. Credentials never enter the
artifact. Transport has three finite attempts and does not override the suite exit
status. `GITLAB_CI=true` requires numeric `CI_PROJECT_ID`, `CI_PIPELINE_ID` and
`CI_JOB_ID`; it marks reported context, not authenticated proof of CI execution.
CI integration and Grafana test views are described below; live GitLab execution remains unverified.

### Test dashboard, safe CI artifacts and stored verification

Open `scribyra-test-runs` for observed suites and `scribyra-operations` for app
activity. Their source selectors prevent controlled test activity from silently
appearing as natural application usage; operations defaults to `application`.
No-data is unknown, not a successful run. Test counters describe received runs
since collector streams began and may reset with the collector; duration rates
need repeated observations. Compare like suites/browser profiles when inspecting
performance changes. The view does not establish a performance regression budget.
Sparse counter stats use the latest sample in the selected range. Retained
readback queries use the recorded observation time; querying a long-idle run at
now can otherwise yield no series from Prometheus's instant lookback.

The Pages job uses `scripts/ci-telemetry.py` for build/Rust/JavaScript and a
Chromium `browser-pages` smoke check against the assembled Pages tree. The
separate browser cache follows `package-lock.json` using GitLab's supported
[lockfile cache key](https://docs.gitlab.com/ci/caching/); the existing compiler/
toolchain cache key is preserved to avoid unnecessary TeX downloads. The helper
starts/stops a quiet loopback HTTP server for the latter. It retains safe summaries
as maintainer-only, one-day JSON/JUnit artifacts, including failures. Build/native
prerequisites must succeed before the test wrappers run. Configure these optional
GitLab variables only when a persistent authenticated ingress is ready:

- `SCRIBYRA_CI_INGRESS_ENDPOINT`: the HTTPS `/v1/runs` destination.
- `SCRIBYRA_CI_INGRESS_TOKEN_FILE`: a protected/masked **file-type** variable whose
  file contains the private 64-hex ingest token with owner-only permissions.

Both variables are required together. No destination is inferred and no default
remote collection is enabled. A failed collector cannot change suite exit status.
No actual GitLab pipeline execution is claimed until its job/artifacts are checked.

For repeatable local stored-query checks, start `telemetry-stack.py --grafana`,
then run with Rust tools available on PATH:

```sh
SCRIBYRA_TEST_STORAGE_STATE=/private/operator/stack-state \
  node --test tests/telemetry-runs-storage.test.mjs
```

This executes actual Rust and deliberate failing tests and verifies stored
metrics/logs/traces plus every dashboard query. Restart that same stack and add
`SCRIBYRA_TEST_RUNS_READBACK_ONLY=1` to verify the retained IDs without republishing.
For the rendered link check, use the same state variable with
`npx playwright test tests/browser/telemetry-runs.spec.js --project=chromium`.
Raw test output and credential-bearing browser traces are not retained.

Self-hosted Loki provisions the two named run links automatically. On managed
Grafana, dashboard deployment needs no datasource edit. Optional
`telemetry-grafana.py --apply --run-links` also needs Loki datasource-write access;
the current token's PUT is denied with HTTP 403, so Cloud log shortcuts remain
unconfigured. Existing datasource settings/credentials and other links are
preserved. The correlated traces panel and safe run IDs remain available.

### Source-aware alert acceptance

Application alerts exclude local tests, CI and synthetic assertions. The separate
CI rule requires a typed run ID and counts failed CI suite records from the last
hour. It reports received metadata; confirm the actual GitLab job/artifact before
claiming a pipeline ran. Failure rules and overview failure counts use safe Loki
records, including a first sparse observation that a metric increase could miss.

With an explicitly started private test stack, verify source isolation and the
optional/required no-data and query-error cases:

```sh
SCRIBYRA_TEST_STORAGE_STATE=/private/test-state \
  node --test tests/telemetry-alert-sources.test.mjs tests/telemetry-grafana-alerts.test.mjs
```

The source check executes an actual failed assertion labelled synthetic, evaluates
controlled source-selected rule clones for that exact run, and checks fresh
production evaluations remain normal. Probe groups are deleted in cleanup. It
does not invent CI job IDs or label the controlled failure as application usage.
The browser Grafana test similarly uses local-test source and a temporary rule
clone for actual failed compilation.

Managed `--alerts` deployment adds only the owned all-time UTC mute and direct
settings for the seven owned rules. It reads the existing receiver name but does
not edit that receiver or organization policies. The generated route is verified;
no test notification is sent. Enabling delivery to a chosen contact point remains
a deliberate operator action. Checking the generic alert's active/suppressed API
status is insufficient to prove a route's mute timing. The mute-timing HTTP API
used here is currently supported but deprecated upstream; recheck compatibility
with the pinned Grafana profile before replacing that API on upgrade.

### Retained native API and cross-runtime verification

Build the delivered executables before verifying native source labels. Cargo's
cache is reused; no clean rebuild or compiler archive download is required:

```sh
cargo build -p scribyra-companion -p scribyra-folders -p scribyra-sync --bins --examples --locked
```

Use an explicitly started private `--grafana` stack and the existing assembled
Pages release. For example, select browser origin `http://127.0.0.1:4175` when
starting the stack, and serve `.pages` there with a loopback HTTP server. Then:

```sh
SCRIBYRA_TEST_STORAGE_STATE=/private/native-test-state \
SCRIBYRA_TEST_PAGES_URL=http://127.0.0.1:4175/ \
  npm run test:storage:native
```

The Node scenario performs read-only CLI success/failure and sync HTTP GET/PUT
success/failure on disposable fixtures. The browser scenario performs a real MCP
compile in each configured engine and reads metrics/logs/traces through Grafana.
It compares the exact local browser record and native support records, follows
parent IDs through native/browser/workers and verifies private-value exclusion.
The fixture collector credential is separate from Grafana/Cloud management
credentials, which are removed from native client environments. The unfinished
folder implementation is not resumed. Engines/tools must already be installed;
these checks do not install them or fetch a TeX archive. With no explicit storage
state, private integrations are reported skipped, not passed.

After those checks, stop and restart the **same** self-hosted state directory.
Verify the retained evidence without launching clients or republishing:

```sh
SCRIBYRA_TEST_STORAGE_STATE=/private/native-test-state \
SCRIBYRA_TEST_NATIVE_READBACK_ONLY=1 \
  node --test tests/telemetry-native-storage.test.mjs
```

This requires all three browser evidence files from the first phase. It checks
original event hashes, historical metric timestamps and exact span/parent IDs.
Metric samples must originate within the original scenario; a pre-existing counter
is not accepted as evidence of a new native observation. Clients and the test
ingress run on the same host/clock domain for that check.
Evidence expires with backend retention; missing old records are not a pass.
Files `native-readback-evidence.json`, `native-browser-evidence-<engine>.json`
and `native-retention-evidence.json` contain only safe verification metadata and
are written owner-readable in the private operator state.

For the managed profile, use the separately configured Cloud ingress/Alloy
launcher and bind `SCRIBYRA_TEST_GRAFANA_URL` plus
`SCRIBYRA_TEST_GRAFANA_TOKEN` privately to the test controller, with its port base
in `SCRIBYRA_TEST_STORAGE_PORT_BASE`. These are readback credentials, never app
settings. The same scenarios and readback-only mode work against managed
backends; stop the verification collector before the latter to prove query
retention independently of a live publisher. No notification delivery is tested.

# Milestone T operational acceptance audit

November 5, 2026. This audits the complete T acceptance gate and its six required
deliverables without changing roadmap order or declaring T complete. Earlier
managed/GitLab results below are **historical evidence**, not new authenticated
checks. This local run accesses no operator credentials or external service.
Local test stacks generate their own disposable authentication material.

## Acceptance gate, line by line

| Roadmap gate | Evidence and present boundary |
| --- | --- |
| Reproducible self-hosted stack receives real runtime/test metrics, events and traces; Grafana distinguishes no data, activity, failures and staleness. | The pinned ingress/Alloy/Prometheus/Loki/Tempo/Grafana stack is launched privately at port base 24789. Actual native CLI/sync and Rust/synthetic-failure suite integrations query retained evidence through Grafana. Browser storage, dashboards and cross-runtime chain checks are rerun. Separate controlled evaluator checks exercise no-data/error behavior and operational alert formulas. These are integration checks, not seed-only dashboards. |
| Failed compile/package request, save/recovery, rejected or cancelled MCP, and failing synthetic test can be followed through safe correlated evidence; native uses delivered CLI/API. | `telemetry-failures.spec.js` compares each actual local safe event to its exact stored Loki body/hash, corresponding Tempo span and fresh operation metric. It covers package-download failure, ordinary TeX failure, quota save failure, failed recovery then retry, and real companion/browser MCP rejection and cancellation. MCP retains its native parent. `telemetry-runs-storage.test.mjs` follows a deliberately failing real Node assertion; native storage tests exercise delivered inspection/sync and MCP→browser→worker paths. All fixtures seed private values and exclude them from queried evidence. |
| Offline local diagnostics/support export; disabled/stopped/slow/rejecting collection preserves edit/save/cancel/compile/cache/recovery. | `telemetry-isolation.spec.js` runs all four modes in Chromium, Firefox and WebKit. A stopped collector must first accept real save activity. Slow requests never acknowledge; rejection returns 403. Each scenario verifies durable edits, a real quota transaction failure plus source backup and retry, engine cancellation/new-worker compile, verified offline preparation, peer deletion/recovered-copy ZIP equality (including binary bytes), network-blocked reload/edit/compile and a second durable reload. Reviewed support download equals its preview; disabled collection has zero export attempts/events. This covers existing cache/recovery behavior, not future folder synchronization. |
| Rust/JS/browser checks cover bounds/privacy/correlation/delivery/drop/ingestion/querying; disabled/enabled startup/compile/transfer/memory overhead with method/limits. | `npm test` covers shared schema, frozen companion/folders and transport behavior. T4e retains 27 browser trials/108 compiles. The new native harness uses three rotated disabled/local/remote modes over three repetitions, fresh CLI/service processes, actual read-only inspection and 60 SQLite HTTP operations per trial, with the T4e sampler and real Alloy. Native compilation does not exist; browser compiler overhead remains T4e. See [measurement method](telemetry-overhead.md). |
| Real CI IDs/revisions/results, controlled artifact access/retention/failure links; complete setup/export/upgrade docs for self-hosters. | [T4f](telemetry.md#t4f-authenticated-gitlab-artifacts-and-retained-ci-queries) records real authenticated private jobs, access/expiry metadata and retained exact records; this run does not reauthenticate those jobs. Local actual suite/failure ingestion and rendered failure-trace links are rerun. [Deployment artifacts/runbook](telemetry-deployment.md) prepare persistent ingestion, CI variables, verification, token rotation, backup/upgrade/rollback. **Continuous direct CI publication and operated HTTPS remain open until the architect deploys and observes a real job.** |

## Required deliverables and operational boundaries

| Required roadmap deliverable | Audit |
| --- | --- |
| Webapp gathering | Delivered contract, worker/application instrumentation and bounded local controls; offline/exception privacy evidence in T1/T2/T3a and the local checks above. No runtime behavior/default destination is changed here. |
| Collector deployment | Reproducible pinned private self-hosted stack runs locally. Prior verification-only Cloud collectors are historical evidence. New opt-in systemd/nginx artifacts are evaluated locally; **persistent host installation, sandbox startup, Cloud credential loading and TLS deployment are not performed**. |
| Browser-to-collector route | Real authenticated loopback ingestion and four fault modes exercised in all engines. Origin/token/body/rate/queue/sampling/drop policy covered by Rust/JS and real ingress tests. **Managed DNS/HTTPS route remains undeployed**. |
| Grafana provisioning | Three versioned private views and seven alert rules; actual panel queries, failure log/trace links and source isolation checked locally. Prior managed provisioning/readback recorded in T3b/T4; **managed Loki shortcut write permission remains outstanding**. |
| Retention, access and alerts | Local seven-day backend settings, Prometheus 512-MB retention, bounded client/collector queues and private Grafana remain in the [operations guide](../ops/telemetry/README.md). Real evaluator no-data/error/source probes and the optional full-timer operational check exercise alert semantics. Local restart/readback is repeated without republishing. Cloud retention/access results are historical; future artifact deletion is not waited for. Host quota, backup operation and notification receiver/delivery need operator decisions/verification. |
| End-to-end evidence | Real supported browser/native/test operations and controlled failures are queryable; measurements and setup/upgrade instructions are retained. No generic profiling SDK or profiling backend is added: supported resource diagnostics remain bounded duration/bytes/WASM capacity and sampled process-tree RSS/PSS. Continuous profiling ingestion is unproven and must not be inferred from metrics/logs/traces. |

Static/private constraints remain: static app, opt-in dynamic services, no default
external collector, no paper/source/TeX logs/paths/provider payloads/secrets in
approved telemetry, bounded labels/buffers, no automatic browser traces or private
fixture uploads. Self-hosting requires no Grafana Cloud account. Frozen companion
and folders acquire no features; only their existing CLI/API is exercised.

## Repeat local checks

All commands run inside the flake and reuse installed compiler assets. Select
the appropriate existing Firefox/WebKit executables through the supported
`PLAYWRIGHT_*_EXECUTABLE_PATH` overrides. This host uses software Mesa EGL for
WebKit as described in [telemetry.md](telemetry.md). No existing server on another
port is used. Playwright owns/cleans its preview on 4273.

The executions used these flake-shell overrides (the paths name existing store
assets; no browsers were installed by Playwright):

```sh
export SCRIBYRA_TEST_PORT=4273
export PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH="$PLAYWRIGHT_BROWSERS_PATH/firefox-1555/firefox/firefox"
export PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH="$PLAYWRIGHT_BROWSERS_PATH/webkit-2370/pw_run.sh"
export LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless
export __EGL_VENDOR_LIBRARY_FILENAMES=/nix/store/j6846pd6a2i4bx16wcdn571sq7jznr71-mesa-26.2.6/share/glvnd/egl_vendor.d/50_mesa.json
ulimit -c 0
```

```sh
nix develop -c npm test
nix develop -c npm run build
nix develop -c cargo build -p scribyra-telemetry --bins --examples --locked
SCRIBYRA_TEST_PORT=4273 nix develop -c python3 scripts/telemetry-stack.py --state .cache/t-local/stack --port-base 24789 --grafana
# Another shell, after the ready record (absolute state path):
export SCRIBYRA_TEST_STORAGE_STATE="$PWD/.cache/t-local/stack"
export SCRIBYRA_TEST_STORAGE_PORT_BASE=24789
SCRIBYRA_TEST_PORT=4273 nix develop -c npx playwright test tests/browser/telemetry-isolation.spec.js
SCRIBYRA_TEST_PORT=4273 nix develop -c npx playwright test tests/browser/telemetry-failures.spec.js tests/browser/telemetry-storage.spec.js tests/browser/telemetry-native-storage.spec.js tests/browser/telemetry-grafana.spec.js tests/browser/telemetry-runs.spec.js tests/browser/telemetry-ingestion.spec.js
nix develop -c node --test tests/telemetry-native-storage.test.mjs tests/telemetry-runs-storage.test.mjs tests/telemetry-grafana-alerts.test.mjs tests/telemetry-alert-sources.test.mjs
# Stop/restart that exact launcher, then read back, without new publication:
SCRIBYRA_TEST_NATIVE_READBACK_ONLY=1 nix develop -c node --test tests/telemetry-native-storage.test.mjs
SCRIBYRA_TEST_RUNS_READBACK_ONLY=1 nix develop -c node --test tests/telemetry-runs-storage.test.mjs
nix develop -c python3 scripts/telemetry-readback.py --state .cache/t-local/stack --port-base 24789
```

The operational alert check needs its **own idle** stack and an explicit ingress
PID belonging to it. Start another launcher with state
`.cache/t-local/operational-stack`, port base 25789 and `--grafana`. Wait for its
ready record. Identify the ingress from the direct children of that exact
launcher (`ps -o pid,comm --ppid "$STACK_PID"`), then:

```sh
SCRIBYRA_TEST_OPERATIONAL_ALERTS=1 SCRIBYRA_TEST_STORAGE_STATE="$PWD/.cache/t-local/operational-stack" SCRIBYRA_TEST_STORAGE_PORT_BASE=25789 SCRIBYRA_TEST_INGRESS_PID="$INGRESS_PID" nix develop -c node --test tests/telemetry-operations.test.mjs
```

This check keeps original rule formulas, thresholds and pending durations, only
selecting synthetic source in temporary clones. Explicit synthetic high-latency
and loss records traverse real ingress/Alloy; real authenticated bursts cause
rate rejection. The exact ingress PID is paused/resumed for the outage check;
storage/Grafana stay running. Staleness waits ten real idle minutes plus five
pending minutes. Temporary rules and paused state are cleaned in `finally`.
No notifications are configured/sent. Latency recovery after the 30-minute
observation window is not waited for; synthetic durations are not measurements
of actual slow compilation. Never point this test at a shared/production stack.

Credential-dependent commands and owner decisions are explicitly separated in
the [deployment runbook](telemetry-deployment.md); their existence is not a pass.

## Executed checks and limits

All browser runs below use `SCRIBYRA_TEST_PORT=4273`, the flake and the executable/
Mesa overrides above. Counts are top-level acceptance cases unless stated;
nested suite executions are not added again to those totals.

| Exact command inside `nix develop -c` | Observed result |
| --- | --- |
| `npm test` | Two successful invocations. Final: Rust 129 passed / 0 failed / 2 ignored; Node 194 passed / 0 failed / 6 skipped, 200 total. Initial Node run had 5 skips before the new optional operational case existed. Five of the final six skipped integrations are exercised explicitly below; actual CI artifact authentication remains credential-gated. The Rust crash-worker fixture is invoked by its parent test. |
| `npm run build` | Two production builds passed; the second includes the recovered-copy span correction. Existing compiler assets were reused. |
| `cargo build -p scribyra-telemetry --bins --examples --locked` | Passed. |
| `cargo build --release -p scribyra-telemetry --locked` | Passed; the restarted stack actually uses that executable through `--ingress-binary`. |
| `cargo build --release -p scribyra-folders -p scribyra-sync --bins --locked` | Passed. Frozen programs retain their features. |
| `cargo test -p scribyra-telemetry --test ingress real_alloy_receives_all_signals_and_converts_delta_metrics_for_storage --locked -- --ignored` with `SCRIBYRA_TEST_ALLOY=$PWD/.cache/telemetry-tools/alloy-v1.21.3` | 1 passed / 0 failed, explicitly exercising the ordinary suite's ignored real-Alloy check. |
| `npx playwright test tests/browser/telemetry-storage.spec.js` | 3 passed / 0 failed, one per engine. |
| `npx playwright test tests/browser/telemetry-failures.spec.js tests/browser/telemetry-isolation.spec.js tests/browser/telemetry-native-storage.spec.js tests/browser/telemetry-grafana.spec.js tests/browser/telemetry-runs.spec.js tests/browser/telemetry-ingestion.spec.js` | 26 passed / 1 failed: Firefox Grafana log row detached during explicit scrolling. Every new failure/isolation case passed in all three engines. |
| `npx playwright test tests/browser/telemetry-runs.spec.js` after the row fix | 3 passed / 0 failed. The click retains exact run-ID/trace-link checks and re-resolves virtualized rows. Together with the previous rows, all 30 distinct browser cases have passing final evidence. |
| `node --test tests/telemetry-native-storage.test.mjs tests/telemetry-runs-storage.test.mjs tests/telemetry-grafana-alerts.test.mjs tests/telemetry-alert-sources.test.mjs` with private state/port bindings | 4 passed / 0 failed / 0 skipped against the real private stack. Actual Rust and intentionally failing Node reports traverse ingress/Alloy/storage. The synthetic assertion's nonzero exit is expected evidence, not an acceptance failure. |
| `node --test tests/telemetry-runtime.test.mjs tests/telemetry-native.test.mjs tests/companion.test.mjs tests/reconciliation.test.mjs` | 20 passed / 0 failed / 0 skipped. |
| `node --test tests/telemetry-operations.test.mjs` with the explicit operational bindings above | 1 passed / 0 failed / 0 skipped in 943 seconds; nine firing/recovery receipts preserve original thresholds/pending periods. No receiver delivery or 30-minute latency recovery is claimed. |
| `node --test tests/telemetry-native-storage.test.mjs` with `SCRIBYRA_TEST_NATIVE_READBACK_ONLY=1` | 1 passed before restart. |
| `node --test tests/telemetry-native-storage.test.mjs tests/telemetry-runs-storage.test.mjs` with both readback-only flags | 2 passed after a complete stack stop/restart; no republishing. |
| `python3 scripts/telemetry-readback.py --state .cache/t-local/stack --port-base 24789` | Passed after restart: historical metrics, logs, trace and worker correlation verified. |
| `npm run measure:telemetry:native -- 3 .cache/t-local/native-overhead.json` | Final 9/9 trials pass, nine actual inspections / 540 successful sync HTTP operations / 16 accepted remote batches. A separate successful 9-trial startup-overlap candidate is excluded. Calibration command `npm run measure:telemetry:native -- 1 .cache/t-local/native-calibration.json` passed 3/3 mode trials. |
| `nix-instantiate --parse ops/telemetry/ingestion.nix`; offline `nix eval` of both NixOS profiles | Parsed; both profiles generated their systemd units and exact TLS route set, including Cloud `LoadCredential` runtime paths. This is evaluation, not an activated host service, nginx/ACME test or Cloud export. |

Calibration and exclusions are retained plainly: the inherited Chromium fault
run was 3 passed / 1 failed because it waited for telemetry before triggering a
save; after correcting setup the initial full matrix passed 12/12. The retained
failure calibration found the missing recovery span (0/1), fixed in production
code; its targeted Chromium rerun passed 1/1 before the final all-engine run.
Operational calibration first started before readiness (0/1), then supplied an
invalid synthetic duration/timeline (0/1); neither became accepted alert evidence.
The final full-timer run passes with valid explicit synthetic records. An initial
path-based Nix evaluation was interrupted; offline Git-flake evaluation passes. Native calibration passed three
mode trials; a first nine-trial candidate passed but overlapped stack startup
and is excluded from reported timings. Only the subsequent isolated nine trials
form the retained native baseline.

Pinned Alloy/Prometheus/Loki/Tempo/Grafana tools were bootstrapped and verified in
this worktree's ignored cache; Playwright engines and the TeX runtime were reused.
No Cloud/GitLab/DNS credential was read or used and no external service was
modified. Private helper credentials/fixtures are temporary; self-hosted state
stays private under `.cache/t-local`. All owned services and browser processes
are stopped after checks. Safe receipts in `docs/measurements` establish prior
queries, not signatures, authenticated external CI execution or an active service.

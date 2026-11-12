# Authenticated CI artifacts in Grafana

The optional integration check in `tests/telemetry-ci-storage.test.mjs` fetches a
real, terminal Scribyra GitLab.com job and its private JSON artifacts. It does not
create a synthetic CI environment or rerun that job's suites. The original CI
run IDs, revision, job/pipeline/project context, times, durations and framework
counts pass the shared Rust validator before publication through `/v1/runs`.

Authenticated job metadata, artifact CI context and revision must agree. The
check also exercises anonymous artifact denial, actual expiry metadata, fresh CI
metrics, framework case counters, exact safe Loki bodies, original-time Tempo
traces and the deployed dashboard's CI log query. Secrets do not enter run bodies
or test failure output. GitLab, Grafana management and ingest credentials remain
separate; native schema-validation children receive no token/password variables.
Requests are bounded, timed, directed to the fixed project API and reject
redirects. Only individual small JSON files are downloaded, never the large Pages
artifact archive or raw test output as an artifact.

## Reproduce with an actual completed job

Start the [private self-hosted stack](telemetry.md) with Grafana. Select a recent
job that produced `.telemetry/*.json` and remains within the shared 24-hour report
age limit. Supply a bounded owner-only GitLab.com credential file and operator
state. Replace the job and paths below with your actual values:

```sh
export SCRIBYRA_TEST_STORAGE_STATE=/absolute/private/telemetry-state
export SCRIBYRA_TEST_CI_JOB=17744591691
export SCRIBYRA_TEST_GITLAB_TOKEN_FILE=/absolute/private/gitlab.token
node --test tests/telemetry-ci-storage.test.mjs
```

The token file must be a regular owner-only file, at most 258 bytes including
whitespace. `target/debug/scribyra-telemetry validate-run` must already be built.
Use `SCRIBYRA_TEST_STORAGE_PORT_BASE` for another explicitly started stack. For a
Cloud collector, use its state/port base plus the existing runtime-only
`SCRIBYRA_TEST_GRAFANA_URL` and `SCRIBYRA_TEST_GRAFANA_TOKEN` management settings.
The GitLab credential authenticates only to `gitlab.com`; the management token
only queries the selected private Grafana. No credential belongs in a static
release, JSON report, dashboard variable or GitLab trace.

A successful first pass writes canonical records and receipt/query evidence under
`<state>/ci-job-<job>/`, with owner-only permissions. Preserve that private state.
Then restart the local stack, or stop the verification-only Cloud collector, and
re-query without publication or GitLab access:

```sh
export SCRIBYRA_TEST_CI_READBACK_ONLY=1
node --test tests/telemetry-ci-storage.test.mjs
```

Readback uses original metric observation times and approved-record hashes. It
checks retained records against the prior authenticated artifact snapshot; the
snapshot is not a signature or a new authentication check after expiry. Ordinary
JavaScript suites skip this integration when no operator-selected job/state is
provided.

Do not repeatedly publish the same job as a way to refresh a dashboard. The
bounded ingress deduplication receipt is process-local; replay after its restart
can add another metric observation for the same original run ID. Counters count
received run reports, not unique authenticated jobs. The retained-query mode
avoids republishing.

## Retention and delayed reports

CI config sets artifact access to Maintainer and expiry to one day. In the project
settings, disable **Keep artifacts from most recent successful jobs** so it cannot
override that expiry. The live API verifies `keep_latest_artifact: false` and
actual job `artifacts_expire_at`; this is configuration/metadata evidence, not a
claim that the future expiry worker has already deleted an artifact. Pages has
its own deployment lifetime (`pages.expire_in: never`). Keep repository, Pages
and Grafana access private.

Historical report timestamps are preserved. In filesystem/TSDB single-node Loki,
the ingester store lookback takes precedence over the querier window. Both are
set to 25 hours in `ops/telemetry/loki.yml` to cover the 24-hour report-arrival
policy. Otherwise older accepted CI records can remain invisible until flushed.
The acceptance found this with an actual delayed CI artifact: flushing exposed
it, while configuring only the querier window did not fix new records. Matching
both windows makes newly received older reports queryable without manual flush.
Older queries consult ingesters as well as storage; query parallelism and stream
budgets remain bounded. Time-based retention remains seven days, with separate
volume/quota requirements unchanged.

Managed Loki configuration is provider-owned. Cloud acceptance uses a recent
completed job; it does not prove immediate discovery of every possible delayed
24-hour report in that provider's ingesters.

## Observed evidence

[Safe reports and query receipts](measurements/ci-artifacts.json) record:

- Self-hosted: pipeline `3028249673`, job `17744591691`, revision `08f368e`,
  four actual build/Rust/JavaScript/browser reports, retained after full restart.
- Cloud: pipeline `3029032282`, job `17750895914`, revision `32086ec`, four actual
  suite reports, retained and queried with the collector stopped. Original CI
  execution timestamps and the deployed dashboard log query are checked.
- Both profiles: authorized individual artifact downloads succeed, anonymous
  downloads return 404, and stored metric/log/trace evidence matches the safe
  artifacts. The project remains private and latest-artifact retention is off.

Open the private [CI view](https://telemetry.scribyra.com/d/scribyra-test-runs?var-source=ci&from=now-24h&to=now)
with Source = CI and a time range covering the job. This is an explicit operator
import of real CI artifacts. Continuous direct CI publication still requires the
persistent managed HTTPS ingest host and protected CI ingest file variables;
these verification imports do not configure that deployment.

References: [GitLab artifact API](https://docs.gitlab.com/api/job_artifacts/),
[artifact retention](https://docs.gitlab.com/ci/jobs/job_artifacts/#keep-artifacts-from-most-recent-successful-jobs),
[Loki configuration](https://grafana.com/docs/loki/latest/configure/) and
[querier lookback precedence](https://github.com/grafana/loki/blob/main/pkg/querier/querier.go).

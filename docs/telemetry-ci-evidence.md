# Authenticated CI artifacts in Grafana

This is the record of a check made in November 2026, while the project was on
GitLab. The project has since moved to GitHub, and the check has no GitHub Actions
equivalent: there the suite keeps the same summaries as one-day workflow artifacts
and publishes nothing (see
[continuous CI publication](telemetry-deployment.md#continuous-ci-publication)).

The optional integration check in `tests/telemetry-ci-storage.test.mjs` fetches a
real, terminal job of the archived GitLab project
(`gitlab.com/urundead-labs/scribyra`) and its private JSON artifacts. It does not
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

## Running it today

The archived GitLab project runs no new jobs and its artifacts expired after one
day, so the first pass (authenticated download and publication) can no longer be
repeated. The test is skipped unless `SCRIBYRA_TEST_CI_JOB` and
`SCRIBYRA_TEST_STORAGE_STATE` are set. Only the retained-query mode still works,
against the private state a first pass wrote under `<state>/ci-job-<job>/`:

```sh
export SCRIBYRA_TEST_STORAGE_STATE=/absolute/private/telemetry-state
export SCRIBYRA_TEST_CI_JOB=17744591691
export SCRIBYRA_TEST_CI_READBACK_ONLY=1
node --test tests/telemetry-ci-storage.test.mjs
```

Readback uses original metric observation times and approved-record hashes. It
checks retained records against the prior authenticated artifact snapshot; the
snapshot is not a signature or a new authentication check after expiry. It makes
no GitLab request and publishes nothing.

## Retention and delayed reports

On GitLab, CI limited artifact access to Maintainers with a one-day expiry, and
the check verified `keep_latest_artifact: false` and each job's
`artifacts_expire_at` through the live API. On GitHub the summaries are workflow
artifacts with `retention-days: 1` (`.github/workflows/suite.yml`), readable by
any signed-in GitHub user because the repository is public. Keep Grafana access
private.

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
  artifacts. The project was private at the time and latest-artifact retention
  was off.

Open the private [CI view](https://telemetry.scribyra.com/d/scribyra-test-runs?var-source=ci&from=now-24h&to=now)
with Source = CI and a time range covering the job. This is an explicit operator
import of real CI artifacts from the GitLab period. Continuous direct CI
publication is not configured on GitHub; these verification imports do not
configure it.

References: [GitLab artifact API](https://docs.gitlab.com/api/job_artifacts/),
[artifact retention](https://docs.gitlab.com/ci/jobs/job_artifacts/#keep-artifacts-from-most-recent-successful-jobs),
[Loki configuration](https://grafana.com/docs/loki/latest/configure/) and
[querier lookback precedence](https://github.com/grafana/loki/blob/main/pkg/querier/querier.go).

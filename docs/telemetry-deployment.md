# Persistent private ingestion and CI publication

Official browser collection uses Grafana Cloud Frontend Observability (Faro),
without a self-hosted ingress. The existing optional ingestion host and CI/native
publication runbook below remain prepared locally, **not deployed** by this work.
No private credentials, deployment, push or external collector request was used.

## Official Pages destination

`npm run build:pages` runs `scripts/build-pages.mjs`, selecting the public address
for both the root application shell and the legacy `/app/` shell:

```text
https://faro-collector-prod-eu-central-0.grafana.net/collect/92935ef8d0bc1065ae2621b09f0a6b6e
```

This address is public by design, not an API secret. The configured collector’s
CORS allows exactly `https://app.scribyra.com` and
`https://scribyra-aca39a.gitlab.io`; the reported rate limit is 3000 (provider-side
settings supplied by the architect, not independently queried here). Session replay
is disabled. Localhost/other deployment origins will be rejected by Cloud CORS.
No DNS/HTTPS ingress host is needed for this official browser route. Native/test/CI
publication still uses the existing optional ingress, not Faro.

Every category starts off. The app names “Grafana Cloud, a third-party service”
and links [what is collected](telemetry.md#what-is-sent-to-faro); the presentation
page carries the same privacy wording. Nothing is sent before explicit category
consent. Opening a project dismisses the unanswered card without granting consent;
choices remain in Diagnostics (projects sidebar, or More tools in a project). There is no SDK, replay, console capture, persistent ID, session cookie,
user identity or page URL. Only Rust-validated, consent-filtered JSON goes directly
to the collector. The collector sees connection IP/browser request metadata.
Retention, dashboard access, budget monitoring (see the
[free-plan budget](#grafana-cloud-free-plan-budget)) and the architect’s one-record
consented live ingestion/readback check remain operator responsibilities; none is
claimed by the local fake-collector acceptance.

## Grafana Cloud free-plan budget

The official collector's Grafana Cloud account stays on the **free plan with no
payment method**, permanently. Nothing can be billed: there is no card to charge, and
an upgrade would need the owner to add one. This section sizes telemetry to that plan.

### Free limits

From [grafana.com/pricing](https://grafana.com/pricing/) as read by the owner in
November 2026 (supplied for this work, not re-fetched; no request to Grafana was
made). Recheck the page when acting on these numbers.

| Item | Free plan |
| --- | --- |
| Frontend Observability | 50,000 sessions per month |
| Logs | 50 GB per month |
| Retention | about 14 days |

Grafana's definition: a session is "the time a user spends in a frontend app...
ends after a maximum of 4 hours, or after 15 minutes of inactivity". It almost
certainly counts the `X-Faro-Session-Id` / `meta.session.id` we send; that is not
documented or confirmed. If Grafana also splits one ID after 15 idle minutes, real
counts are higher than below for people who pause often. Only sessions that actually
send a request can count. Scribyra's volume is small against the logs limit: at most
240 requests per tab, typically a few KB each, so even 50,000 sessions at about
150 KB is roughly 7.5 GB.

### Sessions per opted-in person

The session ID is memory-only, so every page load and every tab is a new session.
Until November 9, 2026 it also rotated every hour; it now rotates after four hours,
like Grafana's own cap (privacy trade-off in
[the session ID section](telemetry.md#faro-session-id)). Focus, visibility and tab
switches never rotate it.

`tests/telemetry-session.test.mjs` replays one realistic working day against the
fake collector: a 09:00 sitting reloaded at 10:15 and closed at 12:30, a 40-minute
second tab at 11:00, an afternoon sitting 13:30–17:20 and an evening check
20:00–20:55, compiling about every ten minutes. It counts distinct session IDs on
accepted requests.

| Per opted-in person | One-hour rotation (before) | Four-hour cap (now) |
| --- | --- | --- |
| That day | 11 | 5 (one per page load) |
| Month, 20 such days | about 220 | about 100 |
| Heavy month (about 10 page loads or tabs a day, 20 days) | about 400 | about 200 |

Plan on **100 sessions per opted-in person per month**, and 200 for heavy users.

### Break-even at each sampling rate

Opted-in people a month before 50,000 sessions are reached:
`50,000 / (sessions per person × rate)`.

| `SCRIBYRA_TELEMETRY_SESSION_RATE` | Typical (100/month) | Heavy (200/month) |
| --- | --- | --- |
| `1` (default) | 500 | 250 |
| `0.5` | 1,000 | 500 |
| `0.25` | 2,000 | 1,000 |
| `0.1` | 5,000 | 2,500 |
| `0.01` | 50,000 | 25,000 |

Only people who opted in count. Pick the highest rate whose break-even comfortably
exceeds the expected opted-in users (aim for under 60% of the limit).

### Changing the session sampling rate

The rate is a build setting, so changing it needs no code change, only a new
pipeline:

1. In GitLab, open the project's **Settings → CI/CD → Variables** and add (or edit)
   `SCRIBYRA_TELEMETRY_SESSION_RATE` with one of `1`, `0.5`, `0.25`, `0.1`, `0.01`.
   It is not secret; leave it unmasked. Protect it if only the default branch should
   see it (the deploy job runs only there). Project variables override the `'1'`
   default in `.gitlab-ci.yml`.
2. Run a pipeline on the default branch (**Build → Pipelines → Run pipeline**), or
   wait for the next merge. Any other value fails the `build` step, so a typo cannot
   deploy.
3. Open tabs keep their old rate until they reload or take the update. Records carry
   `sampling_rate`, so dashboards stay correct across the change: divide counts by
   it (for example `sum by (...) (...) / sampling_rate` or per-record `1/sampling_rate`
   weights).

Only the official Pages build reads the CI variable (`scripts/build-pages.mjs`); a
self-hoster with their own `VITE_TELEMETRY_INGEST_URL` may set
`VITE_TELEMETRY_SESSION_RATE` directly, with the same allowed values.

### What to watch, and alerts for the owner to set

Agents cannot reach Grafana; these are for the owner to set up.

- **Usage page.** In the Grafana Cloud portal (grafana.com, the organization's
  usage/billing overview), watch Frontend Observability sessions month to date
  against 50,000, and logs GB against 50. Check it weekly at first.
- **Usage alerts.** Each stack has a `grafanacloud-usage` Prometheus data source
  holding Grafana's own usage metrics. In Explore, pick that data source and search
  metric names for `frontend`, `faro` or `session` to find the session counter
  (names were not verified here). Create Grafana-managed alert rules on it:
  - warning at **25,000** sessions month to date (50%);
  - critical at **40,000** (80%), the point to lower the rate one step;
  - logs ingestion above **25 GB** month to date.
  Route them to the owner's existing contact point. Alerting itself is part of the free
  plan.
- **Daily rate.** A useful leading signal: distinct sessions per day from our own
  records (count distinct values of the session ID field shown on Faro records in
  Explore; field name not verified here). Above about
  1,600 a day, a month will exceed 50,000.
- After any rate change, confirm `sampling_rate` on new records shows the new value.

### When the limit is reached

Grafana does not document what happens to a free account over its Frontend
Observability limit. Most likely further sessions are refused or dropped until the
monthly reset; it may also restrict the account after repeated overage. **Nothing is
billed** either way: there is no payment method. On Scribyra's side, refusals are
handled like any outage: `429` honours `Retry-After`, repeated failures trip the
per-tab breaker and stop sending, and the app keeps working. Data for the rest of the
month is lost. Lowering the rate before 80% is the only lever.

### Retention: 14 days

Only about two weeks of records are kept, so month-over-month trends and anything
older than 14 days disappear. Grafana's usage metrics are kept separately. If longer
trends matter, once every two weeks open the main dashboard for the last 14 days and
use **Inspect → Data → Download CSV** on its aggregate panels (daily counts and
percentiles, never raw records), keeping the files privately. That costs nothing and
needs no extra service. No automated export is set up.

## Self-hosted browser destinations

Ordinary `npm run build` and source-tree development leave
`VITE_TELEMETRY_INGEST_URL` unset: no prompt, gathering or probe. Self-hosters may
explicitly override that variable even when packaging with `build:pages` (an empty
value disables collection), and select one of:

- Their own [Alloy `faro.receiver`](https://grafana.com/docs/alloy/latest/reference/components/faro/faro.receiver/)
  at `https://YOUR-FARO/collect` (or `/collect/ID` behind a proxy): direct Faro JSON.
  Configure exact `cors_allowed_origins`, payload/rate limits, private storage and
  retention. Allow `Content-Type`. Keep `include_metadata`
  false and disable sourcemap downloads (`sourcemaps { download = false }`);
  this client sends no stack frames. The app sends no `X-API-Key`; this route is
  anonymous and must be bounded by the operator. Alloy’s Faro receiver forwards
  to self-hosted Loki/traces; it is not a proxy for Cloud Frontend Observability.
- The existing `https://YOUR-INGRESS/v1/browser-events`: versioned Scribyra batches
  through the Rust privacy ingress and Alloy OTLP pipeline described below.

Example direct Faro build:

```sh
VITE_TELEMETRY_INGEST_URL=https://YOUR-FARO/collect nix develop -c npm run build
```

HTTPS is required except loopback HTTP tests. Both transports reject credentials,
queries/fragments and unsupported paths at build time and runtime. No Cloud token
belongs in `VITE_*`. The card names custom destinations by their exact address.
Faro and the existing ingress share queue, retry, sampling, dropping, timeout and
revocation controls; see the [exact payload fields and bounds](telemetry.md#what-is-sent-to-faro).

## Anonymous browser consent ingestion

The existing self-hosted ingress remains optional; it is unnecessary for the
official Faro build. To activate this alternative:

1. Build `scribyra-telemetry` and start the existing private Alloy/storage stack.
   Set `SCRIBYRA_BROWSER_INGESTION=1` and an explicit comma-separated
   `SCRIBYRA_ALLOWED_ORIGINS` containing exact HTTPS app origins (no paths or
   wildcards). Set `SCRIBYRA_ALLOY_URL` to the internal HTTP Alloy root and keep
   `SCRIBYRA_TELEMETRY_BIND` loopback-only behind the HTTPS reverse proxy.
   For the supplied NixOS module set `services.scribyra-ingestion.browserConsent = true`;
   it supplies the flag and exposes the new route. Default is false.
2. Expose exact `POST`/`OPTIONS /v1/browser-events` over HTTPS, body limit 64 KiB,
   proxy timeout 10 seconds. Keep health/metrics/Alloy/storage private. Existing
   `/v1/events` and `/v1/runs` still require runtime token authentication. A
   browser-only ingress needs no token file; the stack launcher retains its token
   for existing native/test publication.
3. Rebuild the static app with the chosen **public address only**:

   ```sh
   VITE_TELEMETRY_INGEST_URL=https://YOUR-INGRESS/v1/browser-events nix develop -c npm run build
   ```

   HTTPS is required except loopback HTTP for tests. Build validation rejects
   credentials, query/fragment and unsupported paths. The card shows the exact address.
   Do not set a token or Cloud credential in any `VITE_*` variable. Serve this
   build through the normal private release process; this goal deploys nothing.

The new route is disabled unless explicitly enabled. It requires an allowlisted
Origin even for same-origin requests and rejects null/missing/foreign origins,
Authorization and Cookie headers. Anonymous batches permit only application
source and browser/worker runtimes, at most 32 records and 64 KiB. The existing
closed Rust schema checks the whole batch before forwarding: unknown/private
fields, malformed IDs, measurements/timestamps and oversized bodies fail closed.
Global limits are a 16-request burst replenishing at 4/second, eight concurrent
body readers, a two-second body timeout, one active forwarder, two-second bounded
backend requests and 256 replay receipts. There is no unbounded queue. Browser
queues retain at most 128 records/32 KiB, drop after five minutes, retry at most
three times and abort/drop on consent changes. Offline or failed collectors do
not block application work. In-flight bytes already delivered cannot be recalled.

Origin checks constrain browsers; they do not authenticate people. Non-browser
clients can forge Origin, so anonymous telemetry is untrusted and can be poisoned
or exhaust the global budget. Deploy behind operator-managed network/per-IP
limits as needed, without logging payloads or retaining IPs unnecessarily. Browser
and token traffic share the process budget; use separate ingress processes if
availability isolation is required. The server cannot prove UI consent. No hosted
availability, abuse resistance under real traffic, DNS/TLS, NixOS activation or
retention-policy validation is claimed by local tests.

## Host artifacts

[`ingestion.nix`](../ops/telemetry/ingestion.nix) is an opt-in NixOS module for an
already selected host. It runs the existing supervised stack under systemd with
a persistent private state directory, restart on failure, a release-built ingress,
3-GiB memory ceiling and bounded tasks. It exposes only exact `/v1/events` and
`/v1/runs` routes over nginx HTTPS. Health, metrics, Alloy, Grafana and storage
listeners remain loopback-only. The self-hosted profile includes all three
backends and private Grafana; Cloud mode runs ingress/Alloy only. Backend time
retention, queues, retry budgets and the single-writer restriction remain as in
the [operations guide](../ops/telemetry/README.md). Persistent host uptime does
not make telemetry lossless: Alloy's eight-request queues are memory-backed.

Use a root-reviewed checkout at `/srv/scribyra`, pinned to the architect's merged
revision. Build/provision it before enabling the service (no TeX assets needed):

```sh
cd /srv/scribyra
mkdir -p .cache
nix develop --profile .cache/ingestion-dev -c true
nix develop -c cargo build --release -p scribyra-telemetry --locked
nix develop -c python3 scripts/telemetry-tools.py alloy
# Self-hosted profile only:
nix develop -c python3 scripts/telemetry-tools.py prometheus
nix develop -c python3 scripts/telemetry-tools.py loki
nix develop -c python3 scripts/telemetry-tools.py tempo
nix develop -c python3 scripts/telemetry-tools.py grafana
```

The installer verifies the versioned pins and reuses a valid cache. Keep the
checkout/tools readable and immutable to the runtime account; grant that account
access to the Nix daemon. The service uses `nix develop --offline`, so realize the
flake development closure on the host before enabling it. Store state on a volume
with an operator-selected quota; time retention alone does not bound disk use.

Import the module in the host's NixOS configuration and set all required values:

```nix
imports = [ /srv/scribyra/ops/telemetry/ingestion.nix ];
services.scribyra-ingestion = {
  enable = true;
  hostname = "ingest.telemetry.scribyra.com";
  origin = "https://YOUR-PRIVATE-APP-ORIGIN";
  acmeEmail = "YOUR-ACME-OPERATOR-ADDRESS";
  cloud = false; # true only after configuring the runtime Cloud files below
};
```

Create `/etc/scribyra/ingestion.env` as a root-owned 0600 file. It can be empty
for self-hosted storage. Cloud mode sets the endpoint in
[`ingestion.env.example`](../ops/telemetry/ingestion.env.example). Provision
`/etc/scribyra/cloud.username` and `/etc/scribyra/cloud.ingest-token` as root-owned
0600 files; systemd `LoadCredential` creates private runtime copies and the module
binds their paths for Alloy. Do not override those paths in the environment file.
Never place secret values in Nix expressions/the Nix store.
Grafana management credentials belong only to the operator's acceptance process.
The launcher generates the separate ingress-only token at
`/var/lib/scribyra-ingestion/ingress.token` with mode 0600; distribute it privately
to explicitly authorized browser users and the protected CI file variable.
This ingress currently has one shared ingest token, not per-user/CI identities.
Source fields classify activity; authenticated GitLab artifact checks establish
actual CI provenance separately. Decide whether a separate CI ingress/token is
needed before widening access.

After selecting the host flake and installing the DNS A/AAAA records:

```sh
sudo nixos-rebuild build --flake "$HOST_FLAKE"
sudo nixos-rebuild switch --flake "$HOST_FLAKE"
sudo systemctl is-active scribyra-ingestion nginx
curl --fail --silent --show-error --output /dev/null "https://$INGEST_HOST/v1/events" -X OPTIONS -H "Origin: $APP_ORIGIN" -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "https://$INGEST_HOST/metrics")" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "https://$INGEST_HOST/health")" = 404
```

Define `HOST_FLAKE`, `INGEST_HOST` and `APP_ORIGIN` explicitly in the architect's
shell; none is inferred by the app. Verify DNS TXT ownership for the private app
domains separately with [domain operations](pages-domains.md). ACME ingestion
certificates and those Pages domain certificates are independent.

## Continuous CI publication

The existing `.gitlab-ci.yml` already runs `ci-telemetry.py` for build, Rust,
JavaScript and Chromium Pages suites. With both variables present the helper
publishes each closed-schema summary to `/v1/runs`. Without them it saves safe
local artifacts. A failed suite still publishes its summary; later suites after
that failure are not claimed to have run. Unavailable ingestion is best effort
and does not change the suite's exit status. Preserve maintainer-only access,
one-day expiry and the disabled latest-successful-artifact retention override.
Never upload raw stdout, traces, screenshots, tokens or document fixtures.

The architect can create the two **protected, production-scoped** variables with
the following commands. `GITLAB_OPERATOR_CURL_CONFIG` is an operator-owned 0600
curl configuration containing the authentication header; `CI_INGEST_TOKEN_FILE`
is an owner-only copy of the ingress-only token, without a trailing newline.
The commands deliberately discard GitLab's response, which contains variable
values. They create variables once; use GitLab's protected variable editor for
later rotation or an explicit PUT to the individual variable endpoint.

```sh
test -n "$GITLAB_PROJECT_ID" && test -n "$INGEST_HOST"
curl --fail --silent --show-error --config "$GITLAB_OPERATOR_CURL_CONFIG" --request POST --form 'key=SCRIBYRA_CI_INGRESS_ENDPOINT' --form "value=https://$INGEST_HOST/v1/runs" --form 'protected=true' --form 'environment_scope=production' --output /dev/null "https://gitlab.com/api/v4/projects/$GITLAB_PROJECT_ID/variables"
curl --fail --silent --show-error --config "$GITLAB_OPERATOR_CURL_CONFIG" --request POST --form 'key=SCRIBYRA_CI_INGRESS_TOKEN_FILE' --form "value=<$CI_INGEST_TOKEN_FILE" --form 'variable_type=file' --form 'protected=true' --form 'masked=true' --form 'environment_scope=production' --output /dev/null "https://gitlab.com/api/v4/projects/$GITLAB_PROJECT_ID/variables"
curl --fail --silent --show-error --config "$GITLAB_OPERATOR_CURL_CONFIG" --request POST --form "ref=$DEFAULT_BRANCH" --output /dev/null "https://gitlab.com/api/v4/projects/$GITLAB_PROJECT_ID/pipeline"
```

Use the protected default branch after the architect merges; no push/deployment
was performed locally. Confirm that the runner-created file is owner-only (the
publisher rejects broader permissions), all four job summaries report
`delivery: accepted`, and the exact run IDs/revision appear in Grafana. Then run
the authenticated artifact/retained-query check, once for each completed deploy
job, following [CI evidence](telemetry-ci-evidence.md):

```sh
nix develop -c node --test tests/telemetry-ci-storage.test.mjs
SCRIBYRA_TEST_CI_READBACK_ONLY=1 nix develop -c node --test tests/telemetry-ci-storage.test.mjs
```

These commands require explicit `SCRIBYRA_TEST_STORAGE_STATE`, port base,
`SCRIBYRA_TEST_CI_JOB` and private GitLab token-file binding as documented there;
Cloud readback also requires its separate Grafana URL and management binding.
A passing operator import alone does not prove continuous direct publication:
read the CI job's delivery result and query its original IDs before importing.

## Acceptance, restart and upgrades

For self-hosted browser acceptance, tunnel the private Grafana/backend port block
to the operator's machine or run the tests on the host. Use an explicitly built
preview at port 4273 and the host's canonical allowed test origin. Repeat for
Chromium, Firefox and WebKit:

```sh
SCRIBYRA_TEST_PORT=4273 nix develop -c npx playwright test tests/browser/telemetry-storage.spec.js tests/browser/telemetry-failures.spec.js tests/browser/telemetry-native-storage.spec.js --project=chromium
```

For managed acceptance use the separate Cloud bindings and
`telemetry-cloud.spec.js`, then `telemetry-native-storage.spec.js`; actual
DNS/HTTPS, runtime credential loading, service sandbox and public-route rejection
remain unverified until exercised on the selected host. For diagnostic and alert
acceptance see the [operational matrix](telemetry-acceptance.md).

Before upgrade, stop the service and take a consistent private copy of the entire
state volume, including tokens, Grafana SQLite, WALs and backend blocks. Keep the
previous checkout, flake closure and pinned tools. Restore/rollback them together;
do not open newer backend data with an older binary without checking its migration
support. Start the service and rerun historical readback **without republishing**
before submitting new data. Rotate the ingress token by replacing its file
atomically with another owner-only 64-hex token, restart the service, and update
the authorized browser/CI settings. Rotation and restart can lose queued data.

Managed Loki shortcuts still require the architect's datasource-write permission:

```sh
nix develop -c python3 scripts/telemetry-grafana.py --url https://telemetry.scribyra.com --apply --alerts --run-links
```

Supply the existing private management binding only to that process. Notification
delivery, contact points and any change to the managed all-time mute require
the owner's receiver/routing decision; the supplied acceptance sends no messages.

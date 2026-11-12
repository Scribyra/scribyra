# Human-delay and wall-clock experiments (2026-11-05)

## Current wall-clock page

The current `final` variant drives the actual standalone page. B arms first and
waits; A arms later, and the runner copies A’s exact displayed UTC boundary to B.
There is no second Arm click. This explicit time conveyance is required: without
a server, B cannot infer which boundary A chose. Default A lead is 10–40 seconds;
the page also offers 30- and 60-second minimums for walking between laptops.
Missed starts require Start over on both and a fresh exchange.

Run the suites sequentially, without other browser matrices sharing the host.
All scratch stays in this worktree. The wrappers own their namespace processes,
browsers and 5191 servers; they do not use 4173.

```sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/final/acceptance" CONCURRENCY=4 nix develop -c bash docs/reorientation/data/collaboration/scripts/human-delay-acceptance.sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/final/skew" DELAYS=0 SKEWS=0,-1,1,-2,2,-5,5 CONCURRENCY=4 nix develop -c bash docs/reorientation/data/collaboration/scripts/human-delay-acceptance.sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/final/ui" ENGINES=firefox,chromium,webkit nix develop -c bash -c 'ulimit -c 0; source docs/reorientation/data/collaboration/scripts/webkit-env.sh; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay-ui.mjs'
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/final/smoke" PAIRS=firefox-chromium nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs final nomcast 0 false'
SCRATCH="$PWD/tmp/field-clock/final" nix develop -c node docs/reorientation/data/collaboration/scripts/human-delay-record.mjs
nix develop -c node docs/reorientation/data/collaboration/scripts/human-delay-verify.mjs
git diff --check
```

`DELAYS` defaults to `0,30,180` for the wrapper; the standalone runner still
accepts its explicit delay CLI. `CONCURRENCY` bounds contexts per pairing (default
6; use 4 for acceptance). `SKEWS` shifts only B’s JavaScript Date, including
zero-argument constructors and Date.now; performance.now and browser timers stay
real. Positive means B’s clock is ahead, so the physical B-minus-A start gap is
about `1000 - skew*1000` ms. Results retain that derived real gap as well as the
page’s apparent timestamps. Skew failures are outcomes, not harness failures;
missing transfers on connected pairs, JavaScript/RPC errors and zero-skew
failures still exit nonzero. `START_OFFSET` applies only to historical click
variants, never to `final`. Each row uses fresh contexts.

The result collector reads `acceptance/`, `skew/`, `smoke/`, `ui/ui-check.json` and `probes/`
under SCRATCH (run the probe commands below before collecting) and writes `results/wall-clock.json`. It hashes the final page; each
final run and UI row also records its input hash, checked by the verifier. Finish
page edits before running final suites. If `preliminary.json` is present, the collector imports its exploratory summaries; otherwise it preserves the already retained summaries. Historical evidence stays in
`results/human-delay.json`, verified against `field-test-before-wall-clock.html`.

The two rejected five-second-window probes are reproducible with:

```sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/final/probes" PAIRS=firefox-firefox START_OFFSET=16000 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs retry-a open 0 both'
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/final/probes" PAIRS=firefox-firefox START_OFFSET=16000 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs trickle-a open 0 both'
```

`retry-a` reapplies A’s existing remote description every 3 seconds until failure
or connection; `trickle-a` removes end-of-candidates and advertises trickle in
A’s remote answer. Both use the retained previous page, with no changes to ICE
credentials, and neither repaired a 16-second gap (0/4 total).

UI defaults to Firefox and Chromium. `ENGINES=webkit` enables the extra engine.
On this host the default WebKit environment aborted before any page with
`Could not create EGL display: no supported platform available`. An existing
`webkit-env.sh` configures the retained Mesa software renderer; its exact Nix
paths must exist to use it. It adds no software or runtime downloads.

## Historical click-start investigation

The instructions and counts below describe the previous delivery. Use
`click-start` for that retained page; `final` now always means the timed page.
The acceptance wrapper above has been updated to the timed flow.


These scripts drive the actual self-contained field-test page through Playwright,
using separate Linux network namespaces for A and B, an open virtual bridge or
multicast flooding disabled, and no ICE servers. They use port 5191 only. Nothing
is published or installed. Run from the repository flake; the existing Node and
browser assets suffice. The old page is retained as `field-test-before-delay.html`
from commit `105cb0a` so baseline failures remain reproducible.

Set `REPO=<repo>` to this worktree and `SCRATCH=<scratch>` to a writable directory
inside it (or the authorized original lab). Substitute those placeholders in the
commands below. Do not point them at another worktree. Scratch contains disposable
browser profiles and JSON results. The `/proc/<owned-pid>/cwd` indirection keeps
Chromium's socket pathname short. No HOME override is used. The runner owns and
closes its browser drivers and namespace holders; there is no preview server.

```sh
export REPO=<repo> SCRATCH=<scratch>
mkdir -p "$SCRATCH"
cd "$REPO"
nix develop -c bash docs/reorientation/data/collaboration/scripts/human-delay-acceptance.sh
nix develop -c unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs original open
nix develop -c unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs original nomcast 0,30 false
nix develop -c unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay-ui.mjs
```

Disable core dumps with `ulimit -c 0` before running individual commands. The
acceptance wrapper already does so. Each matrix row opens fresh contexts. Up to
12 rows per browser pairing run concurrently, with one sample per condition;
the acceptance wrapper runs eight namespace pairs concurrently. This is a
connectivity experiment, not a latency benchmark. The UI suite uses one namespace
with a dummy interface and raw candidates, testing lifecycle and error handling.

Runner arguments: `variant policy delays rawA`. Defaults: `original open
0,5,15,30,60,180 both`. `rawA` accepts `both`, `true`, `false`. `PAIRS` optionally
selects comma-separated `firefox-firefox,chromium-chromium,firefox-chromium,chromium-firefox`
(A first). `START_OFFSET` is the wait in milliseconds between final clicks:
positive means A first, negative means B first. The final acceptance uses +1000,
not a zero-delay shortcut. The delay argument is the real wall-clock pause after
B's reply becomes available and before the final clicks. Each successful row
must receive and acknowledge exactly 20 MiB. Final matrices exit nonzero on any
connection/transfer/error failure; exploratory variants retain expected failures
in JSON and exit zero if the harness itself completed.

Both browsers use fake capture on A when `rawA=true`. Chromium gets a camera
permission; Firefox additionally sets
`media.peerconnection.ice.obfuscate_host_addresses=false`, because its fake
camera alone still emitted mDNS. This is explicitly a raw-candidate simulation,
not validation of Firefox's real permission behavior. B never gets a camera.
The actual candidate summaries are retained, as are browser versions.

Other retained variants (run with `open 30 both` unless stated):

- `withhold`: remove offer candidates and end-of-candidates before applying it
  on B; tested at `30,180`.
- `trickle`: the same, also explicitly adding media-level `ice-options:trickle`;
  tested Firefox/Firefox only at `30,180`.
- `coordinated`: withhold candidates, then add them to B when A connects.
- `restart`: call B's `restartIce()` just before A applies the existing answer.
- `fresh`: call `createAnswer()` again from the already-stable B; the API rejects
  this, and the rejection is the result, not a harness failure.
- `fresh-remote`: reapply B's original remote offer, then generate and apply a new
  answer immediately before A uses it. Does not repair the expired Firefox case.
- `deferred`: minimal original-page prototype that creates B's answer but defers
  `setLocalDescription` to a final button. Tested Firefox/Firefox, open policy,
  `0,30,180`, both candidate modes. Use `click-start` for the actual delivered page.

`human-delay-pregather.mjs` is an additional rejected probe: gathering a temporary
local offer then rolling it back does not preserve its port (or Chromium ICE
credentials) in a later answer. It runs through `nix develop -c node ...` and
prints the three SDP snapshots; it closes both browsers.

The historical invocation used identical staged scripts under
`<repo>/tmp/field-delay/{run,driver,ui-check}.mjs`. They are retained here with
portable paths. The report and `results/human-delay.json` distinguish baseline,
final acceptance, rejected orders, alternatives, and harness setup mistakes.
No application/Rust/TeX tests or real Firefox 151, Safari, Windows, HTTPS public
origin, Wi-Fi, sleep, or background-tab trials are implied by these checks.

## Recorded validation commands

The final retained-file acceptance and UI commands (run from `<repo>`) were:

```sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-delay/review" nix develop -c bash docs/reorientation/data/collaboration/scripts/human-delay-acceptance.sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-delay/review" nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay-ui.mjs'
nix develop -c node docs/reorientation/data/collaboration/scripts/human-delay-verify.mjs
git diff --check
```

Acceptance: 96 connections and 96 acknowledged transfers, no failures. UI: 28
checks, no failures. The verifier checks those records, the 48 baseline records,
and the final page's SHA-256; it does not run new browser trials. Application
builds, `npm test`, WASM, WebKit and CI Pages were outside this docs-only scope.

The staged investigation used these exact commands; the portable runner above
has the same CLI and variants:

```sh
nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs original open'
PAIRS=chromium-firefox nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs original open'
nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs withhold open 30,180 both'
PAIRS=firefox-firefox nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs trickle open 30,180 both'
nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs coordinated open 30 both'
nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs restart open 30 both'
nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs fresh open 30 both'
nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs fresh-remote open 30 both'
PAIRS=firefox-firefox nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs deferred open 0,30,180 both'
nix develop -c node tmp/field-delay/pregather.mjs
nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs original nomcast 0,30 false'
START_OFFSET=2000 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs click-start open 30 both'
START_OFFSET=-2000 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs click-start open 30 both'
START_OFFSET=-2000 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/run.mjs click-start nomcast 30 both'
nix develop -c bash tmp/field-delay/acceptance.sh
nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node tmp/field-delay/ui-check.mjs'
REPO="$PWD" SCRATCH="$PWD/tmp/field-delay/portable" PAIRS=firefox-chromium START_OFFSET=1000 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs click-start nomcast 15 false'
```

The original open baseline's first batch stopped after 36 completed rows because
of the shutdown race; the selected Chromium→Firefox command supplies the other
12. Together they give 42 passes and 6 browser failures. The alternative counts
and rejected-order counts are in the report and JSON. `acceptance.sh` was run
first with B first by 1 ms (90/96, rejected) and then A first by 1,000 ms (96/96).
The final retained wrapper repeats the latter after the page-open timestamp fix.
The portable smoke gives 1/1. Initial faulty coordinated/fresh evals (8 errors
each), an interrupted fake-camera calibration, and the no-interface UI setup
(two timeouts) are explicitly excluded from acceptance, with their reasons in
`harnessIssues`. Earlier complete/partial zero-gap matrices are summarized under
`preliminaryRuns`; the final acceptance does not select only their passing cells.

## Follow-up investigation commands and failed checks

Before freezing the page, these exact wrapper commands were run. They are
exploration, not final acceptance; page text/diagnostics changed during them.

```sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/smoke" PAIRS=firefox-firefox nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs final open 0 both'
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/probes" PAIRS=firefox-firefox START_OFFSET=16000 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs retry-a open 0 both'
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/probes" PAIRS=firefox-firefox START_OFFSET=16000 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay.mjs trickle-a open 0 both'
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/acceptance" nix develop -c bash docs/reorientation/data/collaboration/scripts/human-delay-acceptance.sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/skew-probe" DELAYS=0 SKEWS=0,-1,1,-2,2,-5,5 nix develop -c bash docs/reorientation/data/collaboration/scripts/human-delay-acceptance.sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/skew-measure" DELAYS=0 SKEWS=0,-1,1,-2,2,-5,5 CONCURRENCY=4 nix develop -c bash docs/reorientation/data/collaboration/scripts/human-delay-acceptance.sh
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/ui" nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay-ui.mjs'
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/webkit-probe" ENGINES=webkit DEBUG=pw:browser WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay-ui.mjs'
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/webkit-software" ENGINES=webkit DEBUG=pw:browser LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 nix develop -c bash -c 'ulimit -c 0; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay-ui.mjs'
REPO="$PWD" SCRATCH="$PWD/tmp/field-clock/webkit-mesa" ENGINES=webkit nix develop -c bash -c 'ulimit -c 0; source docs/reorientation/data/collaboration/scripts/webkit-env.sh; exec unshare -Urn --kill-child node docs/reorientation/data/collaboration/scripts/human-delay-ui.mjs'
nix develop -c node --check tmp/field-clock/page-check.js
nix develop -c node --check docs/reorientation/data/collaboration/scripts/human-delay.mjs
```

| Run | Observed result |
| --- | --- |
| Firefox-only timed smoke | 2/2 connections and 20 MiB acknowledgments |
| Two A-window probes | Each 0/2 connections; expected rejected alternatives, no harness errors |
| First delayed matrix | 48/48 connections, 46/48 acknowledgments; wrapper exit 1 |
| Overlapping skew sweep | 99/112 connections, 30/112 acknowledgments; wrapper exit 7 |
| Isolated four-context skew exploration | 99/112 connections, all 99 acknowledgments; eight batches complete, no harness errors |
| Initial UI | Firefox 29/29, Chromium 29/29; WebKit fails before its first check |
| Two WebKit environment retries | Each fails before its first check, `Could not create EGL display: no supported platform available. Aborting...` |
| Existing Mesa environment | WebKit 32/32 checks |
| Syntax checks | Both pass; `page-check.js` was the extracted inline page script |

The first delayed and skew suites overlapped. Connected rows lacking their
acknowledgment at 30 seconds remain failures, not successful transfer evidence.
The isolated rerun resolved those transfer cutoffs without changing the 30-second
observation or the page's 15-second stall limit. Exploratory totals and failed-row
summaries are retained in `wall-clock.json.preliminary`; original full scratch
JSON stays local and is disposable. Final suites use the frozen page hash and
run sequentially. Existing UI expectations were updated from click-time fields
to arm/scheduled/apply-time fields; all original lifecycle and transfer checks
remain, with additional schedule, clock, joint-diagnosis and file-origin checks.

The first frozen candidate-page matrix additionally passed 48/48 connections and
transfers. Review corrected joint diagnosis wording for an unstarted local peer;
the complete matrix was repeated on the corrected page, also 48/48. Its final
skew run gives 98/112 connections and all 98 acknowledgments, with 14 connection
failures and no harness errors; see the addendum's signed skew table.

The first expanded final UI attempt passed 33 Firefox checks and six Chromium
checks before failing two new harness assertions; WebKit passed all 35. Firefox
file navigation emits no Playwright `request` event (a separate trace recorded
`requests: []` while the version-3 page loaded). The no-extra-resources check now
rejects every observed URL other than the file itself, without assuming an event
for the navigation. Chromium's typed-address check now waits for asynchronous
`addIceCandidate` completion before asserting the resulting state. Both checks
remain in the suite. The page did not change for these harness corrections.
The trace command was:

```sh
nix develop -c bash -c 'ulimit -c 0; exec node tmp/field-clock/file-requests.mjs'
```

That disposable script launched Firefox with its profile under an owned scratch
holder, observed requests while navigating to the local file, printed its URL
and `R.version`, and closed the browser and holder. Its measured result is in the
preliminary record; it is not needed for rerunning acceptance.

The pair runner also explicitly waits for typed-address completion before arming.
Every retained final matrix row already records completion before Arm; an
additional Firefox→Chromium, no-camera, multicast-blocked smoke exercises this
explicit driver wait on the same final page. This changes neither the page nor
the connection/transfer observation limits.

Final retained-file results: **48/48** delayed connections and transfers;
**98/112** skew connections with all 98 transfers (14 connection failures,
zero harness errors); **105/105** UI checks, 35 per engine; **1/1** typed-wait
smoke; verifier **pass** for current and historical records and page hashes.
`git diff --check` passes. The 5/15/60-second delays were not repeated on this
page; real Firefox 151, radios, HTTPS-origin permissions, actual camera behavior,
Safari/macOS/Windows and sleep/resume connectivity remain outside this run.
No application build, `npm test`, WASM or frozen-component suite was run for this
standalone docs-only change.

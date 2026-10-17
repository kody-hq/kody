# Cache and latency follow-up

Preserve `/tmp/kody-start-query` as the pre-optimization Query build. Its source
manifest is `047036b630248158fc9e2988592671969f1e4e3e2473561efab05ace83ed404d`.
All 4,435 source files still match it. Its dependencies are independent copies,
not links to the changing workspace. Capture the new candidate only after its
app source and tests are ready. Never rebuild or install into the preserved
Query snapshot.

Keep the existing three rotating short rounds and 30-minute session settings for
continuity. Run the separate `cache-navigation-probe.mjs` to explain cache
behavior under zero and 100 ms minimum request-to-response-header latency.
Chrome's CDP latency rule is not a full remote-network or mobile simulation. All
builds use the same rule and no throughput or CPU throttling. No other browser,
build or test work runs during timed samples.

The new probe requires explicit data markers for every route. Do not use only a
heading to claim refreshed data. A marker specifies `selector`, exact `text`,
and optionally `attribute`. Use non-sensitive seeded fixture content. A
`freshMarker` can separately identify a changed server value. Without one,
`freshMarkerMs` stays null and the run makes no fresh-data-presentation claim.

Each target supplies `label`, local `origin`, and snapshot `root`. Use
`framework: "remix"` for the baseline. The compiled Start resolver maps RPC IDs
to function names, including shell identity verification as a distinct request.
Unknown observed server functions fail the probe instead of becoming zero reads.
JSON requests keep their endpoint path. No query strings, request headers,
cookies or response bodies are retained.

Use an A to B to A sequence with no hover. Include these separately named cases:

1. First route entry after hydration.
2. Immediate revisit while fresh.
3. Revisit after the old build's expiry.
4. Revisit after the new build's actual expiry.
5. The same steps under 100 ms minimum latency.

Do not label the same elapsed wait “stale” for two builds with different TTLs.
Record the configured policy and wait duration. The optimized published policy
is 300 seconds with 30-minute retention. Settings use 60 seconds, live
jobs/workflows/activity/email/waiting use 10 seconds, and remaining pages use 30
seconds. Shell data uses 60 seconds with five-minute retention. Private
foreground navigation still verifies identity on every visit. Public marketing,
docs and blog navigation does not make that identity request. Waits use
`waitBeforeMs`; every latency/round/target gets a fresh browser context. Initial
hydration is excluded from these navigation metrics and remains covered by the
existing cold-load harness.

## Held-response proof

For a deterministic cache proof, add `barrier` to a warm or stale revisit:

```json
{
	"functionNames": ["loadShell_createServerFn_handler"],
	"paths": [],
	"observeMs": 1000
}
```

Use the actual compiled names for the implementation under test, including the
separate identity read where applicable. The probe fetches only named GET reads,
holds their responses, samples whether the expected cached data marker is
already visible, then releases them. It records which responses were ready and
still held at that observation. No automatic reload or synthetic app data is
injected. No held request means inconclusive and a failing probe, not a cache
pass. If a fresh cache makes no leaf request, hold the always-fresh shell or
identity read instead, and record the leaf count as zero.

These intercepted steps are diagnostics, separate from uninterrupted latency
samples. A marker visible while an actual response remains held demonstrates
rendering independent of that response. It does not establish refreshed data
until a distinct fresh marker appears after release.

Completed resource timing and marker observations share the document's
performance clock. Record request start, first response byte, response end, and
first cached/fresh marker frame independently. This avoids the epoch/performance
clock alignment problem found in earlier long-session POST timing. Resource
timing omits failed/aborted transfers; separate CDP request records retain those
failures and completed-byte accounting. Marker readiness still observes DOM and
styles, not physical pixel presentation.

## Mutations and lifecycle

Set `authenticated: true` and `accountCheckpoint: true` to append the existing
real profile and retention mutation checkpoint. It records primary-tab
dependency requests around mutation, focus and reconnect refreshes, uses a
second tab as the external editor, and verifies original fixture restoration.
The editor and API-confirmation traffic remain outside primary-tab transfer
counts. The primary tab alone receives the configured network rule.

The checkpoint retains the original feedback/completion fields for comparison,
including their documented cross-clock POST limitation. New resource timings
after the retention click use the browser clock and do not infer HTTP method
from resource names. Use the separate CDP request log for GET/POST counts.
Separate identity and delayed-response tests remain mandatory, cache timing does
not prove authentication isolation.

Before use, run syntax/lint checks, then one untimed local smoke against each
snapshot. The new probe has not yet been browser-verified. No build or timed run
is authorized until the parent task releases the shared measurement window.

## Prepared run sequence

Configs are in `configs/query-optimization-*.json`. They identify Remix on 4177,
the preserved Query build on 4178, and the optimized candidate on 4191. The last
snapshot is pending. Resolve its source hash into a new run config after the
source freeze, never silently substitute the changing workspace.

After release, capture an independent optimized snapshot, prepare its production
fleet, migrate all databases and run the existing isolated readiness and
identity checks. Run the new probes once as untimed smoke tests before relying
on them. Build timing uses separate disposable copies so the preserved
comparator build and its dependencies do not change. Collect source-map
attribution and full raw/gzip bundle inventory separately from observed cold
script/document transfers.

With `H=tools/framework-comparison` and a new output prefix `OUT`, run
sequentially:

```sh
node "$H/session-measurement.mjs" "$H/configs/query-optimization-short.json" "$OUT-short"
node "$H/cache-navigation-probe.mjs" "$H/configs/query-optimization-warm-public.json" "$OUT-warm-public"
node "$H/cache-navigation-probe.mjs" "$H/configs/query-optimization-warm-private.json" "$OUT-warm-private"
node "$H/cache-navigation-probe.mjs" "$H/configs/query-optimization-cache-account.json" "$OUT-account"
node "$H/cache-navigation-probe.mjs" "$H/configs/query-optimization-cache-leaf-barrier.json" "$OUT-leaf-barrier"
node "$H/cache-navigation-probe.mjs" "$H/configs/query-optimization-cache-identity-barrier.json" "$OUT-identity-barrier"
node "$H/cache-navigation-probe.mjs" "$H/configs/query-optimization-cache-published.json" "$OUT-published"
node "$H/lighthouse-targets.mjs" "$H/configs/query-optimization-lighthouse.json" "$OUT-lighthouse"
node "$H/session-measurement.mjs" "$H/configs/query-optimization-long.json" "$OUT-long"
```

The published probe waits 31 seconds, revisits, then waits another 301 seconds
for each target at both latency settings. It does not advance browser clocks.
That phase takes about 35 minutes. The short sessions take about 14 minutes,
private expiry/barrier probes about 15 minutes, 90 Lighthouse audits about 20
minutes, and the long session about 31 minutes. Setup, builds and checks can
bring the complete sequence to roughly two hours. All phases are sequential.

Profile barrier fixtures write a distinct seeded display name before hydration,
then change it through the local API while away. The marker reads the actual
input `value` property. Old and new values have separate frame observations, and
cleanup restores the original profile even after a failed probe. Private
identity barriers intentionally may prevent cached content from appearing until
verification completes, that is a security requirement, not a performance
failure.

History-driven query steps must be labeled separately from anchor clicks. An
unchanged marker is not evidence of query-navigation latency. Request counts
remain useful. Report identity, shell and leaf reads separately, plus mutation
GET/POST dependencies. Cold means a fresh browser context/cache, not a cold
Worker isolate. Incomplete canceled transfers are not zero-byte network work.

The two warm-revisit configs run five rounds for all three targets at both
latency settings, without expiry waits. Public blog/docs and authenticated
jobs/account each have explicit first-entry and warm-revisit labels. Private
runs start on Memories so both measured routes are first entries before their
revisits. These provide repeated latency samples. The one-round real-expiry and
held-response runs are causal diagnostics, not statistical performance
estimates. Expect several additional minutes for the warm series.

# Local three-way follow-up

Compare the immutable Remix snapshot at `/tmp/kody-framework-baseline`, the
current Start snapshot at `/tmp/kody-start-before-confidence`, and the final
improved snapshot at `/tmp/kody-start-after-confidence-identity`. The current
Start snapshot contains a SHA256 manifest, lockfile, maintained patches,
independent dependencies, and preserved build artifacts. Its local test-binding
production rebuild serves port 4175. Keep source snapshots unchanged after
capture.

Use matching local test bindings and seeded data. Build all targets in
production mode, then stop builds, test suites and other browser work during
timed samples. Local delivery does not reproduce Cloudflare compression, edge
cache or remote latency. Do not reactivate the disabled Access token.

`session-measurement.mjs` accepts a JSON config and a new output directory. It
only permits localhost targets and refuses to overwrite output. Rotate target
order across rounds. A short smoke proves the harness works before starting long
runs.

Example configuration:

```json
{
	"targets": [
		{ "label": "remix", "origin": "http://127.0.0.1:4177" },
		{ "label": "start-current", "origin": "http://127.0.0.1:4175" },
		{ "label": "start-improved", "origin": "http://127.0.0.1:4176" }
	],
	"rounds": 3,
	"coldObservationMs": 30000,
	"sessionMs": 180000,
	"hoverMs": 500,
	"dwellMs": 10000,
	"historyEvery": 4,
	"raceEvery": 6,
	"raceSettleMs": 1500,
	"routes": [
		{ "path": "/pricing", "heading": "Start free." },
		{ "path": "/docs", "heading": "What is Kody?" },
		{ "path": "/", "heading": "You shouldn’t have to start over" }
	]
}
```

Run with Node 26:

```sh
node tools/framework-comparison/session-measurement.mjs /tmp/comparison-config.json /tmp/comparison-output
```

For a 30-minute session per target, set `sessionMs` to 1800000 and `rounds`
to 1. Three targets require at least 90 minutes sequentially. With the
authenticated configuration below, this is a paced public/account workload with
real local profile and retention mutations, not a simulated month of usage.
Broader permissions and cancellation coverage still relies on the application
regression suite. Optional `storageState` per target accepts a private local
Playwright state file; that path and its contents are excluded from report
config.

Cold means a fresh anonymous browser context and cache, not a guaranteed cold
Worker isolate or Cloudflare cold start. Authenticated readiness checks use a
separate browser that closes before timing and can warm the local Worker.

The cold-entry window includes background preloading for the full 30 seconds,
even after the initial page looks ready. Requests are grouped by phase and
capture CDP encoded bytes, cache flags, type and completion time. Unfinished and
failed requests remain visible. Encoded-byte totals use completed
loadingFinished events; canceled requests remain counted, but their partial
transfer bytes are not included. URLs retain origin and pathname only, no query
strings, headers or cookies.

Navigation reports nearest-rank p50/p95/p99 for click-to-DOM-ready and
click-to-visible-ready. The latter waits for heading geometry and ancestor
opacity, but does not measure actual pixel presentation. Hover prefetch uses the
same 500ms dwell for each target. History and rapid competing-link checks have
separate phases and do not enter normal navigation percentiles. A full document
reload is a failure, not a fast navigation sample.

Primary-page renderer heap, DOM-node, document and event-listener counts are
sampled throughout the session. They do not measure total browser/OS memory or
the separate editor tab. Active and idle samples use natural collection.
Optional final forced collection is recorded under a separate `forced-final-gc`
phase. Compare steady-state slopes and final plateaus, not just first and last
heap values. Rising natural heap can reflect pending garbage collection, so it
is evidence to investigate, not proof of a leak.

Keep the existing pinned Lighthouse direct-load and flow protocols separate. Do
not pool local results with private edge reports, or pool diagnostic race phases
with ordinary navigation latency.

Normal navigation also records any MutationObserver checkpoint without a
nonempty main heading. Such gaps and full document reloads fail the run, while
all raw evidence is retained. Per-phase traffic totals report unfinished
requests rather than silently treating them as zero-byte completed work.

## Authenticated segment

Set `accountStartMs` to 300000 and `sessionMs` to 1800000 for five minutes of
public browsing followed by 19 minutes of account activity and six idle minutes.
Add `accountRoutes` containing `/account`, `/account/jobs`, and
`/account/memories`, with headings `Account`, `Jobs`, and `Memories`.
`accountCheckEvery` defaults to 12 normal navigation steps.

Apply the repository local migrations and standard seed independently to each
preview's local persistence directory. This includes APP_DB and AUDIT_DB from
the origin config and JOBS_DB from the jobs config. The preparation helper
resolves migrations directories before relocating configs. Before any timing,
the runner checks login, Jobs JSON200 with an array payload, Jobs document200,
the expected heading and the hydrated marker, each in a separate
browser/context. It records prerequisite console errors and refuses to begin
timing if a required check fails. The default credentials are the documented
local Jane fixture. An optional private `SESSION_AUTH_FILE` maps each local
origin to credentials, which are never copied into results. Do not use
production accounts or reactivate Access.

Account checkpoints save through the real profile form, confirm the persisted
value, trigger the same explicit focus/online events used by the application's
browser tests, and check that a different unsaved draft survives the returned
refresh. Browser automation does not naturally emit all tab activation events,
so these lifecycle events are explicit. Missing baseline freshness is recorded
while the session continues. Original profile data is restored and reread at
cleanup.

The jobs page is visited and searched, and the actual jobs API status/count is
recorded. An empty seeded jobs list is a stated workload limitation, not
evidence of populated schedule or execution coverage. No jobs are scheduled to
execute external work. CDP request bytes cover the primary browsing tab;
editor-tab mutations and API confirmations are separately validated and are not
represented as complete browser transfer totals. Public and account navigation
percentiles remain separate.

For the 30-minute retention workload, set `idleMs` to 360000 and `finalForcedGc`
to true. The active loop ends at 24 minutes. The harness then samples six idle
minutes, performs one final navigation to trigger activity-driven cache cleanup,
and optionally records a forced-GC sample separately. Do not interpret the final
forced-GC point as natural steady-state memory.

Retention mutations record separate click-to-disabled DOM feedback, first frame
with disabled feedback, POST response headers, completed accepted response,
first frame with success status, and persisted API confirmation. A missing
pending frame remains null, it is not inferred from a fast response. Normal
navigation timestamps are captured inside browser animation frames, so
Playwright IPC waiting does not become part of the latency metric.

The current POST-response timing fields convert Playwright epoch timestamps to
the browser performance clock. Long Query-session evidence showed inconsistent
ordering in some later samples, so treat those cross-clock values as diagnostic,
not precise causal ordering against DOM or API-confirmation times. Pending,
success and persisted-confirmation observations use the same browser clock. Keep
the raw values and this limitation visible when reproducing the protocol.

Production fleets use `prepare-local-production.mjs` and
`serve-local-production.mjs` to attach real jobs/highlight workers to built
origin artifacts under unique local names. Plain Vite preview omits those
dev-only dependencies and is insufficient for the account/jobs session. The
wrappers never deploy, use isolated persistence and local-only bindings, and
retain private environment files outside reports.

A process lock prevents duplicate session runners. Signals request a stop after
the active target completes and restores its fixtures, they do not interrupt
mutations. Public/account operation counts differ when a framework lacks
freshness and waits for the probe timeout. Do not treat counts as throughput or
compare aggregate traffic/memory without completed-work context.

# Performance comparisons

Compare Kody's Remix app, the shipped Start migration and a pinned main
revision. This is an application comparison, with different content and features
over time, so it does not isolate the cost of Start, Query or Redact.

Use Node 26 and Chrome. Keep builds, tests and other browser work separate from
timed runs. Each source snapshot installs its own lockfile. The default
revisions are in [revisions.json](./revisions.json); edit the main SHA for a new
comparison and preserve that file with the results. The shipped revision is the
merge of PR #3561, rather than its first experimental commit.

```sh
npm run perf:prepare -- /tmp/kody-comparison
npm run perf:builds -- /tmp/kody-comparison/targets.json /tmp/kody-build-results
npm run perf:local -- /tmp/kody-comparison/targets.json /tmp/kody-browser-results private browser lighthouse-targets
npm run perf:local -- /tmp/kody-comparison/targets.json /tmp/kody-correctness-results freshness
node tools/framework-comparison/attribute.mjs /tmp/kody-build-results/targets.json /tmp/kody-attribution.json
node tools/framework-comparison/summarize-lighthouse.mjs /tmp/kody-browser-results/lighthouse-targets
npm run perf:check -- /tmp/kody-browser-results/browser/runs.json /tmp/kody-build-results/inventory/inventory.json main
node tools/framework-comparison/startup.mjs /tmp/kody-comparison/targets.json /tmp/kody-startup-results
```

Use new output directories. Finish the build matrix before starting servers,
because Vite replaces files that Wrangler watches. The runner owns the servers,
checks readiness, uses distinct inspector ports and stops them when it finishes.
Its artifact fingerprints reject builds changed during a measurement. Do not run
these mutating fixture checks against production. The runner accepts loopback
origins only and uses the disposable seeded Jane account.

The public scenarios use five rotating rounds at both zero and 100 ms added
request latency. They measure a click to a visible destination marker on an
animation frame, without hover preloading. Network idle is outside that clock.
They retain page errors, failed requests, document reloads and resource sizes.
DOM/style readiness is not completed physical painting.

Lighthouse uses pinned version 13.5.0, fresh Chrome processes, five rotating
samples for home, pricing and docs on mobile and desktop. Raw JSON/HTML reports,
warnings and failures stay in the output. These are local optimized builds, not
Cloudflare edge results. Fresh browsers do not mean cold Workers.

The profile probe holds a save, navigates to a cached public profile, then
accepts or rejects the write. It checks optimistic presentation, reconciliation
after unmount and authoritative state from another page, then restores the seed.
It uses each revision's UI rather than removed profile JSON endpoints. Held
writes and injected errors provide correctness evidence, not latency samples.

Build results report the first round separately from five warm rounds. Gzip
inventories compress each emitted JS/CSS file independently and include every
lazy route. They do not measure what a page downloads. Source attribution uses
generated UTF-8 source-map spans and keeps unmapped bytes explicit; it cannot
assign compressed bytes to individual source modules.

Keep raw results outside temporary storage when publishing a comparison. Include
the revision file, lockfile hashes, artifact fingerprints, harness versions,
Chrome version, per-sample results and failures. Use medians and ranges. Keep
Worker startup CPU, request latency, Lighthouse and controlled correctness
experiments separate.

## Recovered migration evidence

[Historical manifest](./historical/manifest.json) records literal report
snapshots recovered from the archived migration chat's local event log. They
describe different experimental candidates. Their original Lighthouse traces,
full request logs and inventories were not recovered from the deleted checkout.
Some drafts explicitly say not to switch production yet. Do not treat them as
final shipped-migration measurements or pool their samples with new runs.

`npm run validate` remains the authoritative local gate. The navigation codec
bundle test prevents server/editor schemas from returning to the eager URL codec
graph. Run the browser comparison when changing route loading, caching, shared
UI or dependencies, because build size alone cannot establish the user cost.

Pinned source SHAs are set on each local origin and checked through control-kody
before measurement. This enables the app's production immutable-asset cache
headers. The startup command builds each real slim production entry and profiles
all targets with the same Wrangler version. Run it after browser measurements,
because it replaces each checkout's build output. Startup CPU is separate from
request TTFB and does not predict global edge cold starts.

The private scenario opens the seeded public profile from Account and returns
with browser Back. Its markers identify actual destination data. The byte
budgets check observed initial JavaScript and loaded CSS, rather than all lazy
assets.

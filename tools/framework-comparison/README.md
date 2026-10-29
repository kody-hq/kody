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

The [October 28 audit](../../docs/contributing/performance/2026-10-28/README.md)
includes recovered migration drafts, four pinned revisions, per-sample evidence,
fixes and the remaining cold-load and validation gaps.

For browser verification alongside another checkout, set `KODY_E2E_PORT` to a
free port when running `npm run test:e2e:run`. This changes both the isolated
server and Playwright base URL, without reusing another checkout.

The page-byte check counts native inlined stylesheet bytes as well as external
CSS, so moving CSS into the document cannot make its cost disappear. Browser
results also retain encoded/decoded document sizes, observed paint and hydration
times, and console error counts. Observed local paint is separate from simulated
Lighthouse metrics.

Use `release` to verify the fixed Start build with its real asset namespace
before rebuilding the timing matrix. Set `SOURCE_SHA` to the frozen application
SHA and use a one-target config with that same `commit`, the checkout root,
`serverDirectory: "server"` and a free loopback origin:

```sh
KODY_START_RELEASE=$SOURCE_SHA CLOUDFLARE_ENV=test KODY_WRANGLER_CONFIG=packages/worker/wrangler-local-dev.generated.json npm run build
node tools/framework-comparison/run-local.mjs release-matrix.json NEW_RELEASE_OUTPUT release
```

The release check verifies the health SHA through control-kody, three hydrated
public pages, CSP nonces, native inline CSS, and versioned scripts and fonts. It
accepts normal 200 and cached 304 font responses. The runner owns server startup
and cleanup and verifies that build files did not change during the check. This
is a local release check, without a deploy.

Pure type imports in browser code must use `import type`. With
`verbatimModuleSyntax`, `import { type T } from './module'` can leave an empty
runtime import that still evaluates the module. The browser lint rule rejects
that form, and the shared inline-only style preference is disabled. Mixed
imports that also use runtime values can keep inline type specifiers. The
regression test runs the actual auto-fixer twice and checks the emitted
JavaScript, so a commit hook cannot silently restore the runtime dependency.

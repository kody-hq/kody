# Mobile and docs follow-up

Desktop docs LCP improves to 1,351 ms from pinned main's 2,112 ms, and from
2,256 ms in the previous fix. Initial homepage JavaScript falls to 240,021
encoded bytes, 14.7% below main and 6.5% below the previous fix. Homepage
hydration at 100 ms added request latency improves to 1,395 ms from main's 1,934
ms and the previous fix's 1,600 ms.

**The mobile gap remains open.** Fixed mobile pricing is 2,868 ms versus Remix's
2,572 ms. Docs is 3,013 ms versus 2,727 ms, essentially unchanged from main.
Fixed home improves to 3,614 ms from main's 4,066 ms, but Remix's new home
median moved to 5,426 ms from the earlier 3,166 ms, four of its five new samples
fall in the slower cluster. The source and client inventory are unchanged. These
separate series do not establish home parity or isolate the cause of that
control variation.

See [all four-way results and ranges](./RESULTS.md),
[Lighthouse scores](./LIGHTHOUSE.md), and the
[previous fixed-source report](../RESULTS.md). Every final sample is retained,
earlier pilots are excluded.

Measured application source: `8187ad43c8f6f0f761bf59d9b4e2d0a1202ef92d`. Remix,
shipped migration and audit-start main stay pinned to the same three revisions
as the previous comparison. This compares complete applications, it does not
isolate framework or renderer overhead.

## Root causes fixed

The docs sidebar explicitly preloaded every rendered navigation link. Opening
docs triggered 59 server-function requests before any navigation. Sidebar, list
and pager links now preload on intent. A production browser test checks zero
startup data requests, then checks hover preloading and navigation.

The desktop docs LCP element is its video poster. The thumbnail handler waited
for remote playlist discovery even when the video ID was already in the bundled
allowlist. It now checks that allowlist first. Unknown IDs still require the
full allowlist, and unsupported IDs still fail. The handler test checks every
outbound fetch for the known sample, so an unrelated playlist fetch cannot hide
behind a filtered assertion.

The homepage preloaded a 37,128-byte mascot image that its current layout never
renders. That preload is removed. Signed-in account controls load only for
signed-in sessions, and the root loader preloads them before server rendering. A
no-JavaScript browser check verifies that this does not hide account controls in
streamed fallback content.

Head formatting uses a small contract rather than importing the whole metadata
catalog. Static route metadata stays synchronous. Making all metadata lazy added
a round trip to first navigation, so that experiment was rejected. Metadata
tests preserve all 15 homepage variants.

A lint auto-fixer was rewriting standalone type imports into inline-only type
specifiers. With verbatim module syntax, that form can leave runtime imports of
unrelated modules. The browser lint policy now rejects all-type inline
declarations and allows standalone import type. Pure type clauses across browser
code were normalized, mixed value/type imports were kept. The regression test
runs the actual auto-fixer twice and then transpiles the result. Production
bundle tests check the resulting metadata and loader-data boundaries.

Router now emits the loader and component for each matched route together.
Normal client-only compiler grouping puts Redact and the Router runtime together
without recursively pulling application dependencies. Optional Query modules
keep normal splitting. The existing shared root stylesheet is emitted once and
natively inlined, so dynamic route imports cannot add an external duplicate
stylesheet. No custom preloader, priority override or delayed hydration is used.

## Evidence and limits

The final matrix contains 24 successful builds, 120 Lighthouse audits without
runtime failures, 40 public and 40 signed-in runs covering 200 transitions, 24
accepted/rejected save cases, and three startup CPU samples per source. Both
browser series have zero page errors, console errors and failed requests. Every
save case persisted correctly and restored the seed. Start reconciles after
leaving the form in all cases, Remix's three accepted-save cases still show
stale cached profile data. All four artifact fingerprints match before and after
the run.

Fixed first-profile navigation at 100 ms added request latency improves to 242
ms versus main's 446 ms, but remains slower than Remix's 135 ms. First pricing
navigation is 129 ms versus main's 128 ms. Cached pricing is 25 ms versus main's
15 ms. These values measure visible destination markers, not completed physical
painting.

The homepage still loads 65 JavaScript files versus Remix's 25 and transfers
64.5% more initial JavaScript. Total emitted client assets remain roughly twice
Remix's raw bytes, and warm builds remain much slower. The unchanged application
byte guard passes with 240,021 encoded JS bytes and 122,828 native inline plus
external CSS bytes. The separate total-style metric includes Emotion. Remix's
zero in the Start-native CSS row means no Start marker, its actual inline styles
are counted in the total-style row.

Startup median active CPU is 23.7 ms for fixed and pinned main, versus Remix's
41.3 ms. The current origin/platform/runtime CPU guard passes at 22.3/67.3/41.2
ms best-of-three against 280/340/160 ms budgets. The bundle-size check completes
with existing warning-only platform and runtime overages, 6,422,728 / 5,244,000
bytes and 4,982,043 / 3,793,500 bytes. Origin is 768,990 / 7,750,000 bytes.
Those backend size overages are not fixed here.

The normal production asset namespace was checked with the frozen source SHA,
including three hydrated pages, versioned scripts and fonts, nonce-protected
scripts and one inline stylesheet. The four-way runner checks each origin's
health SHA and rejects artifact changes during measurement.

Public and signed-in navigation use fresh contexts at zero and 100 ms added
request latency. Their local observed paint and hydration metrics are separate
from simulated Lighthouse results. Local HTTP/1.1 request queuing is not proof
of an equivalent production HTTP/2 or HTTP/3 delay. Worker startup measures
local module evaluation CPU, not global edge cold starts or request TTFB.

A modulepreload priority diagnostic is excluded because its control and
treatment had different compiler inputs after a commit auto-fixer changed
imports. Its input audit is preserved as invalid evidence. Earlier pilot samples
are also excluded from the final matrix.

The earlier audit's temporary raw archives were cleared before this follow-up.
Its committed compact samples and recorded archive checksums remain, but those
old archives are unavailable. New raw evidence is preserved outside the checkout
with a checksum.

## Reproduce and validation

Use [revisions.json](./revisions.json), each source's lockfile, Node 26.12.1 and
the recorded Chrome version. Replace the sanitized checkout roots with local
paths and prepare each isolated test environment and seed using the repository
helpers. Keep the three baseline commits pinned. Check out the measured
application SHA, rather than a later report commit.

```sh
node tools/framework-comparison/compare-builds.mjs matrix.json NEW_BUILDS
node tools/framework-comparison/run-local.mjs matrix.json NEW_COMPARISON private browser lighthouse-targets freshness
node tools/framework-comparison/summarize-lighthouse.mjs NEW_COMPARISON/lighthouse-targets
node tools/framework-comparison/attribute.mjs NEW_BUILDS/targets.json NEW_ATTRIBUTION.json
node tools/framework-comparison/check-results.mjs NEW_COMPARISON/browser/runs.json NEW_BUILDS/inventory/inventory.json fixed
node tools/framework-comparison/startup.mjs matrix.json NEW_STARTUP
```

Use new output directories. Run startup last because it replaces each checkout's
build output. The release-asset check is a separate real-SHA build before the
timing matrix, documented in
[the harness README](../../../../../../tools/framework-comparison/README.md).
Raw build runs retain wall-clock samples and logs, including source-map
verification where a revision runs it. Per-file gzip inventory is not route
transfer.

All 7,469 Node tests, 588 Worker tests and 36 browser tests passed on the
measured source. Normal pre-push type checks and Knip passed. The four
production checks also passed, covering public startup, styles, docs intent
preloading and signed-in desktop/phone account controls with and without
JavaScript. Bundle and real auto-fixer regression tests passed after commit
hooks. Lint passed before the source freeze.

The prior authoritative `npm run validate` attempt remains blocked in the
unchanged CLI native macOS Keychain test. This follow-up does not claim that
full gate is green, and it does not substitute a different credential backend to
make it pass.

## Raw archive

[Archive manifest and checksum](./raw-archive.json) records a 485-file,
98,627,199-byte archive saved outside the ignored checkout at:

`/Users/tannerlinsley/.codex/visualizations/2026/10/28/01a180e0-2dc5-7372-953b-169fa7ad27e4/kody-mobile-followup-8187ad43-raw.tar.gz`

SHA-256: `b89068bf015deef0f79e801cad86b4cbf2a8ffecad9039d24ad3a56a44e322c2`.

The local archive contains raw Lighthouse JSON/HTML, full inventories and source
attribution, navigation resources, freshness samples, release proof, profiler
output and the frozen harness/config. Public before/after traces retain the docs
request evidence. The invalid priority input audit remains explicitly invalid.
Environment secrets, generated Wrangler configs, cookies, seed databases,
private session logs and Playwright traces are excluded. The archive is local,
it is not a publicly hosted download. Compact per-sample evidence is committed
alongside this report.

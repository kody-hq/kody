## Results

The public mobile cold-load gap remains open. The fixed source improves several
delivery problems, but these measurements do not establish parity with Remix.
All 120 Lighthouse audits completed without runtime failures.

LCP in milliseconds, median (minimum to maximum), five audits per cell:

| Page    | Device  | Remix               | Shipped             | Main                | Fixed               |
| ------- | ------- | ------------------- | ------------------- | ------------------- | ------------------- |
| home    | mobile  | 3166 (3020 to 5427) | 3613 (3318 to 3829) | 4063 (3919 to 4064) | 3915 (3320 to 4064) |
| home    | desktop | 658 (616 to 696)    | 840 (823 to 919)    | 980 (918 to 1047)   | 981 (934 to 1135)   |
| pricing | mobile  | 2566 (2417 to 2869) | 2564 (2414 to 2565) | 3015 (2864 to 3016) | 3013 (2865 to 3020) |
| pricing | desktop | 850 (838 to 936)    | 581 (547 to 583)    | 654 (622 to 655)    | 623 (615 to 694)    |
| docs    | mobile  | 2599 (2587 to 2886) | 2871 (2869 to 2871) | 2870 (1818 to 3019) | 2868 (2722 to 3019) |
| docs    | desktop | 1732 (1683 to 1761) | 2061 (2026 to 2134) | 1998 (1922 to 2046) | 2256 (2141 to 2287) |

The fixed mobile performance scores are 81, 91 and 91 for home, pricing and
docs, versus Remix’s 91, 95 and 94. Desktop docs LCP also regresses from main’s
1,998 ms to 2,256 ms, so the CSS delivery change is not a universal LCP win. See
[all scores and metrics](./LIGHTHOUSE.md) and
[every audit](./lighthouse-runs.json).

Observed local homepage diagnostics at 100 ms added request latency, medians of
five fresh contexts at 1350×940, without simulated mobile CPU throttling:

| Metric                                          | Remix   | Shipped | Main    | Fixed   |
| ----------------------------------------------- | ------- | ------- | ------- | ------- |
| FCP ms                                          | 260     | 288     | 292     | 268     |
| LCP ms                                          | 700     | 440     | 440     | 268     |
| Hydration marker ms                             | 674     | 1,827   | 1,933   | 1,600   |
| Initial JS encoded bytes                        | 145,878 | 259,010 | 281,455 | 256,571 |
| All observed style text plus external CSS bytes | 62,958  | 100,791 | 178,089 | 144,586 |
| Document gzip body bytes                        | 27,619  | 21,933  | 32,390  | 53,787  |
| Document decoded bytes                          | 152,661 | 125,554 | 135,285 | 269,233 |

The framework traversal patch changes the preload schedule without changing
client JS/CSS output, all 648 emitted file hashes match the preceding CSS/script
source at `79a64ee0`. In the separate preceding navigation series, fixed
hydration was 1,823 ms at 100 ms latency, versus 1,600 ms after traversal. These
are separate diagnostic series, not an isolated randomized treatment comparison.

The final fixed homepage still loads 79 JavaScript files, versus Remix’s 25, and
51 of those fixed files are smaller than 1 KB encoded. It transfers 76% more
initial JavaScript than Remix. Source-map attribution includes Redact, the
router, Query, generated routes, icons and application UI. The comparison
changes the application and framework together, so those bytes cannot all be
assigned to Start.

The local server uses HTTP/1.1. CDP adds per-request latency without
constraining bandwidth, while Lighthouse uses its own simulation. Small-file
queues can be much more expensive here than on production HTTP/2 or HTTP/3. Real
edge protocol traces are still needed before attributing this whole gap to
production users.

Navigation at 100 ms added latency, medians in milliseconds:

| Transition              | Remix | Shipped | Main | Fixed |
| ----------------------- | ----- | ------- | ---- | ----- |
| Home to pricing         | 152   | 158     | 130  | 129   |
| Pricing to docs         | 590   | 490     | 462  | 464   |
| Docs to cached pricing  | 41    | 23      | 18   | 28    |
| Account to profile      | 138   | 468     | 450  | 352   |
| Profile back to account | 164   | 127     | 131  | 134   |

[Navigation samples](./browser-runs.json),
[signed-in samples](./private-runs.json) and
[both latency summaries with ranges](./navigation-summary.json) retain the
zero-latency results too. Three Remix account requests were aborted during
navigation, these remain in the signed-in samples. There were no page or console
errors in either browser series and no failed public requests. The profile route
remains slower than Remix. The freshness checks cover accepted and rejected
saves after leaving the form, including persisted data and seed restoration. See
[all 24 cases](./freshness-runs.json).

Build and startup results:

| Metric                     | Remix     | Shipped   | Main      | Fixed     |
| -------------------------- | --------- | --------- | --------- | --------- |
| First build seconds        | 3.36      | 11.60     | 11.06     | 11.04     |
| Warm build median seconds  | 2.76      | 8.68      | 8.94      | 9.26      |
| Startup active CPU ms      | 43.60     | 24.90     | 25.10     | 25.60     |
| Client JS/CSS file count   | 57        | 621       | 646       | 648       |
| Client raw bytes           | 1,761,137 | 3,124,610 | 3,545,684 | 3,510,300 |
| Client per-file gzip bytes | 528,876   | 1,064,064 | 1,191,179 | 1,188,632 |

Warm builds remain much slower than Remix. Total emitted client assets include
lazy routes and are not initial-page transfer. All 24 build samples and all
three startup samples per source are retained. Startup CPU passes the existing
time guard. The byte-guard command completes with existing warning-only platform
and runtime overages, 6,423,531 / 5,244,000 bytes and 4,982,842 / 3,793,500
bytes. The origin bundle is 768,923 / 7,750,000 bytes. This PR does not claim
those backend size overages are fixed.

The unchanged initial-page guard passes fixed at 256,571 JavaScript bytes and
122,815 native inline stylesheet bytes. The stylesheet guard covers native CSS
plus external CSS, while the separate total-style diagnostic also counts
Emotion. It is not a claim that the page contains only 122,815 bytes of style
text.

## Reproduce

Use the exact SHAs in [revisions.json](./revisions.json), Node 26.12.1, Chrome
156.0.8078.48 and each revision’s lockfile. The historical sources need their
generated test config prepared using the repository helpers. Follow the
[benchmark setup](../../../../../tools/framework-comparison/README.md), using
the four roots and ports from the revisions file. Set the fixed target to the
source SHA above, rather than the later documentation commit.

```sh
node tools/framework-comparison/compare-builds.mjs matrix.json NEW_BUILD_OUTPUT
node tools/framework-comparison/run-local.mjs matrix.json NEW_BROWSER_OUTPUT private browser lighthouse-targets freshness
node tools/framework-comparison/summarize-lighthouse.mjs NEW_BROWSER_OUTPUT/lighthouse-targets
node tools/framework-comparison/attribute.mjs NEW_BUILD_OUTPUT/targets.json attribution.json
node tools/framework-comparison/check-results.mjs NEW_BROWSER_OUTPUT/browser/runs.json NEW_BUILD_OUTPUT/inventory/inventory.json fixed
node tools/framework-comparison/startup.mjs matrix.json /private/tmp/NEW_STARTUP_OUTPUT
```

Use six build rounds, five browser and Lighthouse rounds, both 0 and 100 ms
latency, mobile and desktop Lighthouse, and three freshness rounds. Keep builds,
tests and timing stages separate. `run-local` owns and stops the local servers.
The compact JSON files share identical initial resource inventories by hash and
omit repeated cumulative step inventories, while preserving every measured
sample, request list, error and failure. Full raw inventories and Lighthouse
JSON/HTML reports are in the local archive linked from the PR.

## Remaining work

The changes fix missing static preloads, blocking startup script requests and
unreadable first-frame text. They do not close mobile LCP or hydration parity.
The next useful evidence is a production HTTP/2 or HTTP/3 trace and an isolated
same-application renderer/framework comparison. Further payload work should
remove dependencies from the real initial graph, with authenticated navigation
and shared-cache correctness checks, rather than changing budgets or hiding
content until a benchmark has finished.

# Cold-load hypotheses from the final local reports

This is read-only analysis of `reports/measurements/redact/lighthouse`, using
the final patched Redact run. It proposes edge experiments, not confirmed causes
or runtime changes.

## First test: critical resource order

The migration changed document resource ordering. Original
`packages/worker/start/routes/__root.tsx` places the blocking `/page-init.js`
script first, then the two font preloads, then module preloads. Native
`packages/worker/start/routes/__root.tsx` puts `<HeadContent />` first, which
includes module preloads and the font links, followed by inline global styles
and `/page-init.js`. The measured candidate request order has many High-priority
modules before both fonts and the blocking script.

The blocking script itself is intentional original behavior. It adds `html.js`
before first paint for enhancement-only motion, and remains external because the
existing CSP disallows inline scripts. Font preloading is also intentional
original behavior, with an explicit source comment against dropping or delaying
the fonts. Both use the same self-hosted fonts with `font-display: swap`. The
migration-induced difference is their position relative to module preloads, not
the existence of the script or fonts.

One representative pair, mobile pricing run 3, shows:

| Resource/event                  | Remix, ms from navigation | Patched Redact, ms from navigation |
| ------------------------------- | ------------------------: | ---------------------------------: |
| Document finished               |                       4.3 |                               14.0 |
| Main entry finished             |                      19.1 |                               24.6 |
| Blocking page-init finished     |                      12.2 |                               81.6 |
| Bricolage font finished         |                      13.4 |                               80.2 |
| Wix font finished               |                      18.5 |                               81.4 |
| Observed first contentful paint |                        58 |                                107 |

All these local requests used HTTP/1.1. Candidate modules were requested earlier
than fonts/page-init and consumed many early slots. This supports testing
critical resource order and preload contention first. It does not prove the same
delay exists over Cloudflare HTTP/2 or HTTP/3, or that modules must be removed.
Reordering existing critical resources, if edge evidence confirms the
contention, preserves the intended script and font behavior more closely than
deferring either one.

## What actually became LCP

All five mobile pricing samples identify the same introductory paragraph as LCP
in both frameworks. All five mobile docs samples identify the first article
paragraph. Mobile home identifies comparison text, four samples using the same
list item and one using its heading in each framework. Desktop home identifies
the same shared-primitives heading. These are text elements, so optimizing a
hero image is not a direct explanation for their measured LCP regression.

Median observed, unthrottled LCP subparts from the five local mobile samples:

| Page    | Remix TTFB / render delay, ms | Redact TTFB / render delay, ms |
| ------- | ----------------------------: | -----------------------------: |
| Home    |                    4.1 / 53.0 |                   24.0 / 131.3 |
| Pricing |                    4.1 / 40.8 |                     8.6 / 92.7 |
| Docs    |                    4.1 / 42.9 |                   11.7 / 101.7 |

These are observed trace breakdowns. They are not the simulated Lighthouse
score's 4–9 second FCP/LCP values and must not be added to or substituted for
those simulated metrics. Both observed first paint and response latency deserve
inspection on edge. Local SSR response cost is a secondary hypothesis, but
Worker startup profiling does not measure request rendering and cannot explain
it by itself.

The baseline and candidate pricing sample both had zero TBT. Their bootup-time
audit was roughly 80 ms in the representative pair. That does not rule out
parsing, style calculation, or shorter tasks, but it weakens a claim that large
hydration long tasks alone explain the pricing delay. Font-display audits found
no blocking-font warning. The larger inline HTML/CSS and preload dependency
order remain more concrete leads than blaming font-display or CPU without a
trace.

## Desktop docs is a different problem

All desktop docs samples identify the same `/youtube-thumb/QA0xYMAMjEg` poster
as LCP, at the same dimensions and position. Both discover it in initial HTML
and load it eagerly, but neither marks it `fetchpriority=high`. Median observed
image load duration was 395.0 ms for Remix and 287.2 ms for Redact, with render
delay about 26–27 ms. Candidate desktop docs already had a slightly better
median performance score. Edge proxy cache status and poster delivery should be
checked before attributing that difference to the framework. An image-priority
experiment is plausible for this route, but it is not evidence for changing
every image priority.

Homepage rise animations intentionally delay some content under the shared CSS.
The original stylesheet explicitly documents the visual tradeoff. Do not remove
motion just to improve a score without checking whether the actual edge LCP
element is affected and preserving the requested experience.

## Evidence to keep on edge

Retain the sanitized full Lighthouse report, especially `metrics` (observed and
simulated fields), `lcp-breakdown-insight`, `lcp-discovery-insight`,
`network-requests`, `network-dependency-tree-insight`,
`render-blocking-insight`, `font-display-insight`, `bootup-time`, and
main-thread diagnostics. Network rows include protocol, request priority,
preload status, start/end times and byte counts. Keep element selectors and
public text labels so comparisons identify the same content. The new harness
already retains these without raw request or response headers.

The separate delivery record should establish content encoding, cache-control,
CF-Cache-Status, Age and CF-Ray for the document, blocking script, fonts, entry
modules and docs poster. Compare the same region suffix and cache class where
possible. Access credentials and session headers must remain excluded. If the
edge hypothesis survives, make one targeted ordering or delivery change, then
repeat matched measurements against the unchanged baseline. Use five runs and
keep outliers. Do not compare an optimized candidate's fresh edge data with old
local baseline scores.

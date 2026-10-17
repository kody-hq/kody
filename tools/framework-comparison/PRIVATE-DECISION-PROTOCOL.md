# Private migration decision

The decision is whether to move Kody's entire web app to Start, Router, Query
and Redact. Public-page delivery is a guardrail. The signed-in experience is the
main reason to switch. A framework name, a Lighthouse score, or the existence of
a cache is not evidence of a better experience.

## Conditions

- Use the existing isolated Cloudflare comparison fleets, protected by Access.
  Verify anonymous documents and assets are blocked before and after deploys.
  Keep version preview URLs disabled and service-only workers private.
- Record source, dependency, build and deployed Worker versions. Compare the
  final candidate to the immutable Remix baseline, not an older Start build.
- Use equivalent disposable data and the same browser, device settings and
  network conditions. Alternate target order. Keep every failure.
- Do not use production customer data or send real messages, charges or jobs to
  external services. Restore reversible fixture changes after each run.
- Separate actual edge measurements, local production diagnostics, and
  controlled failure experiments. Never combine their timing distributions.
- Keep credentials out of reports, videos, URLs and logs. Access credentials
  must be scoped to the exact two comparison origins.

## Public pages

Measure home, pricing, docs, blog, community and a public profile. Use fresh
browser loads as well as repeat navigation. Record actual edge cache status; a
fresh browser is not a cold Worker or a cold edge cache.

Keep raw Lighthouse reports for mobile and desktop, with at least five paired
samples per page. Expand noisy comparisons before drawing a conclusion. Report
absolute milliseconds and bytes, medians and ranges, plus failures. Report TTFB,
FCP, LCP, CLS, TBT, initial script transfer and requests separately.

Check server-rendered content with JavaScript disabled, titles, descriptions,
canonical URLs, structured data, redirects, status codes, robots and sitemap
behavior. Access prevents measuring actual search indexing on private previews.
Preview-specific indexing protections must be distinguished from the production
SEO output contract.

Investigate repeated candidate LCP regressions over 100 ms or 5%, whichever is
larger. These are investigation thresholds, not proof of a statistically
significant regression or automatic approval below the threshold. Require no
unresolved content, metadata, status-code or layout-stability regressions.

## App workflows

Measure time to useful feedback separately from time to authoritative server
completion. A pending spinner does not establish optimistic data. A fast stale
screen does not establish correct data.

| Workflow                                                                           | Required observations                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home, docs, public profile, login, Account, Jobs, Account, back/forward            | Content readiness, requests and bytes, blank frames, full reloads, scroll and keyboard focus. Compare intentional hover prefetch separately from clicks without hover.                   |
| Edit profile, hold save, visit cached public profile and return                    | Optimistic value before server completion, survival after unmount, later draft preservation, server acceptance, and complete rollback on rejection. Repeat with an uncached destination. |
| Jobs list, detail, reversible setting, another page, list and detail again         | Consistent list/detail values, useful pending state, authoritative completion, no stale read overwriting a save, and recoverable failure.                                                |
| Email list, filter, detail, classification, navigate away and return               | Filter membership and detail agree, no resurrected stale row, rejected action remains recoverable. Use private seeded messages and no outbound send.                                     |
| Same user, two tabs, external edit, return before and after stale boundary         | Actual stale-data duration, refresh trigger, preserved drafts, and visible failure/retry behavior. Include a continuously visible tab.                                                   |
| Switch account or revoke access with cached and pending private reads              | No wrong-user or revoked content rendered, including transient frames. No private cache or draft survives an identity change.                                                            |
| Repeated filtering, detail navigation and back for 30 minutes, then idle beyond GC | Interaction latency over time, heap after controlled GC, DOM/listener trends, cache retention where observable, and duplicate requests.                                                  |
| Keyboard, reduced motion and narrow viewport through the same workflows            | Usable focus, stable reading position, accessible controls, no lost draft or blocked interaction.                                                                                        |

For natural interactions, report paired per-action measurements and distribution
tails only when sample counts support them. For held writes and injected errors,
report correctness and user-visible states, not fabricated production latency.
Capture matched 60 fps MP4 workflows separately from unrecorded timings, because
recording adds overhead. Preserve a frame-rate/capture verification record.

## Decision

Switch only when the final candidate has a meaningful, repeatable benefit in
representative app workflows, acceptable public-page delivery, resolved
migration-related validation failures, and no unresolved critical correctness or
access-isolation failures. Do not average a data-loss or privacy failure into a
performance score.

Benefits from Query caching must be attributed to Query/cache policy unless a
comparison isolates Start itself. Record remaining custom bridges, retained
backend routing, dependency patches, source complexity and maintenance cost.
Fewer lines or fewer requests alone do not establish a better app.

If representative outcomes are equivalent, report that. If the improvements are
limited to two heavily optimized screens, finish the representative mutation
work before recommending the whole-app switch. Finite tests cannot promise 100%
parity or absence of unknown defects.

## Initial readiness, October 11, 2026

The final v7 build has local evidence, but the private previews still run older
builds. Existing deployment authentication works. Anonymous requests to both
preview homepages redirect to Cloudflare Access. The old benchmark service-token
file is absent; Access organization inspection returns an authentication error.
Remote measurement awaits authorized Access credentials and verification of the
complete privacy configuration. No new remote deployment has been made.

Profile and Jobs have Query mutation handling. Several other app pages retain
direct fetch and local response state. Cross-tab edits do not broadcast cache
invalidation; focus refresh respects each query's stale interval. These are
explicit comparison targets, not assumed benefits.

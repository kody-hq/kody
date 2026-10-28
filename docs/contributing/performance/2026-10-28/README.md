# Kody migration performance audit, October 28, 2026

The migration improved local Worker startup CPU and cached navigation behavior,
but it increased build time, initial JavaScript and the total emitted asset
inventory. Main then added more initial JavaScript and CSS. This change removes
avoidable eager schema imports, unused fade CSS and a route-chunk redirect. It
does not bring every cold page load back to the Remix baseline.

## Sources and recovered evidence

| Label               | Exact source                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Remix               | `8b2528460eb9be9d08d50b7a1d2ee8f491503d83`                                                                 |
| Shipped migration   | `2894f12c99431f7e78816b502c24fdc72813dffc`, merge of [PR #3561](https://github.com/kody-hq/kody/pull/3561) |
| Main at audit start | `214ce21bbd6045a132f7f474bcb6a0126a348722`                                                                 |
| Fixed               | `d7077a679f7989b9956e332ad57895bc584177f0`                                                                 |

The fixed application source was committed before the final browser run. Later
report commits do not change that measured source. Main means the pinned audit
snapshot, rather than whatever the branch points to when this is read.

The archived chat **Start**, ID `01a11c5c-45a6-7af3-ab0c-75e35fbd9432`, was
unarchived. Its deleted checkout and original raw traces were not recovered. Six
literal report snapshots survived in its local session log. Their
[manifest](../../../../tools/framework-comparison/historical/manifest.json)
records the source event, extraction method and SHA-256 for each recovered file.
The recovery script reproduces those six hashes from the surviving log. These
are drafts embedded in tool-call inputs, not original raw measurement files or
proof that every proposed write succeeded. Later shell edits cannot be
reconstructed as a final report from these drafts alone.

The recovered
[comparison draft](../../../../tools/framework-comparison/historical/13328-COMPARISON.md.txt)
shows that mobile home regressions delayed acceptance. After optimizations, its
five alternating edge pairs reported Remix LCP 2.795 seconds (2.095–3.618) and
Start 2.868 seconds (1.816–3.853), both performance score 94. It also
prioritized signed-in cache freshness and navigation correctness. Those
historical candidate results explain the original decision process. They are not
a measurement of the shipped merge and are not pooled below. The old comparison
tooling was subsequently deleted in PR #4038.

## Final browser protocol

All four optimized builds ran sequentially on one Apple M5 Pro, 18 cores, 64 GB,
Node 26.12.1, Chrome 156.0.8078.48. Each revision used its own lockfile. The
runner checked each source SHA through `/health`, enabled the same production
immutable asset cache headers, and recorded identical artifact fingerprints
before and after the run. No builds, tests or other benchmark browsers ran
concurrently.

Public and signed-in navigation use five rotating rounds at both zero and 100 ms
added latency per request, fresh browser contexts and no hover preload. The
clock ends when the destination data marker is visible on an animation frame.
This is DOM/style readiness, not a physical display paint or field INP. Initial
bytes are measured before navigating. Warm return routes share the context's
HTTP and application caches.

Lighthouse 13.5.0 uses fresh Chrome processes, default simulated mobile
throttling and desktop preset defaults. There are five rotating audits for each
of three pages, two devices and four revisions, 120 total. All completed, with
zero runtime failures. All 200 navigation transitions completed with zero page
errors, failed requests or document reloads. Twenty-four controlled save cases
completed and restored the seed data.

These are local production builds with test bindings, disabled telemetry and
local Workers. Local SSR HTML is uncompressed. Public content, layout and LCP
elements change between revisions. Request counts include lazy work observed
during the audit, not just the initial critical path. Fresh browsers do not mean
cold Workers. These results do not establish global edge latency, field Core Web
Vitals, real-user INP, React-versus-Redact cost or framework-only cost. The
recovered edge protocol used applied DevTools throttling, so its numbers are not
directly comparable to this simulated Lighthouse series.

## Initial homepage assets

Observed encoded JavaScript excludes HTTP headers. External CSS is raw emitted
bytes for the stylesheets actually loaded, excluding inline Emotion styles. Each
value was consistent across ten public navigation samples per target.

| Revision | Initial JS, encoded bytes | Loaded external CSS, raw bytes |
| -------- | ------------------------: | -----------------------------: |
| remix    |                   145,878 |                              0 |
| shipped  |                   259,010 |                         78,550 |
| main     |                   281,455 |                        157,135 |
| fixed    |                   256,730 |                        122,836 |

## Navigation

Medians in milliseconds, with minimum–maximum. Five samples per cell.

| Route, added latency       |         Remix |       Shipped |          Main |         Fixed |
| -------------------------- | ------------: | ------------: | ------------: | ------------: |
| Account to profile, 0 ms   |    43 (34–70) |    85 (79–91) |    60 (54–70) |    57 (49–58) |
| Account to profile, 100 ms | 138 (131–148) | 484 (481–485) | 466 (466–471) | 366 (360–368) |
| Back to Account, 0 ms      |   80 (63–147) |    22 (21–29) |    26 (24–26) |    26 (24–27) |
| Back to Account, 100 ms    | 164 (164–180) | 130 (130–132) | 135 (128–136) | 135 (134–147) |
| Home to pricing, 0 ms      |    53 (49–69) |    62 (59–75) |    36 (34–53) |    35 (30–37) |
| Home to pricing, 100 ms    | 157 (145–187) | 159 (150–177) | 135 (132–145) | 136 (131–137) |
| Pricing to docs, 0 ms      |   92 (77–107) |   76 (75–127) |   81 (63–108) |   70 (63–103) |
| Pricing to docs, 100 ms    | 610 (610–627) | 509 (492–510) | 484 (473–492) | 487 (474–489) |
| Return to pricing, 0 ms    |    26 (21–27) |    32 (18–35) |    16 (15–17) |    17 (15–17) |
| Return to pricing, 100 ms  |    43 (41–43) |    24 (23–25) |    16 (16–17) |    16 (15–16) |

## Cold public page loads

Median Lighthouse LCP in milliseconds, with minimum–maximum. Five samples per
cell. All scores, FCP, TBT, CLS, TTFB, transfers and requests are in
[LIGHTHOUSE.md](./LIGHTHOUSE.md).

| Page, device     |            Remix |          Shipped |             Main |            Fixed |
| ---------------- | ---------------: | ---------------: | ---------------: | ---------------: |
| home, mobile     | 3314 (3016–5433) | 3831 (3613–4012) | 4214 (4213–4215) | 4064 (4063–4214) |
| home, desktop    |    654 (613–694) |    911 (811–953) |  1004 (901–1013) |    919 (773–980) |
| pricing, mobile  | 2565 (2426–2566) | 2565 (2563–3015) | 3013 (2863–3016) | 3013 (2865–3015) |
| pricing, desktop |    579 (578–842) |    575 (536–658) |    654 (654–654) |    654 (653–655) |
| docs, mobile     | 2728 (2574–2881) | 2867 (2717–3019) | 3017 (2867–3167) | 3018 (3016–3167) |
| docs, desktop    | 1687 (1630–1703) | 2014 (1916–2070) | 2064 (1932–2146) | 2029 (1620–2148) |

## Build and inventory costs

Six rotating sequential builds per original revision, first round reported
separately, then five warm samples. Dependency and source caches were already
populated. These are complete build-command times, including post-build
source-map verification when present. No fixed-build timing claim is made.

| Revision | First build, ms | Warm median, ms (range) | All client JS/CSS files | Client raw bytes | Client per-file gzip bytes | All server JS/CSS gzip bytes |
| -------- | --------------: | ----------------------: | ----------------------: | ---------------: | -------------------------: | ---------------------------: |
| remix    |            4315 |        4274 (3659–8491) |                      57 |        1,761,137 |                    528,876 |                    5,576,195 |
| shipped  |           16347 |     17641 (16648–36732) |                     621 |        3,124,610 |                  1,064,064 |                    7,297,491 |
| main     |           21228 |     16650 (14119–36103) |                     646 |        3,545,684 |                  1,191,179 |                    7,937,523 |
| fixed    |    not measured |            not measured |                     648 |        3,508,235 |                  1,187,766 |                    7,935,429 |

Inventories include every emitted lazy JS/CSS asset and exclude maps. Gzip is
independent compression per file, not page transfer or deployment upload size.
Build time remains a migration cost. Main's warm median did not regress from the
shipped migration in this series, and the broad ranges deserve attention. The
Remix client totals closely reproduce the cited inventory, but the shipped merge
has 621 client files, rather than the screenshot's 628. This is a pinned
three-revision comparison, not a claim to reproduce Brooks's unidentified
candidate exactly.

Generated source-map spans attribute raw emitted UTF-8 bytes, with unmapped
bytes kept explicit. They do not assign gzip bytes to source modules. Compared
with shipped, main adds 137,292 mapped raw bytes from `@tanstack/charts`, its
largest added dependency. Those charts are lazy and are not on the homepage's
initial resource list. The other mapped TanStack packages are about 199 KB on
main versus 202 KB shipped. Application code, generated route/JSX/Emotion code,
styles and dependencies all contribute to growth. File count alone does not
explain it. [Attribution data](./attribution-summary.json) preserves every
source bucket, rather than treating all bytes as framework overhead.

## What changed and what remains

- URL codecs and document-head helpers pulled in runtime Zod and credential
  editor schemas. The fix separates lightweight parsing/presentation code from
  runtime input schemas, preserving validation at server and editor entry
  points. A production bundle test checks both the codec and document-head
  graphs. Initial homepage JavaScript falls 24,725 encoded bytes, 8.8%, and is
  slightly below the shipped migration. Zod still exists in lazy chunks where
  validation belongs. Total inventory reduction is much smaller than the eager
  transfer reduction, which is expected.
- The root loaded the full prebuilt `tw-fade` stylesheet. Compiling its official
  source for the three used utilities removes 34,299 raw CSS bytes, 21.8% of
  loaded external CSS. This adds the official Tailwind Vite compiler without
  Preflight or automatic source scanning. A browser test checks the homepage and
  workspace mask styles and fade dimensions.
- Route chunks with `@` in their names received a Cloudflare Assets redirect to
  `%40`. Safe ASCII chunk names remove that extra request round trip. At 100 ms
  added request latency, first profile navigation improves from 466 to 366 ms,
  while zero-latency results are close. Identity verification remains intact.
  Remix still reaches the first profile faster, while cached Back and
  return-to-pricing behavior favor Start. Do not remove private-route identity
  checks to win this benchmark.
- A head preload discovers the existing Emotion hoist script earlier. It still
  executes at the footer before hydration with the existing CSP. The final
  homepage LCP improvement is modest and its ranges overlap main. Pricing and
  docs show no material improvement. The first candidate's smaller codec split
  did not remove the full eager schema path, and did not improve cold loading;
  browser resource measurements exposed that incomplete fix.

Mobile pricing LCP remains about 448 ms behind shipped. A representative raw
Lighthouse report identifies render-blocking root CSS and page-init; fixed also
reports the preloaded Emotion hoist script. The CSS response is smaller than
main but still larger than shipped. Homepage content/layout changed, and docs
loads substantially more resources than Remix. These are remaining investigation
targets, not proven framework-only regressions or fixed outcomes. Avoid
deferring correctness scripts or hiding above-the-fold content merely to improve
the score. A paired deployed comparison and critical-style attribution are
needed before claiming restored public cold-load parity.

The controlled profile-save probe holds a write, navigates to a cached public
profile, then accepts or rejects it. All three Start versions show the
optimistic value and reconcile accepted writes after unmount, 3/3 each. They
also roll back all rejected writes, 3/3 each. Remix's accepted writes persist
correctly but its cached destination stays stale in 3/3 cases. All rejected
Remix cases remain correct. All 24 cases verify authoritative state separately
and restore the seeded fields. This is controlled correctness evidence, not a
navigation latency score or proof of every account flow.

## Worker startup

Each revision builds its real slim `production-worker.ts` entry with its own
installed dependencies. The same Wrangler 4.147.0 profiler measures every copied
artifact, three sequential samples. No timed browser work overlaps this stage.

| Revision | Local startup active CPU, ms, median (range) |
| -------- | -------------------------------------------: |
| Remix    |                             40.0 (38.9–43.7) |
| Shipped  |                             22.5 (21.2–22.7) |
| Main     |                             23.7 (22.7–23.9) |
| Fixed    |                             22.7 (22.6–23.9) |

This supports the migration's module-startup benefit on this machine. It is not
request TTFB, a surcharge on every navigation or global edge cold-start latency.
Run the profiler into an external directory such as `/tmp/kody-startup`, because
Wrangler otherwise discovers the parent checkout's deploy configuration and
rejects the copied config as ambiguous. The failed initial attempt is retained
in local raw evidence and contributes no timing samples.

## Validation and limits

The authoritative `npm run validate` was attempted. It completed 7,461 Node
tests, 588 Worker tests, 32 browser tests, MCP checks, typechecking, lint and
the startup-bundle byte guard successfully. The browser suite includes the new
fade-mask checks. The separate startup-time guard also passed all three Worker
budgets, origin 22.4 ms, platform 68.8 ms and runtime 38.8 ms best-of-three.
These guard values are separate from the comparison medians above. Native Start
typechecking and focused schema/bundle/ asset-naming tests also passed. Initial
formatting and unused-export failures were corrected, then format and Knip
passed separately. The local production build was checked through control-kody,
including its source SHA, seeded login, home and Account screenshots.

The full gate is **not green**. Its CLI leg hung for over ten minutes inside
native macOS Keychain, with a sampled owned process blocked in
`keyring.darwin-arm64.node`, `SecKeychainFindGenericPassword` and `mach_msg`.
The owned hung test tree was terminated. CLI source was unchanged. The tests
isolate HOME, but the native Keychain backend still shares the OS credential
namespace. The proper follow-up is an injected hermetic credential backend for
CLI tests. Skipping production authentication or replacing the native backend
just for this benchmark would not establish correctness.

Filing that unrelated gate blocker through the required friction-log package was
blocked by the missing connected account link and local CLI credential. No issue
was filed through an alternate channel. The blocker and its observed stack are
recorded here so the validation result is not mistaken for a pass.

The page-byte guard passes fixed and rejects main at unchanged thresholds:
270,000 encoded initial JS bytes and 135,000 raw loaded external CSS bytes, with
at least five samples and no page errors or document reloads. These are initial
audit guardrails, not evidence of parity with Remix and not an LCP budget. Run
the browser suite after route, cache, shared UI or dependency changes. Retain
public cold-load results alongside signed-in speed and correctness so neither
side of the original goal disappears again.

## Reproduce and inspect

The maintained
[benchmark README](../../../../tools/framework-comparison/README.md) describes
setup and each measurement. Use Node 26, Chrome and separate new output
directories. A complete four-revision input is
[revisions.json](./revisions.json). The refs must exist in the local repository
before `git archive` can read them.

```sh
node tools/framework-comparison/prepare-snapshots.mjs /tmp/kody-audit docs/contributing/performance/2026-10-28/revisions.json
npm run perf:builds -- /tmp/kody-audit/targets.json /tmp/kody-builds
npm run perf:local -- /tmp/kody-audit/targets.json /tmp/kody-browser private browser lighthouse-targets freshness
node tools/framework-comparison/summarize-lighthouse.mjs /tmp/kody-browser/lighthouse-targets
node tools/framework-comparison/attribute.mjs /tmp/kody-builds/targets.json /tmp/kody-attribution.json
npm run perf:check -- /tmp/kody-browser/browser/runs.json /tmp/kody-builds/inventory/inventory.json fixed
node tools/framework-comparison/startup.mjs /tmp/kody-audit/targets.json /tmp/kody-startup
```

Run startup last, because it replaces build output. Never rebuild while local
measurement servers are watching the output. The runner owns and stops its
servers, verifies source SHA and refuses changed artifacts. Run these mutating
seed probes only on loopback origins.

Committed evidence includes every Lighthouse sample and summary, every
navigation sample with initial resources and per-step requests, all freshness
cases, build samples, Worker startup samples, inventory summaries, source
attribution, package/lock hashes and before/after artifact fingerprints.
Repeated cumulative per-step ResourceTiming arrays are omitted from the compact
navigation evidence. Source hashes and inventory hashes are not changed to
account for that compaction.

Full raw reports, inventories, attribution, navigation resources and profiler
logs are preserved in the local `kody-performance-audit-2026-10-28.tar.gz`
archive with a separate SHA-256. It excludes credentials, seed databases, the
private session log and unrelated historical tool inputs. The earlier pilot runs
used different cache settings or incomplete fixes and are not pooled into this
final browser dataset. Failed setup attempts and the failed in-checkout startup
profile remain identifiable in local output, not silently counted as successful
application samples.

Raw archive SHA-256:
`0b2447e83eea41644651368f91f004a509e575e49bda5fc4ff39c6ffcc6603f4`.

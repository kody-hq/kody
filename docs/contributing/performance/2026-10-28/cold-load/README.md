# Public cold-load follow-up

The mobile cold-load gap remains open. See
[the four-way results, ranges and reproduction steps](./RESULTS.md).

This reruns the same four-way comparison after changing how the fixed
application delivers its shared stylesheet and document startup scripts. The
first three source snapshots stay pinned. The fixed application source is
`07ccd2ca8cafae10dadad7d19ad06b219363422e`.

## Causes and changes

Start's build-time manifest preloaded each chunk and its immediate imports, then
stopped. Static dependencies of those imports were fetched only after another
module had loaded and been parsed. The Remix baseline traversed the whole static
graph. A newly added hydration-marker diagnostic exposed the resulting
waterfall, which was easy to miss when looking only at paint.

The framework patch passes the normalized chunk graph to the resolver and walks
static imports breadth-first, with cycle detection and deduplication. It never
walks dynamic imports, so unrelated lazy routes stay lazy. The existing resolver
API keeps its direct-import behavior when no graph is supplied. Tests run
against the actual installed package and cover deep imports, cycles, cache
isolation, asset prefixes and dynamic-route exclusion. A published-package
reproduction shows the original output `[entry, direct]` versus
`[entry, direct, deep]` after the fix. Source, generated ESM and type
declarations are included in the normal patch-package mechanism for
`@tanstack/start-plugin-core@1.171.49`.

The Remix baseline sends its global stylesheet inside the document. Start had
been waiting for an external stylesheet before painting, plus separate requests
for the head initialization script and the footer Emotion hoist script. The
compiled stylesheet was already a single shared root asset. This change uses the
installed Start version's native inline-CSS option and embeds the two static
scripts with the existing request nonce, at their existing execution positions.
The CSP policy is unchanged. JavaScript remains split.

The page-open animation also started hero text at zero opacity. Text now stays
readable from the first animation frame while retaining its translation motion.
Other reveal animations are unchanged. The production browser test pauses the
entrance at time zero and checks opacity, rather than checking only its final
state.

These changes move CSS bytes into HTML, they do not remove those bytes. The byte
guard now counts native inlined stylesheet bytes plus loaded external CSS
against the same 135,000-byte limit. The 270,000-byte initial JavaScript limit
also stays unchanged. Document sizes are recorded both encoded and decoded.

## Protocol

The four sources are Remix `8b252846`, shipped migration `2894f12c`, audit-start
main `214ce21b`, and fixed `07ccd2ca`. Main is the same pinned source from the
initial audit, not a moving branch. Each snapshot uses its own dependencies.
There are six rotating sequential builds per source, with the first round
reported separately from five warm rounds.

The browser protocol keeps five rotating rounds at both zero and 100 ms added
request latency, 40 public runs and 40 signed-in runs, 200 transitions total.
Lighthouse 13.5.0 keeps five rotating audits of home, pricing and docs on mobile
and desktop, 120 audits total. Chrome uses fresh processes per audit and the
same simulated mobile or desktop settings. Controlled freshness tests keep three
accepted and three rejected saves per source, 24 cases total, restoring the
seed.

The runner checks source SHAs, production asset cache headers and before/after
artifact fingerprints. This audit's builds, tests, browser timings and startup
profiles run in separate stages. Background work elsewhere on the machine is not
controlled. Every final sample and failure stays in the evidence. Medians and
ranges are used, without pooling pilot runs or the earlier audit.

Observed local FCP, LCP and hydration-marker times at a 1350×940 viewport are
additional diagnostics from the navigation runs. They do not replace simulated
Lighthouse metrics and are not field INP. The navigation clock still ends at the
first animation frame with the destination marker visible, which is DOM/style
readiness, not a physical display paint. Content and LCP elements differ between
historical application revisions, so this does not isolate framework or renderer
cost.

The earlier report incorrectly called local HTML uncompressed. The browser
receives gzip HTML. The old raw Lighthouse reports already distinguish decoded
resource size from transfer size, for example Remix pricing was 103,001 decoded
bytes versus 20,917 transferred bytes, including headers. The new navigation
records separate encoded body size, decoded body size and transfer size. Literal
recovered historical drafts remain untouched.

## Rejected experiments and setup failures

A later small-common-chunk factory experiment used Rolldown’s supported compiler
option with strict execution ordering. Production correctness checks passed, but
the diagnostic homepage loaded 776,415 encoded JavaScript bytes in 184 files,
versus the measured configuration’s 256,571 bytes in 79 files. Hydration at 100
ms request latency rose to roughly 3.39 seconds. The experiment was stopped and
fully reverted. Its partial diagnostic output is excluded from every final
table. Passing correctness tests alone was not sufficient to retain it.

The first complete navigation series used the CSS/script fix at `79a64ee0`. It
exposed the deeper import waterfall. Its Lighthouse stage was stopped before
changing the framework, and the complete final matrix was restarted with the
preload fix. Those partial Lighthouse samples are retained separately and never
pooled with the final series. Complete earlier navigation samples can be used
only as a labeled diagnostic of the preload change.

Native inlining with separate lazy component styles produced duplicate
stylesheet requests during hydration, which the production test caught. That
version was rejected. The final version retains the existing single shared root
stylesheet, and production checks verify one native inline style and no linked
stylesheet requests on all three pages. The installed Start option is marked
experimental, so this behavior remains covered by a production browser test.

A split base-CSS experiment did not resolve the full gap. A module-preload
priority experiment improved FCP while worsening simulated LCP, so normal module
priorities were restored. No custom preloader, patched Vite runtime, deferred
hydration or blank content placeholder was added.

One pilot is invalid: its build failed on Vite's CSS asset handling, but the
manual shell continued against stale server output and partly replaced client
files. Its apparent speedup is excluded. Following build sequences stop on
failure, and the final matrix uses the build runner's exit checks. The invalid
pilot and its failed build log remain separate in raw evidence.

The default E2E port belonged to another checkout. It was left running; the new
optional `KODY_E2E_PORT` setting gives this suite an isolated origin. The
initial archived-main build also lacked its generated local config, which was
created with the same preparation helper used by the other snapshots. The
partial setup matrix is retained separately and contributes no final samples.

## Verification

The production checks verify nonce-protected scripts without external fetches,
hydration without console errors, native inline CSS without duplicate requests,
no-JavaScript content, route navigation and first-frame hero readability. The
release check uses the real SHA asset namespace and verifies fonts load from
that namespace, with normal 200 and cached 304 responses. No production deploy
is involved.

The full development browser run passed 33 tests and failed one new assertion
that incorrectly counted Vite's `?raw` development modules as classic script
fetches. After correcting that distinction, both new tests passed on the
targeted rerun. The application code was unchanged by that assertion fix. Start
typechecking, installed-package traversal tests, focused bundle and budget
tests, lint, Knip and formatting passed. The prior full-validation CLI Keychain
hang remains a separate blocker, so `npm run validate` is not claimed green.

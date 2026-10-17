# Web app rendering and server state

See [process flow diagrams](./tanstack-start-flows.md) for ownership,
navigation, reads, writes, state, authorization, protocols, and deployment.

The web app uses TanStack Start, Router, Query, and Redact. The existing worker
services remain shared business logic. Website reads and mutations use native
Start server functions.

[`getRouter`](../../packages/worker/start/router.tsx) creates a QueryClient for
each server request and each browser router, then installs Router's SSR Query
integration. Router owns matching, navigation, preloading, scroll restoration,
and document assets. Query owns reusable resources and remaining page payloads.
Route loaders retain a head fallback and the exact Query key, rather than a
second copy of the payload. One-time authorization, verification, and approval
pages use foreground Router loaders so their token results do not become
reusable server-state caches.

## Reads and navigation

[`createPageQuery`](../../packages/worker/start/page-query.ts) builds shared
query options for loaders and mounted components. Keys contain the actor,
resource, and normalized resource inputs, including organization and filters
where applicable. The organizations routes share
[`organizationsQuery`](../../packages/worker/start/organizations-query.ts).

A fresh cache hit needs no payload request. An ordinary stale cache hit renders
the retained data and revalidates in the background. A cache miss waits for the
payload. Explicit invalidation waits for authoritative data unless an optimistic
write is still pending. Query receives its own cancellation signal, so canceling
one navigation does not abort a read needed by another observer.

Private navigation also verifies identity in a blocking root loader,
concurrently with the destination loaders. Router waits for that gate before
committing. Every data RPC independently authorizes its own read. The root check
protects cached data without forcing cold reads to wait for a separate round
trip. That same verification request checks access to the destination
organization, so an authorized warm navigation can reuse its cached payload
without a second permission request. Permission-sensitive queries use
`freshAuthorization` to require a foreground server check even after preload.
This is a deliberate security cost, so a warm private navigation is not a
promise of zero server requests. Server functions independently enforce access.
Presentation-only Credentials, Jobs, and Values filters reuse the committed page
authorization. Known static public pages skip that verification request.

The app disables Query's default focus and reconnect refetches. Its
[`activation handler`](../../packages/worker/start/refresh-on-activation.ts)
checks identity before refreshing private data. Query options declare
`meta.actorKey`, so refresh and permission invalidation cover resource queries
without a registry of page or domain names. This avoids returning a new
account's data into a previous account's mounted document.

## Writes

Mutation lifecycle callbacks own cache updates and reconciliation, including
after the submitting component unmounts. Submitted variables retain their actor,
organization, location, and exact query key. UI callbacks such as navigation
remain tied to the mounted submitter.

Operation-specific Query mutations return operation results rather than rebuilt
page payloads. Their lifecycle callbacks capture the submitted resource scope
and reconcile related queries, including when a response is lost because the
server may have committed the write. Entity patches target the matching cache
shape. Mutation identity does not come from document-head metadata. Pending
controls follow Query mutation state; submitter guards apply to notices, draft
resets, and navigation rather than preventing pending state from settling.

Page-shaped optimistic resources use scoped Query mutation overlays while writes
are pending, then reconcile the captured resource scope when writes settle.
Reads remain independent, including first navigation to a resource. Forms retain
local drafts; saved server data comes from Query. Secrets and one-time revealed
credentials stay outside reusable page caches.

## HTTP boundary

Website forms call `createServerFn` functions, not JSON companion URLs. Function
middleware applies CSRF and document identity checks. Domain boundaries enforce
session status, organization and resource authorization, rate limits, write
leases, and audit events. Organization selection is explicit input, never a
Referer hint. Deletion acquires its own exclusive lifecycle lock. Callback and
protocol requests keep their existing security checks.

Start file routes own the remaining HTTP protocols. Unsupported methods are
rejected using the matched route's own metadata before any document loader runs.
HEAD cannot consume signed verification links. A failed request is never
redispatched to render its error, because a write may already have committed.

The [HTTP inventory](./tanstack-start-http-contracts.md) records the retained
endpoints. The official API worker, MCP, OIDC, OAuth, and package-app protocols
keep their existing external contracts.

## Remaining custom code and checks

Actor verification, organization scoping, mutation dependencies, and
cache-driven head updates express Kody behavior. These are application code, not
features that adopting Start removes. Start owns HTTP and browser routing.
Shared URL builders only construct paths and do not dispatch requests. Retained
Remix imports provide cookie, schema, data-table, and HTML utilities; they do
not match website routes or dispatch website actions. User-authored package apps
may also use Remix independently of Kody's web UI.

Local [Redact](../../patches/@tanstack+redact+0.1.4.patch) and
[Router](../../patches/@tanstack+router-core+1.171.34.patch) patches are part of
the dependency maintenance cost. Upstream reviews are open for the
[Redact fixes](https://github.com/TanStack/redact/pull/43) and
[Router transition rejection](https://github.com/TanStack/router/pull/8703). The
Router proposal is narrower than the local patch: it handles a skipped animation
without retrying the navigation callback. The Redact patch removes its global
hydration scroll interceptor, which suppressed legitimate Router restoration
after user scrolling. The hydration scroll regression compares the same behavior
against React, including immediate navigation after a real wheel event. It also
sends queued updates through their Suspense boundary when an earlier ancestor
update has retained the subtree. Without that check, a departing Router match
could render after its store was cleared while the replacement route suspended.
The [paired Router regression](../../e2e/start/router-retained-match.spec.ts)
passes with React, fails with uncorrected Redact, and passes with the fix,
including resuming the replacement. The failed feature module recovery test also
checks that document recovery emits no unexpected client errors. Browser
regressions under [`e2e/start`](../../e2e/start) cover cache freshness, identity
changes, background errors, metadata, and renderer behavior.

`npm run build` verifies Redact in both bundles and rejects Kody's retired
renderer and client router. `npm run validate` runs the complete local gate. SSR
Query dehydration includes successful and pending queries, preserving streaming,
and excludes settled errors such as authorization redirects. Auxiliary protected
reads start only after their parent resource authorizes.

Passing that gate does not replace authenticated preview testing or matched
production performance measurements.

## Matched page identity

The root `beforeLoad` returns `pageLocation` on every navigation. A rendered
route reads that value from its own matched context, including while it is
retained during pending navigation. Shared page components use
[`useMatchedPageScope`](../../packages/worker/start/use-matched-page-scope.ts).
The full displayed URL is separate from normalized Query inputs. Jobs filters
and Credentials filters therefore retain their URL state without changing their
server data identity. Search controls keep an immediate React draft until their
navigation completes; functional search updates compose rapid filter changes.
Typed whitespace stays in presentation state while resource inputs normalize it.
The shell uses its committed loader location; only navigation-close effects and
requested-destination error displays use the global location. The
held-navigation regression is in
[`cache-navigation.spec.ts`](../../e2e/start/cache-navigation.spec.ts).

## Resource queries

Credentials filters are typed presentation search parameters. They share the
same actor/org/selection cache entry and do not remount the page. Confirmed
presentation-only changes skip both the access check and payload loader; actual
page entries retain fresh authorization. Credentials detail visibility depends
on the authorized list, so that aggregate stays in one RPC rather than splitting
it into two calls that repeat the same permission work.

Email has separate actor/org/filter list queries, actor/org/message detail
queries, and actor notification-destination queries. The loader starts
independent reads together. Selecting another message reuses the list and
destinations; returning to a fresh detail reuses that detail too. Cold detail
navigation uses three parallel RPCs rather than one aggregate RPC, a transport
tradeoff that must be measured rather than called a universal speedup.

Email optimistic classification is derived from Query mutation state. It does
not overwrite the shared server cache or block reads behind pending writes.
Accepted responses patch only the affected entity, and settlement reconciles
both successful and lost responses, including after unmount. Other messages can
be updated concurrently. Email reads run independently of pending writes.

The collection server boundary authenticates the original HTTP request, sharing
its request-scoped authentication lookup with middleware. A separate resource
request binds the destination organization and is checked for denial before data
access. Resource headers never establish the caller's identity.

See
[`authorization-waterfall.spec.ts`](../../e2e/start/authorization-waterfall.spec.ts)
for the delayed authorization/data concurrency regression and
[`email-resource-queries.node.test.ts`](../../packages/worker/start/pages/email-resource-queries.node.test.ts)
for resource reuse and independent request startup.

# Request lifecycle

This document explains how an incoming request moves through the system.

## Entry points

Production has two public HTTP entrypoints:

- **App origin** (`kody.codes`), `packages/worker/src/index.ts`. Start, MCP HTTP
  (`/mcp`), OAuth, inbound email, and queue consumers. Runtime-owned paths
  (package-app origin hosts and inline `/@{username}/packages/…` on the app
  origin) forward over the `RUNTIME_WORKER` service binding to `kody-runtime`.
- **Package-app origin** (`kody.run`) — `packages/worker/src/runtime-worker.ts`.
  Zone routes on that script; the origin handler does not see this host in
  production.

The routing order below is the **app-origin** handler.

The default `fetch` handler delegates to `OAuthProvider` from
`@cloudflare/workers-oauth-provider`, which means OAuth endpoints and token
infrastructure are available alongside normal app routes.

The provider requires `resourceMetadata.resource` (canonical `<origin>/mcp`).
That pins grant and access-token audiences and is the sole RFC 9728
protected-resource metadata document, served at
`/.well-known/oauth-protected-resource/mcp`. The root
`/.well-known/oauth-protected-resource` path is not an alias. Preview, local,
and production each construct a per-origin provider so the resource matches the
host the client connected to (`getAppBaseUrl`). Production refuses non-canonical
hosts (see [Non-canonical hosts](../security.md#non-canonical-hosts)), so MCP is
not served on the production `workers.dev` trigger. `APP_BASE_URL` is only the
fallback for background work with no request URL.

## Routing order

Requests are handled in this order:

0. Production canonical-host check
   (`packages/worker/src/app/canonical-host.ts`): if the runtime is production
   and the request host is not the `APP_BASE_URL` host, not a package-app
   apex/subdomain (`parsePackageAppRequestHost`), and not an `APP_LEGACY_HOSTS`
   entry, the Worker returns `404` `{ error: 'not_found' }` with
   `Cache-Control: no-store`. `GET /health` is exempt so deploy health checks
   and the status worker can probe the script on the `workers.dev` trigger.
   Preview and local skip this check. Platform and runtime workers apply the
   same rule with `/__platform/health` and `/__runtime/health` as their probe
   exemptions.
1. Package-app host isolation (see
   [Hosted package app origin isolation](../security.md#hosted-package-app-origin-isolation)):
   - On the **package-app apex**, no package code runs: `/` redirects to the app
     origin; legacy `/@{username}/packages/*` redirects to the owning user's
     subdomain; everything else is `404`.
   - On a **per-user package-app subdomain** (`{username}.<package-app host>`),
     only `/{leaf}/*` for that hostname's username is served (plus the
     handoff-token exchange on those same paths). `/` redirects to the app
     origin; every other path is `404`.
   - On the **app origin**, `/@{username}/packages/*` never executes package
     code. Anonymous visitors and signed-in outsiders stay on the app origin. A
     signed-in person who may run the app is redirected to the owner's
     package-app subdomain (or verified custom hostname) with a handoff token on
     safe methods, or a `307` on other methods.
   - Production package-app requests fail with `500` when `PACKAGE_APP_BASE_URL`
     is missing or is not on a separate registrable domain from `APP_BASE_URL`;
     package code never executes inline.
   - In confirmed local, preview, and test runtimes, an unset package-app origin
     is a no-op and package apps are served inline at step 10 below.
2. Public OAuth metadata (before `OAuthProvider`):
   - OpenID Connect discovery: `/.well-known/openid-configuration` (`GET` /
     `HEAD` / `OPTIONS`) — includes `revocation_endpoint` at `/oauth/token`
     (same URL RFC 8414 authorization-server metadata advertises) plus matching
     `revocation_endpoint_auth_methods_supported`.
   - JWKS: `/.well-known/jwks.json` (`GET` / `HEAD` / `OPTIONS`)
   - Client ID Metadata Document: `/oauth/client-metadata.json` (`GET` / `HEAD`
     / `OPTIONS`) — Kody-as-client CIMD. Served from the request origin so
     `client_id` matches the fetch URL.
   - Official CLI CIMD: `/oauth/cli-client-metadata.json` (`GET` / `HEAD` /
     `OPTIONS`) — `@kodycodes/cli` presents this URL as `client_id`. Loopback
     redirect is `http://127.0.0.1:43742/callback`.
3. OAuth authorization endpoints:
   - `/oauth/authorize`
   - `/oauth/authorize-info`
   - `/oauth/callback`
4. Browser noise endpoint:
   - `/.well-known/appspecific/com.chrome.devtools.json` (returns 204)
5. OAuth protected resource metadata (inside `OAuthProvider`, path-aware only):
   - `/.well-known/oauth-protected-resource/mcp`
6. MCP endpoint:
   - `/mcp` (requires OAuth bearer token; `OAuthProvider` `apiRoute`). Missing
     Bearer credentials are short-circuited with a JSON `401` (Gemini-friendly)
     before the library's empty-bodied challenge. After authentication,
     `packages/worker/src/mcp-auth.ts` routes by protocol era: 2025-era requests
     go to the sessionful `MCP` Durable Object (`McpAgent`, MCP SDK v1) hosted
     on `kody-platform` and reached through the `MCP_OBJECT` binding, and
     `2026-07-28` envelope requests are served statelessly per request by
     `packages/worker/src/mcp/stateless-lane.ts` (MCP SDK v2, no Durable
     Object). Tokens that lack the resource's `requiredScopes` (OIDC baseline)
     get the library `insufficientScope()` step-up `403`. Both lanes share one
     tool registration; every authenticated request records a lane data point to
     the `MCP_PROTOCOL_EVENTS` Analytics Engine dataset for dual-lane traffic
     measurement (see
     [decision 0005](../decisions/0005-mcp-dual-lane-stateless-migration.md)).
     The origin script owns no Durable Object classes
     ([ADR 0034](../decisions/0034-origin-owns-no-durable-objects.md)). MCP
     `execute` looks up `KodyFetchGateway` on `ctx.exports` of the script that
     **owns** `MCP` — that is `kody-platform`. Origin
     `POST /__maintenance/execute-smoke` is **origin-only**: it uses origin
     `ctx.exports` and returns `scope: "origin-only"`,
     `proves: "origin-kody-fetch-gateway"`, and `notMcpExecute: true`. A passing
     smoke does not prove MCP execute health. Authenticated execute evidence is
     the traffic-backed heartbeat plus the hourly
     `POST /__maintenance/mcp-execute-health` fallback (legacy `/mcp` execute
     with a dedicated canary token). The public card is recent for one hour
     after organic or synthetic success; organic traffic alone is enough. Public
     health and status GETs do not run that probe. A status-page snapshot older
     than the one-minute skip window may re-read origin `GET /health/components`
     `executeEvidence` (never execute) so organic last-success is not one cron
     tick behind the live heartbeat. Persist merges with any newer timestamp
     written while that fetch was in flight.
   - Catchable throws while serving `/mcp` (including through `OAuthProvider`'s
     `apiHandler`) are mapped to an HTTP JSON-RPC `-32603` Internal error
     response on the same connection so MCP clients see a failed request instead
     of an OAuth `{ error: "server_error" }` body or a Cloudflare 1101 from a
     rethrown exception. Real OAuth routes keep their RFC 6749 error shape.
     Isolate kills are outside this catch.
7. Public `@username` ingress handled in `packages/worker/src/index.ts` before
   the OAuth provider / app router (needs `ExecutionContext` for background
   work). Production forwards package-app paths to `kody-runtime` via
   `RUNTIME_WORKER`; webhook ingress stays on origin:
   - `POST /@{username}/webhooks/:packageKodyId/:webhookName/:urlSecret` —
     inbound package webhooks (see [Inbound webhooks](./webhooks.md))
   - Retired `/@{username}/connectors/...` paths return `404`. Use outbound MCP
     servers (`kody.mcp[...]`) for home automation and similar tools.

8. Static assets:
   - Served from `ASSETS` for `GET` and `HEAD` when the path can be a file under
     `packages/worker/public/` (for example `/favicon.ico`, `/images/…`,
     `/fonts/…`, `/styles.css`, `/assets/…`)
   - The origin skips that probe when the first segment is an app route root, an
     `/@…` org or package path, or a pre-router mount (`/mcp`, `/api`, `/oauth`,
     `/connectors`). Those prefixes have no static twin. `/og/…` still probes
     because `public/og/` sits beside the `/og/:page.png` route
   - Matching files are asset-first at the edge unless listed in
     `assets.run_worker_first`
9. Hosted package apps served inline on the app origin
   (`/@{username}/packages/*`), only in confirmed non-production runtimes when
   `PACKAGE_APP_BASE_URL` is unset.
10. App server routes:

- Everything else is handled by `packages/worker/start/http-entry.ts`
- Public agent-discovery documents (Worker-first, origin-aware) include
  `/robots.txt`, `/sitemap.xml`, `/auth.md`,
  `/.well-known/mcp/server-card.json`, `/.well-known/api-catalog`,
  `/.well-known/agent-skills/index.json`, skill markdown under
  `/.well-known/agent-skills/:skillId/SKILL.md`, `/.well-known/security.txt`,
  and OpenAI Apps domain verification at `/.well-known/openai-apps-challenge`
  (unauthenticated `text/plain` token). The homepage adds RFC 8288 `Link`
  headers to those documents and serves markdown when `Accept` prefers
  `text/markdown`. DNS-AID (`_mcp._agents.<apex>` SVCB/HTTPS) is zone DNS, not a
  Worker route.

## Package-app realtime (WebSocket)

A browser `new WebSocket('wss://{username}.kody.run/{leaf}/ws[/facet]')` reaches
`kody-runtime` directly through the `*.kody.run` zone routes (inline dev/preview
reaches it through the origin `RUNTIME_WORKER` forward).
`servePackageAppRequest` recognizes the upgrade (`Upgrade` compared
case-insensitively) before any package `app_fetch` runs and calls
`packageRealtimeSessionRpc(...).connect`, which forwards to the
`PackageRealtimeSession` Durable Object. The DO runs the package connect hook
(one `app_realtime` run) and returns `101` with the client socket.

workerd sends any `fetch` that carries `Upgrade: websocket` as a WebSocket
handshake and **drops the request body**, so the DO connect payload (binding,
facet, browser request) travels in the `X-Kody-Realtime-Connect` header, never
the body. Only a real cross-isolate stub call proves this; calling the DO
instance's `fetch` in-process keeps the body and hides the bug
(`realtime-session.workers.test.ts` uses the real stub).

Post-deploy check for a package with realtime hooks (for example PR Desk):

1. `GET https://kody.run/__runtime/health` reports the merge `commitSha`.
2. Open `https://{username}.kody.run/{leaf}` signed in. DevTools → Network → WS
   shows the `/ws` request with status `101 Switching Protocols`.
3. From Kody MCP, `runList` for that package with `surface: 'app_realtime'`
   since the reopen shows a connect run, and `sessionList({ package_id })` lists
   the open session.

A non-101 `/ws` with no `app_realtime` row means the host or DO failed before
the hook ran (look for Sentry `package_app.phase: realtime-connect`). An
`app_fetch` `426` row on `/ws` means the upgrade was not recognized and fell
through to package code.

## Workflow runtime

All server-side Kody runtime contexts expose `workflows` from `kody:runtime`.
The helper routes every call to the shared `DynamicCallableWorkflow` binding;
there is no separate context-specific Workflow class.

- `workflows.create({ code, workflowName?, runAt, idempotencyKey, params })`
  queues an inline ESM module and later executes it through the same module
  loader used by `execute`. Omitted `workflowName` falls back to `inline-code`.
- `workflows.create({ exportName, packageId?, workflowName?, runAt, idempotencyKey, params })`
  queues a saved-package export invocation. Package runtime contexts resolve
  `packageId` from `packageContext`; ad hoc contexts must pass it explicitly.
  Omitted `workflowName` falls back to the export path.
- The hub verifies saved-package ownership before queuing export-backed
  workflows and records recent workflow rows for `workflowRunList`.

## App server flow

`packages/worker/start/http-entry.ts` validates environment variables and
configures session cookie signing (`COOKIE_SECRET`) before creating the app
router.

Authenticated requests share request-scoped identity resolution. The Start root
route verifies identity and loads shell presentation through Query. Server
functions enforce page and resource authorization before returning payloads.
Anonymous callers receive registry flag defaults without touching D1.

`packages/worker/start/server/protocol-handlers.ts` adapts retained HTTP
protocol services for the native Start routes. Website reads and mutations use
server functions, with no parallel action route table. Web documents render
through `packages/worker/start/server.ts` and the native route tree. See
[web app rendering and server state](../tanstack-start.md) for navigation and
cache ownership.

## Anonymous marketing HTML cache

The native HTTP entry sets
`Cache-Control: public, max-age=60, stale-while-revalidate=300` and
`Vary: Cookie` for anonymous `/`, `/pricing`, `/blog`, `/community`,
`/onboarding`, `/docs`, and `/docs/:slug`. Origin `fetch` stores those
cookie-less `GET`/`HEAD` responses in the Cache API (`caches.default`), keyed on
the canonical origin + pathname + search and a `__accept=html` marker. Requests
whose `Accept` prefers `text/markdown` (`prefersMarkdown`) skip the store. A
matching HTML request with no `kody_session` cookie and no `Authorization`
header is served from that store (`X-Kody-Cache: HIT`) without running the app
handler. A miss runs the handler and, when the response is `200` `text/html`
with no `Set-Cookie` and already carries that Cache-Control, `ctx.waitUntil`
buffers a clone and stores it only once the body has reached `</html>`
(`isCompleteHtmlDocument`); a streamed document that stopped early (render
failure, client abort) is never shared. The stored copy drops `Vary: Cookie`
because Cloudflare's Cache API does not use `Vary` as a key (the lookup already
excludes cookie-bearing requests). Hits restore the browser-facing `Vary` from
the miss (`Cookie`, plus `Accept` on negotiated routes). Browser-facing
`Cache-Control` is unchanged. `Cache-Control: no-cache` on the request skips the
lookup so e2e can assert fresh HTML. Under `WRANGLER_IS_LOCAL_DEV=true`
(`npm run dev`, the Playwright web server) the store is bypassed entirely:
workerd honors `stale-while-revalidate` and persists `caches.default` under
`.wrangler/state`, so a stored page would keep replaying for minutes after the
edit that changed it. The `workers-unit` suite still exercises the store.

The public package surfaces (`/@:username/:kodyId`,
`/@:username/:kodyId/tree/:ref/*`, `/@:username/:kodyId/raw/:ref/*`,
`/community/:id`, `/community/:id/files/*`, `/community/:id/raw/*`) are shared
too, but with `public, max-age=60` and no stale-while-revalidate
(`anonymousDocumentCache: 'visibility'`): an owner can unpublish or make a
package private and nothing purges shared caches, so a stale public response is
bounded to one minute. They are shared only when the document is a `200` (a
`401` or `404` to a stranger stays `no-store` so making a package public takes
effect at once). The Cache API store is HTML-only. Landing-hero video metadata
is KV-cached with SWR on the homepage load. The response stays `no-store` when
the request carries a `kody_session` cookie, `loadSessionInfo` resolves a
session, or the response sets a cookie. Auth, OAuth, account, and every other
HTML path stay `no-store`.

## Request context

`handleRequest` wraps the router in `runWithRequestContext`
(`packages/worker/src/request-context.ts`): an `AsyncLocalStorage` store, also
keyed by `Request`, holding a per-request memo and the Server-Timing entries.
`memoizePerRequest` dedupes lookups a page needs more than once — the package
handler, the streaming `community-detail` frame, and the files loader all
resolve the same `loadPackagePage`, and the tree page resolves the same
Artifacts HEAD from two loaders. Callers that hold the `Request` pass it, since
SSR frames render after the async scope has exited; repo-layer code without a
request falls back to the store. Without any context the helpers just run the
load, so unit tests and jobs are unaffected.

## Page Server-Timing

Loaders record request-scoped phases (`{ name, durationMs, desc? }`, same helper
as execute) through `recordServerTiming` on the request context. Package-app
serving attaches those entries as `Server-Timing`. Cloudflare may append
`cfEdge` / `cfOrigin` / `cfWorker`. App phases include:

- `session` — `loadSessionInfo`
- `ssr` — route preload, stylesheet, and starting the HTML stream
- `highlight` — token batch (`desc` is `hit`, `worker`, `miss`, or `fallback`)
- `listings` — onboarding featured/chooser load
- `package-page` — `loadPackagePage` (URL resolution, viewer, listing and owner
  detail), recorded once per request thanks to the memo; nested inside it:
  `resolve-url`, `auth`, `listing` (public listing + source row on a data-cache
  miss), `artifacts-head` (cached default-branch HEAD), `owner-package`
- `owner-readme` — README read from the owner's published source snapshot
- `files-route` — tree URL canonicalization for `/tree/:ref` and `/files`
- `files` — tree snapshot read (KV, then the listing pin snapshot)

Loader phases recorded through `recordServerTiming` land on the request context.
Package-app responses merge them into `Server-Timing`. The weekly site-perf
collector reads that header on marketing HTML.

Signed-in `/onboarding` derives the setup checklist from verification, inbound
MCP OAuth grants (first and second host), a Step 2 access win (memory, execute,
or saved package), and the saved-package meter. The payload also includes
featured community listings so persist-prompt copy can name an already-installed
example, plus a known memory subject or saved-package name when one exists so
Step 3 can show that artifact. The optional first-win email loop is not a
checklist item and does not run Mailbox probes on this page. See
[onboarding process](./onboarding.md).

Durations use `Date.now()`, which Workers only advance across I/O. The weekly
site-perf collector records these phases; it does not budget them.

## Syntax highlighting

Browser pages that show code — markdown bodies on guides, blog posts, and
community READMEs, onboarding MCP config snippets, and JSON dumps on account
jobs/activity — highlight with [Shiki](https://shiki.style/) on the
`kody-highlight` worker. Origin loaders POST snippets over the `HIGHLIGHT`
service binding (`POST /highlight`) and attach serializable token trees to
loader/API data. The browser only paints those tokens as JSX text and inline
styles — never `innerHTML` — so untrusted README fences stay inside the markdown
safety model. Light and dark tokens follow `prefers-color-scheme` via CSS
variables in `packages/worker/public/styles.css`. Shiki grammars are not part of
the browser bundle; missing tokens render as escaped plaintext in the same
wrapper. Both origin and the highlight worker cache token batches keyed by
highlighter version.

## Client-side navigation flow

TanStack Router owns app navigation, route matching, preloading, history, and
scroll restoration. Internal links use
`packages/worker/start/components/site-link.tsx`. Route loaders ensure
destination Query data before rendering. Query owns cached server state, with
actor and organization scope included in resource keys. Mutations update or
invalidate the affected resources through their Query lifecycle, including when
the initiating component unmounts.

See [web app rendering and server state](../tanstack-start.md) for cache policy,
authorization, and mutation ownership, and
[no-flash navigation](../no-flash-navigation.md) for stylesheet readiness and
Back/Forward behavior. The native route tree lives in
`packages/worker/start/routes/`.

## CORS behavior

`packages/worker/src/index.ts` wraps the handler with `withCors`
(`getCorsHeaders`):

- For `/mcp`, any `Origin` is reflected so browser-hosted remote MCP clients can
  connect: allowed methods are `GET, HEAD, POST, DELETE, OPTIONS`, allowed
  headers include the MCP protocol headers, and `WWW-Authenticate` /
  `Mcp-Session-Id` are exposed so clients can read the OAuth challenge.
- For every other path, CORS headers are only added when `Origin` exactly
  matches the request origin; allowed methods are `GET, POST, OPTIONS` and
  allowed headers include `content-type` and `authorization`.

This keeps cross-origin behavior narrow while allowing same-origin browser and
API requests, plus the deliberate `/mcp` exception.

## Observability (Sentry and Workers tracing)

The Worker default export is wrapped with `Sentry.withSentry` from
`@sentry/cloudflare` (see `packages/worker/src/index.ts`) so incoming `fetch`
requests are traced and uncaught errors can be reported when `SENTRY_DSN` is
configured.

The **MCP** (`MCP` / `MCP_OBJECT`) Durable Object is wrapped with
`Sentry.instrumentDurableObjectWithSentry` (see
`packages/worker/src/mcp/index.ts`) because it runs in a separate isolate from
the top-level Worker.

The MCP server flow adds one more Durable Object:

- The MCP client hub Durable Object terminates outbound websocket connections to
  user-configured MCP servers and proxies JSON-RPC/MCP requests over those
  sockets.

The runtime capability registry **merges** synthesized domains from enabled
**MCP client servers**. See [MCP client servers](./mcp-client-servers.md).

Shared options are built in `packages/worker/src/sentry-options.ts`: **release**
comes from `APP_COMMIT_SHA` when set (deploy workflows pass it as a var), and
**environment** defaults from `SENTRY_ENVIRONMENT` in
`packages/worker/wrangler.jsonc` per deploy target.

MCP tools emit structured `mcp-event` logs via
`packages/worker/src/mcp/observability.ts`. On failures, the same module sends
Sentry events at **error** severity (with MCP tags and context). Failures the
caller can clear from the message alone — `McpCallerError`,
`failurePhase: 'parse_input'`, or an explicit `callerError` payload flag,
including sandbox user-code failures — stay on the structured `mcp-event` log
line and never reach Sentry; genuine platform failures still do. New "not found
/ bad argument" throw sites in `packages/worker/src/mcp/**` should use
`McpCallerError`.

`search` also publishes exclusive wall-clock tiles (`rateLimitMs`,
`usernameLookupMs`, `identityResolutionMs`, `loadAndRankMs`, suffix stamps,
`waitingItemsMs`, `formattingMs`) plus `exclusiveMs` / `unaccountedMs` so named
phases reconcile against `timing.durationMs`. Overlapping detail (memory,
retrievers, candidate plugins) stays beside those tiles and is not summed. Each
call writes one privacy-safe point to `MCP_SEARCH_EVENTS` (see
[Usage metering — MCP search duration](./usage-metering.md#mcp-search-duration)).
Operators asking "is search slow this hour?" query that dataset; UWD `retriever`
surface attribution is unchanged and does not measure search latency.
`/admin/insights` has no search-latency chart. The same page does show the
onboarding funnel (`ONBOARDING_FUNNEL_EVENTS`): unique users per stage for the
last 7 and 28 days. See
[Usage metering — Onboarding funnel](./usage-metering.md#onboarding-funnel).

Authentication and authorization denials are deliberately **not**
`McpCallerError`. `/mcp` rejects anonymous callers at the transport before any
capability runs, so a denial reaching a handler means an internal caller built a
context without a user — a defect worth an issue. Attack visibility for these
lives in the audit log rather than the error stream; see
[Security](../security.md).

### Workers native tracing (OpenTelemetry)

`packages/worker/wrangler.jsonc` also enables
[Workers automatic tracing](https://developers.cloudflare.com/workers/observability/traces/)
(`observability.traces.enabled`, beta). The runtime emits OTel-standard spans
for handler invocations, outbound fetches, and binding calls (D1, KV, R2,
Durable Objects, queues) with no SDK in the bundle; traces appear in the Workers
Observability dashboard next to Workers Logs, and `console.*` output inside a
span is attributed to that span. Custom spans are available via
`tracing.enterSpan()` from `cloudflare:workers` when application-level spans are
worth adding. App-level context rides on two hooks: every metered usage event
emits a `kody.usage.{eventType}` child span with `kody.user_id` and entity
attributes (see [usage-metering.md](./usage-metering.md)), and Sentry error
events carry the signed-in user id (id only, no PII) via `Sentry.setUser` in the
app auth resolver and the MCP failure reporter.

Production deploys additionally export these traces to Sentry through the
account-level `sentry-otlp-traces` destination; preview and test deploys inherit
the top-level block without a destination, so their spans stay in the Cloudflare
dashboard. The destination itself (endpoint, auth header, fork provisioning) is
documented in [setup-manifest.md](../setup-manifest.md), and the
`SENTRY_TRACES_SAMPLE_RATE` handling (production pins it to `0` to avoid
duplicate SDK traces) in
[environment-variables.md](../environment-variables.md).

Billing note: each span is one observability event sharing the Workers Logs
quota (10M events/month included on Workers Paid). Sampling is controlled by
`observability.traces.head_sampling_rate` (defaults to full sampling, fine at
current traffic).

### Browser errors and session replay

The client bundle initializes `@sentry/browser` from a `kody:sentry` meta tag
that `packages/worker/start/routes/__root.tsx` renders when `SENTRY_DSN` is
configured (the DSN is a publishable client key), except under
`WRANGLER_IS_LOCAL_DEV` so Vite HMR noise does not report as production. Capture
is errors plus **error-only Session Replay**: `replaysSessionSampleRate` is `0`
and `replaysOnErrorSampleRate` is `1`, so nothing is recorded to Sentry unless
an error occurs, and replays mask all text and block all media
(`packages/worker/client/sentry-client.ts`) because Kody sessions contain
personal content. Envelopes are sent through the same-origin
`POST /sentry-tunnel` route
(`packages/worker/src/app/handlers/sentry-tunnel.ts`), which only forwards
envelopes whose DSN matches the Worker's own `SENTRY_DSN` — this keeps the
first-party CSP at `connect-src 'self'`. Because that DSN is public, the route
is also rate limited per IP before it buffers a body (see
[security.md](../security.md)). The CSP allows `worker-src blob:` for the replay
compression Web Worker.

### Source maps

`packages/worker/wrangler.jsonc` sets
[`upload_source_maps`](https://developers.cloudflare.com/workers/wrangler/configuration/#source-maps),
and production deploys pass
`--outdir .wrangler/sentry-bundle --upload-source-maps` so the bundle + maps are
generated consistently. Wrangler resolves that `--outdir` against the config
file's directory, so platform and runtime maps land under
`packages/platform-worker/.wrangler/sentry-bundle` and
`packages/runtime-worker/.wrangler/sentry-bundle`. Origin maps come from
`vite build` (`dist/ssr` plus `dist/client`). `npm run deploy` from a laptop is
origin-only.

To symbolicate stack traces in **Sentry** (not only in Cloudflare), configure
[Cloudflare source maps in Sentry](https://docs.sentry.io/platforms/javascript/guides/cloudflare/sourcemaps/):
add GitHub **repository variables** `SENTRY_ORG` and `SENTRY_PROJECT`, a
`SENTRY_AUTH_TOKEN` **secret** with release upload scopes, then CI runs
`npm run sentry:upload-sourcemaps` after deploy using the same **release** as
`APP_COMMIT_SHA`. Sibling-only deploys upload the worker bundles that exist and
skip client maps when origin Vite did not run.

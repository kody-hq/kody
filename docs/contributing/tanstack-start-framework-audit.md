# Website framework ownership audit

This inventory describes the migration source, including the current cleanup
slice. It is not a claim that CI, the deployed preview, every browser state, or
visual parity has passed. See the
[HTTP contracts inventory](./tanstack-start-http-contracts.md) for retained
external URLs and their consumers.

## What Start owns

Paths below are relative to `packages/worker/`.

| Responsibility                                            | Current owner and evidence                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website route matching, navigation and document rendering | `start/routes/`, generated `start/routeTree.gen.ts`, `start/router.tsx`, and `createStartHandler` in `start/server.ts`.                                                                                                                                                                                                                  |
| Retained website HTTP protocols                           | Native route `server.handlers` call operations in `start/server/protocol-handlers.ts`. The HTTP inventory distinguishes these from obsolete website JSON endpoints.                                                                                                                                                                      |
| Method rejection                                          | `start/route-method-middleware.ts` and `start/server/route-method-policy.ts` inspect the matched Start route's handlers. They do not maintain a second URL dispatch table.                                                                                                                                                               |
| Website reads and mutations                               | `createServerFn` modules in `start/server/` call domain operations. `start/server/mutation-context.ts` centralizes authenticated identity, explicit organization binding and mutation write leases. Direct endpoint authorization remains necessary independently of navigation guards.                                                  |
| Shared request protections                                | `start/start.ts` installs Start request/function middleware. `start/server/document-policy.ts` applies organization denial, referral cookies and protocol write leases. Server functions skip the outer lease and enforce their own mutation lease.                                                                                      |
| Admin access                                              | Admin read functions call `start/server/admin-page-context.ts` before reading protected data. `start/server/admin-index.ts` checks authorization before redirecting to users. `start/server.ts` no longer dispatches authorization by an `/admin` pathname prefix. Admin mutation operations keep their separate role/permission checks. |
| Browser server state                                      | `start/page-query.ts`, resource query modules and mutation hooks use Query. Route loaders prepare the same query records used by components. This inventory does not establish that every invalidation dependency is correct.                                                                                                            |
| Document metadata                                         | Native routes/server readers select explicit semantic keys through `start/server/document-head.ts` and `universal/document-head.ts`. The metadata resolver no longer rematches URL patterns.                                                                                                                                             |
| URL creation                                              | `universal/routes.ts` supplies typed href builders. It is not the incoming request router.                                                                                                                                                                                                                                               |

The origin worker still owns infrastructure protocols such as MCP, OAuth/OIDC,
WebSockets and package-app hosting. The API worker owns the official REST API.
These do not need to become website server functions.

## Policies around Start's final response

`start/server.ts` supplies the request nonce and applies CSP/security headers,
cache policy, negotiated-document `Vary`, discovery headers, OAuth cookies and
status handling. It also strips HEAD bodies. These are deployment and HTTP
representation policies, not a second page router.

`start/http-entry.ts` establishes worker request/deferred-work context and error
reporting. It enforces `private, no-store` on the final RPC response, including
redirects serialized after request middleware returns. Its fatal-error path must
not redispatch a request that could already have committed a write.

These wrappers remain custom application code. Moving a policy into native
middleware is useful only if its timing still covers the final serialized
response, cookies, streaming status and error paths. They should not be counted
as removed simply because the renderer is Start.

## Remaining URL-shaped function inputs

Native transport does not automatically remove the old loader-oriented API
shape. These are concrete follow-up targets, not evidence of internal HTTP
fetches or a remaining Remix dispatcher:

| Modules under `start/server/`      | Remaining coupling                                                                 | Appropriate shape                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `oauth.ts`                         | OAuth authorize protocol parameters are forwarded through a reconstructed request. | Keep the external OAuth contract; separate protocol fields from the original authenticated request in the shared reader. |
| `org-alias.ts`                     | Destination URLs identify redirects.                                               | Retain URLs where navigation is the domain input.                                                                        |
| `static-page.ts`, metadata helpers | Pathnames identify static presentation/canonical URLs.                             | Pathnames are appropriate for operations about a page URL.                                                               |

Community and profile readers require typed filter inputs. Package reads retain
original requests and explicit resource identity. Community memoization includes
filter inputs even when reads share the same request. Session verification takes
organization scope from native matched routes and independently checks access.
Jobs, workflow cancellation, experiments and MCP OAuth client
creation/revocation use operation-specific typed inputs instead of action intent
dispatch.

Account collections, connection usage, credentials, and email take explicit
organization, record, selection and filter fields. The `loadCollection(href)`
helper and its fabricated destination Request are removed. Scoped and personal
read contexts keep the original authenticated request. Domain authorization
still runs independently of route navigation. Query mutation barriers,
invalidation and optimistic updates recognize typed organization inputs, keeping
actor and workspace boundaries intact.

Package-file readers take a discriminated resource input from native route
parameters. Location is separate and used for canonical redirects, login return
URLs and metadata, not resource selection. The unused packages-index read
function was deleted, its native alias route already owns that redirect.

The admin users reader uses explicit filters, page size, selected user and a
separate return destination. Pagination keys include actor and page size.
Billing completion takes organization and checkout session fields, checks the
original principal, and owns a write lease for both SSR and RPC. The outer
protocol boundary no longer leases billing success a second time. Login/signup
accepts only an optional return destination. Legacy org aliases retain
destination URLs because they are redirects, but session lookup uses the
original request.

Connect, consent and filtered admin readers separate validated resource inputs
from navigation destinations. OAuth callback restore preserves its
no-account-read branch. Organization management binds explicit slugs to the
original principal; repository reads use explicit filters. Account mutations
keep the original request and pass typed refresh/approval data to domain
operations. The obsolete URL-based secrets reader is removed. Website mutations
use operation-level APIs without reviving HTTP action endpoints. The remaining
broad leaf input contracts are listed below.

The separate signed-token cleanup slice keeps `start/server/action-page.ts` but
replaces generic `loadActionPage(href)` dispatch with `loadVerifyEmail`,
`loadVerifyEmailChange`, `loadVerifyEmailClaimRelease`,
`loadVerifyEmailDestination` and `loadUnsubscribeTips`. Inputs are typed tokens,
plus a return destination for email verification. Shared domain operations use
the original request context. Native routes retain non-consuming HEAD behavior
and disabled prefetch; unsubscribe keeps its external POST contract. The
implementation is included in this cleanup; runtime verification remains
dependent on CI.

## Remix imports that are utilities

Current examples are `remix/cookie` in `src/app/auth-session.ts`,
`oauth-login-state.ts`, `verify-session.ts` and `package-app-session.ts`;
`remix/data-schema` in environment/form/domain validation; `remix/data-table` in
database schema/query helpers; and `remix/html-template` / `remix/response/html`
in minimal error responses and package-app response helpers. These do not own
website route matching, hydration, data loading or navigation.

A repository-wide search also finds Remix component/router imports inside
`src/test-support/remix-package-app-fixture.ts`. Those are source strings for a
hosted package-app fixture, not Kody website runtime imports. The client and
worker TypeScript configurations use React JSX defaults; references to the
deleted backend router and SSR document have been removed.

## Evidence and limits

This audit comes from source inspection. The admin cleanup has server and
server-test TypeScript checks and lint checks; browser regressions were added to
`e2e/admin-rbac.spec.ts` for CI. Local runtime tests were not run at the user's
request. Deployment parity, HTTP status behavior and visual results still need
the corresponding CI and preview evidence. No claim of universal parity or a
measured performance gain follows from this ownership inventory.

## Remaining mutation API cleanup

Account integrations, connected agents, MCP server management, secrets, package
writes and organization management have named native operations. Admin user
management, feature flags, reserved usernames, provider marks, platform
integrations, community report moderation and system email also use named
operations with validated fields. Their domain operations retain independent
role or permission checks. Operation selection may still happen in a local UI
callback, but it is not an action discriminator sent to a generic server
function.

Billing checkout, credit top-up, credit settings and cancellation feedback now
accept explicit validated fields. Scoped billing writes retain organization
binding and the domain's billing permissions. All these native admin and billing
writes use the original authenticated request and `withWebsiteMutation`,
including its deletion check and account write lease. Provider credentials and
logos retain omitted-versus-cleared semantics; feature flag note and audience
fields retain their omission behavior.

This is not a claim that all input contracts are finished. Admin codemod run and
stop functions still accept broad records. Admin users and system-email writes
still carry search separately to refresh their current filtered page, and
construct a canonical URL for the shared data reader and audit path. That URL
does not replace the authenticated request. Several shared domain helpers still
accept individual `unknown` fields or a billing `body` argument behind the
validated native boundary. Shared validation and business authorization remain
useful, while these broad contracts are further simplification targets.

The mutation hooks keep their existing actor/scope barriers and query
invalidation. Feature flag changes refresh permissions and shell state; credit
settings refresh the usage record and invalidate billing data. Source review
found no new authorization bypass or dropped field in this cleanup, but CI and
preview verification remain required evidence of runtime behavior.

Against main `8b1ff60cc`, the deleted client router contains 1,344 lines, intent
prefetch contains 265 lines, and the deleted backend router contains 780 lines.
That is 2,389 lines across those three retired files, not a net migration size
claim. Native routes and operation code replace their responsibilities.

The exported shared secret reader uses `createServerOnlyFn`. This boundary keeps
credential services and the image renderer out of the browser graph. Package
operations preserve domain response status and structured recovery fields.
Organization people mutations invalidate actor-scoped typed organization query
keys, including the organization in each key.

Passkey deletion and renaming, two-factor
setup/confirmation/cancellation/disable, package collaborator
grants/revocations, and five package webhook operations use named native and
domain functions. Webhook operations share authorization and audit context
through callbacks, rather than a switch that selects the write. Webhook approval
and rejection are separate functions. Approval bundle decisions retain their
typed approve/deny value because it describes one domain decision.

Credential proposals and mapping inputs are validated structured values instead
of URL search strings and unknown arrays. Signed proposal, fingerprint, scope,
and atomic-write checks remain in the domain. OAuth session and organization
reads retain the original request; only the external authorization parser gets
an adapted protocol request when needed.

The secret creation alias now builds the canonical organization credential URL
from explicit creation fields. It preserves allowed hosts, package restrictions,
provider, description and expiry instead of rewriting allowedHosts as hosts. The
route organization remains authoritative over any query-string org.

Main’s URL-only organization behavior is ported to native routes. Header
ordering uses route scope or the personal organization, the Organizations page
has no current badge, community installation targets the personal organization,
and no navigation commit writes a remembered-organization cookie.

The latest source pass moves shell gutters, auth/focused layout, and
public-route session verification policy onto native route staticData. Root
loader data captures the destination shell policy so pending navigation cannot
restyle the committed page. Unspecified routes still require session
verification; public document exceptions consult the document catalog using
decoded route params.

Mutation cache filters use structured organization identity instead of parsing
href strings. This fixes both cross-org over-invalidation and missed updates
where callbacks still expected the retired string query keys. Mutation variables
retain their initiating scope across later navigation.

The obsolete non-Start Remix JSX compiler is removed. Remaining non-Start TSX
modules contained no JSX and are plain TypeScript helpers. Hosted user-package
Remix fixtures remain separate from the website runtime.

Organization authorization scope is now declared by all 53 native organization
routes. The root reads typed metadata and decoded parameters instead of parsing
route names. Resource routes preserve their authorization section, while
management routes preserve organization-only verification.

Main's distinct personal-organization identity changes are carried into the
extracted account export and credits readers. Account exports distinguish the
storage owner from the acting person, and credits identify the personal
organization from the authenticated user's stamped organization ID.

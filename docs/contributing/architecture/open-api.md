# Open API

The Kody Open API is the public HTTP surface at `https://api.kody.codes`. Most
operations serve JSON: `GET /openapi.json` (OpenAPI 3.1) and the versioned `/v1`
operations. `POST /v1/capability-proxy/gateway-fetch` is a native streaming hop:
the request body is the outbound fetch body, and a successful response is the
upstream HTTP response, not a JSON envelope. Interactive HTML docs live on a
separate Worker at `https://api-docs.kody.codes` (Scalar). The same JSON
operations back the MCP `api` tool. CapabilityProxy, the streaming gateway-fetch
hop, and package-graph are the local-execute HTTP surfaces (`@kodycodes/cli`).

There is no account UI for API token management — mint, list, and revoke via the
CLI / MCP `api` tool only.

## Workers

```mermaid
sequenceDiagram
  participant B as Browser
  participant D as kody-api-docs
  participant C as Client (CLI, script)
  participant E as kody-api (edge)
  participant O as kody-production KodyApi
  participant DB as D1 / capabilities
  B->>D: HTTPS api-docs.kody.codes
  D->>E: GET /openapi.json (proxy)
  E->>O: service binding KODY_API
  O-->>E: OpenAPI JSON
  E-->>D: OpenAPI JSON
  D-->>B: Scalar HTML + proxied spec
  C->>E: HTTPS api.kody.codes
  E->>E: CORS, path + method allowlist, rate limits, body caps
  E->>O: service binding KODY_API (allowlisted headers only)
  O->>DB: authenticate token, permission check, operation
  O-->>E: operation result
  E-->>C: response (no Set-Cookie)
```

- `kody-api` (`packages/api-worker/`) is a thin edge script on the
  `api.kody.codes` custom domain. It answers `/health` itself, allows only `/`,
  `/openapi.json`, and `/v1/*`, applies per-IP (`API_IP_RATE_LIMITER`, 600/min)
  and per-token (`API_TOKEN_RATE_LIMITER`, 300/min, keyed by API token id or a
  SHA-256 of an opaque Bearer such as CLI MCP OAuth — never the secret
  plaintext) limits, caps buffered bodies at 5 MiB (413) on JSON routes, and
  forwards only `Authorization`, `Content-Type`, `Accept`, `User-Agent`, and
  `CF-Connecting-IP` on those routes. `POST /v1/capability-proxy/gateway-fetch`
  also forwards the allowlisted gateway headers (`X-Kody-Gateway-Url`,
  `X-Kody-Gateway-Method`, `X-Kody-Gateway-Package-Id`,
  `X-Kody-Gateway-Headers`, `x-kody-secret-resolution`) and does not apply the 5
  MiB buffered-body cap; it still respects the Cloudflare Worker upload limit
  (~100 MiB Free/Pro) and returns JSON `413 payload_too_large` when
  `Content-Length` exceeds that limit (see the
  [CLI streaming gateway-fetch contract](../contracts/cli-streaming-gateway-fetch.md)).
  `Cookie` and other `X-Kody-*` headers never reach origin, and origin
  `Set-Cookie` never reaches the client. CORS allows any origin because auth is
  bearer-only. It never serves HTML.
- `kody-api-docs` (`packages/api-docs-worker/`) is the interactive docs host on
  `api-docs.kody.codes`. It serves a Scalar shell at `/`, proxies
  `/openapi.json` from the live API, and answers `/health`. DNS and the
  certificate come from `custom_domain: true` on deploy (same as
  `api.kody.codes`).
- Origin exports `KodyApi` (`packages/worker/src/open-api/kody-api.ts`), a
  `WorkerEntrypoint` that lazy-loads the handler so the origin startup budget
  does not pay for it. Operations run on origin so they share the capability
  registry, D1, and account gates with MCP. The Start website does not call the
  Open API; both use the same domain modules. The OpenAPI document's
  `externalDocs` points at `https://api-docs.kody.codes`.
- Custom domains create their own DNS record and certificate on deploy, so
  `api.kody.codes` and `api-docs.kody.codes` need no manual DNS step as long as
  no conflicting record already exists in the `kody.codes` zone. Previews deploy
  `kody-pr-<n>-api` on `workers.dev`, bound to that preview's origin. API docs
  are production-only (they always proxy the live OpenAPI document).

## Operations

`packages/worker/src/open-api/operations.ts` is the route table and the source
of truth for `/openapi.json`. Most operations are registry capabilities
(`operationId` is the capability name and inputs are its schema; path params map
to same-named inputs, `GET`/`DELETE` read the query string, and other methods
read a JSON body). Token and CapabilityProxy operations are native.

`/v1` is additive: add operations freely; never rename an `operationId`, change
a method or path, or remove an operation without a new version. Capability
routes may declare `aliasPaths`: extra HTTP paths for the same capability. They
are listed in `/openapi.json` with a distinct operationId (`${id}ByPath`) so the
document stays unique; HTTP still dispatches both paths to the capability. Put
the preferred client path on `path` (for example `repoGetGitRemote`'s body-only
`/v1/repos/git-remote`, with `/v1/repos/{repo_id}/git-remote` as an alias).

`POST /v1/execute` runs a module in Kody's cloud sandbox and returns the MCP
execute envelope (`content`, `structuredContent`, `isError`) with HTTP 200 when
the module fails. It accepts `kody_at_…` with `org:execute` only.
`POST /v1/search/tool` is the MCP `search` tool over HTTP (`search:read`),
including `entity` detail. `GET /v1/search` stays the search capability.

Never in the Open API: secret plaintext, the inbound webhook receive path,
package-app HTTP/WebSocket/realtime traffic, admin capabilities, and
runtime-only capabilities (values, package-app fetch, synthetic dispatch). The
`execute` capability stays off the MCP `api` tool; hosted execute is the native
`execute` operation.

Plain API reads and token mints need no execute entitlement and never start a
Dynamic Worker. Writes hold the account write lease, like MCP tool calls.

## Tokens

Scoped API tokens (`kody_at_<id>_<secret>`) are the primary HTTP credential for
the Open API. They are a separate credential class from MCP OAuth
([ADR 0053](../decisions/0053-scoped-api-tokens-are-not-mcp-oauth-scopes.md)).
Kody stores only a SHA-256 hash; the value is returned once, on mint or rotate.

On **local-execute HTTP** (CapabilityProxy,
`POST /v1/capability-proxy/gateway-fetch`, and
`POST /v1/local-execute/package-graph`) and on `POST /v1/tokens/device`, a valid
CLI MCP OAuth access token from `kody login` (official CLI CIMD client id) is
accepted as Bearer
([ADR 0055](../decisions/0055-cli-mcp-oauth-local-execute-http.md),
[ADR 0076](../decisions/0076-cli-login-device-token.md)).
`POST /v1/tokens/device` exchanges that OAuth access token for a user-owned
`kody_at_…` device token. Other `/v1` operations, including `POST /v1/execute`,
reject non-`kody_at_` bearers with `401 Invalid API token`. Older CLIs keep
using MCP and the local-execute OAuth routes.

- Scopes are org permissions (`resource-type:action`: `org:read`, `org:execute`,
  `package:read`, `search:read`, …). Vocabulary:
  [`packages/shared/src/org-permissions.ts`](../../../packages/shared/src/org-permissions.ts).
  There is no implied hierarchy: `package:write` does not grant `package:read`.
  Every operation publishes the required permission as `x-kody-permission`
  (capability operations take it from `orgPermission`; native operations declare
  it in `nativeRoute`). `authorize` step 4 narrows the compiled role by
  `credential.scopes`. There is no separate `x-kody-scope` check. `org:execute`
  is the CapabilityProxy / package-graph / execute route grant; each resolved
  `kody:@…` import also needs `package:execute`. `none` means the surface
  touches no org data (own tokens, who-am-I, discovery, site-admin tools).
- TTL: tokens require an explicit lifetime: `lifetime` `short` (1h idle / 24h
  max) or `long` (14d idle / 3mo max), or both `idle_ttl_seconds` (60–1209600)
  and `max_lifetime_seconds` (up to 7776000). Each authenticated request slides
  `expires_at` forward (debounced), never past `max_expires_at`. Aliases are
  input sugar only; only the resulting idle/max values are stored.
- Minting: the first token comes from the MCP `api` tool (`tokenCreate`, full
  MCP grant; `x-kody-permission: none`). An existing token can mint more, but
  only with scopes it holds and never outliving its own `max_expires_at`. At
  most 500 active tokens per account. When the pool is full, a new mint revokes
  the active token(s) with the least remaining life (time until stored
  `expires_at`), never the caller's own token. Reclaim applies to every mint.
- **CLI bootstrap (ADR 0056):** `cliCredentialBootstrap` (capability +
  `POST /v1/tokens/bootstrap`) returns a one-shot `kody_bc_…` code (never
  `kody_at_`) and a `cli_command` that includes required lifetime flags.
  `POST /v1/tokens/bootstrap/redeem` is code-authenticated only (no Bearer;
  rejected for MCP `api`) and mints a normal `kody_at_` with default scopes:
  `org:execute` + `org:read` + package/integration/secret/email/job/app/memory
  use scopes (migration 0092), plus `package:write` (plain-repo / package
  pushes) and `token:delete` (self-revoke), and `created_via: cli-bootstrap` for
  the CLI to store. Lifetime is required on both bootstrap mint and redeem. CLI
  `whoami` / `GET /v1/tokens/current` surface sliding `expires_at` (the idle
  window).
- Mint and rotate return `token`, `token_type: "Bearer"`, `id`, `name`,
  `scopes`, `status`, `idle_ttl_seconds`, `expires_at`, `max_expires_at`, and
  timestamps. List and get never return the value.
- `GET /v1/tokens/current`, `POST /v1/tokens/current/rotate`, and
  `DELETE /v1/tokens/current` need no scope and act on the calling token.
- Account gates match `/mcp`: verified email, not suspended, not deleting, and
  the token must postdate the last password change.
- Redaction: `redactApiTokens` (`packages/shared/src/api-token-format.ts`) masks
  `kody_at_…` values in API error envelopes, MCP `api` tool failure logs, and
  execute results, logs, and errors (what run records and Activity store),
  whether or not the run has secrets. The MCP `api` tool does not write run
  records, and its success log carries no result.

## CapabilityProxy

The cloud half of local execute. The CLI runs modules in a local workerd and
forwards each `kody:runtime` call here. Static `kody:@…` imports are resolved by
`POST /v1/local-execute/package-graph` (`org:execute` on the route;
`package:execute` per imported package): origin returns published, stamped
importable-module artifacts for embedding — it does **not** execute the user
module and does not silently hop to `kody.execute`. See
[Local CLI execute](../../guides/local-execute.md) and
[Open API](../../guides/open-api.md).

| Route                                     | Body                                                                                                             | 200 response                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /v1/capability-proxy/session`        | none                                                                                                             | `{ scopes, expiresAt, maxExpiresAt, idleTtlSeconds, user, features, limits }` (camelCase) |
| `POST /v1/capability-proxy/call`          | `{ path, args, conversationId?, credentials? }`                                                                  | `{ result }`                                                                              |
| `POST /v1/capability-proxy/gateway-fetch` | raw outbound fetch body (streamed)                                                                               | upstream HTTP response (status, headers, body), streamed                                  |
| `POST /v1/local-execute/package-graph`    | `{ code?, imports?, conversationId? }` (need `code` and/or `imports`; inline `code` ≤ ~5 MiB minus JSON wrapper) | `{ modules: [{ name, esModule }], imports, warnings }`                                    |

- `path` is the `kody:runtime` property path: `['kody', name]`,
  `['kody', 'mcp', server, tool]`, or `['workflows', 'create']`. `args` are
  positional (at most 8; paths at most 8 segments). Unknown keys answer 400.
  `['packages', 'invoke']` answers the same unknown-path 404 as any other
  unbound runtime path. Token-auth / `--local` package composition uses
  package-graph download + local workerd embedding — not whole-module
  `kody.execute`.
- Package-graph uses the same static-import scanner and resolution policy as
  cloud ad hoc execute (imports resolve only in the caller's org). Prefer
  published `importable-module` artifacts; unpublished or missing artifacts
  answer `400 package_import_unpublished`. Literal dynamic `import("kody:@…")`
  answers `400 unsupported_dynamic_package_import`. Inline `code` is capped just
  under the Open API JSON body limit (5 MiB) so the JSON wrapper still fits —
  the same body ceiling as every other JSON Open API op (publish's 10 MiB
  per-file limit is Artifacts git, not this route). Callers with larger modules
  (or `kody dev` worker bundles that only need stamped deps) pass `imports`
  alone; origin synthesizes a tiny entry from that list so the multi-megabyte
  bundle never crosses the wire.
- Calls dispatch through the same `kody.*` tool map as ad hoc cloud execute, so
  capability behavior, `kody.mcp`, and workflows match the cloud. Caller errors
  from a capability keep their status and message. Unexpected capability
  failures return 500 `capability_error`, and their message hides `kody_at_`
  tokens and any secret values the call wrote. Platform failures outside the
  capability return the generic `internal_error`, and the details are logged
  server-side.
- Confused-deputy limits: `POST /v1/capability-proxy/call` is JSON arguments
  only. No caller header or cookie is forwarded into a capability, and the edge
  strips `Cookie` and non-allowlisted `X-Kody-*` before origin sees the request.
  The streaming hop is the exception: allowlisted `X-Kody-Gateway-*` /
  `x-kody-secret-resolution` headers carry outbound URL, method, package stamp,
  and headers; the body is the outbound fetch body. Other `X-Kody-*` headers are
  still stripped.
- Order of checks: bearer credential (401), then — for `kody_at_` tokens only —
  `org:execute` via `authorize` (403 `insufficient_scope`). CLI MCP OAuth skips
  the token-scope check (full MCP grant on these routes).
- Auth: `kody_at_…` with `org:execute`, or a valid `kody login` MCP OAuth access
  token for this origin
  ([ADR 0055](../decisions/0055-cli-mcp-oauth-local-execute-http.md)).
- Authenticated outbound fetch: `path: ['kody','authenticatedFetch']` with
  `{ providerName, request: { url, method?, headers?, body? } }`. Origin runs
  the same placeholder + fetch-gateway model as cloud execute (and host-side
  `integrationTokenRefresh` on auth failure), then returns
  `{ status, statusText, headers, bodyBase64 }`. Bodies over 4 MiB are rejected.
  The package-graph runtime shim implements local `createAuthenticatedFetch` by
  hopping here so OAuth access tokens never enter workerd. Nested
  `…/.__published_bundle__/…/.__kody_virtual__/runtime.js` modules re-export the
  primary shim; the primary imports host `kody:runtime` with a relative
  specifier (`../kody:runtime`) because workerd path-joins bare `kody:runtime`
  under path-like module names. Published bundles that **inline** the virtual
  runtime (Dropbox-style esbuild) are rewritten onto that same shim during
  package-graph prep so `--local` does not depend on cloud's ALS preload.
- Secret-bearing ambient fetch: `path: ['kody','gatewayFetch']` with
  `{ request: { url, method?, headers?, body? }, packageId? }`. Origin runs
  `executeGatewayFetch` / `expandSecretPlaceholders` (same as cloud sandbox
  `fetch`). Package-graph always returns the `.__kody_virtual__/runtime.js`
  gateway-fetch shim (even when the entry has no `kody:@` imports) so ad-hoc
  scripts that call ambient `fetch` with `{{secret:…}}` still hop here. It also
  rewrites published modules so ambient `fetch` hops here and quoted
  `{{secret:name|scope=…}}` literals become `__kodySecretRef(...)` — secret
  plaintext never enters local workerd, and a missing secret fails closed before
  any third-party request. Small buffered placeholder-bearing bodies use this
  JSON hop (4 MiB). Streamed bodies, `multipart/*` bodies, and bodies that would
  exceed 4 MiB use native `POST /v1/capability-proxy/gateway-fetch` via host
  `kody.gatewayFetchStream`
  ([contract](../contracts/cli-streaming-gateway-fetch.md)): raw body, no JSON
  wrapper, upstream response streamed back. Literal `{{…}}` placeholders in
  multipart parts are filled, matching hosted.
- OAuth client-credentials: `path: ['kody','oauthClientCredentials']` with the
  same argument shape as cloud `oauthClientCredentials(...)`. Origin expands
  secret placeholders through the fetch gateway.
- Credential clients (`credential()` / `credentials()`, ADR 0068): both the CLI
  host `kody:runtime` (ad hoc / unpublished `--code` / `--file`) and the
  package-graph shim open, sign, call MCP tools, and refresh OAuth through
  `kody.credentialClientOpen` / `credentialClientOpenAll` /
  `credentialClientSign` / `credentialClientCallTool` /
  `credentialClientRefresh`, which return `{ ok: true, value }` or
  `{ ok: false, error: { code, message, retryWith } }`. The CLI sends its
  `--credential` picks as the call's top-level `credentials` map (code inside
  local workerd controls only `args`, so it cannot pick by name), and
  `kody.credentialClientCheck({ packageId?, strict? })` checks the map before
  code runs. The session's `features` lists `credential-call-map` when origin
  serves both. Handles bind to the CapabilityProxy token, not a run, and a
  claimed `packageId` must pass `package:execute`. A client `fetch` carries only
  the handle in `x-kody-credential-client`, so it always takes the gateway-fetch
  hop, where origin places the credential. See
  [CLI local credential runtime](../contracts/cli-local-credential-runtime.md).
- Stamped `packageStorage` / `packageSecrets`: local shim factories hop as
  `kody.packageStorage*` / `kody.packageSecret*` (secret authority via
  `__kodySecretAuthorityPackageId`). Each local hop accepts only package ids
  owned by the caller's org. Ad hoc (unstamped) `packageStorage()` /
  `packageSecrets` on the host `kody:runtime` remain unbound, matching cloud ad
  hoc execute.

## Errors

Every error is `{ error: { code, message, details? } }` with
`Cache-Control: no-store`.

| Status | `code`                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 400    | `invalid_request`, `package_import_unresolved`, `package_import_unpublished`, `unsupported_dynamic_package_import` |
| 401    | `unauthorized` (missing, invalid, expired, or revoked token)                                                       |
| 403    | `insufficient_scope`, `email_verification_required`, `account_suspended`                                           |
| 404    | `not_found`, `feature_unavailable` (capability or MCP gate)                                                        |
| 405    | `method_not_allowed` (with `Allow`)                                                                                |
| 409    | `account_deleting`                                                                                                 |
| 413    | `payload_too_large`                                                                                                |
| 415    | `unsupported_media_type`                                                                                           |
| 429    | `rate_limited` (edge, `Retry-After`), `entitlement_limit`                                                          |
| 500    | `capability_error`, `internal_error`                                                                               |

## Metering

Each operation records one observe-only `api_call`
([usage metering](./usage-metering.md)); CapabilityProxy hops use
`capability-proxy:<path>` as the entity id, and package-graph prep uses
`localExecutePackageGraph`. On local-execute native failures the entity id
appends the ApiError code (for example
`localExecutePackageGraph:package_import_unresolved`, or
`capabilityProxySession:unauthorized`) so session start, package-graph prep, and
auth failures are distinguishable in Analytics Engine without a new event type
or fake `execute` / `dynamic_worker_day` charges. The capability behind a call
meters itself as usual (email sends, outbound fetches, package runs). Local
execute CPU runs on the user's machine and is never recorded as `execute` or
`dynamic_worker_day`.

## MCP `api` tool

The third MCP tool beside `search` and `execute`
(`packages/worker/src/mcp/tools/api.ts`). Input is `{ operationId, params }`
with `params` as one flat object (path, query, and body fields together). It
runs with the session's MCP grant, so token scopes do not apply on mint paths.
Capability-level feature flags still gate individual operations when registered.

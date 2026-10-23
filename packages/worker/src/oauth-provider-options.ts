// `import type * as` is fully erased under verbatimModuleSyntax; a named
// `{ type X }` import would keep a side-effect import of the provider (and its
// `cloudflare:workers` dependency) on the platform/runtime startup path.
import { waitUntil } from 'cloudflare:workers'
import type * as WorkersOAuthProvider from '@cloudflare/workers-oauth-provider'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'
import { stampOrgIdOnTokenExchange } from '#worker/orgs/oauth-grant.ts'
import { reportOAuthProviderError } from '#worker/oauth-provider-error-log.ts'

/**
 * MCP HTTP path and OAuthProvider `apiRoute`. v1 requires every protected route
 * to be the canonical `resourceMetadata.resource` path or a descendant, so
 * this must stay `/mcp` (not `/api/`).
 */
export const mcpOAuthApiRoute = '/mcp'

export type SharedOAuthProviderOptions = Omit<
	WorkersOAuthProvider.OAuthProviderOptions<Env>,
	'apiHandler' | 'apiHandlers' | 'defaultHandler'
>

/**
 * Canonical RFC 8707 / RFC 9728 resource URI for one app origin (`<origin>/mcp`).
 * v1 pins grants and access-token audiences to this exact value.
 */
export function mcpOAuthResourceUri(origin: string) {
	return `${origin}${mcpOAuthApiRoute}`
}

/**
 * Every `OAuthProvider` option except the request handlers, shared by the
 * origin `fetch` wrapper (`origin-handler.ts`) and the handler-less
 * `getOAuthApi` fallback (`oauth-helpers.ts`) so grant, token, and client
 * storage semantics (endpoints, scopes, TTLs, CIMD, resource) cannot drift
 * between the two. This module must not import the provider at runtime: it
 * sits on the platform/runtime startup path and the provider is deferred
 * there.
 *
 * `resource` is per origin (production, preview, and local each mint tokens
 * for their own `<origin>/mcp`). Callers build one provider options object
 * per resource URI.
 */
export function createSharedOAuthProviderOptions(
	resource: string,
): SharedOAuthProviderOptions {
	return {
		apiRoute: mcpOAuthApiRoute,
		authorizeEndpoint: oauthPaths.authorize,
		tokenEndpoint: oauthPaths.token,
		clientRegistrationEndpoint: oauthPaths.register,
		scopesSupported: mcpOauthScopes,
		// Client ID Metadata Documents (MCP 2025-11-25 SEP-991): clients may use
		// an HTTPS URL as their client_id instead of registering via DCR. The
		// 2026-07-28 revision deprecates RFC 7591 DCR in favor of CIMD, so both
		// stay enabled: CIMD clients present their URL client_id with no
		// registration step, and clients that do not use CIMD register via
		// /oauth/register. A failed CIMD metadata fetch throws CimdFetchError;
		// authorize maps that to an unknown-client page, and the token endpoint
		// still returns generic invalid_client. Whether a client then registers
		// via DCR is the client's own recovery.
		// Requires the global_fetch_strictly_public compatibility flag (set in
		// wrangler.jsonc) so metadata fetches are SSRF-safe; the provider only
		// advertises CIMD support when both are on.
		clientIdMetadataDocumentEnabled: true,
		// Provider defaults are 30-day refresh tokens and 90-day DCR clients.
		// Explicit `undefined` disables those expiries (omitting the option keeps
		// the defaults). Access tokens stay at the 1-hour default.
		refreshTokenTTL: undefined,
		clientRegistrationTTL: undefined,
		// v1 requires a canonical resource. It becomes every token's audience and
		// the RFC 9728 `resource` field. Per-origin providers keep preview/local
		// hosts aligned with the URL clients actually connect to.
		resourceMetadata: {
			resource,
		},
		// Resource baseline (RFC 9728 `scopes_supported` / 401 `scope`). Same
		// OIDC trio as `scopesSupported`; capability scopes stay out (ADR 0049).
		// Advertised, not enforced — the MCP handler uses `insufficientScope()`
		// when a presented token lacks these.
		requiredScopes: mcpOauthScopes,
		// Provider default onError console.warns every structured OAuth error, which
		// trips test console guards and used to discard refresh failure reasons.
		// Report token/refresh failures (code + internal category/reason + client id
		// when available) without secrets; leave the wire response unchanged.
		// CIMD lookup failures stay generic on the wire and keep the provider's own
		// CIMD console.warn; at the token endpoint they are also reported with the
		// client URL and fetch reason. Unexpected throws still reach fetch catch +
		// Sentry.
		onError: (error) => {
			// Provider does not await onError; pin reporting to the request so
			// client-id lookup + audit are not dropped when the OAuth response
			// returns first.
			waitUntil(
				reportOAuthProviderError(error).catch((reportError) => {
					console.warn('oauth-provider-error-report-failed', reportError)
				}),
			)
		},
		// v1.2 removed allowPlainPKCE / allowImplicitFlow (S256 + auth code only).
		// App-layer getPkceValidationError remains defense in depth. See
		// docs/contributing/security.md.
		tokenExchangeCallback: ({ props }) => stampOrgIdOnTokenExchange({ props }),
	}
}

// Type-only namespace import: fully erased, so the provider (and its
// `cloudflare:workers` import) stays off the platform/runtime startup path
// and out of node unit tests until `resolveOAuthHelpers` actually needs it.
import type * as WorkersOAuthProvider from '@cloudflare/workers-oauth-provider'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	createSharedOAuthProviderOptions,
	mcpOAuthResourceUri,
} from '#worker/oauth-provider-options.ts'

type OAuthHelpers = WorkersOAuthProvider.OAuthHelpers

/**
 * `getOAuthApi` builds a provider instance to validate options, and the
 * constructor insists on request handlers even though the helpers API never
 * routes a request. These stubs satisfy that contract and nothing else.
 */
const inertHandler = {
	fetch() {
		return Promise.resolve(new Response('Not Found', { status: 404 }))
	},
} satisfies ExportedHandler<Env>

/**
 * Resolve the provider's `OAuthHelpers` for the current execution context.
 *
 * `@cloudflare/workers-oauth-provider` injects `env.OAUTH_PROVIDER` only
 * inside its own `fetch` wrapper on origin, and only for the default handler
 * and API routes — `/oauth/token` is handled internally and never gets the
 * injection. Scheduled lanes, RPC entrypoints (`JobsHost.runScheduledLane`),
 * OIDC UserInfo/logout (served before `oauthProvider.fetch`), token-response
 * `id_token` enrichment (runs after that fetch returns), and capabilities
 * served from the sessionful `MCP` Durable Object on kody-platform therefore
 * build the same `OAuthHelpersImpl` through the library's `getOAuthApi` with
 * the shared options. The library loads lazily from the pre-bundled module
 * (`tools/build-worker-bundler-modules.ts`): a plain dynamic
 * `import('@cloudflare/workers-oauth-provider')` is inlined into Wrangler's
 * main module, which would put it on the platform/runtime startup path.
 * The generated specifier stays behind `import()`, so Vite origin emits a
 * hashed chunk and Wrangler siblings still upload it via
 * `find_additional_modules`. It is only fetched and evaluated when a
 * non-fetch caller actually needs it.
 *
 * Returns `undefined` only when `OAUTH_KV` itself is missing. Callers type
 * `OAUTH_PROVIDER` as the subset of `OAuthHelpers` they consume; the full
 * library type is assignable to every such subset.
 *
 * Background callers have no request URL, so the helpers bind to
 * `getAppBaseUrl({ env })` + `/mcp` (APP_BASE_URL, else production default).
 * Grant listing/revocation and unwrap do not re-check that audience; token
 * minting on the request path uses a per-origin provider instead.
 */
export async function resolveOAuthHelpers<Helpers extends object>(
	env: Env & { OAUTH_PROVIDER?: Helpers },
	options: { requestUrl?: string } = {},
): Promise<Helpers | OAuthHelpers | undefined> {
	if (env.OAUTH_PROVIDER) return env.OAUTH_PROVIDER
	if (!env.OAUTH_KV) return undefined
	const { getOAuthApi } =
		await import('./node_modules/.kody-generated/oauth-provider.mjs')
	// A request-path caller that mints grants (the device grant on
	// `/oauth/token`) passes its URL so the audience matches that origin.
	const resource = mcpOAuthResourceUri(
		getAppBaseUrl({
			env,
			...(options.requestUrl ? { requestUrl: options.requestUrl } : {}),
		}),
	)
	return getOAuthApi<Env>(
		{
			...createSharedOAuthProviderOptions(resource),
			apiHandler: inertHandler,
			defaultHandler: inertHandler,
		},
		env,
	)
}

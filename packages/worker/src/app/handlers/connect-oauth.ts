import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import {
	hasStoredConnectClientSecret,
	loadAccountIntegrationByName,
	loadExistingConnectionSummary,
} from '#app/account-integrations-data.ts'
import { loadConnectOauthChooser } from '#app/connect-oauth-chooser.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { joinAppUrl } from '#worker/app-base-url.ts'
import { type ConnectOauthLoaderData } from '#universal/loader-data.ts'

/**
 * Every working visit to /connect/oauth carries at least one of these:
 * `provider` (agent-built setup URLs), `code` (the
 * provider's success redirect — config is restored from sessionStorage, so
 * the query has no provider), or `error` (the provider's denial redirect).
 * A visit with none of them is the signed-in provider chooser.
 */
export function isBareConnectOauthVisit(url: URL): boolean {
	const params = url.searchParams
	return !params.get('provider') && !params.get('code') && !params.get('error')
}

/**
 * SSR prefill embedded for every rendered visit so the page paints its final
 * layout server-side. `?provider=` visits carry the same record the
 * `/account/integrations.json?name=` endpoint serves (plus whether the
 * client-secret secret already exists), so a direct navigation renders the
 * ready connect card without a client fetch. Callback returns
 * (`code`/`error`) restore config from sessionStorage, so their query
 * carries no provider and only the redirect URI is embedded.
 */
export async function loadConnectOauthLoaderData(
	env: Env,
	request: Request,
	input: {
		orgSlug?: string
		provider?: string
		code?: string
		error?: string
		appSlug?: string
		platformSlug?: string
	},
	authenticatedUser?: Awaited<ReturnType<typeof readAuthenticatedAppUser>>,
): Promise<ConnectOauthLoaderData> {
	const redirectUri = joinAppUrl({
		env,
		path: '/connect/oauth',
		requestUrl: request.url,
	})
	const provider = input.provider?.trim()
	const providerKey = provider ? normalizeProviderKey(provider) : ''
	if (!providerKey) {
		if (input.provider || input.code || input.error) {
			return { ok: true, provider: null, integration: null, redirectUri }
		}
		const user =
			authenticatedUser ??
			(await readAuthenticatedAppUser(request, env, {
				prefetchFeatureFlags: true,
			}))
		return {
			ok: true,
			provider: null,
			integration: null,
			redirectUri,
			chooser: user
				? await loadConnectOauthChooser({
						env,
						userId: user.mcpUser.userId,
						orgSlug: input.orgSlug,
					})
				: { options: [] },
		}
	}
	const user =
		authenticatedUser ??
		(await readAuthenticatedAppUser(request, env, {
			prefetchFeatureFlags: true,
		}))
	if (!user) {
		return { ok: true, provider: null, integration: null, redirectUri }
	}
	// `app=<slug>` reuses a saved bring-your-own app under `provider`.
	// Explicit platform intent uses the same visibility rules as the integration resolver.
	const integration = await loadAccountIntegrationByName(
		env,
		user,
		providerKey,
		{
			appSlug: input.appSlug?.trim()
				? (normalizeProviderKey(input.appSlug.trim()) ?? undefined)
				: undefined,
			platformSlug: input.platformSlug?.trim()
				? (normalizeProviderKey(input.platformSlug.trim()) ?? undefined)
				: undefined,
		},
	)
	const [existingConnection, hasStoredClientSecret] = await Promise.all([
		loadExistingConnectionSummary(env, user, providerKey),
		hasStoredConnectClientSecret(env, user, providerKey, integration),
	])
	return {
		ok: true,
		provider: providerKey,
		integration,
		builtInAvailable: false,
		existingConnection,
		hasStoredClientSecret,
		redirectUri,
	}
}

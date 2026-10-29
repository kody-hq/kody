import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { oauthAppToSetupPrefill } from '#worker/integrations/service.ts'
import {
	listPinnedConnectableApps,
	pinnedReconnectHref,
	resolvePinnedConnectTarget,
} from '#worker/integrations/pinned-connect.ts'
import {
	hasStoredConnectClientSecret,
	loadAccountIntegrationByName,
	loadExistingConnectionSummary,
	toAppOnlyIntegrationRecord,
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
		mode?: string
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
	const pinnedAppSlug =
		input.mode === 'personal' && input.appSlug?.trim()
			? normalizeProviderKey(input.appSlug.trim())
			: null
	if (pinnedAppSlug && !input.code && !input.error) {
		const user =
			authenticatedUser ??
			(await readAuthenticatedAppUser(request, env, {
				prefetchFeatureFlags: true,
			}))
		if (!user) {
			return { ok: true, provider: null, integration: null, redirectUri }
		}
		return loadPinnedConnectLoaderData({
			env,
			user,
			appSlug: pinnedAppSlug,
			displayName: providerKey || pinnedAppSlug,
			redirectUri,
		})
	}
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
						orgApps: input.orgSlug
							? (
									await listPinnedConnectableApps({
										env,
										request: user.request,
										mcpUser: user.mcpUser,
									})
								)?.apps
							: undefined,
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
	const pinnedReconnect = await pinnedReconnectHref({
		env,
		request: user.request,
		mcpUser: user.mcpUser,
		name: providerKey,
	})
	if (pinnedReconnect) {
		return {
			ok: true,
			provider: null,
			integration: null,
			redirectUri,
			pinnedReconnectHref: pinnedReconnect,
		}
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

/**
 * `mode=personal&app=<slug>`: a member connects their own account through
 * the scoped org's app. The record carries the app's public client id and
 * endpoints only; the secret stays host-side, so the setup step is skipped.
 */
async function loadPinnedConnectLoaderData({
	env,
	user,
	appSlug,
	displayName,
	redirectUri,
}: {
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	appSlug: string
	/** The `provider` the page shows; the saved name is `connectionName`. */
	displayName: string
	redirectUri: string
}): Promise<ConnectOauthLoaderData> {
	const target = await resolvePinnedConnectTarget({
		env,
		request: user.request,
		mcpUser: user.mcpUser,
		appSlug,
	})
	if (!target.ok) {
		return {
			ok: true,
			provider: null,
			integration: null,
			redirectUri,
			pinnedConnectError: target.error,
		}
	}
	const record = toAppOnlyIntegrationRecord(
		oauthAppToSetupPrefill(target.app),
		displayName,
	)
	return {
		ok: true,
		provider: record.name,
		integration: {
			...record,
			hasClientSecret: true,
			pinnedAppSlug: target.app.slug,
		},
		builtInAvailable: false,
		existingConnection: null,
		hasStoredClientSecret: true,
		redirectUri,
		pinnedConnect: {
			orgSlug: target.orgSlug,
			appSlug: target.app.slug,
			appLabel: target.app.label,
			connectionName: target.connectionName,
		},
	}
}

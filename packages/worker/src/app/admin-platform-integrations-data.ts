import { type AdminPlatformIntegrationsLoaderData } from '#universal/loader-data.ts'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import {
	countConnectionsForPlatformApp,
	listPlatformOauthApps,
} from '#worker/integrations/platform-apps.ts'

export async function loadAdminPlatformIntegrationsData(
	env: Env,
): Promise<AdminPlatformIntegrationsLoaderData> {
	const apps = await listPlatformOauthApps({
		db: env.APP_DB,
		includeDisabled: true,
	})
	const withCounts = await Promise.all(
		apps.map(async (app) => ({
			slug: app.slug,
			provider: app.provider,
			label: app.label,
			description: app.description,
			clientId: app.clientId,
			hasClientSecret: app.hasClientSecret,
			tokenUrl: app.tokenUrl,
			authorizeUrl: app.authorizeUrl,
			deviceAuthorizationUrl: app.deviceAuthorizationUrl,
			apiBaseUrl: app.apiBaseUrl,
			flow: app.flow,
			usePkce: app.usePkce,
			tokenExchangeStyle: app.tokenExchangeStyle,
			scopeSeparator: app.scopeSeparator,
			extraAuthorizeParams: app.extraAuthorizeParams,
			allowedScopes: app.allowedScopes,
			defaultScopes: app.defaultScopes,
			requiredHosts: app.requiredHosts,
			enabled: app.enabled,
			visibility: app.visibility,
			logoPath: buildPlatformOauthAppLogoPath(app),
			connectionCount: await countConnectionsForPlatformApp({
				db: env.APP_DB,
				slug: app.slug,
			}),
			createdAt: app.createdAt,
			updatedAt: app.updatedAt,
		})),
	)
	return { ok: true, apps: withCounts }
}

import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type AccountMcpServersLoaderData } from '#universal/loader-data.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildMcpServerStatusView,
	loadMcpClientHubReadSnapshotOrNull,
} from '#mcp/capabilities/mcp-servers/shared.ts'
import {
	attachCatalogLogoPath,
	listPlatformProviderMarks,
} from '#worker/integrations/provider-marks.ts'
import { buildMcpServerAutoLogoPath } from '#worker/mcp-client/mcp-server-logo.ts'
import {
	listMcpServerSettings,
	resolveMcpServerOAuthClientUrls,
} from '#worker/mcp-client/settings-service.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountMcpServersData(input: {
	env: Env
	user: AuthenticatedUser
	requestUrl?: string | URL | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<AccountMcpServersLoaderData> {
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const oauth = resolveMcpServerOAuthClientUrls({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const [settings, savedPackages, marks] = await Promise.all([
		listMcpServerSettings({ env: input.env, userId }),
		listSavedPackagesByUserId(input.env.APP_DB, { userId }),
		listPlatformProviderMarks({ db: input.env.APP_DB }),
	])
	const snapshot =
		settings.length > 0
			? await loadMcpClientHubReadSnapshotOrNull({
					env: input.env,
					userId,
				})
			: null
	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		oauthClientOrigin: oauth.clientOrigin,
		oauthCallbackUrl: oauth.callbackUrl,
		oauthClientMetadataUrl: oauth.clientMetadataUrl,
		servers: settings.map((setting) => {
			const server =
				snapshot?.servers.find((entry) => entry.serverId === setting.id) ?? null
			return attachCatalogLogoPath(
				{
					...buildMcpServerStatusView({
						setting,
						snapshot: server,
						authorizeLink: {
							appOrigin: oauth.clientOrigin,
							orgSlug:
								input.user.request.org.slug?.trim() || input.user.username,
						},
						oauthCallbackUrl: oauth.callbackUrl,
						oauthClientOrigin: oauth.clientOrigin,
						oauthClientMetadataUrl: oauth.clientMetadataUrl,
					}),
					state: server?.state ?? 'unknown',
					autoLogoPath: buildMcpServerAutoLogoPath(setting),
					oauthClientId: server?.oauthClientId ?? null,
				},
				marks,
			)
		}),
		savedPackages: savedPackages.map((entry) => ({
			id: entry.id,
			kodyId: entry.kodyId,
		})),
	}
}

import {
	buildConnectOauthChooserOptions,
	type ConnectOauthChooserOption,
} from '#universal/oauth-connect.ts'
import { buildPlatformOauthAppLogoPath } from '#worker/integrations/platform-app-logo.ts'
import { isPlatformOauthAppDiscoverable } from '#worker/integrations/platform-apps.ts'
import {
	listPlatformProviderMarks,
	resolveProviderMarkLogoPath,
	hostFromProviderUrl,
} from '#worker/integrations/provider-marks.ts'
import { buildUserOauthAppLogoPaths } from '#worker/integrations/user-oauth-app-logo.ts'
import {
	listAvailablePlatformApps,
	listJoinedIntegrations,
} from '#worker/integrations/service.ts'
import { toConnectablePlatformApp } from '#app/platform-integration-catalog.ts'
import {
	listScopeIncludes,
	type ResourceListScope,
} from '#worker/authorization/authorize.ts'

import type { UserOauthApp } from '#worker/integrations/types.ts'

export type { ConnectOauthChooserOption }

export async function loadConnectOauthChooser(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	/** From `/connect/oauth?org=`; kept on every chooser option href. */
	orgSlug?: string | null
	/** Org apps the member may connect their own account through. */
	orgApps?: ReadonlyArray<UserOauthApp>
	/** The caller's `integration:read` list scope; omit to list every connection. */
	listScope?: ResourceListScope
}): Promise<{ options: Array<ConnectOauthChooserOption> }> {
	const [saved, platformApps, marks] = await Promise.all([
		listJoinedIntegrations({ env: input.env, userId: input.userId }),
		listAvailablePlatformApps({ env: input.env }),
		listPlatformProviderMarks({ db: input.env.APP_DB }),
	])
	const listScope = input.listScope
	const joined = listScope
		? saved.filter((entry) =>
				listScopeIncludes(listScope, entry.connection.credentialId),
			)
		: saved
	return {
		options: buildConnectOauthChooserOptions({
			orgSlug: input.orgSlug,
			orgApps: (input.orgApps ?? []).map((app) => ({
				slug: app.slug,
				label: app.label?.trim() || app.slug,
				providerKey: app.provider,
				...buildUserOauthAppLogoPaths(app),
				catalogLogoPath: resolveProviderMarkLogoPath({
					marks,
					providerKey: app.provider,
					host: hostFromProviderUrl(app.authorizeUrl),
				}),
			})),
			connections: joined.map((entry) => ({
				name: entry.connection.name,
				label:
					entry.connection.accountLabel?.trim() ||
					entry.app.label?.trim() ||
					entry.connection.name,
				providerKey: entry.app.provider,
				logoPath:
					entry.lane === 'platform'
						? buildPlatformOauthAppLogoPath(entry.app)
						: buildUserOauthAppLogoPaths(entry.app).logoPath,
				autoLogoPath:
					entry.lane === 'platform'
						? null
						: buildUserOauthAppLogoPaths(entry.app).autoLogoPath,
				catalogLogoPath: resolveProviderMarkLogoPath({
					marks,
					providerKey: entry.app.provider,
					host: hostFromProviderUrl(entry.app.authorizeUrl),
				}),
				platform: entry.lane === 'platform',
				platformDiscoverable:
					entry.lane === 'platform' &&
					isPlatformOauthAppDiscoverable(entry.app),
				appSlug: entry.app.slug,
				canDrive: Boolean(
					entry.app.authorizeUrl?.trim() && entry.app.tokenUrl.trim(),
				),
			})),
			platformApps: platformApps.map((app) =>
				toConnectablePlatformApp(app, marks),
			),
		}),
	}
}

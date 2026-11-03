import { kodyDiscordInviteUrl } from '#universal/community-links.ts'
import type { DiscordPageLoaderData } from '#universal/loader-data.ts'
import { isDiscordGuildRoleSyncConfigured } from '#worker/discord/guild-role.ts'
import { getEnabledOauthProviders } from '#app/oauth-providers.ts'
import { getTurnstileSiteKey } from '#app/public-form-protection.ts'

export async function loadDiscordPageData(input: {
	env: Env
	userId?: number
}): Promise<DiscordPageLoaderData> {
	const discordProviderAvailable = getEnabledOauthProviders(input.env).includes(
		'discord',
	)
	const turnstileSiteKey = getTurnstileSiteKey(input.env)
	if (input.userId == null) {
		return {
			ok: true,
			signedIn: false,
			discordConnected: false,
			discordDisplayName: null,
			discordProviderAvailable,
			canSyncDiscordRoles: false,
			inviteUrl: kodyDiscordInviteUrl,
			turnstileSiteKey,
		}
	}

	const connection = await input.env.APP_DB.prepare(
		`SELECT provider_display_name FROM oauth_connections
		 WHERE user_id = ? AND provider_name = 'discord'`,
	)
		.bind(input.userId)
		.first<{ provider_display_name: string | null }>()

	return {
		ok: true,
		signedIn: true,
		discordConnected: Boolean(connection),
		discordDisplayName: connection?.provider_display_name ?? null,
		discordProviderAvailable,
		canSyncDiscordRoles:
			Boolean(connection) && isDiscordGuildRoleSyncConfigured(input.env),
		inviteUrl: kodyDiscordInviteUrl,
		turnstileSiteKey,
	}
}

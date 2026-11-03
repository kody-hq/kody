import type { AccountConnectionsLoaderData } from '#universal/loader-data.ts'
import { isDiscordGuildRoleSyncConfigured } from '#worker/discord/guild-role.ts'
import {
	getEnabledOauthProviders,
	isOauthProviderId,
	oauthProviderDefinitions,
} from '#app/oauth-providers.ts'
import { listPasskeysForUser } from '#app/passkeys.ts'
import { isUsablePasswordHash } from '#worker/identity/usable-password.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

type ConnectionRow = {
	id: number
	provider_name: string
	provider_display_name: string | null
	created_at: string
}

async function listConnections(db: D1Database, userId: number) {
	const result = await db
		.prepare(
			`SELECT id, provider_name, provider_display_name, created_at
			 FROM oauth_connections
			 WHERE user_id = ?
			 ORDER BY created_at, id`,
		)
		.bind(userId)
		.all<ConnectionRow>()
	return result.results ?? []
}

async function hasUsablePassword(db: D1Database, userId: number) {
	const row = await db
		.prepare(
			`SELECT password_hash FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{ password_hash: string }>()
	// Sentinel hashes (admin-created / OAuth-created accounts) never verify,
	// so only a real PBKDF2 hash counts as a usable password.
	return isUsablePasswordHash(row?.password_hash)
}

export async function loadAccountConnectionsData(input: {
	env: Env
	userId: number
}): Promise<AccountConnectionsLoaderData> {
	const { env, userId } = input
	const [connections, usablePassword, passkeys] = await Promise.all([
		listConnections(env.APP_DB, userId),
		hasUsablePassword(env.APP_DB, userId),
		listPasskeysForUser(env.APP_DB, userId),
	])
	// Disconnecting the last connection is only safe when another first
	// factor (password or passkey) can still sign the account in.
	const canDisconnect =
		usablePassword || passkeys.length > 0 || connections.length > 1
	const connectedProviders = new Set(
		connections.map((connection) => connection.provider_name),
	)
	return {
		ok: true,
		connections: connections.map((connection) => ({
			provider: connection.provider_name,
			label: isOauthProviderId(connection.provider_name)
				? oauthProviderDefinitions[connection.provider_name].label
				: connection.provider_name,
			displayName: connection.provider_display_name,
			createdAt: connection.created_at,
		})),
		canDisconnect,
		hasUsablePassword: usablePassword,
		availableProviders: getEnabledOauthProviders(env)
			.filter((provider) => !connectedProviders.has(provider))
			.map((provider) => ({
				id: provider,
				label: oauthProviderDefinitions[provider].label,
			})),
		canSyncDiscordRoles:
			connectedProviders.has('discord') &&
			isDiscordGuildRoleSyncConfigured(env),
	}
}

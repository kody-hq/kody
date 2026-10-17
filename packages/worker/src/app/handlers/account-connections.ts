import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	isOauthProviderId,
	type OauthProviderId,
} from '#app/oauth-providers.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	maybeRemoveDiscordGuildRoles,
	maybeSyncDiscordGuildRolesForUser,
	summarizeDiscordGuildRoleSync,
} from '#worker/discord/guild-role.ts'
type ConnectionContext = {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
}
export async function syncAccountDiscordRole({
	request,
	env,
	user,
}: ConnectionContext) {
	const connection = await env.APP_DB.prepare(
		`SELECT provider_id FROM oauth_connections
		 WHERE user_id = ? AND provider_name = 'discord'`,
	)
		.bind(user.userId)
		.first<{ provider_id: string }>()
	if (!connection) {
		return operationResult(
			{ ok: false, error: 'Discord is not connected.' },
			404,
		)
	}
	const summary = await maybeSyncDiscordGuildRolesForUser({
		env,
		userId: user.userId,
		discordUserId: connection.provider_id,
	})
	const result =
		'status' in summary ? summary : summarizeDiscordGuildRoleSync(summary)
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'discord_member_role_sync',
		result: result.status === 'assigned' ? 'success' : 'failure',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: new URL(request.url).pathname,
		reason: `status=${result.status}`,
	})
	return operationResult({
		ok: true as const,
		discordMemberRole: result,
	})
}
export async function disconnectAccountProvider({
	request,
	env,
	user,
	provider,
}: ConnectionContext & { provider: OauthProviderId }) {
	if (!isOauthProviderId(provider))
		return operationResult({ ok: false, error: 'Invalid provider.' }, 400)
	const existing = await env.APP_DB.prepare(
		`SELECT id, provider_id FROM oauth_connections
	 WHERE user_id = ? AND provider_name = ?`,
	)
		.bind(user.userId, provider)
		.first<{ id: number; provider_id: string }>()
	if (!existing) {
		return operationResult({ ok: false, error: 'Connection not found.' }, 404)
	}

	// Removing this provider must leave at least one working sign-in
	// method: a usable password, a passkey, or another connection. The
	// guard lives inside the DELETE itself so concurrent disconnects
	// cannot both pass a separate pre-check and remove every method.
	const result = await env.APP_DB.prepare(
		`DELETE FROM oauth_connections
	 WHERE user_id = ?1 AND provider_name = ?2
	 AND (
		EXISTS (
			SELECT 1 FROM users
			WHERE id = ?1 AND password_hash LIKE 'pbkdf2_sha256$%'
				AND deleted_at IS NULL
		)
		OR EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1)
		OR EXISTS (
			SELECT 1 FROM oauth_connections
			WHERE user_id = ?1 AND provider_name != ?2
		)
	 )`,
	)
		.bind(user.userId, provider)
		.run()
	if ((result.meta?.changes ?? 0) === 0) {
		return operationResult(
			{
				ok: false,
				error:
					'This connection is your only way to sign in. Set a password or register a passkey first.',
			},
			400,
		)
	}

	if (provider === 'discord') {
		await maybeRemoveDiscordGuildRoles({
			env,
			discordUserId: existing.provider_id,
		})
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'oauth_connection_removed',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: new URL(request.url).pathname,
		reason: `provider=${provider}`,
	})
	return operationResult({ ok: true as const })
}

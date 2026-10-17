import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	buildDefaultPasskeyName,
	validatePasskeyName,
} from '#app/passkey-label.ts'
import {
	deletePasskeyForUser,
	listPasskeysForUser,
	renamePasskeyForUser,
	type PasskeyRow,
} from '#app/passkeys.ts'
import { type AccountPasskeysLoaderData } from '#universal/loader-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'

function displayPasskeyName(passkey: PasskeyRow) {
	const stored = passkey.name.trim()
	if (stored) return stored
	return buildDefaultPasskeyName({
		aaguid: passkey.aaguid,
		deviceType: passkey.device_type,
	})
}

export async function loadPasskeysPayload(
	db: D1Database,
	userId: number,
): Promise<AccountPasskeysLoaderData> {
	const passkeys = await listPasskeysForUser(db, userId)
	return {
		ok: true,
		passkeys: passkeys.map((passkey) => ({
			id: passkey.id,
			name: displayPasskeyName(passkey),
			deviceType: passkey.device_type,
			backedUp: passkey.backed_up === 1,
			createdAt: passkey.created_at,
			lastUsedAt: passkey.last_used_at,
		})),
	}
}

export async function deleteAccountPasskey({
	env,
	request,
	user,
	passkeyId,
}: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	passkeyId: string
}) {
	const requestIp = getRequestIp(request) ?? undefined
	const deleted = await deletePasskeyForUser(env.APP_DB, passkeyId, user.userId)
	if (!deleted) {
		return {
			ok: false,
			code: 'not_found' as const,
			error: 'Passkey not found.',
		}
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'passkey_delete',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: '/account/passkeys',
	})
	return { ok: true as const }
}
export async function renameAccountPasskey({
	env,
	request,
	user,
	passkeyId,
	name,
}: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	passkeyId: string
	name?: string
}) {
	const requestIp = getRequestIp(request) ?? undefined
	const validated = validatePasskeyName(name)
	if (!validated.ok) {
		return { ok: false, error: validated.error }
	}

	const renamed = await renamePasskeyForUser(
		env.APP_DB,
		passkeyId,
		user.userId,
		validated.name,
	)
	if (!renamed) {
		return {
			ok: false,
			code: 'not_found' as const,
			error: 'Passkey not found.',
		}
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'passkey_rename',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: '/account/passkeys',
	})
	return { ok: true as const }
}

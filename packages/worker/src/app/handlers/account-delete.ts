import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { isAccountDeletionConfirmation } from '#universal/account-deletion-confirmation.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import { isUsablePasswordHash } from '#worker/identity/usable-password.ts'
import {
	UserDeleteBlockedSoleOwnerError,
	softDeleteUserAccount,
} from '#worker/orgs/soft-delete.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'

function readDeleteRequestFields(body: unknown) {
	if (!body || typeof body !== 'object') {
		return { confirmation: null, password: null }
	}
	const record = body as Record<string, unknown>
	return {
		confirmation:
			typeof record.confirmation === 'string' ? record.confirmation : null,
		password: typeof record.password === 'string' ? record.password : null,
	}
}

export async function deleteAccount({
	env,
	request,
	user,
	body,
}: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	body: unknown
}) {
	const requestIp = getRequestIp(request) ?? undefined
	const url = new URL(request.url)
	const { confirmation, password } = readDeleteRequestFields(body)
	if (!confirmation || !isAccountDeletionConfirmation(confirmation)) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'account_delete',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'invalid_confirmation',
		})
		return {
			status: 400,
			payload: {
				error: 'Account deletion requires typing GOODBYE KODY to confirm.',
			},
		}
	}

	const db = createDb(env.APP_DB)
	const userRow = await db.findOne(usersTable, {
		where: { id: user.userId },
	})
	if (!userRow) {
		return { status: 404, payload: { error: 'User not found.' } }
	}

	if (isUsablePasswordHash(userRow.password_hash)) {
		if (!password) {
			return {
				status: 400,
				payload: {
					error: 'Account deletion requires re-entering the current password.',
				},
			}
		}
		const passwordValid = await verifyPassword(password, userRow.password_hash)
		if (!passwordValid) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'account_delete',
				result: 'failure',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: 'invalid_password',
			})
			return {
				status: 401,
				payload: { error: 'Current password did not match.' },
			}
		}
	}

	let result: Awaited<ReturnType<typeof softDeleteUserAccount>>
	try {
		result = await softDeleteUserAccount({
			env,
			// Account deletion targets the person, not their personal org.
			userId: personalOrgId(user.mcpUser.userId),
			actorUserId: personalOrgId(user.mcpUser.userId),
			actorUsername: user.username,
		})
	} catch (error) {
		if (error instanceof UserDeleteBlockedSoleOwnerError) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'account_delete',
				result: 'failure',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: 'sole_owner_with_members',
			})
			const orgList = error.blockers
				.map((blocker) => `@${blocker.orgSlug}`)
				.join(', ')
			return {
				status: 409,
				payload: {
					error: `Account deletion is blocked while you are the only Owner of ${orgList}. Promote another Owner or remove the other members first.`,
					blockers: error.blockers,
				},
			}
		}
		throw error
	}

	scheduleUserDeletedEvent({
		env,
		user: {
			id: personalOrgId(user.mcpUser.userId),
			username: user.username,
			email: user.email,
		},
	})

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'account_delete',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: url.pathname,
		reason: 'soft_deleted',
	})

	return {
		status: 200,
		payload: { ok: true, softDeleted: true, restoreWindowDays: 30, ...result },
		sessionCookie: await destroyAuthCookie(isSecureRequest(request)),
	}
}

import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	applyPasswordChange,
	type ApplyPasswordChangeResult,
} from '#app/apply-password-change.ts'
import {
	createAuthCookie,
	isSecureRequest,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import { checkRateLimit } from '#app/rate-limit.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { isUsablePasswordHash } from '#worker/identity/usable-password.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import {
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'
import { object, optional, parseSafe, string } from 'remix/data-schema'

const passwordChangeRateLimitConfig = {
	maxRequests: 5,
	windowSeconds: 15 * 60,
}

const passwordChangeRequestSchema = object({
	currentPassword: optional(string()),
	newPassword: string(),
})

function applyFailureReason(
	result: Extract<ApplyPasswordChangeResult, { ok: false }>,
) {
	switch (result.reason) {
		case 'oauth_provider_unavailable':
			return result.reason
		case 'oauth_grant_revoke_failed':
			return result.detail
		default: {
			const unreachable: never = result
			return unreachable
		}
	}
}

function passwordChangeIssuedAt(result: ApplyPasswordChangeResult) {
	if (result.ok) return result.changedAtMs + 1
	if (
		result.reason === 'oauth_grant_revoke_failed' &&
		result.changedAtMs != null
	) {
		return result.changedAtMs + 1
	}
	return Date.now()
}

export async function changeAccountPassword({
	env,
	request,
	user,
	body,
}: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	body: unknown
}): Promise<{
	status: number
	payload: { ok: boolean; error?: string; message?: string; code?: string }
	sessionCookie?: string
	retryAfter?: string
}> {
	const db = createDb(env.APP_DB)
	const url = new URL(request.url)
	const parsed = parseSafe(passwordChangeRequestSchema, body)
	const requestIp = getRequestIp(request) ?? undefined
	const currentPassword = parsed.success
		? (parsed.value.currentPassword ?? '')
		: ''
	const newPassword = parsed.success ? parsed.value.newPassword : ''

	if (!parsed.success || !newPassword) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_change',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'invalid_payload',
		})
		return {
			status: 400,
			payload: { ok: false, error: 'New password is required.' },
		}
	}

	const passwordError = getPasswordPolicyError(newPassword)
	if (passwordError) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_change',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'weak_password',
		})
		return { status: 400, payload: { ok: false, error: passwordError } }
	}

	const userRecord = await db.findOne(usersTable, {
		where: { id: user.userId },
	})
	if (!userRecord) {
		return { status: 401, payload: { ok: false, error: 'Unauthorized.' } }
	}

	const rateLimitKey = `password-change:user:${user.userId}`
	const rateLimit = await checkRateLimit(
		env.APP_DB,
		rateLimitKey,
		passwordChangeRateLimitConfig,
	)
	if (!rateLimit.allowed) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_change',
			result: 'rate_limited',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
		})
		return {
			status: 429,
			payload: {
				ok: false,
				error: 'Too many password change attempts. Please try again later.',
			},
			retryAfter: String(rateLimit.retryAfterSeconds ?? 60),
		}
	}

	const hasUsablePassword = isUsablePasswordHash(userRecord.password_hash)
	if (hasUsablePassword) {
		if (!currentPassword) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'password_change',
				result: 'failure',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: 'missing_current_password',
			})
			return {
				status: 400,
				payload: { ok: false, error: 'Current password is required.' },
			}
		}
		const passwordValid = await verifyPassword(
			currentPassword,
			userRecord.password_hash,
		)
		if (!passwordValid) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'password_change',
				result: 'failure',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: 'invalid_password',
			})
			return {
				status: 401,
				payload: {
					ok: false,
					code: 'invalid_password',
					error: 'Current password is incorrect.',
				},
			}
		}
		if (currentPassword === newPassword) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'password_change',
				result: 'failure',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: 'same_password',
			})
			return {
				status: 400,
				payload: { ok: false, error: 'Choose a different password.' },
			}
		}
	}

	const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthGrantHelpers })
		.OAUTH_PROVIDER
	const result = await applyPasswordChange({
		db,
		d1: env.APP_DB,
		helpers,
		userId: user.userId,
		// Password sessions are person-owned.
		stableUserId: personalOrgId(personIdFromStored(userRecord.stable_user_id)),
		password: newPassword,
	})

	const sessionUserId = user.sessionUserId
	const sessionEmail = user.email
	async function sessionCookieForChange() {
		const parsedSession = await readParsedAuthSession(request)
		return createAuthCookie(
			{
				stableUserId: sessionUserId,
				email: sessionEmail,
				rememberMe: parsedSession?.session.rememberMe ?? false,
			},
			isSecureRequest(request),
			passwordChangeIssuedAt(result),
		)
	}

	if (!result.ok) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_change',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: applyFailureReason(result),
		})
		if (!result.stamped) {
			return {
				status: 500,
				payload: {
					ok: false,
					error: 'Unable to update your password right now.',
				},
			}
		}
		return {
			status: 500,
			payload: {
				ok: false,
				error: 'Unable to update your password right now.',
			},
			sessionCookie: await sessionCookieForChange(),
		}
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'password_change',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: url.pathname,
	})
	return {
		status: 200,
		payload: {
			ok: true,
			message: hasUsablePassword
				? 'Password updated. Other sessions and connected MCP hosts need to sign in again.'
				: 'Password saved. You can sign in with email and password, and other sessions and connected MCP hosts need to sign in again.',
		},
		sessionCookie: await sessionCookieForChange(),
	}
}

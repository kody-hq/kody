import { authOperationResult } from './auth-operation-result.ts'
import { object, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	createEmailClaimReleaseVerification,
	emailClaimReleaseRequestRateLimitConfig,
	emailClaimReleaseSuccessRateLimitConfig,
	EmailClaimReleaseRequestError,
} from '#app/email-claim-release.ts'
import { countRecentEmailClaimReleases } from '#worker/identity/email-claims.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'

const emailClaimReleaseRequestSchema = object({
	email: string(),
	password: string(),
})

function getEmailValidationError(email: string) {
	if (!email) return 'Email is required.'
	if (email.length > 254) return 'Email is too long.'
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return 'Enter a valid email address.'
	}
	return null
}

function releaseRequestErrorMessage(
	reason: 'current_email' | 'not_claimed' | 'already_released',
) {
	switch (reason) {
		case 'current_email':
			return 'You cannot release the email this account currently uses to sign in.'
		case 'already_released':
			return 'That address is already released from this account.'
		case 'not_claimed':
			return 'That address is not claimed by this account.'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}

export async function requestWebsiteEmailRelease({
	env,
	request,
	url,
	body,
}: {
	env: Env
	request: Request
	url: URL
	body: Record<string, unknown>
}) {
	const db = createDb(env.APP_DB)
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return authOperationResult({ ok: false, error: 'Unauthorized.' }, 401)
	}

	const parsed = parseSafe(emailClaimReleaseRequestSchema, body)
	const requestIp = getRequestIp(request) ?? undefined
	const email = parsed.success ? normalizeEmail(parsed.value.email) : ''
	const password = parsed.success ? parsed.value.password : ''
	const validationError = parsed.success
		? getEmailValidationError(email)
		: 'Invalid request body.'
	if (validationError) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_claim_release_request',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'invalid_payload',
		})
		return authOperationResult({ ok: false, error: validationError }, 400)
	}

	const userRecord = await db.findOne(usersTable, {
		where: { id: user.userId },
	})
	if (!userRecord) {
		return authOperationResult({ ok: false, error: 'Unauthorized.' }, 401)
	}

	if (!userRecord.email_verified_at) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_claim_release_request',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'email_unverified',
		})
		return authOperationResult(
			{
				ok: false,
				error:
					'Verify your current email address before releasing a former address.',
			},
			403,
		)
	}

	const requestLimitKey = `email-claim-release-request:user:${user.userId}`
	const requestLimit = await checkRateLimit(
		env.APP_DB,
		requestLimitKey,
		emailClaimReleaseRequestRateLimitConfig,
	)
	if (!requestLimit.allowed) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_claim_release_request',
			result: 'rate_limited',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'request_window',
		})
		return authOperationResult(
			{
				ok: false,
				error: 'Too many release requests. Please try again later.',
			},
			{
				status: 429,
				headers: {
					'Retry-After': String(requestLimit.retryAfterSeconds ?? 60),
				},
			},
		)
	}

	const recentReleases = await countRecentEmailClaimReleases(env.APP_DB, {
		userId: user.userId,
		windowSeconds: emailClaimReleaseSuccessRateLimitConfig.windowSeconds,
	})
	if (recentReleases >= emailClaimReleaseSuccessRateLimitConfig.maxRequests) {
		await releaseRateLimit(env.APP_DB, requestLimitKey).catch(() => undefined)
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_claim_release_request',
			result: 'rate_limited',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'daily_cap',
		})
		return authOperationResult(
			{
				ok: false,
				error:
					'You have released the maximum number of addresses for today. Try again tomorrow.',
			},
			429,
		)
	}

	const passwordValid = await verifyPassword(password, userRecord.password_hash)
	if (!passwordValid) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_claim_release_request',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'invalid_password',
		})
		return authOperationResult(
			{
				ok: false,
				code: 'invalid_password',
				error: 'Password is incorrect.',
			},
			401,
		)
	}

	try {
		await createEmailClaimReleaseVerification({
			env,
			userId: user.userId,
			currentEmail: user.email,
			email,
			requestUrl: url,
		})
	} catch (error) {
		if (error instanceof EmailClaimReleaseRequestError) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'account',
				action: 'email_claim_release_request',
				result: 'failure',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: error.reason,
			})
			return authOperationResult(
				{ ok: false, error: releaseRequestErrorMessage(error.reason) },
				error.reason === 'current_email' ? 400 : 404,
			)
		}
		console.error('Failed to request email claim release:', error)
		await releaseRateLimit(env.APP_DB, requestLimitKey).catch(() => undefined)
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_claim_release_request',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'send_failed',
		})
		return authOperationResult(
			{
				ok: false,
				error:
					'Unable to send the release verification. Please try again later.',
			},
			502,
		)
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'email_claim_release_request',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: url.pathname,
		reason: 'release_requested',
	})
	return authOperationResult({
		ok: true,
		message: 'Verification email sent to that former address.',
	})
}

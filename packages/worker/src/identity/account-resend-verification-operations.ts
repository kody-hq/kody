import { authOperationResult } from './auth-operation-result.ts'
import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createEmailVerification } from '#app/email-verification.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import { emailVerificationSenderBlockMessage } from '#universal/email-verification-delivery.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	EmailVerificationSendBlockedError,
	assertVerificationResendAllowed,
} from '#worker/email/verification-delivery.ts'
import {
	AccountDeletionInProgressError,
	assertAccountWritableDb,
} from '#worker/account/deletion-state.ts'

export const resendVerificationRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 15 * 60,
}

function readResendRedirectTo(body: Record<string, unknown>) {
	const redirectTo = body.redirectTo
	return typeof redirectTo === 'string' ? normalizeRedirectTo(redirectTo) : null
}

export async function resendWebsiteVerification({
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
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return authOperationResult({ ok: false, error: 'Unauthorized.' }, 401)
	}

	const requestIp = getRequestIp(request) ?? undefined
	if (user.emailVerified) {
		return authOperationResult(
			{ ok: false, error: 'Your email is already verified.' },
			400,
		)
	}

	try {
		await assertAccountWritableDb(
			env.APP_DB,
			personalOrgId(user.mcpUser.userId),
		)
	} catch (error) {
		if (error instanceof AccountDeletionInProgressError) {
			return authOperationResult(
				{
					ok: false,
					error: error.message,
					code: 'account_deleting',
				},
				409,
			)
		}
		throw error
	}

	const redirectTo = readResendRedirectTo(body)

	try {
		await assertVerificationResendAllowed(env.APP_DB, user.userId)
	} catch (error) {
		if (error instanceof EmailVerificationSendBlockedError) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'auth',
				action: 'email_verification_resend',
				result: 'failure',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: 'sender_block',
			})
			return authOperationResult(
				{
					ok: false,
					error: error.message || emailVerificationSenderBlockMessage,
					code: 'sender_block',
				},
				409,
			)
		}
		throw error
	}

	const rateLimitKey = `verification-resend:user:${user.userId}`
	const rateLimit = await checkRateLimit(
		env.APP_DB,
		rateLimitKey,
		resendVerificationRateLimitConfig,
	)
	if (!rateLimit.allowed) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'email_verification_resend',
			result: 'rate_limited',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
		})
		return authOperationResult(
			{
				ok: false,
				error:
					'Too many verification emails requested. Please try again later.',
			},
			{
				status: 429,
				headers: {
					'Retry-After': String(rateLimit.retryAfterSeconds ?? 60),
				},
			},
		)
	}

	try {
		await createEmailVerification({
			env,
			userId: user.userId,
			email: user.email,
			requestUrl: url,
			redirectTo,
		})
	} catch (error) {
		if (error instanceof AccountDeletionInProgressError) {
			return authOperationResult(
				{
					ok: false,
					error: error.message,
					code: 'account_deleting',
				},
				409,
			)
		}
		console.error('Failed to resend verification email:', error)
		// A failed send should not eat into the user's resend
		// allowance; refund the slot so they can retry promptly.
		await releaseRateLimit(env.APP_DB, rateLimitKey).catch(() => undefined)
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'email_verification_resend',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'send_failed',
		})
		return authOperationResult(
			{
				ok: false,
				error: 'Unable to send the verification email. Please try again later.',
			},
			502,
		)
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'email_verification_resend',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: url.pathname,
	})
	return authOperationResult({
		ok: true,
		message: 'Verification email sent. Check your inbox.',
	})
}

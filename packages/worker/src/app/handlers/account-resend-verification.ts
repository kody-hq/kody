import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { createEmailVerification } from '#app/email-verification.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import {
	inspectVerificationEmailSend,
	VerificationEmailRefusedError,
} from '#app/verification-email-cap.ts'
import { emailVerificationSenderBlockMessage } from '#universal/email-verification-delivery.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { type routes } from '#universal/routes.ts'
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

async function readResendRedirectTo(request: Request) {
	const contentType = request.headers.get('content-type') ?? ''
	if (!contentType.includes('application/json')) {
		return normalizeRedirectTo(
			new URL(request.url).searchParams.get('redirectTo'),
		)
	}
	const body = await request.json().catch(() => null)
	if (!body || typeof body !== 'object') return null
	const redirectTo = (body as Record<string, unknown>).redirectTo
	return typeof redirectTo === 'string' ? normalizeRedirectTo(redirectTo) : null
}

export function createAccountResendVerificationHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			const requestIp = getRequestIp(request) ?? undefined
			if (user.emailVerified) {
				return jsonResponse(
					{ ok: false, error: 'Your email is already verified.' },
					400,
				)
			}

			try {
				await assertAccountWritableDb(
					env.APP_DB,
					// person-keyed (not personal org)
					personalOrgId(user.mcpUser.userId),
				)
			} catch (error) {
				if (error instanceof AccountDeletionInProgressError) {
					return jsonResponse(
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

			const redirectTo = await readResendRedirectTo(request)

			const verificationSend = await inspectVerificationEmailSend({
				db: env.APP_DB,
				email: user.email,
			})
			if (!verificationSend.ok) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'auth',
					action: 'email_verification_resend',
					result:
						verificationSend.code === 'verification_email_cap'
							? 'rate_limited'
							: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: verificationSend.code,
				})
				return jsonResponse(
					{
						ok: false,
						error: verificationSend.error,
						code: verificationSend.code,
					},
					{
						status: verificationSend.status,
						headers:
							verificationSend.retryAfterSeconds == null
								? undefined
								: {
										'Retry-After': String(verificationSend.retryAfterSeconds),
									},
					},
				)
			}

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
					return jsonResponse(
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
				const retryAfterSeconds = rateLimit.retryAfterSeconds ?? 60
				return jsonResponse(
					{
						ok: false,
						error: `Too many verification emails for this account. You can request ${String(resendVerificationRateLimitConfig.maxRequests)} every ${String(resendVerificationRateLimitConfig.windowSeconds / 60)} minutes. Try again in ${String(Math.ceil(retryAfterSeconds / 60))} minutes.`,
						code: 'verification_resend_cap',
					},
					{
						status: 429,
						headers: {
							'Retry-After': String(retryAfterSeconds),
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
					return jsonResponse(
						{
							ok: false,
							error: error.message,
							code: 'account_deleting',
						},
						409,
					)
				}
				if (error instanceof VerificationEmailRefusedError) {
					await releaseRateLimit(env.APP_DB, rateLimitKey).catch(
						() => undefined,
					)
					void logAuditEvent({
						db: auditDatabaseFromEnv(env),
						category: 'auth',
						action: 'email_verification_resend',
						result:
							error.code === 'verification_email_cap'
								? 'rate_limited'
								: 'failure',
						email: user.email,
						ip: requestIp,
						path: url.pathname,
						reason: error.code,
					})
					return jsonResponse(
						{ ok: false, error: error.message, code: error.code },
						{
							status: error.status,
							headers:
								error.retryAfterSeconds == null
									? undefined
									: { 'Retry-After': String(error.retryAfterSeconds) },
						},
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
				return jsonResponse(
					{
						ok: false,
						error:
							'Unable to send the verification email. Please try again later.',
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
			return jsonResponse({
				ok: true,
				message: 'Verification email sent. Check your inbox.',
			})
		},
	} satisfies Action<typeof routes.accountResendVerification>
}

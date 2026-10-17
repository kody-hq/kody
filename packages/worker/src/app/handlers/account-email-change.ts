import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { object, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { createEmailChangeVerification } from '#app/email-change.ts'
import { isEmailReservedForOtherAccount } from '#worker/identity/email-claims.ts'
import { assessAccountEmail } from '#worker/identity/account-email-policy.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import { type routes } from '#universal/routes.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'

export const emailChangeRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 15 * 60,
}

const emailChangeRequestSchema = object({
	email: string(),
	password: string(),
})

export function createAccountEmailChangeHandler(env: Env) {
	const db = createDb(env.APP_DB)

	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return jsonResponse({ ok: false, error: 'Invalid JSON payload.' }, 400)
			}

			const parsed = parseSafe(emailChangeRequestSchema, body)
			const requestIp = getRequestIp(request) ?? undefined
			const password = parsed.success ? parsed.value.password : ''
			if (!parsed.success) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_change_request',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_payload',
				})
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}
			const emailDecision = await assessAccountEmail(
				normalizeEmail(parsed.value.email),
			)
			if (!emailDecision.ok) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_change_request',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: emailDecision.code,
				})
				return jsonResponse(
					{
						ok: false,
						error: emailDecision.error,
						code: emailDecision.code,
						...(emailDecision.suggestion
							? { suggestion: emailDecision.suggestion }
							: {}),
					},
					400,
				)
			}
			const newEmail = emailDecision.email

			if (newEmail === normalizeEmail(user.email)) {
				return jsonResponse(
					{ ok: false, error: 'Enter a different email address.' },
					400,
				)
			}

			const userRecord = await db.findOne(usersTable, {
				where: { id: user.userId },
			})
			if (!userRecord) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (!userRecord.email_verified_at) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_change_request',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'email_unverified',
				})
				return jsonResponse(
					{
						ok: false,
						error: 'Verify your current email address before changing it.',
					},
					403,
				)
			}

			const rateLimitKey = `email-change:user:${user.userId}`
			const rateLimit = await checkRateLimit(
				env.APP_DB,
				rateLimitKey,
				emailChangeRateLimitConfig,
			)
			if (!rateLimit.allowed) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_change_request',
					result: 'rate_limited',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
				})
				return jsonResponse(
					{
						ok: false,
						error: 'Too many email change requests. Please try again later.',
					},
					{
						status: 429,
						headers: {
							'Retry-After': String(rateLimit.retryAfterSeconds ?? 60),
						},
					},
				)
			}

			const passwordValid = await verifyPassword(
				password,
				userRecord.password_hash,
			)
			if (!passwordValid) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_change_request',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'invalid_password',
				})
				return jsonResponse(
					{
						ok: false,
						code: 'invalid_password',
						error: 'Password is incorrect.',
					},
					401,
				)
			}

			const existingUser = await db.findOne(usersTable, {
				where: { email: newEmail },
			})
			const reservedByOther = existingUser
				? existingUser.id !== user.userId
				: await isEmailReservedForOtherAccount(
						env.APP_DB,
						newEmail,
						user.userId,
					)
			if (reservedByOther) {
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_change_request',
					result: 'failure',
					email: user.email,
					ip: requestIp,
					path: url.pathname,
					reason: 'email_exists',
				})
				return jsonResponse(
					{ ok: false, error: 'Email already registered.' },
					409,
				)
			}

			try {
				await createEmailChangeVerification({
					env,
					userId: user.userId,
					currentEmail: user.email,
					newEmail,
					requestUrl: url,
				})
			} catch (error) {
				await releaseRateLimit(env.APP_DB, rateLimitKey).catch(() => undefined)
				const uniqueField = getUniqueConstraintField(error)
				if (uniqueField === 'new_email') {
					return jsonResponse(
						{ ok: false, error: 'Email change is already pending.' },
						409,
					)
				}
				console.error('Failed to request email change:', error)
				void logAuditEvent({
					db: auditDatabaseFromEnv(env),
					category: 'account',
					action: 'email_change_request',
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
							'Unable to send the email change verification. Please try again later.',
					},
					502,
				)
			}

			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'account',
				action: 'email_change_request',
				result: 'success',
				email: user.email,
				ip: requestIp,
				path: url.pathname,
				reason: `new_email=${newEmail}`,
			})
			return jsonResponse({
				ok: true,
				formerEmailRemainsClaimed: true,
				message:
					'Verification email sent to your new address. After you confirm, your current address stays tied to this account until you release it from Former addresses.',
			})
		},
	} satisfies Action<typeof routes.accountEmailChange>
}

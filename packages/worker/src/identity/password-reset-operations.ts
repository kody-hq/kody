import { authOperationResult } from './auth-operation-result.ts'
import { object, parseSafe, string } from 'remix/data-schema'
import { createDb, passwordResetsTable, usersTable } from '#worker/db.ts'
import {
	auditDatabaseFromEnv,
	logAuditEvent,
	getRequestIp,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import { deferWork } from '#worker/deferred-work.ts'
import {
	sendGatedTransactionalEmail,
	type GatedTransactionalSendResult,
} from '#worker/email/transactional-send-policy.ts'
import {
	registerTransactionalEmailDelivery,
	transactionalPasswordResetConfirmedKind,
	transactionalPasswordResetKind,
} from '#worker/email/verification-delivery.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	createPasswordResetToken,
	hashPasswordResetToken,
	passwordResetTokenExpiryMs,
} from '#worker/identity/password-reset-tokens.ts'
import { applyPasswordChange } from '#app/apply-password-change.ts'
import { clearedFactorsAuditReason } from '#app/clear-account-factors.ts'
import { getPasswordPolicyError } from '@kody-internal/shared/password-policy.ts'
import { checkPublicFormProtection } from '#app/public-form-protection.ts'
import {
	buildPasswordResetConfirmedEmail,
	buildPasswordResetEmail,
} from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import {
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'

const resetRequestSchema = object({
	email: string(),
})

const resetConfirmSchema = object({
	token: string(),
	password: string(),
})

function logHardBounceSuppression(input: {
	to: string
	kind: string
	result: GatedTransactionalSendResult
}) {
	if (input.result.ok || !('code' in input.result)) return
	if (input.result.code !== 'recipient_hard_bounce') return
	console.info(
		'password-reset-hard-bounce-suppressed',
		JSON.stringify({
			to: redactEmailRecipient(input.to),
			kind: input.kind,
		}),
	)
}

async function rememberPasswordResetDelivery(input: {
	db: D1Database
	userId: number
	recipient: string
	kind:
		| typeof transactionalPasswordResetKind
		| typeof transactionalPasswordResetConfirmedKind
	result: GatedTransactionalSendResult
}) {
	if (!input.result.ok || !input.result.messageId) return
	await registerTransactionalEmailDelivery({
		db: input.db,
		providerMessageId: input.result.messageId,
		userId: input.userId,
		recipient: input.recipient,
		kind: input.kind,
	}).catch((error) => {
		console.warn('password-reset-delivery-index-failed', error)
	})
}

function logMissingEmailConfig(payload: { to: string; subject: string }) {
	console.warn(
		'password-reset-email-sender-unconfigured',
		JSON.stringify({
			to: redactEmailRecipient(payload.to),
			subject: payload.subject,
		}),
	)
}

function getPasswordResetEmailConfig(
	env: Pick<Env, 'APP_BASE_URL' | 'SYSTEM_EMAIL_DOMAIN'> & {
		WRANGLER_IS_LOCAL_DEV?: string
	},
	requestUrl?: string | URL,
) {
	return resolveTransactionalEmailConfig({
		env,
		requestUrl: env.WRANGLER_IS_LOCAL_DEV === 'true' ? requestUrl : undefined,
	})
}

export async function requestWebsitePasswordReset({
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
	const protection = await checkPublicFormProtection({
		env,
		request,
		body:
			typeof body === 'object' && body !== null
				? (body as Record<string, unknown>)
				: {},
	})
	if (!protection.ok)
		return authOperationResult({ error: protection.error }, 400)
	const parsed = parseSafe(resetRequestSchema, body)
	const requestIp = getRequestIp(request) ?? undefined
	const normalizedEmail = parsed.success
		? normalizeEmail(parsed.value.email)
		: ''

	if (!parsed.success || !normalizedEmail) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_reset_request',
			result: 'failure',
			email: normalizedEmail || undefined,
			ip: requestIp,
			path: url.pathname,
			reason: 'invalid_payload',
		})
		return authOperationResult({ error: 'Email is required.' }, { status: 400 })
	}

	const userRecord = await db.findOne(usersTable, {
		where: { email: normalizedEmail },
	})

	if (userRecord) {
		const userId = userRecord.id
		// Token writes and the email send happen after the response so
		// the reply latency does not depend on whether the address is
		// registered; the uniform message body alone would still leak
		// account existence through a timing side channel.
		void deferWork('password-reset-request-error', async () => {
			const emailConfig = getPasswordResetEmailConfig(env, url)
			const resetToken = await createPasswordResetToken({
				db: env.APP_DB,
				userId,
				expiresAt: Date.now() + passwordResetTokenExpiryMs,
			})
			const appBaseUrl = new URL(emailConfig?.appBaseUrl ?? url).origin
			const resetUrl = new URL('/reset-password', appBaseUrl)
			resetUrl.searchParams.set('token', resetToken.token)
			const email = buildPasswordResetEmail({
				appBaseUrl,
				resetUrl: resetUrl.toString(),
			})

			if (!emailConfig) {
				logMissingEmailConfig({
					to: normalizedEmail,
					subject: email.subject,
				})
				return
			}

			try {
				const sendResult = await sendGatedTransactionalEmail({
					db: env.APP_DB,
					config: {
						accountId: env.CLOUDFLARE_ACCOUNT_ID,
						apiBaseUrl: env.CLOUDFLARE_API_BASE_URL,
						apiToken: env.CLOUDFLARE_API_TOKEN,
					},
					category: 'essential',
					kind: transactionalPasswordResetKind,
					message: {
						to: normalizedEmail,
						from: emailConfig.fromEmail,
						subject: email.subject,
						html: email.html,
						text: email.text,
					},
				})
				logHardBounceSuppression({
					to: normalizedEmail,
					kind: transactionalPasswordResetKind,
					result: sendResult,
				})
				await rememberPasswordResetDelivery({
					db: env.APP_DB,
					userId,
					recipient: normalizedEmail,
					kind: transactionalPasswordResetKind,
					result: sendResult,
				})
			} catch (error) {
				console.warn('cloudflare-email-error', error)
			}
		})

		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_reset_request',
			result: 'success',
			email: normalizedEmail,
			ip: requestIp,
			path: url.pathname,
		})
	} else {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_reset_request',
			result: 'failure',
			email: normalizedEmail,
			ip: requestIp,
			path: url.pathname,
			reason: 'email_not_found',
		})
	}

	return authOperationResult({
		ok: true,
		message: 'If the account exists, a reset email has been sent.',
	})
}

export async function confirmWebsitePasswordReset({
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
	const protection = await checkPublicFormProtection({
		env,
		request,
		body:
			typeof body === 'object' && body !== null
				? (body as Record<string, unknown>)
				: {},
	})
	if (!protection.ok)
		return authOperationResult({ error: protection.error }, 400)
	const parsed = parseSafe(resetConfirmSchema, body)
	const requestIp = getRequestIp(request) ?? undefined
	const token = parsed.success ? parsed.value.token.trim() : ''
	const password = parsed.success ? parsed.value.password : ''

	if (!parsed.success || !token || !password) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'failure',
			ip: requestIp,
			path: url.pathname,
			reason: 'invalid_payload',
		})
		return authOperationResult(
			{ error: 'Token and password are required.' },
			{ status: 400 },
		)
	}

	const passwordError = getPasswordPolicyError(password)
	if (passwordError) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'failure',
			ip: requestIp,
			path: url.pathname,
			reason: 'weak_password',
		})
		return authOperationResult({ error: passwordError }, { status: 400 })
	}

	const tokenHash = await hashPasswordResetToken(token)
	const resetRecord = await db.findOne(passwordResetsTable, {
		where: { token_hash: tokenHash },
	})
	const now = Date.now()

	if (!resetRecord || resetRecord.expires_at < now) {
		if (resetRecord && resetRecord.expires_at < now) {
			await db.delete(passwordResetsTable, resetRecord.id)
		}
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'failure',
			ip: requestIp,
			path: url.pathname,
			reason: resetRecord ? 'expired_token' : 'invalid_token',
		})
		return authOperationResult(
			{ error: 'Reset link is invalid or expired.' },
			{ status: 400 },
		)
	}

	const userRecord = await db.findOne(usersTable, {
		where: { id: resetRecord.user_id },
	})
	if (!userRecord) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'failure',
			ip: requestIp,
			path: url.pathname,
			reason: 'user_not_found',
		})
		return authOperationResult(
			{ error: 'Reset link is invalid or expired.' },
			{ status: 400 },
		)
	}

	const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthGrantHelpers })
		.OAUTH_PROVIDER
	const result = await applyPasswordChange({
		db,
		d1: env.APP_DB,
		helpers,
		userId: resetRecord.user_id,
		stableUserId: personalOrgId(personIdFromStored(userRecord.stable_user_id)),
		password,
		clearSecondFactorsAndConnections: true,
	})
	if (!result.ok) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'password_reset_confirm',
			result: 'failure',
			ip: requestIp,
			path: url.pathname,
			reason:
				result.reason === 'oauth_grant_revoke_failed'
					? result.detail
					: result.reason,
		})
		return authOperationResult(
			{ error: 'Unable to finish password reset right now.' },
			{ status: 500 },
		)
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'password_reset_confirm',
		result: 'success',
		ip: requestIp,
		path: url.pathname,
		reason: result.cleared
			? clearedFactorsAuditReason(result.cleared)
			: undefined,
	})

	const emailConfig = getPasswordResetEmailConfig(env, url)
	const accountUrl = new URL(
		'/account',
		emailConfig?.appBaseUrl ?? url,
	).toString()
	const email = buildPasswordResetConfirmedEmail({
		appBaseUrl: emailConfig?.appBaseUrl ?? new URL(url).origin,
		accountUrl,
	})
	if (!emailConfig) {
		logMissingEmailConfig({
			to: userRecord.email,
			subject: email.subject,
		})
	} else {
		try {
			const sendResult = await sendGatedTransactionalEmail({
				db: env.APP_DB,
				config: {
					accountId: env.CLOUDFLARE_ACCOUNT_ID,
					apiBaseUrl: env.CLOUDFLARE_API_BASE_URL,
					apiToken: env.CLOUDFLARE_API_TOKEN,
				},
				category: 'essential',
				kind: transactionalPasswordResetConfirmedKind,
				message: {
					to: userRecord.email,
					from: emailConfig.fromEmail,
					subject: email.subject,
					html: email.html,
					text: email.text,
				},
			})
			logHardBounceSuppression({
				to: userRecord.email,
				kind: transactionalPasswordResetConfirmedKind,
				result: sendResult,
			})
			await rememberPasswordResetDelivery({
				db: env.APP_DB,
				userId: resetRecord.user_id,
				recipient: userRecord.email,
				kind: transactionalPasswordResetConfirmedKind,
				result: sendResult,
			})
		} catch (error) {
			console.warn('cloudflare-email-error', error)
		}
	}

	return authOperationResult({ ok: true })
}

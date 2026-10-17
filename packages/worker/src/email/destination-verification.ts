import * as Sentry from '@sentry/cloudflare'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { redactEmailRecipient } from '#worker/audit-log.ts'
import { buildEmailDestinationVerificationEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { checkRateLimit, releaseRateLimit } from '#app/rate-limit.ts'
import {
	accountSuspendedMessage,
	getAccountRestrictionsByStableUserId,
} from '#worker/account/account-suspension.ts'
import {
	generateVerificationToken,
	hashVerificationToken,
	verificationTokenExpiryMs,
} from '#worker/identity/email-verification-tokens.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { normalizeEmailAddress } from './address.ts'
import {
	addEmailNotificationDestination,
	deleteEmailNotificationDestinationRow,
	EmailDestinationError,
	getEmailDestinationValidationError,
	loadEmailDestinationAccount,
	markEmailNotificationDestinationVerified,
	type EmailDestinationErrorCode,
	type EmailNotificationDestination,
} from './destinations.ts'
import { emailOutboundPausedMessage } from './outbound-abuse.ts'
import { emailOutboundDeliveryPausedMessage } from './outbound-consecutive-failures.ts'
import { resolveUserPlatformSender } from './platform-address.ts'
import { gateTransactionalSend } from './transactional-send-policy.ts'
import {
	CloudflareEmailProviderSkippedError,
	sendViaCloudflareEmailProvider,
} from './provider-send.ts'
import {
	registerTransactionalEmailDelivery,
	transactionalEmailDestinationVerificationKind,
} from './verification-delivery.ts'

/**
 * Destination-verification abuse caps. `docs/use/email-primitives.md`,
 * `docs/contributing/architecture/authentication.md`, and the
 * `emailDestinationAdd` capability description repeat these defaults.
 */
export const emailDestinationRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 15 * 60,
}

/** Per-user rolling daily cap, in addition to the 15-minute burst limit. */
export const emailDestinationUserDailyCap = {
	maxRequests: 10,
	windowSeconds: 24 * 60 * 60,
}

/**
 * Per-recipient rolling daily cap across every account. The rate-limit key
 * is a hash of the normalized address so `_rate_limits` does not store it.
 */
export const emailDestinationRecipientDailyCap = {
	maxRequests: 3,
	windowSeconds: 24 * 60 * 60,
}

/** `users.created_at` must be at least this old before verification mail. */
export const emailDestinationMinimumAccountAgeMs = 24 * 60 * 60 * 1000

export function emailDestinationUserBurstRateLimitKey(userId: number) {
	return `email-destination:user:${userId}`
}

function emailDestinationUserDailyRateLimitKey(userId: number) {
	return `email-destination:user-daily:${userId}`
}

type DestinationVerificationCapCode = Extract<
	EmailDestinationErrorCode,
	'rate_limited' | 'user_daily_cap' | 'recipient_daily_cap'
>

type DestinationVerificationAllowance = {
	recipientEmail: string
	userDaily: boolean
	recipient: boolean
	burst: boolean
}

function formatRetryAtUtc(date: Date) {
	const iso = date.toISOString()
	return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

function formatWindow(windowSeconds: number) {
	if (windowSeconds % (60 * 60) === 0) {
		const hours = windowSeconds / (60 * 60)
		return hours === 1 ? '1 hour' : `${hours} hours`
	}
	if (windowSeconds % 60 === 0) {
		const minutes = windowSeconds / 60
		return minutes === 1 ? '1 minute' : `${minutes} minutes`
	}
	return windowSeconds === 1 ? '1 second' : `${windowSeconds} seconds`
}

function formatMinimumAccountAge() {
	return formatWindow(emailDestinationMinimumAccountAgeMs / 1000)
}

function parseStoredTimestampMs(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return null
	const sqliteUtc =
		/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z)?$/.exec(trimmed)
	const normalized = sqliteUtc
		? `${sqliteUtc[1]}T${sqliteUtc[2]}${sqliteUtc[3] ?? 'Z'}`
		: trimmed
	const ms = Date.parse(normalized)
	return Number.isFinite(ms) ? ms : null
}

function requireDestinationRecipient(email: string) {
	const validationError = getEmailDestinationValidationError(email)
	if (validationError) {
		throw new EmailDestinationError('invalid_email', validationError)
	}
	const canonical = normalizeEmailAddress(email)
	if (!canonical) {
		throw new EmailDestinationError(
			'invalid_email',
			'Enter a valid email address.',
		)
	}
	return canonical
}

function canonicalDestinationRecipient(email: string) {
	return normalizeEmailAddress(email) ?? email.trim().toLowerCase()
}

async function destinationVerificationRecipientRateLimitKey(email: string) {
	const digest = await sha256Hex(canonicalDestinationRecipient(email))
	return `email-destination:recipient:${digest}`
}

async function readDestinationVerificationRetry(
	db: D1Database,
	key: string,
	windowSeconds: number,
) {
	const nowSeconds = Math.floor(Date.now() / 1000)
	const row = await db
		.prepare(
			`SELECT MIN(ts) AS oldest
			 FROM _rate_limits
			 WHERE key = ? AND ts > ?`,
		)
		.bind(key, nowSeconds - windowSeconds)
		.first<{ oldest: number | null }>()
	const oldest = row?.oldest
	if (typeof oldest !== 'number') {
		return {
			retryAt: new Date((nowSeconds + windowSeconds) * 1000),
			retryAfterSeconds: windowSeconds,
		}
	}
	const retryAtSeconds = oldest + windowSeconds
	return {
		retryAt: new Date(retryAtSeconds * 1000),
		retryAfterSeconds: Math.max(1, retryAtSeconds - nowSeconds),
	}
}

async function consumeDestinationVerificationSlot(input: {
	db: D1Database
	key: string
	config: { maxRequests: number; windowSeconds: number }
	code: DestinationVerificationCapCode
	message: (retryAtLabel: string) => string
}) {
	const rateLimit = await checkRateLimit(input.db, input.key, input.config)
	if (rateLimit.allowed) return
	const retry = await readDestinationVerificationRetry(
		input.db,
		input.key,
		input.config.windowSeconds,
	)
	throw new EmailDestinationError(
		input.code,
		input.message(formatRetryAtUtc(retry.retryAt)),
		{ retryAfterSeconds: retry.retryAfterSeconds },
	)
}

async function assertDestinationVerificationAccountAge(
	db: D1Database,
	userId: number,
	now = new Date(),
) {
	const row = await db
		.prepare(
			`SELECT created_at
			 FROM users
			 WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{ created_at: string | null }>()
	if (!row) {
		throw new Error('Account was not found for destination verification.')
	}
	const createdMs = row.created_at
		? parseStoredTimestampMs(row.created_at)
		: null
	const ageLabel = formatMinimumAccountAge()
	if (createdMs == null) {
		throw new EmailDestinationError(
			'account_too_new',
			`New accounts can add email destinations ${ageLabel} after signup, and this account has no readable creation time. Contact support so we can confirm when the account was created.`,
		)
	}
	const eligibleAtMs = createdMs + emailDestinationMinimumAccountAgeMs
	if (now.getTime() >= eligibleAtMs) return
	throw new EmailDestinationError(
		'account_too_new',
		`New accounts can add email destinations ${ageLabel} after signup. Try again after ${formatRetryAtUtc(new Date(eligibleAtMs))}. If you need an address before then, contact support.`,
		{
			retryAfterSeconds: Math.max(
				1,
				Math.ceil((eligibleAtMs - now.getTime()) / 1000),
			),
		},
	)
}

async function acquireDestinationVerificationAllowance(input: {
	db: D1Database
	userId: number
	recipientEmail: string
}) {
	const allowance: DestinationVerificationAllowance = {
		recipientEmail: input.recipientEmail,
		userDaily: false,
		recipient: false,
		burst: false,
	}
	try {
		await consumeDestinationVerificationSlot({
			db: input.db,
			key: emailDestinationUserDailyRateLimitKey(input.userId),
			config: emailDestinationUserDailyCap,
			code: 'user_daily_cap',
			message: (retryAtLabel) =>
				`Destination verification email was not sent. This account has reached the limit of ${emailDestinationUserDailyCap.maxRequests} destination verification emails per rolling ${formatWindow(emailDestinationUserDailyCap.windowSeconds)}. Try again after ${retryAtLabel}.`,
		})
		allowance.userDaily = true
		await consumeDestinationVerificationSlot({
			db: input.db,
			key: await destinationVerificationRecipientRateLimitKey(
				input.recipientEmail,
			),
			config: emailDestinationRecipientDailyCap,
			code: 'recipient_daily_cap',
			message: (retryAtLabel) =>
				`Destination verification email was not sent to this address. It has already received ${emailDestinationRecipientDailyCap.maxRequests} destination verification emails in the last ${formatWindow(emailDestinationRecipientDailyCap.windowSeconds)}, the maximum across all accounts. Use a different address, or try again after ${retryAtLabel}. If you did not request these emails, contact support.`,
		})
		allowance.recipient = true
		await consumeDestinationVerificationSlot({
			db: input.db,
			key: emailDestinationUserBurstRateLimitKey(input.userId),
			config: emailDestinationRateLimitConfig,
			code: 'rate_limited',
			message: (retryAtLabel) =>
				`Destination verification email was not sent. You can request at most ${emailDestinationRateLimitConfig.maxRequests} every ${formatWindow(emailDestinationRateLimitConfig.windowSeconds)}. Try again after ${retryAtLabel}.`,
		})
		allowance.burst = true
		return allowance
	} catch (error) {
		await refundDestinationVerificationAllowance(
			input.db,
			input.userId,
			allowance,
		)
		throw error
	}
}

async function refundDestinationVerificationAllowance(
	db: D1Database,
	userId: number,
	allowance: DestinationVerificationAllowance,
) {
	if (allowance.userDaily) {
		await releaseRateLimit(
			db,
			emailDestinationUserDailyRateLimitKey(userId),
		).catch(() => undefined)
	}
	if (allowance.recipient) {
		await releaseRateLimit(
			db,
			await destinationVerificationRecipientRateLimitKey(
				allowance.recipientEmail,
			),
		).catch(() => undefined)
	}
	if (allowance.burst) {
		await releaseRateLimit(
			db,
			emailDestinationUserBurstRateLimitKey(userId),
		).catch(() => undefined)
	}
}

export type VerifyEmailDestinationReason =
	| 'missing_token'
	| 'invalid_token'
	| 'expired_token'

export type VerifyEmailDestinationResult =
	| {
			ok: true
			userId: number
			email: string
	  }
	| {
			ok: false
			reason: VerifyEmailDestinationReason
	  }

function readDestinationVerificationToken(token: unknown) {
	if (typeof token !== 'string') return ''
	return token.trim().toLowerCase()
}

function getDestinationLinkConfig(input: {
	env: Pick<Env, 'APP_BASE_URL' | 'SYSTEM_EMAIL_DOMAIN'> & {
		WRANGLER_IS_LOCAL_DEV?: string
	}
	requestUrl: string | URL
}) {
	return (
		resolveTransactionalEmailConfig({
			env: input.env,
			requestUrl: input.requestUrl,
		}) ?? {
			appBaseUrl: new URL(input.requestUrl).origin,
			fromEmail: `kody@${new URL(input.requestUrl).hostname}`,
		}
	)
}

export function buildEmailDestinationVerificationUrl(input: {
	appBaseUrl: string
	token: string
}) {
	const verificationUrl = new URL('/verify-email-destination', input.appBaseUrl)
	verificationUrl.searchParams.set('token', input.token)
	return verificationUrl
}

async function insertDestinationVerificationToken(input: {
	db: D1Database
	userId: number
	destinationId: string
	now?: Date
}) {
	const token = generateVerificationToken()
	const tokenHash = await hashVerificationToken(token)
	const now = input.now ?? new Date()
	const expiresAt = now.getTime() + verificationTokenExpiryMs
	await input.db
		.prepare(
			`INSERT INTO pending_email_destination_verifications
			 (user_id, destination_id, token_hash, expires_at)
			 VALUES (?, ?, ?, ?)`,
		)
		.bind(input.userId, input.destinationId, tokenHash, expiresAt)
		.run()
	return { token, tokenHash }
}

async function discardDestinationVerificationToken(
	db: D1Database,
	tokenHash: string,
) {
	await db
		.prepare(
			`DELETE FROM pending_email_destination_verifications
			 WHERE token_hash = ?`,
		)
		.bind(tokenHash)
		.run()
		.catch(() => undefined)
}

function captureDestinationVerificationSendFailure(input: {
	error: unknown
	userId: number
	destinationEmail: string
	from: string
}) {
	Sentry.captureException(input.error, {
		tags: {
			email_flow: 'destination_verification',
		},
		extra: {
			userId: input.userId,
			destinationEmail: redactEmailRecipient(input.destinationEmail),
			from: redactEmailRecipient(input.from),
		},
	})
}

async function sendDestinationVerificationEmail(input: {
	env: Env
	userId: number
	destinationId: string
	destinationEmail: string
	requestUrl: string | URL
	token: string
	tokenHash: string
	onSendFailure: () => Promise<void>
}) {
	let fromForReporting = 'unresolved'
	try {
		const account = await loadEmailDestinationAccount({
			db: input.env.APP_DB,
			dbUserId: input.userId,
		})
		if (!account) {
			throw new Error('Account was not found for destination verification.')
		}

		const restrictions = await getAccountRestrictionsByStableUserId({
			db: input.env.APP_DB,
			stableUserId: account.stableUserId,
		})
		if (restrictions?.suspendedAt) {
			throw new Error(accountSuspendedMessage)
		}
		if (restrictions?.emailOutboundPausedAt) {
			throw new Error(emailOutboundPausedMessage)
		}
		if (restrictions?.emailOutboundDeliveryPausedAt) {
			throw new Error(emailOutboundDeliveryPausedMessage)
		}

		const linkConfig = getDestinationLinkConfig({
			env: input.env,
			requestUrl: input.requestUrl,
		})
		const sender = await resolveUserPlatformSender({
			db: input.env.APP_DB,
			env: input.env,
			accountEmail: account.email,
			userId: account.stableUserId,
		})
		fromForReporting = sender.from
		const verificationUrl = buildEmailDestinationVerificationUrl({
			appBaseUrl: linkConfig.appBaseUrl,
			token: input.token,
		})
		const email = buildEmailDestinationVerificationEmail({
			appBaseUrl: linkConfig.appBaseUrl,
			destinationEmail: input.destinationEmail,
			verificationUrl: verificationUrl.toString(),
		})

		const gate = await gateTransactionalSend({
			db: input.env.APP_DB,
			recipient: input.destinationEmail,
			category: 'essential',
		})
		if (!gate.allowed) {
			throw new Error(gate.message)
		}

		const sendResult = await sendViaCloudflareEmailProvider({
			env: input.env,
			from: sender.from,
			to: [input.destinationEmail],
			subject: email.subject,
			html: email.html,
			text: email.text,
		})
		if (sendResult.messageId) {
			await registerTransactionalEmailDelivery({
				db: input.env.APP_DB,
				providerMessageId: sendResult.messageId,
				userId: input.userId,
				recipient: input.destinationEmail,
				kind: transactionalEmailDestinationVerificationKind,
			}).catch((error) => {
				console.warn(
					'email-destination-verification-delivery-index-failed',
					error,
				)
			})
		}
	} catch (error) {
		if (
			error instanceof CloudflareEmailProviderSkippedError &&
			isNonProductionRuntime(input.env)
		) {
			console.warn('email-destination-verify-send-skipped', input.userId)
			return
		}
		await input.onSendFailure()
		captureDestinationVerificationSendFailure({
			error,
			userId: input.userId,
			destinationEmail: input.destinationEmail,
			from: fromForReporting,
		})
		throw error instanceof Error
			? error
			: new Error('Destination verification could not be sent.')
	}
}

export async function createEmailDestinationVerification(input: {
	env: Env
	userId: number
	email: string
	requestUrl: string | URL
}): Promise<{ destination: EmailNotificationDestination; created: boolean }> {
	const recipientEmail = requireDestinationRecipient(input.email)
	await assertDestinationVerificationAccountAge(input.env.APP_DB, input.userId)
	const allowance = await acquireDestinationVerificationAllowance({
		db: input.env.APP_DB,
		userId: input.userId,
		recipientEmail,
	})
	try {
		const added = await addEmailNotificationDestination({
			db: input.env.APP_DB,
			dbUserId: input.userId,
			email: recipientEmail,
		})
		const minted = await insertDestinationVerificationToken({
			db: input.env.APP_DB,
			userId: input.userId,
			destinationId: added.destination.id,
		})
		await sendDestinationVerificationEmail({
			env: input.env,
			userId: input.userId,
			destinationId: added.destination.id,
			destinationEmail: added.destination.email,
			requestUrl: input.requestUrl,
			token: minted.token,
			tokenHash: minted.tokenHash,
			onSendFailure: async () => {
				await discardDestinationVerificationToken(
					input.env.APP_DB,
					minted.tokenHash,
				)
				if (added.created) {
					await deleteEmailNotificationDestinationRow({
						db: input.env.APP_DB,
						destinationId: added.destination.id,
						userId: input.userId,
					})
				}
			},
		})
		return added
	} catch (error) {
		await refundDestinationVerificationAllowance(
			input.env.APP_DB,
			input.userId,
			allowance,
		)
		throw error
	}
}

export async function resendEmailDestinationVerification(input: {
	env: Env
	userId: number
	destinationId: string
	requestUrl: string | URL
}): Promise<EmailNotificationDestination> {
	const row = await input.env.APP_DB.prepare(
		`SELECT id, email, verified_at, is_default
		 FROM email_notification_destinations
		 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.destinationId, input.userId)
		.first<{
			id: string
			email: string
			verified_at: string | null
			is_default: number
		}>()
	if (!row) {
		throw new Error('Email destination was not found.')
	}
	if (row.verified_at) {
		throw new Error('That address is already verified.')
	}

	await assertDestinationVerificationAccountAge(input.env.APP_DB, input.userId)
	const allowance = await acquireDestinationVerificationAllowance({
		db: input.env.APP_DB,
		userId: input.userId,
		recipientEmail: canonicalDestinationRecipient(row.email),
	})

	try {
		const minted = await insertDestinationVerificationToken({
			db: input.env.APP_DB,
			userId: input.userId,
			destinationId: row.id,
		})

		await sendDestinationVerificationEmail({
			env: input.env,
			userId: input.userId,
			destinationId: row.id,
			destinationEmail: row.email,
			requestUrl: input.requestUrl,
			token: minted.token,
			tokenHash: minted.tokenHash,
			onSendFailure: async () => {
				await discardDestinationVerificationToken(
					input.env.APP_DB,
					minted.tokenHash,
				)
			},
		})
	} catch (error) {
		await refundDestinationVerificationAllowance(
			input.env.APP_DB,
			input.userId,
			allowance,
		)
		throw error
	}

	return {
		id: row.id,
		email: row.email,
		kind: 'additional',
		verified: false,
		isDefault: row.is_default === 1,
		canRemove: true,
	}
}

async function retireSiblingDestinationVerificationTokens(
	db: D1Database,
	destinationId: string,
	tokenHash: string,
) {
	await db
		.prepare(
			`DELETE FROM pending_email_destination_verifications
			 WHERE destination_id = ? AND token_hash != ?`,
		)
		.bind(destinationId, tokenHash)
		.run()
		.catch((error) => {
			console.warn('email-destination-token-cleanup-failed', error)
		})
}

export async function verifyEmailDestinationToken(input: {
	db: D1Database
	token: unknown
	now?: Date
	/** When false, a valid unused token is not consumed. HEAD probes use this. */
	consume?: boolean
}): Promise<VerifyEmailDestinationResult> {
	const token = readDestinationVerificationToken(input.token)
	if (!token) return { ok: false, reason: 'missing_token' }

	const tokenHash = await hashVerificationToken(token)
	const record = await input.db
		.prepare(
			`SELECT p.id, p.user_id, p.destination_id, p.expires_at, d.email
			 FROM pending_email_destination_verifications p
			 LEFT JOIN email_notification_destinations d ON d.id = p.destination_id
			 WHERE p.token_hash = ?${andLiveDeletedAtSql()}`,
		)
		.bind(tokenHash)
		.first<{
			id: number
			user_id: number
			destination_id: string
			expires_at: number
			email: string | null
		}>()
	const now = input.now ?? new Date()

	if (!record) return { ok: false, reason: 'invalid_token' }
	if (record.expires_at < now.getTime()) {
		await input.db
			.prepare(
				`DELETE FROM pending_email_destination_verifications WHERE id = ?`,
			)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'expired_token' }
	}
	if (!record.email) {
		await input.db
			.prepare(
				`DELETE FROM pending_email_destination_verifications WHERE id = ?`,
			)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'invalid_token' }
	}

	if (input.consume === false) {
		return {
			ok: true,
			userId: record.user_id,
			email: record.email,
		}
	}

	const destination = await markEmailNotificationDestinationVerified({
		db: input.db,
		destinationId: record.destination_id,
		userId: record.user_id,
		now,
	})
	if (!destination) return { ok: false, reason: 'invalid_token' }

	await retireSiblingDestinationVerificationTokens(
		input.db,
		record.destination_id,
		tokenHash,
	)

	return {
		ok: true,
		userId: record.user_id,
		email: destination.email,
	}
}

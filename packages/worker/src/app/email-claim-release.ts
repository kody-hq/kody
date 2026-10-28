import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import {
	buildDeletedAccountReleaseEmail,
	buildEmailClaimReleaseEmail,
} from '#app/email/messages.ts'
import { consumeDeletedAccountReleaseToken } from '#worker/identity/deleted-account-identity-release.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import {
	countRecentEmailClaimReleases,
	releaseAccountEmailClaim,
	resolveReleasableEmailClaim,
} from '#worker/identity/email-claims.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const emailClaimReleaseRequestRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 15 * 60,
}

export const emailClaimReleaseSuccessRateLimitConfig = {
	maxRequests: 3,
	windowSeconds: 24 * 60 * 60,
}

const emailClaimReleaseTokenBytes = 32
const emailClaimReleaseTokenExpiryMs = 24 * 60 * 60 * 1000

function generateEmailClaimReleaseToken() {
	const bytes = new Uint8Array(emailClaimReleaseTokenBytes)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

function getEmailClaimReleaseConfig(input: {
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

export async function createEmailClaimReleaseVerification(input: {
	env: Env
	userId: number
	currentEmail: string
	email: string
	requestUrl: string | URL
}) {
	const email = normalizeEmail(input.email)
	const releasable = await resolveReleasableEmailClaim({
		db: input.env.APP_DB,
		userId: input.userId,
		currentEmail: input.currentEmail,
		email,
	})
	if (!releasable.ok) {
		throw new EmailClaimReleaseRequestError(releasable.reason)
	}
	await sendEmailClaimReleaseLink({
		env: input.env,
		userId: input.userId,
		email,
		requestUrl: input.requestUrl,
		buildMessage: buildEmailClaimReleaseEmail,
	})
}

/**
 * Mail a link that proves the signup email before a soft-deleted account
 * holding it is superseded. Password signup alone is not proof.
 */
export async function createDeletedAccountReleaseVerification(input: {
	env: Env
	deletedUserId: number
	email: string
	requestUrl: string | URL
}) {
	await sendEmailClaimReleaseLink({
		env: input.env,
		userId: input.deletedUserId,
		email: normalizeEmail(input.email),
		requestUrl: input.requestUrl,
		buildMessage: buildDeletedAccountReleaseEmail,
		// One mail per address per window, however many signups or resets ask.
		onlyIfNoneWithinSeconds:
			emailClaimReleaseRequestRateLimitConfig.windowSeconds,
	})
}

async function sendEmailClaimReleaseLink(input: {
	env: Env
	userId: number
	email: string
	requestUrl: string | URL
	buildMessage: (input: {
		appBaseUrl: string
		email: string
		verificationUrl: string
	}) => { subject: string; html: string; text: string }
	/** Reserve atomically and skip the send when a link is this recent. */
	onlyIfNoneWithinSeconds?: number
}) {
	const email = input.email
	const token = generateEmailClaimReleaseToken()
	const tokenHash = await hashVerificationToken(token)
	const expiresAt = Date.now() + emailClaimReleaseTokenExpiryMs
	let restorePrevious: (() => Promise<void>) | null = null

	if (input.onlyIfNoneWithinSeconds == null) {
		await input.env.APP_DB.prepare(
			`DELETE FROM pending_email_claim_releases WHERE user_id = ? AND email = ?`,
		)
			.bind(input.userId, email)
			.run()

		await input.env.APP_DB.prepare(
			`INSERT INTO pending_email_claim_releases (user_id, email, token_hash, expires_at)
			 VALUES (?, ?, ?, ?)`,
		)
			.bind(input.userId, email, tokenHash, expiresAt)
			.run()
	} else {
		// (user_id, email) is unique. A recent link wins; a stale one is
		// swapped in place (restored if the new mail fails); a concurrent
		// caller that loses the swap or insert sends nothing.
		const existing = await input.env.APP_DB.prepare(
			`SELECT id, token_hash, expires_at, created_at,
			        created_at > datetime('now', ?) AS recent
			 FROM pending_email_claim_releases
			 WHERE user_id = ? AND email = ?`,
		)
			.bind(`-${input.onlyIfNoneWithinSeconds} seconds`, input.userId, email)
			.first<{
				id: number
				token_hash: string
				expires_at: number
				created_at: string
				recent: number
			}>()
		if (existing?.recent) return
		if (existing) {
			const swapped = await input.env.APP_DB.prepare(
				`UPDATE pending_email_claim_releases
				 SET token_hash = ?, expires_at = ?, created_at = CURRENT_TIMESTAMP
				 WHERE id = ? AND token_hash = ?`,
			)
				.bind(tokenHash, expiresAt, existing.id, existing.token_hash)
				.run()
			if ((swapped.meta.changes ?? 0) === 0) return
			restorePrevious = async () => {
				await input.env.APP_DB.prepare(
					`UPDATE pending_email_claim_releases
					 SET token_hash = ?, expires_at = ?, created_at = ?
					 WHERE token_hash = ?`,
				)
					.bind(
						existing.token_hash,
						existing.expires_at,
						existing.created_at,
						tokenHash,
					)
					.run()
			}
		} else
			try {
				const reserved = await input.env.APP_DB.prepare(
					`INSERT INTO pending_email_claim_releases (user_id, email, token_hash, expires_at)
				 SELECT ?, ?, ?, ?
				 WHERE NOT EXISTS (
				   SELECT 1 FROM pending_email_claim_releases
				   WHERE user_id = ? AND email = ?
				 )`,
				)
					.bind(input.userId, email, tokenHash, expiresAt, input.userId, email)
					.run()
				if ((reserved.meta.changes ?? 0) === 0) return
			} catch (error) {
				if (getUniqueConstraintField(error)) return
				throw error
			}
	}

	async function discardNewToken() {
		if (restorePrevious) {
			await restorePrevious().catch(() => undefined)
			return
		}
		await input.env.APP_DB.prepare(
			`DELETE FROM pending_email_claim_releases WHERE token_hash = ?`,
		)
			.bind(tokenHash)
			.run()
			.catch(() => undefined)
	}

	const emailConfig = getEmailClaimReleaseConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const verificationUrl = new URL(
		'/verify-email-claim-release',
		emailConfig.appBaseUrl,
	)
	verificationUrl.searchParams.set('token', token)
	const message = input.buildMessage({
		appBaseUrl: emailConfig.appBaseUrl,
		email,
		verificationUrl: verificationUrl.toString(),
	})

	let sendResult: Awaited<ReturnType<typeof sendGatedTransactionalEmail>>
	try {
		sendResult = await sendGatedTransactionalEmail({
			db: input.env.APP_DB,
			config: {
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			category: 'essential',
			kind: 'email_claim_release',
			message: {
				to: email,
				from: emailConfig.fromEmail,
				subject: message.subject,
				html: message.html,
				text: message.text,
			},
		})
	} catch (error) {
		await discardNewToken()
		throw error
	}
	if (!sendResult.ok) {
		if ('hold' in sendResult && sendResult.hold) {
			await discardNewToken()
			throw new Error(sendResult.error)
		}
		if (!(sendResult.skipped && isNonProductionRuntime(input.env))) {
			await discardNewToken()
			throw new Error(sendResult.error ?? 'Release email could not be sent.')
		}
		console.warn('email-claim-release-send-skipped', input.userId)
	}
}

export type VerifyEmailClaimReleaseResult =
	| {
			ok: true
			userId: number
			email: string
			supersededDeletedAccount?: true
	  }
	| {
			ok: false
			reason:
				| 'missing_token'
				| 'invalid_token'
				| 'expired_token'
				| 'not_claimed'
				| 'current_email'
				| 'daily_cap'
	  }

export async function verifyEmailClaimReleaseToken(input: {
	db: D1Database
	token: unknown
	now?: Date
}): Promise<VerifyEmailClaimReleaseResult> {
	const token = typeof input.token === 'string' ? input.token.trim() : ''
	if (!token) return { ok: false, reason: 'missing_token' }

	const tokenHash = await hashVerificationToken(token)
	const now = input.now ?? new Date()
	const deletedAccountRelease = await consumeDeletedAccountReleaseToken(
		input.db,
		tokenHash,
		now,
	)
	if (deletedAccountRelease) return deletedAccountRelease
	const record = await input.db
		.prepare(
			`SELECT pec.id, pec.user_id, pec.email, pec.expires_at,
			        u.email AS current_email
			 FROM pending_email_claim_releases pec
			 INNER JOIN users u ON u.id = pec.user_id
			 WHERE pec.token_hash = ?${andLiveDeletedAtSql()}`,
		)
		.bind(tokenHash)
		.first<{
			id: number
			user_id: number
			email: string
			expires_at: number
			current_email: string
		}>()

	if (!record) return { ok: false, reason: 'invalid_token' }
	if (record.expires_at < now.getTime()) {
		await input.db
			.prepare(`DELETE FROM pending_email_claim_releases WHERE id = ?`)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'expired_token' }
	}

	const releasable = await resolveReleasableEmailClaim({
		db: input.db,
		userId: record.user_id,
		currentEmail: record.current_email,
		email: record.email,
	})
	if (!releasable.ok) {
		await input.db
			.prepare(`DELETE FROM pending_email_claim_releases WHERE id = ?`)
			.bind(record.id)
			.run()
		return {
			ok: false,
			reason:
				releasable.reason === 'already_released'
					? 'not_claimed'
					: releasable.reason,
		}
	}

	const recentReleases = await countRecentEmailClaimReleases(input.db, {
		userId: record.user_id,
		windowSeconds: emailClaimReleaseSuccessRateLimitConfig.windowSeconds,
		now,
	})
	if (recentReleases >= emailClaimReleaseSuccessRateLimitConfig.maxRequests) {
		return { ok: false, reason: 'daily_cap' }
	}

	await releaseAccountEmailClaim(input.db, {
		userId: record.user_id,
		email: releasable.email,
		now,
	})
	await input.db
		.prepare(
			`DELETE FROM pending_email_claim_releases WHERE user_id = ? AND email = ?`,
		)
		.bind(record.user_id, releasable.email)
		.run()

	return {
		ok: true,
		userId: record.user_id,
		email: releasable.email,
	}
}

export class EmailClaimReleaseRequestError extends Error {
	readonly reason: 'current_email' | 'not_claimed' | 'already_released'

	constructor(reason: 'current_email' | 'not_claimed' | 'already_released') {
		super(`Email claim cannot be released (${reason}).`)
		this.name = 'EmailClaimReleaseRequestError'
		this.reason = reason
	}
}

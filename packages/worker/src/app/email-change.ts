import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import { hashVerificationToken } from '#app/email-verification.ts'
import { assessAccountEmail } from '#worker/identity/account-email-policy.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { buildEmailChangeEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { createDb, pendingEmailChangesTable } from '#worker/db.ts'
import {
	claimAccountEmail,
	isEmailReservedForOtherAccount,
} from '#worker/identity/email-claims.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { reconcileDestinationsAfterIdentityEmailChange } from '#worker/email/destinations.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const emailChangeTokenBytes = 32
const emailChangeTokenExpiryMs = 24 * 60 * 60 * 1000
function generateEmailChangeToken() {
	const bytes = new Uint8Array(emailChangeTokenBytes)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

function getEmailChangeConfig(input: {
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

export async function createEmailChangeVerification(input: {
	env: Env
	userId: number
	currentEmail: string
	newEmail: string
	requestUrl: string | URL
}) {
	const db = createDb(input.env.APP_DB)
	const token = generateEmailChangeToken()
	const tokenHash = await hashVerificationToken(token)
	const expiresAt = Date.now() + emailChangeTokenExpiryMs

	await input.env.APP_DB.prepare(
		`DELETE FROM pending_email_changes WHERE user_id = ?`,
	)
		.bind(input.userId)
		.run()

	await db.create(pendingEmailChangesTable, {
		user_id: input.userId,
		new_email: input.newEmail,
		token_hash: tokenHash,
		expires_at: expiresAt,
	})

	async function discardNewToken() {
		await input.env.APP_DB.prepare(
			`DELETE FROM pending_email_changes WHERE token_hash = ?`,
		)
			.bind(tokenHash)
			.run()
			.catch(() => undefined)
	}

	const emailConfig = getEmailChangeConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const verificationUrl = new URL(
		'/verify-email-change',
		emailConfig.appBaseUrl,
	)
	verificationUrl.searchParams.set('token', token)
	const email = buildEmailChangeEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		currentEmail: input.currentEmail,
		newEmail: input.newEmail,
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
			kind: 'email_change',
			message: {
				to: input.newEmail,
				from: emailConfig.fromEmail,
				subject: email.subject,
				html: email.html,
				text: email.text,
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
			throw new Error(sendResult.error ?? 'Email change could not be sent.')
		}
		console.warn('email-change-send-skipped', input.userId)
	}

	await input.env.APP_DB.prepare(
		`DELETE FROM pending_email_changes WHERE user_id = ? AND token_hash != ?`,
	)
		.bind(input.userId, tokenHash)
		.run()
		.catch((error) => {
			console.warn('email-change-token-cleanup-failed', error)
		})
}

export type VerifyEmailChangeResult =
	| {
			ok: true
			userId: number
			stableUserId: string
			oldEmail: string
			newEmail: string
	  }
	| ({
			ok: false
			reason:
				| 'missing_token'
				| 'invalid_token'
				| 'expired_token'
				| 'email_conflict'
				| 'email_rejected'
	  } & { error?: string })

export async function verifyEmailChangeToken(input: {
	db: D1Database
	token: unknown
	now?: Date
}): Promise<VerifyEmailChangeResult> {
	const token = typeof input.token === 'string' ? input.token.trim() : ''
	if (!token) return { ok: false, reason: 'missing_token' }

	const tokenHash = await hashVerificationToken(token)
	const record = await input.db
		.prepare(
			`SELECT pec.id, pec.user_id, pec.new_email, pec.expires_at, u.email, u.stable_user_id
			 FROM pending_email_changes pec
			 INNER JOIN users u ON u.id = pec.user_id
			 WHERE pec.token_hash = ?${andLiveDeletedAtSql()}`,
		)
		.bind(tokenHash)
		.first<{
			id: number
			user_id: number
			new_email: string
			expires_at: number
			email: string
			stable_user_id: string
		}>()
	const now = input.now ?? new Date()

	if (!record) return { ok: false, reason: 'invalid_token' }
	if (record.expires_at < now.getTime()) {
		await input.db
			.prepare(`DELETE FROM pending_email_changes WHERE id = ?`)
			.bind(record.id)
			.run()
		return { ok: false, reason: 'expired_token' }
	}

	const newEmail = normalizeEmail(record.new_email)
	const existing = await input.db
		.prepare(
			`SELECT id FROM users WHERE email = ? AND id != ?${andLiveDeletedAtSql()}`,
		)
		.bind(newEmail, record.user_id)
		.first<{ id: number }>()
	if (existing) return { ok: false, reason: 'email_conflict' }
	if (
		await isEmailReservedForOtherAccount(input.db, newEmail, record.user_id)
	) {
		return { ok: false, reason: 'email_conflict' }
	}
	const emailDecision = await assessAccountEmail(newEmail)
	if (!emailDecision.ok) {
		return {
			ok: false,
			reason: 'email_rejected',
			error: emailDecision.error,
		}
	}

	// Preserve the existing stable id across email changes so MCP identity,
	// ownership rows, and grants stay bound to the same account.
	const stableUserId = personIdFromStored(record.stable_user_id)
	const verifiedAt = now.toISOString()

	try {
		await input.db
			.prepare(
				`UPDATE users
				 SET email = ?,
				     email_verified_at = ?,
				     stable_user_id = ?,
				     updated_at = CURRENT_TIMESTAMP
				 WHERE id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(newEmail, verifiedAt, stableUserId, record.user_id)
			.run()
	} catch (error) {
		if (getUniqueConstraintField(error) === 'email') {
			return { ok: false, reason: 'email_conflict' }
		}
		throw error
	}

	// Invalidate immediately after the email write so same-isolate package-app
	// serve cannot keep the old email while later cleanup claims may fail.
	invalidatePackageAppOwnerCache({ stableUserId })

	await input.db
		.prepare(`DELETE FROM pending_email_changes WHERE user_id = ?`)
		.bind(record.user_id)
		.run()
	await input.db
		.prepare(`DELETE FROM email_verifications WHERE user_id = ?`)
		.bind(record.user_id)
		.run()

	await claimAccountEmail(input.db, {
		userId: record.user_id,
		email: record.email,
		now,
	})
	await claimAccountEmail(input.db, {
		userId: record.user_id,
		email: newEmail,
		now,
	})
	await reconcileDestinationsAfterIdentityEmailChange({
		db: input.db,
		userId: record.user_id,
		newEmail,
	})

	return {
		ok: true,
		userId: record.user_id,
		stableUserId,
		oldEmail: record.email,
		newEmail,
	}
}

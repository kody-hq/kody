import { generateTOTP, getTOTPAuthUri, verifyTOTP } from '@epic-web/totp'
import {
	isSealedSecretPayload,
	openPlatformSecret,
	sealPlatformSecret,
} from '#mcp/secrets/crypto.ts'

/**
 * Epic Stack-style verification rows: an active `2fa` row for a user is the
 * "two-factor enabled" flag, and a `2fa-verify` row holds a pending setup
 * that only becomes active once the user proves they scanned the secret.
 */
export const twoFactorVerificationType = '2fa'
export const twoFactorSetupVerificationType = '2fa-verify'

export type TwoFactorVerificationType =
	| typeof twoFactorVerificationType
	| typeof twoFactorSetupVerificationType

type TwoFactorEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

type VerificationRow = {
	secret: string
	algorithm: string
	digits: number
	period: number
	char_set: string
}

function getTwoFactorTarget(userId: number) {
	return String(userId)
}

/**
 * AAD for a TOTP secret: the verification row's target (the integer
 * users.id). Not bound to `type` because confirm promotes `2fa-verify` to
 * `2fa` in place without re-sealing.
 */
export function totpSecretContext(target: string) {
	return `user-db:${target}:totp`
}

export function sealTotpSecret(
	env: Pick<Env, 'SECRET_STORE_KEY'>,
	target: string,
	secret: string,
) {
	return sealPlatformSecret(
		env,
		'totp-secret',
		totpSecretContext(target),
		secret,
	)
}

/** Opens a stored TOTP secret. Anything not sealed fails closed. */
async function openStoredTotpSecret(
	env: TwoFactorEnv,
	target: string,
	stored: string,
) {
	if (!isSealedSecretPayload(stored)) {
		throw new Error('Unable to decrypt platform secret.')
	}
	return openPlatformSecret(
		env,
		'totp-secret',
		totpSecretContext(target),
		stored,
	)
}

export async function findTwoFactorVerification(
	db: D1Database,
	userId: number,
	type: TwoFactorVerificationType,
) {
	return db
		.prepare(
			`SELECT secret, algorithm, digits, period, char_set
			 FROM verifications
			 WHERE target = ? AND type = ?
			 AND (expires_at IS NULL OR expires_at > ?)`,
		)
		.bind(getTwoFactorTarget(userId), type, Date.now())
		.first<VerificationRow>()
}

export async function isTwoFactorEnabled(db: D1Database, userId: number) {
	const verification = await findTwoFactorVerification(
		db,
		userId,
		twoFactorVerificationType,
	)
	return verification !== null
}

/**
 * Creates (or replaces) a pending two-factor setup and returns the otpauth
 * URI for the user's authenticator app. The setup only activates after
 * `confirmTwoFactorSetup`, so abandoning it never locks the user out.
 */
export async function createTwoFactorSetup(input: {
	env: TwoFactorEnv
	userId: number
	accountName: string
	issuer: string
}) {
	const { otp: _otp, ...config } = await generateTOTP()
	const target = getTwoFactorTarget(input.userId)
	const sealedSecret = await sealTotpSecret(input.env, target, config.secret)
	await input.env.APP_DB.prepare(
		`INSERT INTO verifications (
				type, target, secret, algorithm, digits, period, char_set, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT (target, type) DO UPDATE SET
				secret = excluded.secret,
				algorithm = excluded.algorithm,
				digits = excluded.digits,
				period = excluded.period,
				char_set = excluded.char_set,
				expires_at = NULL,
				created_at = CURRENT_TIMESTAMP`,
	)
		.bind(
			twoFactorSetupVerificationType,
			target,
			sealedSecret,
			config.algorithm,
			config.digits,
			config.period,
			config.charSet,
		)
		.run()

	const otpUri = getTOTPAuthUri({
		secret: config.secret,
		algorithm: config.algorithm,
		digits: config.digits,
		period: config.period,
		accountName: input.accountName,
		issuer: input.issuer,
	})
	return { otpUri, secret: config.secret }
}

export async function verifyTwoFactorCode(input: {
	env: TwoFactorEnv
	userId: number
	code: string
	type: TwoFactorVerificationType
}) {
	const verification = await findTwoFactorVerification(
		input.env.APP_DB,
		input.userId,
		input.type,
	)
	if (!verification) return false

	const secret = await openStoredTotpSecret(
		input.env,
		getTwoFactorTarget(input.userId),
		verification.secret,
	)
	const result = await verifyTOTP({
		otp: input.code,
		secret,
		algorithm: verification.algorithm,
		digits: verification.digits,
		period: verification.period,
		charSet: verification.char_set,
	})
	return result !== null
}

/**
 * Promotes the pending `2fa-verify` row to the active `2fa` type in place so
 * the exact secret the user scanned stays the active secret. Returns whether
 * a pending row was actually promoted (false when the setup vanished, e.g.
 * a concurrent cancel).
 *
 * The active-row delete (needed to satisfy the UNIQUE(target, type)
 * constraint before promoting) is conditional on a pending row existing so
 * that a concurrent duplicate confirm can never delete the active factor
 * without promoting a replacement.
 */
export async function confirmTwoFactorSetup(db: D1Database, userId: number) {
	const target = getTwoFactorTarget(userId)
	const [, promotion] = await db.batch([
		db
			.prepare(
				`DELETE FROM verifications WHERE target = ? AND type = ?
				 AND EXISTS (
					SELECT 1 FROM verifications WHERE target = ? AND type = ?
				 )`,
			)
			.bind(
				target,
				twoFactorVerificationType,
				target,
				twoFactorSetupVerificationType,
			),
		db
			.prepare(
				`UPDATE verifications SET type = ? WHERE target = ? AND type = ?`,
			)
			.bind(twoFactorVerificationType, target, twoFactorSetupVerificationType),
	])
	return (promotion?.meta.changes ?? 0) > 0
}

export async function cancelTwoFactorSetup(db: D1Database, userId: number) {
	await db
		.prepare(`DELETE FROM verifications WHERE target = ? AND type = ?`)
		.bind(getTwoFactorTarget(userId), twoFactorSetupVerificationType)
		.run()
}

export async function disableTwoFactor(db: D1Database, userId: number) {
	// Also drop any pending setup so a stale scanned secret can't be
	// re-activated later without going through the full setup flow.
	const result = await db
		.prepare(`DELETE FROM verifications WHERE target = ? AND type IN (?, ?)`)
		.bind(
			getTwoFactorTarget(userId),
			twoFactorVerificationType,
			twoFactorSetupVerificationType,
		)
		.run()
	return result.meta?.changes ?? 0
}

export type TotpSecretBackfillResult = {
	scanned: number
	sealed: number
	remainingPlaintext: number
	nextCursor: number | null
}

/**
 * Bounded backfill: seals `2fa` / `2fa-verify` rows that still hold a
 * plaintext secret. Safe to rerun; each row is a compare-and-swap.
 */
export async function sealPlaintextTotpSecrets(input: {
	env: TwoFactorEnv
	dryRun: boolean
	limit: number
	cursor?: number | null
}): Promise<TotpSecretBackfillResult> {
	const db = input.env.APP_DB
	const rows = await db
		.prepare(
			`SELECT id, type, target, secret FROM verifications
			 WHERE type IN (?, ?) AND id > ? AND secret NOT LIKE 'v2.%'
			 ORDER BY id LIMIT ?`,
		)
		.bind(
			twoFactorVerificationType,
			twoFactorSetupVerificationType,
			input.cursor ?? 0,
			input.limit,
		)
		.all<{ id: number; type: string; target: string; secret: string }>()
	const page = rows.results ?? []
	let sealed = 0
	for (const row of page) {
		if (isSealedSecretPayload(row.secret) || input.dryRun) continue
		const ciphertext = await sealTotpSecret(input.env, row.target, row.secret)
		const result = await db
			.prepare(
				`UPDATE verifications SET secret = ? WHERE id = ? AND secret = ?`,
			)
			.bind(ciphertext, row.id, row.secret)
			.run()
		sealed += result.meta?.changes ?? 0
	}
	const remaining = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM verifications
			 WHERE type IN (?, ?) AND secret NOT LIKE 'v2.%'`,
		)
		.bind(twoFactorVerificationType, twoFactorSetupVerificationType)
		.first<{ count: number }>()
	return {
		scanned: page.length,
		sealed,
		remainingPlaintext: Number(remaining?.count ?? 0),
		nextCursor: page.length < input.limit ? null : (page.at(-1)?.id ?? null),
	}
}

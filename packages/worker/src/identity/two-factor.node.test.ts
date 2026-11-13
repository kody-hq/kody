import { DatabaseSync } from 'node:sqlite'
import { generateTOTP } from '@epic-web/totp'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	confirmTwoFactorSetup,
	createTwoFactorSetup,
	sealPlaintextTotpSecrets,
	verifyTwoFactorCode,
} from './two-factor.ts'

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'two-factor-test-secret-store-key-32-chars',
	}
	const storedSecret = (userId: number) =>
		(
			sqlite
				.prepare('SELECT secret FROM verifications WHERE target = ?')
				.get(String(userId)) as { secret: string }
		).secret
	const insertPlaintext = (userId: number, secret: string) =>
		sqlite
			.prepare(
				`INSERT INTO verifications
					(type, target, secret, algorithm, digits, period, char_set)
				 VALUES ('2fa', ?, ?, 'SHA-1', 6, 30, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')`,
			)
			.run(String(userId), secret)
	return { sqlite, env, storedSecret, insertPlaintext }
}

async function currentCode(secret: string) {
	const { otp } = await generateTOTP({
		secret,
		algorithm: 'SHA-1',
		digits: 6,
		period: 30,
		charSet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
	})
	return otp
}

async function enroll(env: ReturnType<typeof setup>['env'], userId: number) {
	const created = await createTwoFactorSetup({
		env,
		userId,
		accountName: `user-${userId}`,
		issuer: 'Kody',
	})
	return created
}

test('setup stores only a sealed secret and the setup URI still carries it', async () => {
	const { env, storedSecret } = setup()
	const { otpUri, secret } = await enroll(env, 1)
	expect(otpUri).toContain(`secret=${secret}`)
	expect(storedSecret(1)).toMatch(/^v2\./)
	expect(storedSecret(1)).not.toContain(secret)
	const { otp } = await generateTOTP({ secret })
	expect(
		await verifyTwoFactorCode({
			env,
			userId: 1,
			code: otp,
			type: '2fa-verify',
		}),
	).toBe(true)
	expect(await confirmTwoFactorSetup(env.APP_DB, 1)).toBe(true)
	expect(
		await verifyTwoFactorCode({ env, userId: 1, code: otp, type: '2fa' }),
	).toBe(true)
	expect(
		await verifyTwoFactorCode({ env, userId: 1, code: '000000', type: '2fa' }),
	).toBe(otp === '000000')
})

test('a sealed secret copied onto another user fails closed', async () => {
	const { sqlite, env, storedSecret } = setup()
	const first = await enroll(env, 1)
	await enroll(env, 2)
	sqlite
		.prepare('UPDATE verifications SET secret = ? WHERE target = ?')
		.run(storedSecret(1), '2')
	const { otp } = await generateTOTP({ secret: first.secret })
	await expect(
		verifyTwoFactorCode({ env, userId: 2, code: otp, type: '2fa-verify' }),
	).rejects.toThrow('Unable to decrypt platform secret.')
})

test('existing plaintext 2FA keeps working and is sealed on first use', async () => {
	const { env, storedSecret, insertPlaintext } = setup()
	const { secret } = await generateTOTP()
	insertPlaintext(3, secret)
	expect(
		await verifyTwoFactorCode({
			env,
			userId: 3,
			code: await currentCode(secret),
			type: '2fa',
		}),
	).toBe(true)
	expect(storedSecret(3)).toMatch(/^v2\./)
	expect(
		await verifyTwoFactorCode({
			env,
			userId: 3,
			code: await currentCode(secret),
			type: '2fa',
		}),
	).toBe(true)
})

test('the backfill seals every plaintext row and reports zero remaining', async () => {
	const { env, storedSecret, insertPlaintext } = setup()
	const secrets = await Promise.all(
		[4, 5, 6].map(async () => (await generateTOTP()).secret),
	)
	secrets.forEach((secret, index) => insertPlaintext(4 + index, secret))
	await enroll(env, 7)
	expect(
		await sealPlaintextTotpSecrets({ env, dryRun: true, limit: 10 }),
	).toEqual({ scanned: 3, sealed: 0, remainingPlaintext: 3, nextCursor: null })
	const firstPage = await sealPlaintextTotpSecrets({
		env,
		dryRun: false,
		limit: 2,
	})
	expect(firstPage).toMatchObject({
		scanned: 2,
		sealed: 2,
		remainingPlaintext: 1,
	})
	expect(
		await sealPlaintextTotpSecrets({
			env,
			dryRun: false,
			limit: 2,
			cursor: firstPage.nextCursor,
		}),
	).toEqual({ scanned: 1, sealed: 1, remainingPlaintext: 0, nextCursor: null })
	for (const [index, secret] of secrets.entries()) {
		expect(storedSecret(4 + index)).toMatch(/^v2\./)
		expect(
			await verifyTwoFactorCode({
				env,
				userId: 4 + index,
				code: await currentCode(secret),
				type: '2fa',
			}),
		).toBe(true)
	}
})

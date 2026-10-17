import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { hashVerificationToken } from '#worker/identity/email-verification-tokens.ts'
import { addEmailNotificationDestination } from './destinations.ts'
import {
	createEmailDestinationVerification,
	emailDestinationMinimumAccountAgeMs,
	emailDestinationRateLimitConfig,
	emailDestinationRecipientDailyCap,
	emailDestinationUserBurstRateLimitKey,
	emailDestinationUserDailyCap,
	verifyEmailDestinationToken,
} from './destination-verification.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const matureAccountCreatedAtSql = "datetime('now', '-48 hours')"

async function makeOwner(input?: { createdAtSql?: string }) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const stableUserId = testStableUserIdFromEmail('owner@example.com')
	const createdAtSql = input?.createdAtSql ?? matureAccountCreatedAtSql
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at,
			created_at
		) VALUES (
			1, 'owner', 'owner@example.com', ${quoteSqlString(stableUserId)},
			'test-password-hash', CURRENT_TIMESTAMP, ${createdAtSql}
		);
	`)
	const env = {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	return {
		sqlite,
		db,
		env,
		create: (email: string, userId = 1) =>
			createEmailDestinationVerification({
				env,
				userId,
				email,
				requestUrl: 'http://example.com',
			}),
		pendingTokenHashes: (destinationId: string) =>
			(
				sqlite
					.prepare(
						`SELECT token_hash AS tokenHash
						 FROM pending_email_destination_verifications
						 WHERE destination_id = ?
						 ORDER BY id ASC`,
					)
					.all(destinationId) as Array<{ tokenHash: string }>
			).map((row) => row.tokenHash),
	}
}

test('destination verification tokens mark one extra address verified and reject missing/expired links', async () => {
	const { sqlite, db } = await makeOwner()
	const added = await addEmailNotificationDestination({
		db,
		dbUserId: 1,
		email: 'phone@example.com',
	})
	const insertPending = async (token: string, expiresAt: number) =>
		sqlite
			.prepare(
				`INSERT INTO pending_email_destination_verifications
				 (user_id, destination_id, token_hash, expires_at)
				 VALUES (1, ?, ?, ?)`,
			)
			.run(added.destination.id, await hashVerificationToken(token), expiresAt)
	const isVerified = () =>
		sqlite
			.prepare(
				`SELECT verified_at IS NOT NULL AS verified
				 FROM email_notification_destinations WHERE id = ?`,
			)
			.get(added.destination.id)

	const expiredToken = 'a'.repeat(64)
	await insertPending(expiredToken, Date.now() - 1)
	for (const [token, reason] of [
		['', 'missing_token'],
		['nope', 'invalid_token'],
		[expiredToken, 'expired_token'],
	] as const) {
		expect(await verifyEmailDestinationToken({ db, token })).toEqual({
			ok: false,
			reason,
		})
	}

	const liveToken = 'b'.repeat(64)
	await insertPending(liveToken, Date.now() + 60_000)
	const verifiedPhone = { ok: true, userId: 1, email: 'phone@example.com' }
	expect(
		await verifyEmailDestinationToken({ db, token: liveToken, consume: false }),
	).toEqual(verifiedPhone)
	expect(isVerified()).toEqual({ verified: 0 })

	expect(await verifyEmailDestinationToken({ db, token: liveToken })).toEqual(
		verifiedPhone,
	)
	expect(isVerified()).toEqual({ verified: 1 })
	expect(await verifyEmailDestinationToken({ db, token: liveToken })).toEqual(
		verifiedPhone,
	)
	expect(
		sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM pending_email_destination_verifications`,
			)
			.get(),
	).toEqual({ count: 1 })
})

test('createEmailDestinationVerification rate-limits add and resend for UI and MCP', async () => {
	consoleWarn.mockImplementation(() => {})
	const { create } = await makeOwner()
	for (
		let index = 0;
		index < emailDestinationRateLimitConfig.maxRequests;
		index++
	) {
		expect((await create(`extra-${index}@example.com`)).created).toBe(true)
	}
	await expect(create('one-more@example.com')).rejects.toMatchObject({
		code: 'rate_limited',
		message: expect.stringMatching(
			/at most 3 every 15 minutes\. Try again after \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/,
		),
	})
	expect(consoleWarn).toHaveBeenCalled()
})

test('new accounts cannot request destination verification until the minimum age', async () => {
	const { sqlite, create } = await makeOwner({
		createdAtSql: "datetime('now', '-30 minutes')",
	})
	const error = await create('extra@example.com').then(
		() => {
			throw new Error('Expected a new account to be blocked.')
		},
		(caught: unknown) => caught,
	)
	const ageHours = emailDestinationMinimumAccountAgeMs / (60 * 60 * 1000)
	expect(error).toMatchObject({
		code: 'account_too_new',
		message: expect.stringMatching(
			new RegExp(
				`New accounts can add email destinations ${ageHours} hours after signup\\. Try again after \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} UTC\\. If you need an address before then, contact support\\.`,
			),
		),
	})
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM email_notification_destinations`)
			.get(),
	).toEqual({ count: 0 })
	expect(
		sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_rate_limits'`,
			)
			.get(),
	).toBeUndefined()
})

test('each account can send at most the daily destination verification cap', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, create } = await makeOwner()
	const addresses = [
		'one@example.com',
		'two@example.com',
		'three@example.com',
		'four@example.com',
	]
	let sent = 0
	let addressIndex = 0
	let sendsOnAddress = 0
	while (sent < emailDestinationUserDailyCap.maxRequests) {
		if (sent > 0 && sent % emailDestinationRateLimitConfig.maxRequests === 0) {
			sqlite
				.prepare(`DELETE FROM _rate_limits WHERE key = ?`)
				.run(emailDestinationUserBurstRateLimitKey(1))
		}
		if (sendsOnAddress >= emailDestinationRecipientDailyCap.maxRequests) {
			addressIndex += 1
			sendsOnAddress = 0
		}
		await create(addresses[addressIndex] ?? 'overflow@example.com')
		sent += 1
		sendsOnAddress += 1
	}
	await expect(create('eleven@example.com')).rejects.toMatchObject({
		code: 'user_daily_cap',
		message: expect.stringMatching(
			/limit of 10 destination verification emails per rolling 24 hours\. Try again after \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/,
		),
	})
})

test('a recipient address is capped across accounts and the stored key is hashed', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, create } = await makeOwner()
	const victim = 'Victim@Example.com'
	const otherUserId = testStableUserIdFromEmail('other@example.com')
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, stable_user_id, password_hash, email_verified_at,
			created_at
		) VALUES (
			2, 'other', 'other@example.com', ${quoteSqlString(otherUserId)},
			'test-password-hash', CURRENT_TIMESTAMP, ${matureAccountCreatedAtSql}
		);
	`)
	for (
		let index = 0;
		index < emailDestinationRecipientDailyCap.maxRequests;
		index += 1
	) {
		await create(victim)
	}
	const blocked = await create(victim, 2).then(
		() => {
			throw new Error('Expected the shared recipient cap to block user 2.')
		},
		(caught: unknown) => caught,
	)
	expect(blocked).toMatchObject({
		code: 'recipient_daily_cap',
		message: expect.stringMatching(
			/already received 3 destination verification emails in the last 24 hours.*Use a different address, or try again after \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC.*contact support/s,
		),
	})
	const keys = sqlite.prepare(`SELECT key FROM _rate_limits`).all() as Array<{
		key: string
	}>
	expect(keys.some((row) => row.key.includes('victim@example.com'))).toBe(false)
	expect(keys.some((row) => row.key.includes('Victim@Example.com'))).toBe(false)
	expect(
		keys.some((row) => row.key.startsWith('email-destination:recipient:')),
	).toBe(true)
	expect((await create('other-inbox@example.com', 2)).created).toBe(true)
})

test('a send that fails before provider accept refunds destination verification counters', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = await makeOwner()
	const productionEnv = {
		APP_DB: db,
		APP_BASE_URL: 'http://example.com',
		SENTRY_ENVIRONMENT: 'production',
	} as unknown as Env
	await expect(
		createEmailDestinationVerification({
			env: productionEnv,
			userId: 1,
			email: 'pager@example.com',
			requestUrl: 'http://example.com',
		}),
	).rejects.toThrow(/skipped because no Cloudflare Email credentials/i)
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM email_notification_destinations`)
			.get(),
	).toEqual({ count: 0 })
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM _rate_limits`).get(),
	).toEqual({ count: 0 })

	const allowed = await createEmailDestinationVerification({
		env: {
			APP_DB: db,
			APP_BASE_URL: 'http://example.com',
			SENTRY_ENVIRONMENT: 'test',
		} as unknown as Env,
		userId: 1,
		email: 'pager@example.com',
		requestUrl: 'http://example.com',
	})
	expect(allowed.created).toBe(true)
})

test('createEmailDestinationVerification resends for a pending address and leaves unused links valid', async () => {
	consoleWarn.mockImplementation(() => {})
	const { create, pendingTokenHashes } = await makeOwner()
	const first = await create('pager@example.com')
	expect(first.created).toBe(true)
	const [firstTokenHash] = pendingTokenHashes(first.destination.id)

	expect(await create('Pager@Example.com')).toMatchObject({
		created: false,
		destination: { id: first.destination.id, email: 'pager@example.com' },
	})
	const pending = pendingTokenHashes(first.destination.id)
	expect(pending).toHaveLength(2)
	expect(pending[0]).toBe(firstTokenHash)
	expect(pending[1]).not.toBe(firstTokenHash)
})

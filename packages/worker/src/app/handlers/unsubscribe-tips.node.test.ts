import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testCookieSecret } from '#worker/test-support/auth-provider-harness.ts'
import { executeUnsubscribeTips } from '#app/handlers/unsubscribe-tips.ts'
import {
	createTipsUnsubscribeToken,
	isTipsEmailsOptedOut,
} from '#worker/usage/tips-unsubscribe.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

async function insertUser(db: D1Database, userId = 'user-tips') {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('tips', 'tips@example.com', 'x', ?)`,
		)
		.bind(userId)
		.run()
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		COOKIE_SECRET: testCookieSecret,
	} as unknown as Env
}

test('unsubscribe-tips operation validates token and applies idempotent opt-out', async () => {
	const db = createDb()
	await insertUser(db)
	const env = createEnv(db)

	const token = await createTipsUnsubscribeToken({
		env,
		userId: ownerIdFromStored('user-tips'),
	})

	const missing = await executeUnsubscribeTips({
		request: new Request('https://example.com/unsubscribe/tips'),
		env,
		token: null,
	})
	expect(missing).toMatchObject({
		status: 400,
		ok: false,
		error: 'Unsubscribe token is required.',
	})

	const getUrl = `https://example.com/unsubscribe/tips?token=${encodeURIComponent(token)}`
	const first = await executeUnsubscribeTips({
		request: new Request(getUrl),
		env,
		token,
	})
	expect(first).toMatchObject({
		ok: true,
		alreadyOptedOut: false,
		message: expect.stringContaining('unsubscribed from Kody tips'),
	})
	expect(
		await isTipsEmailsOptedOut({ db, userId: ownerIdFromStored('user-tips') }),
	).toBe(true)

	const again = await executeUnsubscribeTips({
		request: new Request(getUrl),
		env,
		token,
	})
	expect(again).toMatchObject({
		ok: true,
		alreadyOptedOut: true,
	})
})

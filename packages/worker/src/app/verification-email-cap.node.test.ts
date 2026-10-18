import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	peekVerificationEmailCap,
	reserveVerificationEmailSend,
	verificationEmailCapKey,
	verificationEmailCapMax,
} from './verification-email-cap.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('verification email cap is 5 per recipient per 24 hours and the key is hashed', async () => {
	const { sqlite, db } = createDb()
	for (let attempt = 0; attempt < verificationEmailCapMax; attempt += 1) {
		const reserved = await reserveVerificationEmailSend({
			db,
			email: 'Ada@Example.com',
		})
		expect(reserved.ok).toBe(true)
	}
	const blocked = await reserveVerificationEmailSend({
		db,
		email: 'ada@example.com',
	})
	expect(blocked.ok).toBe(false)
	if (blocked.ok) return
	expect(blocked.code).toBe('verification_email_cap')
	expect(blocked.status).toBe(429)
	expect(blocked.error).toContain('5 verification emails')
	expect(blocked.error).toContain('24 hours')
	expect(blocked.error).toContain('Try again in')
	expect(blocked.retryAfterSeconds).toBeGreaterThan(0)

	const peeked = await peekVerificationEmailCap({
		db,
		email: 'ada@example.com',
	})
	expect(peeked.ok).toBe(false)

	const keys = sqlite.prepare(`SELECT key FROM _rate_limits`).all() as Array<{
		key: string
	}>
	expect(keys).toHaveLength(verificationEmailCapMax)
	const expectedKey = await verificationEmailCapKey('ada@example.com')
	expect(keys.every((row) => row.key === expectedKey)).toBe(true)
	expect(expectedKey.startsWith('verify-email:recipient:')).toBe(true)
	expect(expectedKey.includes('ada@example.com')).toBe(false)
	expect(expectedKey.includes('@')).toBe(false)
})

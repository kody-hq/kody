import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { applyDeliverabilitySideEffects } from './deliverability-side-effects.ts'
import {
	isHardBounce,
	loadVerificationRecipientHardBounce,
} from './recipient-suppression.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

test('hard bounce is a bounced event or a permanent 5xx, not a sender block or 4xx', () => {
	expect(isHardBounce({ status: 'bounced' })).toBe(true)
	expect(
		isHardBounce({
			status: 'bounced',
			smtpResponse: '550 5.1.1 user unknown',
		}),
	).toBe(true)
	expect(
		isHardBounce({
			status: 'failed',
			smtpStatusCode: '550',
			smtpEnhancedStatusCode: '5.1.1',
		}),
	).toBe(true)
	expect(
		isHardBounce({
			status: 'rejected',
			smtpResponse: '450 mailbox busy',
		}),
	).toBe(false)
	expect(
		isHardBounce({
			status: 'bounced',
			smtpResponse: 'kody.codes is blacklisted - RLR613',
		}),
	).toBe(false)
	expect(isHardBounce({ status: 'complained' })).toBe(false)
	expect(isHardBounce({ status: 'deferred' })).toBe(false)
})

test('a hard bounce suppresses later verification sends until a delivery clears it', async () => {
	const db = createDb()
	const fetchImpl = (async () =>
		Response.json({ Status: 0, Answer: [] })) as typeof fetch
	await applyDeliverabilitySideEffects({
		db,
		recipient: 'Ada <Ada@Example.com>',
		deliveryStatus: 'bounced',
		smtpResponse: '550 5.1.1 user unknown',
		smtpStatusCode: '550',
		recordVerificationSuppression: true,
		fetchImpl,
	})
	const suppressed = await loadVerificationRecipientHardBounce({
		db,
		recipient: 'ada@example.com',
	})
	expect(suppressed).toMatchObject({
		recipient: 'ada@example.com',
		scope: 'verification',
		lastStatus: 'bounced',
	})
	await applyDeliverabilitySideEffects({
		db,
		recipient: "O'Brien <o'brien@company.com>",
		deliveryStatus: 'bounced',
		smtpResponse: '550 5.1.1 user unknown',
		recordVerificationSuppression: true,
		fetchImpl,
	})
	expect(
		await loadVerificationRecipientHardBounce({
			db,
			recipient: "o'brien@company.com",
		}),
	).toMatchObject({
		recipient: "o'brien@company.com",
		scope: 'verification',
		lastStatus: 'bounced',
	})

	await applyDeliverabilitySideEffects({
		db,
		recipient: 'ada@example.com',
		deliveryStatus: 'bounced',
		smtpResponse: '550 kody.codes is blacklisted - RLR613',
		fetchImpl,
	})
	await applyDeliverabilitySideEffects({
		db,
		recipient: 'other@example.com',
		deliveryStatus: 'delivered',
		fetchImpl,
	})
	expect(
		await loadVerificationRecipientHardBounce({
			db,
			recipient: 'ada@example.com',
		}),
	).toMatchObject({
		recipient: 'ada@example.com',
		scope: 'verification',
		lastStatus: 'bounced',
	})

	await applyDeliverabilitySideEffects({
		db,
		recipient: 'ada@example.com',
		deliveryStatus: 'delivered',
		fetchImpl,
	})
	expect(
		await loadVerificationRecipientHardBounce({
			db,
			recipient: 'ada@example.com',
		}),
	).toBeNull()
})

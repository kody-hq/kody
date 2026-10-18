import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { loadVerificationRecipientHardBounce } from './verification-recipient-suppression.ts'
import { registerTransactionalEmailDelivery } from './verification-delivery.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const inserted = await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('ada', 'ada@example.com', 'hash', ?)`,
		)
		.bind('a'.repeat(64))
		.run()
	return { db, userId: Number(inserted.meta.last_row_id) }
}

function providerEvent(input: {
	providerMessageId: string
	providerEventId: string
	status: 'delivered' | 'bounced'
	recipient: string
	smtpResponse?: string
	smtpStatusCode?: string
}) {
	return {
		type: `cf.email.sending.message.${input.status}`,
		source: {
			type: 'email.sending',
			zoneId: 'zone-1',
			domain: 'kody.codes',
		},
		payload: {
			eventId: input.providerEventId,
			messageId: input.providerMessageId,
			sender: 'kody@kody.codes',
			recipient: input.recipient,
			terminal: true,
			delivery: {
				status: input.status,
				smtpResponse: input.smtpResponse,
				smtpStatusCode: input.smtpStatusCode,
			},
		},
		metadata: {
			accountId: 'account-1',
			eventSubscriptionId: 'subscription-1',
			eventSchemaVersion: 1,
			eventTimestamp: '2026-10-18T02:00:00.000Z',
		},
	}
}

test('a password reset hard bounce records suppression and a delivery clears it', async () => {
	const { db, userId } = await createDb()
	const recipient = 'ada@example.com'
	await registerTransactionalEmailDelivery({
		db,
		providerMessageId: 'cf-reset-1',
		userId,
		recipient,
		kind: 'password_reset',
	})
	const bounced = await processCloudflareEmailDeliveryEvent({
		env: { APP_DB: db },
		body: providerEvent({
			providerMessageId: 'cf-reset-1',
			providerEventId: 'event-bounce',
			status: 'bounced',
			recipient,
			smtpResponse: '550 5.1.1 user unknown',
			smtpStatusCode: '550',
		}),
	})
	expect(bounced.outcome).toBe('recorded_transactional')
	expect(await loadVerificationRecipientHardBounce({ db, recipient })).toEqual({
		recipient,
		status: 'bounced',
	})

	await registerTransactionalEmailDelivery({
		db,
		providerMessageId: 'cf-reset-2',
		userId,
		recipient,
		kind: 'password_reset_confirmed',
	})
	const delivered = await processCloudflareEmailDeliveryEvent({
		env: { APP_DB: db },
		body: providerEvent({
			providerMessageId: 'cf-reset-2',
			providerEventId: 'event-delivered',
			status: 'delivered',
			recipient,
		}),
	})
	expect(delivered.outcome).toBe('recorded_transactional')
	expect(
		await loadVerificationRecipientHardBounce({ db, recipient }),
	).toBeNull()
})

test('a late password reset bounce after delivery does not re-suppress', async () => {
	const { db, userId } = await createDb()
	const recipient = 'ada@example.com'
	await registerTransactionalEmailDelivery({
		db,
		providerMessageId: 'cf-reset-late',
		userId,
		recipient,
		kind: 'password_reset',
	})
	const delivered = await processCloudflareEmailDeliveryEvent({
		env: { APP_DB: db },
		body: {
			...providerEvent({
				providerMessageId: 'cf-reset-late',
				providerEventId: 'event-delivered-late',
				status: 'delivered',
				recipient,
			}),
			metadata: {
				accountId: 'account-1',
				eventSubscriptionId: 'subscription-1',
				eventSchemaVersion: 1,
				eventTimestamp: '2026-10-18T03:00:00.000Z',
			},
		},
	})
	expect(delivered.outcome).toBe('recorded_transactional')
	const bounced = await processCloudflareEmailDeliveryEvent({
		env: { APP_DB: db },
		body: {
			...providerEvent({
				providerMessageId: 'cf-reset-late',
				providerEventId: 'event-bounce-late',
				status: 'bounced',
				recipient,
				smtpResponse: '550 5.1.1 user unknown',
				smtpStatusCode: '550',
			}),
			metadata: {
				accountId: 'account-1',
				eventSubscriptionId: 'subscription-1',
				eventSchemaVersion: 1,
				eventTimestamp: '2026-10-18T02:00:00.000Z',
			},
		},
	})
	expect(bounced.outcome).toBe('stale_transactional')
	expect(
		await loadVerificationRecipientHardBounce({ db, recipient }),
	).toBeNull()
})

test('a mailbox bounce does not record verification suppression', async () => {
	const { db } = await createDb()
	const result = await processCloudflareEmailDeliveryEvent({
		env: { APP_DB: db },
		body: providerEvent({
			providerMessageId: 'cf-mailbox-1',
			providerEventId: 'event-mailbox',
			status: 'bounced',
			recipient: 'ada@example.com',
			smtpResponse: '550 5.1.1 user unknown',
			smtpStatusCode: '550',
		}),
	})
	expect(result.outcome).toBe('unmatched')
	expect(
		await loadVerificationRecipientHardBounce({
			db,
			recipient: 'ada@example.com',
		}),
	).toBeNull()
})

import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import {
	listRecipientSuppressions,
	loadRecipientSuppression,
	loadVerificationRecipientHardBounce,
	pruneRecipientSuppressionTracking,
} from './recipient-suppression.ts'
import {
	pruneSystemEmailSends,
	recordSystemEmailSends,
} from './system-email-sends.ts'
import {
	gateTransactionalSend,
	sendGatedTransactionalEmail,
} from './transactional-send-policy.ts'
import { registerTransactionalEmailDelivery } from './verification-delivery.ts'

const migrations = new URL('../../migrations/', import.meta.url)

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrations)
	return createD1FromSqlite(sqlite)
}

const stubMxFetch = (async () =>
	Response.json({ Status: 0, Answer: [] })) as typeof fetch

type Status = 'delivered' | 'bounced' | 'failed' | 'deferred'

function providerEvent(input: {
	messageId: string
	eventId: string
	status: Status
	recipient: string
	at?: string
	smtpResponse?: string
	smtpStatusCode?: string
}) {
	return {
		type: `cf.email.sending.message.${input.status}`,
		source: { type: 'email.sending', zoneId: 'zone-1', domain: 'kody.codes' },
		payload: {
			eventId: input.eventId,
			messageId: input.messageId,
			sender: 'kody@kody.codes',
			recipient: input.recipient,
			terminal: input.status !== 'deferred',
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
			eventTimestamp: input.at ?? '2026-11-03T10:00:00.000Z',
		},
	}
}

function process(db: D1Database, body: ReturnType<typeof providerEvent>) {
	return processCloudflareEmailDeliveryEvent({
		env: { APP_DB: db },
		fetchImpl: stubMxFetch,
		body,
	})
}

// Every failure also arms the short recipient cooldown; gate after it.
function afterCooldown() {
	return new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
}

const hardBounce = {
	status: 'bounced' as const,
	smtpResponse: '550 5.1.1 user unknown',
	smtpStatusCode: '550',
}

async function recordSend(
	db: D1Database,
	messageId: string,
	to: Array<string>,
) {
	await recordSystemEmailSends({
		db,
		providerMessageId: messageId,
		recipients: to,
		sender: 'kody@kody.codes',
		kind: 'connect_agent',
		now: new Date('2026-11-03T09:00:00.000Z'),
	})
}

test('delivery reports for recorded system sends match per recipient', async () => {
	const db = createDb()
	await recordSend(db, 'cf-multi', ['Ada@Example.com', 'grace@example.com'])

	const ada = await process(
		db,
		providerEvent({
			messageId: 'cf-multi',
			eventId: 'ev-ada',
			status: 'delivered',
			recipient: 'ada@example.com',
		}),
	)
	expect(ada).toMatchObject({
		outcome: 'recorded_system',
		send: { recipient: 'ada@example.com', kind: 'connect_agent' },
	})
	const grace = await process(
		db,
		providerEvent({
			messageId: 'cf-multi',
			eventId: 'ev-grace',
			...hardBounce,
			recipient: 'Grace <grace@example.com>',
		}),
	)
	expect(grace).toMatchObject({
		outcome: 'recorded_system',
		send: { recipient: 'grace@example.com' },
		suppressed: false,
	})
	expect(
		await loadRecipientSuppression({ db, recipient: 'grace@example.com' }),
	).toMatchObject({ scope: 'tracking', hardBounceCount: 1 })
	expect(
		await loadRecipientSuppression({ db, recipient: 'ada@example.com' }),
	).toBeNull()

	expect(
		(
			await process(
				db,
				providerEvent({
					messageId: 'cf-never-sent',
					eventId: 'ev-unknown',
					status: 'delivered',
					recipient: 'ada@example.com',
				}),
			)
		).outcome,
	).toBe('unmatched')
})

test('repeated hard bounces suppress all system mail until a delivery or clear', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = createDb()
	const recipient = 'gone@example.com'
	await recordSend(db, 'cf-1', [recipient])
	await recordSend(db, 'cf-2', [recipient])
	await recordSend(db, 'cf-3', [recipient])

	const first = providerEvent({
		messageId: 'cf-1',
		eventId: 'ev-1',
		...hardBounce,
		recipient,
	})
	await process(db, first)
	// A queue retry of the same event does not count twice.
	await process(db, first)
	expect(await loadRecipientSuppression({ db, recipient })).toMatchObject({
		scope: 'tracking',
		hardBounceCount: 1,
	})
	expect(
		await gateTransactionalSend({
			db,
			recipient,
			category: 'essential',
			kind: 'billing_success',
			now: afterCooldown(),
		}),
	).toEqual({ allowed: true })

	// Temporary failures and sender-domain blocks never count.
	await process(
		db,
		providerEvent({
			messageId: 'cf-2',
			eventId: 'ev-2-deferred',
			status: 'deferred',
			recipient,
			smtpResponse: '451 try again later',
			at: '2026-11-03T10:01:00.000Z',
		}),
	)
	await process(
		db,
		providerEvent({
			messageId: 'cf-2',
			eventId: 'ev-2-block',
			status: 'bounced',
			recipient,
			smtpResponse: '550 kody.codes is blacklisted - RLR613',
			at: '2026-11-03T10:02:00.000Z',
		}),
	)
	expect(await loadRecipientSuppression({ db, recipient })).toMatchObject({
		hardBounceCount: 1,
	})

	const second = await process(
		db,
		providerEvent({
			messageId: 'cf-3',
			eventId: 'ev-3',
			status: 'failed',
			recipient,
			smtpResponse: '550 5.1.1 no such user',
			smtpStatusCode: '550',
		}),
	)
	expect(second).toMatchObject({ outcome: 'recorded_system', suppressed: true })
	expect(consoleWarn).toHaveBeenCalledWith(
		'system-email-recipient-suppressed',
		{
			kind: 'connect_agent',
			status: 'failed',
		},
	)
	expect(await loadRecipientSuppression({ db, recipient })).toMatchObject({
		scope: 'all',
		hardBounceCount: 2,
		lastStatus: 'failed',
	})
	for (const kind of [
		'billing_success',
		'email_verification',
		'password_reset',
	]) {
		expect(
			await gateTransactionalSend({
				db,
				recipient,
				category: 'essential',
				kind,
			}),
		).toMatchObject({ allowed: false, code: 'recipient_suppressed' })
		expect(
			await gateTransactionalSend({
				db,
				recipient,
				category: 'essential',
				kind,
				now: afterCooldown(),
			}),
		).toMatchObject({ allowed: false, code: 'recipient_suppressed' })
	}
	// Verification and password reset stop at full suppression too.
	expect(
		await loadVerificationRecipientHardBounce({ db, recipient }),
	).toMatchObject({ scope: 'all' })
	expect(
		(await listRecipientSuppressions({ db, limit: 10 })).suppressions,
	).toEqual([expect.objectContaining({ recipient, scope: 'all' })])

	await recordSend(db, 'cf-4', [recipient])
	await process(
		db,
		providerEvent({
			messageId: 'cf-4',
			eventId: 'ev-4',
			status: 'delivered',
			recipient,
			at: '2026-11-03T11:00:00.000Z',
		}),
	)
	expect(await loadRecipientSuppression({ db, recipient })).toBeNull()
})

test('a late bounce after delivery of the same send is stale', async () => {
	const db = createDb()
	const recipient = 'ada@example.com'
	await recordSend(db, 'cf-late', [recipient])
	await process(
		db,
		providerEvent({
			messageId: 'cf-late',
			eventId: 'ev-delivered',
			status: 'delivered',
			recipient,
			at: '2026-11-03T11:00:00.000Z',
		}),
	)
	const late = await process(
		db,
		providerEvent({
			messageId: 'cf-late',
			eventId: 'ev-bounce',
			...hardBounce,
			recipient,
			at: '2026-11-03T10:00:00.000Z',
		}),
	)
	expect(late.outcome).toBe('stale_system')
	expect(await loadRecipientSuppression({ db, recipient })).toBeNull()
})

test('a verification hard bounce suppresses verification at once and counts toward full suppression', async () => {
	const db = createDb()
	const recipient = 'ada@example.com'
	const inserted = await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('ada', ?, 'hash', ?)`,
		)
		.bind(recipient, 'a'.repeat(64))
		.run()
	await registerTransactionalEmailDelivery({
		db,
		providerMessageId: 'cf-reset',
		userId: Number(inserted.meta.last_row_id),
		recipient,
		kind: 'password_reset',
	})
	await recordSystemEmailSends({
		db,
		providerMessageId: 'cf-reset',
		recipients: [recipient],
		sender: 'kody@kody.codes',
		kind: 'password_reset',
	})
	const result = await process(
		db,
		providerEvent({
			messageId: 'cf-reset',
			eventId: 'ev-reset',
			...hardBounce,
			recipient,
		}),
	)
	expect(result.outcome).toBe('recorded_transactional')
	expect(await loadRecipientSuppression({ db, recipient })).toMatchObject({
		scope: 'verification',
		hardBounceCount: 1,
	})
	expect(
		await gateTransactionalSend({
			db,
			recipient,
			category: 'essential',
			kind: 'password_reset',
		}),
	).toMatchObject({ allowed: false, code: 'recipient_hard_bounce' })
	// Other system mail still sends until the threshold.
	expect(
		await gateTransactionalSend({
			db,
			recipient,
			category: 'essential',
			kind: 'billing_success',
			now: afterCooldown(),
		}),
	).toEqual({ allowed: true })
})

test('retention prunes old send records and stale below-threshold tracking rows', async () => {
	const db = createDb()
	await recordSend(db, 'cf-old', ['old@example.com'])
	await process(
		db,
		providerEvent({
			messageId: 'cf-old',
			eventId: 'ev-old',
			...hardBounce,
			recipient: 'old@example.com',
		}),
	)
	const now = new Date('2027-03-01T00:00:00.000Z')
	expect(await pruneSystemEmailSends({ db, now })).toBe(1)
	expect(await pruneRecipientSuppressionTracking({ db, now })).toBe(1)
	expect(
		await loadRecipientSuppression({ db, recipient: 'old@example.com' }),
	).toBeNull()
})

test('migration 0243 carries existing verification hard bounces forward', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrations, { before: '0243' })
	sqlite
		.prepare(
			`INSERT INTO email_verification_hard_bounces
				(recipient, status, detail, suppressed_at, updated_at)
			VALUES (?, 'bounced', '550 user unknown', ?, ?)`,
		)
		.run(
			'ada@example.com',
			'2026-10-01T00:00:00.000Z',
			'2026-10-01T00:00:00.000Z',
		)
	sqlite.exec(
		readFileSync(
			new URL(
				'0243-system-email-sends-and-recipient-suppressions.sql',
				migrations,
			),
			'utf8',
		),
	)
	const db = createD1FromSqlite(sqlite)
	expect(
		await loadVerificationRecipientHardBounce({
			db,
			recipient: 'ada@example.com',
		}),
	).toMatchObject({
		scope: 'verification',
		hardBounceCount: 1,
		verificationSuppressedAt: '2026-10-01T00:00:00.000Z',
		lastDetail: '550 user unknown',
	})
	expect(
		sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE name = 'email_verification_hard_bounces'`,
			)
			.get(),
	).toBeUndefined()
})

test('a bounce older than a later delivery on another send does not count', async () => {
	const db = createDb()
	const recipient = 'flaky@example.com'
	await recordSend(db, 'cf-a', [recipient])
	await recordSend(db, 'cf-b', [recipient])
	await recordSend(db, 'cf-c', [recipient])

	await process(
		db,
		providerEvent({
			messageId: 'cf-c',
			eventId: 'ev-c-delivered',
			status: 'delivered',
			recipient,
			at: '2026-11-03T10:05:00.000Z',
		}),
	)
	// Both bounces happened before that delivery but are reported after it.
	for (const [messageId, at] of [
		['cf-a', '2026-11-03T10:01:00.000Z'],
		['cf-b', '2026-11-03T10:02:00.000Z'],
	] as const) {
		await process(
			db,
			providerEvent({
				messageId,
				eventId: `ev-${messageId}-bounced`,
				...hardBounce,
				recipient,
				at,
			}),
		)
	}
	expect(await loadRecipientSuppression({ db, recipient })).toBeNull()
})

test('gated transactional mail is held when any recipient is suppressed', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = createDb()
	const suppressed = 'gone@example.com'
	await recordSend(db, 'cf-1', [suppressed])
	await recordSend(db, 'cf-2', [suppressed])
	for (const [messageId, at] of [
		['cf-1', '2026-11-03T10:01:00.000Z'],
		['cf-2', '2026-11-03T10:02:00.000Z'],
	] as const) {
		await process(
			db,
			providerEvent({
				messageId,
				eventId: `ev-${messageId}`,
				...hardBounce,
				recipient: suppressed,
				at,
			}),
		)
	}
	const fetchImpl = vi.fn(stubMxFetch)
	const result = await sendGatedTransactionalEmail({
		db,
		config: { accountId: 'account-1', apiToken: 'test-token' },
		category: 'essential',
		kind: 'billing_success',
		message: {
			from: 'kody@kody.codes',
			to: ['ok@example.com', suppressed],
			subject: 'Receipt',
			text: 'Thanks',
			html: '<p>Thanks</p>',
		},
		now: afterCooldown(),
		fetchImpl,
	})
	expect(result).toMatchObject({
		ok: false,
		hold: true,
		code: 'recipient_suppressed',
	})
})

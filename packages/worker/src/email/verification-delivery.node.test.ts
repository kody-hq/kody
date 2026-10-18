import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	classifyVerificationDeliveryFailure,
	lookupTransactionalEmailDelivery,
	recordTransactionalEmailDeliveryEvent,
	registerTransactionalEmailDelivery,
	setUserEmailVerificationDelivery,
	transactionalEmailDestinationVerificationKind,
	transactionalEmailVerificationKind,
	transactionalKindRecordsHardBounce,
	transactionalPasswordResetKind,
} from './verification-delivery.ts'

const senderBlockResponse =
	'451 4.7.1 Data command rejected: kody.codes is blacklisted - RLR613'

async function createDeliveryTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db, columns: ['email_verified_at'] })
	await db
		.prepare(
			`CREATE TABLE transactional_email_delivery_index (
				provider_message_id TEXT PRIMARY KEY NOT NULL,
				user_id INTEGER NOT NULL,
				kind TEXT NOT NULL,
				recipient TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				last_status TEXT,
				last_status_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('blocked', 'blocked@example.com', 'hash', ?)`,
		)
		.bind('a'.repeat(64))
		.run()
	return db
}

function register(
	db: D1Database,
	providerMessageId: string,
	extra: { recipient?: string; kind?: string } = {},
) {
	return registerTransactionalEmailDelivery({
		db,
		providerMessageId,
		userId: 1,
		recipient: 'blocked@example.com',
		...extra,
	})
}

function record(
	db: D1Database,
	providerMessageId: string,
	deliveryStatus: 'bounced' | 'failed' | 'delivered',
	eventTimestamp: string,
	smtpResponse?: string,
) {
	return recordTransactionalEmailDeliveryEvent({
		db,
		providerMessageId,
		deliveryStatus,
		eventTimestamp,
		smtpResponse,
	})
}

function readUserDelivery(db: D1Database) {
	return db
		.prepare(
			`SELECT email_verification_delivery_status AS status, email_verification_delivery_class AS class
			 FROM users WHERE id = 1`,
		)
		.first<{ status: string | null; class: string | null }>()
}

function senderBlockEvent(kind: string, recipient = 'blocked@example.com') {
	return {
		outcome: 'recorded',
		event: {
			userId: 1,
			kind,
			recipient,
			status: 'bounced',
			class: 'sender_block',
			alreadyTerminal: false,
		},
	}
}

test('classifyVerificationDeliveryFailure treats Fastmail RLR613 as a sender block', () => {
	const cases = [
		{
			input: {
				status: 'bounced',
				smtpResponse: senderBlockResponse,
				smtpEnhancedStatusCode: '4.7.1',
			},
			expected: 'sender_block',
		},
		{
			input: { status: 'failed', smtpResponse: '550 5.7.1 Too new - RLR813' },
			expected: 'sender_block',
		},
		{
			input: {
				status: 'bounced',
				smtpResponse: '550 5.1.1 mailbox unavailable',
			},
			expected: 'other',
		},
		{
			input: {
				status: 'delivered',
				smtpResponse: 'kody.codes is blacklisted - RLR613',
			},
			expected: null,
		},
		{
			input: {
				status: 'deferred',
				smtpResponse: senderBlockResponse,
			},
			expected: 'sender_block',
		},
		{
			input: {
				status: 'deferred',
				smtpResponse: '450 try again later',
			},
			expected: null,
		},
	] as const
	expect(
		cases.map(({ input }) => classifyVerificationDeliveryFailure(input)),
	).toEqual(cases.map(({ expected }) => expected))
})

test('transactional verification delivery records bounce status and stops matching unknown ids', async () => {
	const db = await createDeliveryTestDb()
	await register(db, 'cf-message-1')
	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-message-1',
		}),
	).toMatchObject({
		user_id: 1,
		kind: 'email_verification',
		recipient: 'blocked@example.com',
	})

	expect(
		await record(
			db,
			'cf-message-1',
			'bounced',
			'2026-08-27T23:20:00.000Z',
			senderBlockResponse,
		),
	).toEqual(senderBlockEvent('email_verification'))
	const keepsSenderBlock = {
		outcome: 'recorded',
		event: { alreadyTerminal: true, class: 'sender_block' },
	}
	expect(
		await record(
			db,
			'cf-message-1',
			'bounced',
			'2026-08-27T23:21:00.000Z',
			senderBlockResponse,
		),
	).toMatchObject(keepsSenderBlock)
	expect(
		await record(db, 'unknown-message', 'bounced', '2026-08-27T23:22:00.000Z'),
	).toEqual({ outcome: 'unmatched' })
	expect(await readUserDelivery(db)).toEqual({
		status: 'bounced',
		class: 'sender_block',
	})
	expect(
		await db
			.prepare(
				`SELECT email_verification_delivery_detail AS detail FROM users WHERE id = 1`,
			)
			.first<{ detail: string }>(),
	).toEqual({ detail: expect.stringContaining('RLR613') })

	expect(
		await record(
			db,
			'cf-message-1',
			'failed',
			'2026-08-27T23:23:00.000Z',
			'550 5.7.1 policy rejected',
		),
	).toMatchObject(keepsSenderBlock)
	expect(await readUserDelivery(db)).toMatchObject({ class: 'sender_block' })
})

test('a newer verification send retires older provider ids and ignores stale events', async () => {
	const db = await createDeliveryTestDb()
	await register(db, 'cf-old')
	await register(db, 'cf-new')
	expect(
		await lookupTransactionalEmailDelivery({ db, providerMessageId: 'cf-old' }),
	).toBeNull()
	expect(
		await lookupTransactionalEmailDelivery({ db, providerMessageId: 'cf-new' }),
	).toMatchObject({ provider_message_id: 'cf-new' })

	expect(
		await record(db, 'cf-new', 'delivered', '2026-08-27T23:30:00.000Z'),
	).toMatchObject({
		outcome: 'recorded',
		event: { status: 'delivered', alreadyTerminal: false },
	})
	expect(
		await record(
			db,
			'cf-new',
			'bounced',
			'2026-08-27T23:20:00.000Z',
			senderBlockResponse,
		),
	).toEqual({ outcome: 'stale' })
	expect(await readUserDelivery(db)).toEqual({
		status: 'delivered',
		class: null,
	})
})

test('an immediate bounce still wins over a later worker-clock accepted stamp', async () => {
	const db = await createDeliveryTestDb()
	await register(db, 'cf-immediate-bounce')
	await setUserEmailVerificationDelivery({
		db,
		userId: 1,
		status: 'accepted',
		class: null,
		at: '2026-08-27T23:21:00.000Z',
	})
	expect(
		await record(
			db,
			'cf-immediate-bounce',
			'bounced',
			'2026-08-27T23:20:00.000Z',
			senderBlockResponse,
		),
	).toEqual(senderBlockEvent('email_verification'))
	expect(await readUserDelivery(db)).toEqual({
		status: 'bounced',
		class: 'sender_block',
	})
})

test('destination verification lifecycle matches the index without clobbering signup delivery columns', async () => {
	const db = await createDeliveryTestDb()
	await register(db, 'cf-signup', { kind: transactionalEmailVerificationKind })
	await setUserEmailVerificationDelivery({
		db,
		userId: 1,
		status: 'accepted',
		class: null,
		at: '2026-09-17T02:00:00.000Z',
	})
	await register(db, 'cf-destination', {
		recipient: 'pager@example.com',
		kind: transactionalEmailDestinationVerificationKind,
	})

	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-signup',
		}),
	).toMatchObject({
		kind: transactionalEmailVerificationKind,
		recipient: 'blocked@example.com',
	})
	expect(
		await lookupTransactionalEmailDelivery({
			db,
			providerMessageId: 'cf-destination',
		}),
	).toMatchObject({
		kind: transactionalEmailDestinationVerificationKind,
		recipient: 'pager@example.com',
	})

	expect(
		await record(
			db,
			'cf-destination',
			'bounced',
			'2026-09-17T02:05:00.000Z',
			senderBlockResponse,
		),
	).toEqual(
		senderBlockEvent(
			transactionalEmailDestinationVerificationKind,
			'pager@example.com',
		),
	)
	expect(await readUserDelivery(db)).toEqual({
		status: 'accepted',
		class: null,
	})

	expect(
		await record(db, 'cf-signup', 'delivered', '2026-09-17T02:06:00.000Z'),
	).toMatchObject({
		outcome: 'recorded',
		event: {
			kind: transactionalEmailVerificationKind,
			status: 'delivered',
			alreadyTerminal: false,
		},
	})
	expect(await readUserDelivery(db)).toMatchObject({ status: 'delivered' })
})

test('password reset lifecycle matches the index without clobbering signup delivery columns', async () => {
	const db = await createDeliveryTestDb()
	await setUserEmailVerificationDelivery({
		db,
		userId: 1,
		status: 'accepted',
		class: null,
		at: '2026-09-17T02:00:00.000Z',
	})
	await register(db, 'cf-reset', { kind: transactionalPasswordResetKind })
	expect(
		transactionalKindRecordsHardBounce(transactionalPasswordResetKind),
	).toBe(true)
	expect(transactionalKindRecordsHardBounce('password_reset_confirmed')).toBe(
		true,
	)
	expect(transactionalKindRecordsHardBounce('email_verification')).toBe(true)
	expect(transactionalKindRecordsHardBounce('forward')).toBe(false)

	expect(
		await record(
			db,
			'cf-reset',
			'bounced',
			'2026-09-17T02:05:00.000Z',
			'550 5.1.1 user unknown',
		),
	).toMatchObject({
		outcome: 'recorded',
		event: {
			kind: transactionalPasswordResetKind,
			status: 'bounced',
			recipient: 'blocked@example.com',
		},
	})
	expect(await readUserDelivery(db)).toEqual({
		status: 'accepted',
		class: null,
	})
})

test('destination verification rejects a bounce after a newer delivered event', async () => {
	const db = await createDeliveryTestDb()
	await register(db, 'cf-destination-fresh', {
		recipient: 'pager@example.com',
		kind: transactionalEmailDestinationVerificationKind,
	})

	expect(
		await record(
			db,
			'cf-destination-fresh',
			'delivered',
			'2026-10-17T18:30:00.000Z',
		),
	).toMatchObject({
		outcome: 'recorded',
		event: {
			kind: transactionalEmailDestinationVerificationKind,
			status: 'delivered',
			recipient: 'pager@example.com',
		},
	})
	expect(
		await record(
			db,
			'cf-destination-fresh',
			'bounced',
			'2026-10-17T18:20:00.000Z',
			senderBlockResponse,
		),
	).toEqual({ outcome: 'stale' })
	expect(
		await record(
			db,
			'cf-destination-fresh',
			'bounced',
			'2026-10-17T18:30:00.000Z',
			senderBlockResponse,
		),
	).toEqual({ outcome: 'stale' })
})

test('password reset rejects a bounce after a newer delivered event', async () => {
	const db = await createDeliveryTestDb()
	await register(db, 'cf-reset-fresh', { kind: transactionalPasswordResetKind })

	expect(
		await record(db, 'cf-reset-fresh', 'delivered', '2026-10-17T18:30:00.000Z'),
	).toMatchObject({
		outcome: 'recorded',
		event: { kind: transactionalPasswordResetKind, status: 'delivered' },
	})
	expect(
		await record(
			db,
			'cf-reset-fresh',
			'bounced',
			'2026-10-17T18:20:00.000Z',
			'550 5.1.1 user unknown',
		),
	).toEqual({ outcome: 'stale' })
})

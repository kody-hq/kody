import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { type Mailbox } from './mailbox-do.ts'
import { initializeMailboxSchema } from './mailbox-schema.ts'
import {
	assertMailboxThrows,
	baseMessage,
	rpcFor,
	stubFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'
import {
	mailboxMetaSchemaVersionKey,
	mailboxSchemaVersion,
} from './mailbox-types.ts'

const at = (time: string) => `2026-07-01T${time}.000Z`

test('Mailbox spam and archive are orthogonal, non-destructive, and drive list views', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('spam-archive')
	const mailbox = rpcFor(ownerId)
	const messages = {
		accepted: baseMessage(ownerId, {
			id: 'accepted',
			subject: 'Needle accepted',
			createdAt: at('12:00:01'),
			updatedAt: at('12:00:01'),
		}),
		quarantined: baseMessage(ownerId, {
			id: 'quarantined',
			subject: 'Needle quarantined',
			classification: 'quarantined',
			classificationReason: 'DMARC failed.',
			createdAt: at('12:00:02'),
			updatedAt: at('12:00:02'),
		}),
		spam: baseMessage(ownerId, {
			id: 'spam',
			subject: 'Needle spam',
			createdAt: at('12:00:03'),
			updatedAt: at('12:00:03'),
		}),
		archived: baseMessage(ownerId, {
			id: 'archived',
			subject: 'Needle archived',
			createdAt: at('12:00:04'),
			updatedAt: at('12:00:04'),
		}),
	}
	for (const message of Object.values(messages)) {
		await mailbox.upsertMessageGraph({ ownerId, message, attachments: [] })
	}

	expect(
		await mailbox.setMessageClassification({
			ownerId,
			messageId: 'spam',
			classification: 'spam',
			classificationReason: 'Marked as spam.',
			updatedAt: at('13:00:00'),
		}),
	).toEqual({ status: 'accepted' })
	expect(
		await mailbox.setMessageClassification({
			ownerId,
			messageId: 'archived',
			archivedAt: at('13:00:01'),
			updatedAt: at('13:00:01'),
		}),
	).toEqual({ status: 'accepted' })
	expect(await mailbox.getMessage({ messageId: 'archived' })).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
		archivedAt: at('13:00:01'),
	})
	expect(await mailbox.getMessage({ messageId: 'spam' })).toMatchObject({
		classification: 'spam',
		classificationReason: 'Marked as spam.',
		archivedAt: null,
	})

	const ids = async (
		view?: Parameters<typeof mailbox.listMessages>[0]['view'],
	) =>
		(await mailbox.listMessages({ view, limit: 50 })).messages
			.map((message) => message.id)
			.sort()
	expect(await ids()).toEqual(['accepted', 'archived', 'quarantined', 'spam'])
	expect(await ids('all')).toEqual([
		'accepted',
		'archived',
		'quarantined',
		'spam',
	])
	expect(await ids('inbox')).toEqual(['accepted', 'quarantined'])
	expect(await ids('accepted')).toEqual(['accepted'])
	expect(await ids('quarantined')).toEqual(['quarantined'])
	expect(await ids('spam')).toEqual(['spam'])
	expect(await ids('archived')).toEqual(['archived'])
	expect(await mailbox.countMessages({ view: 'inbox' })).toEqual({ total: 2 })
	expect(await mailbox.countMessages({ view: 'spam' })).toEqual({ total: 1 })
	expect(
		(await mailbox.searchMessages({ query: 'needle', view: 'inbox' })).messages
			.map((message) => message.id)
			.sort(),
	).toEqual(['accepted', 'quarantined'])

	// Archived spam stays in the spam view only, never in archived or inbox.
	await mailbox.setMessageClassification({
		ownerId,
		messageId: 'spam',
		archivedAt: at('14:00:00'),
		updatedAt: at('14:00:00'),
	})
	expect(await ids('spam')).toEqual(['spam'])
	expect(await ids('archived')).toEqual(['archived'])

	// Not spam restores the inbox but keeps the archive flag until unarchived.
	await mailbox.setMessageClassification({
		ownerId,
		messageId: 'spam',
		classification: 'accepted',
		classificationReason: null,
		updatedAt: at('14:00:01'),
	})
	expect(await mailbox.getMessage({ messageId: 'spam' })).toMatchObject({
		classification: 'accepted',
		classificationReason: null,
		archivedAt: at('14:00:00'),
	})
	expect(await ids('archived')).toEqual(['archived', 'spam'])
	await mailbox.setMessageClassification({
		ownerId,
		messageId: 'spam',
		archivedAt: null,
		updatedAt: at('14:00:02'),
	})
	expect(await ids('inbox')).toEqual(['accepted', 'quarantined', 'spam'])

	expect(
		await mailbox.setMessageClassification({
			ownerId,
			messageId: 'archived',
			archivedAt: null,
			updatedAt: at('12:00:00'),
		}),
	).toEqual({ status: 'stale' })
	expect(
		await mailbox.setMessageClassification({
			ownerId,
			messageId: 'missing',
			classification: 'spam',
			classificationReason: 'Marked as spam.',
			updatedAt: at('15:00:00'),
		}),
	).toEqual({ status: 'missing' })
	await runInDurableObject(stubFor(ownerId), async (instance: Mailbox) => {
		await assertMailboxThrows(/requires classification or archivedAt/, () =>
			instance.setMessageClassification({
				ownerId,
				messageId: 'accepted',
				updatedAt: at('15:00:00'),
			}),
		)
		await assertMailboxThrows(/archivedAt/, () =>
			instance.setMessageClassification({
				ownerId,
				messageId: 'accepted',
				archivedAt: 'yesterday',
				updatedAt: at('15:00:00'),
			}),
		)
	})
	expect(await mailbox.countMessages({})).toEqual({ total: 4 })
})

const preV6EmailMessagesSql = `
	CREATE TABLE email_messages_pre_v6 (
		id TEXT PRIMARY KEY NOT NULL,
		direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
		inbox_id TEXT,
		thread_id TEXT,
		sender_identity_id TEXT,
		from_address TEXT NOT NULL DEFAULT '',
		envelope_from TEXT,
		to_addresses_json TEXT NOT NULL DEFAULT '[]',
		cc_addresses_json TEXT NOT NULL DEFAULT '[]',
		bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
		reply_to_addresses_json TEXT NOT NULL DEFAULT '[]',
		subject TEXT NOT NULL DEFAULT '',
		message_id_header TEXT,
		in_reply_to_header TEXT,
		references_json TEXT NOT NULL DEFAULT '[]',
		headers_json TEXT NOT NULL DEFAULT '{}',
		auth_results TEXT,
		text_body TEXT,
		html_body TEXT,
		raw_mime_key TEXT,
		raw_size INTEGER NOT NULL DEFAULT 0,
		processing_status TEXT NOT NULL CHECK (
			processing_status IN ('stored', 'sent', 'failed')
		),
		classification TEXT NOT NULL DEFAULT 'accepted' CHECK (
			classification IN ('accepted', 'quarantined')
		),
		classification_reason TEXT,
		provider_message_id TEXT,
		delivery_status TEXT CHECK (
			delivery_status IS NULL OR delivery_status IN (
				'delivered', 'deferred', 'bounced', 'failed',
				'rejected', 'complained'
			)
		),
		delivery_status_at TEXT,
		error TEXT,
		received_at TEXT,
		sent_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)
`

test('Mailbox warm-migrates a v5 email_messages table to v6 without losing rows', async () => {
	silenceIncidentalRuntimeWarnings()
	const ownerId = uniqueUserId('warm-v6')
	const mailbox = rpcFor(ownerId)
	const quarantined = baseMessage(ownerId, {
		id: 'warm-quarantined',
		classification: 'quarantined',
		classificationReason: 'DMARC failed.',
		textBody: 'kept body',
	})
	const outbound = baseMessage(ownerId, {
		id: 'warm-outbound',
		direction: 'outbound',
		processingStatus: 'sent',
		providerMessageId: 'provider-warm-1',
	})
	await mailbox.upsertMessageGraph({ ownerId, message: quarantined })
	await mailbox.upsertMessageGraph({ ownerId, message: outbound })
	const before = await mailbox.getMessage({ messageId: quarantined.id })

	await runInDurableObject(stubFor(ownerId), async (_instance, state) => {
		const sql = state.storage.sql
		sql.exec(
			`INSERT INTO email_message_retention_retries (
				message_id, retry_at, attempt_count, last_error, updated_at
			) VALUES (?, ?, 2, 'r2 unavailable', ?)`,
			quarantined.id,
			at('20:00:00'),
			at('19:00:00'),
		)
		// Recreate the v5 shape: no archived_at and a CHECK without spam.
		state.storage.transactionSync(() => {
			sql.exec(
				`CREATE TABLE retries_park AS SELECT * FROM email_message_retention_retries`,
			)
			sql.exec(`DELETE FROM email_message_retention_retries`)
			sql.exec(preV6EmailMessagesSql)
			const columns = sql
				.exec<{ name: string }>(`PRAGMA table_info('email_messages')`)
				.toArray()
				.map((column) => column.name)
				.filter((name) => name !== 'archived_at')
				.join(', ')
			sql.exec(
				`INSERT INTO email_messages_pre_v6 (${columns})
				SELECT ${columns} FROM email_messages`,
			)
			sql.exec(`DROP TABLE email_messages`)
			sql.exec(`ALTER TABLE email_messages_pre_v6 RENAME TO email_messages`)
			sql.exec(
				`INSERT INTO email_message_retention_retries SELECT * FROM retries_park`,
			)
			sql.exec(`DROP TABLE retries_park`)
		})
		sql.exec(
			`UPDATE mailbox_meta SET value = 5 WHERE key = ?`,
			mailboxMetaSchemaVersionKey,
		)
		expect(() =>
			sql.exec(
				`UPDATE email_messages SET classification = 'spam' WHERE id = ?`,
				quarantined.id,
			),
		).toThrow(/CHECK constraint failed/)

		initializeMailboxSchema(state.storage)
		initializeMailboxSchema(state.storage)

		expect(
			Number(
				sql
					.exec<{ value: number }>(
						`SELECT value FROM mailbox_meta WHERE key = ?`,
						mailboxMetaSchemaVersionKey,
					)
					.toArray()[0]?.value,
			),
		).toBe(mailboxSchemaVersion)
		expect(mailboxSchemaVersion).toBe(6)
		expect(
			sql
				.exec<{ name: string }>(`PRAGMA table_info('email_messages')`)
				.toArray()
				.map((column) => column.name)
				.at(-1),
		).toBe('archived_at')
		expect(
			sql
				.exec<{ message_id: string; attempt_count: number }>(
					`SELECT message_id, attempt_count FROM email_message_retention_retries`,
				)
				.toArray(),
		).toEqual([{ message_id: quarantined.id, attempt_count: 2 }])
		expect(
			sql
				.exec<{ name: string }>(
					`SELECT name FROM sqlite_master
					WHERE type = 'index' AND tbl_name = 'email_messages'
					AND name IN (
						'idx_email_messages_archived_created_at',
						'idx_email_messages_provider_message_id',
						'idx_email_messages_classification_created_at'
					)
					ORDER BY name`,
				)
				.toArray()
				.map((row) => row.name),
		).toEqual([
			'idx_email_messages_archived_created_at',
			'idx_email_messages_classification_created_at',
			'idx_email_messages_provider_message_id',
		])
		expect(
			sql
				.exec<{ name: string }>(
					`SELECT name FROM sqlite_master WHERE name LIKE '%v6%'`,
				)
				.toArray(),
		).toEqual([])
	})

	expect(await mailbox.getMessage({ messageId: quarantined.id })).toEqual({
		...before,
		archivedAt: null,
	})
	expect(await mailbox.countMessages({})).toEqual({ total: 2 })
	expect(
		await mailbox.setMessageClassification({
			ownerId,
			messageId: quarantined.id,
			classification: 'spam',
			classificationReason: 'Marked as spam.',
			archivedAt: at('21:00:00'),
			updatedAt: at('21:00:00'),
		}),
	).toEqual({ status: 'accepted' })
	expect(await mailbox.getMessage({ messageId: quarantined.id })).toMatchObject(
		{ classification: 'spam', archivedAt: at('21:00:00') },
	)
})

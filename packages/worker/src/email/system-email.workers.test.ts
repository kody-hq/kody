import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { handleInboundEmail } from './inbound.ts'
import { maxSurvivableInboundRawBytes } from './parser.ts'
import { mailboxRpc } from './mailbox-client.ts'
import { listEmailInboxesForUser } from './repo.ts'
import {
	deleteSystemEmailMessageById,
	listSystemEmailMessages,
} from './system-email-graph-store.ts'
import { systemInboundDeletedRejectionReason } from './system-inbound-dedupe.ts'
import { loadSystemEmailHealth } from './system-email-health.ts'
import {
	maxDetailedEmailRejectionEventsPerDay,
	RetryableInboundStorageError,
} from './service.ts'
import {
	pruneSystemEmailRetention,
	refundSystemEmailDailyReceive,
	systemEmailDayKey,
	systemEmailLimits,
	systemEmailOwnerId,
} from './system-email.ts'
import { createForwardableEmailMessage } from './test-fixtures.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
type InboundEnv = Parameters<typeof handleInboundEmail>[1]

const platformBaseUrl = 'https://kody.example.com'
// System inboxes live on the apex; user mail lives on the inbox. subdomain.
const systemDomain = 'kody.example.com'
const userDomain = 'inbox.kody.example.com'
const unknownAddress = 'Unknown Kody email address.'
const reservedForSystem = 'This address is reserved for system mail.'
const overQuota = 'Recipient mailbox is over quota.'
const retentionNow = new Date('2026-07-06T12:00:00.000Z')
const expiredAt = new Date(
	retentionNow.getTime() -
		(systemEmailLimits.retentionDays + 1) * 24 * 60 * 60 * 1000,
).toISOString()

function createInboundEnv(overrides: Partial<InboundEnv> = {}): InboundEnv {
	return { ...env, APP_BASE_URL: platformBaseUrl, ...overrides } as InboundEnv
}

function buildInboundMessage(input: {
	to: string
	subject?: string
	messageId?: string
}) {
	return createForwardableEmailMessage({
		from: 'sender@example.net',
		to: input.to,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${input.to}`,
			`Subject: ${input.subject ?? 'System mail'}`,
			`Message-ID: <${input.messageId ?? crypto.randomUUID()}@example.net>`,
			'',
			'System body.',
		].join('\r\n'),
	})
}

async function deliver(
	input: Parameters<typeof buildInboundMessage>[0],
	inboundEnv = createInboundEnv(),
) {
	const message = buildInboundMessage(input)
	await handleInboundEmail(message, inboundEnv)
	return message.rejectedReason
}

function proxyWith<T extends object>(
	target: T,
	overrides: Partial<Record<keyof T, unknown>>,
) {
	return new Proxy(target, {
		get(object, property, receiver) {
			if (property in overrides) {
				return overrides[property as keyof T]
			}
			const value = Reflect.get(object, property, receiver)
			return typeof value === 'function' ? value.bind(object) : value
		},
	})
}

async function seedVerifiedAccount(username: string) {
	const email = `${username}-${crypto.randomUUID()}@example.com`
	const userId = testStableUserIdFromEmail(email)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET
			email = excluded.email,
			email_verified_at = excluded.email_verified_at,
			stable_user_id = excluded.stable_user_id,
			updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(
			username,
			email,
			'test-password-hash',
			new Date().toISOString(),
			userId,
		)
		.run()
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username,
		plan: 'max',
	})
	return userId
}

async function listSystemMessages() {
	return await listSystemEmailMessages({ db: env.APP_DB, limit: 10 })
}

async function systemInboxNames() {
	const inboxes = await listEmailInboxesForUser({
		db: env.APP_DB,
		userId: systemEmailOwnerId,
	})
	return inboxes.map((inbox) => inbox.name).sort()
}

async function listUserInbound(userId: string) {
	return (
		await mailboxRpc({ env, userId: ownerIdFromStored(userId) }).listMessages({
			limit: 10,
		})
	).messages
}

async function readSystemDailyReceiveCount(
	localPart: string,
	day = systemEmailDayKey(),
) {
	const row = await env.APP_DB.prepare(
		`SELECT count FROM system_email_daily_counters
			WHERE local_part = ? AND day = ?`,
	)
		.bind(localPart, day)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

async function readRejectionEvents() {
	const { results } = await env.APP_DB.prepare(
		`SELECT id, detail_json FROM system_email_delivery_events
		WHERE event_type = 'rejected'
		ORDER BY created_at ASC, id ASC`,
	).all<{ id: string; detail_json: string }>()
	const rows = (results ?? []).map((row) => ({
		id: row.id,
		detail: JSON.parse(row.detail_json) as Record<string, unknown>,
	}))
	return {
		detailed: rows.filter((row) => row.detail['aggregate'] !== true),
		aggregate: rows.find((row) => row.detail['aggregate'] === true) ?? null,
	}
}

async function insertSystemMessages(
	rows: Array<{ id: string; rawMimeKey: string | null; createdAt: string }>,
) {
	// 4 bindings per row must stay under D1's 100-variable statement limit.
	const insertChunkSize = 18
	for (let start = 0; start < rows.length; start += insertChunkSize) {
		const chunk = rows.slice(start, start + insertChunkSize)
		await env.APP_DB.prepare(
			`INSERT INTO system_email_messages (
				id, direction, from_address, subject, processing_status, raw_mime_key, created_at, updated_at
			) VALUES ${chunk
				.map(() => `(?, 'inbound', 'a@example.net', 'Head', 'stored', ?, ?, ?)`)
				.join(', ')}`,
		)
			.bind(
				...chunk.flatMap((row) => [
					row.id,
					row.rawMimeKey,
					row.createdAt,
					row.createdAt,
				]),
			)
			.run()
	}
}

async function selectIds(sql: string) {
	const { results } = await env.APP_DB.prepare(sql).all<{ id: string }>()
	return results.map((row) => row.id)
}

async function countRows(sql: string) {
	const row = await env.APP_DB.prepare(sql).first<{ count: number }>()
	return Number(row?.count ?? -1)
}

function failingDeleteBlobs() {
	return proxyWith(env.EMAIL_BLOBS, {
		delete: async () => {
			throw new Error('simulated R2 outage')
		},
	})
}

test('reserved system locals store under the operator-owned system inbox', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const fixtureUserId = await seedVerifiedAccount('kody')

	expect(
		await deliver({
			to: `kody@${systemDomain}`,
			subject: 'Cloudflare confirmation',
		}),
	).toBeNull()
	expect(await listUserInbound(fixtureUserId)).toEqual([])
	const messages = await listSystemMessages()
	expect(messages).toHaveLength(1)
	expect(messages[0]).toMatchObject({
		subject: 'Cloudflare confirmation',
		fromAddress: 'sender@example.net',
		processingStatus: 'stored',
	})
	expect(await loadSystemEmailHealth({ db: env.APP_DB })).toMatchObject({
		counts: { messages: 1, deliveryEvents: 2 },
		healthy: true,
	})
	const delivery = await env.APP_DB.prepare(
		`SELECT detail_json FROM system_email_delivery_events
		WHERE event_type = 'received' LIMIT 1`,
	).first<{ detail_json: string }>()
	expect(JSON.parse(delivery?.detail_json ?? '{}')).toMatchObject({
		state: 'received',
		usageEffectRecordedAt: expect.any(String),
		subscriptionEffectState: 'complete',
	})
	const counter = await env.APP_DB.prepare(
		`SELECT updated_at, operation_token
		FROM system_email_daily_counters WHERE local_part = 'kody'`,
	).first<{ updated_at: string; operation_token: string }>()
	expect(counter?.updated_at).toMatch(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
	)
	expect(counter?.operation_token).toMatch(
		/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u,
	)
	expect(await systemInboxNames()).toEqual(['kody'])
	const rollup = await env.APP_DB.prepare(
		`SELECT event_count, error_count FROM usage_rollups
		WHERE user_id = ? AND metric = 'email_received'`,
	)
		.bind(systemEmailOwnerId)
		.first<{ event_count: number; error_count: number }>()
	expect(rollup).toMatchObject({ event_count: 1, error_count: 0 })

	// Subaddressed system mail (support+tag@apex) routes to the same
	// operator inbox for the base local part.
	for (const [to, subject, inboxes] of [
		[
			`support+ticket-123@${systemDomain}`,
			'Tagged system mail',
			['kody', 'support'],
		],
		[
			`psl@${systemDomain}`,
			'Public suffix list contact',
			['kody', 'psl', 'support'],
		],
	] as const) {
		expect(await deliver({ to, subject })).toBeNull()
		expect((await listSystemMessages())[0]).toMatchObject({
			subject,
			toAddresses: [to],
		})
		expect(await systemInboxNames()).toEqual(inboxes)
	}

	// Inbound-only alias: team@apex lands in the support inbox and keeps the
	// original To; it must not provision a separate team system inbox.
	const teamTo = `team@${systemDomain}`
	expect(
		await deliver({ to: teamTo, subject: 'Team alias inbound' }),
	).toBeNull()
	expect((await listSystemMessages())[0]).toMatchObject({
		subject: 'Team alias inbound',
		toAddresses: [teamTo],
	})
	expect(await systemInboxNames()).toEqual(['kody', 'psl', 'support'])
	expect(await readSystemDailyReceiveCount('support')).toBeGreaterThanOrEqual(2)
	expect(await readSystemDailyReceiveCount('team')).toBe(0)
}, 30_000)

test('user-subdomain mail delivers to live users (including reserved-local plus-tags) and rejects permanent or unowned reserved locals', async () => {
	silenceIncidentalRuntimeWarnings()
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const username = `normal-${crypto.randomUUID().slice(0, 8)}`
	const userId = await seedVerifiedAccount(username)
	const blogUserId = await seedVerifiedAccount('blog')

	expect(
		await deliver({
			to: `blog@${userDomain}`,
			subject: 'Unreserved built-in inbox',
		}),
	).toBeNull()
	expect(await listUserInbound(blogUserId)).toEqual([
		expect.objectContaining({ direction: 'inbound' }),
	])

	const rejections: Array<[string, string]> = [
		[`help@${userDomain}`, unknownAddress],
		// An admin-added reservation with no live account is not a system
		// mailbox; there is no such user.
		[`brandnew@${userDomain}`, unknownAddress],
		// System locals only route on the apex: on the user subdomain they stay
		// reserved, and non-system locals on the apex are not addresses at all.
		[`kody@${userDomain}`, reservedForSystem],
		[`${username}@${systemDomain}`, unknownAddress],
	]
	for (const [to, reason] of rejections) {
		expect(await deliver({ to })).toBe(reason)
	}

	const deliveredTo = [
		`${username}@${userDomain}`,
		`${username}+kody@${userDomain}`,
		`${username}+patch@${userDomain}`,
		`${username}+support@${userDomain}`,
	]
	for (const to of deliveredTo) {
		expect(await deliver({ to, subject: `User mail ${to}` })).toBeNull()
	}
	const stored = await listUserInbound(userId)
	expect(stored).toHaveLength(deliveredTo.length)
	expect(stored).toEqual(
		expect.arrayContaining(
			deliveredTo.map((to) =>
				expect.objectContaining({
					subject: `User mail ${to}`,
					toAddresses: [to],
					direction: 'inbound',
					processingStatus: 'stored',
				}),
			),
		),
	)
	expect(await listSystemMessages()).toEqual([])
})

test('refundSystemEmailDailyReceive decrements local/day counter and floors at zero', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-07-05T12:00:00.000Z')
	const day = systemEmailDayKey(now)
	await env.APP_DB.prepare(
		`INSERT INTO system_email_daily_counters (local_part, day, count, updated_at)
		VALUES ('abuse', ?, 1, ?), ('support', ?, 2, ?)`,
	)
		.bind(day, now.toISOString(), day, now.toISOString())
		.run()

	for (let attempt = 0; attempt < 2; attempt += 1) {
		await refundSystemEmailDailyReceive({
			db: env.APP_DB,
			localPart: 'abuse',
			now,
		})
		expect(await readSystemDailyReceiveCount('abuse', day)).toBe(0)
	}
	expect(await readSystemDailyReceiveCount('support', day)).toBe(2)
})

test('system inbox R2/D1 failures and retries keep one durable quota charge', async () => {
	silenceIncidentalRuntimeWarnings()
	const r2FailingEnv = createInboundEnv({
		EMAIL_BLOBS: proxyWith(env.EMAIL_BLOBS, {
			put: async () => {
				throw new Error('simulated R2 outage')
			},
		}),
	})
	const d1FailingEnv = createInboundEnv({
		APP_DB: proxyWith(env.APP_DB, {
			prepare: (query: string) => {
				if (query.includes('INSERT INTO system_email_messages')) {
					throw new Error('simulated D1 insert failure')
				}
				return env.APP_DB.prepare(query)
			},
		}),
	})

	for (const [index, failingEnv] of [r2FailingEnv, d1FailingEnv].entries()) {
		await ensureEmailTestSchema(env.APP_DB)
		await ensureUsageRollupsTestSchema(env.APP_DB)
		const input = {
			to: `abuse@${systemDomain}`,
			messageId: `system-storage-retry-${index}`,
		}
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const message = buildInboundMessage(input)
			await expect(
				handleInboundEmail(message, failingEnv),
			).rejects.toBeInstanceOf(RetryableInboundStorageError)
			expect(message.rejectedReason).toBeNull()
			expect(await readSystemDailyReceiveCount('abuse')).toBe(1)
		}

		expect(await deliver(input)).toBeNull()
		expect(await readSystemDailyReceiveCount('abuse')).toBe(1)
		expect(await listSystemMessages()).toHaveLength(1)
	}
})

test('admin delete tombstones the inbound fingerprint so SMTP redelivery stays discarded', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const input = {
		to: `abuse@${systemDomain}`,
		messageId: 'system-delete-tombstone',
	}
	expect(await deliver(input)).toBeNull()
	const stored = await listSystemMessages()
	expect(stored).toHaveLength(1)
	const pointer = await env.APP_DB.prepare(
		`SELECT id, state, message_id, fingerprint
		FROM system_email_delivery_events
		WHERE provider = 'cloudflare-email-routing-dedupe'
		LIMIT 1`,
	).first<{
		id: string
		state: string
		message_id: string | null
		fingerprint: string
	}>()
	expect(pointer).toMatchObject({
		state: 'pending',
		message_id: null,
	})
	expect(pointer?.id).toBe(`email-inbound-dedupe:${pointer?.fingerprint}`)

	await deleteSystemEmailMessageById({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		messageId: stored[0]!.id,
	})
	expect(await listSystemMessages()).toEqual([])
	const tombstone = await env.APP_DB.prepare(
		`SELECT state, event_type, message_id, detail_json
		FROM system_email_delivery_events
		WHERE id = ?`,
	)
		.bind(pointer!.id)
		.first<{
			state: string
			event_type: string
			message_id: string | null
			detail_json: string
		}>()
	expect(tombstone).toMatchObject({
		state: 'rejected',
		event_type: 'rejected',
		message_id: null,
	})
	expect(JSON.parse(tombstone?.detail_json ?? '{}')).toMatchObject({
		state: 'rejected',
		rejectionReason: systemInboundDeletedRejectionReason,
	})
	expect(
		await countRows(
			`SELECT COUNT(*) AS count FROM system_email_delivery_events
			WHERE message_id IS NOT NULL`,
		),
	).toBe(0)
	expect(await readSystemDailyReceiveCount('abuse')).toBe(1)

	expect(await deliver(input)).toBe(systemInboundDeletedRejectionReason)
	expect(await listSystemMessages()).toEqual([])
	expect(await readSystemDailyReceiveCount('abuse')).toBe(1)
})

test('system inbox ambiguous quota batch response charges once across retry', async () => {
	silenceIncidentalRuntimeWarnings()
	consoleWarn.mockImplementation(() => {})
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	let batchResponseFailed = false
	const ambiguousDb = proxyWith(env.APP_DB, {
		batch: async (statements: Parameters<D1Database['batch']>[0]) => {
			const result = await env.APP_DB.batch(statements)
			if (!batchResponseFailed) {
				batchResponseFailed = true
				throw new Error('simulated system quota batch response loss')
			}
			return result
		},
	})
	const input = {
		to: `abuse@${systemDomain}`,
		messageId: 'system-ambiguous-quota',
	}
	await deliver(input, createInboundEnv({ APP_DB: ambiguousDb }))
	await deliver(input)

	expect(await readSystemDailyReceiveCount('abuse')).toBe(1)
	expect(await listSystemMessages()).toHaveLength(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'system-inbound-dedupe-window-claim-recovered',
		expect.stringContaining('email-inbound-dedupe:'),
		expect.any(Error),
	)
})

test('system stored-message count failure occurs before quota charge', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const countFailure = async () => {
		throw new Error('simulated system stored count failure')
	}
	const failingDb = proxyWith(env.APP_DB, {
		prepare: (query: string) =>
			query.includes('COUNT(*)') && query.includes('FROM system_email_messages')
				? { first: countFailure, bind: () => ({ first: countFailure }) }
				: env.APP_DB.prepare(query),
	})

	await expect(
		deliver(
			{ to: `abuse@${systemDomain}`, messageId: 'system-count-failure' },
			createInboundEnv({ APP_DB: failingDb }),
		),
	).rejects.toThrow('simulated system stored count failure')
	expect(await readSystemDailyReceiveCount('abuse')).toBe(0)
})

test('system email size and daily caps reject before storage with bounded events', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)

	const oversize = buildInboundMessage({ to: `abuse@${systemDomain}` })
	Object.defineProperty(oversize, 'rawSize', {
		value: maxSurvivableInboundRawBytes + 1,
	})
	await handleInboundEmail(oversize, createInboundEnv())
	expect(oversize.rejectedReason).toBe(overQuota)
	expect(
		await env.APP_DB.prepare(
			`SELECT count FROM system_email_daily_counters WHERE local_part = 'abuse'`,
		).first(),
	).toBeNull()
	await env.APP_DB.prepare(`DELETE FROM system_email_delivery_events`).run()

	await env.APP_DB.prepare(
		`INSERT INTO system_email_daily_counters (local_part, day, count, updated_at)
		VALUES ('support', ?, ?, ?)`,
	)
		.bind(
			new Date().toISOString().slice(0, 10),
			systemEmailLimits.maxReceivesPerDay,
			new Date().toISOString(),
		)
		.run()
	const attempts = maxDetailedEmailRejectionEventsPerDay + 2
	for (let index = 0; index < attempts; index += 1) {
		expect(
			await deliver({
				to: `support@${systemDomain}`,
				messageId: `system-cap-${index}`,
			}),
		).toBe(overQuota)
	}
	expect(await listSystemMessages()).toEqual([])
	const rejections = await readRejectionEvents()
	expect(rejections.detailed).toHaveLength(
		maxDetailedEmailRejectionEventsPerDay,
	)
	expect(rejections.aggregate?.detail).toMatchObject({
		aggregate: true,
		count: attempts,
		last_phase: 'system-limit',
	})
})

test('system email retention deletes blobs before rows, keeps rows when the blob delete fails, and prunes old messages, events, and counters', async () => {
	silenceIncidentalRuntimeWarnings(['system-email-raw-mime-blob-delete-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	const fresh = retentionNow.toISOString()
	const rawMimeKey = `email-raw:v1:${systemEmailOwnerId}/blob-ordering-message`
	await env.EMAIL_BLOBS.put(rawMimeKey, 'raw mime payload')
	await insertSystemMessages([
		{ id: 'blob-ordering-message', rawMimeKey, createdAt: expiredAt },
		{ id: 'plain-old-message', rawMimeKey: null, createdAt: expiredAt },
		{ id: 'fresh-system-message', rawMimeKey: null, createdAt: fresh },
	])
	await env.APP_DB.prepare(
		`INSERT INTO system_email_attachments (
			id, message_id, filename, content_type, size, storage_kind, created_at
		) VALUES ('old-attachment', 'blob-ordering-message', 'old.txt', 'text/plain', 1, 'raw-mime', ?)`,
	)
		.bind(expiredAt)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO system_email_delivery_events (
			id, message_id, inbox_id, event_type, provider, detail_json, created_at
		) VALUES
			('old-event', 'blob-ordering-message', NULL, 'received', 'test', '{}', ?),
			('fresh-event', 'fresh-system-message', NULL, 'received', 'test', '{}', ?)`,
	)
		.bind(expiredAt, fresh)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO system_email_daily_counters (local_part, day, count, updated_at)
		VALUES ('admin', '2026-01-01', 1, ?)`,
	)
		.bind(expiredAt)
		.run()
	const messageIds = () =>
		selectIds(`SELECT id FROM system_email_messages ORDER BY id`)

	const failed = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: failingDeleteBlobs(),
		now: retentionNow,
	})
	// The simulated outage is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'system-email-raw-mime-blob-delete-failed',
		expect.any(Error),
	)
	// Every message attempts the deterministic raw-MIME key, so an R2 outage
	// skips both the stored-key row and the plain residual; the blob remains
	// for retry.
	expect(failed).toMatchObject({
		deletedMessages: 0,
		deletedRawMimeBlobs: 0,
		blobDeleteErrors: 2,
		authority: 'dedicated',
		warnings: [],
	})
	expect(await env.EMAIL_BLOBS.get(rawMimeKey)).not.toBeNull()
	expect(await messageIds()).toEqual([
		'blob-ordering-message',
		'fresh-system-message',
		'plain-old-message',
	])

	const retried = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now: retentionNow,
	})
	expect(retried).toMatchObject({
		deletedMessages: 2,
		deletedRawMimeBlobs: 1,
		blobDeleteErrors: 0,
		authority: 'dedicated',
	})
	expect(failed.deletedCounters + retried.deletedCounters).toBe(1)
	expect(await env.EMAIL_BLOBS.get(rawMimeKey)).toBeNull()
	expect(await messageIds()).toEqual(['fresh-system-message'])
	expect(await selectIds(`SELECT id FROM system_email_attachments`)).toEqual([])
	expect(
		await selectIds(`SELECT id FROM system_email_delivery_events ORDER BY id`),
	).toEqual(['fresh-event'])
	expect(
		await countRows(
			`SELECT COUNT(*) AS count FROM system_email_daily_counters`,
		),
	).toBe(0)
})

test('system email retention advances past skipped blob rows at the head of a batch', async () => {
	silenceIncidentalRuntimeWarnings(['system-email-raw-mime-blob-delete-failed'])
	await ensureEmailTestSchema(env.APP_DB)
	const oldMs = Date.parse(expiredAt)
	// A full batch of blob-backed rows sits at the head of the newest-first
	// expired ordering; the plain rows behind it are even older.
	const blockedCount = systemEmailLimits.pruneBatchSize
	const plainCount = 5
	await insertSystemMessages([
		...Array.from({ length: blockedCount }, (_, index) => ({
			id: `head-blob-${String(index).padStart(3, '0')}`,
			rawMimeKey: `email-raw:v1:${systemEmailOwnerId}/head-blob-${index}`,
			createdAt: new Date(oldMs + index * 1000).toISOString(),
		})),
		...Array.from({ length: plainCount }, (_, index) => ({
			id: `head-plain-${index}`,
			rawMimeKey: null,
			createdAt: new Date(oldMs - 24 * 60 * 60 * 1000).toISOString(),
		})),
	])

	// Every message attempts the deterministic raw-MIME key, so an R2 outage
	// skips every selected batch while the keyset cursor still advances.
	const result = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: failingDeleteBlobs(),
		now: retentionNow,
	})
	expect(result.blobDeleteErrors).toBe(blockedCount + plainCount)
	expect(result.deletedMessages).toBe(0)
	// The simulated outage is warned for operators.
	expect(consoleWarn).toHaveBeenCalledWith(
		'system-email-raw-mime-blob-delete-failed',
		expect.any(Error),
	)
	expect(
		await countRows(
			`SELECT COUNT(*) AS count FROM system_email_messages WHERE id LIKE 'head-plain-%'`,
		),
	).toBe(plainCount)
	expect(
		await countRows(
			`SELECT COUNT(*) AS count FROM system_email_messages WHERE id LIKE 'head-blob-%'`,
		),
	).toBe(blockedCount)

	// A working binding then deletes the skipped rows (deleting absent R2
	// keys is a no-op).
	const cleanup = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now: retentionNow,
	})
	expect(cleanup.deletedMessages).toBe(blockedCount + plainCount)
})

test('system email retention drains delivery-event backlogs larger than one batch', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const backlog = systemEmailLimits.pruneBatchSize + 5
	await env.APP_DB.prepare(
		`WITH RECURSIVE sequence(value) AS (
			VALUES(0) UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
		)
		INSERT INTO system_email_delivery_events (
			id, message_id, inbox_id, event_type, provider, detail_json, created_at
		)
		SELECT 'backlog-event-' || value, NULL, NULL, 'received', 'test', '{}', ?
		FROM sequence`,
	)
		.bind(backlog - 1, expiredAt)
		.run()

	const result = await pruneSystemEmailRetention({
		db: env.APP_DB,
		blobs: env.EMAIL_BLOBS,
		now: retentionNow,
	})

	expect(result.deletedDeliveryEvents).toBeGreaterThanOrEqual(backlog)
	expect(
		await countRows(
			`SELECT COUNT(*) AS count FROM system_email_delivery_events
			WHERE id LIKE 'backlog-event-%'`,
		),
	).toBe(0)
})

test('kent@ mail reaching the Worker lands in the system inbox', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const kentTo = `kent@${systemDomain}`
	expect(
		await deliver({ to: kentTo, subject: 'Hi Kent' }, createInboundEnv()),
	).toBeNull()
	expect((await listSystemMessages())[0]).toMatchObject({
		subject: 'Hi Kent',
		toAddresses: [kentTo],
	})
	expect(await systemInboxNames()).toContain('kent')
}, 30_000)

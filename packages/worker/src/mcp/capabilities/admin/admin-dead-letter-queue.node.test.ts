import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	deadLetterParkRetryDelaySeconds,
	handleDeadLetterQueueBatch,
} from '#worker/dead-letter/consumer.ts'
import { describeDeadLetterBody } from '#worker/dead-letter/metadata.ts'
import {
	deadLetterQueueNames,
	getDeadLetterQueue,
	resolveDeadLetterQueue,
} from '#worker/dead-letter/queues.ts'
import { purgeParkedDeadLetterMessages } from '#worker/dead-letter/store.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	consoleError,
	consoleInfo,
} from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminDeadLetterQueueAckCapability } from './admin-dead-letter-queue-ack.ts'
import { adminDeadLetterQueueListCapability } from './admin-dead-letter-queue-list.ts'
import { adminDeadLetterQueuePeekCapability } from './admin-dead-letter-queue-peek.ts'
import { adminDeadLetterQueuePurgeCapability } from './admin-dead-letter-queue-purge.ts'
import { adminDeadLetterQueueReplayCapability } from './admin-dead-letter-queue-replay.ts'

const sentry = vi.hoisted(() => ({
	captureException: vi.fn(),
	contexts: [] as Array<Record<string, unknown>>,
	tags: [] as Array<[string, string]>,
}))

vi.mock(import('@sentry/cloudflare'), async (importOriginal) => ({
	...(await importOriginal()),
	captureException: sentry.captureException,
	withScope: ((callback: (scope: unknown) => void) =>
		callback({
			setLevel() {},
			setFingerprint() {},
			setTag: (key: string, value: string) => sentry.tags.push([key, value]),
			setContext: (_name: string, context: Record<string, unknown>) =>
				sentry.contexts.push(context),
		})) as never,
}))

// These tests assert real `audit_events` rows.
vi.unmock('#worker/audit-log.ts')

const feedbackDlq = 'kody-platform-feedback-dispatch-dlq'
const emailDlq = 'kody-email-delivery-dlq'
const secretBody = {
	feedbackId: 'feedback-fixture-1',
	kind: 'fixture.event',
	message: 'user-authored text that must stay private',
	accessToken: 'fixture-token-value',
	sessionId: 'fixture-session',
	'free text key with spaces': true,
}

function createHarness(callerRoles: Array<string> = ['admin']) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(
		readFileSync(
			new URL(
				'../../../../audit-migrations/0001-audit-events.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	const users = [
		{ id: 1, username: 'admin', roles: [1, 2] },
		{ id: 2, username: 'jane', roles: [1] },
	]
	for (const user of users) {
		const email = `${user.username}@example.com`
		const stableUserId = testStableUserIdFromEmail(email)
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id, email_verified_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'hash', ?, '2026-01-01T00:00:00.000Z', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
			)
			.run(user.id, user.username, email, stableUserId)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
				 VALUES (?, ?, 'free', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
			)
			.run(stableUserId, user.username)
		for (const role of user.roles) {
			sqlite
				.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`)
				.run(user.id, role)
		}
	}
	const isAdmin = callerRoles.includes('admin')
	const callerEmail = isAdmin ? 'admin@example.com' : 'jane@example.com'
	const db = createD1FromSqlite(sqlite)
	const send = vi.fn(async () => {})
	const replayScheduledDispatchMessage = vi.fn(async () => ({
		ok: true as const,
		lane: 'fixture',
	}))
	const env = {
		APP_DB: db,
		AUDIT_DB: createD1FromSqlite(auditSqlite),
		PLATFORM_FEEDBACK_DISPATCH_QUEUE: { send },
		JOBS: { replayScheduledDispatchMessage },
	} as unknown as Env
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored(testStableUserIdFromEmail(callerEmail)),
				email: callerEmail,
				displayName: isAdmin ? 'admin' : 'jane',
				roles: callerRoles,
			},
		}),
	}
	const park = async (
		queue: string,
		messages: Array<{ id: string; body: unknown; attempts?: number }>,
	) => {
		const definition = getDeadLetterQueue(queue)
		if (!definition) throw new Error(`unknown fixture queue ${queue}`)
		const acks: Array<string> = []
		await handleDeadLetterQueueBatch(
			{
				queue,
				messages: messages.map((message, index) => ({
					id: message.id,
					body: message.body,
					attempts: message.attempts ?? 1,
					timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)),
					ack: () => acks.push(message.id),
					retry: () => {},
				})),
			} as unknown as MessageBatch<unknown>,
			env,
			definition,
		)
		return acks
	}
	return {
		ctx,
		send,
		replayScheduledDispatchMessage,
		park,
		sqlite,
		auditEvents: () =>
			auditSqlite
				.prepare(
					'SELECT action, result, reason, email_hash FROM audit_events ORDER BY id',
				)
				.all() as Array<{
				action: string
				result: string
				reason: string
				email_hash: string | null
			}>,
	}
}

test('every production DLQ resolves, including preview-prefixed names', () => {
	expect(resolveDeadLetterQueue(feedbackDlq)?.name).toBe(feedbackDlq)
	expect(
		resolveDeadLetterQueue('kody-pr-42-platform-feedback-dispatch-dlq')?.name,
	).toBe(feedbackDlq)
	expect(resolveDeadLetterQueue('kody-platform-feedback-dispatch')).toBeNull()
})

test('redacted metadata keeps shape and stable ids, never values or secrets', () => {
	const { bodyJson, metadata } = describeDeadLetterBody(secretBody)
	expect(bodyJson).toBe(JSON.stringify(secretBody))
	expect(metadata).toEqual({
		payloadType: 'object',
		payloadBytes: new TextEncoder().encode(JSON.stringify(secretBody)).length,
		topLevelKeys: ['feedbackId', 'kind', 'message', 'accessToken', 'sessionId'],
		topLevelKeyCount: 6,
		kind: 'fixture.event',
		stableIds: { feedbackId: 'feedback-fixture-1' },
	})
	const serialized = JSON.stringify(metadata)
	expect(serialized).not.toContain('user-authored text')
	expect(serialized).not.toContain('fixture-token-value')
	expect(serialized).not.toContain('fixture-session')
	expect(describeDeadLetterBody('plain text body').metadata).toMatchObject({
		payloadType: 'string',
		topLevelKeys: [],
		stableIds: {},
	})
	expect(
		describeDeadLetterBody({ id: 'has spaces in it' }).metadata.stableIds,
	).toEqual({})
	expect(describeDeadLetterBody(10n)).toMatchObject({
		bodyJson: null,
		metadata: { payloadType: 'unserializable', payloadBytes: 0 },
	})
})

test('the DLQ consumer reports park failures to Sentry with queue, message id, and attempts, then retries', async () => {
	consoleError.mockImplementation(() => {})
	sentry.captureException.mockClear()
	sentry.contexts.length = 0
	const definition = getDeadLetterQueue(feedbackDlq)
	if (!definition) throw new Error('missing fixture queue')
	const retry = vi.fn()
	const ack = vi.fn()
	await handleDeadLetterQueueBatch(
		{
			queue: feedbackDlq,
			messages: [
				{
					id: 'msg-fixture-fail',
					body: secretBody,
					attempts: 101,
					timestamp: new Date('2026-01-01T00:00:00.000Z'),
					ack,
					retry,
				},
			],
		} as unknown as MessageBatch<unknown>,
		{
			APP_DB: {
				prepare: () => ({
					bind: () => ({
						run: async () => {
							throw new Error('D1 unavailable')
						},
					}),
				}),
			} as unknown as D1Database,
		},
		definition,
	)
	expect(ack).not.toHaveBeenCalled()
	expect(retry).toHaveBeenCalledWith({ delaySeconds: 2_700 })
	expect([1, 2, 3, 10, 11, 100].map(deadLetterParkRetryDelaySeconds)).toEqual([
		60, 120, 240, 2_700, 2_700, 2_700,
	])
	expect(sentry.captureException).toHaveBeenCalledTimes(1)
	expect(sentry.contexts.at(-1)).toEqual({
		stage: 'park',
		queue: feedbackDlq,
		messageId: 'msg-fixture-fail',
		attempts: 101,
		final: true,
		error: 'D1 unavailable',
	})
	expect(JSON.stringify(sentry.contexts)).not.toContain('user-authored text')
})

test('admins list depth, peek redacted metadata, replay, ack, and confirmed purge with audit rows', async () => {
	consoleInfo.mockImplementation(() => {})
	const t = createHarness()
	expect(
		await t.park(feedbackDlq, [
			{ id: 'msg-fixture-a', body: secretBody, attempts: 4 },
			{ id: 'msg-fixture-b', body: { feedbackId: 'feedback-fixture-2' } },
			{ id: 'msg-fixture-c', body: { feedbackId: 'feedback-fixture-3' } },
		]),
	).toEqual(['msg-fixture-a', 'msg-fixture-b', 'msg-fixture-c'])
	// Redelivery after a lost ack keeps the first parked row.
	await t.park(feedbackDlq, [{ id: 'msg-fixture-a', body: secretBody }])
	await t.park(emailDlq, [{ id: 'msg-fixture-email', body: { kind: 'x' } }])

	const list = await adminDeadLetterQueueListCapability.handler({}, t.ctx)
	expect(list.queues.map((queue) => queue.queue)).toEqual(deadLetterQueueNames)
	expect(
		list.queues.find((queue) => queue.queue === feedbackDlq),
	).toMatchObject({
		source_queue: 'kody-platform-feedback-dispatch',
		depth: 3,
		parked_count: 3,
		oldest_message_at: '2026-01-01T00:00:00.000Z',
		cloudflare: null,
		replay_supported: true,
	})
	expect(list.queues.find((queue) => queue.queue === emailDlq)).toMatchObject({
		depth: 1,
		replay_supported: false,
	})

	const firstPage = await adminDeadLetterQueuePeekCapability.handler(
		{ queue: feedbackDlq, limit: 2 },
		t.ctx,
	)
	expect(firstPage.parked_count).toBe(3)
	expect(firstPage.messages[0]).toMatchObject({
		message_id: 'msg-fixture-a',
		queue: feedbackDlq,
		source_queue: 'kody-platform-feedback-dispatch',
		status: 'parked',
		attempts: 4,
		enqueued_at: '2026-01-01T00:00:00.000Z',
		payload_type: 'object',
		top_level_keys: [
			'feedbackId',
			'kind',
			'message',
			'accessToken',
			'sessionId',
		],
		kind: 'fixture.event',
		stable_ids: { feedbackId: 'feedback-fixture-1' },
		replayable: true,
	})
	expect(JSON.stringify(firstPage)).not.toMatch(
		/user-authored text|fixture-token-value|fixture-session/,
	)
	expect(firstPage.next_cursor).toEqual(expect.any(String))
	const secondPage = await adminDeadLetterQueuePeekCapability.handler(
		{ queue: feedbackDlq, limit: 2, cursor: firstPage.next_cursor ?? '' },
		t.ctx,
	)
	expect(secondPage.messages.map((message) => message.message_id)).toEqual([
		'msg-fixture-c',
	])
	expect(secondPage.next_cursor).toBeNull()

	await expect(
		adminDeadLetterQueueReplayCapability.handler(
			{ queue: feedbackDlq, message_id: 'msg-fixture-a' },
			t.ctx,
		),
	).resolves.toEqual({
		queue: feedbackDlq,
		message_id: 'msg-fixture-a',
		source_queue: 'kody-platform-feedback-dispatch',
		outcome: 'replayed',
	})
	expect(t.send).toHaveBeenCalledWith(secretBody, { contentType: 'json' })

	await expect(
		adminDeadLetterQueueReplayCapability.handler(
			{ queue: emailDlq, message_id: 'msg-fixture-email' },
			t.ctx,
		),
	).rejects.toThrow(/Replay is unsupported for queue=kody-email-delivery-dlq/)

	await expect(
		adminDeadLetterQueueAckCapability.handler(
			{ queue: feedbackDlq, message_id: 'msg-fixture-b' },
			t.ctx,
		),
	).resolves.toEqual({
		queue: feedbackDlq,
		message_id: 'msg-fixture-b',
		outcome: 'acked',
	})
	await expect(
		adminDeadLetterQueueAckCapability.handler(
			{ queue: feedbackDlq, message_id: 'msg-fixture-b' },
			t.ctx,
		),
	).rejects.toThrow('Dead-letter message not found')

	await expect(
		adminDeadLetterQueuePurgeCapability.handler(
			{ queue: feedbackDlq, confirm: emailDlq },
			t.ctx,
		),
	).rejects.toThrow('confirm must equal the queue name exactly')
	await expect(
		adminDeadLetterQueuePurgeCapability.handler(
			{ queue: feedbackDlq, confirm: feedbackDlq },
			t.ctx,
		),
	).resolves.toEqual({
		queue: feedbackDlq,
		purged_count: 1,
		message_ids: ['msg-fixture-c'],
		remaining_count: 0,
		outcome: 'purged',
	})
	const after = await adminDeadLetterQueueListCapability.handler({}, t.ctx)
	expect(after.queues.find((queue) => queue.queue === feedbackDlq)?.depth).toBe(
		0,
	)

	const events = t.auditEvents()
	expect(
		events.map(({ action, result, reason }) => ({ action, result, reason })),
	).toEqual([
		{
			action: 'adminDeadLetterQueueReplay',
			result: 'success',
			reason: `queue=${feedbackDlq};message_id=msg-fixture-a;source_queue=kody-platform-feedback-dispatch;outcome=replayed`,
		},
		{
			action: 'adminDeadLetterQueueReplay',
			result: 'failure',
			reason: expect.stringContaining(
				'Replay is unsupported for queue=kody-email-delivery-dlq;message_id=msg-fixture-email',
			),
		},
		{
			action: 'adminDeadLetterQueueAck',
			result: 'success',
			reason: `queue=${feedbackDlq};message_id=msg-fixture-b;outcome=acked`,
		},
		{
			action: 'adminDeadLetterQueueAck',
			result: 'failure',
			reason: `Dead-letter message not found: queue=${feedbackDlq};message_id=msg-fixture-b.`,
		},
		{
			action: 'adminDeadLetterQueuePurge',
			result: 'failure',
			reason: `Purge not confirmed for queue=${feedbackDlq}: confirm must equal the queue name exactly.`,
		},
		{
			action: 'adminDeadLetterQueuePurge',
			result: 'success',
			reason: `queue=${feedbackDlq};message_id=msg-fixture-c;outcome=purged`,
		},
		{
			action: 'adminDeadLetterQueuePurge',
			result: 'success',
			reason: `queue=${feedbackDlq};purged_count=1;remaining_count=0;outcome=purged`,
		},
	])
	expect(events.every((event) => event.email_hash)).toBe(true)
})

test('a failed replay send keeps the message parked and reports to Sentry', async () => {
	consoleInfo.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	sentry.contexts.length = 0
	const t = createHarness()
	await t.park(feedbackDlq, [
		{ id: 'msg-fixture-send', body: secretBody, attempts: 4 },
	])
	t.send.mockRejectedValueOnce(new Error('queue send failed'))
	await expect(
		adminDeadLetterQueueReplayCapability.handler(
			{ queue: feedbackDlq, message_id: 'msg-fixture-send' },
			t.ctx,
		),
	).rejects.toThrow(
		`Replay send failed for queue=${feedbackDlq};message_id=msg-fixture-send: queue send failed`,
	)
	expect(sentry.contexts.at(-1)).toMatchObject({
		stage: 'replay',
		queue: feedbackDlq,
		messageId: 'msg-fixture-send',
		attempts: 4,
	})
	const peek = await adminDeadLetterQueuePeekCapability.handler(
		{ queue: feedbackDlq, message_id: 'msg-fixture-send' },
		t.ctx,
	)
	expect(peek.messages[0]?.status).toBe('parked')
})

test('scheduled-dispatch DLQ replays through the jobs worker', async () => {
	consoleInfo.mockImplementation(() => {})
	const t = createHarness()
	const body = { lane: 'fixture_lane', scheduledTime: 1, cron: '* * * * *' }
	await t.park('kody-scheduled-dispatch-dlq', [
		{ id: 'msg-fixture-lane', body },
	])
	await adminDeadLetterQueueReplayCapability.handler(
		{ queue: 'kody-scheduled-dispatch-dlq', message_id: 'msg-fixture-lane' },
		t.ctx,
	)
	expect(t.replayScheduledDispatchMessage).toHaveBeenCalledWith({ body })
})

test('non-admins cannot list, peek, replay, ack, or purge dead-letter queues', async () => {
	consoleInfo.mockImplementation(() => {})
	const t = createHarness(['user'])
	await t.park(feedbackDlq, [{ id: 'msg-fixture-guard', body: secretBody }])
	const message = {
		queue: feedbackDlq,
		message_id: 'msg-fixture-guard',
	} as const
	await expect(
		adminDeadLetterQueueListCapability.handler({}, t.ctx),
	).rejects.toThrow(/admin/i)
	await expect(
		adminDeadLetterQueuePeekCapability.handler({ queue: feedbackDlq }, t.ctx),
	).rejects.toThrow(/admin/i)
	await expect(
		adminDeadLetterQueueReplayCapability.handler(message, t.ctx),
	).rejects.toThrow(/admin/i)
	await expect(
		adminDeadLetterQueueAckCapability.handler(message, t.ctx),
	).rejects.toThrow(/admin/i)
	await expect(
		adminDeadLetterQueuePurgeCapability.handler(
			{ queue: feedbackDlq, confirm: feedbackDlq },
			t.ctx,
		),
	).rejects.toThrow(/admin/i)
	expect(t.send).not.toHaveBeenCalled()
	expect(
		t.sqlite
			.prepare('SELECT COUNT(*) AS count FROM dead_letter_messages')
			.get(),
	).toEqual({ count: 1 })
})

test('purge deletes a bounded oldest-first batch and reports what remains', async () => {
	const t = createHarness()
	const queue = 'kody-platform-feedback-dispatch-dlq'
	await t.park(queue, [
		{ id: 'msg-fixture-1', body: { feedbackId: 'feedback-fixture-1' } },
		{ id: 'msg-fixture-2', body: { feedbackId: 'feedback-fixture-2' } },
		{ id: 'msg-fixture-3', body: { feedbackId: 'feedback-fixture-3' } },
	])
	await expect(
		purgeParkedDeadLetterMessages(t.ctx.env.APP_DB, {
			deadLetterQueue: queue,
			limit: 2,
		}),
	).resolves.toEqual({
		messageIds: ['msg-fixture-1', 'msg-fixture-2'],
		remainingCount: 1,
	})
	await expect(
		purgeParkedDeadLetterMessages(t.ctx.env.APP_DB, {
			deadLetterQueue: queue,
			limit: 2,
		}),
	).resolves.toEqual({ messageIds: ['msg-fixture-3'], remainingCount: 0 })
})

import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { shouldDeferSiteAccessToActor } from '#mcp/capabilities/access-control.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import {
	recordSystemEmailSends,
	recordSystemEmailSendDeliveryEvent,
} from '#worker/email/system-email-sends.ts'

const mocks = vi.hoisted(() => ({ sendNewsletterEmail: vi.fn() }))
vi.mock('#worker/email/system-outbound.ts', () => ({
	sendNewsletterEmail: mocks.sendNewsletterEmail,
}))

const {
	adminWhatsNewRecipientListCapability: list,
	adminWhatsNewOptInSetCapability: set,
	adminWhatsNewEmailSendCapability: send,
	adminWhatsNewDeliveryEventListCapability: events,
} = await import('./admin-whats-new.ts')

function setup(roles = ['admin']) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.example.com',
		source: { kind: 'mcp-oauth' },
		user: {
			userId: personIdFromStored(
				testStableUserIdFromEmail('admin@example.com'),
			),
			email: 'admin@example.com',
			username: 'admin',
			displayName: 'Admin',
			roles,
		},
	})
	const ctx = {
		env: { APP_DB: createD1FromSqlite(sqlite) } as Env,
		callerContext,
	}
	function user(
		index: number,
		optIn = 0,
		updatedAt: string | null = null,
		extra: { verified?: boolean; deleted?: boolean; deleting?: boolean } = {},
	) {
		const id = index.toString(16).padStart(64, '0')
		sqlite
			.prepare(
				`INSERT INTO users (stable_user_id, personal_org_id, username, email, password_hash, email_verified_at, deleted_at, deleting_at, whats_new_email_opt_in, whats_new_email_opt_in_updated_at) VALUES (?, ?, ?, ?, 'hash', ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				`org-${index}`,
				`reader${index}`,
				`reader${index}@example.com`,
				extra.verified === false ? null : '2026-11-14',
				extra.deleted ? '2026-11-14' : null,
				extra.deleting ? '2026-11-14' : null,
				optIn,
				updatedAt,
			)
		return id
	}
	return { ctx, user, sqlite }
}

test('newsletter list paginates live verified users and distinguishes never-chosen from unsubscribed', async () => {
	const { ctx, user } = setup()
	const first = user(1, 1, '2026-11-14')
	const second = user(2)
	const third = user(3, 0, '2026-11-14')
	user(4, 1, null, { verified: false })
	user(5, 1, null, { deleted: true })
	user(6, 1, null, { deleting: true })
	const page = await list.handler({ audience: 'all-users', limit: 2 }, ctx)
	expect(page.users.map((row) => row.stable_user_id)).toEqual([first, second])
	expect(page.users.map((row) => [row.opted_in, row.unsubscribed])).toEqual([
		[true, false],
		[false, false],
	])
	expect(page.next_cursor).toBe(second)
	const last = await list.handler(
		{ audience: 'all-users', cursor: page.next_cursor, limit: 2 },
		ctx,
	)
	expect(last.users).toEqual([
		expect.objectContaining({
			stable_user_id: third,
			opted_in: false,
			unsubscribed: true,
		}),
	])
	expect(last.next_cursor).toBeNull()
	expect(
		(await list.handler({ audience: 'opted-in' }, ctx)).users.map(
			(row) => row.stable_user_id,
		),
	).toEqual([first])
	expect(
		await list.handler({ audience: 'all-users', cursor: third }, ctx),
	).toEqual({ users: [], next_cursor: null })
	await expect(
		list.handler({ audience: 'all-users', limit: 501 }, ctx),
	).rejects.toThrow('Invalid input')
	await expect(
		list.handler({ audience: 'all-users', cursor: 'bad' }, ctx),
	).rejects.toThrow('Invalid input')
})

test('newsletter preferences always stamp explicit choices and reject missing or deleted users', async () => {
	const { ctx, user } = setup()
	const id = user(1)
	for (const opted_in of [false, true, false]) {
		const result = await set.handler({ stable_user_id: id, opted_in }, ctx)
		expect(result).toEqual({
			stable_user_id: id,
			opted_in,
			opt_in_updated_at: expect.any(String),
			opt_in_source: 'admin',
		})
		const all = await list.handler({ audience: 'all-users' }, ctx)
		expect(all.users[0]).toMatchObject({
			opted_in,
			opt_in_updated_at: result.opt_in_updated_at,
			opt_in_source: 'admin',
			unsubscribed: !opted_in,
		})
	}
	const deleted = user(2, 0, null, { deleted: true })
	const linked = await set.handler(
		{ stable_user_id: id, opted_in: false, source: 'email_link' },
		ctx,
	)
	expect(linked.opt_in_source).toBe('email_link')
	expect(
		(await list.handler({ audience: 'all-users' }, ctx)).users[0]
			?.opt_in_source,
	).toBe('email_link')
	await expect(
		set.handler({ stable_user_id: id, opted_in: true, source: 'signup' }, ctx),
	).rejects.toThrow('Invalid input')
	const deleting = user(3, 0, null, { deleting: true })
	for (const stable_user_id of [deleted, deleting, 'f'.repeat(64)]) {
		await expect(
			set.handler({ stable_user_id, opted_in: true }, ctx),
		).rejects.toThrow('User not found.')
	}
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminWhatsNewOptInSet',
			result: 'failure',
		}),
	)
})

test('a choice recorded elsewhere first keeps its own time, and a future time is refused', async () => {
	const { ctx, user } = setup()
	const id = user(1)
	const occurred_at = '2026-11-15T20:06:42.050Z'
	const result = await set.handler(
		{ stable_user_id: id, opted_in: true, source: 'email_link', occurred_at },
		ctx,
	)
	expect(result).toMatchObject({
		opted_in: true,
		opt_in_updated_at: occurred_at,
		opt_in_source: 'email_link',
	})
	expect(
		(await list.handler({ audience: 'all-users' }, ctx)).users[0],
	).toMatchObject({
		opted_in: true,
		opt_in_updated_at: occurred_at,
		opt_in_source: 'email_link',
	})
	await expect(
		set.handler(
			{
				stable_user_id: id,
				opted_in: false,
				occurred_at: new Date(Date.now() + 60_000).toISOString(),
			},
			ctx,
		),
	).rejects.toThrow('occurred_at must not be in the future.')
})

test('a choice older than the saved one is not applied', async () => {
	const { ctx, user } = setup()
	const unsubscribedAt = '2026-11-15T21:00:00.000Z'
	const id = user(1, 0, unsubscribedAt)
	const stored = {
		opted_in: false,
		opt_in_updated_at: unsubscribedAt,
	}
	expect(
		await set.handler(
			{
				stable_user_id: id,
				opted_in: true,
				source: 'email_link',
				occurred_at: '2026-11-15T20:06:42.050Z',
			},
			ctx,
		),
	).toMatchObject(stored)
	expect(
		(await list.handler({ audience: 'all-users' }, ctx)).users[0],
	).toMatchObject(stored)
	expect(
		await set.handler(
			{
				stable_user_id: id,
				opted_in: true,
				source: 'email_link',
				occurred_at: '2026-11-15T21:00:01.000Z',
			},
			ctx,
		),
	).toMatchObject({
		opted_in: true,
		opt_in_updated_at: '2026-11-15T21:00:01.000Z',
	})
})

test('newsletter capabilities require a site admin and send exactly one recipient with redacted audit', async () => {
	const { ctx } = setup(['user'])
	for (const capability of [list, set, send, events]) {
		await expect(capability.handler({}, ctx)).rejects.toThrow(
			'lacks required role',
		)
	}
	const admin = setup().ctx
	mocks.sendNewsletterEmail.mockResolvedValue({
		from: 'news@kody.example.com',
		to: ['reader@example.com'],
		providerMessageId: 'message-1',
	})
	const input = {
		to: 'reader@example.com',
		subject: "What's New",
		text: 'Updates',
		headers: { 'List-Unsubscribe': '<https://example.com/unsubscribe>' },
	}
	expect(await send.handler(input, admin)).toMatchObject({
		provider_message_id: 'message-1',
		send_id: JSON.stringify(['message-1', input.to]),
		replayed: false,
	})
	expect(mocks.sendNewsletterEmail).toHaveBeenCalledWith(
		expect.objectContaining(input),
	)
	expect(logAuditEventSpy.mock.calls.at(-1)?.[0]).toMatchObject({
		action: 'adminWhatsNewEmailSend',
		result: 'success',
	})
	expect(logAuditEventSpy.mock.calls.at(-1)?.[0].reason).not.toContain(input.to)
	for (const to of [[], ['reader@example.com'], 'not-an-email']) {
		await expect(send.handler({ ...input, to }, admin)).rejects.toThrow(
			'Invalid input',
		)
	}
	await expect(
		send.handler({ to: input.to, subject: 'Empty' }, admin),
	).rejects.toThrow('Email text or HTML')
	mocks.sendNewsletterEmail.mockResolvedValueOnce({
		from: 'news@kody.example.com',
		to: [input.to],
		providerMessageId: 'message-1',
		replayed: true,
	})
	expect(
		await send.handler({ ...input, idempotency_key: 'campaign:user' }, admin),
	).toMatchObject({ provider_message_id: 'message-1', replayed: true })
	expect(mocks.sendNewsletterEmail.mock.calls.at(-1)?.[0]).toMatchObject({
		idempotencyKey: 'campaign:user',
	})
	expect(mocks.sendNewsletterEmail.mock.calls.at(-1)?.[0]).not.toHaveProperty(
		'idempotency_key',
	)
	expect(logAuditEventSpy.mock.calls.at(-1)?.[0].reason).toContain('replayed')
	mocks.sendNewsletterEmail.mockRejectedValueOnce(new Error('Provider failed'))
	await expect(send.handler(input, admin)).rejects.toThrow('Provider failed')
	mocks.sendNewsletterEmail.mockResolvedValueOnce({
		from: 'news@example.com',
		to: [input.to],
		providerMessageId: null,
	})
	expect(await send.handler(input, admin)).toMatchObject({
		provider_message_id: null,
		send_id: null,
	})
})

test('newsletter delivery listing pages latest matched reports only, with an inclusive since filter', async () => {
	const { ctx } = setup()
	expect(await events.handler({}, ctx)).toEqual({
		events: [],
		next_cursor: null,
	})
	const at = '2026-11-14T01:00:00.000Z'
	for (const [providerMessageId, status, kind] of [
		['a', 'bounced', 'whats_new'],
		['b', 'complained', 'whats_new'],
		['c', 'delivered', 'operator'],
		['d', null, 'whats_new'],
	] as const) {
		await recordSystemEmailSends({
			db: ctx.env.APP_DB,
			providerMessageId,
			recipients: ['reader@example.com'],
			sender: 'news@example.com',
			kind,
		})
		if (status)
			await recordSystemEmailSendDeliveryEvent({
				db: ctx.env.APP_DB,
				providerMessageId,
				recipient: 'reader@example.com',
				deliveryStatus: status,
				eventTimestamp: at,
			})
	}
	const first = await events.handler({ since: at, limit: 1 }, ctx)
	expect(first.events).toEqual([
		{
			provider_message_id: 'a',
			recipient: 'reader@example.com',
			event: 'bounced',
			occurred_at: at,
		},
	])
	expect(first.next_cursor).toEqual(expect.any(String))
	const last = await events.handler(
		{ cursor: first.next_cursor, limit: 1 },
		ctx,
	)
	expect(last.events[0]).toMatchObject({
		provider_message_id: 'b',
		event: 'complained',
	})
	expect(last.next_cursor).toBeNull()
	await recordSystemEmailSendDeliveryEvent({
		db: ctx.env.APP_DB,
		providerMessageId: 'a',
		recipient: 'reader@example.com',
		deliveryStatus: 'delivered',
		eventTimestamp: '2026-11-14T02:00:00.000Z',
	})
	const updated = await events.handler(
		{ since: '2026-11-14T02:00:00.000Z' },
		ctx,
	)
	expect(updated.events).toEqual([
		{
			provider_message_id: 'a',
			recipient: 'reader@example.com',
			event: 'delivered',
			occurred_at: '2026-11-14T02:00:00.000Z',
		},
	])
	expect(
		await events.handler({ since: '2026-11-15T00:00:00.000Z' }, ctx),
	).toEqual({ events: [], next_cursor: null })
	await expect(events.handler({ cursor: 'bad' }, ctx)).rejects.toThrow(
		'Invalid cursor',
	)
	await expect(events.handler({ since: 'yesterday' }, ctx)).rejects.toThrow(
		'Invalid input',
	)
	await expect(events.handler({ limit: 501 }, ctx)).rejects.toThrow(
		'Invalid input',
	)
})

test('package-app runs-as callers without site roles fail closed rather than inheriting publisher admin access', async () => {
	const { ctx } = setup()
	const user = ctx.callerContext.user!
	const callerContext = createMcpCallerContext({
		baseUrl: ctx.callerContext.baseUrl,
		executionOrigin: 'background',
		source: { kind: 'package-app' },
		user: {
			userId: user.userId,
			email: user.email,
			username: user.username,
			displayName: user.displayName,
		},
	})
	expect(shouldDeferSiteAccessToActor(callerContext)).toBe(false)
	await expect(
		list.handler({ audience: 'opted-in' }, { ...ctx, callerContext }),
	).rejects.toThrow('lacks required role "admin"')
})

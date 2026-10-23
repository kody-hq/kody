import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { buildInboundDelivery } from './inbound-delivery.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { type MailboxInboundDeliverySnapshot } from './mailbox-inbound-ledger.ts'

function namespace(stub: object) {
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => stub,
	} as unknown as DurableObjectNamespace
}

function authorityFor(
	userId: string,
	stubs: { mailbox?: object; meter?: object; db?: object } = {},
) {
	return createUserInboundDeliveryAuthority({
		env: {
			APP_DB: (stubs.db ?? {}) as D1Database,
			USER_METER: namespace(stubs.meter ?? {}),
			MAILBOX: namespace(stubs.mailbox ?? {}),
		},
		userId: ownerIdFromStored(userId),
	})
}

const now = new Date('2026-08-02T12:00:00.000Z')

async function createDelivery(userId: string, now: Date) {
	return await buildInboundDelivery({
		userId: ownerIdFromStored(userId),
		inboxId: 'inbox-1',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'From: sender@example.com\r\n\r\nhello',
		quotaDay: '2026-08-02',
		now,
	})
}

test('dedupe claim precedes UserMeter on Mailbox retry', async () => {
	const userId = ownerIdFromStored('user-1')
	const delivery = await createDelivery(userId, now)
	const snapshot: MailboxInboundDeliverySnapshot = {
		...delivery,
		state: 'pending',
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	const order: Array<string> = []
	let consumeCalls = 0
	let insertCalls = 0
	const meter = {
		consumeInboundDelivery: vi.fn(async () => {
			consumeCalls += 1
			order.push(`meter-${consumeCalls}`)
			return {
				outcome: 'ready' as const,
				count: 1,
				revision: consumeCalls,
				mirrorUpdatedAt: now.toISOString(),
				consumed: consumeCalls === 1,
				replayed: consumeCalls > 1,
				day: delivery.quotaDay,
				resource: 'email_receives_per_day' as const,
			}
		}),
	}
	const mailbox = {
		getInboundDelivery: vi.fn(async () => null),
		getInboundDueWorkHint: vi.fn(async () => {
			order.push('mailbox-hint')
			return { dueAt: delivery.dedupeExpiresAt }
		}),
		claimInboundDeliveryWindow: vi.fn(async () => {
			order.push('mailbox-window')
			return snapshot
		}),
		insertChargedPendingInboundDelivery: vi.fn(async () => {
			insertCalls += 1
			order.push(`mailbox-${insertCalls}`)
			if (insertCalls === 1) throw new Error('injected Mailbox insert failure')
			return { status: 'inserted' as const, delivery: snapshot }
		}),
	}
	const run = vi.fn(async () => {
		order.push('d1-hint')
		return { success: true }
	})
	const prepare = vi.fn((_sql: string) => ({
		bind: vi.fn(() => ({ run })),
	}))
	const authority = authorityFor(userId, { mailbox, meter, db: { prepare } })

	await expect(
		authority.charge({ delivery, plan: 'pro', limit: 100, now }),
	).rejects.toThrow('injected Mailbox insert failure')
	await expect(
		authority.charge({ delivery, plan: 'pro', limit: 100, now }),
	).resolves.toEqual({ delivery, charged: true })

	expect(order).toEqual([
		'mailbox-window',
		'meter-1',
		'mailbox-1',
		'mailbox-window',
		'meter-2',
		'mailbox-2',
		'mailbox-hint',
		'd1-hint',
	])
})

test('commitInboundMessageGraph forwards the active storage lease to one owner Mailbox RPC', async () => {
	const userId = ownerIdFromStored('user-2')
	const delivery = {
		...(await createDelivery(userId, now)),
		state: 'storing' as const,
		storageLease: 'lease-1',
	}
	const commitInboundMessageGraph = vi.fn(async () => ({
		status: 'committed' as const,
		message: { id: delivery.messageId },
	}))
	const prepare = vi.fn()
	const authority = authorityFor(userId, {
		mailbox: { commitInboundMessageGraph },
		db: { prepare },
	})
	const thread = { id: delivery.threadId } as never
	const message = { id: delivery.messageId, direction: 'inbound' } as never
	const attachments = [{ id: 'attachment-1' }] as never

	await authority.commitInboundMessageGraph({
		delivery,
		thread,
		message,
		attachments,
	})

	expect(commitInboundMessageGraph).toHaveBeenCalledWith({
		ownerId: userId,
		deliveryId: delivery.deliveryId,
		storageLease: 'lease-1',
		thread,
		message,
		attachments,
	})
	expect(prepare).not.toHaveBeenCalled()
})

test('commitInboundMessageGraph rejects a delivery without an active lease', async () => {
	const userId = ownerIdFromStored('user-3')
	await expect(
		authorityFor(userId).commitInboundMessageGraph({
			delivery: await createDelivery(userId, now),
			thread: {} as never,
			message: {} as never,
			attachments: [],
		}),
	).rejects.toThrow('active storage lease')
})

test('USER authority refuses the dedicated system email owner', () => {
	expect(() => authorityFor(systemEmailOwnerId)).toThrow('must remain in D1')
})

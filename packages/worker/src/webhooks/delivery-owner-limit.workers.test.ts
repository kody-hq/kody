import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { afterEach, expect, test, vi } from 'vitest'
import { getRunRecord } from '#worker/run-records/service.ts'
import {
	type AckWebhookDelivery,
	markAckWebhookDelivery,
	recordWebhookDelivery,
	startAckWebhookDeliveryAttempt,
	webhookAckOwnerStartedLimit,
	webhookAckQueuedHoldMs,
	webhookAckStartedHoldMs,
} from './delivery.ts'

afterEach(() => {
	vi.useRealTimers()
})

function deliveryFor(owner: string, deliveryId: string): AckWebhookDelivery {
	return {
		endpoint: {
			id: `endpoint-${owner}`,
			userId: ownerIdFromStored(owner),
			packageId: 'package-1',
			webhookName: 'github-merge',
		},
		kodyId: 'ship-pr',
		deliveryId,
		payloadBytes: 10,
		receivedAt: new Date().toISOString(),
	}
}

async function deliveryState(delivery: AckWebhookDelivery) {
	const record = await getRunRecord({
		env,
		userId: delivery.endpoint.userId,
		runId: delivery.deliveryId,
	})
	return record?.run.metadata?.['state'] ?? null
}

test('an owner at the started limit cannot start another delivery until one is requeued, and other owners are unaffected', async () => {
	const owner = `owner-limit-${crypto.randomUUID()}`
	const started = Array.from({ length: webhookAckOwnerStartedLimit }, (_, i) =>
		deliveryFor(owner, `started-${i}`),
	)
	for (const delivery of started) {
		expect(await startAckWebhookDeliveryAttempt({ env, delivery })).toBe(true)
	}

	const waiting = deliveryFor(owner, 'waiting')
	await markAckWebhookDelivery({
		env,
		delivery: waiting,
		state: 'accepted',
		holdMs: webhookAckQueuedHoldMs,
	})
	expect(await startAckWebhookDeliveryAttempt({ env, delivery: waiting })).toBe(
		false,
	)
	expect(await deliveryState(waiting)).toBe('accepted')

	// A redelivery of an already started delivery keeps its own slot.
	expect(
		await startAckWebhookDeliveryAttempt({ env, delivery: started[0]! }),
	).toBe(true)

	const otherOwner = deliveryFor(`owner-other-${crypto.randomUUID()}`, 'other')
	expect(
		await startAckWebhookDeliveryAttempt({ env, delivery: otherOwner }),
	).toBe(true)

	await markAckWebhookDelivery({
		env,
		delivery: started[0]!,
		state: 'queued',
		holdMs: webhookAckQueuedHoldMs,
	})
	expect(await startAckWebhookDeliveryAttempt({ env, delivery: waiting })).toBe(
		true,
	)
	expect(await deliveryState(waiting)).toBe('started')
})

test('started deliveries whose consumer was killed stop counting once their hold lapses', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	const owner = `owner-killed-${crypto.randomUUID()}`
	for (let i = 0; i < webhookAckOwnerStartedLimit; i += 1) {
		await startAckWebhookDeliveryAttempt({
			env,
			delivery: deliveryFor(owner, `killed-${i}`),
		})
	}
	const next = deliveryFor(owner, 'next')
	expect(await startAckWebhookDeliveryAttempt({ env, delivery: next })).toBe(
		false,
	)

	vi.setSystemTime(Date.now() + webhookAckStartedHoldMs + 1_000)

	expect(await startAckWebhookDeliveryAttempt({ env, delivery: next })).toBe(
		true,
	)
})

test('accepted deliveries healed to interrupted while they waited take a slot when they finally start', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	const owner = `owner-healed-${crypto.randomUUID()}`
	const waited = Array.from({ length: webhookAckOwnerStartedLimit }, (_, i) =>
		deliveryFor(owner, `waited-${i}`),
	)
	for (const delivery of waited) {
		await markAckWebhookDelivery({
			env,
			delivery,
			state: 'accepted',
			holdMs: webhookAckQueuedHoldMs,
		})
	}

	vi.setSystemTime(Date.now() + webhookAckQueuedHoldMs + 1_000)
	for (const delivery of waited) {
		const record = await getRunRecord({
			env,
			userId: delivery.endpoint.userId,
			runId: delivery.deliveryId,
		})
		expect(record?.run.status).toBe('error')
	}

	for (const delivery of waited) {
		expect(await startAckWebhookDeliveryAttempt({ env, delivery })).toBe(true)
		const record = await getRunRecord({
			env,
			userId: delivery.endpoint.userId,
			runId: delivery.deliveryId,
		})
		expect(record?.run.status).toBe('running')
		expect(record?.run.metadata?.['state']).toBe('started')
	}

	expect(
		await startAckWebhookDeliveryAttempt({
			env,
			delivery: deliveryFor(owner, 'next'),
		}),
	).toBe(false)
})

test('a redelivery of a finished delivery leaves its recorded outcome in place', async () => {
	const delivery = deliveryFor(`owner-finished-${crypto.randomUUID()}`, 'done')
	expect(await startAckWebhookDeliveryAttempt({ env, delivery })).toBe(true)
	await recordWebhookDelivery({
		env,
		endpoint: delivery.endpoint,
		kodyId: delivery.kodyId,
		outcome: 'delivered',
		httpStatus: 200,
		payloadBytes: delivery.payloadBytes,
		invocationId: delivery.deliveryId,
		startedAt: new Date().toISOString(),
		receivedAt: delivery.receivedAt,
		requirePersistence: true,
	})

	expect(await startAckWebhookDeliveryAttempt({ env, delivery })).toBe(true)

	const record = await getRunRecord({
		env,
		userId: delivery.endpoint.userId,
		runId: delivery.deliveryId,
	})
	expect(record?.run.status).toBe('success')
	expect(record?.run.metadata?.['state']).toBe('succeeded')
})

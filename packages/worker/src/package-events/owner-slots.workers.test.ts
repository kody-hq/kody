import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	claimPackageEventSlot,
	releasePackageEventSlot,
} from '#worker/run-records/service.ts'
import { packageEventsOwnerInFlightLimit } from './dispatch-queue.ts'

function claim(owner: string, id: string, ttlMs = 60_000) {
	return claimPackageEventSlot({
		env,
		userId: ownerIdFromStored(owner),
		id,
		limit: packageEventsOwnerInFlightLimit,
		expiresAt: new Date(Date.now() + ttlMs).toISOString(),
	})
}

test('an owner at the package event cap waits for a release or an expiry, and other owners are unaffected', async () => {
	const owner = `event-cap-${crypto.randomUUID()}`
	for (let i = 0; i < packageEventsOwnerInFlightLimit; i++) {
		// The last slot is already expired, as if its consumer was killed.
		const ttlMs = i === packageEventsOwnerInFlightLimit - 1 ? -1 : 60_000
		expect((await claim(owner, `event-${i}`, ttlMs)).claimed).toBe(true)
	}
	// A redelivery of a message that holds a slot keeps it.
	expect((await claim(owner, 'event-0')).claimed).toBe(true)
	// The expired slot is free, and taking it fills the cap again.
	expect((await claim(owner, 'after-expiry')).claimed).toBe(true)
	expect(await claim(owner, 'waiting')).toEqual({
		claimed: false,
		inFlight: packageEventsOwnerInFlightLimit,
	})
	expect(
		(await claim(`event-cap-other-${crypto.randomUUID()}`, 'event-0')).claimed,
	).toBe(true)

	await releasePackageEventSlot({
		env,
		userId: ownerIdFromStored(owner),
		id: 'event-0',
	})
	expect((await claim(owner, 'waiting')).claimed).toBe(true)
})

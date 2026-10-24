import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	CommunityForkClaimLostError,
	CommunityForkInProgressError,
} from './errors.ts'
import {
	acquireCommunityForkClaim,
	getActiveCommunityForkClaim,
	releaseCommunityForkClaim,
	renewCommunityForkClaim,
	withCommunityForkClaim,
} from './fork-claims.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	// Run the real migration so the guard is tested against production DDL.
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

const key = { ownerId: 'org-1', listingId: 'listing-1' }

test('only one of many concurrent claims for the same owner and listing wins', async () => {
	const db = createDb()
	const results = await Promise.all(
		Array.from({ length: 8 }, () => acquireCommunityForkClaim(db, key)),
	)
	expect(results.filter(Boolean)).toHaveLength(1)
	// Other owners and listings are independent.
	expect(
		await acquireCommunityForkClaim(db, { ...key, ownerId: 'org-2' }),
	).toEqual(expect.any(String))
	expect(
		await acquireCommunityForkClaim(db, { ...key, listingId: 'listing-2' }),
	).toEqual(expect.any(String))
})

test('a released claim can be taken again and an expired one is taken over', async () => {
	const db = createDb()
	const now = new Date('2026-10-23T18:00:00.000Z')
	const first = await acquireCommunityForkClaim(db, { ...key, now })
	expect(first).toEqual(expect.any(String))
	expect(await acquireCommunityForkClaim(db, { ...key, now })).toBeNull()
	expect(
		await getActiveCommunityForkClaim(db, {
			ownerIds: ['org-1'],
			listingId: 'listing-1',
			now,
		}),
	).toMatchObject({ claimId: first, startedAt: now.toISOString() })

	// A stale lease (crashed request) does not block forks forever.
	const later = new Date(now.getTime() + 6 * 60_000)
	expect(
		await getActiveCommunityForkClaim(db, {
			ownerIds: ['org-1'],
			listingId: 'listing-1',
			now: later,
		}),
	).toBeNull()
	const takeover = await acquireCommunityForkClaim(db, { ...key, now: later })
	expect(takeover).toEqual(expect.any(String))
	expect(takeover).not.toBe(first)

	// Releasing with the old claim id must not drop the new holder.
	await releaseCommunityForkClaim(db, { ...key, claimId: first! })
	expect(await acquireCommunityForkClaim(db, { ...key, now: later })).toBeNull()
	await releaseCommunityForkClaim(db, { ...key, claimId: takeover! })
	expect(await acquireCommunityForkClaim(db, { ...key, now: later })).toEqual(
		expect.any(String),
	)
})

test('withCommunityForkClaim serializes work and releases the claim even on failure', async () => {
	const db = createDb()
	const order: Array<string> = []
	let finishFirst: () => void = () => {}
	const firstGate = new Promise<void>((resolve) => {
		finishFirst = resolve
	})
	const onWaiting = vi.fn()
	const first = withCommunityForkClaim({ db, ...key }, async () => {
		order.push('first:start')
		await firstGate
		order.push('first:end')
		throw new Error('first failed')
	})
	await vi.waitFor(() => expect(order).toEqual(['first:start']))
	const second = withCommunityForkClaim(
		{ db, ...key, pollMs: 5, waitMs: 5_000, onWaiting },
		async () => {
			order.push('second')
			return 'second-result'
		},
	)
	await vi.waitFor(() => expect(onWaiting).toHaveBeenCalledTimes(1))
	expect(onWaiting).toHaveBeenCalledWith(
		expect.objectContaining({ ownerId: 'org-1', listingId: 'listing-1' }),
	)
	finishFirst()
	await expect(first).rejects.toThrow('first failed')
	await expect(second).resolves.toBe('second-result')
	expect(order).toEqual(['first:start', 'first:end', 'second'])
	expect(
		await getActiveCommunityForkClaim(db, {
			ownerIds: ['org-1'],
			listingId: 'listing-1',
		}),
	).toBeNull()
})

test('withCommunityForkClaim gives up with an in-progress error instead of running twice', async () => {
	const db = createDb()
	await acquireCommunityForkClaim(db, key)
	const work = vi.fn(async () => 'never')
	await expect(
		withCommunityForkClaim({ db, ...key, pollMs: 5, waitMs: 20 }, work),
	).rejects.toBeInstanceOf(CommunityForkInProgressError)
	expect(work).not.toHaveBeenCalled()
})

test('a holder renews its lease so a slow fork is not taken over mid-flight', async () => {
	const db = createDb()
	const now = new Date('2026-10-23T18:00:00.000Z')
	const claimId = await acquireCommunityForkClaim(db, { ...key, now })
	const nearExpiry = new Date(now.getTime() + 4 * 60_000)
	expect(
		await renewCommunityForkClaim(db, {
			...key,
			claimId: claimId!,
			now: nearExpiry,
		}),
	).toBe(true)
	// Past the original lease, but the renewed one still holds.
	const pastOriginal = new Date(now.getTime() + 6 * 60_000)
	expect(
		await acquireCommunityForkClaim(db, { ...key, now: pastOriginal }),
	).toBeNull()
	// A stale holder cannot renew a claim someone else took over.
	expect(
		await renewCommunityForkClaim(db, { ...key, claimId: 'someone-else' }),
	).toBe(false)
})

test('withCommunityForkClaim keeps renewing while work runs', async () => {
	const db = createDb()
	const leases: Array<string> = []
	let finish: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		finish = resolve
	})
	const running = withCommunityForkClaim(
		{ db, ...key, renewMs: 5 },
		async () => {
			await gate
			return 'done'
		},
	)
	await vi.waitFor(async () => {
		const claim = await getActiveCommunityForkClaim(db, {
			ownerIds: ['org-1'],
			listingId: 'listing-1',
		})
		if (claim && !leases.includes(claim.expiresAt)) leases.push(claim.expiresAt)
		expect(leases.length).toBeGreaterThan(1)
	})
	finish()
	await expect(running).resolves.toBe('done')
	expect(
		await getActiveCommunityForkClaim(db, {
			ownerIds: ['org-1'],
			listingId: 'listing-1',
		}),
	).toBeNull()
})

test('withCommunityForkClaim aborts work when the claim is taken over', async () => {
	consoleError.mockImplementation(() => {})
	const db = createDb()
	let reachedAssert = false
	const running = withCommunityForkClaim(
		{ db, ...key, renewMs: 5 },
		async (hold) => {
			const claim = await getActiveCommunityForkClaim(db, {
				ownerIds: ['org-1'],
				listingId: 'listing-1',
			})
			expect(claim?.claimId).toBe(hold.claimId)
			// Simulate a crashed renew window: expire the lease and let another
			// request take over while this holder is still "working".
			const pastLease = new Date(Date.now() + 10 * 60_000)
			const takeover = await acquireCommunityForkClaim(db, {
				...key,
				now: pastLease,
			})
			expect(takeover).toEqual(expect.any(String))
			expect(takeover).not.toBe(hold.claimId)
			reachedAssert = true
			await hold.assertHeld()
			return 'should-not-return'
		},
	)
	await expect(running).rejects.toBeInstanceOf(CommunityForkClaimLostError)
	expect(reachedAssert).toBe(true)
	expect(consoleError).toHaveBeenCalled()
})

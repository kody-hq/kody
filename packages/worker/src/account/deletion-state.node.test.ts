import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
	type UserMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { durableObjectInstanceInactiveCloseMessage } from '#worker/sentry-options.ts'
import { isMcpCallerError } from '#mcp/caller-error.ts'
import {
	accountWriteLeaseHeartbeatMs,
	writeLeaseTtlMs,
} from './write-lease-timing.ts'
import {
	AccountDeletionInProgressError,
	AccountWriteLeaseLostError,
	accountDeletionWritersActive,
	abortAccountDeleting,
	abortAccountDeletingByStableUserId,
	assertAccountWritableDb,
	clearUserMeterDeletionTombstone,
	listActiveAccountWriteLeases,
	markAccountDeleting,
	repairAccountWriteLease,
	withAccountWriteLease,
} from './deletion-state.ts'

const fence = '2099-01-01 00:00:00'
const atMinute = (minute: number) => new Date(Date.UTC(2099, 0, 1, 0, minute))
const repairReason = 'Inspected worker crash and confirmed process termination.'

/**
 * Wraps the in-memory UserMeter so tests can intercept individual RPCs;
 * `wrap` runs once per `namespace.get` (one RPC stub).
 */
function createWrappedMeterEnv(
	wrap: (stub: UserMeterRpc, stubId: number) => Partial<UserMeterRpc>,
) {
	const namespace = createInMemoryUserMeterEnv().env.USER_METER
	let stubCount = 0
	return {
		USER_METER: {
			idFromName: namespace.idFromName.bind(namespace),
			get(id: DurableObjectId) {
				const stub = namespace.get(id) as unknown as UserMeterRpc
				return { ...stub, ...wrap(stub, ++stubCount) }
			},
		},
	} as unknown as UserMeterEnv
}

function failingMeterEnv(methods: Record<string, () => Promise<never>>) {
	return {
		USER_METER: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			get: () => methods,
		},
	} as unknown as UserMeterEnv
}

function createTrackedLeaseDoEnv(
	input: {
		acquireResetCount?: number
		releaseResetCount?: number
		rpcTimeoutMs?: number
	} = {},
) {
	const calls: Array<{ stubId: number; method: string }> = []
	const attempts = { acquireWriteLease: 0, releaseWriteLease: 0 }
	const resets = {
		acquireWriteLease: input.acquireResetCount ?? 0,
		releaseWriteLease: input.releaseResetCount ?? 0,
	}
	const env = createWrappedMeterEnv((stub, stubId) => {
		const createdAt = Date.now()
		const track = (
			method:
				| 'acquireWriteLease'
				| 'assertWriteLeaseHeld'
				| 'releaseWriteLease',
		) => {
			calls.push({ stubId, method })
			if (
				input.rpcTimeoutMs != null &&
				Date.now() - createdAt > input.rpcTimeoutMs
			) {
				throw new Error('Durable Object RPC stub exceeded its timeout.')
			}
			if (method !== 'assertWriteLeaseHeld') {
				attempts[method] += 1
				if (attempts[method] <= resets[method]) {
					throw new Error(durableObjectInstanceInactiveCloseMessage)
				}
			}
		}
		return {
			acquireWriteLease: async (args) => {
				track('acquireWriteLease')
				return stub.acquireWriteLease(args)
			},
			assertWriteLeaseHeld: async (args) => {
				track('assertWriteLeaseHeld')
				return stub.assertWriteLeaseHeld(args)
			},
			releaseWriteLease: async (args) => {
				track('releaseWriteLease')
				return stub.releaseWriteLease(args)
			},
		}
	})
	return { env, calls, attempts }
}

function createLeaseHarness(
	env: UserMeterEnv = createInMemoryUserMeterEnv().env,
) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE,
			personal_org_id TEXT,
			deleting_at TEXT,
			deleted_at TEXT,
			active_write_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT
		);
		INSERT INTO users (id, stable_user_id, personal_org_id) VALUES (1, 'user-a', 'user-a');
		INSERT INTO users (id, stable_user_id, personal_org_id) VALUES (2, 'user-b', 'user-b');
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY NOT NULL,
			slug TEXT NOT NULL UNIQUE,
			deleted_at TEXT,
			deleting_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		INSERT INTO orgs (id, slug, created_at, updated_at)
			VALUES ('team-org-a', 'acme', '2026-01-01', '2026-01-01');
		INSERT INTO orgs (id, slug, created_at, updated_at)
			VALUES ('user-a', 'user-a', '2026-01-01', '2026-01-01');
		CREATE TABLE account_write_lease_repairs (
			id TEXT PRIMARY KEY,
			target_user_id TEXT NOT NULL,
			lease_token TEXT NOT NULL,
			lease_holder TEXT NOT NULL,
			lease_acquired_at TEXT NOT NULL,
			repaired_by_user_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
	`)
	const db = createD1FromSqlite(sqlite)
	return {
		sqlite,
		db,
		env,
		// Getters so RPC stubs are only opened when a test reads the meter.
		get meterA() {
			return userMeterRpc({ env, userId: ownerIdFromStored('user-a') })
		},
		get meterB() {
			return userMeterRpc({ env, userId: ownerIdFromStored('user-b') })
		},
		lease<T>(
			write: () => Promise<T>,
			input: { stableUserId?: OwnerId; holder?: string } = {},
		) {
			return withAccountWriteLease({
				db,
				stableUserId: ownerIdFromStored('user-a'),
				env,
				write,
				...input,
			})
		},
		markDeleting(minute = 0, markEnv = env) {
			return markAccountDeleting({
				db,
				dbUserId: 1,
				now: atMinute(minute),
				env: markEnv,
			})
		},
		d1DeletingAt() {
			return sqlite.prepare(`SELECT deleting_at FROM users WHERE id = 1`).get()
		},
		repairCount() {
			return sqlite
				.prepare(`SELECT COUNT(*) AS count FROM account_write_lease_repairs`)
				.get()
		},
		async countA() {
			const meterA = userMeterRpc({ env, userId: ownerIdFromStored('user-a') })
			return (await meterA.countActiveWriteLeases()).count
		},
		activeHolders(stableUserId = ownerIdFromStored('user-a')) {
			return listActiveAccountWriteLeases(env, stableUserId).then((leases) =>
				leases.map((lease) => lease.holder),
			)
		},
	}
}

type LeaseHarness = ReturnType<typeof createLeaseHarness>

function holdDoWriteLease(h: LeaseHarness, holder: string) {
	let finish: () => void = () => undefined
	const finished = new Promise<void>((resolve) => {
		finish = resolve
	})
	let started: () => void = () => undefined
	const startedPromise = new Promise<void>((resolve) => {
		started = resolve
	})
	const lease = { token: '', acquiredAt: '' }
	const operation = h.lease(
		async () => {
			const [active] = await listActiveAccountWriteLeases(
				h.env,
				ownerIdFromStored('user-a'),
			)
			lease.token = active!.token
			lease.acquiredAt = active!.acquired_at
			started()
			await finished
			return 'lost'
		},
		{ holder },
	)
	return {
		operation,
		started: startedPromise,
		finish: () => finish(),
		get token() {
			return lease.token
		},
		get acquiredAt() {
			return lease.acquiredAt
		},
	}
}

type HeldLease = ReturnType<typeof holdDoWriteLease>

function repairHeld(h: LeaseHarness, held: HeldLease) {
	return repairAccountWriteLease({
		db: h.db,
		stableUserId: ownerIdFromStored('user-a'),
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
		repairedByUserId: 'admin-user',
		reason: repairReason,
		env: h.env,
	})
}

async function prepareRepairWithAuditRow(
	h: LeaseHarness,
	held: HeldLease,
	holder: string,
) {
	const prepared = await h.meterA.prepareWriteLeaseRepair({
		token: held.token,
		expectedAcquiredAt: held.acquiredAt,
	})
	expect(prepared.prepared).toBe(true)
	const repairId = prepared.prepared ? prepared.repairId : 'missing-repair-id'
	h.sqlite
		.prepare(
			`INSERT INTO account_write_lease_repairs (
				id, target_user_id, lease_token, lease_holder,
				lease_acquired_at, repaired_by_user_id, reason, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			repairId,
			'user-a',
			held.token,
			holder,
			held.acquiredAt,
			'admin-user',
			repairReason,
			fence,
		)
	return repairId
}

const isHeld = (h: LeaseHarness, held: HeldLease) =>
	h.meterA.assertWriteLeaseHeld({ token: held.token })

const settle = (promise: Promise<unknown>) =>
	promise.then(
		() => 'resolved' as const,
		(error: unknown) => error,
	)

test('env is required: UserMeter authoritative for acquire/held/release with D1 deleting_at gate', async () => {
	const h = createLeaseHarness()

	await h.lease(
		async () => {
			expect(await h.activeHolders()).toEqual(['test:do-authority'])
			expect(await h.countA()).toBe(1)
		},
		{ holder: 'test:do-authority' },
	)
	expect(await h.activeHolders()).toEqual([])
	expect(await h.countA()).toBe(0)

	const held = holdDoWriteLease(h, 'test:do-repair')
	await held.started
	expect(await h.countA()).toBe(1)

	await expect(h.markDeleting()).resolves.toEqual({
		leaseCount: 1,
		blockingLeases: [
			{ holder: 'test:do-repair', acquiredAt: expect.any(String) },
		],
		created: true,
		deletingAt: fence,
	})
	expect(await h.meterA.readDeletionState()).toEqual({ deletingAt: fence })

	await repairHeld(h, held)
	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
	expect(await h.countA()).toBe(0)
	expect(
		h.sqlite.prepare(`SELECT reason FROM account_write_lease_repairs`).get(),
	).toEqual({ reason: repairReason })

	await expect(h.lease(async () => 'blocked')).rejects.toBeInstanceOf(
		AccountDeletionInProgressError,
	)
	await expect(
		h.lease(async () => 'ok', {
			stableUserId: ownerIdFromStored('user-b'),
			holder: 'test:other-user',
		}),
	).resolves.toBe('ok')
	expect(await h.meterB.readDeletionState()).toEqual({ deletingAt: null })
})

test('nested same-user lease reuses the outer lease, detached work re-acquires, and release is awaited', async () => {
	const h = createLeaseHarness()

	const nested = await h.lease(
		async () => {
			expect(await h.countA()).toBe(1)
			return await h.lease(
				async () => {
					// Still only the outer lease: the nested call must not pay
					// another acquire/release round trip.
					expect(await h.countA()).toBe(1)
					expect(await h.activeHolders()).toEqual(['test:outer'])
					return 'nested-result'
				},
				{ holder: 'test:nested' },
			)
		},
		{ holder: 'test:outer' },
	)
	expect(nested).toBe('nested-result')
	// The outer release is the only release.
	expect(await h.activeHolders()).toEqual([])

	let detached: Promise<void> = Promise.resolve()
	let releaseOuter: () => void = () => undefined
	const outerReleased = new Promise<void>((resolve) => {
		releaseOuter = resolve
	})
	await h.lease(
		async () => {
			// Created inside the lease scope (inheriting the AsyncLocalStorage
			// context) but running only after the outer lease has been released.
			detached = (async () => {
				await outerReleased
				await h.lease(
					async () => {
						expect(await h.activeHolders()).toEqual(['test:detached'])
					},
					{ holder: 'test:detached' },
				)
			})()
		},
		{ holder: 'test:outer' },
	)
	releaseOuter()
	await detached
	expect(await h.countA()).toBe(0)

	// Release is awaited: withAccountWriteLease does not settle until DO release completes.
	let releaseEntered = false
	let openGate: () => void = () => undefined
	const releaseGate = new Promise<void>((resolve) => {
		openGate = resolve
	})
	const gated = createLeaseHarness(
		createWrappedMeterEnv((stub) => ({
			async releaseWriteLease(args) {
				releaseEntered = true
				await releaseGate
				return stub.releaseWriteLease(args)
			},
		})),
	)
	let settled = false
	const awaitedRelease = gated
		.lease(async () => 'ok', { holder: 'test:await-do-release' })
		.then((value) => {
			settled = true
			return value
		})
	await vi.waitFor(
		async () => {
			expect(releaseEntered).toBe(true)
			expect(await gated.countA()).toBe(1)
		},
		{ timeout: 2_000, interval: 1 },
	)
	expect(settled).toBe(false)
	openGate()
	await expect(awaitedRelease).resolves.toBe('ok')
	expect(await gated.countA()).toBe(0)
})

test('nested lease for a different user and sequential siblings each acquire their own lease', async () => {
	const h = createLeaseHarness()

	await h.lease(
		async () => {
			await h.lease(
				async () => {
					expect(await h.countA()).toBe(1)
					expect(await h.meterB.countActiveWriteLeases()).toEqual({
						count: 1,
					})
					expect(await h.activeHolders(ownerIdFromStored('user-b'))).toEqual([
						'test:other-user',
					])
				},
				{
					stableUserId: ownerIdFromStored('user-b'),
					holder: 'test:other-user',
				},
			)
		},
		{ holder: 'test:outer' },
	)
	expect(await h.activeHolders(ownerIdFromStored('user-a'))).toEqual([])
	expect(await h.activeHolders(ownerIdFromStored('user-b'))).toEqual([])

	for (const holder of ['test:first', 'test:second']) {
		await h.lease(
			async () => {
				expect(await h.activeHolders()).toEqual([holder])
			},
			{ holder },
		)
	}
	expect(await h.activeHolders()).toEqual([])
})

test('long write callback does not retain a UserMeter RPC stub', async () => {
	vi.useFakeTimers()
	try {
		vi.setSystemTime(new Date('2099-01-01T00:00:00.000Z'))
		const rpcTimeoutMs = 90_000
		const meter = createTrackedLeaseDoEnv({ rpcTimeoutMs })
		const h = createLeaseHarness(meter.env)

		const operation = h.lease(
			async () => {
				await new Promise((resolve) => setTimeout(resolve, rpcTimeoutMs + 1))
				return 'finished'
			},
			{ holder: 'test:long-write' },
		)
		await vi.runAllTimersAsync()

		await expect(operation).resolves.toBe('finished')
		// Heartbeats open their own stubs in between; none is the acquire stub.
		expect(meter.calls).toEqual([
			{ stubId: 1, method: 'acquireWriteLease' },
			{ stubId: expect.any(Number), method: 'releaseWriteLease' },
		])
		expect(meter.calls[1]?.stubId).not.toBe(1)
	} finally {
		vi.useRealTimers()
	}
})

test('UserMeter instance-inactive acquire and release retry then fail closed', async () => {
	vi.useFakeTimers()
	try {
		const recovered = createTrackedLeaseDoEnv({
			acquireResetCount: 1,
			releaseResetCount: 1,
		})
		let recoveredWrites = 0
		const recoveredOperation = createLeaseHarness(recovered.env).lease(
			async () => {
				recoveredWrites += 1
				return 'recovered'
			},
		)
		await vi.runAllTimersAsync()
		await expect(recoveredOperation).resolves.toBe('recovered')
		expect(recoveredWrites).toBe(1)
		expect(recovered.attempts).toEqual({
			acquireWriteLease: 2,
			releaseWriteLease: 2,
		})

		const inactiveError = expect.objectContaining({
			message: durableObjectInstanceInactiveCloseMessage,
		})
		const acquireUnavailable = createTrackedLeaseDoEnv({
			acquireResetCount: 4,
		})
		let blockedWrites = 0
		const blockedResult = settle(
			createLeaseHarness(acquireUnavailable.env).lease(async () => {
				blockedWrites += 1
			}),
		)
		await vi.runAllTimersAsync()
		expect(await blockedResult).toEqual(inactiveError)
		expect(acquireUnavailable.attempts.acquireWriteLease).toBe(4)
		expect(blockedWrites).toBe(0)

		const releaseUnavailable = createTrackedLeaseDoEnv({
			releaseResetCount: 4,
		})
		const releaseHarness = createLeaseHarness(releaseUnavailable.env)
		let completedWrites = 0
		const releaseFailedResult = settle(
			releaseHarness.lease(async () => {
				completedWrites += 1
			}),
		)
		await vi.runAllTimersAsync()
		expect(await releaseFailedResult).toEqual(inactiveError)
		expect(completedWrites).toBe(1)
		expect(releaseUnavailable.attempts.releaseWriteLease).toBe(4)
		expect(await releaseHarness.countA()).toBe(1)
	} finally {
		vi.useRealTimers()
	}
})

test('USER_METER failures fail closed (missing binding throws)', async () => {
	const h = createLeaseHarness(
		failingMeterEnv({
			async acquireWriteLease() {
				throw new Error('do acquire failed')
			},
			async markDeleting() {
				throw new Error('do mark failed')
			},
		}),
	)

	await expect(h.lease(async () => 'mutated')).rejects.toThrow(
		'do acquire failed',
	)
	await expect(h.markDeleting()).rejects.toThrow('do mark failed')
	expect(h.d1DeletingAt()).toEqual({ deleting_at: null })

	await expect(
		withAccountWriteLease({
			db: h.db,
			stableUserId: ownerIdFromStored('user-a'),
			env: {},
			async write() {
				return 'blocked'
			},
		}),
	).rejects.toThrow('USER_METER Durable Object binding is not configured.')
})

test('held UserMeter lease is exported in deletion state without D1 mirror operations', async () => {
	const h = createLeaseHarness()
	h.db.batch = (async () => {
		throw new Error(
			'D1 batch must not be called in env path after mirror retirement',
		)
	}) as D1Database['batch']
	const mirrorCalls: Array<string> = []
	const originalPrepare = h.db.prepare.bind(h.db)
	h.db.prepare = ((query: string) => {
		if (query.includes('active_write_count')) mirrorCalls.push(query)
		return originalPrepare(query)
	}) as D1Database['prepare']

	const held = holdDoWriteLease(h, 'test:do-no-mirror')
	await held.started
	expect(await h.countA()).toBe(1)
	expect(
		(await h.meterA.exportCounters({ pageSize: 1 })).deletionState,
	).toEqual({
		deletingAt: null,
		activeWriteLeaseCount: 1,
		writeLeases: [{ acquiredAt: held.acquiredAt }],
	})

	held.finish()
	await expect(held.operation).resolves.toBe('lost')
	expect(await h.countA()).toBe(0)
	expect(mirrorCalls).toEqual([])
})

test('DO repair prepare/audit/finalize is idempotent and lease-lost aware', async () => {
	const h = createLeaseHarness()
	const held = holdDoWriteLease(h, 'test:do-repair-protocol')
	await held.started

	const prepare = () =>
		h.meterA.prepareWriteLeaseRepair({
			token: held.token,
			expectedAcquiredAt: held.acquiredAt,
		})
	const prepared = await prepare()
	expect(prepared).toEqual(
		expect.objectContaining({
			prepared: true,
			token: held.token,
			acquiredAt: held.acquiredAt,
		}),
	)
	const repairId = prepared.prepared ? prepared.repairId : 'missing-repair-id'
	expect(await prepare()).toEqual(
		expect.objectContaining({ prepared: true, repairId }),
	)
	expect(await isHeld(h, held)).toEqual({ held: true })
	expect(await h.countA()).toBe(1)

	await expect(repairHeld(h, held)).resolves.toEqual({
		repaired: true,
		repairId,
	})
	expect(await isHeld(h, held)).toEqual({ held: false })
	expect(
		h.sqlite
			.prepare(
				`SELECT id, lease_token, lease_acquired_at FROM account_write_lease_repairs`,
			)
			.get(),
	).toEqual({
		id: repairId,
		lease_token: held.token,
		lease_acquired_at: held.acquiredAt,
	})

	// Idempotent retry returns the same repairId without creating a second audit row.
	await expect(repairHeld(h, held)).resolves.toEqual({
		repaired: true,
		repairId,
	})
	expect(h.repairCount()).toEqual({ count: 1 })

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('DO repair is audit-first: an existing prepared audit row is adopted before finalize', async () => {
	const h = createLeaseHarness()
	const held = holdDoWriteLease(h, 'test:do-repair-mirror')
	await held.started
	const repairId = await prepareRepairWithAuditRow(
		h,
		held,
		'test:do-repair-mirror',
	)
	expect(await isHeld(h, held)).toEqual({ held: true })

	for (let attempt = 0; attempt < 2; attempt += 1) {
		await expect(repairHeld(h, held)).resolves.toEqual({
			repaired: true,
			repairId,
		})
		expect(await isHeld(h, held)).toEqual({ held: false })
		expect(h.repairCount()).toEqual({ count: 1 })
	}

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('lost-finalize retry returns stable repairId and leaves DO released', async () => {
	const h = createLeaseHarness()
	const held = holdDoWriteLease(h, 'test:stale-after-finalize')
	await held.started
	const repairId = await prepareRepairWithAuditRow(
		h,
		held,
		'test:stale-after-finalize',
	)
	// Simulate: finalize completed but the repairAccountWriteLease response was lost.
	await h.meterA.finalizeWriteLeaseRepair({
		token: held.token,
		repairId,
		expectedAcquiredAt: held.acquiredAt,
	})
	expect(await isHeld(h, held)).toEqual({ held: false })

	await expect(repairHeld(h, held)).resolves.toEqual({
		repaired: true,
		repairId,
	})
	expect(h.repairCount()).toEqual({ count: 1 })

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('finalize failure leaves DO held and retry succeeds', async () => {
	let finalizeAttempts = 0
	const h = createLeaseHarness(
		createWrappedMeterEnv((stub) => ({
			async finalizeWriteLeaseRepair(args) {
				finalizeAttempts += 1
				if (finalizeAttempts === 1) {
					throw new Error('simulated finalize transport failure')
				}
				return stub.finalizeWriteLeaseRepair(args)
			},
		})),
	)
	const held = holdDoWriteLease(h, 'test:finalize-fail-closed')
	await held.started

	await expect(repairHeld(h, held)).rejects.toThrow(
		'simulated finalize transport failure',
	)
	expect(await isHeld(h, held)).toEqual({ held: true })

	await expect(repairHeld(h, held)).resolves.toEqual(
		expect.objectContaining({ repaired: true }),
	)
	expect(await isHeld(h, held)).toEqual({ held: false })
	expect(finalizeAttempts).toBe(2)

	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('D1 deleting_at race: gate queries D1 before DO acquire', async () => {
	const h = createLeaseHarness()
	// Pre-mark D1 deleting_at (simulates another worker racing to delete).
	h.sqlite.prepare(`UPDATE users SET deleting_at = ? WHERE id = 1`).run(fence)

	await expect(h.lease(async () => 'should not run')).rejects.toBeInstanceOf(
		AccountDeletionInProgressError,
	)
	// DO was never asked to acquire.
	expect(await h.countA()).toBe(0)
})

test('purge resets lease state but preserves deletingAt tombstone', async () => {
	const h = createLeaseHarness()
	// Hold a lease while the account is still writable (before marking for deletion).
	const held = holdDoWriteLease(h, 'test:pre-purge')
	await held.started
	expect(await h.countA()).toBe(1)

	await h.markDeleting()
	await h.meterA.purge()
	expect(await h.meterA.readDeletionState()).toEqual({ deletingAt: fence })
	expect(await h.countA()).toBe(0)
	// D1 gate still blocks (deleting_at is permanent).
	await expect(h.lease(async () => 'blocked')).rejects.toBeInstanceOf(
		AccountDeletionInProgressError,
	)
	held.finish()
	await expect(held.operation).rejects.toBeInstanceOf(
		AccountWriteLeaseLostError,
	)
})

test('abortAccountDeleting clears the D1 gate and UserMeter tombstone only for the matching fence', async () => {
	const h = createLeaseHarness()
	const expectFence = async (deletingAt: string | null) => {
		expect(h.d1DeletingAt()).toEqual({ deleting_at: deletingAt })
		expect(await h.meterA.readDeletionState()).toEqual({ deletingAt })
	}

	await h.markDeleting()
	await expectFence(fence)

	await abortAccountDeleting({
		db: h.db,
		dbUserId: 1,
		now: atMinute(5),
		env: h.env,
		expectedDeletingAt: '2098-12-31 00:00:00',
	})
	await expectFence(fence)

	await abortAccountDeleting({
		db: h.db,
		dbUserId: 1,
		now: atMinute(1),
		env: h.env,
	})
	await expectFence(null)
	await expect(h.lease(async () => 'ok')).resolves.toBe('ok')

	await h.markDeleting()
	await abortAccountDeletingByStableUserId({
		db: h.db,
		stableUserId: ownerIdFromStored('user-a'),
		now: atMinute(2),
		env: h.env,
	})
	await expectFence(null)

	await expect(
		abortAccountDeletingByStableUserId({
			db: h.db,
			stableUserId: ownerIdFromStored('missing-user'),
			env: h.env,
		}),
	).rejects.toThrow('User not found.')
	await expect(
		clearUserMeterDeletionTombstone({
			env: {},
			stableUserId: ownerIdFromStored('user-a'),
		}),
	).resolves.toEqual({ cleared: false })
})

test('assertAccountWritableDb allows a live team org OwnerId with no users row', async () => {
	const h = createLeaseHarness()
	await expect(
		assertAccountWritableDb(h.db, ownerIdFromStored('team-org-a')),
	).resolves.toBeUndefined()
	await expect(
		assertAccountWritableDb(h.db, ownerIdFromStored('missing-id')),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	h.sqlite
		.prepare(`UPDATE orgs SET deleting_at = ? WHERE id = ?`)
		.run(fence, 'team-org-a')
	await expect(
		assertAccountWritableDb(h.db, ownerIdFromStored('team-org-a')),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
})

test('assertAccountWritableDb rejects a soft-deleted person even when their personal org is live', async () => {
	const h = createLeaseHarness()
	h.sqlite
		.prepare(`UPDATE users SET deleted_at = ? WHERE stable_user_id = ?`)
		.run(fence, 'user-a')
	await expect(
		assertAccountWritableDb(h.db, ownerIdFromStored('user-a')),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
	await expect(h.lease(async () => 'should-not-run')).rejects.toBeInstanceOf(
		AccountDeletionInProgressError,
	)
})

test('assertAccountWritableDb rejects a live person whose personal org is deleting', async () => {
	const h = createLeaseHarness()
	h.sqlite
		.prepare(`UPDATE orgs SET deleting_at = ? WHERE id = ?`)
		.run(fence, 'user-a')
	await expect(
		assertAccountWritableDb(h.db, ownerIdFromStored('user-a')),
	).rejects.toBeInstanceOf(AccountDeletionInProgressError)
})

test('withAccountWriteLease does not clear a leftover meter tombstone for a soft-deleted person', async () => {
	const h = createLeaseHarness()
	h.sqlite
		.prepare(`UPDATE users SET deleted_at = ? WHERE stable_user_id = ?`)
		.run(fence, 'user-a')
	await h.meterA.markDeleting({ deletingAt: '2026-08-31 15:22:12' })
	await expect(h.lease(async () => 'should-not-run')).rejects.toBeInstanceOf(
		AccountDeletionInProgressError,
	)
	expect(await h.meterA.readDeletionState()).toEqual({
		deletingAt: '2026-08-31 15:22:12',
	})
})

test('withAccountWriteLease leases package writes under a team org OwnerId', async () => {
	const h = createLeaseHarness()
	await expect(
		h.lease(async () => 'saved', {
			stableUserId: ownerIdFromStored('team-org-a'),
		}),
	).resolves.toBe('saved')
})

test('withAccountWriteLease drops a leftover team-org meter tombstone when the org is live', async () => {
	const h = createLeaseHarness()
	const meterOrg = userMeterRpc({
		env: h.env,
		userId: ownerIdFromStored('team-org-a'),
	})
	await meterOrg.markDeleting({ deletingAt: '2026-08-31 15:22:12' })
	await expect(
		h.lease(async () => 'saved', {
			stableUserId: ownerIdFromStored('team-org-a'),
		}),
	).resolves.toBe('saved')
	expect(await meterOrg.readDeletionState()).toEqual({ deletingAt: null })
})

test('withAccountWriteLease drops a leftover UserMeter tombstone when D1 is live', async () => {
	const h = createLeaseHarness()
	await h.meterA.markDeleting({ deletingAt: '2026-08-31 15:22:12' })
	expect(await h.meterA.readDeletionState()).toEqual({
		deletingAt: '2026-08-31 15:22:12',
	})

	await expect(h.lease(async () => 'ok')).resolves.toBe('ok')
	expect(await h.meterA.readDeletionState()).toEqual({ deletingAt: null })
})

test('withAccountWriteLease restores the meter tombstone when deletion starts during leftover heal', async () => {
	const deletingAt = '2026-08-31 16:04:00'
	let sqlite: DatabaseSync | null = null
	const h = createLeaseHarness(
		createWrappedMeterEnv((stub) => ({
			async clearDeleting(args) {
				sqlite!
					.prepare(`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`)
					.run(deletingAt, 'user-a')
				return stub.clearDeleting(args)
			},
		})),
	)
	sqlite = h.sqlite
	await h.meterA.markDeleting({ deletingAt: '2026-08-31 15:22:12' })

	await expect(h.lease(async () => 'ok')).rejects.toBeInstanceOf(
		AccountDeletionInProgressError,
	)
	expect(h.d1DeletingAt()).toEqual({ deleting_at: deletingAt })
	expect(await h.meterA.readDeletionState()).toEqual({ deletingAt })
})

test('markAccountDeleting does not roll back a fence another attempt owns', async () => {
	const h = createLeaseHarness()
	await h.markDeleting()

	await expect(
		h.markDeleting(
			5,
			failingMeterEnv({
				async markDeleting() {
					throw new Error('do mark failed')
				},
			}),
		),
	).rejects.toThrow('do mark failed')
	expect(h.d1DeletingAt()).toEqual({ deleting_at: fence })
	expect(await h.meterA.readDeletionState()).toEqual({ deletingAt: fence })
})

test('a running write keeps renewing its lease, so deletion stays refused past the TTL', async () => {
	vi.useFakeTimers()
	try {
		const h = createLeaseHarness()
		const held = holdDoWriteLease(h, 'packageSave')
		await held.started

		await vi.advanceTimersByTimeAsync(
			writeLeaseTtlMs + accountWriteLeaseHeartbeatMs,
		)

		const marked = await h.markDeleting()
		expect(marked.leaseCount).toBe(1)
		expect(marked.blockingLeases.map((lease) => lease.holder)).toEqual([
			'packageSave',
		])
		await abortAccountDeleting({
			db: h.db,
			dbUserId: 1,
			env: h.env,
			expectedDeletingAt: marked.deletingAt,
		})
		held.finish()
		await expect(held.operation).resolves.toBe('lost')
	} finally {
		vi.useRealTimers()
	}
})

test('a writer that stops renewing stops blocking deletion after the TTL and then loses its lease', async () => {
	vi.useFakeTimers()
	try {
		// The heartbeat never lands, as when the isolate holding the lease is killed.
		const env = createWrappedMeterEnv(() => ({
			renewWriteLease: async () => {
				throw new Error('writer is gone')
			},
		}))
		const h = createLeaseHarness(env)
		const held = holdDoWriteLease(h, 'packagePublish')
		await held.started

		await vi.advanceTimersByTimeAsync(writeLeaseTtlMs - 1_000)
		expect((await h.markDeleting()).leaseCount).toBe(1)

		await vi.advanceTimersByTimeAsync(2_000)
		const marked = await h.markDeleting(1)
		expect(marked.leaseCount).toBe(0)
		expect(marked.blockingLeases).toEqual([])

		held.finish()
		await expect(held.operation).rejects.toBeInstanceOf(
			AccountWriteLeaseLostError,
		)
	} finally {
		vi.useRealTimers()
	}
})

test('the heartbeat stops once the write finishes', async () => {
	vi.useFakeTimers()
	try {
		let renewals = 0
		const env = createWrappedMeterEnv((stub) => ({
			renewWriteLease: async (args) => {
				renewals += 1
				return stub.renewWriteLease(args)
			},
		}))
		const h = createLeaseHarness(env)
		const held = holdDoWriteLease(h, 'packageSave')
		await held.started
		await vi.advanceTimersByTimeAsync(accountWriteLeaseHeartbeatMs * 2)
		expect(renewals).toBe(2)

		held.finish()
		await held.operation
		await vi.advanceTimersByTimeAsync(accountWriteLeaseHeartbeatMs * 3)
		expect(renewals).toBe(2)
	} finally {
		vi.useRealTimers()
	}
})

test('a deletion refused by active writes names the holders and is a caller conflict', () => {
	const nowMs = Date.UTC(2099, 0, 1, 0, 1, 0)
	const error = accountDeletionWritersActive(
		{
			leaseCount: 3,
			blockingLeases: [
				{ holder: 'packagePublish', acquiredAt: '2099-01-01 00:00:48' },
				{ holder: 'packageSave', acquiredAt: '2099-01-01T00:00:55.000Z' },
			],
		},
		nowMs,
	)
	expect(error.message).toBe(
		'Deletion is waiting for 3 write(s) on this account to finish. Held by: packagePublish (started 12s ago), packageSave (started 5s ago), and 1 more. The delete did not finish. Retry in a few seconds; a write that stopped without finishing stops blocking within 2 minutes.',
	)
	expect(isMcpCallerError(error)).toBe(true)
})

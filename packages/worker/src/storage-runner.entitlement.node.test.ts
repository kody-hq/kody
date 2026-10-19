import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import {
	storageEstimateReadRetryDelaysMs,
	storageEstimateReadTimeoutMs,
} from '#worker/storage-runner.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'
import type * as StorageBucketsService from '#worker/storage-buckets/service.ts'

const totalRetryDelayMs = storageEstimateReadRetryDelaysMs.reduce(
	(total, delay) => total + delay,
	0,
)
const maxEstimateReadAttempts = storageEstimateReadRetryDelaysMs.length + 1

const mockModule = vi.hoisted(() => ({
	listUserStorageBucketEstimates:
		vi.fn<typeof StorageBucketsService.listUserStorageBucketEstimates>(),
	readStorageBytesFromUserMeter: vi.fn<
		typeof EntitlementsService.readStorageBytesFromUserMeter
	>(async () => 0),
	registerStorageBucket: vi.fn(),
	recordStorageBucketEstimate: vi.fn(),
	maybeRefreshStorageBucketEstimate: vi.fn(),
}))

vi.mock('#worker/storage-buckets/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StorageBucketsService>()
	return {
		...actual,
		listUserStorageBucketEstimates: (
			...args: Parameters<
				typeof StorageBucketsService.listUserStorageBucketEstimates
			>
		) => mockModule.listUserStorageBucketEstimates(...args),
		registerStorageBucket: (...args: Array<unknown>) =>
			mockModule.registerStorageBucket(...args),
		recordStorageBucketEstimate: (...args: Array<unknown>) =>
			mockModule.recordStorageBucketEstimate(...args),
		maybeRefreshStorageBucketEstimate: (...args: Array<unknown>) =>
			mockModule.maybeRefreshStorageBucketEstimate(...args),
		flushStorageBucketRegistrationsForTests: async () => undefined,
		clearStorageBucketRegistrationDedupeForTests: () => undefined,
		listPlatformStorageBuckets: async () => [],
	}
})

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementsService>()
	return {
		...actual,
		readStorageBytesFromUserMeter: (
			...args: Parameters<
				typeof EntitlementsService.readStorageBytesFromUserMeter
			>
		) => mockModule.readStorageBytesFromUserMeter(...args),
	}
})

const { assertStorageRunnerWriteWithinEntitlement } =
	await import('#worker/storage-runner.ts')

function createEstimateEnv(
	getEstimatedBytes: (storageId: string) => Promise<{ estimatedBytes: number }>,
) {
	return {
		APP_DB: {
			prepare() {
				throw new Error('APP_DB should not be queried when email is absent')
			},
		},
		STORAGE_RUNNER: {
			idFromName: (name: string) => name,
			get: (name: string) => {
				const parts = JSON.parse(name) as [string, string]
				const storageId = parts[1]
				return {
					getEstimatedBytes: () => getEstimatedBytes(storageId),
				}
			},
		},
	} as unknown as Env
}

function assertWrite(
	getEstimatedBytes: (storageId: string) => Promise<{ estimatedBytes: number }>,
	storageId: string,
) {
	return assertStorageRunnerWriteWithinEntitlement({
		env: createEstimateEnv(getEstimatedBytes),
		userId: ownerIdFromStored('user-1'),
		email: null,
		storageId,
		requested: 1,
	})
}

function unestimatedBuckets(...storageIds: Array<string>) {
	return storageIds.map((storageId) => ({
		storageId,
		kind: 'unknown' as const,
		estimatedBytes: null,
	}))
}

function fakeTimers() {
	vi.useFakeTimers()
	return {
		[Symbol.dispose]: () => {
			vi.useRealTimers()
		},
	}
}

const unreadableMessage = (storageId: string) =>
	`Unable to verify the storage byte entitlement because the bucket estimate for storageId "${storageId}" could not be read after ${maxEstimateReadAttempts} attempts.`

test('assertStorageRunnerWriteWithinEntitlement retries estimate reads with backoff, fails closed, and waits for peers', async () => {
	mockModule.listUserStorageBucketEstimates.mockResolvedValue(
		unestimatedBuckets('bucket-a'),
	)
	const retryOnce = vi
		.fn()
		.mockRejectedValueOnce(new Error('transient DO read failure'))
		.mockResolvedValueOnce({ estimatedBytes: 32 })
	{
		using _timers = fakeTimers()
		const assertion = assertWrite(() => retryOnce(), 'bucket-a')
		await vi.advanceTimersByTimeAsync(storageEstimateReadRetryDelaysMs[0])
		await expect(assertion).resolves.toBeUndefined()
		expect(retryOnce).toHaveBeenCalledTimes(2)
	}

	// The fail-closed error surfaces only after the whole retry policy is
	// exhausted (production showed a single retry losing to transient
	// per-bucket DO estimate-read failures).
	const persistentFailure = vi
		.fn()
		.mockRejectedValue(new Error('persistent DO read failure'))
	{
		using _timers = fakeTimers()
		const assertion = assertWrite(() => persistentFailure(), 'bucket-a')
		// Attach before advancing timers so the rejection is not unhandled.
		// oxlint-disable-next-line vitest/valid-expect
		const expectation = expect(assertion).rejects.toThrow(
			unreadableMessage('bucket-a'),
		)
		await vi.advanceTimersByTimeAsync(totalRetryDelayMs)
		await expectation
		expect(persistentFailure).toHaveBeenCalledTimes(maxEstimateReadAttempts)
	}

	const chunkStorageIds = ['fast-fail', 'slow-ok'] as const
	mockModule.listUserStorageBucketEstimates.mockResolvedValue(
		unestimatedBuckets(...chunkStorageIds),
	)

	let inFlight = 0
	let maxInFlight = 0
	let resolveSlow: (() => void) | undefined
	const slowPending = new Promise<void>((resolve) => {
		resolveSlow = resolve
	})
	const callCounts = new Map<string, number>()

	const getEstimatedBytes = async (storageId: string) => {
		inFlight += 1
		maxInFlight = Math.max(maxInFlight, inFlight)
		const callCount = (callCounts.get(storageId) ?? 0) + 1
		callCounts.set(storageId, callCount)
		try {
			if (storageId === 'fast-fail') {
				if (callCount === 1) {
					// Yield so the peer read is in-flight before this rejects;
					// a sync throw would never overlap and miss the fan-out bug.
					await Promise.resolve()
					throw new Error('fast fail on first attempt')
				}
				return { estimatedBytes: 8 }
			}
			if (storageId === 'slow-ok') {
				if (callCount === 1) {
					await slowPending
				}
				return { estimatedBytes: 16 }
			}
			throw new Error(`Unexpected storageId: ${storageId}`)
		} finally {
			inFlight -= 1
		}
	}

	const peerAssertion = assertWrite(getEstimatedBytes, 'fast-fail')

	await vi.waitFor(() => {
		expect(callCounts.get('fast-fail')).toBe(1)
		expect(callCounts.get('slow-ok')).toBe(1)
	})
	expect(maxInFlight).toBe(chunkStorageIds.length)

	// Even after the retry delay elapses, the failed read must not retry while
	// its slow first-attempt peer is still in flight (allSettled must win).
	await new Promise<void>((resolve) => {
		setTimeout(resolve, storageEstimateReadRetryDelaysMs[0] + 50)
	})
	expect(callCounts.get('fast-fail')).toBe(1)
	expect(callCounts.get('slow-ok')).toBe(1)

	resolveSlow?.()
	await expect(peerAssertion).resolves.toBeUndefined()

	expect(callCounts.get('fast-fail')).toBe(2)
	expect(callCounts.get('slow-ok')).toBe(1)
	expect(maxInFlight).toBe(chunkStorageIds.length)

	// A late success after the per-attempt timeout must reuse the in-flight
	// RPC. Opening a second stub call queues behind the abandoned one on the
	// single-threaded DO and is how a 2.5s wake becomes four stacked timeouts.
	// Fulfill during the first backoff (timeout + 50ms < 150ms) is the
	// CodeRabbit case: dropping a fulfilled promise from the map would start
	// a second RPC.
	mockModule.listUserStorageBucketEstimates.mockResolvedValue(
		unestimatedBuckets('slow-wake'),
	)
	let slowWakeCalls = 0
	const slowWake = () => {
		slowWakeCalls += 1
		return new Promise<{ estimatedBytes: number }>((resolve) => {
			setTimeout(() => {
				resolve({ estimatedBytes: 48 })
			}, storageEstimateReadTimeoutMs + 50)
		})
	}
	{
		using _timers = fakeTimers()
		const assertion = assertWrite(() => slowWake(), 'slow-wake')
		await vi.advanceTimersByTimeAsync(
			storageEstimateReadTimeoutMs + storageEstimateReadRetryDelaysMs[0],
		)
		await expect(assertion).resolves.toBeUndefined()
		expect(slowWakeCalls).toBe(1)
	}

	let hungCalls = 0
	{
		using _timers = fakeTimers()
		const assertion = assertWrite(() => {
			hungCalls += 1
			return new Promise<{ estimatedBytes: number }>(() => {})
		}, 'slow-wake')
		// Attach before advancing timers so the rejection is not unhandled.
		// oxlint-disable-next-line vitest/valid-expect
		const expectation = expect(assertion).rejects.toThrow(
			unreadableMessage('slow-wake'),
		)
		await vi.advanceTimersByTimeAsync(
			totalRetryDelayMs +
				storageEstimateReadTimeoutMs * maxEstimateReadAttempts,
		)
		await expectation
		expect(hungCalls).toBe(1)
	}
})

// Regression for the 2026-07-30 production incidents: a tiny first write of a
// run-ledger value was blocked by "Unable to verify the storage byte
// entitlement because the bucket estimate for storageId 'package:…' could not
// be read after 2 attempts" — a transient estimate-read failure on a PEER
// bucket in a large inventory, different bucket each time. Once a peer's
// estimate is stored in D1, its Durable Object must never be probed (let
// alone block) another bucket's write.
test('peer estimates stay out of the live probe path while D1 + target compose the baseline', async () => {
	const peerStorageIds = Array.from(
		{ length: 40 },
		(_value, index) => `package:peer-${String(index)}`,
	)
	mockModule.listUserStorageBucketEstimates.mockResolvedValue([
		...peerStorageIds.map((storageId) => ({
			storageId,
			kind: 'package' as const,
			estimatedBytes: 64,
		})),
		{ storageId: 'package:target', kind: 'package', estimatedBytes: 128 },
	])
	const probedStorageIds: Array<string> = []
	const getEstimatedBytes = async (storageId: string) => {
		probedStorageIds.push(storageId)
		if (storageId !== 'package:target') {
			throw new Error('peer DO estimate reads are permanently failing')
		}
		return { estimatedBytes: 256 }
	}

	await expect(
		assertWrite(getEstimatedBytes, 'package:target'),
	).resolves.toBeUndefined()

	// Only the write target was measured live; no peer fan-out happened.
	expect(probedStorageIds).toEqual(['package:target'])

	const userId = ownerIdFromStored('user-1')
	const limit = planLimits.free.maxStorageBytes
	mockModule.readStorageBytesFromUserMeter.mockImplementation(
		async (input: { userId: string }) => {
			expect(input.userId).toBe(userId)
			return limit - 100
		},
	)
	mockModule.listUserStorageBucketEstimates.mockResolvedValue([
		{ storageId: 'package:peer', kind: 'package', estimatedBytes: 50 },
		{ storageId: 'package:target', kind: 'package', estimatedBytes: 200 },
	])
	probedStorageIds.length = 0
	const composeEstimate = async (storageId: string) => {
		probedStorageIds.push(storageId)
		return { estimatedBytes: storageId === 'package:target' ? 60 : 50 }
	}

	const denied = await assertWrite(composeEstimate, 'package:target').then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(isEntitlementLimitError(denied)).toBe(true)
	expect(denied).toMatchObject({
		details: {
			resource: 'storage_bytes',
			current: limit - 100 + 50 + 60,
			limit,
		},
	})
	expect((denied as Error).message).toContain(
		'Inventoried buckets: 2 package storage',
	)
	expect(probedStorageIds).toEqual(['package:target'])
	expect(mockModule.readStorageBytesFromUserMeter).toHaveBeenCalledWith(
		expect.objectContaining({
			userId,
			db: expect.anything(),
		}),
	)
})

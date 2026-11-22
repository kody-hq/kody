import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
	BudgetLimitError,
	ComputeOverageLimitError,
	isBudgetLimitError,
	isComputeOverageLimitError,
} from '#worker/entitlements/errors.ts'
import {
	asyncCheckIntervalMs,
	gatePackageAppUsage,
	packageAppUsageBreakerCooldownMs,
} from './package-app-usage-breaker.ts'

const ownerId = ownerIdFromStored('org-1')
const start = 1_800_000_000_000

function computeDenial(current = 412) {
	return new ComputeOverageLimitError({
		resource: 'unique_worker_days',
		plan: 'pro',
		limit: 350,
		current,
		creditsStatus: 'add_credits',
	})
}

function budgetDenial() {
	return new BudgetLimitError({
		kind: 'user',
		orgSlug: 'acme',
		actorUsername: 'member',
		spentMicroUsd: 5_000_000,
		budgetMicroUsd: 5_000_000,
	})
}

function setup(options: { limitPercent?: number | string } = {}) {
	const store = new Map<string, string>()
	const kvOps: Array<string> = []
	let failReads = false
	const kv = {
		async get(key: string, type: 'json') {
			kvOps.push(`get ${key}`)
			if (failReads) throw new Error('KV unavailable')
			expect(type).toBe('json')
			const raw = store.get(key)
			return raw === undefined ? null : (JSON.parse(raw) as unknown)
		},
		async put(key: string, value: string) {
			kvOps.push(`put ${key}`)
			store.set(key, value)
		},
		async delete(key: string) {
			kvOps.push(`delete ${key}`)
			store.delete(key)
		},
	}
	const env = {
		BUNDLE_ARTIFACTS_KV: kv,
		PACKAGE_APP_USAGE_BREAKER_LIMIT_PERCENT: options.limitPercent,
	} as unknown as Env
	const deferred: Array<Promise<unknown>> = []
	const check = vi.fn<() => Promise<void>>(async () => {})
	return {
		store,
		kvOps,
		check,
		failKvReads() {
			failReads = true
		},
		gate(input: { now: number; actorId?: string | null }) {
			return gatePackageAppUsage({
				env,
				ownerId,
				actorId: input.actorId === undefined ? 'person-1' : input.actorId,
				check,
				waitUntil: (promise) => deferred.push(promise),
				now: input.now,
			})
		},
		async flush() {
			await Promise.all(deferred.splice(0))
		},
	}
}

beforeEach(() => {
	resetIsolateState()
})

afterEach(() => {
	vi.restoreAllMocks()
})

test('closed: serves before the usage check runs, then checks after the response', async () => {
	const t = setup()
	let releaseCheck = () => {}
	t.check.mockImplementation(
		() => new Promise<void>((resolve) => (releaseCheck = resolve)),
	)

	await expect(t.gate({ now: start })).resolves.toBeUndefined()
	expect(t.check).toHaveBeenCalledTimes(1)
	releaseCheck()
	await t.flush()
	expect(t.store.size).toBe(0)
	expect(t.kvOps).toEqual(['get package-app-usage-breaker:v1:org-1:person-1'])
})

test('closed: one async check per visitor per interval in an isolate', async () => {
	const t = setup()
	await t.gate({ now: start })
	await t.gate({ now: start + 1_000 })
	await t.gate({ now: start + 1_000, actorId: 'person-2' })
	await t.flush()
	expect(t.check).toHaveBeenCalledTimes(2)

	await t.gate({ now: start + asyncCheckIntervalMs })
	await t.flush()
	expect(t.check).toHaveBeenCalledTimes(3)
})

test('a denial after the response opens the breaker; later requests fail fast with the stored denial', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(computeDenial())

	await expect(t.gate({ now: start })).resolves.toBeUndefined()
	await t.flush()
	const stored = JSON.parse(
		t.store.get('package-app-usage-breaker:v1:org-1:person-1') ?? 'null',
	) as { retryAt: number; denial: { kind: string } }
	expect(stored.retryAt).toBe(start + packageAppUsageBreakerCooldownMs)
	expect(stored.denial.kind).toBe('compute')

	t.check.mockClear()
	const refused = await t
		.gate({ now: start + 1_000 })
		.catch((error: unknown) => error)
	expect(isComputeOverageLimitError(refused)).toBe(true)
	expect((refused as ComputeOverageLimitError).details).toMatchObject({
		limit: 350,
		current: 412,
	})
	expect(t.check).not.toHaveBeenCalled()
})

test('open: another isolate reads the KV deny entry and refuses without running the check', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(budgetDenial())
	await t.gate({ now: start })
	await t.flush()

	resetIsolateState()
	t.check.mockClear()
	const refused = await t
		.gate({ now: start + 5_000 })
		.catch((error: unknown) => error)
	expect(isBudgetLimitError(refused)).toBe(true)
	expect((refused as BudgetLimitError).details.orgSlug).toBe('acme')
	expect(t.check).not.toHaveBeenCalled()
})

test('half-open: after the cooldown one probe runs first; passing closes the breaker', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(computeDenial())
	await t.gate({ now: start })
	await t.flush()
	t.check.mockClear()

	const afterCooldown = start + packageAppUsageBreakerCooldownMs
	await expect(t.gate({ now: afterCooldown })).resolves.toBeUndefined()
	expect(t.check).toHaveBeenCalledTimes(1)
	expect(t.store.size).toBe(0)
	expect(t.kvOps.at(-1)).toBe(
		'delete package-app-usage-breaker:v1:org-1:person-1',
	)
})

test('half-open: a failing probe refuses and re-opens in this isolate without a KV write', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValue(computeDenial())
	await t.gate({ now: start })
	await t.flush()
	const storedBefore = t.store.get(
		'package-app-usage-breaker:v1:org-1:person-1',
	)
	const putsBefore = t.kvOps.filter((op) => op.startsWith('put')).length

	const afterCooldown = start + packageAppUsageBreakerCooldownMs
	const refused = await t
		.gate({ now: afterCooldown })
		.catch((error: unknown) => error)
	expect(isComputeOverageLimitError(refused)).toBe(true)
	expect(t.check).toHaveBeenCalledTimes(2)

	// Refused locally for another cooldown with no further checks or writes.
	const later = afterCooldown + packageAppUsageBreakerCooldownMs - 1
	await expect(t.gate({ now: later })).rejects.toSatisfy(
		isComputeOverageLimitError,
	)
	expect(t.check).toHaveBeenCalledTimes(2)
	expect(t.store.get('package-app-usage-breaker:v1:org-1:person-1')).toBe(
		storedBefore,
	)
	expect(t.kvOps.filter((op) => op.startsWith('put'))).toHaveLength(putsBefore)
})

test('a top-up resumes serving within one cooldown: the probe passes and closes', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(computeDenial())
	await t.gate({ now: start })
	await t.flush()
	await expect(t.gate({ now: start + 1_000 })).rejects.toSatisfy(
		isComputeOverageLimitError,
	)

	// The wallet is funded: the check passes from now on.
	await expect(
		t.gate({ now: start + packageAppUsageBreakerCooldownMs }),
	).resolves.toBeUndefined()
	expect(packageAppUsageBreakerCooldownMs).toBeLessThanOrEqual(10_000)
})

test('a KV read that started before the breaker opened does not erase the open state', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	let releaseRead = () => {}
	const slowRead = new Promise<void>((resolve) => (releaseRead = resolve))
	let reads = 0
	let stored: string | null = null
	const env = {
		BUNDLE_ARTIFACTS_KV: {
			async get() {
				reads += 1
				const snapshot = stored
				if (reads === 2) await slowRead
				return snapshot === null ? null : (JSON.parse(snapshot) as unknown)
			},
			async put(_key: string, value: string) {
				stored = value
			},
			async delete() {
				stored = null
			},
		},
	} as unknown as Env
	const deferred: Array<Promise<unknown>> = []
	const gate = (now: number) =>
		gatePackageAppUsage({
			env,
			ownerId,
			actorId: 'person-1',
			check: t.check,
			waitUntil: (promise) => deferred.push(promise),
			now,
		})

	// The first request reads null and its deferred check denies. A second
	// request misses the isolate cache and its KV read stalls until after the
	// breaker has opened.
	t.check.mockRejectedValueOnce(computeDenial())
	await gate(start)
	const stalled = gate(start + 6_000)
	await Promise.all(deferred.splice(0))
	releaseRead()
	await expect(stalled).rejects.toSatisfy(isComputeOverageLimitError)

	await expect(gate(start + 6_001)).rejects.toSatisfy(
		isComputeOverageLimitError,
	)
})

test('a KV read that overlaps a successful probe does not resurrect the closed breaker', async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {})
	let releaseRead = () => {}
	const slowRead = new Promise<void>((resolve) => (releaseRead = resolve))
	let reads = 0
	let stored: string | null = null
	const env = {
		BUNDLE_ARTIFACTS_KV: {
			async get() {
				reads += 1
				const snapshot = stored
				if (reads === 2) await slowRead
				return snapshot === null ? null : (JSON.parse(snapshot) as unknown)
			},
			async put(_key: string, value: string) {
				stored = value
			},
			async delete() {
				stored = null
			},
		},
	} as unknown as Env
	const check = vi.fn<() => Promise<void>>()
	const deferred: Array<Promise<unknown>> = []
	const gate = (now: number) =>
		gatePackageAppUsage({
			env,
			ownerId,
			actorId: 'person-1',
			check,
			waitUntil: (promise) => deferred.push(promise),
			now,
		})

	check.mockRejectedValueOnce(computeDenial())
	await gate(start)
	await Promise.all(deferred.splice(0))
	expect(stored).not.toBeNull()

	// In a fresh isolate after the cooldown, one request's KV read stalls
	// holding the open entry while another request's probe passes and closes.
	resetIsolateState()
	const afterCooldown = start + packageAppUsageBreakerCooldownMs
	const stalled = gate(afterCooldown)
	check.mockResolvedValueOnce(undefined)
	await expect(gate(afterCooldown)).resolves.toBeUndefined()
	expect(stored).toBeNull()

	// Usage denies again, but the stalled request must see the close and
	// serve on the closed path rather than probe with the stale entry.
	check.mockRejectedValue(computeDenial())
	releaseRead()
	await expect(stalled).resolves.toBeUndefined()
})

test('half-open: only one probe at a time; concurrent requests are refused', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(computeDenial())
	await t.gate({ now: start })
	await t.flush()

	let releaseProbe = () => {}
	t.check.mockImplementationOnce(
		() => new Promise<void>((resolve) => (releaseProbe = resolve)),
	)
	const afterCooldown = start + packageAppUsageBreakerCooldownMs
	const probe = t.gate({ now: afterCooldown })
	await vi.waitFor(() => expect(t.check).toHaveBeenCalledTimes(2))
	const concurrent = await t
		.gate({ now: afterCooldown })
		.catch((error: unknown) => error)
	expect(isComputeOverageLimitError(concurrent)).toBe(true)
	releaseProbe()
	await expect(probe).resolves.toBeUndefined()
})

test('the breaker is scoped per visitor: one member over budget does not refuse another', async () => {
	const t = setup()
	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(budgetDenial())
	await t.gate({ now: start })
	await t.flush()

	await expect(
		t.gate({ now: start + 1_000, actorId: 'person-2' }),
	).resolves.toBeUndefined()
	await expect(
		t.gate({ now: start + 1_000, actorId: null }),
	).resolves.toBeUndefined()
	await expect(t.gate({ now: start + 1_000 })).rejects.toSatisfy(
		isBudgetLimitError,
	)
})

test('a denial below the configured threshold does not trip', async () => {
	const t = setup({ limitPercent: '150' })
	t.check.mockRejectedValue(computeDenial(412))
	await t.gate({ now: start })
	await t.flush()
	expect(t.store.size).toBe(0)

	vi.spyOn(console, 'info').mockImplementation(() => {})
	t.check.mockRejectedValue(computeDenial(600))
	await t.gate({ now: start + asyncCheckIntervalMs })
	await t.flush()
	expect(t.store.size).toBe(1)
})

test('an unreadable deny entry fails closed: the check runs before serving', async () => {
	const t = setup()
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	t.failKvReads()

	t.check.mockRejectedValueOnce(computeDenial())
	await expect(t.gate({ now: start })).rejects.toSatisfy(
		isComputeOverageLimitError,
	)

	const checkError = new Error('D1 unavailable')
	t.check.mockRejectedValueOnce(checkError)
	await expect(t.gate({ now: start })).rejects.toBe(checkError)

	await expect(t.gate({ now: start })).resolves.toBeUndefined()
	expect(t.check).toHaveBeenCalledTimes(3)
})

test('a check error after the response is logged and does not open the breaker', async () => {
	const t = setup()
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	t.check.mockRejectedValueOnce(new Error('D1 unavailable'))
	await t.gate({ now: start })
	await t.flush()
	expect(t.store.size).toBe(0)
	expect(warn).toHaveBeenCalledWith(
		'package-app-usage-check-failed',
		expect.any(Error),
	)
})

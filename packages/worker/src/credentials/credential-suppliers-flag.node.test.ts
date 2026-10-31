import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	isMissingFeatureFlagsTable: vi.fn(),
}))

vi.mock('#worker/feature-flags/service.ts', () => ({
	evaluateFeatureFlagBatched: async (...args: Array<unknown>) => ({
		enabled: await mocks.isFeatureEnabled(...args),
		source: 'global',
	}),
	isMissingFeatureFlagsTable: mocks.isMissingFeatureFlagsTable,
}))

const {
	isPackageCredentialSuppliersEnabled,
	packageCredentialSuppliersFlagTtlMs,
	resetPackageCredentialSuppliersFlagCacheForTests,
} = await import('./credential-suppliers-flag.ts')

function dbForOwner(id: number | null) {
	return {
		prepare: (sql: string) => ({
			bind: (orgId: string) => ({
				first: async () => {
					expect(sql).toContain('FROM org_memberships')
					expect(orgId).toBe('org-fixture')
					return id === null ? null : { id }
				},
			}),
		}),
	} as unknown as D1Database
}

beforeEach(() => {
	vi.useRealTimers()
	resetPackageCredentialSuppliersFlagCacheForTests()
	mocks.isFeatureEnabled.mockReset().mockResolvedValue(true)
	mocks.isMissingFeatureFlagsTable.mockReset().mockReturnValue(false)
})

test('evaluates the supplier flag for the publisher owner numeric user id once per request', async () => {
	const request = new Request('https://app.example.test/')
	const db = dbForOwner(42)

	await expect(
		isPackageCredentialSuppliersEnabled({
			db,
			orgId: 'org-fixture',
			request,
		}),
	).resolves.toBe(true)
	await expect(
		isPackageCredentialSuppliersEnabled({
			db,
			orgId: 'org-fixture',
			request,
		}),
	).resolves.toBe(true)

	expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(1)
	expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
		db,
		'package-credential-suppliers',
		42,
		{ orgId: 'org-fixture' },
	)
})

test('concurrent evaluations for the same org share one in-flight lookup', async () => {
	const request = new Request('https://app.example.test/concurrent')
	const db = dbForOwner(42)
	let resolveFlag: (value: boolean) => void = () => undefined
	mocks.isFeatureEnabled.mockImplementationOnce(
		() =>
			new Promise<boolean>((resolve) => {
				resolveFlag = resolve
			}),
	)

	const pending = Promise.all([
		isPackageCredentialSuppliersEnabled({
			db,
			orgId: 'org-fixture',
			request,
		}),
		isPackageCredentialSuppliersEnabled({
			db,
			orgId: 'org-fixture',
			request,
		}),
		isPackageCredentialSuppliersEnabled({
			db,
			orgId: 'org-fixture',
			request,
		}),
	])
	await Promise.resolve()
	expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(1)
	resolveFlag(true)
	await expect(pending).resolves.toEqual([true, true, true])
	expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(1)
})

test('a missing feature flags table keeps supplier behavior disabled', async () => {
	const db = dbForOwner(42)
	mocks.isFeatureEnabled.mockRejectedValue(
		new Error('no such table: feature_flags'),
	)
	mocks.isMissingFeatureFlagsTable.mockReturnValue(true)

	await expect(
		isPackageCredentialSuppliersEnabled({
			db,
			orgId: 'org-fixture',
		}),
	).resolves.toBe(false)
})

test('reuses one org answer across requests until the TTL expires', async () => {
	vi.useFakeTimers({ now: new Date('2026-10-31T00:00:00Z') })
	const db = dbForOwner(42)
	const evaluate = () =>
		isPackageCredentialSuppliersEnabled({
			db,
			orgId: 'org-fixture',
			request: new Request('https://app.example.test/'),
		})

	await expect(evaluate()).resolves.toBe(true)
	mocks.isFeatureEnabled.mockResolvedValue(false)
	await expect(evaluate()).resolves.toBe(true)
	expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(1)

	vi.advanceTimersByTime(packageCredentialSuppliersFlagTtlMs + 1)
	await expect(evaluate()).resolves.toBe(false)
	expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(2)
	vi.useRealTimers()
})

test('does not cache a failed evaluation across requests', async () => {
	const db = dbForOwner(42)
	mocks.isFeatureEnabled.mockRejectedValueOnce(new Error('d1 down'))
	await expect(
		isPackageCredentialSuppliersEnabled({ db, orgId: 'org-fixture' }),
	).rejects.toThrow('d1 down')
	await expect(
		isPackageCredentialSuppliersEnabled({ db, orgId: 'org-fixture' }),
	).resolves.toBe(true)
	expect(mocks.isFeatureEnabled).toHaveBeenCalledTimes(2)
})

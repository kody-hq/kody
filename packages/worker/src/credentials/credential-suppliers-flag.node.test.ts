import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	isMissingFeatureFlagsTable: vi.fn(),
}))

vi.mock('#worker/feature-flags/service.ts', () => ({
	isFeatureEnabled: mocks.isFeatureEnabled,
	isMissingFeatureFlagsTable: mocks.isMissingFeatureFlagsTable,
}))

const { isPackageCredentialSuppliersEnabled } =
	await import('./credential-suppliers-flag.ts')

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

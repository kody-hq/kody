import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { approvedCommitCache } from '#worker/package-capabilities/approved-commit-cache.ts'
import { resolveInternetVisibleApprovedCommit } from './package-app-internet-visible.ts'

const mockModule = vi.hoisted(() => ({
	getServedPackageCapabilityApproval: vi.fn(),
}))

vi.mock('#worker/package-capabilities/capability-approvals-repo.ts', () => ({
	getServedPackageCapabilityApproval: (...args: Array<unknown>) =>
		mockModule.getServedPackageCapabilityApproval(...args),
}))

const ownerUserId = ownerIdFromStored('owner-1')
const env = { APP_DB: {} } as unknown as Env

function createSavedPackage(id: string): SavedPackageRecord {
	return {
		id,
		userId: ownerUserId,
		sourceId: `source-${id}`,
		hasApp: true,
		isInternetVisible: true,
	} as SavedPackageRecord
}

async function resolve(savedPackage: SavedPackageRecord) {
	return await resolveInternetVisibleApprovedCommit({
		env,
		lookup: { savedPackage, retired: false },
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

test('anonymous visitors run the commit of the served approval', async () => {
	mockModule.getServedPackageCapabilityApproval.mockResolvedValue({
		publishedCommit: 'commit-a',
	})

	await expect(resolve(createSavedPackage('pkg-current'))).resolves.toBe(
		'commit-a',
	)
	expect(mockModule.getServedPackageCapabilityApproval).toHaveBeenCalledWith(
		env.APP_DB,
		{
			packageId: 'pkg-current',
			ownerUserId,
			sourceId: 'source-pkg-current',
		},
	)
})

test('no approval and not internet-visible both resolve to null', async () => {
	mockModule.getServedPackageCapabilityApproval.mockResolvedValue(null)
	await expect(resolve(createSavedPackage('pkg-unapproved'))).resolves.toBe(
		null,
	)

	await expect(
		resolve({
			...createSavedPackage('pkg-private'),
			isInternetVisible: false,
		}),
	).resolves.toBe(null)
	expect(mockModule.getServedPackageCapabilityApproval).toHaveBeenCalledTimes(1)
})

test('the lookup is cached per app until an approval write drops it', async () => {
	const savedPackage = createSavedPackage('pkg-invalidate')
	mockModule.getServedPackageCapabilityApproval.mockResolvedValue({
		publishedCommit: 'commit-a',
	})
	await expect(resolve(savedPackage)).resolves.toBe('commit-a')
	await expect(resolve(savedPackage)).resolves.toBe('commit-a')
	expect(mockModule.getServedPackageCapabilityApproval).toHaveBeenCalledTimes(1)
	approvedCommitCache.delete(savedPackage.id)
	await expect(resolve(savedPackage)).resolves.toBe('commit-a')
	expect(mockModule.getServedPackageCapabilityApproval).toHaveBeenCalledTimes(2)
})

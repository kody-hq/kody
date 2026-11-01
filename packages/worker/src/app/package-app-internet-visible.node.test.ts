import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { approvedCommitCache } from '#worker/package-capabilities/approved-commit-cache.ts'
import {
	resolveInternetVisibleApprovedCommit,
	warmInternetVisibleApprovedCommit,
} from './package-app-internet-visible.ts'

const mockModule = vi.hoisted(() => ({
	getLatestPackageCapabilityApproval: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadCapabilityApprovalSummary: vi.fn(),
	approvePackageCapabilitySet: vi.fn(),
}))

vi.mock('#worker/package-capabilities/capability-approvals-repo.ts', () => ({
	getLatestPackageCapabilityApproval: (...args: Array<unknown>) =>
		mockModule.getLatestPackageCapabilityApproval(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-capabilities/capability-approval-service.ts', () => ({
	loadCapabilityApprovalSummary: (...args: Array<unknown>) =>
		mockModule.loadCapabilityApprovalSummary(...args),
	approvePackageCapabilitySet: (...args: Array<unknown>) =>
		mockModule.approvePackageCapabilitySet(...args),
}))

const ownerUserId = ownerIdFromStored('owner-1')
const env = { APP_DB: {} } as unknown as Env
const requestUrl = 'https://kody.run/apps/owner/site'

function createSavedPackage(id: string): SavedPackageRecord {
	return {
		id,
		userId: ownerUserId,
		sourceId: `source-${id}`,
		hasApp: true,
		isInternetVisible: true,
	} as SavedPackageRecord
}

function approvalFor(commit: string) {
	return {
		id: `approval-${commit}`,
		publishedCommit: commit,
		fingerprint: 'fingerprint-1',
		approvedByUserId: 'approver-1',
	}
}

function liveSource(commit: string) {
	return { user_id: ownerUserId, published_commit: commit }
}

async function resolve(savedPackage: SavedPackageRecord) {
	return await resolveInternetVisibleApprovedCommit({
		env,
		lookup: { savedPackage, retired: false },
		requestUrl,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

test('serves the approved commit when it is still the live publish', async () => {
	mockModule.getLatestPackageCapabilityApproval.mockResolvedValue(
		approvalFor('commit-a'),
	)
	mockModule.getEntitySourceById.mockResolvedValue(liveSource('commit-a'))

	await expect(resolve(createSavedPackage('pkg-current'))).resolves.toBe(
		'commit-a',
	)
	expect(mockModule.loadCapabilityApprovalSummary).not.toHaveBeenCalled()
})

test('a republish with new capabilities stays pinned to the older approval', async () => {
	mockModule.getLatestPackageCapabilityApproval.mockResolvedValue(
		approvalFor('commit-a'),
	)
	mockModule.getEntitySourceById.mockResolvedValue(liveSource('commit-c'))
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: 'commit-c',
		matchingApproval: null,
		capabilitySet: { fingerprint: 'fingerprint-2' },
	})

	await expect(resolve(createSavedPackage('pkg-new-caps'))).resolves.toBe(
		'commit-a',
	)
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()
})

test('a failed capability check fails closed to the older approval', async () => {
	mockModule.getLatestPackageCapabilityApproval.mockResolvedValue(
		approvalFor('commit-a'),
	)
	mockModule.getEntitySourceById.mockResolvedValue(liveSource('commit-d'))
	mockModule.loadCapabilityApprovalSummary.mockRejectedValue(
		new Error('manifest unavailable'),
	)

	await expect(resolve(createSavedPackage('pkg-check-fails'))).resolves.toBe(
		'commit-a',
	)
})

test('no approval and not internet-visible both resolve to null', async () => {
	mockModule.getLatestPackageCapabilityApproval.mockResolvedValue(null)
	await expect(resolve(createSavedPackage('pkg-unapproved'))).resolves.toBe(
		null,
	)

	await expect(
		resolve({
			...createSavedPackage('pkg-private'),
			isInternetVisible: false,
		}),
	).resolves.toBe(null)
	expect(mockModule.getEntitySourceById).not.toHaveBeenCalled()
})

test('publish-time warm accepts a matching republish so the first request reads the cache', async () => {
	const savedPackage = createSavedPackage('pkg-warm')
	mockModule.getLatestPackageCapabilityApproval.mockResolvedValue(
		approvalFor('commit-a'),
	)
	mockModule.getEntitySourceById.mockResolvedValue(liveSource('commit-b'))
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: 'commit-b',
		matchingApproval: approvalFor('commit-a'),
		capabilitySet: { fingerprint: 'fingerprint-1' },
	})
	mockModule.approvePackageCapabilitySet.mockResolvedValue({
		approval: approvalFor('commit-b'),
	})

	await expect(
		warmInternetVisibleApprovedCommit({ env, savedPackage, requestUrl }),
	).resolves.toBe('commit-b')
	expect(mockModule.approvePackageCapabilitySet).toHaveBeenCalledTimes(1)

	await expect(resolve(savedPackage)).resolves.toBe('commit-b')
	expect(mockModule.getLatestPackageCapabilityApproval).toHaveBeenCalledTimes(1)
	expect(mockModule.loadCapabilityApprovalSummary).toHaveBeenCalledTimes(1)
})

test('publish-time warm skips apps that are not internet-visible', async () => {
	await expect(
		warmInternetVisibleApprovedCommit({
			env,
			savedPackage: {
				...createSavedPackage('pkg-warm-private'),
				isInternetVisible: false,
			},
			requestUrl,
		}),
	).resolves.toBe(null)
	expect(mockModule.getLatestPackageCapabilityApproval).not.toHaveBeenCalled()
})

test('an approval write drops the cached commit', async () => {
	const savedPackage = createSavedPackage('pkg-invalidate')
	mockModule.getLatestPackageCapabilityApproval.mockResolvedValue(
		approvalFor('commit-a'),
	)
	mockModule.getEntitySourceById.mockResolvedValue(liveSource('commit-a'))
	await expect(resolve(savedPackage)).resolves.toBe('commit-a')
	approvedCommitCache.delete(savedPackage.id)
	await expect(resolve(savedPackage)).resolves.toBe('commit-a')
	expect(mockModule.getLatestPackageCapabilityApproval).toHaveBeenCalledTimes(2)
})

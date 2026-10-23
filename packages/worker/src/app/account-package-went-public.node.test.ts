import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getPackageApprovalRequest: vi.fn(),
	listPendingPackageApprovalRequests: vi.fn(),
	resolvePackageApprovalRequest: vi.fn(),
	loadCapabilityApprovalSummary: vi.fn(),
	findPackageCapabilityApprovalByFingerprint: vi.fn(),
	getSavedPackageById: vi.fn(),
	updateSavedPackage: vi.fn(),
	getEntitySourceById: vi.fn(),
}))

vi.mock('#worker/package-capabilities/approval-requests-repo.ts', () => ({
	getPackageApprovalRequest: (...args: Array<unknown>) =>
		mockModule.getPackageApprovalRequest(...args),
	listPendingPackageApprovalRequests: (...args: Array<unknown>) =>
		mockModule.listPendingPackageApprovalRequests(...args),
	resolvePackageApprovalRequest: (...args: Array<unknown>) =>
		mockModule.resolvePackageApprovalRequest(...args),
}))

vi.mock('#worker/package-capabilities/capability-approvals-repo.ts', () => ({
	findPackageCapabilityApprovalByFingerprint: (...args: Array<unknown>) =>
		mockModule.findPackageCapabilityApprovalByFingerprint(...args),
}))

vi.mock('#worker/package-capabilities/capability-approval-service.ts', () => ({
	loadCapabilityApprovalSummary: (...args: Array<unknown>) =>
		mockModule.loadCapabilityApprovalSummary(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

const { approveWentPublicRequest } =
	await import('./account-package-approval-requests.ts')

beforeEach(() => {
	mockModule.getPackageApprovalRequest.mockReset()
	mockModule.listPendingPackageApprovalRequests.mockReset()
	mockModule.resolvePackageApprovalRequest.mockReset()
	mockModule.loadCapabilityApprovalSummary.mockReset()
	mockModule.findPackageCapabilityApprovalByFingerprint.mockReset()
	mockModule.getSavedPackageById.mockReset()
	mockModule.updateSavedPackage.mockReset()
	mockModule.getEntitySourceById.mockReset()
})

function stubApproveWentPublicHappyPath() {
	mockModule.getPackageApprovalRequest.mockResolvedValue({
		id: 'req-went',
		reason: 'went_public',
		status: 'pending',
		pendingCommit: 'deadbeef',
		baseCommit: 'deadbeef',
		details: {},
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		published_commit: 'deadbeef',
	})
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: 'deadbeef',
		fingerprintMatchesApproval: true,
		capabilitySet: { fingerprint: 'fp-1', entries: [] },
		dependencySnapshot: null,
	})
	mockModule.findPackageCapabilityApprovalByFingerprint.mockResolvedValue({
		id: 'pin-1',
		publishedCommit: 'deadbeef',
		fingerprint: 'fp-1',
		dependencySnapshotJson: '{}',
	})
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage(false))
	mockModule.resolvePackageApprovalRequest.mockResolvedValue(true)
	mockModule.updateSavedPackage.mockResolvedValue(true)
}

function savedPackage(isInternetVisible = false) {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('owner-1'),
		name: '@user/notes',
		kodyId: 'notes',
		description: '',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

test('approveWentPublicRequest fails closed when clear bumps updated_at after claim without re-opening the ask', async () => {
	stubApproveWentPublicHappyPath()
	mockModule.updateSavedPackage.mockResolvedValue(false)

	const result = await approveWentPublicRequest({
		env: { APP_DB: {} } as Env,
		request: new Request('https://example.com/approve'),
		savedPackage: savedPackage(false),
		ownerUserId: 'owner-1',
		actorUserId: personIdFromStored('actor-1'),
		requestId: 'req-went',
	})
	expect(result).toMatchObject({ ok: false, status: 409 })
	expect(mockModule.resolvePackageApprovalRequest).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'req-went',
			status: 'approved',
		}),
	)
	expect(mockModule.updateSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			isInternetVisible: true,
			expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
		}),
	)
})

test('approveWentPublicRequest requires a pin for the current published commit', async () => {
	mockModule.getPackageApprovalRequest.mockResolvedValue({
		id: 'req-went',
		reason: 'went_public',
		status: 'pending',
		pendingCommit: 'deadbeef',
		baseCommit: 'deadbeef',
		details: {},
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		published_commit: 'deadbeef',
	})
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: 'deadbeef',
		fingerprintMatchesApproval: true,
		capabilitySet: { fingerprint: 'fp-1', entries: [] },
	})
	mockModule.findPackageCapabilityApprovalByFingerprint.mockResolvedValue(null)

	const result = await approveWentPublicRequest({
		env: { APP_DB: {} } as Env,
		request: new Request('https://example.com/approve'),
		savedPackage: savedPackage(false),
		ownerUserId: 'owner-1',
		actorUserId: 'actor-1',
		requestId: 'req-went',
	})
	expect(result).toMatchObject({ ok: false, status: 409 })
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('approveWentPublicRequest supersedes when the published commit moved', async () => {
	mockModule.getPackageApprovalRequest.mockResolvedValue({
		id: 'req-went',
		reason: 'went_public',
		status: 'pending',
		pendingCommit: 'deadbeef',
		baseCommit: 'deadbeef',
		details: {},
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		published_commit: 'newer',
	})
	mockModule.resolvePackageApprovalRequest.mockResolvedValue(true)

	const result = await approveWentPublicRequest({
		env: { APP_DB: {} } as Env,
		request: new Request('https://example.com/approve'),
		savedPackage: savedPackage(false),
		ownerUserId: 'owner-1',
		actorUserId: 'actor-1',
		requestId: 'req-went',
	})
	expect(result).toMatchObject({ ok: false, status: 409 })
	expect(mockModule.resolvePackageApprovalRequest).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ status: 'superseded' }),
	)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

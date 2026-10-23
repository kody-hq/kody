import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	writablePackage: null as ReturnType<typeof createSavedPackage> | null,
	loadCapabilityApprovalSummary: vi.fn(),
	approvePackageCapabilitySet: vi.fn(),
	clearInternetVisible: vi.fn(),
	reloadAccountPackagesAfterWrite: vi.fn(),
	loadOrgBindingForOrg: vi.fn(),
	approveCredentialNeedsRequest: vi.fn(),
	approveWentPublicRequest: vi.fn(),
	enqueueWentPublicApproval: vi.fn(),
	getPendingWentPublicApproval: vi.fn(),
	logOrgAuditEvent: vi.fn(),
	loadCurrentPackageSecurityAudit: vi.fn(),
	attemptSelfPublish: vi.fn(),
	applyMatchingPinInternetVisible: vi.fn(),
}))

vi.mock('#worker/package-capabilities/security-audit-state.ts', () => ({
	loadCurrentPackageSecurityAudit: (...args: Array<unknown>) =>
		mockModule.loadCurrentPackageSecurityAudit(...args),
	loadPackageSecurityAuditState: vi.fn(),
}))

vi.mock('#worker/package-capabilities/went-public-approval.ts', () => ({
	enqueueWentPublicApproval: (...args: Array<unknown>) =>
		mockModule.enqueueWentPublicApproval(...args),
	getPendingWentPublicApproval: (...args: Array<unknown>) =>
		mockModule.getPendingWentPublicApproval(...args),
}))

vi.mock('#worker/package-capabilities/self-publish.ts', () => ({
	attemptSelfPublish: (...args: Array<unknown>) =>
		mockModule.attemptSelfPublish(...args),
	explainSelfPublishBlocker: vi.fn(async () => null),
	applyMatchingPinInternetVisible: (...args: Array<unknown>) =>
		mockModule.applyMatchingPinInternetVisible(...args),
}))

vi.mock('#worker/orgs/org-audit.ts', () => ({
	logOrgAuditEvent: (...args: Array<unknown>) =>
		mockModule.logOrgAuditEvent(...args),
}))

vi.mock('#app/account-package-approval-requests.ts', () => ({
	approveCredentialNeedsRequest: (...args: Array<unknown>) =>
		mockModule.approveCredentialNeedsRequest(...args),
	approveWentPublicRequest: (...args: Array<unknown>) =>
		mockModule.approveWentPublicRequest(...args),
	loadPendingPackageApprovals: async () => [],
}))

vi.mock('#app/account-package-write-access.ts', () => ({
	loadWritableAccountSavedPackage: vi.fn(
		async (input: {
			packageId: string
			user: { mcpUser: { userId: string } }
		}) => {
			if (!mockModule.writablePackage) {
				return {
					ok: false as const,
					response: new Response(
						JSON.stringify({ ok: false, error: 'Package not found.' }),
						{ status: 404 },
					),
				}
			}
			return {
				ok: true as const,
				package: {
					savedPackage: mockModule.writablePackage,
					ownerUserId: mockModule.writablePackage.userId,
					actorUserId: input.user.mcpUser.userId,
				},
			}
		},
	),
}))

vi.mock('#worker/package-capabilities/capability-approval-service.ts', () => ({
	loadCapabilityApprovalSummary: (...args: Array<unknown>) =>
		mockModule.loadCapabilityApprovalSummary(...args),
	approvePackageCapabilitySet: (...args: Array<unknown>) =>
		mockModule.approvePackageCapabilitySet(...args),
	clearInternetVisible: (...args: Array<unknown>) =>
		mockModule.clearInternetVisible(...args),
	CapabilityApprovalError: class CapabilityApprovalError extends Error {
		constructor(message: string) {
			super(message)
			this.name = 'CapabilityApprovalError'
		}
	},
}))

vi.mock('#app/account-packages-data.ts', () => ({
	reloadAccountPackagesAfterWrite: (...args: Array<unknown>) =>
		mockModule.reloadAccountPackagesAfterWrite(...args),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForOrg: (...args: Array<unknown>) =>
		mockModule.loadOrgBindingForOrg(...args),
}))

const {
	setAccountPackageInternetVisible,
	approveAccountPackageCapabilitiesAndGoPublic,
	approveAccountPackageWentPublic,
} = await import('./account-package-capability-approval.ts')

const { CapabilityApprovalError } =
	await import('#worker/package-capabilities/capability-approval-service.ts')

beforeEach(() => {
	mockModule.writablePackage = null
	mockModule.loadCapabilityApprovalSummary.mockReset()
	mockModule.approvePackageCapabilitySet.mockReset()
	mockModule.clearInternetVisible.mockReset()
	mockModule.reloadAccountPackagesAfterWrite.mockReset()
	mockModule.loadOrgBindingForOrg.mockReset()
	mockModule.approveCredentialNeedsRequest.mockReset()
	mockModule.approveWentPublicRequest.mockReset()
	mockModule.enqueueWentPublicApproval.mockReset()
	mockModule.getPendingWentPublicApproval.mockReset()
	mockModule.getPendingWentPublicApproval.mockResolvedValue({
		id: 'request-went-public',
	})
	mockModule.logOrgAuditEvent.mockReset()
	mockModule.logOrgAuditEvent.mockResolvedValue(undefined)
	mockModule.loadCurrentPackageSecurityAudit.mockReset()
	mockModule.loadCurrentPackageSecurityAudit.mockResolvedValue(null)
	mockModule.attemptSelfPublish.mockReset()
	mockModule.attemptSelfPublish.mockResolvedValue({
		status: 'blocked',
		blocker: 'not_audited',
		reasons: [{ kind: 'not_audited' }],
		detail: {
			blocker: 'not_audited',
			reasons: [{ kind: 'not_audited' }],
			message: 'No passing security audit is recorded for this version.',
		},
	})
	mockModule.applyMatchingPinInternetVisible.mockReset()
})

function createUser(): AuthenticatedAppUser {
	return {
		sessionUserId: '42',
		userId: 42,
		username: 'user',
		email: 'user@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'user',
		roles: [],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: personIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'user',
			displayName: 'user',
		},
		request: sessionRequestContext('stable-user-1'),
	}
}

function createSavedPackage(isInternetVisible: boolean) {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('stable-user-1'),
		name: '@user/notes',
		kodyId: 'notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hasSkills: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('turning on internet-visible with matching approval turns serving on without another Approve', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'abc' },
		dependencySnapshot: {
			version: 1,
			root: {
				packageId: 'pkg-1',
				kodyId: 'notes',
				sourceId: 'source-1',
				publishedCommit: 'deadbeef',
			},
			dependencies: [],
		},
		publishedCommit: 'deadbeef',
		latestApproval: { fingerprint: 'other' },
		matchingApproval: {
			fingerprint: 'abc',
			approvedAt: '2026-01-02T00:00:00.000Z',
		},
		fingerprintMatchesApproval: true,
		isInternetVisible: false,
	})
	mockModule.applyMatchingPinInternetVisible.mockResolvedValue({ ok: true })
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })

	const response = await setAccountPackageInternetVisible({
		env,
		request,
		user,
		packageId: 'pkg-1',
		internetVisible: true,
		confirmName: 'notes',
	})
	expect(response?.status).toBe(200)
	expect(response?.data).toMatchObject({ ok: true })
	expect(mockModule.applyMatchingPinInternetVisible).toHaveBeenCalledWith(
		expect.objectContaining({
			fingerprint: 'abc',
			ownerUserId: mockModule.writablePackage?.userId,
		}),
	)
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
})

test('turning on internet-visible self-publishes when the capability set is empty and the audit passed', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'abc' },
		dependencySnapshot: null,
		publishedCommit: 'deadbeef',
		latestApproval: null,
		matchingApproval: null,
		fingerprintMatchesApproval: false,
		isInternetVisible: false,
	})
	mockModule.attemptSelfPublish.mockResolvedValue({
		status: 'self_published',
	})
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })

	const response = await setAccountPackageInternetVisible({
		env,
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
		}),
		user,
		packageId: 'pkg-1',
		internetVisible: true,
		confirmName: 'notes',
	})
	expect(response?.status).toBe(200)
	expect(response?.data).toMatchObject({ ok: true })
	expect(mockModule.attemptSelfPublish).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerUserId: mockModule.writablePackage?.userId,
			actorUserId: user.mcpUser.userId,
		}),
	)
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(mockModule.applyMatchingPinInternetVisible).not.toHaveBeenCalled()
})

test('turning on internet-visible does not recreate a canceled went_public ask after self-publish fails', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'abc' },
		dependencySnapshot: null,
		publishedCommit: 'deadbeef',
		latestApproval: null,
		matchingApproval: { fingerprint: 'abc' },
		fingerprintMatchesApproval: true,
		isInternetVisible: false,
	})
	mockModule.attemptSelfPublish.mockResolvedValue({
		status: 'failed',
		error:
			'The request to make this package internet-visible was resolved meanwhile, so nothing was approved.',
	})
	mockModule.getPendingWentPublicApproval.mockResolvedValueOnce(null)

	const canceled = await setAccountPackageInternetVisible({
		env,
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
		}),
		user,
		packageId: 'pkg-1',
		internetVisible: true,
		confirmName: 'notes',
	})
	expect(canceled?.status).toBe(400)
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(mockModule.applyMatchingPinInternetVisible).not.toHaveBeenCalled()

	mockModule.getPendingWentPublicApproval.mockResolvedValueOnce({
		id: 'request-still-pending',
	})
	const pending = await setAccountPackageInternetVisible({
		env,
		request: new Request('https://example.com/account/packages.json', {
			method: 'POST',
		}),
		user,
		packageId: 'pkg-1',
		internetVisible: true,
		confirmName: 'notes',
	})
	expect(pending?.status).toBe(400)
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(mockModule.applyMatchingPinInternetVisible).not.toHaveBeenCalled()
})

test('turning off internet-visible requires the slug and clears the flag', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(true)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.clearInternetVisible.mockResolvedValue(true)
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })

	const missing = await setAccountPackageInternetVisible({
		env,
		request,
		user,
		packageId: 'pkg-1',
		internetVisible: false,
		confirmName: '',
	})
	expect(missing?.status).toBe(400)
	expect(mockModule.clearInternetVisible).not.toHaveBeenCalled()

	const ok = await setAccountPackageInternetVisible({
		env,
		request,
		user,
		packageId: 'pkg-1',
		internetVisible: false,
		confirmName: 'notes',
	})
	expect(ok?.status).toBe(200)
	expect(mockModule.clearInternetVisible).toHaveBeenCalled()
})

test('approve-capabilities-and-go-public pins without enqueuing, so a request turned off meanwhile stays off', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.approvePackageCapabilitySet.mockResolvedValue({
		approval: { id: 'approval-1', publishedCommit: 'deadbeef' },
		capabilitySet: { entries: [], fingerprint: 'reviewed-fp' },
		wentPublicRequest: null,
	})
	mockModule.approveWentPublicRequest.mockResolvedValue({
		ok: false,
		status: 409,
		error: 'This request was already resolved. Reload the page.',
	})

	const response = await approveAccountPackageCapabilitiesAndGoPublic({
		env,
		request,
		user,
		packageId: 'pkg-1',
		fingerprint: 'reviewed-fp',
		requestId: 'request-went-public',
	})

	expect(response?.status).toBe(409)
	expect(response?.data).toMatchObject({ ok: false })
	expect(mockModule.approvePackageCapabilitySet).toHaveBeenCalledWith(
		expect.objectContaining({ enqueueWentPublic: false }),
	)
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(
		mockModule.logOrgAuditEvent.mock.calls.map(([event]) => [
			event.action,
			event.result,
		]),
	).toEqual([
		['package.capabilities.approve', 'success'],
		['package.went_public.approve', 'failure'],
	])
})

test('approve-capabilities-and-go-public does not go public when the capability approval fails', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.approvePackageCapabilitySet.mockRejectedValue(
		new CapabilityApprovalError('The capability set changed.'),
	)

	const missingRequest = await approveAccountPackageCapabilitiesAndGoPublic({
		env,
		request,
		user,
		packageId: 'pkg-1',
		fingerprint: 'stale-fp',
		requestId: '',
	})
	expect(missingRequest?.status).toBe(400)
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()

	const response = await approveAccountPackageCapabilitiesAndGoPublic({
		env,
		request,
		user,
		packageId: 'pkg-1',
		fingerprint: 'stale-fp',
		requestId: 'request-went-public',
	})

	expect(response?.status).toBe(400)
	expect(response?.data).toMatchObject({
		ok: false,
		error: 'The capability set changed.',
	})
	expect(mockModule.approveWentPublicRequest).not.toHaveBeenCalled()
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledTimes(1)
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'package.capabilities.approve',
			result: 'failure',
			details: expect.objectContaining({
				fingerprint: 'stale-fp',
				error: 'The capability set changed.',
			}),
		}),
	)
})

test('a failing audit write does not block the approval', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.writablePackage = createSavedPackage(false)
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.logOrgAuditEvent.mockRejectedValue(new Error('audit down'))
	mockModule.approveWentPublicRequest.mockResolvedValue({ ok: true })
	mockModule.reloadAccountPackagesAfterWrite.mockResolvedValue({ ok: true })
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

	const response = await approveAccountPackageWentPublic({
		env,
		request,
		user,
		packageId: 'pkg-1',
		requestId: 'request-went-public',
	})

	expect(response?.status).toBe(200)
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})

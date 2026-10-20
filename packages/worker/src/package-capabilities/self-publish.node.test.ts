import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import type * as Authorize from '#worker/authorization/authorize.ts'
import type * as WentPublicApproval from './went-public-approval.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
	loadPublishedCredentialNeeds: vi.fn(),
	approvePackageCapabilitySet: vi.fn(),
	enqueueWentPublicApproval: vi.fn(),
	setSelfPublishMark: vi.fn(),
	approveWentPublicRequest: vi.fn(),
	logOrgAuditEvent: vi.fn(),
	loadCurrentPackageSecurityAudit: vi.fn(),
	authorizePackageWrite: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))
vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntityManifest(...args),
}))
vi.mock('#worker/credentials/credential-needs-closure.ts', () => ({
	loadPublishedCredentialNeeds: (...args: Array<unknown>) =>
		mockModule.loadPublishedCredentialNeeds(...args),
}))
vi.mock('./capability-approval-service.ts', () => ({
	approvePackageCapabilitySet: (...args: Array<unknown>) =>
		mockModule.approvePackageCapabilitySet(...args),
}))
vi.mock('./went-public-approval.ts', async (importOriginal) => ({
	...(await importOriginal<typeof WentPublicApproval>()),
	enqueueWentPublicApproval: (...args: Array<unknown>) =>
		mockModule.enqueueWentPublicApproval(...args),
	setSelfPublishMark: (...args: Array<unknown>) =>
		mockModule.setSelfPublishMark(...args),
}))
vi.mock('#app/account-package-approval-requests.ts', () => ({
	approveWentPublicRequest: (...args: Array<unknown>) =>
		mockModule.approveWentPublicRequest(...args),
}))
vi.mock('./security-audit-state.ts', () => ({
	loadCurrentPackageSecurityAudit: (...args: Array<unknown>) =>
		mockModule.loadCurrentPackageSecurityAudit(...args),
}))
vi.mock('./package-storage-use.ts', () => ({
	findPublishedPackageStorageMatches: vi.fn(async () => []),
	publishedPackageUsesStorage: vi.fn(async () => false),
	sourceFilesUsePackageStorage: vi.fn(() => false),
	findPackageStorageMatchesInFiles: vi.fn(() => []),
	findPackageStorageMatchesInSource: vi.fn(() => []),
}))
vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => ({
	...(await importOriginal<typeof Authorize>()),
	authorizePackageWrite: (...args: Array<unknown>) =>
		mockModule.authorizePackageWrite(...args),
}))
vi.mock('#worker/orgs/org-audit.ts', () => ({
	logOrgAuditEvent: (...args: Array<unknown>) =>
		mockModule.logOrgAuditEvent(...args),
}))

const {
	attemptSelfPublish,
	evaluateSelfPublish,
	selfPublishPackage,
	selfPublishAuditAction,
} = await import('./self-publish.ts')
const { AuthorizationError } =
	await import('#worker/authorization/authorize.ts')

const ownerId = ownerIdFromStored('org-1')
const savedPackage = {
	id: 'pkg-1',
	userId: ownerId,
	kodyId: 'landing',
	name: '@bea/landing',
	description: 'Landing page',
	tags: [],
	searchText: null,
	hasApp: true,
	hasSkills: false,
	hidden: false,
	isPrivate: false,
	isInternetVisible: false,
	lockedAt: null,
	sourceId: 'source-root',
	createdAt: '2026-10-01T00:00:00.000Z',
	updatedAt: '2026-10-01T00:00:00.000Z',
}

function summary(dependencySourceIds: Array<string> = []) {
	return {
		capabilitySet: { entries: [], fingerprint: 'fp-1' },
		dependencySnapshot: {
			version: 1 as const,
			root: {
				packageId: 'pkg-1',
				kodyId: 'landing',
				sourceId: 'source-root',
				publishedCommit: 'commit-source-root',
			},
			dependencies: dependencySourceIds.map((sourceId) => ({
				sourceId,
				publishedCommit: `commit-${sourceId}`,
				kodyId: sourceId,
			})),
		},
		publishedCommit: 'commit-source-root',
		latestApproval: null,
		matchingApproval: null,
		fingerprintMatchesApproval: false,
		isInternetVisible: false,
	}
}

function publishTree(kodyBySource: Record<string, Record<string, unknown>>) {
	mockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) =>
			sourceId in kodyBySource
				? {
						id: sourceId,
						user_id: `owner-of-${sourceId}`,
						published_commit: `commit-${sourceId}`,
					}
				: null,
	)
	mockModule.loadPublishedEntityManifest.mockImplementation(
		async (input: { sourceId: string }) => ({
			manifest: {
				name: input.sourceId,
				kody: { description: 'test', ...kodyBySource[input.sourceId] },
			},
		}),
	)
}

const env = { APP_DB: {} } as Env
const markedRequest = { id: 'request-1', details: { selfPublish: true } }

beforeEach(() => {
	for (const mock of Object.values(mockModule)) mock.mockReset()
	mockModule.loadPublishedCredentialNeeds.mockResolvedValue([])
	mockModule.logOrgAuditEvent.mockResolvedValue(undefined)
	mockModule.loadCurrentPackageSecurityAudit.mockResolvedValue({
		verdict: 'pass',
		summary: 'Checked.',
		auditor: 'Audit agent',
		recordedBy: null,
		recordedAt: '2026-10-15T00:00:00.000Z',
	})
	mockModule.authorizePackageWrite.mockResolvedValue(undefined)
})

test('a tree that declares nothing is eligible, checked per package owner with the fresh closure', async () => {
	publishTree({ 'source-root': {}, 'source-dep': { app: { entry: 'x' } } })
	await expect(
		evaluateSelfPublish({
			env,
			savedPackage,
			summary: summary(['source-dep']),
		}),
	).resolves.toEqual({ eligible: true })
	expect(mockModule.loadPublishedCredentialNeeds.mock.calls).toEqual([
		[
			expect.objectContaining({
				userId: 'owner-of-source-root',
				sourceId: 'source-root',
				fresh: true,
			}),
		],
		[
			expect.objectContaining({
				userId: 'owner-of-source-dep',
				sourceId: 'source-dep',
				fresh: true,
			}),
		],
	])
})

test('self-publish is blocked when the capability set has entries or the tree declares credentials or capabilities', async () => {
	const evaluate = (dependencies: Array<string> = ['source-dep']) =>
		evaluateSelfPublish({ env, savedPackage, summary: summary(dependencies) })

	publishTree({ 'source-root': {} })
	await expect(evaluate()).resolves.toEqual(
		expect.objectContaining({
			eligible: false,
			blocker: 'unpublished',
		}),
	)

	publishTree({ 'source-root': {}, 'source-dep': {} })
	await expect(
		evaluateSelfPublish({
			env,
			savedPackage,
			summary: {
				...summary(),
				capabilitySet: {
					entries: [
						{
							kind: 'credential',
							credentialId: 'cred-1',
							hosts: ['api.example.com'],
							via: ['landing'],
						},
					],
					fingerprint: 'fp-with-cred',
				},
			},
		}),
	).resolves.toEqual(
		expect.objectContaining({
			eligible: false,
			blocker: 'declares_credentials',
			reasons: [
				expect.objectContaining({
					kind: 'credential_entry',
					credentialId: 'cred-1',
				}),
			],
		}),
	)
	await expect(
		evaluateSelfPublish({
			env,
			savedPackage,
			summary: {
				...summary(),
				capabilitySet: {
					entries: [
						{
							kind: 'storage',
							storageId: 'pkg-1',
							hosts: [],
							via: ['landing'],
						},
					],
					fingerprint: 'fp-with-storage',
				},
			},
		}),
	).resolves.toEqual(
		expect.objectContaining({
			eligible: false,
			blocker: 'declares_capabilities',
			reasons: [
				expect.objectContaining({
					kind: 'storage_entry',
					storageId: 'pkg-1',
				}),
			],
		}),
	)

	publishTree({
		'source-root': {},
		'source-dep': { credentials: { resend: { description: 'Mail.' } } },
	})
	await expect(evaluate()).resolves.toEqual(
		expect.objectContaining({
			eligible: false,
			blocker: 'declares_credentials',
		}),
	)

	publishTree({ 'source-root': {}, 'source-dep': {} })
	mockModule.loadPublishedCredentialNeeds.mockImplementation(
		async (input: { sourceId: string }) =>
			input.sourceId === 'source-dep'
				? [{ key: 'resend', provider: 'resend' }]
				: [],
	)
	await expect(evaluate()).resolves.toEqual(
		expect.objectContaining({
			eligible: false,
			blocker: 'declares_credentials',
		}),
	)
	mockModule.loadPublishedCredentialNeeds.mockResolvedValue([])

	for (const kody of [
		{ secretMounts: { token: { name: 'TOKEN' } } },
		{ secretProvider: { name: 'vault' } },
		{ subscriptions: { tick: {} } },
		{ emits: { done: { description: 'Done.' } } },
		{ jobs: { nightly: {} } },
		{ retrievers: { docs: {} } },
		{ webhooks: [{ name: 'stripe' }] },
	]) {
		publishTree({ 'source-root': kody, 'source-dep': {} })
		await expect(evaluate()).resolves.toEqual(
			expect.objectContaining({
				eligible: false,
				blocker: 'declares_capabilities',
				reasons: [
					expect.objectContaining({
						kind: 'manifest_field',
						field: Object.keys(kody)[0],
					}),
				],
			}),
		)
	}
})

test('self-publish needs a passing security audit for the current commit and fingerprint', async () => {
	publishTree({ 'source-root': {} })
	const evaluate = () =>
		evaluateSelfPublish({ env, savedPackage, summary: summary() })

	mockModule.loadCurrentPackageSecurityAudit.mockResolvedValueOnce(null)
	await expect(evaluate()).resolves.toEqual(
		expect.objectContaining({
			eligible: false,
			blocker: 'not_audited',
		}),
	)
	expect(mockModule.loadCurrentPackageSecurityAudit).toHaveBeenCalledWith(
		env.APP_DB,
		{
			ownerUserId: ownerId,
			packageId: 'pkg-1',
			publishedCommit: 'commit-source-root',
			fingerprint: 'fp-1',
		},
	)

	mockModule.loadCurrentPackageSecurityAudit.mockResolvedValueOnce({
		verdict: 'concerns',
		summary: 'Look closer.',
		auditor: 'Audit agent',
		recordedBy: null,
		recordedAt: '2026-10-15T00:00:00.000Z',
	})
	await expect(evaluate()).resolves.toEqual(
		expect.objectContaining({
			eligible: false,
			blocker: 'audit_concerns',
		}),
	)

	await expect(evaluate()).resolves.toEqual({ eligible: true })
})

test('attemptSelfPublish writes nothing when blocked or when the caller may not publish', async () => {
	publishTree({ 'source-root': {} })
	const request = sessionRequestContext('person-1')
	const attempt = () =>
		attemptSelfPublish({
			env,
			request,
			requestUrl: 'https://heykody.dev',
			ownerUserId: ownerId,
			actorUserId: 'person-1',
			savedPackage,
			summary: summary(),
		})

	mockModule.loadCurrentPackageSecurityAudit.mockResolvedValueOnce(null)
	await expect(attempt()).resolves.toEqual(
		expect.objectContaining({
			status: 'blocked',
			blocker: 'not_audited',
			detail: expect.objectContaining({
				blocker: 'not_audited',
				message: expect.stringContaining('security audit'),
			}),
		}),
	)

	mockModule.authorizePackageWrite.mockRejectedValueOnce(
		Object.create(AuthorizationError.prototype),
	)
	await expect(attempt()).resolves.toEqual(
		expect.objectContaining({
			status: 'blocked',
			blocker: 'not_permitted',
			detail: expect.objectContaining({ blocker: 'not_permitted' }),
		}),
	)
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
})

function selfPublish() {
	return selfPublishPackage({
		env,
		request: sessionRequestContext('person-1', 'bea'),
		requestUrl: 'https://heykody.dev',
		ownerUserId: ownerId,
		actorUserId: 'person-1',
		savedPackage,
		summary: summary(),
	})
}

function pinCurrentCommit() {
	mockModule.approvePackageCapabilitySet.mockResolvedValue({
		approval: { id: 'approval-1', publishedCommit: 'commit-source-root' },
	})
}

test('selfPublishPackage pins the set, approves a marked went_public request, and audits once', async () => {
	pinCurrentCommit()
	mockModule.enqueueWentPublicApproval.mockResolvedValue(markedRequest)
	mockModule.approveWentPublicRequest.mockResolvedValue({ ok: true })

	await expect(selfPublish()).resolves.toEqual({ ok: true })

	expect(mockModule.approvePackageCapabilitySet).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedFingerprint: 'fp-1',
			enqueueWentPublic: false,
		}),
	)
	expect(mockModule.enqueueWentPublicApproval).toHaveBeenCalledWith(
		expect.objectContaining({
			publishedCommit: 'commit-source-root',
			selfPublish: true,
		}),
	)
	expect(mockModule.setSelfPublishMark).not.toHaveBeenCalled()
	expect(mockModule.approveWentPublicRequest).toHaveBeenCalledWith(
		expect.objectContaining({ requestId: 'request-1' }),
	)
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledTimes(1)
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: selfPublishAuditAction,
			result: 'success',
			orgId: ownerId,
			resourceId: 'pkg-1',
			details: expect.objectContaining({
				requestId: 'request-1',
				approvalId: 'approval-1',
				fingerprint: 'fp-1',
			}),
		}),
	)
})

test('selfPublishPackage marks a reused owner-path request in place before approving it', async () => {
	pinCurrentCommit()
	mockModule.enqueueWentPublicApproval.mockResolvedValue({
		id: 'owner-request',
		details: { fingerprint: 'fp-1' },
	})
	mockModule.setSelfPublishMark.mockResolvedValue(true)
	mockModule.approveWentPublicRequest.mockResolvedValue({ ok: true })

	await expect(selfPublish()).resolves.toEqual({ ok: true })
	expect(mockModule.setSelfPublishMark.mock.calls).toEqual([
		[env, 'owner-request', true],
	])
	expect(mockModule.approveWentPublicRequest).toHaveBeenCalledWith(
		expect.objectContaining({ requestId: 'owner-request' }),
	)
})

test('selfPublishPackage never approves a request resolved before it could be marked', async () => {
	pinCurrentCommit()
	mockModule.enqueueWentPublicApproval.mockResolvedValue({
		id: 'owner-request',
		details: {},
	})
	mockModule.setSelfPublishMark.mockResolvedValue(false)

	await expect(selfPublish()).resolves.toMatchObject({ ok: false })
	expect(mockModule.approveWentPublicRequest).not.toHaveBeenCalled()
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({ result: 'failure' }),
	)
})

test('selfPublishPackage unmarks the still-pending request when approve fails, and audits the error', async () => {
	pinCurrentCommit()
	mockModule.enqueueWentPublicApproval.mockResolvedValue(markedRequest)
	mockModule.approveWentPublicRequest.mockResolvedValue({
		ok: false,
		status: 409,
		error: 'Review and approve the capability summary first.',
	})

	await expect(selfPublish()).resolves.toEqual({
		ok: false,
		error: 'Review and approve the capability summary first.',
	})
	expect(mockModule.setSelfPublishMark.mock.calls).toEqual([
		[env, 'request-1', false],
	])
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: selfPublishAuditAction,
			result: 'failure',
			details: expect.objectContaining({
				error: 'Review and approve the capability summary first.',
			}),
		}),
	)
})

test('selfPublishPackage unmarks the request when approve throws', async () => {
	pinCurrentCommit()
	mockModule.enqueueWentPublicApproval.mockResolvedValue(markedRequest)
	mockModule.approveWentPublicRequest.mockRejectedValue(new Error('D1 down'))

	await expect(selfPublish()).rejects.toThrow('D1 down')
	expect(mockModule.setSelfPublishMark.mock.calls).toEqual([
		[env, 'request-1', false],
	])
})

test('self-publish is blocked when a package in the tree republished since the pinned snapshot', async () => {
	publishTree({ 'source-root': {}, 'source-dep': {} })
	const stale = summary(['source-dep'])
	stale.dependencySnapshot.dependencies[0]!.publishedCommit = 'commit-older'
	await expect(
		evaluateSelfPublish({ env, savedPackage, summary: stale }),
	).resolves.toEqual(
		expect.objectContaining({
			eligible: false,
			blocker: 'stale_dependencies',
		}),
	)
})

test('selfPublishPackage refuses when the package republished since the audited commit', async () => {
	mockModule.approvePackageCapabilitySet.mockResolvedValue({
		approval: { id: 'approval-2', publishedCommit: 'commit-newer' },
	})

	const result = await selfPublishPackage({
		env,
		request: sessionRequestContext('person-1', 'bea'),
		requestUrl: 'https://heykody.dev',
		ownerUserId: ownerId,
		actorUserId: 'person-1',
		savedPackage,
		summary: summary(),
	})
	expect(result).toMatchObject({
		ok: false,
		error: expect.stringContaining('published again since its security audit'),
	})
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(mockModule.approveWentPublicRequest).not.toHaveBeenCalled()
	expect(mockModule.logOrgAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			result: 'failure',
			details: expect.objectContaining({
				publishedCommit: 'commit-source-root',
				pinnedCommit: 'commit-newer',
			}),
		}),
	)
})

test('selfPublishPackage with a pending request id approves only that request and never enqueues', async () => {
	pinCurrentCommit()
	mockModule.setSelfPublishMark.mockResolvedValueOnce(true)
	mockModule.approveWentPublicRequest.mockResolvedValue({ ok: true })
	const input = {
		env,
		request: sessionRequestContext('person-1', 'bea'),
		requestUrl: 'https://heykody.dev',
		ownerUserId: ownerId,
		actorUserId: 'person-1',
		savedPackage,
		summary: summary(),
		pendingRequestId: 'seen-request',
	}

	await expect(selfPublishPackage(input)).resolves.toEqual({ ok: true })
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(mockModule.setSelfPublishMark).toHaveBeenCalledWith(
		env,
		'seen-request',
		true,
	)
	expect(mockModule.approveWentPublicRequest).toHaveBeenCalledWith(
		expect.objectContaining({ requestId: 'seen-request' }),
	)

	mockModule.approveWentPublicRequest.mockClear()
	mockModule.setSelfPublishMark.mockResolvedValueOnce(false)
	await expect(selfPublishPackage(input)).resolves.toMatchObject({
		ok: false,
	})
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(mockModule.approveWentPublicRequest).not.toHaveBeenCalled()
})

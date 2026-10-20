import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	updateSavedPackage: vi.fn(),
	setSavedPackageLockedAt: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	loadCapabilityApprovalSummary: vi.fn(),
	approvePackageCapabilitySet: vi.fn(),
	enqueueWentPublicApproval: vi.fn(),
	getPendingWentPublicApproval: vi.fn(),
	loadCurrentPackageSecurityAudit: vi.fn(),
	attemptSelfPublish: vi.fn(),
	applyMatchingPinInternetVisible: vi.fn(),
}))

vi.mock('#worker/package-capabilities/self-publish.ts', () => ({
	attemptSelfPublish: (...args: Array<unknown>) =>
		mockModule.attemptSelfPublish(...args),
	applyMatchingPinInternetVisible: (...args: Array<unknown>) =>
		mockModule.applyMatchingPinInternetVisible(...args),
}))

vi.mock('#worker/package-capabilities/security-audit-state.ts', () => ({
	loadCurrentPackageSecurityAudit: (...args: Array<unknown>) =>
		mockModule.loadCurrentPackageSecurityAudit(...args),
}))

vi.mock('#worker/package-capabilities/capability-approval-service.ts', () => ({
	loadCapabilityApprovalSummary: (...args: Array<unknown>) =>
		mockModule.loadCapabilityApprovalSummary(...args),
	approvePackageCapabilitySet: (...args: Array<unknown>) =>
		mockModule.approvePackageCapabilitySet(...args),
	clearInternetVisible: vi.fn(),
}))

vi.mock('#worker/package-capabilities/went-public-approval.ts', () => ({
	getPendingWentPublicApproval: (...args: Array<unknown>) =>
		mockModule.getPendingWentPublicApproval(...args),
	enqueueWentPublicApproval: (...args: Array<unknown>) =>
		mockModule.enqueueWentPublicApproval(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
	setSavedPackageLockedAt: (...args: Array<unknown>) =>
		mockModule.setSavedPackageLockedAt(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

const { packageUpdateCapability } = await import('./package-update.ts')

function update(
	changes: Record<string, unknown>,
	{
		userId = 'user-1' as string | null,
		packageId = 'pkg-1',
	}: { userId?: string | null; packageId?: string } = {},
) {
	if (userId) {
		mockModule.resolvePackageOwnerContext.mockResolvedValue({
			ownerUserId: userId,
			ownerScope: 'user',
			ownerEmail: 'user@example.com',
			actorUserId: userId,
		})
	}
	return packageUpdateCapability.handler(
		{ package_id: packageId, changes },
		{
			env: { APP_DB: {} } as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: userId
					? {
							userId: personIdFromStored(userId),
							email: 'user@example.com',
							displayName: 'User',
						}
					: null,
			}),
		},
	)
}

function createSavedPackage(input?: {
	hidden?: boolean
	lockedAt?: string | null
}) {
	return {
		id: 'pkg-1',
		userId: ownerIdFromStored('user-1'),
		kodyId: 'notes',
		name: '@user/notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		hasApp: false,
		hidden: input?.hidden ?? false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: input?.lockedAt ?? null,
		sourceId: 'source-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('packageUpdate hides and unhides a user-scoped package and returns persisted summaries', async () => {
	mockModule.updateSavedPackage.mockResolvedValue(true)
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(createSavedPackage({ hidden: true }))
		.mockResolvedValueOnce(createSavedPackage({ hidden: true }))
		.mockResolvedValueOnce(createSavedPackage({ hidden: false }))

	await expect(update({ hidden: true })).resolves.toMatchObject({
		ok: true,
		package: {
			package_id: 'pkg-1',
			kody_id: 'notes',
			slug: 'notes',
			name: '@user/notes',
			hidden: true,
			visibility: 'public',
			source_id: 'source-1',
		},
	})
	await expect(update({ hidden: false })).resolves.toMatchObject({
		ok: true,
		package: {
			package_id: 'pkg-1',
			kody_id: 'notes',
			slug: 'notes',
			hidden: false,
			visibility: 'public',
		},
	})

	expect(mockModule.updateSavedPackage.mock.calls).toEqual([
		[
			{},
			{ userId: ownerIdFromStored('user-1'), packageId: 'pkg-1', hidden: true },
		],
		[
			{},
			{
				userId: ownerIdFromStored('user-1'),
				packageId: 'pkg-1',
				hidden: false,
			},
		],
	])
	expect(mockModule.setSavedPackageLockedAt).not.toHaveBeenCalled()
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(4)
})

test('packageUpdate locks a package and rejects unlock with the owner website URL', async () => {
	const lockedPackage = createSavedPackage({
		lockedAt: '2026-08-28T12:00:00.000Z',
	})
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(lockedPackage)
		.mockResolvedValue(lockedPackage)
	mockModule.setSavedPackageLockedAt.mockResolvedValue(true)
	const lockedSummary = {
		ok: true,
		package: { package_id: 'pkg-1', locked_at: '2026-08-28T12:00:00.000Z' },
	}

	await expect(update({ locked: true })).resolves.toMatchObject(lockedSummary)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledWith(
		{},
		{
			userId: ownerIdFromStored('user-1'),
			packageId: 'pkg-1',
			lockedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		},
	)

	await expect(update({ locked: true })).resolves.toMatchObject(lockedSummary)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)

	const unlockError = await update({ locked: false }).catch(
		(error: unknown) => error,
	)
	expect(unlockError).toBeInstanceOf(McpCallerError)
	expect(unlockError).toMatchObject({
		message:
			'Agents cannot unlock packages. Send the owner to https://heykody.dev/@user/notes/settings to unlock publishes.',
	})
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)

	await expect(update({ hidden: true, locked: false })).rejects.toThrow(
		/cannot unlock/i,
	)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('packageUpdate rejects invalid changes and cross-user or unauthenticated access', async () => {
	await expect(update({})).rejects.toThrow(
		'Provide at least one supported package change.',
	)
	await expect(update({ name: '@user/renamed' })).rejects.toThrow(
		'Invalid input for capability "packageUpdate"',
	)

	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	await expect(
		update(
			{ hidden: true },
			{ userId: ownerIdFromStored('user-2'), packageId: 'other-user-package' },
		),
	).rejects.toThrow(/not found/i)

	await expect(update({ hidden: true }, { userId: null })).rejects.toThrow(
		/authenticated/i,
	)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('packageUpdate internet_visible without an approved capability set records the ask for one owner Approve', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'fp-1' },
		publishedCommit: 'commit-1',
		fingerprintMatchesApproval: false,
	})
	mockModule.enqueueWentPublicApproval.mockResolvedValue({ id: 'request-1' })
	mockModule.loadCurrentPackageSecurityAudit.mockResolvedValue({
		verdict: 'pass',
		summary: 'Checked',
		auditor: 'Audit agent',
		recordedBy: null,
		recordedAt: '2026-10-15T00:00:00.000Z',
	})
	mockModule.attemptSelfPublish.mockResolvedValue({
		status: 'blocked',
		blocker: 'declares_credentials',
		reasons: [{ kind: 'credential_entry', via: ['notes'] }],
		detail: {
			blocker: 'declares_credentials',
			reasons: [{ kind: 'credential_entry', via: ['notes'] }],
			message: 'Capability set lists credential a credential.',
		},
	})

	const result = await update({ internet_visible: true })
	expect(result).toMatchObject({
		ok: true,
		approval_url: 'https://heykody.dev/@user/notes/approve-capabilities',
		internet_visible_pending: true,
		self_publish_blocker: 'declares_credentials',
	})
	expect(result).not.toHaveProperty('security_audit')
	expect(mockModule.enqueueWentPublicApproval).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerUserId: 'user-1',
			publishedCommit: 'commit-1',
			fingerprint: 'fp-1',
			requestedByUserId: 'user-1',
		}),
	)
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('packageUpdate internet_visible with a matching pin turns serving on without another Approve', async () => {
	mockModule.approvePackageCapabilitySet.mockReset()
	mockModule.enqueueWentPublicApproval.mockReset()
	mockModule.applyMatchingPinInternetVisible.mockReset()
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce({
			...createSavedPackage(),
			isInternetVisible: true,
		})
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'fp-1' },
		publishedCommit: 'commit-1',
		fingerprintMatchesApproval: true,
	})
	mockModule.applyMatchingPinInternetVisible.mockResolvedValue({ ok: true })
	mockModule.attemptSelfPublish.mockResolvedValue({
		status: 'blocked',
		blocker: 'declares_capabilities',
		reasons: [{ kind: 'storage_entry', storageId: 'pkg-1', via: ['notes'] }],
		detail: {
			blocker: 'declares_capabilities',
			reasons: [{ kind: 'storage_entry', storageId: 'pkg-1', via: ['notes'] }],
			message: 'Capability set lists package storage for pkg-1.',
		},
	})
	mockModule.loadCurrentPackageSecurityAudit.mockResolvedValue({
		verdict: 'pass',
		summary: 'Checked',
		auditor: 'Audit agent',
		recordedBy: null,
		recordedAt: '2026-10-15T00:00:00.000Z',
	})

	const result = await update({ internet_visible: true })
	expect(result).toMatchObject({
		ok: true,
		package: expect.objectContaining({ internet_visible: true }),
	})
	expect(result).not.toHaveProperty('internet_visible_pending')
	expect(result).not.toHaveProperty('approval_url')
	expect(mockModule.applyMatchingPinInternetVisible).toHaveBeenCalledWith(
		expect.objectContaining({
			fingerprint: 'fp-1',
			ownerUserId: 'user-1',
		}),
	)
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
})

test('packageUpdate internet_visible with a matching pin asks to retry when apply fails and nothing is pending', async () => {
	mockModule.applyMatchingPinInternetVisible.mockReset()
	mockModule.enqueueWentPublicApproval.mockReset()
	mockModule.getPendingWentPublicApproval.mockReset()
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'fp-1' },
		publishedCommit: 'commit-1',
		fingerprintMatchesApproval: true,
	})
	mockModule.attemptSelfPublish.mockResolvedValue({
		status: 'blocked',
		blocker: 'declares_capabilities',
		reasons: [{ kind: 'storage_entry', storageId: 'pkg-1', via: ['notes'] }],
		detail: {
			blocker: 'declares_capabilities',
			reasons: [{ kind: 'storage_entry', storageId: 'pkg-1', via: ['notes'] }],
			message: 'Capability set lists package storage for pkg-1.',
		},
	})
	mockModule.applyMatchingPinInternetVisible.mockResolvedValue({
		ok: false,
		error: 'The published version changed.',
	})
	mockModule.getPendingWentPublicApproval.mockResolvedValueOnce(null)

	await expect(update({ internet_visible: true })).rejects.toThrow(
		'The published version changed. Nothing is pending for the owner',
	)
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()

	mockModule.getPendingWentPublicApproval.mockResolvedValueOnce({
		id: 'request-1',
	})
	const result = await update({ internet_visible: true })
	expect(result).toMatchObject({
		internet_visible_pending: true,
		approval_url: 'https://heykody.dev/@user/notes/approve-capabilities',
		self_publish_error: 'The published version changed.',
	})
})

test('packageUpdate internet_visible self-publishes a package that declares nothing', async () => {
	mockModule.approvePackageCapabilitySet.mockReset()
	mockModule.enqueueWentPublicApproval.mockReset()
	mockModule.updateSavedPackage.mockReset()
	const summary = {
		capabilitySet: { entries: [], fingerprint: 'fp-1' },
		publishedCommit: 'commit-1',
		fingerprintMatchesApproval: false,
	}
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce({
			...createSavedPackage(),
			isInternetVisible: true,
		})
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue(summary)
	mockModule.attemptSelfPublish.mockResolvedValue({ status: 'self_published' })

	const result = await update({ internet_visible: true })
	expect(result).toMatchObject({ ok: true, self_published: true })
	expect(result).not.toHaveProperty('approval_url')
	expect(result).not.toHaveProperty('internet_visible_pending')
	expect(mockModule.attemptSelfPublish).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerUserId: 'user-1',
			actorUserId: 'user-1',
			requestUrl: 'https://heykody.dev',
			summary,
		}),
	)
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()
})

test('packageUpdate internet_visible on an unaudited version tells the agent to audit and record it before the handoff', async () => {
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
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'fp-1' },
		publishedCommit: 'commit-1',
		fingerprintMatchesApproval: false,
	})
	mockModule.enqueueWentPublicApproval.mockResolvedValue({ id: 'request-1' })
	mockModule.loadCurrentPackageSecurityAudit.mockResolvedValue(null)

	const result = await update({ internet_visible: true })

	expect(mockModule.loadCurrentPackageSecurityAudit).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			ownerUserId: 'user-1',
			packageId: 'pkg-1',
			publishedCommit: 'commit-1',
			fingerprint: 'fp-1',
		}),
	)
	expect(result).toMatchObject({
		approval_url: 'https://heykody.dev/@user/notes/approve-capabilities',
		internet_visible_pending: true,
		self_publish_blocker: 'not_audited',
		security_audit: {
			operation: 'packageSecurityAuditRecord',
			http_route: 'POST /v1/packages/pkg-1/security-audits',
			args: {
				package_id: 'pkg-1',
				published_commit: 'commit-1',
				fingerprint: 'fp-1',
			},
		},
	})
	const step = (result as { security_audit: { next_step: string } })
		.security_audit
	expect(step.next_step).toContain('packageSecurityAuditRecord')
	expect(step.next_step).toContain(
		'https://heykody.dev/@user/notes/approve-capabilities',
	)
	expect(
		(result as { security_audit: { audit_prompt: string } }).security_audit
			.audit_prompt,
	).toContain('published_commit: "commit-1"')
})

test('packageUpdate internet_visible leaves the pending request for the owner when self-publish fails', async () => {
	mockModule.enqueueWentPublicApproval.mockReset()
	mockModule.approvePackageCapabilitySet.mockReset()
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.loadCapabilityApprovalSummary.mockResolvedValue({
		capabilitySet: { entries: [], fingerprint: 'fp-1' },
		publishedCommit: 'commit-1',
		fingerprintMatchesApproval: false,
	})
	mockModule.attemptSelfPublish.mockResolvedValue({
		status: 'failed',
		error: 'The published version changed.',
	})
	mockModule.getPendingWentPublicApproval.mockResolvedValueOnce({
		id: 'request-1',
	})

	const result = await update({ internet_visible: true })
	expect(result).toMatchObject({
		internet_visible_pending: true,
		approval_url: 'https://heykody.dev/@user/notes/approve-capabilities',
		self_publish_error: 'The published version changed.',
	})
	expect(result).not.toHaveProperty('self_published')
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
	expect(mockModule.approvePackageCapabilitySet).not.toHaveBeenCalled()

	mockModule.getPendingWentPublicApproval.mockResolvedValueOnce(null)
	await expect(update({ internet_visible: true })).rejects.toThrow(
		'The published version changed. Nothing is pending for the owner',
	)
	expect(mockModule.enqueueWentPublicApproval).not.toHaveBeenCalled()
})

import { DatabaseSync } from 'node:sqlite'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as NeedsClosure from './credential-needs-closure.ts'
import { type CredentialNeed } from './credential-needs.ts'

const mocks = vi.hoisted(() => ({
	before: [] as Array<CredentialNeed>,
	after: [] as Array<CredentialNeed>,
	computeError: null as Error | null,
	source: null as EntitySourceRow | null,
	publishFromExternalRef: vi.fn(),
	publishSession: vi.fn(),
	liveSessionIds: new Set<string>(),
	loadCapabilityApprovalSummary: vi.fn(),
	approvePackageCapabilitySet: vi.fn(),
	CapabilityApprovalError: class CapabilityApprovalError extends Error {
		constructor(message: string) {
			super(message)
			this.name = 'CapabilityApprovalError'
		}
	},
}))

vi.mock('./credential-needs-closure.ts', async (importOriginal) => ({
	...(await importOriginal<typeof NeedsClosure>()),
	loadPublishedCredentialNeeds: async () => mocks.before,
	computeCredentialNeedsClosure: async () => {
		if (mocks.computeError) throw mocks.computeError
		return { needs: mocks.after, conflicts: [] }
	},
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: async () => mocks.source,
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	getRepoSessionById: async (_env: unknown, input: { sessionId: string }) =>
		mocks.liveSessionIds.has(input.sessionId) ? { id: input.sessionId } : null,
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mocks.publishFromExternalRef(...args),
		publishSession: (...args: Array<unknown>) => mocks.publishSession(...args),
	}),
}))

vi.mock('#worker/package-capabilities/capability-approval-service.ts', () => ({
	loadCapabilityApprovalSummary: (...args: Array<unknown>) =>
		mocks.loadCapabilityApprovalSummary(...args),
	approvePackageCapabilitySet: (...args: Array<unknown>) =>
		mocks.approvePackageCapabilitySet(...args),
	CapabilityApprovalError: mocks.CapabilityApprovalError,
}))

const {
	describeCredentialNeedChange,
	diffCredentialNeeds,
	pausedSessionMovedMessage,
	requireCredentialNeedsApproval,
} = await import('./credential-needs-approval.ts')
const { approveCredentialNeedsRequest, loadPendingPackageApprovals } =
	await import('#app/account-package-approval-requests.ts')
const { enqueuePackageApprovalRequest, getPackageApprovalRequest } =
	await import('#worker/package-capabilities/approval-requests-repo.ts')

const ownerId = ownerIdFromStored('org-acme')
const manifestContent = JSON.stringify({
	name: '@acme/mailer',
	exports: { '.': './index.ts' },
	kody: { id: 'mailer', description: 'Sends mail' },
})

function need(key: string, overrides: Partial<CredentialNeed> = {}) {
	return {
		key,
		kind: 'secret' as const,
		provider: 'resend',
		description: '',
		multiple: false,
		...overrides,
	}
}

async function setup(options?: { internetVisible?: boolean }) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const env = { APP_DB: db } as unknown as Env
	const packageId = 'package-mailer'
	const now = '2026-10-13T00:00:00.000Z'
	const internetVisible = options?.internetVisible !== false
	await insertSavedPackage(
		db,
		{
			id: packageId,
			user_id: ownerId,
			name: '@acme/mailer',
			kody_id: 'mailer',
			description: 'Sends mail',
			tags_json: '[]',
			search_text: null,
			source_id: 'source-mailer',
			has_app: 0,
			has_skills: 0,
			hidden: 0,
			is_private: 1,
			is_internet_visible: internetVisible ? 1 : 0,
			created_at: now,
			updated_at: now,
		},
		null,
		{ stamp: false },
	)
	const source = {
		id: 'source-mailer',
		user_id: ownerId,
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: 'repo-mailer',
		published_commit: 'commit-old',
		manifest_path: 'package.json',
		source_root: '/',
	} as EntitySourceRow
	mocks.source = source
	const gate = (pendingCommit = 'commit-new') =>
		requireCredentialNeedsApproval({
			env,
			source,
			pendingCommit,
			files: { 'package.json': manifestContent },
			requestedByUserId: 'person-bea',
		})
	return { db, env, packageId, source, gate }
}

beforeEach(() => {
	mocks.before = []
	mocks.after = []
	mocks.computeError = null
	mocks.publishFromExternalRef.mockReset()
	mocks.publishSession.mockReset()
	mocks.liveSessionIds.clear()
	mocks.loadCapabilityApprovalSummary.mockReset()
	mocks.approvePackageCapabilitySet.mockReset()
	mocks.loadCapabilityApprovalSummary.mockResolvedValue({
		publishedCommit: 'commit-new',
		capabilitySet: { fingerprint: 'fp-after-needs', entries: [] },
		fingerprintMatchesApproval: false,
	})
	mocks.approvePackageCapabilitySet.mockResolvedValue({
		approval: { id: 'pin-1', publishedCommit: 'commit-new' },
		capabilitySet: { fingerprint: 'fp-after-needs', entries: [] },
		wentPublicRequest: null,
	})
})

test('only added or reshaped needs count as a change', () => {
	expect(
		diffCredentialNeeds(
			[
				need('MAIL'),
				need('GONE'),
				need('DOCS', { description: 'old' }),
				need('KIND'),
				need('MANY'),
			],
			[
				need('MAIL', { provider: 'postmark' }),
				need('DOCS', { description: 'new' }),
				need('SMS', { kind: 'login', provider: 'twilio', from: '@acme/sms' }),
				need('KIND', { kind: 'oauth' }),
				need('MANY', { multiple: true }),
			],
		),
	).toEqual([
		{
			key: 'KIND',
			change: 'changed',
			before: { kind: 'secret', provider: 'resend', multiple: false },
			after: { kind: 'oauth', provider: 'resend', multiple: false },
		},
		{
			key: 'MAIL',
			change: 'changed',
			before: { kind: 'secret', provider: 'resend', multiple: false },
			after: { kind: 'secret', provider: 'postmark', multiple: false },
		},
		{
			key: 'MANY',
			change: 'changed',
			before: { kind: 'secret', provider: 'resend', multiple: false },
			after: { kind: 'secret', provider: 'resend', multiple: true },
		},
		{
			key: 'SMS',
			change: 'added',
			after: { kind: 'login', provider: 'twilio', multiple: false },
			from: '@acme/sms',
		},
	])
})

test('turning on owner credentials for visitors reshapes a need; turning it off does not', () => {
	const shared = need('DB', { ownerCredentialForVisitors: true })
	const changes = diffCredentialNeeds([need('DB')], [shared])
	expect(changes).toEqual([
		{
			key: 'DB',
			change: 'changed',
			before: { kind: 'secret', provider: 'resend', multiple: false },
			after: {
				kind: 'secret',
				provider: 'resend',
				multiple: false,
				ownerCredentialForVisitors: true,
			},
		},
	])
	expect(diffCredentialNeeds([shared], [need('DB')])).toEqual([])
	expect(diffCredentialNeeds([shared], [shared])).toEqual([])
})

test('switching who supplies a need reshapes it; dropping publisher sharing does not', () => {
	const publisher = need('GITHUB', { supplier: 'publisher' })
	const executor = need('GITHUB', { supplier: 'executor', required: false })
	expect(diffCredentialNeeds([publisher], [executor])).toEqual([
		{
			key: 'GITHUB',
			change: 'changed',
			before: {
				kind: 'secret',
				provider: 'resend',
				multiple: false,
				supplier: 'publisher',
			},
			after: {
				kind: 'secret',
				provider: 'resend',
				multiple: false,
				supplier: 'executor',
				required: false,
			},
		},
	])
	expect(diffCredentialNeeds([executor], [need('GITHUB')])).toHaveLength(1)
	expect(diffCredentialNeeds([publisher], [need('GITHUB')])).toEqual([])
	expect(
		describeCredentialNeedChange(
			diffCredentialNeeds([publisher], [executor])[0]!,
		),
	).toContain('each person who uses it supplies their own, optional')
})

test('a private package publishes credential-need changes without approval; internet-visible still pauses', async () => {
	mocks.before = [need('MAIL')]
	mocks.after = [need('MAIL'), need('NEW')]

	const privatePkg = await setup({ internetVisible: false })
	await expect(privatePkg.gate()).resolves.toBeNull()
	await expect(
		loadPendingPackageApprovals({
			env: privatePkg.env,
			ownerUserId: ownerId,
			packageId: privatePkg.packageId,
			publishedCommit: 'commit-old',
		}),
	).resolves.toEqual([])

	const visible = await setup({ internetVisible: true })
	const paused = await visible.gate()
	expect(paused).toMatchObject({
		packageId: visible.packageId,
		pendingCommit: 'commit-new',
		changes: [{ key: 'NEW', change: 'added' }],
	})
	await expect(
		loadPendingPackageApprovals({
			env: visible.env,
			ownerUserId: ownerId,
			packageId: visible.packageId,
			publishedCommit: 'commit-old',
		}),
	).resolves.toEqual([
		expect.objectContaining({
			id: paused?.requestId,
			reason: 'credential_needs_changed',
			approveAction: 'approve-credential-needs',
		}),
	])
})

test('a needs change queues one pending approval per package; unchanged, removed, first, and failed computes publish', async () => {
	const t = await setup({ internetVisible: true })
	mocks.before = [need('MAIL'), need('OLD')]
	mocks.after = [need('MAIL')]
	await expect(t.gate()).resolves.toBeNull()

	mocks.computeError = new Error('dependency vanished')
	mocks.after = [need('NEW')]
	await expect(t.gate()).resolves.toBeNull()
	mocks.computeError = null

	await expect(
		requireCredentialNeedsApproval({
			env: t.env,
			source: { ...t.source, published_commit: null },
			pendingCommit: 'commit-first',
			files: { 'package.json': manifestContent },
		}),
	).resolves.toBeNull()

	const first = await t.gate()
	expect(first).toMatchObject({
		packageId: t.packageId,
		packageName: '@acme/mailer',
		kodyId: 'mailer',
		pendingCommit: 'commit-new',
		changes: [{ key: 'NEW', change: 'added' }],
	})
	const again = await t.gate()
	expect(again?.requestId).toBe(first?.requestId)

	const newer = await t.gate('commit-newer')
	expect(newer?.requestId).not.toBe(first?.requestId)
	await expect(
		getPackageApprovalRequest(t.db, {
			id: first!.requestId,
			packageId: t.packageId,
			ownerUserId: ownerId,
		}),
	).resolves.toMatchObject({ status: 'superseded' })
	const pending = await loadPendingPackageApprovals({
		env: t.env,
		ownerUserId: ownerId,
		packageId: t.packageId,
		publishedCommit: 'commit-old',
	})
	expect(pending).toEqual([
		expect.objectContaining({
			id: newer?.requestId,
			reason: 'credential_needs_changed',
			pendingCommit: 'commit-newer',
			approveAction: 'approve-credential-needs',
		}),
	])
	await expect(
		loadPendingPackageApprovals({
			env: t.env,
			ownerUserId: ownerId,
			packageId: t.packageId,
			publishedCommit: 'commit-later',
		}),
	).resolves.toEqual([])
})

test('approving needs on a private package does not pin internet-visible capabilities', async () => {
	const t = await setup({ internetVisible: false })
	const savedPackage = {
		id: t.packageId,
		userId: ownerId,
		sourceId: 'source-mailer',
		isInternetVisible: false,
	} as SavedPackageRecord
	const request = await enqueuePackageApprovalRequest(t.db, {
		packageId: t.packageId,
		ownerUserId: ownerId,
		reason: 'credential_needs_changed',
		pendingCommit: 'commit-new',
		baseCommit: 'commit-old',
		details: { changes: [] },
		requestedByUserId: null,
	})
	mocks.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
	})
	await expect(
		approveCredentialNeedsRequest({
			env: t.env,
			request: new Request('https://kody.test/approve'),
			savedPackage,
			ownerUserId: ownerId,
			actorUserId: 'person-bea',
			requestId: request.id,
		}),
	).resolves.toEqual({ ok: true })
	expect(mocks.approvePackageCapabilitySet).not.toHaveBeenCalled()
})

test('a failed capability pin after needs publish leaves the request pending for retry', async () => {
	const t = await setup({ internetVisible: true })
	const savedPackage = {
		id: t.packageId,
		userId: ownerId,
		sourceId: 'source-mailer',
		isInternetVisible: true,
	} as SavedPackageRecord
	const request = await enqueuePackageApprovalRequest(t.db, {
		packageId: t.packageId,
		ownerUserId: ownerId,
		reason: 'credential_needs_changed',
		pendingCommit: 'commit-new',
		baseCommit: 'commit-old',
		details: {
			changes: [
				{
					key: 'database',
					change: 'changed',
					before: { provider: 'database', multiple: false },
					after: {
						provider: 'database',
						multiple: false,
						ownerCredentialForVisitors: true,
					},
				},
			],
		},
		requestedByUserId: null,
	})
	mocks.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
	})
	mocks.approvePackageCapabilitySet.mockRejectedValueOnce(
		new mocks.CapabilityApprovalError(
			'The capability set changed since you loaded this page. Reload, review the updated summary, and approve again.',
		),
	)
	const approve = () =>
		approveCredentialNeedsRequest({
			env: t.env,
			request: new Request('https://kody.test/approve'),
			savedPackage,
			ownerUserId: ownerId,
			actorUserId: 'person-bea',
			requestId: request.id,
		})
	await expect(approve()).resolves.toMatchObject({ ok: false, status: 409 })
	await expect(
		getPackageApprovalRequest(t.db, {
			id: request.id,
			packageId: t.packageId,
			ownerUserId: ownerId,
		}),
	).resolves.toMatchObject({ status: 'pending' })

	// Publish already moved the source off the pause base; the page still
	// shows the request, and a second Approve pins without republishing.
	mocks.source = { ...t.source, published_commit: 'commit-new' }
	await expect(
		loadPendingPackageApprovals({
			env: t.env,
			ownerUserId: ownerId,
			packageId: t.packageId,
			publishedCommit: 'commit-new',
		}),
	).resolves.toEqual([
		expect.objectContaining({
			id: request.id,
			approveAction: 'approve-credential-needs',
			pendingCommit: 'commit-new',
		}),
	])
	mocks.approvePackageCapabilitySet.mockClear()
	mocks.publishFromExternalRef.mockClear()
	mocks.approvePackageCapabilitySet.mockResolvedValueOnce({
		approval: { id: 'pin-retry', publishedCommit: 'commit-new' },
		capabilitySet: { fingerprint: 'fp-after-needs', entries: [] },
		wentPublicRequest: null,
	})
	await expect(approve()).resolves.toEqual({ ok: true })
	expect(mocks.publishFromExternalRef).not.toHaveBeenCalled()
	expect(mocks.approvePackageCapabilitySet).toHaveBeenCalledTimes(1)
	await expect(
		getPackageApprovalRequest(t.db, {
			id: request.id,
			packageId: t.packageId,
			ownerUserId: ownerId,
		}),
	).resolves.toMatchObject({ status: 'approved' })
})

test('approving publishes the paused commit past the pause; a moved base supersedes it', async () => {
	const t = await setup({ internetVisible: true })
	const savedPackage = {
		id: t.packageId,
		userId: ownerId,
		sourceId: 'source-mailer',
		isInternetVisible: true,
	} as SavedPackageRecord
	const enqueue = (pendingCommit: string) =>
		enqueuePackageApprovalRequest(t.db, {
			packageId: t.packageId,
			ownerUserId: ownerId,
			reason: 'credential_needs_changed',
			pendingCommit,
			baseCommit: 'commit-old',
			details: { changes: [] },
			requestedByUserId: null,
		})
	const approve = (requestId: string) =>
		approveCredentialNeedsRequest({
			env: t.env,
			request: new Request('https://kody.test/approve'),
			savedPackage,
			ownerUserId: ownerId,
			actorUserId: 'person-bea',
			requestId,
		})
	const request = await enqueue('commit-new')
	mocks.publishFromExternalRef.mockResolvedValueOnce({
		status: 'checks_failed',
		failed_checks: [],
		manifest: null,
		run_id: 'run-1',
	})
	await expect(approve(request.id)).resolves.toMatchObject({
		ok: false,
		status: 400,
	})
	mocks.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-new',
	})
	await expect(approve(request.id)).resolves.toEqual({ ok: true })
	expect(mocks.publishFromExternalRef).toHaveBeenLastCalledWith(
		expect.objectContaining({
			newCommit: 'commit-new',
			expectedHead: 'commit-new',
			allowForce: false,
			destructiveOverwriteConfirmed: false,
			allowLockedPublish: true,
			credentialNeedsApproved: true,
		}),
	)
	expect(mocks.approvePackageCapabilitySet).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedFingerprint: 'fp-after-needs',
			enqueueWentPublic: false,
			recordPin: true,
			actorUserId: 'person-bea',
		}),
	)
	expect(
		(
			await getPackageApprovalRequest(t.db, {
				id: request.id,
				packageId: t.packageId,
				ownerUserId: ownerId,
			})
		)?.status,
	).toBe('approved')
	await expect(approve(request.id)).resolves.toMatchObject({
		ok: false,
		status: 409,
	})

	const stale = await enqueue('commit-two')
	mocks.source = { ...t.source, published_commit: 'commit-codemod' }
	mocks.publishFromExternalRef.mockClear()
	await expect(approve(stale.id)).resolves.toMatchObject({
		ok: false,
		status: 409,
		error: expect.stringContaining('Publish again'),
	})
	expect(mocks.publishFromExternalRef).not.toHaveBeenCalled()
	await expect(approve('missing')).resolves.toMatchObject({ status: 404 })

	mocks.source = t.source
	const overtaken = await enqueue('commit-three')
	mocks.publishFromExternalRef.mockRejectedValueOnce(
		new Error(
			'Artifacts HEAD changed from "commit-three" to "commit-four" before publish.',
		),
	)
	await expect(approve(overtaken.id)).resolves.toMatchObject({
		ok: false,
		status: 409,
		error: expect.stringContaining('Publish again'),
	})
	await expect(
		getPackageApprovalRequest(t.db, {
			id: overtaken.id,
			packageId: t.packageId,
			ownerUserId: ownerId,
		}),
	).resolves.toMatchObject({ status: 'superseded' })

	const forced = await enqueuePackageApprovalRequest(t.db, {
		packageId: t.packageId,
		ownerUserId: ownerId,
		reason: 'credential_needs_changed',
		pendingCommit: 'commit-orphan',
		baseCommit: 'commit-old',
		details: {
			changes: [],
			externalPublish: {
				allowForce: true,
				destructiveOverwriteConfirmed: true,
			},
		},
		requestedByUserId: null,
	})
	mocks.publishFromExternalRef.mockResolvedValueOnce({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: 'commit-orphan',
	})
	await expect(approve(forced.id)).resolves.toEqual({ ok: true })
	expect(mocks.publishFromExternalRef).toHaveBeenLastCalledWith(
		expect.objectContaining({
			newCommit: 'commit-orphan',
			allowForce: true,
			destructiveOverwriteConfirmed: true,
		}),
	)
})

test('approving a paused session publish re-runs that session at the paused commit', async () => {
	const t = await setup({ internetVisible: true })
	const savedPackage = {
		id: t.packageId,
		userId: ownerId,
		sourceId: 'source-mailer',
		isInternetVisible: true,
	} as SavedPackageRecord
	mocks.after = [need('NEW')]
	const paused = await requireCredentialNeedsApproval({
		env: t.env,
		source: t.source,
		pendingCommit: 'commit-paused',
		files: { 'package.json': manifestContent },
		pausedSession: {
			sessionId: 'source-sync-1',
			force: true,
			destructiveOverwriteConfirmed: true,
			privateVisibilityChangeConfirmed: false,
		},
	})
	const approve = (requestId: string) =>
		approveCredentialNeedsRequest({
			env: t.env,
			request: new Request('https://kody.test/approve'),
			savedPackage,
			ownerUserId: ownerId,
			actorUserId: 'person-bea',
			requestId,
		})
	const status = async (requestId: string) =>
		(
			await getPackageApprovalRequest(t.db, {
				id: requestId,
				packageId: t.packageId,
				ownerUserId: ownerId,
			})
		)?.status
	const pause = async (pendingCommit: string, sessionId: string) =>
		(await requireCredentialNeedsApproval({
			env: t.env,
			source: t.source,
			pendingCommit,
			files: { 'package.json': manifestContent },
			pausedSession: {
				sessionId,
				force: false,
				destructiveOverwriteConfirmed: false,
				privateVisibilityChangeConfirmed: false,
			},
		}))!.requestId
	mocks.liveSessionIds.add('source-sync-1')
	mocks.publishSession.mockResolvedValueOnce({
		status: 'ok',
		sessionId: 'source-sync-1',
		publishedCommit: 'commit-paused',
		message: 'Published.',
	})
	await expect(approve(paused!.requestId)).resolves.toEqual({ ok: true })
	expect(mocks.publishSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sessionId: 'source-sync-1',
			force: true,
			destructiveOverwriteConfirmed: true,
			allowLockedPublish: true,
			credentialNeedsApproved: true,
			expectedHeadCommit: 'commit-paused',
		}),
	)
	expect(mocks.publishFromExternalRef).not.toHaveBeenCalled()

	const gone = await pause('commit-paused-2', 'source-sync-2')
	mocks.publishSession.mockClear()
	await expect(approve(gone)).resolves.toMatchObject({
		ok: false,
		status: 409,
		error: expect.stringContaining('Publish again'),
	})
	expect(mocks.publishSession).not.toHaveBeenCalled()
	expect(await status(gone)).toBe('superseded')

	const moved = await pause('commit-paused-3', 'source-sync-3')
	mocks.liveSessionIds.add('source-sync-3')
	mocks.publishSession.mockRejectedValueOnce(
		new Error(pausedSessionMovedMessage('source-sync-3', 'commit-paused-3')),
	)
	await expect(approve(moved)).resolves.toMatchObject({ status: 409 })
	expect(await status(moved)).toBe('superseded')

	const blip = await pause('commit-paused-4', 'source-sync-4')
	mocks.liveSessionIds.add('source-sync-4')
	mocks.publishSession.mockRejectedValueOnce(new Error('Network blip'))
	await expect(approve(blip)).rejects.toThrow('Network blip')
	expect(await status(blip)).toBe('pending')
})

test('flipping an executor need between optional and required reshapes it', () => {
	const optional = need('GITHUB', { supplier: 'executor', required: false })
	const required = need('GITHUB', { supplier: 'executor', required: true })
	expect(diffCredentialNeeds([optional], [required])).toHaveLength(1)
	expect(diffCredentialNeeds([required], [optional])).toHaveLength(1)
	expect(
		diffCredentialNeeds([required], [need('GITHUB', { supplier: 'executor' })]),
	).toEqual([])
})

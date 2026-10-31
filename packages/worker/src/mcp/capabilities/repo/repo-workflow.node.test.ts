import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as RepoSessions from '#worker/repo/repo-sessions.ts'

const mockModule = vi.hoisted(() => ({
	getActiveRepoSessionByConversation: vi.fn(),
	countActiveRepoSessions: vi.fn<typeof RepoSessions.countActiveRepoSessions>(
		async () => 0,
	),
	getRepoSessionById: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	getActiveRepoSessionByConversation: (...args: Array<unknown>) =>
		mockModule.getActiveRepoSessionByConversation(...args),
	countActiveRepoSessions: (
		...args: Parameters<typeof RepoSessions.countActiveRepoSessions>
	) => mockModule.countActiveRepoSessions(...args),
	getRepoSessionById: (...args: Array<unknown>) =>
		mockModule.getRepoSessionById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

const { repoOpenSessionCapability } = await import('./repo-open-session.ts')
const { repoPublishSessionCapability } =
	await import('./repo-publish-session.ts')
const { repoEditFilesCapability } = await import('./repo-edit-files.ts')
const { repoCommitCapability } = await import('./repo-commit.ts')
const { repoRunChecksCapability } = await import('./repo-run-checks.ts')

const ctx = {
	env: {
		APP_DB: {
			prepare: () => ({
				bind: () => ({
					first: async () => ({
						username: 'user',
						plan: 'max',
						stripe_plan: null,
					}),
				}),
			}),
		},
	} as unknown as Env,
	callerContext: createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user@example.com',
			displayName: 'user',
		},
	}),
}

function setupRepoRpc() {
	for (const mock of Object.values(mockModule)) mock.mockReset()
	mockModule.countActiveRepoSessions.mockResolvedValue(0)
	mockModule.getRepoSessionById.mockResolvedValue({
		id: 'session-1',
		user_id: ownerIdFromStored('user-1'),
		source_id: 'source-package-1',
	})
	mockModule.getEntitySourceByIdForUser.mockResolvedValue({
		id: 'source-package-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
	})
	const rpc = {
		openSession: vi.fn(),
		getSessionInfo: vi.fn(),
		applyEdits: vi.fn(),
		sessionCommit: vi.fn(),
		runChecks: vi.fn(),
		publishSession: vi.fn(),
		listPublishedPackageArtifactTargets: vi.fn(
			async (): Promise<Array<unknown>> => [],
		),
		rebuildPublishedPackageArtifact: vi.fn(),
	}
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	return rpc
}

function sessionInfo(overrides: Record<string, unknown> = {}) {
	return {
		id: 'session-1',
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-1',
		source_branch: 'main',
		conversation_id: null,
		last_checkpoint_commit: 'commit-package-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:01:00.000Z',
		published_commit: 'commit-package-1',
		manifest_path: 'package.json',
		entity_type: 'package',
		...overrides,
	}
}

function stubPackageLookup(sourceOverrides: Record<string, unknown> = {}) {
	mockModule.resolveSavedPackageRef.mockResolvedValueOnce({
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@kody/triage-github-pr',
		kodyId: 'triage-github-pr',
		description: 'Triages one PR',
		tags: ['github', 'triage'],
		searchText: null,
		sourceId: 'source-package-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-04-18T00:00:00.000Z',
		updatedAt: '2026-04-18T00:00:00.000Z',
	})
	mockModule.getEntitySourceByIdForUser.mockResolvedValueOnce({
		id: 'source-package-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-package-1',
		published_commit: 'commit-package-1',
		indexed_commit: 'commit-package-1',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
		...sourceOverrides,
	})
}

test('repo open session workflow and conversation conflict guard', async () => {
	const openRpc = setupRepoRpc()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce(null)
	stubPackageLookup()
	openRpc.openSession.mockResolvedValueOnce(sessionInfo())

	const opened = await repoOpenSessionCapability.handler(
		{ target: { kind: 'package', kody_id: 'triage-github-pr' } },
		ctx,
	)

	expect(opened.resolved_target).toEqual({
		kind: 'package',
		source_id: 'source-package-1',
		package_id: 'package-1',
		kody_id: 'triage-github-pr',
		name: '@kody/triage-github-pr',
	})
	expect(openRpc.openSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-package-1',
			userId: ownerIdFromStored('user-1'),
			sourceRoot: '/',
		}),
	)

	setupRepoRpc()
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce({
		id: 'session-other',
		source_id: 'source-other',
	})
	stubPackageLookup({ id: 'source-other', entity_id: 'package-other' })

	await expect(
		repoOpenSessionCapability.handler(
			{
				target: { kind: 'package', kody_id: 'triage-github-pr' },
				conversation_id: 'conversation-1',
			},
			ctx,
		),
	).rejects.toThrow(Error)
})

test('repo edit → commit → checks → publish session workflow', async () => {
	const rpc = setupRepoRpc()
	const edits = [
		{
			kind: 'write',
			path: 'src/index.ts',
			content: 'export const done = true\n',
		},
		{ kind: 'delete', path: 'src/remove.ts' },
		{ kind: 'move', path: 'src/old.ts', to: 'src/new.ts' },
	]
	rpc.applyEdits.mockResolvedValueOnce({
		dryRun: true,
		totalChanged: 3,
		edits: [
			['src/index.ts', 'export const done = true\n'],
			['src/remove.ts', ''],
			['src/new.ts', 'moved\n'],
		].map(([path, content]) => ({ path, changed: true, content, diff: '@@' })),
	})
	rpc.sessionCommit.mockResolvedValueOnce({
		oid: 'commit-session-1',
		message: 'Update index',
	})
	rpc.runChecks.mockResolvedValueOnce({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'Manifest ok' }],
		manifest: {
			name: '@kody/triage-github-pr',
			kody: { id: 'triage-github-pr', description: 'Triages one PR' },
		},
		runId: 'check-1',
		treeHash: 'tree-1',
		checkedAt: '2026-04-18T00:02:00.000Z',
	})
	rpc.getSessionInfo.mockResolvedValue(
		sessionInfo({
			id: 'session-existing',
			conversation_id: 'conversation-1',
			last_checkpoint_commit: 'commit-session-1',
			last_check_run_id: 'check-1',
			last_check_tree_hash: 'tree-1',
			updated_at: '2026-04-18T00:02:00.000Z',
		}),
	)
	rpc.publishSession.mockResolvedValueOnce({
		status: 'ok',
		sessionId: 'session-existing',
		publishedCommit: 'commit-published',
		message: 'Published session.',
	})
	const session = { session_id: 'session-existing' }

	const edited = await repoEditFilesCapability.handler(
		{ ...session, edits, dry_run: true, rollback_on_error: false },
		ctx,
	)
	const committed = await repoCommitCapability.handler(
		{ ...session, message: 'Update index' },
		ctx,
	)
	const checks = await repoRunChecksCapability.handler(session, ctx)
	const published = await repoPublishSessionCapability.handler(session, ctx)

	expect(rpc.applyEdits).toHaveBeenCalledWith({
		sessionId: 'session-existing',
		userId: ownerIdFromStored('user-1'),
		edits,
		dryRun: true,
		rollbackOnError: false,
	})
	expect(edited.total_changed).toBe(3)
	expect(edited.dry_run).toBe(true)
	expect(rpc.sessionCommit).toHaveBeenCalledWith({
		sessionId: 'session-existing',
		userId: ownerIdFromStored('user-1'),
		message: 'Update index',
	})
	expect(committed).toEqual({
		oid: 'commit-session-1',
		message: 'Update index',
	})
	expect(checks.ok).toBe(true)
	expect(published).toMatchObject({
		status: 'ok',
		session_id: 'session-existing',
		published_commit: 'commit-published',
	})
})

test('repoPublishSession covers base_moved repair, artifact rebuild, and rebuild failures', async () => {
	const target = {
		kind: 'module',
		artifactName: '.',
		entryPoint: 'src/index.ts',
		bundleKind: 'module',
	}
	const publishedOk = {
		status: 'ok',
		sessionId: 'session-1',
		publishedCommit: 'commit-new',
		message: 'Published session.',
	}
	const setupPublish = (publishResult: Record<string, unknown>) => {
		const rpc = setupRepoRpc()
		rpc.getSessionInfo.mockResolvedValueOnce(
			sessionInfo({
				base_commit: 'commit-old',
				last_checkpoint_commit: 'commit-old',
				last_check_run_id: 'check-1',
				last_check_tree_hash: 'tree-1',
				updated_at: '2026-04-18T00:02:00.000Z',
				published_commit: 'commit-old',
			}),
		)
		rpc.publishSession.mockResolvedValueOnce(publishResult)
		rpc.listPublishedPackageArtifactTargets.mockResolvedValueOnce([target])
		return rpc
	}
	const publish = () =>
		repoPublishSessionCapability.handler({ session_id: 'session-1' }, ctx)

	setupPublish({
		status: 'base_moved',
		sessionId: 'session-1',
		publishedCommit: null,
		message:
			'The source repo has moved since this session opened. Rebase the session before publishing.',
		repairHint: 'repoRebaseSession',
		sessionBaseCommit: 'commit-old',
		currentPublishedCommit: 'commit-new',
	})
	expect(await publish()).toMatchObject({
		status: 'base_moved',
		session_id: 'session-1',
		published_commit: null,
		repair_hint: 'repoRebaseSession',
		session_base_commit: 'commit-old',
		current_published_commit: 'commit-new',
	})

	const publishRpc = setupPublish(publishedOk)
	expect(await publish()).toMatchObject({
		status: 'ok',
		session_id: 'session-1',
		published_commit: 'commit-new',
	})
	expect(publishRpc.publishSession).toHaveBeenCalledWith({
		sessionId: 'session-1',
		userId: ownerIdFromStored('user-1'),
		rebuildPackageArtifacts: false,
		expectedPackageScope: 'user',
		privateVisibilityChangeConfirmed: false,
		requestedByUserId: 'user-1',
		publisherRequest: expect.objectContaining({
			actor: expect.objectContaining({ userId: 'user-1' }),
		}),
	})
	expect(publishRpc.rebuildPublishedPackageArtifact).toHaveBeenCalledWith({
		sessionId: 'session-1',
		sourceId: 'source-package-1',
		userId: ownerIdFromStored('user-1'),
		publishedCommit: 'commit-new',
		target,
		baseUrl: 'https://heykody.dev',
	})

	const failureRpc = setupPublish(publishedOk)
	failureRpc.rebuildPublishedPackageArtifact.mockRejectedValueOnce(
		new Error('bundle too large'),
	)
	await expect(publish()).rejects.toThrow(/bundle artifact rebuild failed/i)
})

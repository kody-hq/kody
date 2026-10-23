import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceByIdForUser: vi.fn(),
	getSavedPackageById: vi.fn(),
	listRepoSessionsBySource: vi.fn(),
	listRepoSessionsByUser: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	listRepoSessionsBySource: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsBySource(...args),
	listRepoSessionsByUser: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsByUser(...args),
}))

const { repoListSessionsCapability } = await import('./repo-list-sessions.ts')

function listSessions(args: Record<string, unknown> = {}) {
	return repoListSessionsCapability.handler(args, {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('user-1'),
				email: 'user-1@example.com',
				displayName: 'user-1',
			},
		}),
	})
}

function createSession(
	id: string,
	overrides: Partial<{
		user_id: string
		source_id: string
		status: 'active' | 'published' | 'discarded'
		updated_at: string
	}> = {},
) {
	const sourceId = overrides.source_id ?? 'source-1'
	const status = overrides.status ?? 'active'
	return {
		id,
		user_id: overrides.user_id ?? 'user-1',
		source_id: sourceId,
		source_repo_id: `repo-${sourceId}`,
		session_branch: `sessions/${id}`,
		source_branch: 'main',
		base_commit: `base-${id}`,
		source_root: '/',
		conversation_id: `conversation-${id}`,
		status,
		expires_at: status === 'active' ? null : '2026-05-12T00:00:00.000Z',
		last_checkpoint_at: null,
		last_checkpoint_commit: `checkpoint-${id}`,
		last_check_run_id: `check-${id}`,
		last_check_tree_hash: `tree-${id}`,
		created_at: '2026-04-28T00:00:00.000Z',
		updated_at: overrides.updated_at ?? '2026-04-28T00:00:00.000Z',
	}
}

function stubSources({ missingSourceId }: { missingSourceId?: string } = {}) {
	for (const fn of Object.values(mockModule)) fn.mockReset()
	mockModule.getEntitySourceByIdForUser.mockImplementation(
		async (_db: D1Database, input: { id: string; userId: string }) =>
			input.id === missingSourceId || input.userId !== 'user-1'
				? null
				: {
						id: input.id,
						user_id: ownerIdFromStored('user-1'),
						entity_kind: 'package' as const,
						entity_id: 'package-1',
						repo_id: `repo-${input.id}`,
						published_commit: 'commit-published',
						indexed_commit: 'commit-indexed',
						manifest_path: 'package.json',
						source_root: '/',
						last_external_check_at: null,
						external_check_until: null,
						created_at: '2026-04-28T00:00:00.000Z',
						updated_at: '2026-04-28T00:00:00.000Z',
					},
	)
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@user/demo',
		kodyId: 'demo',
		description: 'Demo package',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-04-28T00:00:00.000Z',
		updatedAt: '2026-04-28T00:00:00.000Z',
	})
}

const ids = (result: { sessions: Array<{ id: string }> }) =>
	result.sessions.map((session) => session.id)

test('repoListSessions defaults to active sessions for the signed-in user', async () => {
	stubSources()
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession('session-active', { updated_at: '2026-04-28T00:03:00.000Z' }),
		createSession('session-published', {
			status: 'published',
			updated_at: '2026-04-28T00:02:00.000Z',
		}),
		createSession('session-other-user', {
			user_id: ownerIdFromStored('other-user'),
			updated_at: '2026-04-28T00:01:00.000Z',
		}),
	])

	const result = await listSessions()

	expect(mockModule.listRepoSessionsByUser).toHaveBeenCalledWith(
		expect.anything(),
		'user-1',
	)
	expect(result.sessions).toHaveLength(1)
	expect(result.sessions[0]).toMatchObject({
		id: 'session-active',
		status: 'active',
		resolved_target: {
			kind: 'package',
			package_id: 'package-1',
		},
	})
})

test('repoListSessions status all includes inactive sessions', async () => {
	stubSources()
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession('session-active'),
		createSession('session-published', { status: 'published' }),
		createSession('session-discarded', { status: 'discarded' }),
	])

	const result = await listSessions({ status: 'all' })

	expect(result.sessions.map((session) => session.status)).toEqual([
		'active',
		'published',
		'discarded',
	])
	expect(result.sessions[1]?.expires_at).toBe('2026-05-12T00:00:00.000Z')
})

test('repoListSessions does not return rows for another user even if storage is malformed', async () => {
	stubSources()
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession('session-other-user', {
			user_id: ownerIdFromStored('other-user'),
		}),
	])

	expect((await listSessions()).sessions).toEqual([])
	expect(mockModule.getEntitySourceByIdForUser).not.toHaveBeenCalled()
})

test('repoListSessions supports source_id narrowing and applies limit after dropping missing sources', async () => {
	stubSources()
	mockModule.listRepoSessionsBySource.mockResolvedValue([
		createSession('session-source-new', {
			source_id: 'source-2',
			updated_at: '2026-04-28T00:02:00.000Z',
		}),
		createSession('session-source-old', {
			source_id: 'source-2',
			updated_at: '2026-04-28T00:01:00.000Z',
		}),
	])

	expect(ids(await listSessions({ source_id: 'source-2', limit: 1 }))).toEqual([
		'session-source-new',
	])
	expect(mockModule.listRepoSessionsBySource).toHaveBeenCalledWith(
		expect.anything(),
		{ userId: ownerIdFromStored('user-1'), sourceId: 'source-2' },
	)
	expect(mockModule.listRepoSessionsByUser).not.toHaveBeenCalled()

	stubSources({ missingSourceId: 'source-missing' })
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession('session-missing-source', {
			source_id: 'source-missing',
			updated_at: '2026-04-28T00:03:00.000Z',
		}),
		createSession('session-valid', {
			source_id: 'source-1',
			updated_at: '2026-04-28T00:02:00.000Z',
		}),
	])

	expect(ids(await listSessions({ limit: 1 }))).toEqual(['session-valid'])
	expect(mockModule.getEntitySourceByIdForUser).toHaveBeenCalledTimes(2)
})

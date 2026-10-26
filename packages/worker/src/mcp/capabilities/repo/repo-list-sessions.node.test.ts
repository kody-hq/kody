import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

const mockModule = vi.hoisted(() => ({
	checkPermission: vi.fn(),
	listEntitySourcesByIdsForUser: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	listRepoSessionsBySource: vi.fn(),
	listRepoSessionsByUser: vi.fn(),
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/authorization/authorize.ts')>()
	return {
		...actual,
		checkPermission: (...args: Parameters<typeof actual.checkPermission>) =>
			mockModule.checkPermission(...args),
	}
})

vi.mock('#worker/repo/entity-sources.ts', () => ({
	listEntitySourcesByIdsForUser: (...args: Array<unknown>) =>
		mockModule.listEntitySourcesByIdsForUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByIds: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByIds(...args),
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

function packageSource(id: string, entityId = 'package-1'): EntitySourceRow {
	return {
		id,
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: entityId,
		repo_id: `repo-${id}`,
		published_commit: 'commit-published',
		indexed_commit: 'commit-indexed',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-28T00:00:00.000Z',
		updated_at: '2026-04-28T00:00:00.000Z',
	}
}

function repoSource(id: string): EntitySourceRow {
	return {
		...packageSource(id, 'repo-entity-1'),
		entity_kind: 'repo',
		entity_id: 'repo-entity-1',
	}
}

function savedPackage(
	overrides: Partial<SavedPackageRecord> = {},
): SavedPackageRecord {
	return {
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@user/demo',
		kodyId: 'demo',
		description: 'Demo package',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-04-28T00:00:00.000Z',
		updatedAt: '2026-04-28T00:00:00.000Z',
		...overrides,
	}
}

function stubSources({
	sources,
	packages,
	deniedPackageIds = [],
}: {
	sources?: Array<EntitySourceRow>
	packages?: Array<SavedPackageRecord>
	deniedPackageIds?: ReadonlyArray<string>
} = {}) {
	for (const fn of Object.values(mockModule)) fn.mockReset()
	const resolvedSources = sources ?? [packageSource('source-1')]
	mockModule.listEntitySourcesByIdsForUser.mockImplementation(
		async (
			_db: D1Database,
			input: { userId: string; ids: ReadonlyArray<string> },
		) =>
			input.userId !== 'user-1'
				? []
				: resolvedSources.filter((source) => input.ids.includes(source.id)),
	)
	mockModule.listSavedPackagesByIds.mockImplementation(
		async (
			_db: D1Database,
			input: { userId: string; packageIds: Array<string> },
		) =>
			(packages ?? [savedPackage()]).filter((row) =>
				input.packageIds.includes(row.id),
			),
	)
	mockModule.checkPermission.mockImplementation(
		(
			_access: unknown,
			_permission: unknown,
			resource: { id?: string } | undefined,
		) => ({
			allowed: !resource?.id || !deniedPackageIds.includes(resource.id),
		}),
	)
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
	expect(mockModule.listEntitySourcesByIdsForUser).toHaveBeenCalledWith(
		expect.anything(),
		{ userId: ownerIdFromStored('user-1'), ids: [] },
	)
})

test('repoListSessions supports source_id narrowing and applies limit after dropping missing sources', async () => {
	stubSources({ sources: [packageSource('source-2')] })
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

	stubSources({ sources: [packageSource('source-1')] })
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
	expect(mockModule.listEntitySourcesByIdsForUser).toHaveBeenCalledTimes(1)
	expect(mockModule.listEntitySourcesByIdsForUser).toHaveBeenCalledWith(
		expect.anything(),
		{
			userId: ownerIdFromStored('user-1'),
			ids: ['source-missing', 'source-1'],
		},
	)
})

test('repoListSessions batch-loads sources and packages once for many sessions', async () => {
	const sources = Array.from({ length: 53 }, (_, index) =>
		packageSource(`source-${index}`, `package-${index}`),
	)
	const packages = sources.map((source) =>
		savedPackage({
			id: source.entity_id,
			sourceId: source.id,
			name: `@user/${source.entity_id}`,
			kodyId: source.entity_id,
		}),
	)
	stubSources({ sources, packages })
	mockModule.listRepoSessionsByUser.mockResolvedValue(
		sources.map((source, index) =>
			createSession(`session-${index}`, {
				source_id: source.id,
				updated_at: `2026-04-28T00:${String(index).padStart(2, '0')}:00.000Z`,
			}),
		),
	)

	const result = await listSessions({ status: 'all', limit: 100 })

	expect(result.sessions).toHaveLength(53)
	expect(mockModule.listEntitySourcesByIdsForUser).toHaveBeenCalledTimes(1)
	expect(mockModule.listSavedPackagesByIds).toHaveBeenCalledTimes(1)
	expect(mockModule.listSavedPackagesByIds).toHaveBeenCalledWith(
		expect.anything(),
		{
			userId: ownerIdFromStored('user-1'),
			packageIds: sources.map((source) => source.entity_id),
		},
	)
})

test('repoListSessions skips packages the caller cannot read and fills the limit from later rows', async () => {
	stubSources({
		sources: [
			packageSource('source-denied', 'package-denied'),
			packageSource('source-allowed', 'package-allowed'),
		],
		packages: [
			savedPackage({
				id: 'package-denied',
				sourceId: 'source-denied',
				name: '@user/denied',
				kodyId: 'denied',
			}),
			savedPackage({
				id: 'package-allowed',
				sourceId: 'source-allowed',
				name: '@user/allowed',
				kodyId: 'allowed',
			}),
		],
		deniedPackageIds: ['package-denied'],
	})
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession('session-denied', {
			source_id: 'source-denied',
			updated_at: '2026-04-28T00:02:00.000Z',
		}),
		createSession('session-allowed', {
			source_id: 'source-allowed',
			updated_at: '2026-04-28T00:01:00.000Z',
		}),
	])

	expect(ids(await listSessions({ limit: 1 }))).toEqual(['session-allowed'])
	expect(mockModule.checkPermission).toHaveBeenCalled()
})

test('repoListSessions falls back to source resolved_target when the saved package row is missing', async () => {
	stubSources({
		sources: [packageSource('source-1', 'package-missing')],
		packages: [],
	})
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession('session-1'),
	])

	const result = await listSessions()

	expect(result.sessions[0]?.resolved_target).toEqual({
		kind: 'source',
		source_id: 'source-1',
		entity_kind: 'package',
		entity_id: 'package-missing',
	})
})

test('repoListSessions uses source resolved_target for non-package entity kinds', async () => {
	stubSources({ sources: [repoSource('source-repo')], packages: [] })
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		createSession('session-repo', { source_id: 'source-repo' }),
	])

	const result = await listSessions()

	expect(mockModule.listSavedPackagesByIds).toHaveBeenCalledWith(
		expect.anything(),
		{ userId: ownerIdFromStored('user-1'), packageIds: [] },
	)
	expect(result.sessions[0]?.resolved_target).toEqual({
		kind: 'source',
		source_id: 'source-repo',
		entity_kind: 'repo',
		entity_id: 'repo-entity-1',
	})
})

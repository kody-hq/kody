import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { vi } from 'vitest'
import type * as backgroundMcpUserModule from '#worker/identity/background-mcp-user.ts'
import type * as managerClientModule from '#worker/jobs/manager-client.ts'
import type * as artifactRepoCleanupModule from '#worker/repo/artifact-repo-cleanup.ts'
import type { RepoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import type * as repoSessionsModule from '#worker/repo/repo-sessions.ts'
import type * as sourceServiceModule from '#worker/repo/source-service.ts'
import type * as sourceSyncModule from '#worker/repo/source-sync.ts'
import type {
	StorageClearResult,
	StorageEstimateResult,
} from '#worker/storage-runner.ts'

type CleanupSessionBranchInput = Parameters<
	RepoSessionRpc['cleanupSessionBranch']
>[0]

export const repoMockModule = {
	ensureEntitySource: vi.fn<typeof sourceServiceModule.ensureEntitySource>(),
	syncArtifactSourceSnapshot:
		vi.fn<typeof sourceSyncModule.syncArtifactSourceSnapshot>(),
	cleanupArtifactReposForSource: vi.fn<
		typeof artifactRepoCleanupModule.cleanupArtifactReposForSource
	>(async () => ({
		deleted: 0,
		artifactAccessUnavailable: false,
	})),
	listRepoSessionsBySource: vi.fn<
		typeof repoSessionsModule.listRepoSessionsBySource
	>(async () => []),
	deleteRepoSessionsBySourceForUser: vi.fn<
		typeof repoSessionsModule.deleteRepoSessionsBySourceForUser
	>(async () => 0),
	cleanupSessionBranch: vi.fn(async (_payload: CleanupSessionBranchInput) => ({
		ok: true,
	})),
}

export const jobManagerMockModule = {
	syncJobManagerAlarm: vi.fn<typeof managerClientModule.syncJobManagerAlarm>(),
	getJobManagerDebugState:
		vi.fn<typeof managerClientModule.getJobManagerDebugState>(),
}

export const storageRunnerMockModule = {
	clearStorage: vi.fn<() => Promise<StorageClearResult>>(async () => ({
		ok: true,
	})),
	getEstimatedBytes: vi.fn<() => Promise<StorageEstimateResult>>(async () => ({
		estimatedBytes: 0,
	})),
}

async function mockBackgroundMcpUser(
	_db: D1Database,
	userId: string,
): Promise<{
	userId: ReturnType<typeof personIdFromStored>
	email: string
	username: string
	displayName: string
}> {
	return {
		userId: personIdFromStored(userId),
		email: `${userId}@example.com`,
		username: userId,
		displayName: userId,
	}
}

export const identityMockModule = {
	resolveBackgroundMcpUser: vi.fn<
		typeof backgroundMcpUserModule.resolveBackgroundMcpUser
	>(mockBackgroundMcpUser),
}

export function sourceServiceMock() {
	return {
		ensureEntitySource: (
			...args: Parameters<typeof sourceServiceModule.ensureEntitySource>
		) => repoMockModule.ensureEntitySource(...args),
	}
}

export function sourceSyncMock() {
	return {
		syncArtifactSourceSnapshot: (
			...args: Parameters<typeof sourceSyncModule.syncArtifactSourceSnapshot>
		) => repoMockModule.syncArtifactSourceSnapshot(...args),
	}
}

export function artifactRepoCleanupMock() {
	return {
		cleanupArtifactReposForSource: (
			...args: Parameters<
				typeof artifactRepoCleanupModule.cleanupArtifactReposForSource
			>
		) => repoMockModule.cleanupArtifactReposForSource(...args),
	}
}

export function repoSessionsMock() {
	return {
		listRepoSessionsBySource: (
			...args: Parameters<typeof repoSessionsModule.listRepoSessionsBySource>
		) => repoMockModule.listRepoSessionsBySource(...args),
		deleteRepoSessionsBySourceForUser: (
			...args: Parameters<
				typeof repoSessionsModule.deleteRepoSessionsBySourceForUser
			>
		) => repoMockModule.deleteRepoSessionsBySourceForUser(...args),
	}
}

export function repoSessionDoMock() {
	return {
		repoSessionRpc: () => ({
			cleanupSessionBranch: (payload: CleanupSessionBranchInput) =>
				repoMockModule.cleanupSessionBranch(payload),
		}),
	}
}

export function managerClientMock() {
	return {
		syncJobManagerAlarm: (
			...args: Parameters<typeof managerClientModule.syncJobManagerAlarm>
		) => jobManagerMockModule.syncJobManagerAlarm(...args),
		getJobManagerDebugState: (
			...args: Parameters<typeof managerClientModule.getJobManagerDebugState>
		) => jobManagerMockModule.getJobManagerDebugState(...args),
	}
}

export function backgroundMcpUserMock() {
	return {
		resolveBackgroundMcpUser: (
			...args: Parameters<
				typeof backgroundMcpUserModule.resolveBackgroundMcpUser
			>
		) => identityMockModule.resolveBackgroundMcpUser(...args),
	}
}

export function storageRunnerMock(actual: Record<string, unknown>) {
	return {
		...actual,
		storageRunnerRpc: () => ({
			clearStorage: () => storageRunnerMockModule.clearStorage(),
			getEstimatedBytes: () => storageRunnerMockModule.getEstimatedBytes(),
			getValue: async () => ({ ok: true, key: '', value: null }),
			setValue: async ({ key }: { key: string }) => ({ ok: true, key }),
			deleteValue: async ({ key }: { key: string }) => ({
				ok: true,
				key,
				deleted: true,
			}),
			listValues: async () => ({
				entries: [],
				estimatedBytes: 0,
				truncated: false,
				nextStartAfter: null,
				pageSize: 50,
			}),
			exportStorage: async () => ({
				entries: [],
				estimatedBytes: 0,
				truncated: false,
				nextStartAfter: null,
				pageSize: 50,
			}),
			importStorage: async () => ({ ok: true, written: 0, cleared: false }),
			sqlQuery: async () => ({
				ok: true,
				columns: [],
				rows: [],
				rowsAffected: 0,
			}),
		}),
	}
}

export function resetJobServiceMocks() {
	vi.restoreAllMocks()
	repoMockModule.cleanupArtifactReposForSource.mockClear()
	repoMockModule.cleanupArtifactReposForSource.mockResolvedValue({
		deleted: 0,
		artifactAccessUnavailable: false,
	})
	repoMockModule.listRepoSessionsBySource.mockClear()
	repoMockModule.listRepoSessionsBySource.mockResolvedValue([])
	repoMockModule.deleteRepoSessionsBySourceForUser.mockClear()
	repoMockModule.deleteRepoSessionsBySourceForUser.mockResolvedValue(0)
	repoMockModule.cleanupSessionBranch.mockClear()
	repoMockModule.cleanupSessionBranch.mockResolvedValue({ ok: true })
	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	jobManagerMockModule.getJobManagerDebugState.mockReset()
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue({
		bindingAvailable: false,
		status: 'missing_binding',
		storedUserId: null,
		alarmScheduledFor: null,
		nextRunnableJobId: null,
		nextRunnableRunAt: null,
		alarmInSync: null,
	})
	storageRunnerMockModule.clearStorage.mockClear()
	storageRunnerMockModule.clearStorage.mockResolvedValue({ ok: true })
	storageRunnerMockModule.getEstimatedBytes.mockClear()
	storageRunnerMockModule.getEstimatedBytes.mockResolvedValue({
		estimatedBytes: 0,
	})
	identityMockModule.resolveBackgroundMcpUser.mockReset()
	identityMockModule.resolveBackgroundMcpUser.mockImplementation(
		mockBackgroundMcpUser,
	)
}

export function workerBundlerModulesMock() {
	return {
		importWorkerBundler: async () => ({
			createFileSystemSnapshot: vi.fn(
				async (files: AsyncIterable<[string, string]>) => {
					const snapshotFiles = new Map<string, string>()
					for await (const [path, content] of files) {
						snapshotFiles.set(path, content)
					}
					return {
						read(path: string) {
							return snapshotFiles.get(path) ?? null
						},
					}
				},
			),
			createWorker: vi.fn(
				async ({
					files,
					entryPoint,
				}: {
					files: Record<string, string>
					entryPoint?: string
				}) => {
					const mainModule = 'dist/bundled-entry.js'
					const selectedEntryPoint = entryPoint ?? 'index.ts'
					return {
						mainModule,
						modules: {
							[mainModule]: files[selectedEntryPoint] ?? '',
						},
						warnings: [],
					}
				},
			),
		}),
		importWorkerBundlerTypescript: async () => ({
			createTypescriptLanguageService: vi.fn(async () => ({
				fileSystem: {
					read: vi.fn(() => null),
					write: vi.fn(),
				},
				languageService: {
					getSemanticDiagnostics: vi.fn((entryPoint: string) =>
						entryPoint === '.__kody_repo_module_check__.ts' ||
						entryPoint === 'src/job.ts'
							? []
							: [{ messageText: `missing ${entryPoint}` }],
					),
				},
			})),
		}),
	}
}

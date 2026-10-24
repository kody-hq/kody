import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as PublishLock from '#worker/package-registry/package-publish-lock.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type ArtifactBootstrapAccess } from './artifacts.ts'
import type * as EntitySources from './entity-sources.ts'
import {
	isRepoChecksFailedError,
	RepoChecksFailedError,
} from './repo-checks-failed-error.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	updateEntitySource: vi.fn<typeof EntitySources.updateEntitySource>(
		async () => true,
	),
	repoSessionRpc: vi.fn(),
	writePublishedSourceSnapshot: vi.fn<
		typeof PublishedRuntimeArtifacts.writePublishedSourceSnapshot
	>(async () => 'snapshot-key'),
	loadLockedSavedPackage: vi.fn<typeof PublishLock.loadLockedSavedPackage>(
		async () => null,
	),
	runRepoChecks: vi.fn(
		async (
			..._args: Array<unknown>
		): Promise<{
			ok: boolean
			results: Array<{ kind: string; ok: boolean; message: string }>
			manifest: {
				name: string
				exports: { '.': string }
				kody: { id: string; description: string }
			} | null
			sourceFiles: Record<string, string>
		}> => ({
			ok: true,
			results: [{ kind: 'manifest', ok: true, message: 'ok' }],
			manifest: {
				name: '@scope/demo',
				exports: { '.': './src/index.ts' },
				kody: { id: 'demo', description: 'Demo' },
			},
			sourceFiles: {},
		}),
	),
	writeArtifactSourceSnapshot: vi.fn(async (..._args: Array<unknown>) => ({
		published_commit: 'commit-mock-1',
		files: {} as Record<string, string>,
	})),
	isLoopbackArtifactsRemote: vi.fn((..._args: Array<unknown>) => false),
	recordPackageAppPublish: vi.fn(async (_input: unknown) => {}),
}))

vi.mock('#worker/package-runtime/package-app-authority.ts', () => ({
	recordPackageAppPublish: (input: unknown) =>
		mockModule.recordPackageAppPublish(input),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	updateEntitySource: (
		...args: Parameters<typeof EntitySources.updateEntitySource>
	) => mockModule.updateEntitySource(...args),
}))

vi.mock('./repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	writePublishedSourceSnapshot: (
		...args: Parameters<
			typeof PublishedRuntimeArtifacts.writePublishedSourceSnapshot
		>
	) => mockModule.writePublishedSourceSnapshot(...args),
	buildPublishedSourceSnapshotKvKey: ({
		sourceId,
		publishedCommit,
	}: {
		sourceId: string
		publishedCommit: string
	}) => `snapshot:${sourceId}:${publishedCommit}`,
}))

vi.mock(
	'#worker/package-registry/package-publish-lock.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PublishLock>()
		return {
			...actual,
			loadLockedSavedPackage: (
				...args: Parameters<typeof PublishLock.loadLockedSavedPackage>
			) => mockModule.loadLockedSavedPackage(...args),
		}
	},
)

vi.mock('./checks.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./checks.ts')>()
	return {
		...actual,
		runRepoChecks: mockModule.runRepoChecks,
	}
})

vi.mock('./artifact-source-snapshot.ts', () => ({
	writeArtifactSourceSnapshot: mockModule.writeArtifactSourceSnapshot,
}))

vi.mock('./artifacts.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./artifacts.ts')>()
	return {
		...actual,
		isLoopbackArtifactsRemote: mockModule.isLoopbackArtifactsRemote,
		hasArtifactsAccess: () => true,
	}
})

const { syncArtifactSourceSnapshot } = await import('./source-sync.ts')
const { PackageCredentialNeedsApprovalError } =
	await import('#worker/credentials/credential-needs-approval.ts')

const bootstrapAccess: ArtifactBootstrapAccess = {
	defaultBranch: 'main',
	remote: 'https://acct.artifacts.cloudflare.net/git/default/repo-1.git',
	token: 'art_v1_bootstrap?expires=1760000000',
	expiresAt: '2025-10-09T08:53:20.000Z',
}

const packageJson =
	'{"name":"@scope/demo","exports":{".":"./src/index.ts"},"kody":{"id":"demo","description":"Demo"}}'

const syncInput = {
	env: {
		APP_DB: { prepare: () => ({}) as D1PreparedStatement },
		BUNDLE_ARTIFACTS_KV: {},
		REPO_SESSION: {},
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token-1',
	} as unknown as Env,
	userId: ownerIdFromStored('user-1'),
	baseUrl: 'https://heykody.dev',
	sourceId: 'source-1',
}

function sourceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
		...overrides,
	}
}

const packageFiles = {
	'package.json': packageJson,
	'src/index.ts': 'export const ready = true\n',
}

const packageSource = {
	entity_kind: 'package' as const,
	entity_id: 'package-1',
	repo_id: 'package-1',
	manifest_path: 'package.json',
}

function bootstrapped(publishedCommit: string, extra = {}) {
	return vi.fn(async () => ({
		sessionId: 'source-sync-source-1-session',
		publishedCommit,
		message: 'Bootstrapped source source-1.',
		...extra,
	}))
}

function publishingSession(publishedCommit: string) {
	return {
		openSession: vi.fn(async () => ({ id: 'source-sync-source-1-session' })),
		applyEdits: vi.fn(async () => ({
			dryRun: false,
			totalChanged: 1,
			edits: [],
		})),
		runChecks: vi.fn(async () => ({
			ok: true as const,
			results: [{ kind: 'manifest' as const, ok: true, message: 'ok' }],
			manifest: {
				name: '@scope/demo',
				exports: { '.': './src/index.ts' },
				kody: { id: 'demo', description: 'Demo' },
			},
			sourceFiles: {},
			runId: 'check-run-1',
			treeHash: 'tree-1',
			checkedAt: '2026-04-18T00:00:00.000Z',
		})),
		acceptCurrentTreeForPublish: vi.fn(async () => ({
			runId: 'accepted-check-1',
			treeHash: 'tree-accepted',
			checkedAt: '2026-04-18T00:00:00.000Z',
			ok: true as const,
			results: [
				{
					kind: 'manifest' as const,
					ok: true,
					message: 'accepted without validators',
				},
			],
		})),
		publishSession: vi.fn(async () => ({
			status: 'ok' as const,
			sessionId: 'source-sync-source-1-session',
			publishedCommit,
			message: 'Published session',
		})),
	}
}

function setupSync(
	row: Record<string, unknown>,
	overrides: Record<string, ReturnType<typeof vi.fn>> = {},
) {
	vi.clearAllMocks()
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
		manifest: {
			name: '@scope/demo',
			exports: { '.': './src/index.ts' },
			kody: { id: 'demo', description: 'Demo' },
		},
		sourceFiles: {},
	})
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(false)
	mockModule.writeArtifactSourceSnapshot.mockResolvedValue({
		published_commit: 'commit-mock-1',
		files: {},
	})
	const client = {
		bootstrapSource: vi.fn(),
		openSession: vi.fn(),
		applyEdits: vi.fn(),
		runChecks: vi.fn(),
		acceptCurrentTreeForPublish: vi.fn(),
		publishSession: vi.fn(),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'source-sync-source-1-session',
			deleted: false,
		})),
		...overrides,
	}
	mockModule.getEntitySourceById.mockResolvedValueOnce(row)
	mockModule.repoSessionRpc.mockReturnValueOnce(client as never)
	return client
}

test('syncArtifactSourceSnapshot bootstraps new sources and uses repo sessions for published sources', async () => {
	const bootstrap = setupSync(sourceRow(), {
		bootstrapSource: bootstrapped('commit-bootstrap-1'),
	})
	await expect(
		syncArtifactSourceSnapshot({ ...syncInput, files: packageFiles }),
	).resolves.toBe('commit-bootstrap-1')
	expect(bootstrap.bootstrapSource).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		edits: [
			{
				kind: 'write',
				path: 'package.json',
				content: packageFiles['package.json'],
			},
			{
				kind: 'write',
				path: 'src/index.ts',
				content: packageFiles['src/index.ts'],
			},
		],
		bootstrapAccess: null,
	})
	expect(bootstrap.openSession).not.toHaveBeenCalled()
	expect(bootstrap.publishSession).not.toHaveBeenCalled()

	expect(mockModule.recordPackageAppPublish).not.toHaveBeenCalled()

	const withAccess = setupSync(sourceRow(), {
		bootstrapSource: bootstrapped('commit-bootstrap-2'),
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			bootstrapAccess,
			files: { 'package.json': packageFiles['package.json'] },
		}),
	).resolves.toBe('commit-bootstrap-2')
	expect(withAccess.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({ bootstrapAccess }),
	)

	const session = setupSync(
		sourceRow({
			published_commit: 'commit-existing-1',
			indexed_commit: 'commit-existing-1',
		}),
		{
			...publishingSession('commit-session-2'),
			discardSession: vi.fn(async () => ({
				ok: true as const,
				sessionId: 'source-sync-source-1-session',
				deleted: true,
			})),
		},
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: { 'package.json': packageFiles['package.json'] },
		}),
	).resolves.toBe('commit-session-2')
	expect(session.bootstrapSource).not.toHaveBeenCalled()
	expect(session.openSession).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			sourceRoot: '/',
		}),
	)
	expect(session.applyEdits).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			dryRun: false,
			rollbackOnError: true,
		}),
	)
	expect(session.runChecks).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('user-1') }),
	)
	expect(session.publishSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: ownerIdFromStored('user-1'),
	})
	expect(session.publishSession.mock.calls[0]?.[0]).not.toHaveProperty('force')
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(session.discardSession).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('user-1') }),
	)

	const plainRepo = setupSync(
		sourceRow({
			entity_kind: 'repo',
			entity_id: 'repo-1',
			repo_id: 'repo-1',
			published_commit: 'commit-existing-1',
		}),
		publishingSession('commit-session-repo'),
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: { 'README.md': '# repo\n' },
		}),
	).resolves.toBe('commit-session-repo')
	expect(plainRepo.runChecks).not.toHaveBeenCalled()
	expect(plainRepo.publishSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: ownerIdFromStored('user-1'),
		force: true,
	})
})

test('a first publish records who published it before the code serves', async () => {
	const callOrder: Array<string> = []
	mockModule.recordPackageAppPublish.mockImplementation(async () => {
		callOrder.push('recordPackageAppPublish')
	})
	const bootstrapSource = vi.fn(async () => {
		callOrder.push('bootstrapSource')
		return {
			sessionId: 'source-sync-source-1-session',
			publishedCommit: 'commit-bootstrap-person',
			message: 'Bootstrapped source source-1.',
		}
	})
	setupSync(sourceRow(), { bootstrapSource })
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: packageFiles,
			requestedByUserId: 'person-1',
		}),
	).resolves.toBe('commit-bootstrap-person')
	expect(callOrder).toEqual(['recordPackageAppPublish', 'bootstrapSource'])
	expect(mockModule.recordPackageAppPublish).toHaveBeenLastCalledWith({
		db: syncInput.env.APP_DB,
		scope: { orgId: ownerIdFromStored('user-1'), packageId: 'package-1' },
		personId: 'person-1',
	})

	setupSync(sourceRow(), { bootstrapSource: bootstrapped('commit-unknown') })
	await syncArtifactSourceSnapshot({
		...syncInput,
		files: packageFiles,
		requestedByUserId: null,
	})
	expect(mockModule.recordPackageAppPublish).toHaveBeenLastCalledWith(
		expect.objectContaining({ personId: null }),
	)
	mockModule.recordPackageAppPublish.mockReset()
})

test('syncArtifactSourceSnapshot runs package checks before updating a published package', async () => {
	const session = setupSync(
		sourceRow({
			...packageSource,
			published_commit: 'commit-existing-1',
			indexed_commit: 'commit-existing-1',
		}),
		publishingSession('commit-session-pkg'),
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-session-pkg')
	expect(session.runChecks).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('user-1') }),
	)
	expect(session.runChecks.mock.calls[0]?.[0]).not.toHaveProperty(
		'requirePackageDocs',
	)
	expect(session.publishSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: ownerIdFromStored('user-1'),
	})
	expect(session.publishSession.mock.calls[0]?.[0]).not.toHaveProperty('force')

	const failing = setupSync(
		sourceRow({
			...packageSource,
			published_commit: 'commit-existing-1',
		}),
		{
			...publishingSession('commit-should-not'),
			runChecks: vi.fn(async () => ({
				ok: false as const,
				results: [
					{
						kind: 'typecheck' as const,
						ok: false,
						message: 'update type error',
					},
				],
				manifest: null,
				sourceFiles: {},
				runId: 'check-run-fail',
				treeHash: 'tree-fail',
				checkedAt: '2026-04-18T00:00:00.000Z',
			})),
		},
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: { 'package.json': packageJson },
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof RepoChecksFailedError &&
			error.message === 'update type error',
	)
	expect(failing.publishSession).not.toHaveBeenCalled()

	const docsExempt = setupSync(
		sourceRow({
			...packageSource,
			published_commit: 'commit-existing-1',
		}),
		publishingSession('commit-docs-exempt'),
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			requirePackageDocs: false,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-docs-exempt')
	expect(docsExempt.runChecks).toHaveBeenCalledWith(
		expect.objectContaining({ requirePackageDocs: false }),
	)

	const stampExempt = setupSync(
		sourceRow({
			...packageSource,
			published_commit: 'commit-existing-1',
		}),
		publishingSession('commit-stamp-exempt'),
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			requirePackageDocs: false,
			enforceCredentialStamp: false,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-stamp-exempt')
	expect(stampExempt.runChecks).toHaveBeenCalledWith(
		expect.objectContaining({
			requirePackageDocs: false,
			enforceCredentialStamp: false,
		}),
	)
})

test('syncArtifactSourceSnapshot keeps the session when the publish pauses for credential needs approval', async () => {
	const approval = {
		requestId: 'request-1',
		packageId: 'package-1',
		packageName: '@scope/demo',
		kodyId: 'demo',
		pendingCommit: 'commit-paused',
		changes: [],
		message: 'Package "@scope/demo" changed its credential needs.',
	}
	const session = setupSync(
		sourceRow({
			...packageSource,
			published_commit: 'commit-existing-1',
			indexed_commit: 'commit-existing-1',
		}),
		{
			...publishingSession('commit-paused'),
			publishSession: vi.fn(async () => ({
				status: 'approval_required' as const,
				sessionId: 'source-sync-source-1-session',
				publishedCommit: null,
				currentPublishedCommit: 'commit-existing-1',
				message: approval.message,
				approval,
				credentialNotice: null,
			})),
		},
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: { 'package.json': packageJson },
		}),
	).rejects.toBeInstanceOf(PackageCredentialNeedsApprovalError)
	expect(session.discardSession).not.toHaveBeenCalled()
})

test('syncArtifactSourceSnapshot forwards bootstrap publish flags', async () => {
	const docsExempt = setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-bootstrap-docs'),
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			requirePackageDocs: false,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-bootstrap-docs')
	expect(docsExempt.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({ requirePackageDocs: false }),
	)

	const stampExempt = setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-bootstrap-stamp'),
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			requirePackageDocs: false,
			enforceCredentialStamp: false,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-bootstrap-stamp')
	expect(stampExempt.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({
			requirePackageDocs: false,
			enforceCredentialStamp: false,
		}),
	)

	const scoped = setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-bootstrap-scope'),
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			expectedPackageScope: 'renamed-user',
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-bootstrap-scope')
	expect(scoped.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({ expectedPackageScope: 'renamed-user' }),
	)
})

test('syncArtifactSourceSnapshot skips publish checks when runPublishChecks is false', async () => {
	const bootstrap = setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-bootstrap-skip'),
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			runPublishChecks: false,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-bootstrap-skip')
	expect(bootstrap.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({ runPublishChecks: false }),
	)

	const session = setupSync(
		sourceRow({
			...packageSource,
			published_commit: 'commit-existing-1',
		}),
		publishingSession('commit-skip-update'),
	)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			runPublishChecks: false,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-skip-update')
	expect(session.runChecks).not.toHaveBeenCalled()
	expect(session.acceptCurrentTreeForPublish).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: ownerIdFromStored('user-1'),
	})
	// No force: force would trip overwrite confirmation; stamped check-status
	// lets publishSession proceed without checks_outdated.
	expect(session.publishSession).toHaveBeenCalledWith({
		sessionId: expect.stringMatching(/^source-sync-source-1-/),
		userId: ownerIdFromStored('user-1'),
	})
	expect(session.publishSession.mock.calls[0]?.[0]).not.toHaveProperty('force')
})

test('syncArtifactSourceSnapshot loopback first-publish runs package checks before snapshot', async () => {
	const loopbackAccess = {
		...bootstrapAccess,
		remote: 'http://127.0.0.1:8787/git/default/package-1.git',
	}
	setupSync(sourceRow(packageSource))
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(true)
	mockModule.runRepoChecks.mockResolvedValueOnce({
		ok: false as const,
		results: [
			{ kind: 'typecheck' as const, ok: false, message: 'loopback type error' },
		],
		manifest: null as null,
		sourceFiles: {} as Record<string, string>,
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			bootstrapAccess: loopbackAccess,
			files: { 'package.json': packageJson },
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			isRepoChecksFailedError(error) &&
			error instanceof Error &&
			error.message === 'loopback type error',
	)
	expect(mockModule.runRepoChecks).toHaveBeenCalled()
	expect(mockModule.writeArtifactSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	setupSync(sourceRow(packageSource))
	mockModule.isLoopbackArtifactsRemote.mockReturnValue(true)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			bootstrapAccess: loopbackAccess,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-mock-1')
	expect(mockModule.runRepoChecks).toHaveBeenCalled()
	expect(mockModule.writeArtifactSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ publishedCommit: 'commit-mock-1' }),
	)
})

test('syncArtifactSourceSnapshot refuses to bootstrap a locked package without allowLockedPublish', async () => {
	const locked = setupSync(sourceRow(packageSource))
	mockModule.loadLockedSavedPackage.mockResolvedValue({
		id: 'package-1',
		name: '@scope/demo',
		lockedAt: '2026-08-28T12:00:00.000Z',
	} as never)
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			files: { 'package.json': packageJson },
		}),
	).rejects.toThrow(
		'Package "@scope/demo" is locked. Unlock it on the website before the first published snapshot can be created.',
	)
	expect(locked.bootstrapSource).not.toHaveBeenCalled()
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	const allowed = setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-bootstrap-locked'),
	})
	await expect(
		syncArtifactSourceSnapshot({
			...syncInput,
			allowLockedPublish: true,
			files: { 'package.json': packageJson },
		}),
	).resolves.toBe('commit-bootstrap-locked')
	expect(allowed.bootstrapSource).toHaveBeenCalled()
	expect(mockModule.loadLockedSavedPackage).not.toHaveBeenCalled()
})

test('syncArtifactSourceSnapshot first-publishes a forked dest HEAD without force overwrite', async () => {
	const destWorkspaceFiles = {
		'package.json':
			'{"name":"@jane/demo","exports":{".":"./src/index.ts"},"kody":{"id":"demo","description":"Demo"},"private":true}',
		'src/index.ts': 'export const ready = true\n',
		'README.md': 'forked dest tree',
	}
	const forkInput = {
		...syncInput,
		existingHeadCommit: 'commit-dest-head',
		files: { 'package.json': destWorkspaceFiles['package.json'] },
	}

	const fork = setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-fork-rewrite', {
			files: destWorkspaceFiles,
		}),
	})
	await expect(syncArtifactSourceSnapshot(forkInput)).resolves.toBe(
		'commit-fork-rewrite',
	)
	expect(fork.bootstrapSource).toHaveBeenCalledWith(
		expect.objectContaining({
			existingHeadCommit: 'commit-dest-head',
			edits: [expect.objectContaining({ kind: 'write', path: 'package.json' })],
		}),
	)
	expect(fork.openSession).not.toHaveBeenCalled()
	expect(fork.publishSession).not.toHaveBeenCalled()
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: destWorkspaceFiles,
			source: expect.objectContaining({
				published_commit: 'commit-fork-rewrite',
			}),
		}),
	)

	setupSync(sourceRow(packageSource), {
		bootstrapSource: bootstrapped('commit-fork-rewrite'),
	})
	await expect(syncArtifactSourceSnapshot(forkInput)).rejects.toThrow(
		/produced no workspace snapshot/,
	)
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()

	const published = setupSync(
		sourceRow({ ...packageSource, published_commit: 'commit-existing-1' }),
	)
	await expect(syncArtifactSourceSnapshot(forkInput)).rejects.toThrow(
		/already has a published commit/,
	)
	expect(published.bootstrapSource).not.toHaveBeenCalled()
	expect(published.publishSession).not.toHaveBeenCalled()
})

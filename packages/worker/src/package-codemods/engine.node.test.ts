import { isolatedCheckRunnerLimitMessage } from '#worker/repo/isolated-runner-limit-message.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as RepoChecks from '#worker/repo/checks.ts'
import { explicitWebhookUrlSecretVerificationCodemodId } from './codemods/0012-explicit-webhook-url-secret-verification.ts'
import {
	createPackageCodemodRun,
	getPackageCodemodRunById,
	getPackageCodemodRunItemById,
	insertPackageCodemodRunItem,
	listPackageCodemodRuns,
} from './ledger.ts'
import type * as Registry from './registry.ts'
import { type PackageCodemod } from './types.ts'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	listSavedPackagesPage: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	syncPublishedSourceSnapshotOnly: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	runRepoChecks: vi.fn(),
	dispatchPackageCodemodSubscriptionEvent: vi.fn(),
	getPackageScopeByUserId: vi.fn(
		async (_db: D1Database, userId: string) => userId,
	),
}))

const publishedOnlyFixtureCodemod = vi.hoisted((): PackageCodemod => ({
	id: 'test-published-only-fixture',
	description: 'Test fixture for the published-only write lane.',
	applyMode: 'published-only',
	detect: (files) =>
		files['index.ts']?.includes('// fixture codemod')
			? []
			: [{ path: 'index.ts', message: 'Missing fixture marker.' }],
	transform: (files) => {
		const source = files['index.ts'] ?? ''
		if (source.includes('// fixture codemod')) {
			return { files, changed: false, changedPaths: [], needsManual: [] }
		}
		return {
			files: { ...files, 'index.ts': `${source}// fixture codemod\n` },
			changed: true,
			changedPaths: ['index.ts'],
			needsManual: [],
		}
	},
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getPackageScopeByUserId: mocks.getPackageScopeByUserId,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
	listSavedPackagesPage: mocks.listSavedPackagesPage,
}))
vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: mocks.loadPackageSourceBySourceId,
}))
vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: mocks.syncArtifactSourceSnapshot,
	syncPublishedSourceSnapshotOnly: mocks.syncPublishedSourceSnapshotOnly,
}))
vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: mocks.refreshSavedPackageProjection,
}))
vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: mocks.resolveArtifactSourceHead,
}))
vi.mock('#worker/repo/checks.ts', async (importOriginal) => ({
	...(await importOriginal<typeof RepoChecks>()),
	runRepoChecks: mocks.runRepoChecks,
}))
vi.mock('./registry.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof Registry>()
	return {
		...actual,
		getPackageCodemodById: (id: string) =>
			id === publishedOnlyFixtureCodemod.id
				? publishedOnlyFixtureCodemod
				: actual.getPackageCodemodById(id),
	}
})
vi.mock('./subscription-events.ts', () => ({
	packageCodemodAppliedTopic: 'package.codemod.applied',
	packageCodemodRevertedTopic: 'package.codemod.reverted',
	createPackageCodemodSubscriptionCache: () => ({
		load: async () => ({ subscriptions: [], discoveryErrors: [] }),
	}),
	dispatchPackageCodemodSubscriptionEvent:
		mocks.dispatchPackageCodemodSubscriptionEvent,
}))

const {
	buildPackageCodemodRevertSnapshotKvKey,
	operatorExcludedFinding,
	runPackageCodemodStep,
	unfinishedAttemptsError,
} = await import('./engine.ts')

const codemodId = '0001-ambient-storage-to-package-storage'
const userScope = {
	kind: 'user',
	userId: ownerIdFromStored('user-1'),
} as const
const fleetScope = { kind: 'fleet' } as const

function createKv() {
	const store = new Map<string, { value: string; expirationTtl?: number }>()
	return {
		store,
		namespace: {
			async get(key: string) {
				return store.get(key)?.value ?? null
			},
			async put(
				key: string,
				value: string,
				options?: { expirationTtl?: number },
			) {
				store.set(key, { value, expirationTtl: options?.expirationTtl })
			},
			async delete(key: string) {
				store.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

let migratedSnapshot: Uint8Array | undefined

function createMigratedSqlite() {
	if (!migratedSnapshot) {
		const seed = new DatabaseSync(':memory:')
		applyAllMigrations(seed, new URL('../../migrations/', import.meta.url))
		migratedSnapshot = seed.serialize()
		seed.close()
	}
	const sqlite = new DatabaseSync(':memory:')
	sqlite.deserialize(migratedSnapshot)
	return sqlite
}

function createEnv() {
	const kv = createKv()
	const sqlite = createMigratedSqlite()
	return {
		env: {
			APP_DB: createD1FromSqlite(sqlite),
			BUNDLE_ARTIFACTS_KV: kv.namespace,
			APP_BASE_URL: 'https://example.com',
		} as Env,
		kv,
	}
}

type StepInput = Parameters<typeof runPackageCodemodStep>[0]

function step(env: Env, input: Partial<StepInput> = {}) {
	return runPackageCodemodStep({
		env,
		baseUrl: 'https://example.com',
		initiatedByUserId: 'user-1',
		codemodId,
		mode: 'scan',
		scope: userScope,
		limit: 10,
		...input,
	} as StepInput)
}

function savedPackage(
	id: string,
	input: { userId?: string; kodyId?: string; sourceId?: string } = {},
) {
	const userId = input.userId ?? 'user-1'
	const kodyId = input.kodyId ?? id.replace(/^pkg-/, '')
	return {
		id,
		userId,
		name: `@${userId}/${kodyId}`,
		kodyId,
		description: kodyId,
		tags: [],
		searchText: null,
		sourceId: input.sourceId ?? `source-${kodyId}`,
		hasApp: false,
		hidden: false,
		isPrivate: true,
		isInternetVisible: false,
		lockedAt: null as string | null,
		createdAt: '2026-07-30T00:00:00.000Z',
		updatedAt: '2026-07-30T00:00:00.000Z',
	}
}

function packageJson(kodyId: string) {
	return `${JSON.stringify(
		{
			name: `@user/${kodyId}`,
			exports: { '.': './index.ts' },
			kody: { id: kodyId, description: 'Package for codemod tests.' },
		},
		null,
		'\t',
	)}\n`
}

function ambientFiles() {
	return {
		'package.json': packageJson('demo'),
		'index.ts':
			"import { storage } from 'kody:runtime'\nexport async function run() {\n\treturn storage.get('k')\n}\n",
	}
}

function cleanFiles() {
	return {
		'package.json': packageJson('clean'),
		'index.ts':
			"import { packageStorage } from 'kody:runtime'\nexport async function run() {\n\treturn packageStorage().get('k')\n}\n",
	}
}

function loadedSource(input: {
	files: Record<string, string>
	publishedCommit: string | null
	repoId: string
	sourceId: string
	userId: string
}) {
	return {
		source: {
			id: input.sourceId,
			user_id: input.userId,
			entity_kind: 'package',
			repo_id: input.repoId,
			published_commit: input.publishedCommit,
			indexed_commit: input.publishedCommit,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-07-30T00:00:00.000Z',
			updated_at: '2026-07-30T00:00:00.000Z',
		},
		files: input.files,
		manifest: {},
	}
}

/** Every source loads with `repo_id === sourceId` and published at `commit-<sourceId>`. */
function mockSourcesByIdWith(files: () => Record<string, string>) {
	mocks.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string; userId: string }) =>
			loadedSource({
				files: files(),
				publishedCommit: `commit-${input.sourceId}`,
				repoId: input.sourceId,
				sourceId: input.sourceId,
				userId: input.userId,
			}),
	)
}

/** One ambient package whose repo HEAD matches its published commit. */
function mockSinglePackage(pkg: ReturnType<typeof savedPackage>) {
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: ambientFiles(),
			publishedCommit: `commit-repo-${pkg.kodyId}`,
			repoId: `repo-${pkg.kodyId}`,
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
}

function checkResult(ok: boolean, message = 'ok') {
	return {
		ok,
		results: [{ kind: 'lint', ok, message }],
		manifest: {},
		sourceFiles: {},
	}
}

function mockChecksByIndex(
	check: (index: string) => ReturnType<typeof checkResult>,
) {
	mocks.runRepoChecks.mockImplementation(
		async (input: {
			workspace: { readFile(path: string): Promise<string | null> }
		}) => check((await input.workspace.readFile('index.ts')) ?? ''),
	)
}

function setupMocks() {
	mocks.refreshSavedPackageProjection.mockResolvedValue(undefined)
	mocks.dispatchPackageCodemodSubscriptionEvent.mockResolvedValue([])
	mocks.resolveArtifactSourceHead.mockImplementation(
		async (_env: Env, repoId: string) => ({
			branch: 'main',
			commit: `commit-${repoId}`,
		}),
	)
	mocks.runRepoChecks.mockResolvedValue(checkResult(true))
	mocks.syncArtifactSourceSnapshot.mockImplementation(
		async (input: { files: Record<string, string> }) =>
			input.files['index.ts']?.includes('packageStorage()')
				? 'commit-after'
				: 'commit-reverted',
	)
	mocks.syncPublishedSourceSnapshotOnly.mockReset()
	mocks.syncPublishedSourceSnapshotOnly.mockResolvedValue(
		'commit-published-only-after',
	)
}

async function insertAppliedItems(
	db: D1Database,
	runId: string,
	items: Array<{ id: string; userId: string }>,
) {
	for (const item of items) {
		await insertPackageCodemodRunItem(db, {
			id: item.id,
			runId,
			userId: ownerIdFromStored(item.userId),
			packageId: `pkg-${item.id}`,
			kodyId: item.id,
			status: 'applied',
			beforeCommit: 'before',
			afterCommit: 'after',
		})
	}
}

function createPriorFleetApply(db: D1Database, id: string) {
	return createPackageCodemodRun(db, {
		id,
		codemodId,
		mode: 'apply',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		status: 'completed',
	})
}

test('package codemod engine covers lifecycle, drift, isolation, snapshot keys, and gates', async () => {
	setupMocks()
	const { env, kv } = createEnv()
	const user1Packages = [
		'pkg-ambient',
		'pkg-clean',
		'pkg-drift',
		'pkg-unpublished',
		'pkg-fail',
	].map((id) => savedPackage(id))
	const pkgOtherUser = savedPackage('pkg-other', {
		userId: ownerIdFromStored('user-2'),
	})
	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: D1Database, input: { userId: string }) =>
			input.userId === 'user-1'
				? user1Packages
				: input.userId === 'user-2'
					? [pkgOtherUser]
					: [],
	)
	mocks.listSavedPackagesPage.mockResolvedValue([])
	const publishedCommits: Record<string, string | null> = {
		unpublished: null,
		drift: 'commit-published-old',
		clean: 'commit-repo-clean',
		other: 'commit-repo-other',
		ambient: 'commit-repo-ambient',
	}
	mocks.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string; userId: string }) => {
			const name = input.sourceId.replace(/^source-/, '')
			if (name === 'fail') throw new Error('source boom')
			return loadedSource({
				files: name === 'clean' ? cleanFiles() : ambientFiles(),
				publishedCommit: publishedCommits[name] ?? null,
				repoId: `repo-${name}`,
				sourceId: input.sourceId,
				userId: input.userId,
			})
		},
	)
	let ambientHead = 'commit-repo-ambient'
	mocks.resolveArtifactSourceHead.mockImplementation(
		async (_env: Env, repoId: string) => ({
			branch: 'main',
			commit:
				repoId === 'repo-drift'
					? 'commit-head-moved'
					: repoId === 'repo-ambient'
						? ambientHead
						: `commit-${repoId}`,
		}),
	)

	const scan = await step(env, { limit: 50 })
	expect(scan.nextCursor).toBeNull()
	expect(scan.summary).toMatchObject({
		detected: 1,
		clean: 1,
		skipped_drift: 1,
		skipped_unpublished: 1,
		failed: 1,
	})

	// Pre-existing ambient-storage failures are not "new" after the transform.
	mockChecksByIndex((index) =>
		/import\s*\{[^}]*\bstorage\b/.test(index) &&
		index.includes("from 'kody:runtime'")
			? checkResult(false, 'ambient storage line 12')
			: checkResult(true),
	)
	const dryRun = await step(env, {
		mode: 'dry-run',
		filters: { packageIds: ['pkg-ambient', 'pkg-clean'] },
	})
	expect(dryRun.summary).toMatchObject({ dry_run_ok: 1, clean: 1 })
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	mockChecksByIndex((index) =>
		index.includes('packageStorage().get')
			? checkResult(false, 'new failure only after transform')
			: checkResult(true),
	)
	const gated = await step(env, {
		mode: 'apply',
		filters: { packageIds: ['pkg-ambient'] },
	})
	expect(gated.items[0]?.status).toBe('dry_run_new_failures')
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	// A check runner limit after the transform is inconclusive, not new.
	mockChecksByIndex((index) =>
		index.includes('packageStorage().get')
			? checkResult(
					false,
					isolatedCheckRunnerLimitMessage('Bundle validation for "index.ts"'),
				)
			: checkResult(true),
	)
	const limited = await step(env, {
		mode: 'dry-run',
		filters: { packageIds: ['pkg-ambient'] },
	})
	expect(limited.items[0]).toMatchObject({
		status: 'failed',
		error: expect.stringContaining('could not be verified'),
	})
	expect(mocks.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ followCapabilityImports: false }),
	)

	// A real error joined beside a chunk's runner limit is still new.
	mockChecksByIndex((index) =>
		index.includes('packageStorage().get')
			? checkResult(
					false,
					`${isolatedCheckRunnerLimitMessage('Bundle validation for "index.ts"')}\nnew failure only after transform`,
				)
			: checkResult(true),
	)
	const mixed = await step(env, {
		mode: 'dry-run',
		filters: { packageIds: ['pkg-ambient'] },
	})
	expect(mixed.items[0]?.status).toBe('dry_run_new_failures')

	// Two chunks failing before, one of them hitting the limit after: not new.
	mockChecksByIndex((index) =>
		index.includes('packageStorage().get')
			? checkResult(
					false,
					`chunk one error\n${isolatedCheckRunnerLimitMessage('Bundle validation for "index.ts"')}`,
				)
			: checkResult(false, 'chunk one error\nchunk two error'),
	)
	const chunked = await step(env, {
		mode: 'dry-run',
		filters: { packageIds: ['pkg-ambient'] },
	})
	expect(chunked.items[0]).toMatchObject({ status: 'failed' })

	// An operator-excluded package is recorded, never processed.
	mocks.runRepoChecks.mockClear()
	const excluded = await step(env, {
		mode: 'apply',
		filters: {
			packageIds: ['pkg-ambient'],
			excludePackageIds: ['pkg-ambient'],
		},
	})
	expect(excluded.items[0]).toMatchObject({
		status: 'needs_manual',
		findings: [operatorExcludedFinding],
	})
	expect(mocks.runRepoChecks).not.toHaveBeenCalled()
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	// A failure whose message changes only by line number is not new.
	mockChecksByIndex((index) =>
		/import\s*\{[^}]*\bstorage\b/.test(index) &&
		!index.includes('packageStorage')
			? checkResult(false, 'ambient storage line 12')
			: checkResult(false, 'ambient storage line 40'),
	)
	const apply = await step(env, {
		mode: 'apply',
		filters: { packageIds: ['pkg-ambient'] },
	})
	expect(apply.items[0]).toMatchObject({
		status: 'applied',
		packageId: 'pkg-ambient',
		beforeCommit: 'commit-repo-ambient',
		afterCommit: 'commit-after',
	})
	const applyItemId = apply.items[0]!.itemId
	const revertKey = buildPackageCodemodRevertSnapshotKvKey({
		userId: ownerIdFromStored('user-1'),
		itemId: applyItemId,
	})
	expect(revertKey).toBe(`package-codemod-revert:user-1:${applyItemId}`)
	expect(kv.store.get(revertKey)?.expirationTtl).toBe(90 * 24 * 60 * 60)
	expect(
		(await getPackageCodemodRunItemById(env.APP_DB, applyItemId))
			?.revertSnapshotKey,
	).toBe(revertKey)
	expect(mocks.dispatchPackageCodemodSubscriptionEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			topic: 'package.codemod.applied',
			subscriptionCache: expect.anything(),
		}),
	)

	ambientHead = 'commit-after'
	const revertInput = { mode: 'revert', revertOfRunId: apply.runId } as const
	const revert = await step(env, revertInput)
	expect(revert.items[0]?.status).toBe('reverted')
	expect(
		(await getPackageCodemodRunItemById(env.APP_DB, applyItemId))?.status,
	).toBe('reverted')
	expect((await step(env, revertInput)).items).toEqual([])

	const user2CannotRevertUser1 = await step(env, {
		...revertInput,
		initiatedByUserId: 'user-2',
		scope: { kind: 'user', userId: ownerIdFromStored('user-2') },
	})
	expect(user2CannotRevertUser1.items).toEqual([])
})

test('package codemod engine enforces resume scope, binary paging, fleet progress, and publish failure id reuse', async () => {
	setupMocks()
	const { env, kv } = createEnv()
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		savedPackage('a'),
		savedPackage('B', { kodyId: 'b', sourceId: 'source-b' }),
	])
	mockSourcesByIdWith(cleanFiles)

	const firstPage = await step(env, { limit: 1 })
	expect(firstPage.items.map((item) => item.packageId)).toEqual(['B'])
	expect(firstPage.nextCursor).toBe('B')
	const secondPage = await step(env, {
		runId: firstPage.runId,
		cursor: firstPage.nextCursor,
		limit: 1,
	})
	expect(secondPage.items.map((item) => item.packageId)).toEqual(['a'])
	expect(secondPage.nextCursor).toBeNull()

	await expect(
		step(env, { scope: fleetScope, runId: firstPage.runId, limit: 1 }),
	).rejects.toThrow(/scope does not match/i)

	mocks.listSavedPackagesPage.mockImplementation(
		async (
			_db: D1Database,
			input: { afterId: string | null; limit: number },
		) => {
			const start = input.afterId
				? Number(input.afterId.split('-').at(-1)) + 1
				: 1
			if (start > 250) return []
			return Array.from({ length: input.limit }, (_, index) =>
				savedPackage(`fleet-${String(start + index).padStart(4, '0')}`, {
					userId: ownerIdFromStored('user-9'),
					kodyId: `nope-${start + index}`,
				}),
			)
		},
	)
	const fleetFiltered = await step(env, {
		initiatedByUserId: 'admin-1',
		scope: fleetScope,
		filters: { packageIds: ['never-match'] },
		limit: 5,
	})
	expect(fleetFiltered.items).toEqual([])
	expect(fleetFiltered.nextCursor).toBe('fleet-0250')
	expect(mocks.listSavedPackagesPage.mock.calls.length).toBe(5)

	mockSinglePackage(savedPackage('pkg-publish'))
	mocks.syncArtifactSourceSnapshot.mockRejectedValueOnce(
		new Error('publish exploded'),
	)
	const applyPublish = {
		mode: 'apply' as const,
		filters: { packageIds: ['pkg-publish'] },
	}
	const failedPublish = await step(env, applyPublish)
	expect(failedPublish.items).toHaveLength(1)
	expect(failedPublish.items[0]?.status).toBe('failed')
	expect(failedPublish.items[0]?.error).toMatch(/repo HEAD may be ahead/i)
	const failedItem = await getPackageCodemodRunItemById(
		env.APP_DB,
		failedPublish.items[0]!.itemId,
	)
	expect(failedItem?.revertSnapshotKey).toBe(
		buildPackageCodemodRevertSnapshotKvKey({
			userId: ownerIdFromStored('user-1'),
			itemId: failedPublish.items[0]!.itemId,
		}),
	)
	expect(kv.store.has(failedItem!.revertSnapshotKey!)).toBe(true)

	let headCalls = 0
	mocks.syncArtifactSourceSnapshot.mockReset()
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-after')
	mocks.resolveArtifactSourceHead.mockImplementation(async () => {
		headCalls += 1
		return {
			branch: 'main',
			commit:
				headCalls >= 2 ? 'commit-moved-before-publish' : 'commit-repo-publish',
		}
	})
	const driftBeforePublish = await step(env, applyPublish)
	expect(driftBeforePublish.items[0]?.status).toBe('skipped_drift')
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('package codemod revert skips when HEAD no longer matches applied afterCommit', async () => {
	setupMocks()
	const { env } = createEnv()
	mockSinglePackage(savedPackage('pkg-revert-drift'))
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-after-apply')

	const apply = await step(env, { mode: 'apply' })
	expect(apply.items[0]?.status).toBe('applied')

	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-user-moved-head',
	})
	const revert = await step(env, {
		mode: 'revert',
		revertOfRunId: apply.runId,
	})
	expect(revert.items[0]?.status).toBe('skipped_drift')
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(1)
})

test('codemod context takes the scope from the owner, not the saved package name', async () => {
	setupMocks()
	const { env } = createEnv()
	const movedFiles = {
		'package.json': `${JSON.stringify({
			name: '@old-owner/moved',
			exports: { '.': './index.ts' },
			kody: { id: 'moved', description: 'Package for codemod tests.' },
		})}\n`,
		'index.ts': "export { helper } from 'kody:@old-owner/helper'\n",
	}
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		{ ...savedPackage('pkg-moved'), name: '@old-owner/moved' },
	])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: movedFiles,
			publishedCommit: 'commit-repo-moved',
			repoId: 'repo-moved',
			sourceId: 'source-moved',
			userId: 'user-1',
		}),
	)

	const scan = await step(env, {
		codemodId: '0011-owner-scope-follows-registry',
	})
	expect(mocks.getPackageScopeByUserId).toHaveBeenCalledWith(
		env.APP_DB,
		'user-1',
	)
	expect(scan.items[0]).toMatchObject({
		status: 'detected',
		packageId: 'pkg-moved',
	})
	expect(scan.items[0]?.findings.map((finding) => finding.path)).toEqual([
		'index.ts',
		'package.json',
	])
	expect(scan.items[0]?.findings[0]?.message).toContain('@user-1/moved')
})

test('fleet apply on a locked package commits HEAD without promoting published_commit', async () => {
	setupMocks()
	const { env } = createEnv()
	mockSinglePackage({
		...savedPackage('pkg-locked'),
		lockedAt: '2026-08-28T12:00:00.000Z',
	})
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-after-locked')

	const apply = await step(env, { mode: 'apply' })
	expect(apply.items[0]).toMatchObject({
		status: 'applied',
		packageId: 'pkg-locked',
		afterCommit: 'commit-after-locked',
	})
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-locked',
			promotePublished: false,
		}),
	)
})

test('package codemod engine rejects resume steps with mismatched filters or a cursor without a runId', async () => {
	setupMocks()
	const { env } = createEnv()
	mocks.listSavedPackagesByUserId.mockResolvedValue([savedPackage('pkg-a')])
	mockSourcesByIdWith(cleanFiles)

	await expect(
		step(env, { cursor: 'pkg-somewhere', limit: 50 }),
	).rejects.toThrow('cursor requires runId')

	const first = await step(env, {
		initiatedByUserId: 'admin-1',
		filters: { packageIds: ['pkg-a', 'pkg-b'] },
	})
	expect(first.runId).toBeTruthy()
	const resume = { initiatedByUserId: 'admin-2', runId: first.runId }

	await expect(
		step(env, { ...resume, filters: { packageIds: ['pkg-other'] } }),
	).rejects.toThrow(/filters do not match/i)
	expect(
		(
			await step(env, {
				...resume,
				filters: { packageIds: ['pkg-b', 'pkg-a'] },
			})
		).runId,
	).toBe(first.runId)
	expect((await step(env, resume)).runId).toBe(first.runId)
})

test('omitted continuation filters keep a canary fleet apply on the stored package set', async () => {
	setupMocks()
	const { env } = createEnv()
	const fleet = [savedPackage('pkg-canary'), savedPackage('pkg-outside')]
	mocks.listSavedPackagesPage.mockImplementation(
		async (_db: D1Database, input: { afterId: string | null }) =>
			fleet.filter(
				(pkg) =>
					input.afterId == null || pkg.id.localeCompare(input.afterId) > 0,
			),
	)
	mockSourcesByIdWith(cleanFiles)
	const fleetStep = {
		initiatedByUserId: 'admin-1',
		scope: fleetScope,
		limit: 1,
	}

	const first = await step(env, {
		...fleetStep,
		filters: { packageIds: ['pkg-canary'] },
	})
	expect(first.items.map((item) => item.packageId)).toEqual(['pkg-canary'])
	expect(first.nextCursor).toBe('pkg-canary')

	const continued = await step(env, {
		...fleetStep,
		runId: first.runId,
		cursor: first.nextCursor,
	})
	expect(continued.runId).toBe(first.runId)
	expect(continued.items).toEqual([])
	expect(continued.nextCursor).toBeNull()
})

test('credential-need enforcement scope keeps a fleet run off unshared personal packages', async () => {
	setupMocks()
	const { env } = createEnv()
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('solo', 'solo@example.com', 'hash', 'solo')`,
	).run()
	const fleet = [
		savedPackage('pkg-a-solo', { userId: 'solo' }),
		{
			...savedPackage('pkg-b-public', { userId: 'solo' }),
			isInternetVisible: true,
		},
		savedPackage('pkg-c-team', { userId: 'team-org' }),
	]
	mocks.listSavedPackagesPage.mockImplementation(
		async (_db: D1Database, input: { afterId: string | null }) =>
			fleet.filter(
				(pkg) =>
					input.afterId == null || pkg.id.localeCompare(input.afterId) > 0,
			),
	)
	mockSourcesByIdWith(cleanFiles)

	const result = await step(env, {
		initiatedByUserId: 'admin-1',
		scope: fleetScope,
		filters: { scope: 'credential-need-enforcement' },
	})
	expect(result.items.map((item) => item.packageId)).toEqual([
		'pkg-b-public',
		'pkg-c-team',
	])
	const run = await getPackageCodemodRunById(env.APP_DB, result.runId)
	expect(JSON.parse(run!.filtersJson)).toEqual({
		scope: 'credential-need-enforcement',
	})
})

test('package codemod revert page ceiling and user-scoped SQL filter for sparse ownership', async () => {
	setupMocks()
	const { env } = createEnv()
	const revertOf = (revertOfRunId: string) =>
		step(env, { mode: 'revert', revertOfRunId })

	await createPriorFleetApply(env.APP_DB, 'prior-fleet')
	await insertAppliedItems(env.APP_DB, 'prior-fleet', [
		...Array.from({ length: 40 }, (_, index) => ({
			id: `other-${String(index).padStart(4, '0')}`,
			userId: ownerIdFromStored('user-other'),
		})),
		{ id: 'mine-0001', userId: ownerIdFromStored('user-1') },
		{ id: 'mine-0002', userId: ownerIdFromStored('user-1') },
	])

	const sparse = await revertOf('prior-fleet')
	expect(sparse.items).toHaveLength(2)
	expect(sparse.items.every((item) => item.userId === 'user-1')).toBe(true)
	expect(sparse.nextCursor).toBeNull()
	expect(
		await getPackageCodemodRunById(env.APP_DB, sparse.runId),
	).toMatchObject({ status: 'completed' })

	// More applied rows than one heavy step can finish (step limit caps at 10)
	// so the revert must return a cursor instead of completing the run.
	await createPriorFleetApply(env.APP_DB, 'prior-dense')
	await insertAppliedItems(
		env.APP_DB,
		'prior-dense',
		Array.from({ length: 30 }, (_, index) => ({
			id: `dense-${String(index).padStart(4, '0')}`,
			userId: ownerIdFromStored('user-1'),
		})),
	)

	const paged = await revertOf('prior-dense')
	expect(paged.items).toHaveLength(10)
	expect(paged.nextCursor).toBe('dense-0009')
	expect(await getPackageCodemodRunById(env.APP_DB, paged.runId)).toMatchObject(
		{ status: 'running' },
	)
})

test('package codemod fleet revert applies packageIds filters and leaves others applied', async () => {
	setupMocks()
	const { env, kv } = createEnv()
	await createPriorFleetApply(env.APP_DB, 'prior-canary-apply')
	const priorItems = [
		{
			id: 'item-pkg-keep-a',
			userId: ownerIdFromStored('user-1'),
			kodyId: 'keep-a',
		},
		{
			id: 'item-pkg-revert',
			userId: ownerIdFromStored('user-1'),
			kodyId: 'revert-me',
		},
		{
			id: 'item-pkg-keep-b',
			userId: ownerIdFromStored('user-2'),
			kodyId: 'keep-b',
		},
	].map((prior) => ({
		...prior,
		packageId: `pkg-${prior.kodyId}`,
		sourceId: `source-${prior.kodyId}`,
	}))

	for (const prior of priorItems) {
		const revertSnapshotKey = buildPackageCodemodRevertSnapshotKvKey({
			userId: prior.userId,
			itemId: prior.id,
		})
		await insertPackageCodemodRunItem(env.APP_DB, {
			id: prior.id,
			runId: 'prior-canary-apply',
			userId: prior.userId,
			packageId: prior.packageId,
			kodyId: prior.kodyId,
			status: 'applied',
			beforeCommit: `commit-${prior.sourceId}-before`,
			afterCommit: `commit-${prior.sourceId}`,
			changedPaths: ['index.ts'],
			revertSnapshotKey,
		})
		await kv.namespace.put(
			revertSnapshotKey,
			JSON.stringify({
				codemodId,
				userId: prior.userId,
				packageId: prior.packageId,
				beforeCommit: `commit-${prior.sourceId}-before`,
				files: cleanFiles(),
			}),
		)
	}

	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: D1Database, input: { userId: string }) =>
			priorItems
				.filter((prior) => prior.userId === input.userId)
				.map((prior) => savedPackage(prior.packageId, prior)),
	)
	mockSourcesByIdWith(cleanFiles)
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-reverted')

	const revert = await step(env, {
		initiatedByUserId: 'admin-1',
		mode: 'revert',
		scope: fleetScope,
		filters: { packageIds: ['pkg-revert-me'] },
		revertOfRunId: 'prior-canary-apply',
	})
	expect(revert.items).toHaveLength(1)
	expect(revert.items[0]).toMatchObject({
		packageId: 'pkg-revert-me',
		status: 'reverted',
	})
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(1)
	const statuses = await Promise.all(
		priorItems.map(async (prior) => [
			prior.id,
			(await getPackageCodemodRunItemById(env.APP_DB, prior.id))?.status,
		]),
	)
	expect(statuses).toEqual([
		['item-pkg-keep-a', 'applied'],
		['item-pkg-revert', 'reverted'],
		['item-pkg-keep-b', 'applied'],
	])
})

test('package codemod step-level throw marks the run failed instead of leaving it running', async () => {
	setupMocks()
	const { env } = createEnv()
	mocks.listSavedPackagesPage.mockRejectedValue(new Error('paging boom'))

	await expect(
		step(env, { initiatedByUserId: 'admin-1', scope: fleetScope, limit: 5 }),
	).rejects.toThrow('paging boom')

	// The step threw before returning a runId, so look the run up directly.
	const runs = await listPackageCodemodRuns(env.APP_DB, { limit: 10 })
	expect(runs).toHaveLength(1)
	expect(runs[0]).toMatchObject({ status: 'failed' })
})

test('package codemod continuation steps heartbeat the run and reopen abandoned runs', async () => {
	setupMocks()
	const { env } = createEnv()
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		savedPackage('hb-a'),
		savedPackage('hb-b'),
	])
	mockSourcesByIdWith(cleanFiles)
	await createPackageCodemodRun(env.APP_DB, {
		id: 'run-heartbeat',
		codemodId,
		mode: 'scan',
		scopeUserId: 'user-1',
		initiatedByUserId: 'admin-1',
		status: 'abandoned',
		createdAt: '2026-07-30T10:00:00.000Z',
		updatedAt: '2026-07-30T10:00:00.000Z',
	})

	const heartbeat = await step(env, {
		initiatedByUserId: 'admin-1',
		runId: 'run-heartbeat',
		limit: 1,
	})
	expect(heartbeat.nextCursor).not.toBeNull()
	const reopened = await getPackageCodemodRunById(env.APP_DB, 'run-heartbeat')
	expect(reopened).toMatchObject({ status: 'running' })
	expect(reopened!.updatedAt > '2026-07-30T10:00:00.000Z').toBe(true)
})

const publishedOnlyCodemodId = publishedOnlyFixtureCodemod.id

function undeclaredWebhookFiles() {
	return {
		'package.json': `${JSON.stringify(
			{
				name: '@user/webhook-pkg',
				exports: { '.': './index.ts' },
				kody: {
					id: 'webhook-pkg',
					description: 'Webhook package with no verification declared.',
					webhooks: [{ path: '/hooks/demo' }],
				},
			},
			null,
			'\t',
		)}\n`,
		'index.ts': 'export {}\n',
	}
}

test('0012 dry-run and apply never rewrite or republish an undeclared webhook package', async () => {
	setupMocks()
	const { env, kv } = createEnv()
	const pkg = savedPackage('pkg-undeclared-webhook', {
		kodyId: 'webhook-pkg',
		sourceId: 'source-undeclared-webhook',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: undeclaredWebhookFiles(),
			publishedCommit: 'commit-published',
			repoId: 'repo-undeclared-webhook',
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-published',
	})

	for (const mode of ['dry-run', 'apply'] as const) {
		const result = await step(env, {
			mode,
			codemodId: explicitWebhookUrlSecretVerificationCodemodId,
		})
		expect(result.items[0]).toMatchObject({
			status: 'needs_manual',
			packageId: pkg.id,
			changedPaths: [],
			findings: [
				{
					path: 'package.json',
					message: expect.stringContaining('keeps working on its URL secret'),
				},
			],
		})
	}
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
	expect(mocks.syncPublishedSourceSnapshotOnly).not.toHaveBeenCalled()
	expect(mocks.refreshSavedPackageProjection).not.toHaveBeenCalled()
	expect(kv.store.size).toBe(0)
})

test('published-only apply on drifted packages uses syncPublishedSourceSnapshotOnly and never default-branch sync', async () => {
	setupMocks()
	const { env } = createEnv()
	const pkg = savedPackage('pkg-drift-published-only', {
		kodyId: 'webhook-pkg',
		sourceId: 'source-drift-published-only',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: undeclaredWebhookFiles(),
			publishedCommit: 'commit-published-old',
			repoId: 'repo-drift-published-only',
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-head-moved',
	})
	mocks.syncPublishedSourceSnapshotOnly.mockResolvedValue(
		'commit-published-only-after',
	)

	const apply = await step(env, {
		mode: 'apply',
		codemodId: publishedOnlyCodemodId,
	})
	expect(apply.items[0]).toMatchObject({
		status: 'applied',
		packageId: pkg.id,
		beforeCommit: 'commit-published-old',
		afterCommit: 'commit-published-only-after',
	})
	expect(mocks.syncPublishedSourceSnapshotOnly).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: pkg.sourceId,
			expectedPublishedCommit: 'commit-published-old',
			commitMessage: expect.stringContaining(publishedOnlyCodemodId),
		}),
	)
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('published-only apply promotes locked drifted packages via allowLockedPublish', async () => {
	setupMocks()
	const { env } = createEnv()
	const pkg = {
		...savedPackage('pkg-locked-drift-published-only', {
			kodyId: 'webhook-pkg',
			sourceId: 'source-locked-drift-published-only',
		}),
		lockedAt: '2026-10-12T00:00:00.000Z',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: undeclaredWebhookFiles(),
			publishedCommit: 'commit-published-old',
			repoId: 'repo-locked-drift-published-only',
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-head-moved',
	})
	mocks.syncPublishedSourceSnapshotOnly.mockResolvedValue(
		'commit-published-only-locked',
	)

	const apply = await step(env, {
		mode: 'apply',
		codemodId: publishedOnlyCodemodId,
	})
	expect(apply.items[0]).toMatchObject({
		status: 'applied',
		packageId: pkg.id,
		afterCommit: 'commit-published-only-locked',
	})
	expect(mocks.syncPublishedSourceSnapshotOnly).toHaveBeenCalledWith(
		expect.objectContaining({
			promotePublished: true,
			allowLockedPublish: true,
			expectedPublishedCommit: 'commit-published-old',
		}),
	)
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('published-only apply promotes locked aligned packages via allowLockedPublish', async () => {
	setupMocks()
	const { env } = createEnv()
	const pkg = {
		...savedPackage('pkg-locked-aligned-published-only', {
			kodyId: 'webhook-pkg',
			sourceId: 'source-locked-aligned-published-only',
		}),
		lockedAt: '2026-10-12T00:00:00.000Z',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: undeclaredWebhookFiles(),
			publishedCommit: 'commit-repo-aligned',
			repoId: 'repo-locked-aligned-published-only',
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-repo-aligned',
	})
	mocks.syncArtifactSourceSnapshot.mockResolvedValue(
		'commit-after-locked-aligned',
	)

	const apply = await step(env, {
		mode: 'apply',
		codemodId: publishedOnlyCodemodId,
	})
	expect(apply.items[0]).toMatchObject({
		status: 'applied',
		packageId: pkg.id,
		afterCommit: 'commit-after-locked-aligned',
	})
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			promotePublished: true,
			allowLockedPublish: true,
		}),
	)
	expect(mocks.syncPublishedSourceSnapshotOnly).not.toHaveBeenCalled()
})

test('published-only revert does not require HEAD to match afterCommit', async () => {
	setupMocks()
	const { env, kv } = createEnv()
	const pkg = savedPackage('pkg-revert-published-only', {
		kodyId: 'webhook-pkg',
		sourceId: 'source-revert-published-only',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: undeclaredWebhookFiles(),
			publishedCommit: 'commit-before',
			repoId: 'repo-revert-published-only',
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-head-still-drifted',
	})
	mocks.syncPublishedSourceSnapshotOnly.mockResolvedValue('commit-after-apply')

	const apply = await step(env, {
		mode: 'apply',
		codemodId: publishedOnlyCodemodId,
	})
	expect(apply.items[0]?.status).toBe('applied')
	const applyItemId = apply.items[0]!.itemId
	expect(
		kv.store.has(
			buildPackageCodemodRevertSnapshotKvKey({
				userId: ownerIdFromStored('user-1'),
				itemId: applyItemId,
			}),
		),
	).toBe(true)

	// HEAD remains drifted; published_commit still equals afterCommit.
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-user-unpublished-work',
	})
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: undeclaredWebhookFiles(),
			publishedCommit: 'commit-after-apply',
			repoId: 'repo-revert-published-only',
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
	mocks.syncPublishedSourceSnapshotOnly.mockResolvedValue('commit-reverted')

	const revert = await step(env, {
		mode: 'revert',
		codemodId: publishedOnlyCodemodId,
		revertOfRunId: apply.runId,
	})
	expect(revert.items[0]?.status).toBe('reverted')
	expect(mocks.syncPublishedSourceSnapshotOnly).toHaveBeenCalledWith(
		expect.objectContaining({
			expectedPublishedCommit: 'commit-after-apply',
		}),
	)
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('published-only codemod revert of an aligned apply uses syncArtifactSourceSnapshot', async () => {
	setupMocks()
	const { env } = createEnv()
	const pkg = savedPackage('pkg-revert-aligned-published-only', {
		kodyId: 'webhook-pkg',
		sourceId: 'source-revert-aligned-published-only',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: undeclaredWebhookFiles(),
			publishedCommit: 'commit-aligned',
			repoId: 'repo-revert-aligned-published-only',
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-aligned',
	})
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-after-aligned')

	const apply = await step(env, {
		mode: 'apply',
		codemodId: publishedOnlyCodemodId,
	})
	expect(apply.items[0]?.status).toBe('applied')
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(1)
	mocks.syncArtifactSourceSnapshot.mockClear()
	mocks.syncPublishedSourceSnapshotOnly.mockClear()

	// HEAD still at afterCommit — aligned apply must revert via default sync.
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-after-aligned',
	})
	mocks.loadPackageSourceBySourceId.mockResolvedValue(
		loadedSource({
			files: undeclaredWebhookFiles(),
			publishedCommit: 'commit-after-aligned',
			repoId: 'repo-revert-aligned-published-only',
			sourceId: pkg.sourceId,
			userId: pkg.userId,
		}),
	)
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-reverted-aligned')

	const revert = await step(env, {
		mode: 'revert',
		codemodId: publishedOnlyCodemodId,
		revertOfRunId: apply.runId,
	})
	expect(revert.items[0]?.status).toBe('reverted')
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(1)
	expect(mocks.syncPublishedSourceSnapshotOnly).not.toHaveBeenCalled()
})

async function seedOwnersMidDeletion(db: D1Database) {
	// Legacy deletion: fenced with deleting_at, never finished.
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, deleting_at)
			VALUES ('legacy', 'legacy@example.com', 'hash', 'owner-legacy', '2026-08-20T00:00:00.000Z')`,
		)
		.run()
	// Soft-deleted person inside the restore window.
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, deleted_at)
			VALUES ('restorable', 'restorable@example.com', 'hash', 'owner-soft', '2026-10-01T00:00:00.000Z')`,
		)
		.run()
	// Team org being purged.
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, entitlement_ladder, deleting_at, created_at, updated_at)
			VALUES ('org-deleting', 'org-deleting', 'Deleting', 'free', 'public', '2026-10-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES ('live', 'live@example.com', 'hash', 'owner-live')`,
		)
		.run()
}

test('fleet codemod steps skip packages whose owner is mid-deletion or deleted', async () => {
	setupMocks()
	const { env } = createEnv()
	await seedOwnersMidDeletion(env.APP_DB)
	const fleet = [
		savedPackage('pkg-a-legacy', { userId: 'owner-legacy' }),
		savedPackage('pkg-b-live', { userId: 'owner-live' }),
		savedPackage('pkg-c-org', { userId: 'org-deleting' }),
		savedPackage('pkg-d-soft', { userId: 'owner-soft' }),
	]
	mocks.listSavedPackagesPage.mockImplementation(
		async (_db: D1Database, input: { afterId: string | null }) =>
			fleet.filter(
				(pkg) =>
					input.afterId == null || pkg.id.localeCompare(input.afterId) > 0,
			),
	)
	mockSourcesByIdWith(cleanFiles)

	for (const mode of ['scan', 'dry-run'] as const) {
		mocks.loadPackageSourceBySourceId.mockClear()
		const result = await step(env, {
			initiatedByUserId: 'admin-1',
			mode,
			scope: fleetScope,
		})
		expect(result.items.map((item) => item.packageId)).toEqual(['pkg-b-live'])
		expect(result.summary.failed ?? 0).toBe(0)
		expect(result.nextCursor).toBeNull()
		expect(mocks.loadPackageSourceBySourceId).toHaveBeenCalledTimes(1)
	}
})

test('user-scoped codemod step on an owner mid-deletion records no items', async () => {
	setupMocks()
	const { env } = createEnv()
	await seedOwnersMidDeletion(env.APP_DB)
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		savedPackage('pkg-legacy-1', { userId: 'owner-legacy' }),
		savedPackage('pkg-legacy-2', { userId: 'owner-legacy' }),
	])
	mockSourcesByIdWith(cleanFiles)
	const result = await step(env, {
		scope: { kind: 'user', userId: ownerIdFromStored('owner-legacy') },
	})
	expect(result.items).toEqual([])
	expect(result.nextCursor).toBeNull()
	expect(mocks.loadPackageSourceBySourceId).not.toHaveBeenCalled()
})

test('fleet codemod revert skips applied items whose owner is mid-deletion', async () => {
	setupMocks()
	const { env, kv } = createEnv()
	await seedOwnersMidDeletion(env.APP_DB)
	await createPriorFleetApply(env.APP_DB, 'prior-apply-deleting-owner')
	const priorItems = [
		{ id: 'item-legacy', userId: 'owner-legacy', kodyId: 'legacy' },
		{ id: 'item-live', userId: 'owner-live', kodyId: 'live' },
	].map((prior) => ({
		...prior,
		userId: ownerIdFromStored(prior.userId),
		packageId: `pkg-${prior.kodyId}`,
		sourceId: `source-${prior.kodyId}`,
	}))
	for (const prior of priorItems) {
		const revertSnapshotKey = buildPackageCodemodRevertSnapshotKvKey({
			userId: prior.userId,
			itemId: prior.id,
		})
		await insertPackageCodemodRunItem(env.APP_DB, {
			id: prior.id,
			runId: 'prior-apply-deleting-owner',
			userId: prior.userId,
			packageId: prior.packageId,
			kodyId: prior.kodyId,
			status: 'applied',
			beforeCommit: `commit-${prior.sourceId}-before`,
			afterCommit: `commit-${prior.sourceId}`,
			changedPaths: ['index.ts'],
			revertSnapshotKey,
		})
		await kv.namespace.put(
			revertSnapshotKey,
			JSON.stringify({
				codemodId,
				userId: prior.userId,
				packageId: prior.packageId,
				beforeCommit: `commit-${prior.sourceId}-before`,
				files: cleanFiles(),
			}),
		)
	}
	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: D1Database, input: { userId: string }) =>
			priorItems
				.filter((prior) => prior.userId === input.userId)
				.map((prior) => savedPackage(prior.packageId, prior)),
	)
	mockSourcesByIdWith(cleanFiles)
	mocks.syncArtifactSourceSnapshot.mockResolvedValue('commit-reverted')

	const revert = await step(env, {
		initiatedByUserId: 'admin-1',
		mode: 'revert',
		scope: fleetScope,
		revertOfRunId: 'prior-apply-deleting-owner',
	})
	expect(revert.items.map((item) => [item.packageId, item.status])).toEqual([
		['pkg-live', 'reverted'],
	])
	expect(mocks.syncArtifactSourceSnapshot).toHaveBeenCalledTimes(1)
	expect(
		(await getPackageCodemodRunItemById(env.APP_DB, 'item-legacy'))?.status,
	).toBe('applied')
})

test('a package whose earlier attempts never finished is recorded as failed and paging moves on', async () => {
	setupMocks()
	const { env, kv } = createEnv()
	const pkg = savedPackage('pkg-unfinished', {
		kodyId: 'unfinished-pkg',
		sourceId: 'source-unfinished',
	})
	mocks.listSavedPackagesByUserId.mockResolvedValue([pkg])
	const get = kv.namespace.get.bind(kv.namespace)
	vi.spyOn(kv.namespace, 'get').mockImplementation(((
		key: string,
		...rest: Array<unknown>
	) =>
		key.startsWith('package-codemod-attempt:') && key.endsWith(`:${pkg.id}`)
			? Promise.resolve('2')
			: (get as (...args: Array<unknown>) => unknown)(
					key,
					...rest,
				)) as typeof kv.namespace.get)
	const deleteSpy = vi.spyOn(kv.namespace, 'delete')

	const result = await step(env, {
		mode: 'dry-run',
		codemodId: explicitWebhookUrlSecretVerificationCodemodId,
	})
	expect(result.items[0]).toMatchObject({
		status: 'failed',
		packageId: pkg.id,
		error: unfinishedAttemptsError,
	})
	expect(mocks.loadPackageSourceBySourceId).not.toHaveBeenCalled()
	const attemptKey = `package-codemod-attempt:${result.runId}:${pkg.id}`
	expect(deleteSpy).toHaveBeenCalledWith(attemptKey)

	const retried = await step(env, {
		mode: 'dry-run',
		codemodId: explicitWebhookUrlSecretVerificationCodemodId,
		runId: result.runId,
	})
	expect(retried.items).toEqual([])
	expect(mocks.loadPackageSourceBySourceId).not.toHaveBeenCalled()
})

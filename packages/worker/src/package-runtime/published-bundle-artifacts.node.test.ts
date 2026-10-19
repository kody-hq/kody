import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactRepo from '#worker/repo/published-bundle-artifacts-repo.ts'
import type * as PublishedRuntimeArtifacts from './published-runtime-artifacts.ts'
import {
	isPublishedPackageArtifactBuiltForCommit,
	loadPublishedBundleArtifactByIdentity,
	rebuildPublishedPackageArtifacts,
	reusePublishedPackageArtifactIfUnchanged,
} from './published-bundle-artifacts.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	listEntitySourcesByIds: vi.fn(
		async (_db: unknown, ids: ReadonlyArray<string>) => {
			const sources = []
			for (const id of ids) {
				const forUser = await mockModule.getEntitySourceByIdForUser(_db, {
					id,
					userId: ownerIdFromStored('user-1'),
				})
				if (forUser) {
					sources.push(forUser)
					continue
				}
				const any = await mockModule.getEntitySourceById(_db, id)
				if (any) sources.push(any)
			}
			return sources
		},
	),
	getPublishedBundleArtifactByIdentity: vi.fn(),
	insertPublishedBundleArtifactRow: vi.fn(),
	readPublishedBundleArtifact: vi.fn(),
	readPublishedSourceSnapshot: vi.fn(),
	updatePublishedBundleArtifactRow: vi.fn(),
	upsertPublishedBundleArtifactRow: vi.fn(
		async (db: unknown, input: { userId: string; sourceId: string }) => {
			const existing = await mockModule.getPublishedBundleArtifactByIdentity(
				db,
				input,
			)
			if (existing) {
				await mockModule.updatePublishedBundleArtifactRow(db, {
					id: existing.id,
					...input,
				})
				return existing.id
			}
			return await mockModule.insertPublishedBundleArtifactRow(db, input)
		},
	),
	writePublishedBundleArtifact: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
	listEntitySourcesByIds: (db: unknown, ids: ReadonlyArray<string>) =>
		mockModule.listEntitySourcesByIds(db, ids),
}))

vi.mock('#worker/repo/published-bundle-artifacts-repo.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactRepo>(
		'#worker/repo/published-bundle-artifacts-repo.ts',
	)
	return {
		...actual,
		getPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.getPublishedBundleArtifactByIdentity(...args),
		insertPublishedBundleArtifactRow: (...args: Array<unknown>) =>
			mockModule.insertPublishedBundleArtifactRow(...args),
		updatePublishedBundleArtifactRow: (...args: Array<unknown>) =>
			mockModule.updatePublishedBundleArtifactRow(...args),
		upsertPublishedBundleArtifactRow: (
			...args: Parameters<
				typeof PublishedBundleArtifactRepo.upsertPublishedBundleArtifactRow
			>
		) => mockModule.upsertPublishedBundleArtifactRow(...args),
	}
})

vi.mock('./published-runtime-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedRuntimeArtifacts>(
		'./published-runtime-artifacts.ts',
	)
	return {
		...actual,
		readPublishedBundleArtifact: (...args: Array<unknown>) =>
			mockModule.readPublishedBundleArtifact(...args),
		readPublishedSourceSnapshot: (...args: Array<unknown>) =>
			mockModule.readPublishedSourceSnapshot(...args),
		writePublishedBundleArtifact: (...args: Array<unknown>) =>
			mockModule.writePublishedBundleArtifact(...args),
	}
})

const kvEnv = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as unknown as Env
const envWithoutKv = { APP_DB: {} } as unknown as Env

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'artifact-row-1',
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		artifactKind: 'module',
		artifactName: '.',
		entryPoint: 'src/index.ts',
		kvKey: 'kv:module',
		dependenciesJson: '[]',
		createdAt: '2026-05-13T00:00:00.000Z',
		updatedAt: '2026-05-13T00:00:00.000Z',
		...overrides,
	}
}

function makeKvArtifact(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		kind: 'module',
		artifactName: '.',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		entryPoint: 'src/index.ts',
		mainModule: 'dist/index.js',
		modules: { 'dist/index.js': 'export default {}' },
		dependencies: [],
		dynamicDependencies: [],
		packageContext: null,
		createdAt: '2026-05-13T00:00:00.000Z',
		...overrides,
	}
}

function makeBuilder(prefix: string, body: string) {
	return vi.fn(async ({ entryPoint }: { entryPoint: string }) => {
		const mainModule = `dist/${prefix}${entryPoint.replaceAll('/', '_')}.js`
		return { mainModule, modules: { [mainModule]: body }, dependencies: [] }
	})
}

type RebuildInput = Parameters<typeof rebuildPublishedPackageArtifacts>[0]

function makeRebuildInput(input: {
	name: string
	description: string
	kody?: Record<string, unknown>
	exports?: Record<string, string>
	hasApp?: boolean
	publishedCommit?: string
	env?: Env
	buildAppBundle?: RebuildInput['buildAppBundle']
	buildModuleBundle?: RebuildInput['buildModuleBundle']
	buildImportableModuleBundle?: RebuildInput['buildImportableModuleBundle']
}): RebuildInput {
	const kodyId = input.name.split('/')[1]!
	return {
		env:
			input.env ??
			({
				APP_DB: {},
				BUNDLE_ARTIFACTS_KV: {
					get: async () => null,
					put: async () => undefined,
					delete: async () => undefined,
				},
			} as unknown as Env),
		userId: ownerIdFromStored('user-1'),
		source: {
			id: 'source-1',
			user_id: ownerIdFromStored('user-1'),
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: input.publishedCommit ?? 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			external_check_until: null,
			created_at: '2026-04-30T00:00:00.000Z',
			updated_at: '2026-04-30T00:00:00.000Z',
		},
		savedPackage: {
			id: 'pkg-1',
			userId: ownerIdFromStored('user-1'),
			name: input.name,
			kodyId,
			description: input.description,
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: input.hasApp ?? false,
			hasSkills: false,
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
			lockedAt: null,
			createdAt: '2026-04-30T00:00:00.000Z',
			updatedAt: '2026-04-30T00:00:00.000Z',
		},
		manifest: {
			name: input.name,
			exports: input.exports ?? { '.': './src/index.ts' },
			kody: { id: kodyId, description: input.description, ...input.kody },
		},
		buildAppBundle: input.buildAppBundle ?? vi.fn(),
		buildAppClientBundle: vi.fn(),
		buildModuleBundle: input.buildModuleBundle ?? vi.fn(),
		buildImportableModuleBundle: input.buildImportableModuleBundle ?? vi.fn(),
	} as RebuildInput
}

function stubFreshRebuildPersistence(kvKey = 'kv:key') {
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.writePublishedBundleArtifact.mockResolvedValue(kvKey)
	mockModule.insertPublishedBundleArtifactRow.mockResolvedValue(undefined)
}

test('isPublishedBundleArtifactCurrentForCommit rejects prior-commit leftovers', async () => {
	const { isPublishedBundleArtifactCurrentForCommit } =
		await import('./published-bundle-artifacts.ts')
	expect(
		isPublishedBundleArtifactCurrentForCommit({
			artifact: { publishedCommit: 'commit-old' },
			rowPublishedCommit: 'commit-old',
			currentPublishedCommit: 'commit-new',
		}),
	).toBe(false)
	expect(
		isPublishedBundleArtifactCurrentForCommit({
			artifact: { publishedCommit: 'commit-new' },
			rowPublishedCommit: 'commit-new',
			currentPublishedCommit: 'commit-new',
		}),
	).toBe(true)
	expect(
		isPublishedBundleArtifactCurrentForCommit({
			artifact: { publishedCommit: 'commit-new' },
			rowPublishedCommit: 'commit-old',
			currentPublishedCommit: 'commit-new',
		}),
	).toBe(false)
})

test('loadPublishedBundleArtifactByIdentity treats mismatched and malformed KV artifact payloads as cache misses', async () => {
	const identity = {
		sourceId: 'source-email-received-subscriber',
		publishedCommit: 'commit-email-received-subscriber',
		artifactKind: 'importable-module',
		artifactName: './workflow-approved-email',
		entryPoint: 'src/workflow-approved-email.ts',
	}
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeRow({ ...identity, kvKey: 'kv:workflow-approved-email' }),
	)
	mockModule.readPublishedBundleArtifact
		.mockResolvedValueOnce(
			makeKvArtifact({
				kind: 'importable-module',
				sourceId: 'source-ai-chat',
				publishedCommit: 'commit-ai-chat',
				packageContext: {
					packageId: 'pkg-ai-chat',
					kodyId: 'ai-chat',
					sourceId: 'source-ai-chat',
				},
			}),
		)
		.mockResolvedValueOnce(
			makeKvArtifact({
				kind: 'importable-module',
				artifactName: identity.artifactName,
				sourceId: identity.sourceId,
				publishedCommit: identity.publishedCommit,
				entryPoint: '',
				packageContext: {
					packageId: 'pkg-email-received-subscriber',
					kodyId: 'email-received-subscriber',
					sourceId: identity.sourceId,
				},
			}),
		)

	// First read: identity mismatch; second read: malformed (empty entryPoint).
	for (let read = 0; read < 2; read += 1) {
		expect(
			await loadPublishedBundleArtifactByIdentity({
				env: kvEnv,
				userId: ownerIdFromStored('user-1'),
				sourceId: identity.sourceId,
				kind: 'importable-module',
				artifactName: identity.artifactName,
				entryPoint: './src/workflow-approved-email.ts',
			}),
		).toEqual({
			row: expect.objectContaining({
				sourceId: identity.sourceId,
				artifactName: identity.artifactName,
				entryPoint: identity.entryPoint,
			}),
			artifact: null,
		})
	}
})

test('isPublishedPackageArtifactBuiltForCommit requires matching row and KV artifact for the commit', async () => {
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(null)
	const isBuilt = (env = kvEnv) =>
		isPublishedPackageArtifactBuiltForCommit({
			env,
			userId: ownerIdFromStored('user-1'),
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			target: {
				kind: 'module',
				artifactName: '.',
				entryPoint: 'src/index.ts',
				bundleKind: 'module',
			},
		})

	expect(await isBuilt(envWithoutKv)).toBe(false)
	expect(mockModule.getPublishedBundleArtifactByIdentity).not.toHaveBeenCalled()

	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValueOnce(null)
	expect(await isBuilt()).toBe(false)

	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(makeRow())
	mockModule.readPublishedBundleArtifact.mockResolvedValueOnce(null)
	expect(await isBuilt()).toBe(false)

	// Identity mismatch (KV commit differs from row) is treated as a miss.
	mockModule.readPublishedBundleArtifact.mockResolvedValueOnce(
		makeKvArtifact({ publishedCommit: 'commit-old' }),
	)
	expect(await isBuilt()).toBe(false)

	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeRow({ publishedCommit: 'commit-old' }),
	)
	mockModule.readPublishedBundleArtifact.mockResolvedValueOnce(
		makeKvArtifact({ publishedCommit: 'commit-old' }),
	)
	expect(await isBuilt()).toBe(false)

	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(makeRow())
	mockModule.readPublishedBundleArtifact.mockResolvedValue(makeKvArtifact())
	expect(await isBuilt()).toBe(true)

	const invalidatedAt = {
		invalidateArtifactsBefore: '2026-09-05T16:00:00.000Z',
	}
	mockModule.readPublishedSourceSnapshot.mockResolvedValueOnce(invalidatedAt)
	expect(await isBuilt()).toBe(false)

	mockModule.readPublishedBundleArtifact.mockResolvedValueOnce(
		makeKvArtifact({ createdAt: '2026-09-05T16:00:01.000Z' }),
	)
	mockModule.readPublishedSourceSnapshot.mockResolvedValueOnce(invalidatedAt)
	expect(await isBuilt()).toBe(true)
})

test('rebuildPublishedPackageArtifacts bundles declared subscription handlers', async () => {
	stubFreshRebuildPersistence()
	const buildAppBundle = vi.fn()
	const buildModuleBundle = makeBuilder(
		'',
		'export default async function run() { return "ok" }',
	)
	const buildImportableModuleBundle = makeBuilder(
		'importable_',
		'export default async function run(input) { return input }',
	)

	await rebuildPublishedPackageArtifacts(
		makeRebuildInput({
			name: '@kentcdodds/email-automation',
			description: 'Email automation package',
			kody: {
				subscriptions: {
					'email.message.received': {
						handler: './src/on-email-received.ts',
					},
					'email.message.quarantined': {
						handler: './src/on-email-quarantined.ts',
					},
				},
			},
			buildAppBundle,
			buildModuleBundle,
			buildImportableModuleBundle,
		}),
	)

	expect(buildAppBundle).not.toHaveBeenCalled()
	for (const entryPoint of [
		'src/index.ts',
		'src/on-email-received.ts',
		'src/on-email-quarantined.ts',
	]) {
		expect(buildModuleBundle).toHaveBeenCalledWith({ entryPoint })
	}
	expect(buildImportableModuleBundle).toHaveBeenCalledTimes(1)
	expect(buildImportableModuleBundle).toHaveBeenCalledWith({
		entryPoint: 'src/index.ts',
	})
	expect(
		mockModule.insertPublishedBundleArtifactRow.mock.calls.map((call) => [
			call[1].artifactKind,
			call[1].artifactName,
		]),
	).toEqual([
		['module', '.'],
		['importable-module', '.'],
		['module', 'subscription:email.message.quarantined'],
		['module', 'subscription:email.message.received'],
	])
})

test('rebuildPublishedPackageArtifacts stores app bundles with artifactName null', async () => {
	stubFreshRebuildPersistence('kv:app')
	const buildAppBundle = vi.fn(async () => ({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js':
				'export default { async fetch() { return new Response("ok") } }',
		},
		dependencies: [],
	}))

	await rebuildPublishedPackageArtifacts(
		makeRebuildInput({
			name: '@kentcdodds/example-app',
			description: 'Example app package',
			exports: {},
			kody: { app: { entry: 'app.js' } },
			hasApp: true,
			buildAppBundle,
		}),
	)

	expect(buildAppBundle).toHaveBeenCalledWith({ entryPoint: 'app.js' })
	expect(mockModule.insertPublishedBundleArtifactRow).toHaveBeenCalledTimes(1)
	expect(mockModule.insertPublishedBundleArtifactRow).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			artifactKind: 'app',
			artifactName: null,
			entryPoint: 'app.js',
		}),
	)
	expect(mockModule.writePublishedBundleArtifact).toHaveBeenCalledWith(
		expect.objectContaining({
			kvKey: 'bundle-artifact:v1:source-1:commit-1:app:_:app.js',
			artifact: expect.objectContaining({
				version: 1,
				kind: 'app',
			}),
		}),
	)
})

test('rebuildPublishedPackageArtifacts uses builder dependency metadata instead of package-wide fallback scans', async () => {
	stubFreshRebuildPersistence()

	await rebuildPublishedPackageArtifacts(
		makeRebuildInput({
			name: '@kentcdodds/reachable-only',
			description: 'Reachable-only dependency package',
			buildModuleBundle: makeBuilder(
				'',
				'export default async function run() { return "ok" }',
			),
			buildImportableModuleBundle: makeBuilder(
				'importable_',
				'export const ready = true',
			),
		}),
	)

	expect(mockModule.getEntitySourceById).not.toHaveBeenCalled()
	expect(
		mockModule.insertPublishedBundleArtifactRow.mock.calls.map(
			(call) => call[1].dependenciesJson,
		),
	).toEqual(['[]', '[]'])
})

test('rebuildPublishedPackageArtifacts overlaps a bounded number of target builds', async () => {
	stubFreshRebuildPersistence()
	let resolveGate: (() => void) | undefined
	const gate = new Promise<void>((resolve) => {
		resolveGate = resolve
	})
	let inFlight = 0
	let maxInFlight = 0
	const trackingBuilder = (prefix: string) => {
		const build = makeBuilder(prefix, 'export default async function run() {}')
		return vi.fn(async (input: { entryPoint: string }) => {
			inFlight += 1
			maxInFlight = Math.max(maxInFlight, inFlight)
			await gate
			inFlight -= 1
			return await build(input)
		})
	}
	const buildModuleBundle = trackingBuilder('')
	const buildImportableModuleBundle = trackingBuilder('importable_')

	const rebuildPromise = rebuildPublishedPackageArtifacts(
		makeRebuildInput({
			name: '@kentcdodds/multi-export',
			description: 'Multi-export package',
			exports: { '.': './src/index.ts', './hello': './src/hello.ts' },
			buildModuleBundle,
			buildImportableModuleBundle,
		}),
	)

	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (maxInFlight >= 2) break
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	expect(maxInFlight).toBe(2)
	resolveGate?.()
	await rebuildPromise
	expect(buildModuleBundle).toHaveBeenCalledTimes(2)
	expect(buildImportableModuleBundle).toHaveBeenCalledTimes(2)
})

const reusePreviousFiles = {
	'package.json': JSON.stringify({
		name: '@alice/multi-export',
		exports: { '.': './src/a.ts', './b': './src/b.ts' },
		kody: { id: 'multi-export', description: 'fixture' },
	}),
	'src/a.ts': `import { shared } from './shared.ts'\nexport default async function a() { return shared('a') }\n`,
	'src/b.ts': `export default async function b() { return 'b' }\n`,
	'src/shared.ts': `export function shared(label: string) { return label }\n`,
}

function priorModuleArtifact(input: {
	artifactName: string
	entryPoint: string
	publishedCommit?: string
	artifactKind?: 'module' | 'importable-module'
}) {
	const publishedCommit = input.publishedCommit ?? 'commit-old'
	const artifactKind = input.artifactKind ?? 'module'
	const mainModule = `dist/${input.entryPoint.replaceAll('/', '_')}.js`
	return {
		row: makeRow({
			id:
				artifactKind === 'module'
					? `row-${input.artifactName}`
					: `row-${artifactKind}-${input.artifactName}`,
			publishedCommit,
			artifactKind,
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
			kvKey: `bundle-artifact:v1:source-1:${publishedCommit}:${artifactKind}:${input.artifactName}:${input.entryPoint}`,
		}),
		artifact: {
			...makeKvArtifact({
				kind: artifactKind,
				publishedCommit,
				artifactName: input.artifactName,
				entryPoint: input.entryPoint,
				mainModule,
				modules: {
					[mainModule]: 'export default async function run() { return "ok" }',
				},
				packageContext: {
					packageId: 'pkg-1',
					kodyId: 'multi-export',
					sourceId: 'source-1',
				},
			}),
			dependencies: [] as Array<Record<string, unknown>>,
		},
	}
}

/** Prior-commit artifacts for `src/a.ts` (`.`) and `src/b.ts` (`./b`); `snapshots` maps commit -> file overrides. */
function stubPriorArtifacts(
	snapshots: Record<string, Record<string, string>>,
	moduleKindOnly = false,
) {
	const priorA = priorModuleArtifact({
		artifactName: '.',
		entryPoint: 'src/a.ts',
	})
	const priorB = priorModuleArtifact({
		artifactName: './b',
		entryPoint: 'src/b.ts',
	})
	const artifactsByEntry = new Map([
		['src/a.ts', priorA],
		['src/b.ts', priorB],
	])
	mockModule.getPublishedBundleArtifactByIdentity.mockImplementation(
		async (
			_db: unknown,
			query: { entryPoint: string; artifactKind: string },
		) => {
			if (moduleKindOnly && query.artifactKind !== 'module') return null
			return artifactsByEntry.get(query.entryPoint)?.row ?? null
		},
	)
	mockModule.readPublishedBundleArtifact.mockImplementation(
		async (input: { kvKey: string }) =>
			[...artifactsByEntry.values()].find(
				(loaded) => loaded.row.kvKey === input.kvKey,
			)?.artifact ?? null,
	)
	stubSnapshots(snapshots)
	return { priorA, priorB }
}

function stubSnapshots(snapshots: Record<string, Record<string, string>>) {
	mockModule.readPublishedSourceSnapshot.mockImplementation(
		async (input: { publishedCommit: string }) => {
			const overrides = snapshots[input.publishedCommit]
			return overrides
				? { files: { ...reusePreviousFiles, ...overrides } }
				: null
		},
	)
}

const changedB = {
	'src/b.ts': `export default async function b() { return 'b-changed' }\n`,
}

test('reusePublishedPackageArtifactIfUnchanged copies clean targets and rebuilds dirty, missing, or same-commit leftovers', async () => {
	mockModule.writePublishedBundleArtifact.mockResolvedValue('kv:reused')
	mockModule.updatePublishedBundleArtifactRow.mockResolvedValue(true)
	const { priorA } = stubPriorArtifacts({
		'commit-old': {},
		'commit-2': changedB,
	})
	const reuse = (input: {
		entry: 'a' | 'b' | 'missing'
		publishedCommit?: string
		snapshotCache?: Parameters<
			typeof reusePublishedPackageArtifactIfUnchanged
		>[0]['snapshotCache']
		env?: Env
	}) =>
		reusePublishedPackageArtifactIfUnchanged({
			env: input.env ?? kvEnv,
			userId: ownerIdFromStored('user-1'),
			sourceId: 'source-1',
			publishedCommit: input.publishedCommit ?? 'commit-2',
			target: {
				kind: 'module',
				artifactName: input.entry === 'a' ? '.' : `./${input.entry}`,
				entryPoint: `src/${input.entry}.ts`,
				bundleKind: 'module',
			},
			...(input.snapshotCache ? { snapshotCache: input.snapshotCache } : {}),
		})

	const snapshotCache = new Map()
	expect(await reuse({ entry: 'a', snapshotCache })).toBe(true)
	expect(mockModule.writePublishedBundleArtifact).toHaveBeenCalledWith(
		expect.objectContaining({
			kvKey: 'bundle-artifact:v1:source-1:commit-2:module:.:src/a.ts',
			artifact: expect.objectContaining({
				publishedCommit: 'commit-2',
				entryPoint: 'src/a.ts',
				modules: priorA.artifact.modules,
			}),
		}),
	)
	expect(mockModule.updatePublishedBundleArtifactRow).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			id: 'row-.',
			publishedCommit: 'commit-2',
			kvKey: 'bundle-artifact:v1:source-1:commit-2:module:.:src/a.ts',
		}),
	)
	expect(await reuse({ entry: 'b', snapshotCache })).toBe(false)

	// A changed local import dirties only the importing target.
	stubSnapshots({
		'commit-old': {},
		'commit-shared': {
			'src/shared.ts': `export function shared(label: string) { return label.toUpperCase() }\n`,
		},
	})
	const sharedSnapshotCache = new Map()
	for (const [entry, reused] of [
		['a', false],
		['b', true],
	] as const) {
		expect(
			await reuse({
				entry,
				publishedCommit: 'commit-shared',
				snapshotCache: sharedSnapshotCache,
			}),
		).toBe(reused)
	}

	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValueOnce(null)
	expect(await reuse({ entry: 'missing' })).toBe(false)

	mockModule.readPublishedSourceSnapshot.mockResolvedValueOnce(null)
	expect(await reuse({ entry: 'a' })).toBe(false)

	const sameCommit = priorModuleArtifact({
		artifactName: '.',
		entryPoint: 'src/a.ts',
		publishedCommit: 'commit-2',
	})
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValueOnce(
		sameCommit.row,
	)
	mockModule.readPublishedBundleArtifact.mockResolvedValueOnce(
		sameCommit.artifact,
	)
	expect(await reuse({ entry: 'a' })).toBe(false)

	expect(await reuse({ entry: 'a', env: envWithoutKv })).toBe(false)

	const staleDep = priorModuleArtifact({
		artifactName: '.',
		entryPoint: 'src/a.ts',
	})
	staleDep.artifact.dependencies = [
		{ sourceId: 'source-dep', publishedCommit: 'dep-old', kodyId: 'dep' },
	]
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(
		staleDep.row,
	)
	mockModule.readPublishedBundleArtifact.mockResolvedValue(staleDep.artifact)
	stubSnapshots({ 'commit-old': {}, 'commit-2': {} })
	mockModule.getEntitySourceByIdForUser.mockResolvedValue({
		id: 'source-dep',
		user_id: ownerIdFromStored('user-1'),
		published_commit: 'dep-new',
	})
	mockModule.writePublishedBundleArtifact.mockClear()
	expect(await reuse({ entry: 'a' })).toBe(false)
	expect(mockModule.writePublishedBundleArtifact).not.toHaveBeenCalled()

	mockModule.getEntitySourceByIdForUser.mockResolvedValue({
		id: 'source-dep',
		user_id: ownerIdFromStored('user-1'),
		published_commit: 'dep-old',
	})
	mockModule.updatePublishedBundleArtifactRow.mockResolvedValueOnce(false)
	expect(await reuse({ entry: 'a' })).toBe(false)
})

test('rebuildPublishedPackageArtifacts reuses unchanged prior artifacts and only rebuilds dirty targets', async () => {
	mockModule.writePublishedBundleArtifact.mockResolvedValue('kv:key')
	mockModule.updatePublishedBundleArtifactRow.mockResolvedValue(true)
	mockModule.insertPublishedBundleArtifactRow.mockResolvedValue(undefined)
	stubPriorArtifacts({ 'commit-old': {}, 'commit-2': changedB }, true)
	const rebuilt = 'export default async function run() { return "rebuilt" }'
	const buildModuleBundle = makeBuilder('', rebuilt)
	const buildImportableModuleBundle = makeBuilder('importable_', rebuilt)

	await rebuildPublishedPackageArtifacts(
		makeRebuildInput({
			name: '@alice/multi-export',
			description: 'fixture',
			exports: { '.': './src/a.ts', './b': './src/b.ts' },
			publishedCommit: 'commit-2',
			env: kvEnv,
			buildModuleBundle,
			buildImportableModuleBundle,
		}),
	)

	expect(buildModuleBundle).toHaveBeenCalledTimes(1)
	expect(buildModuleBundle).toHaveBeenCalledWith({ entryPoint: 'src/b.ts' })
	expect(buildImportableModuleBundle).toHaveBeenCalledTimes(2)
	expect(mockModule.updatePublishedBundleArtifactRow).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			id: 'row-.',
			publishedCommit: 'commit-2',
			entryPoint: 'src/a.ts',
		}),
	)
})

test('rebuildPublishedPackageArtifacts shares snapshot reads across already-built targets and batches dependency source lookups', async () => {
	const built = priorModuleArtifact({
		artifactName: '.',
		entryPoint: 'src/a.ts',
		publishedCommit: 'commit-built',
	})
	const builtImportable = priorModuleArtifact({
		artifactName: '.',
		entryPoint: 'src/a.ts',
		publishedCommit: 'commit-built',
		artifactKind: 'importable-module',
	})
	mockModule.getPublishedBundleArtifactByIdentity.mockImplementation(
		async (
			_db: unknown,
			query: { artifactKind: string; entryPoint: string },
		) => {
			if (query.entryPoint !== 'src/a.ts') return null
			return query.artifactKind === 'importable-module'
				? builtImportable.row
				: built.row
		},
	)
	mockModule.readPublishedBundleArtifact.mockImplementation(
		async (input: { kvKey: string }) => {
			if (input.kvKey === builtImportable.row.kvKey) {
				return {
					...builtImportable.artifact,
					kind: 'importable-module',
					createdAt: '2026-09-05T16:00:01.000Z',
				}
			}
			return {
				...built.artifact,
				createdAt: '2026-09-05T16:00:01.000Z',
			}
		},
	)
	mockModule.readPublishedSourceSnapshot.mockResolvedValue({
		files: reusePreviousFiles,
		invalidateArtifactsBefore: '2026-09-05T16:00:00.000Z',
	})
	mockModule.listEntitySourcesByIds.mockClear()
	mockModule.readPublishedSourceSnapshot.mockClear()
	mockModule.readPublishedSourceSnapshot.mockResolvedValue({
		files: reusePreviousFiles,
		invalidateArtifactsBefore: '2026-09-05T16:00:00.000Z',
	})

	await rebuildPublishedPackageArtifacts(
		makeRebuildInput({
			name: '@alice/already-built',
			description: 'fixture',
			exports: { '.': './src/a.ts' },
			publishedCommit: 'commit-built',
			env: kvEnv,
			buildModuleBundle: vi.fn(),
			buildImportableModuleBundle: vi.fn(),
		}),
	)

	// module + importable already-built checks share one snapshot read.
	expect(mockModule.readPublishedSourceSnapshot).toHaveBeenCalledTimes(1)

	const depArtifact = priorModuleArtifact({
		artifactName: '.',
		entryPoint: 'src/a.ts',
		publishedCommit: 'commit-old',
	})
	depArtifact.artifact.dependencies = [
		{ sourceId: 'source-dep-a', publishedCommit: 'dep-1', kodyId: 'dep-a' },
		{ sourceId: 'source-dep-b', publishedCommit: 'dep-1', kodyId: 'dep-b' },
	]
	depArtifact.row.publishedCommit = 'commit-old'
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(
		depArtifact.row,
	)
	mockModule.readPublishedBundleArtifact.mockResolvedValue(depArtifact.artifact)
	stubSnapshots({ 'commit-old': {}, 'commit-reuse': {} })
	mockModule.listEntitySourcesByIds.mockResolvedValue([
		{
			id: 'source-dep-a',
			user_id: ownerIdFromStored('user-1'),
			published_commit: 'dep-1',
		},
		{
			id: 'source-dep-b',
			user_id: ownerIdFromStored('user-1'),
			published_commit: 'dep-1',
		},
	])
	mockModule.writePublishedBundleArtifact.mockResolvedValue('kv:reused')
	mockModule.updatePublishedBundleArtifactRow.mockResolvedValue(true)
	mockModule.listEntitySourcesByIds.mockClear()

	expect(
		await reusePublishedPackageArtifactIfUnchanged({
			env: kvEnv,
			userId: ownerIdFromStored('user-1'),
			sourceId: 'source-1',
			publishedCommit: 'commit-reuse',
			target: {
				kind: 'module',
				artifactName: '.',
				entryPoint: 'src/a.ts',
				bundleKind: 'module',
			},
		}),
	).toBe(true)
	expect(mockModule.listEntitySourcesByIds).toHaveBeenCalledTimes(1)
	expect(mockModule.listEntitySourcesByIds).toHaveBeenCalledWith(
		{},
		expect.arrayContaining(['source-dep-a', 'source-dep-b']),
	)
	expect(mockModule.getEntitySourceByIdForUser).not.toHaveBeenCalled()
})

test('sequential reuse checks without a shared dependency cache see a dependency publish', async () => {
	const depArtifact = priorModuleArtifact({
		artifactName: '.',
		entryPoint: 'src/a.ts',
		publishedCommit: 'commit-old',
	})
	depArtifact.artifact.dependencies = [
		{ sourceId: 'source-dep-a', publishedCommit: 'dep-1', kodyId: 'dep-a' },
	]
	depArtifact.row.publishedCommit = 'commit-old'
	mockModule.getPublishedBundleArtifactByIdentity.mockResolvedValue(
		depArtifact.row,
	)
	mockModule.readPublishedBundleArtifact.mockResolvedValue(depArtifact.artifact)
	stubSnapshots({ 'commit-old': {}, 'commit-reuse': {} })
	mockModule.writePublishedBundleArtifact.mockResolvedValue('kv:reused')
	mockModule.updatePublishedBundleArtifactRow.mockResolvedValue(true)

	let depCommit = 'dep-1'
	mockModule.listEntitySourcesByIds.mockImplementation(async () => [
		{
			id: 'source-dep-a',
			user_id: ownerIdFromStored('user-1'),
			published_commit: depCommit,
		},
	])

	const reuseInput = {
		env: kvEnv,
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-1',
		publishedCommit: 'commit-reuse',
		target: {
			kind: 'module' as const,
			artifactName: '.',
			entryPoint: 'src/a.ts',
			bundleKind: 'module' as const,
		},
	}

	// External rebuild filters targets without sharing dependencySourceCache
	// across sequential targets, so each check loads current dependency rows.
	expect(await reusePublishedPackageArtifactIfUnchanged(reuseInput)).toBe(true)
	depCommit = 'dep-2'
	expect(await reusePublishedPackageArtifactIfUnchanged(reuseInput)).toBe(false)
	expect(mockModule.listEntitySourcesByIds).toHaveBeenCalledTimes(2)
})

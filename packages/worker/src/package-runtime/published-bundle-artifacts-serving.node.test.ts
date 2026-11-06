import {
	servingArtifactCommitForSource,
	toServingSourceView,
} from '#worker/repo/serving-commit.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	advanceEntitySourceServingCommit,
	getEntitySourceById,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'
import {
	createBundleArtifactsKv,
	createDatabase,
	insertPublishedEntitySource,
} from '#worker/test-support/jobs-service.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	rebuildPublishedPackageArtifacts,
} from './published-bundle-artifacts.ts'
import { writePublishedSourceSnapshot } from './published-runtime-artifacts.ts'

const userId = ownerIdFromStored('user-serving')
const sourceId = 'source-serving'
const packageId = 'pkg-serving'
const kodyId = 'serving'
const manifestJson = {
	name: '@kody/serving',
	exports: { '.': './src/index.ts' },
	kody: {
		id: kodyId,
		description: 'Serves one complete build at a time',
		jobs: {
			nightly: {
				entry: './src/job.ts',
				schedule: { type: 'interval', every: '1h' },
			},
		},
	},
}

function packageFiles(commit: string) {
	return {
		'package.json': JSON.stringify(manifestJson),
		'src/index.ts': `export const commit = "${commit}"`,
		'src/job.ts': `export default async () => "${commit}"`,
	}
}

function bundleFor(commit: string) {
	return async () => ({
		mainModule: 'dist/entry.js',
		modules: { 'dist/entry.js': `export const bundle = "bundle-${commit}"` },
		dependencies: [],
	})
}

async function setUp() {
	const db = createDatabase()
	const kv = createBundleArtifactsKv()
	const env = { APP_DB: db, BUNDLE_ARTIFACTS_KV: kv } as unknown as Env
	await insertPublishedEntitySource({
		db,
		userId,
		sourceId,
		entityKind: 'package',
		entityId: packageId,
		publishedCommit: 'commit-1',
		kv,
		files: packageFiles('commit-1'),
	})
	const source = async () => {
		const row = await getEntitySourceById(db, sourceId)
		if (!row) throw new Error('Expected source row.')
		return row
	}
	const rebuild = async (input: {
		module: () => Promise<unknown>
		importable: () => Promise<unknown>
	}) =>
		await rebuildPublishedPackageArtifacts({
			env,
			userId,
			source: await source(),
			savedPackage: { id: packageId, kodyId, sourceId } as SavedPackageRecord,
			manifest: parseAuthoredPackageJson({
				content: JSON.stringify(manifestJson),
			}),
			buildAppBundle: bundleFor('unused'),
			buildAppClientBundle: bundleFor('unused'),
			buildModuleBundle: input.module as never,
			buildImportableModuleBundle: input.importable as never,
		})
	/** Finalize moves `published_commit` before publish builds the targets. */
	const publish = async (commit: string) => {
		await updateEntitySource(db, {
			id: sourceId,
			userId,
			publishedCommit: commit,
		})
		await writePublishedSourceSnapshot({
			env,
			source: await source(),
			files: packageFiles(commit),
		})
	}
	/** What a runtime reader (import, invoke, job) loads for each target. */
	const served = async () => {
		const view = toServingSourceView(await source())
		const load = async (
			kind: 'module' | 'importable-module' | 'job',
			artifactName: string,
			entryPoint: string,
		) => {
			const loaded = await loadPublishedBundleArtifactByIdentity({
				env,
				userId,
				sourceId,
				kind,
				artifactName,
				entryPoint,
				commit: view.published_commit,
			})
			return Object.values(loaded?.artifact?.modules ?? {}).join('')
		}
		return {
			commit: view.published_commit,
			module: await load('module', '.', 'src/index.ts'),
			importable: await load('importable-module', '.', 'src/index.ts'),
			job: await load('job', 'nightly', 'src/job.ts'),
		}
	}
	await rebuild({
		module: bundleFor('commit-1'),
		importable: bundleFor('commit-1'),
	})
	return { db, env, source, rebuild, publish, served }
}

const servingCommit1 = {
	commit: 'commit-1',
	module: expect.stringContaining('bundle-commit-1'),
	importable: expect.stringContaining('bundle-commit-1'),
	job: expect.stringContaining('bundle-commit-1'),
}

test('a complete rebuild sets the serving pointer', async () => {
	const { source, served } = await setUp()

	expect((await source()).serving_commit).toBe('commit-1')
	expect(await served()).toEqual(servingCommit1)
})

test('while a publish builds, every reader keeps the previous build', async () => {
	const { source, publish, served } = await setUp()
	await publish('commit-2')

	expect((await source()).published_commit).toBe('commit-2')
	expect(await served()).toEqual(servingCommit1)
})

test('a failed rebuild keeps the previous build serving even for targets it saved', async () => {
	const { source, rebuild, publish, served } = await setUp()
	await publish('commit-2')

	await expect(
		rebuild({
			module: async () => {
				throw new Error('esbuild failed')
			},
			importable: bundleFor('commit-2'),
		}),
	).rejects.toThrow('esbuild failed')

	expect((await source()).serving_commit).toBe('commit-1')
	expect(await served()).toEqual(servingCommit1)
})

test('the serving pointer switches once every target for the new commit is saved', async () => {
	const { source, rebuild, publish, served } = await setUp()
	await publish('commit-2')
	await rebuild({
		module: bundleFor('commit-2'),
		importable: bundleFor('commit-2'),
	})

	expect((await source()).serving_commit).toBe('commit-2')
	expect(await served()).toEqual({
		commit: 'commit-2',
		module: expect.stringContaining('bundle-commit-2'),
		importable: expect.stringContaining('bundle-commit-2'),
		job: expect.stringContaining('bundle-commit-2'),
	})
})

test('the serving pointer only compare-and-sets to the current published commit', async () => {
	const { db, source, publish } = await setUp()
	await publish('commit-2')
	await publish('commit-3')

	await expect(
		advanceEntitySourceServingCommit(db, {
			id: sourceId,
			userId,
			commit: 'commit-2',
		}),
	).resolves.toBe(false)
	expect((await source()).serving_commit).toBe('commit-1')
	await expect(
		advanceEntitySourceServingCommit(db, {
			id: sourceId,
			userId,
			commit: 'commit-3',
		}),
	).resolves.toBe(true)
	expect((await source()).serving_commit).toBe('commit-3')
})

test('a source without a serving pointer keeps importing its newest saved build', async () => {
	const { env, source, publish } = await setUp()
	await publish('commit-2')
	// Migration 0245 leaves the pointer null when saved artifacts lag
	// `published_commit`, so no complete build exists at commit-2.
	const row = { ...(await source()), serving_commit: null }
	const importable = async (commit: string | null) => {
		const loaded = await loadPublishedBundleArtifactByIdentity({
			env,
			userId,
			sourceId,
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			commit,
		})
		return loaded?.artifact
			? Object.values(loaded.artifact.modules).join('')
			: null
	}

	expect(await importable(toServingSourceView(row).published_commit)).toBeNull()
	expect(servingArtifactCommitForSource(row)).toBeNull()
	expect(await importable(servingArtifactCommitForSource(row))).toContain(
		'bundle-commit-1',
	)
})

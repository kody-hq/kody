import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { lockSecretToPackage, saveSecret } from '#mcp/secrets/service.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import { mergePublishedArtifactDependencies } from '#worker/package-runtime/module-graph-import-rewriting.ts'
import { resolveKodyDependenciesForEntryPoint } from '#worker/package-runtime/module-graph-workspace.ts'
import { buildKodyImportableModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { persistPublishedBundleArtifact } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { communityForksTableSql } from '#worker/community/community-forks-test-schema.ts'
import { entitySourcesTableSql } from '#worker/repo/entity-sources-test-schema.ts'
import { ensureSecretBucketsTestSchema } from '#worker/secrets-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { buildPublishTargets } from './builder-entry.ts'
import {
	collectLinkedPackageImports,
	linkUploadedPackageImports,
} from './link-dependencies.ts'
import {
	hashWorkerLoaderModules,
	sha256Hex,
	workerLoaderModuleBytes,
} from './module-hashes.ts'
import type { PublishBuildTargetEntry } from './types.ts'
import {
	PublishBuildVerificationError,
	verifyUploadedTargetModules,
} from './verify.ts'

/**
 * 6C end to end: an importer built outside Kody cloud (the builder the CLI
 * and execution contexts run, with no registry access) imports a package its
 * publisher did not write. Kody links the dependency's published artifact at
 * commit time, and at runtime the dependency's storage and secrets stay bound
 * to the dependency, not the importer.
 */

const baseUrl = 'https://kody.dev'
const encoder = new TextEncoder()

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await runSql(entitySourcesTableSql)
	await runSql(`CREATE TABLE IF NOT EXISTS saved_packages (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		description TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		search_text TEXT,
		source_id TEXT NOT NULL,
		has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
		has_skills INTEGER NOT NULL DEFAULT 0 CHECK (has_skills IN (0, 1)),
		hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
		is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
		is_internet_visible INTEGER NOT NULL DEFAULT 0,
		locked_at TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
	)`)
	for (const column of [
		'is_private INTEGER NOT NULL DEFAULT 1',
		'is_internet_visible INTEGER NOT NULL DEFAULT 0',
		'locked_at TEXT',
	]) {
		try {
			await runSql(`ALTER TABLE saved_packages ADD COLUMN ${column}`)
		} catch {
			// Column already present on newer schemas.
		}
	}
	await runSql(`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		published_commit TEXT NOT NULL,
		artifact_kind TEXT NOT NULL,
		artifact_name TEXT,
		entry_point TEXT NOT NULL,
		kv_key TEXT NOT NULL,
		dependencies_json TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await ensureSecretBucketsTestSchema(env.APP_DB)
	await runSql(communityForksTableSql)
	await ensureSoftDeleteTestColumns(env.APP_DB)
}

async function insertPackage(input: {
	userId: string
	name: string
	kodyId: string
}) {
	const unique = crypto.randomUUID()
	const packageId = `pkg-${unique}`
	const sourceId = `source-${unique}`
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		packageId,
		input.userId,
		input.name,
		input.kodyId,
		`${input.name} package`,
		sourceId,
		now,
		now,
	)
	const source = {
		id: sourceId,
		user_id: ownerIdFromStored(input.userId),
		entity_kind: 'package' as const,
		entity_id: packageId,
		repo_id: `repo-${sourceId}`,
		published_commit: `commit-${unique}`,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
	await runSql(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		sourceId,
		input.userId,
		packageId,
		source.repo_id,
		source.published_commit,
		now,
		now,
	)
	return { packageId, sourceId, kodyId: input.kodyId, source }
}

const notesMounts = { notesToken: { name: 'notesToken', scope: 'user' } }
const notesTokenRef = '{{secret:notesToken|scope=user}}'

/** The dependency: published on Kody cloud by its own author. */
async function publishNotesDependency(userId: string) {
	const sourceFiles = {
		'package.json': JSON.stringify({
			name: '@kentcdodds/notes',
			exports: { './note-list': './src/note-list.ts' },
			kody: { id: 'notes', description: 'Notes', secretMounts: notesMounts },
		}),
		'src/note-list.ts': `import { packageSecrets, packageStorage } from 'kody:runtime'
export default async function noteList() {
	const bucket = packageStorage()
	const result = await bucket.sql('select name from notes order by name asc')
	return {
		bucketId: bucket.id,
		names: result.rows.map((row) => row.name),
		token: await packageSecrets.get('notesToken'),
	}
}`,
	}
	const notes = await insertPackage({
		userId,
		name: '@kentcdodds/notes',
		kodyId: 'notes',
	})
	await persistPublishedSourceSnapshot({
		env,
		userId,
		source: notes.source,
		snapshot: { files: sourceFiles },
	})
	const bundle = await buildKodyImportableModuleBundle({
		env,
		baseUrl,
		userId,
		sourceFiles,
		entryPoint: 'src/note-list.ts',
		rootPackageId: notes.packageId,
	})
	await persistPublishedBundleArtifact({
		env,
		userId,
		source: notes.source,
		kind: 'importable-module',
		artifactName: './note-list',
		entryPoint: 'src/note-list.ts',
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		packageContext: {
			packageId: notes.packageId,
			kodyId: 'notes',
			sourceId: notes.sourceId,
		},
	})
	const runner = storageRunnerRpc({
		env,
		userId: ownerIdFromStored(userId),
		storageId: buildPackageStorageId(notes.packageId),
	})
	for (const query of [
		'create table if not exists notes (name text primary key)',
		"insert into notes (name) values ('debugging'), ('writing')",
	]) {
		await runner.sqlQuery({ query, writable: true })
	}
	await saveSecret({
		env,
		userId: ownerIdFromStored(userId),
		scope: 'user',
		name: 'notesToken',
		value: 'notes-secret-value',
		audit: null,
	})
	await lockSecretToPackage({
		env,
		userId: ownerIdFromStored(userId),
		name: 'notesToken',
		packageId: notes.packageId,
		audit: null,
	})
	return notes
}

/** The importer: also mounts `notesToken`, to try reading it directly. */
const importerFiles = {
	'package.json': JSON.stringify({
		name: '@kentcdodds/reader',
		exports: { './run': './src/run.ts' },
		kody: {
			id: 'reader',
			description: 'Reader',
			dependencies: { '@kentcdodds/notes': '*' },
			secretMounts: notesMounts,
		},
	}),
	'src/run.ts': `import { packageSecrets, packageStorage } from 'kody:runtime'
import noteList from 'kody:@kentcdodds/notes/note-list'
export default async function run() {
	let ownToken
	try {
		ownToken = await packageSecrets.get('notesToken')
	} catch (error) {
		ownToken = { error: error instanceof Error ? error.message : String(error) }
	}
	return { ownBucketId: packageStorage().id, ownToken, notes: await noteList() }
}`,
}

/** What the CLI (git tree) or the context daemon (clone) hands the builder. */
function builderFiles(files: Record<string, string>) {
	return Object.entries(files).map(([path, content]) => ({
		path,
		base64: btoa(String.fromCharCode(...encoder.encode(content))),
	}))
}

async function uploadedEntry(input: {
	target: PublishBuildTargetEntry extends infer T
		? Pick<T & object, 'kind' | 'bundleKind' | 'artifactName' | 'entryPoint'>
		: never
	mainModule: string
	modules: WorkerLoaderModules
}): Promise<PublishBuildTargetEntry> {
	const modules: PublishBuildTargetEntry['modules'] = {}
	for (const [path, module] of Object.entries(input.modules)) {
		const bytes = workerLoaderModuleBytes(module)
		modules[path] = {
			sha256: await sha256Hex(bytes),
			size: bytes.byteLength,
			chunks: [],
		}
	}
	return {
		kind: input.target.kind,
		bundleKind: input.target.bundleKind,
		artifactName: input.target.artifactName ?? null,
		entryPoint: input.target.entryPoint,
		mainModule: input.mainModule,
		modules,
	}
}

/** The verify + link half of `persistUploadedPublishBuild` for one target. */
async function commitUploadedTarget(input: {
	userId: string
	ownPackageId: string
	uploaded: PublishBuildTargetEntry
	modules: WorkerLoaderModules
}) {
	const linkedImports = collectLinkedPackageImports({
		sourceFiles: importerFiles,
		entryPoint: input.uploaded.entryPoint,
	})
	const { referencedLinkedImports } = await verifyUploadedTargetModules({
		uploaded: input.uploaded,
		modules: input.modules,
		ownPackageId: input.ownPackageId,
		linkedImports,
	})
	const linked = await linkUploadedPackageImports({
		env,
		baseUrl,
		userId: input.userId,
		modules: input.modules,
		linkedImports,
		referenced: referencedLinkedImports,
	})
	const dependencies = await resolveKodyDependenciesForEntryPoint({
		env,
		baseUrl,
		userId: input.userId,
		sourceFiles: importerFiles,
		entryPoint: input.uploaded.entryPoint,
	})
	return {
		mainModule: input.uploaded.mainModule,
		modules: linked.modules,
		dependencies: mergePublishedArtifactDependencies({
			dependencies,
			publishedArtifactDependencies: linked.publishedArtifactDependencies,
		}),
	}
}

async function setup() {
	silenceIncidentalRuntimeWarnings()
	await ensureSchema()
	const userId = `user-${crypto.randomUUID()}`
	await ensurePersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username: `lk-${userId.slice(-12)}`,
	})
	const notes = await publishNotesDependency(userId)
	const reader = await insertPackage({
		userId,
		name: '@kentcdodds/reader',
		kodyId: 'reader',
	})
	await persistPublishedSourceSnapshot({
		env,
		userId,
		source: reader.source,
		snapshot: { files: importerFiles },
	})
	return { userId, notes, reader }
}

async function buildOffWorker(userId: string, readerPackageId: string) {
	const built = await buildPublishTargets({
		files: builderFiles(importerFiles),
		rootPackageId: readerPackageId,
		userId,
		baseUrl,
	})
	const target = built.targets.find(
		(entry) => entry.target.bundleKind === 'importable-module',
	)
	if (!target) {
		throw new Error(
			`no importable target in ${JSON.stringify(built.targets.map((entry) => entry.target))}`,
		)
	}
	return target
}

for (const origin of ['local', 'context'] as const) {
	test(
		`a ${origin} build links another author's package; its storage and secrets stay bound to it`,
		{ timeout: 120_000 },
		async () => {
			const { userId, notes, reader } = await setup()
			const built = await buildOffWorker(userId, reader.packageId)
			const uploadedSources = Object.values(built.modules)
				.map((module) => JSON.stringify(module))
				.join('\n')
			// The untrusted build holds no dependency code and no dependency id.
			expect(uploadedSources).toContain('__kody_linked__')
			expect(uploadedSources).not.toContain(notes.packageId)
			expect(uploadedSources).not.toContain('select name from notes')
			// Kody's own rebuild in linked mode hashes the same (rebuild sample).
			const rebuilt = await buildKodyImportableModuleBundle({
				env,
				baseUrl,
				userId,
				sourceFiles: importerFiles,
				entryPoint: built.target.entryPoint,
				rootPackageId: reader.packageId,
				linkKodyPackageImports: true,
			})
			expect(await hashWorkerLoaderModules(rebuilt.modules)).toEqual(
				built.moduleHashes,
			)

			const committed = await commitUploadedTarget({
				userId,
				ownPackageId: reader.packageId,
				uploaded: await uploadedEntry(built),
				modules: built.modules,
			})
			expect(committed.dependencies).toMatchObject([
				{ packageId: notes.packageId },
			])
			const run = await runBundledModuleWithRegistry(
				env,
				createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl,
					user: {
						userId: personIdFromStored(userId),
						email: 'worker@example.com',
						displayName: 'Worker Test',
					},
				}),
				committed,
				undefined,
				{
					skipCapabilityRegistry: true,
					packageContext: {
						packageId: reader.packageId,
						kodyId: reader.kodyId,
						sourceId: reader.sourceId,
					},
				},
			)
			expect(run.error).toBeUndefined()
			expect(run.result).toEqual({
				ownBucketId: buildPackageStorageId(reader.packageId),
				ownToken: {
					error: expect.stringMatching(/not allowed for package/i),
				},
				notes: {
					bucketId: buildPackageStorageId(notes.packageId),
					names: ['debugging', 'writing'],
					token: notesTokenRef,
				},
			})
			expect(JSON.stringify(run.result)).not.toContain('notes-secret-value')
		},
	)
}

test(
	'an upload that inlines the dependency or binds its id is refused',
	{ timeout: 120_000 },
	async () => {
		const { userId, notes, reader } = await setup()
		const built = await buildOffWorker(userId, reader.packageId)

		// A build with registry access inlines the dependency (the cloud shape).
		const inlined = await buildKodyImportableModuleBundle({
			env,
			baseUrl,
			userId,
			sourceFiles: importerFiles,
			entryPoint: built.target.entryPoint,
			rootPackageId: reader.packageId,
		})
		const inlinedRefusal = commitUploadedTarget({
			userId,
			ownPackageId: reader.packageId,
			uploaded: await uploadedEntry({ ...built, ...inlined }),
			modules: inlined.modules,
		})
		await expect(inlinedRefusal).rejects.toBeInstanceOf(
			PublishBuildVerificationError,
		)

		// The linked upload, edited to claim the dependency's bindings.
		const forged: WorkerLoaderModules = Object.fromEntries(
			Object.entries(built.modules).map(([path, module]) => [
				path,
				typeof module === 'string'
					? module.replaceAll(
							JSON.stringify(reader.packageId),
							JSON.stringify(notes.packageId),
						)
					: module,
			]),
		)
		expect(forged).not.toEqual(built.modules)
		await expect(
			commitUploadedTarget({
				userId,
				ownPackageId: reader.packageId,
				uploaded: await uploadedEntry({ ...built, modules: forged }),
				modules: forged,
			}),
		).rejects.toThrow(/not this package/)
	},
)

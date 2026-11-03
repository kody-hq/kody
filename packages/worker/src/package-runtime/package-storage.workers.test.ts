import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import {
	createPackageStorageAccessDeniedMessage,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'

/**
 * End-to-end behavior matrix for `packageStorage()` against REAL
 * `buildKodyModuleBundle` / `buildKodyImportableModuleBundle` output —
 * synthetic module maps previously masked bundler inlining (see #814), so
 * every scenario here runs the module graph the way production does:
 * publish an importable artifact, statically import it, and execute the
 * merged bundle through `runBundledModuleWithRegistry`.
 */

const baseUrl = 'https://kody.dev'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSavedPackageArtifactSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await runSql(`CREATE TABLE IF NOT EXISTS entity_sources (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		entity_kind TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		repo_id TEXT NOT NULL,
		published_commit TEXT,
		serving_commit TEXT,
		indexed_commit TEXT,
		manifest_path TEXT NOT NULL DEFAULT 'package.json',
		source_root TEXT NOT NULL DEFAULT '/',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
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
	await ensureSoftDeleteTestColumns(env.APP_DB)
}

function makePackageFiles(
	kodyId: string,
	description: string,
	exportName: string,
	entrySource: string,
	kodyExtra: Record<string, unknown> = {},
) {
	const entryPoint = `src/${exportName.slice(2)}.ts`
	return {
		entryPoint,
		sourceFiles: {
			'package.json': JSON.stringify({
				name: `@kentcdodds/${kodyId}`,
				exports: { [exportName]: `./${entryPoint}` },
				kody: { id: kodyId, description, ...kodyExtra },
			}),
			[entryPoint]: entrySource,
		},
	}
}

/**
 * Publishes one saved package end-to-end the way the registry does: source
 * snapshot plus one importable-module artifact, bundled with `rootPackageId`
 * so its modules carry the package-runtime stamp.
 */
async function publishPackage(
	userId: string,
	kodyId: string,
	description: string,
	exportName: string,
	entrySource: string,
	kodyExtra: Record<string, unknown> = {},
	extraFiles: Record<string, string> = {},
) {
	const unique = crypto.randomUUID()
	const packageId = `pkg-${unique}`
	const sourceId = `source-${unique}`
	const name = `@kentcdodds/${kodyId}`
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		packageId,
		userId,
		name,
		kodyId,
		`${name} package`,
		sourceId,
		now,
		now,
	)
	const source = {
		id: sourceId,
		user_id: ownerIdFromStored(userId),
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
		userId,
		packageId,
		source.repo_id,
		source.published_commit,
		now,
		now,
	)
	const packageFiles = makePackageFiles(
		kodyId,
		description,
		exportName,
		entrySource,
		kodyExtra,
	)
	const { entryPoint } = packageFiles
	const sourceFiles = { ...packageFiles.sourceFiles, ...extraFiles }
	await persistPublishedSourceSnapshot({
		env,
		userId,
		source,
		snapshot: { files: sourceFiles },
	})
	const artifactBundle = await buildKodyImportableModuleBundle({
		env,
		baseUrl,
		userId,
		sourceFiles,
		entryPoint,
		rootPackageId: packageId,
	})
	await persistPublishedBundleArtifact({
		env,
		userId,
		source,
		kind: 'importable-module',
		artifactName: exportName,
		entryPoint,
		mainModule: artifactBundle.mainModule,
		modules: artifactBundle.modules,
		dependencies: artifactBundle.dependencies,
		packageContext: { packageId, kodyId, sourceId },
	})
	return { packageId, sourceId }
}

function packageBucketRunner(userId: string, packageId: string) {
	return storageRunnerRpc({
		env,
		userId: ownerIdFromStored(userId),
		storageId: buildPackageStorageId(packageId),
	})
}

function buildEntry(
	userId: string,
	entrySource: string,
	rootPackageId?: string,
) {
	return buildKodyModuleBundle({
		env,
		baseUrl,
		userId,
		sourceFiles: { 'entry.ts': entrySource },
		entryPoint: 'entry.ts',
		...(rootPackageId ? { rootPackageId } : {}),
	})
}

function runBundle(
	userId: string,
	bundle: Awaited<ReturnType<typeof buildKodyModuleBundle>>,
	packageContext?: { packageId: string; kodyId: string; sourceId: string },
) {
	return runBundledModuleWithRegistry(
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
		bundle,
		undefined,
		{
			skipCapabilityRegistry: true,
			...(packageContext ? { packageContext } : {}),
		},
	)
}

async function withUsageEventsBinding<T>(run: () => Promise<T>) {
	const previousUsageEvents = env.USAGE_EVENTS
	const defineUsageEvents = (value: unknown) =>
		Object.defineProperty(env, 'USAGE_EVENTS', {
			configurable: true,
			enumerable: true,
			writable: true,
			value,
		})
	defineUsageEvents({ writeDataPoint() {} })
	if (!env.USAGE_EVENTS) {
		throw new Error(
			'Failed to bind a stub USAGE_EVENTS dataset on the workers env.',
		)
	}
	try {
		return await run()
	} finally {
		if (previousUsageEvents === undefined) {
			Reflect.deleteProperty(env, 'USAGE_EVENTS')
		} else {
			defineUsageEvents(previousUsageEvents)
		}
	}
}

async function setupUser() {
	silenceIncidentalRuntimeWarnings()
	await ensureSavedPackageArtifactSchema()
	return `user-${crypto.randomUUID()}`
}

test(
	'statically imported package code reads its own bucket from an ad hoc execute call',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const { packageId } = await publishPackage(
			userId,
			'notes',
			'Note storage',
			'./note-list',
			`import { packageStorage } from 'kody:runtime'
export default async function noteList() {
	const bucket = packageStorage()
	const result = await bucket.sql('select name from notes order by name asc')
	return {
		bucketId: bucket.id,
		names: result.rows.map((row) => row.name),
	}
}`,
		)
		// Seed the package's own bucket for `packageStorage()`.
		const runner = packageBucketRunner(userId, packageId)
		for (const query of [
			'create table if not exists notes (name text primary key)',
			"insert into notes (name) values ('debugging'), ('writing')",
		]) {
			await runner.sqlQuery({ query, writable: true })
		}

		const bundle = await buildEntry(
			userId,
			`import noteList from 'kody:@kentcdodds/notes/note-list'
export default async function main() {
	return await noteList()
}`,
		)
		// The bundle records the dependency's immutable package id — that is
		// the provenance the host grants `packageStorage()` access from.
		expect(bundle.dependencies).toMatchObject([{ packageId }])

		const result = await runBundle(userId, bundle)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			bucketId: buildPackageStorageId(packageId),
			names: ['debugging', 'writing'],
		})
	},
)

test(
	'two statically imported packages each write and read their own bucket',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const owners = {} as Record<'alpha' | 'beta', string>
		for (const leaf of ['alpha', 'beta'] as const) {
			const { packageId } = await publishPackage(
				userId,
				leaf,
				`${leaf} storage owner`,
				'./whoami',
				`import { packageStorage } from 'kody:runtime'
export default async function whoami() {
	const bucket = packageStorage()
	await bucket.set('written-by', ${JSON.stringify(leaf)})
	return { bucketId: bucket.id, owner: await bucket.get('owner') }
}`,
			)
			owners[leaf] = packageId
			await packageBucketRunner(userId, packageId).setValue({
				key: 'owner',
				value: `${leaf}-bucket`,
			})
		}

		const bundle = await buildEntry(
			userId,
			`import alphaWhoami from 'kody:@kentcdodds/alpha/whoami'
import betaWhoami from 'kody:@kentcdodds/beta/whoami'
export default async function main() {
	return { alpha: await alphaWhoami(), beta: await betaWhoami() }
}`,
		)
		const result = await runBundle(userId, bundle)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			alpha: {
				bucketId: buildPackageStorageId(owners.alpha),
				owner: 'alpha-bucket',
			},
			beta: {
				bucketId: buildPackageStorageId(owners.beta),
				owner: 'beta-bucket',
			},
		})
		// The sandbox writes landed in each declaring package's own bucket.
		for (const [leaf, packageId] of Object.entries(owners)) {
			await expect(
				packageBucketRunner(userId, packageId).getValue({ key: 'written-by' }),
			).resolves.toEqual({ key: 'written-by', value: leaf })
		}
	},
)

test(
	'a package statically imported into another package keeps its own bucket in the host package runtime',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const inner = await publishPackage(
			userId,
			'inner',
			'Inner storage owner',
			'./whoami',
			`import { packageStorage } from 'kody:runtime'
export default async function whoami() {
	return { bucketId: packageStorage().id, owner: await packageStorage().get('owner') }
}`,
		)
		await packageBucketRunner(userId, inner.packageId).setValue({
			key: 'owner',
			value: 'inner-bucket',
		})

		const outerUnique = crypto.randomUUID()
		const outerPackageId = `pkg-${outerUnique}`
		const { entryPoint, sourceFiles } = makePackageFiles(
			'outer',
			'Outer package importing inner',
			'./run',
			`import { packageStorage } from 'kody:runtime'
import innerWhoami from 'kody:@kentcdodds/inner/whoami'
export default async function run() {
	return {
		inner: await innerWhoami(),
		outerBucketId: packageStorage().id,
	}
}`,
			{ dependencies: ['@kentcdodds/inner'] },
		)
		// Build the outer package's own module bundle the way package
		// invocations do (rootPackageId stamps the outer sources).
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl,
			userId,
			sourceFiles,
			entryPoint,
			rootPackageId: outerPackageId,
		})
		// Package invocation runs reach the package bucket only through
		// packageStorage().
		const result = await runBundle(userId, bundle, {
			packageId: outerPackageId,
			kodyId: 'outer',
			sourceId: `source-${outerUnique}`,
		})
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			inner: {
				bucketId: buildPackageStorageId(inner.packageId),
				owner: 'inner-bucket',
			},
			outerBucketId: buildPackageStorageId(outerPackageId),
		})
	},
)

test(
	'a package reached only through another package static import keeps its own bucket from ad hoc execute',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const inner = await publishPackage(
			userId,
			'wake',
			'Inner storage owner',
			'./whoami',
			`import { packageStorage } from 'kody:runtime'
export default async function whoami() {
	return { bucketId: packageStorage().id, owner: await packageStorage().get('owner') }
}`,
		)
		await packageBucketRunner(userId, inner.packageId).setValue({
			key: 'owner',
			value: 'wake-bucket',
		})
		const outer = await publishPackage(
			userId,
			'relay',
			'Outer package importing wake',
			'./run',
			`import whoami from 'kody:@kentcdodds/wake/whoami'
export default async function run() {
	return { inner: await whoami() }
}`,
			{ dependencies: { '@kentcdodds/wake': '*' } },
		)

		const bundle = await buildEntry(
			userId,
			`import run from 'kody:@kentcdodds/relay/run'
export default async function main() {
	return await run()
}`,
		)
		expect(bundle.dependencies).toMatchObject([
			{ packageId: outer.packageId },
			{ packageId: inner.packageId, transitive: true },
		])
		expect(bundle.dependencies[0]).not.toHaveProperty('transitive')

		const result = await runBundle(userId, bundle)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			inner: {
				bucketId: buildPackageStorageId(inner.packageId),
				owner: 'wake-bucket',
			},
		})
	},
)

test(
	'a dependency file unreachable from the imported export does not grant its imports a bucket',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const victim = await publishPackage(
			userId,
			'vault',
			'Holds private data',
			'./noop',
			'export default async function noop() { return null }',
		)
		await packageBucketRunner(userId, victim.packageId).setValue({
			key: 'secret',
			value: 'do-not-leak',
		})
		const outer = await publishPackage(
			userId,
			'courier',
			'Outer package with an unrelated file importing vault',
			'./run',
			'export default async function run() { return null }',
			{ dependencies: { '@kentcdodds/vault': '*' } },
			{
				'src/unrelated.ts': `import noop from 'kody:@kentcdodds/vault/noop'
export default noop`,
			},
		)

		const bundle = await buildEntry(
			userId,
			`import { kody } from 'kody:runtime'
import run from 'kody:@kentcdodds/courier/run'
export default async function main() {
	await run()
	return await kody.packageStorageGet({ packageId: ${JSON.stringify(victim.packageId)}, key: 'secret' })
}`,
		)
		expect(bundle.dependencies).toMatchObject([{ packageId: outer.packageId }])
		expect(bundle.dependencies).toHaveLength(1)

		const result = await runBundle(userId, bundle)
		expect(result.error).toContain(
			createPackageStorageAccessDeniedMessage(victim.packageId),
		)
		expect(result.error).not.toContain('do-not-leak')
	},
)

test(
	'packageStorage get/set stay callable when StorageRunner metering is enabled',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const packageId = `pkg-${crypto.randomUUID()}`
		// Local workers env omits USAGE_EVENTS, so storageRunnerRpc returns
		// the raw RpcStub. Bind a stub dataset on the real env — do not
		// wrap env in a Proxy, because createExecuteExecutor passes env
		// into the Dynamic Worker. Production wraps the StorageRunner stub
		// when Analytics Engine is bound; that wrapper must stay a
		// plain-object Proxy or every packageStorage() call — including get
		// of a missing key on export and subscription — throws the RPC
		// receiver serialization error.
		await withUsageEventsBinding(async () => {
			const bundle = await buildEntry(
				userId,
				`import { packageStorage } from 'kody:runtime'
export default async function main() {
	const bucket = packageStorage()
	const missing = await bucket.get('missing-key')
	await bucket.set('note', 'plain')
	const note = await bucket.get('note')
	const listed = await bucket.list()
	return {
		missing,
		note,
		keys: listed.entries.map((entry) => entry.key),
	}
}`,
				packageId,
			)
			const result = await runBundle(userId, bundle, {
				packageId,
				kodyId: 'metered-storage',
				sourceId: `source-${packageId}`,
			})
			expect(result.error).toBeUndefined()
			expect(result.result).toEqual({
				missing: null,
				note: 'plain',
				keys: ['note'],
			})
		})
	},
)

test(
	'importing ambient storage from kody:runtime fails because the export is gone',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const { entryPoint, sourceFiles } = makePackageFiles(
			'legacy',
			'Legacy ambient storage',
			'./main',
			`import { storage } from 'kody:runtime'
export default async function main() {
	return await storage.get('key')
}`,
		)
		await expect(
			buildKodyModuleBundle({
				env,
				baseUrl,
				userId,
				sourceFiles,
				entryPoint,
				rootPackageId: `pkg-${crypto.randomUUID()}`,
			}),
		).rejects.toThrow(/storage/)
	},
)

test(
	'inline execute code without package provenance gets an actionable packageStorage error',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = `user-${crypto.randomUUID()}`
		const bundle = await buildEntry(
			userId,
			`import { packageStorage } from 'kody:runtime'
export default async function main() {
	return await packageStorage().get('anything')
}`,
		)
		const result = await runBundle(userId, bundle)
		expect(result.error).toContain(
			'packageStorage() requires package provenance',
		)
		expect(result.error).toContain('import(specifier)')
	},
)

test(
	'hand-written package ids are rejected: only bundler-recorded provenance grants bucket access',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		// The victim package exists and has data, but the execute code below
		// never statically imports it — so its id is not in the grant set.
		const victim = await publishPackage(
			userId,
			'victim',
			'Holds private data',
			'./noop',
			'export default async function noop() { return null }',
		)
		await packageBucketRunner(userId, victim.packageId).setValue({
			key: 'secret',
			value: 'do-not-leak',
		})

		// A forged host-tool call with a hand-written package id — exactly
		// what a malicious module would try.
		const bundle = await buildEntry(
			userId,
			`import { kody } from 'kody:runtime'
export default async function main() {
	return await kody.packageStorageGet({ packageId: ${JSON.stringify(victim.packageId)}, key: 'secret' })
}`,
		)
		const result = await runBundle(userId, bundle)
		expect(result.error).toContain(
			createPackageStorageAccessDeniedMessage(victim.packageId),
		)
		expect(result.error).not.toContain('do-not-leak')
	},
)

/*
 * GHSA-5fv3 follow-up: package storage identity. A bucket belongs to the
 * package whose code is running, not to whichever granted id a caller
 * names. Importer code, sibling packages, and the run package must not
 * read or write another statically imported package's bucket by passing
 * its id to `kody.packageStorage*` or the runtime store's
 * `__kodyPackageStorage` factory. The owner keeps full access.
 */
const storageProbeSource = (targetExpr: string) => `
	const target = ${targetExpr}
	const out = {}
	const msg = (e) => String(e?.message ?? e).slice(0, 160)
	try { out.kodyGet = (await kody.packageStorageGet({ packageId: target, key: 'secret' }))?.value ?? null } catch (e) { out.kodyGet = msg(e) }
	try { await kody.packageStorageSet({ packageId: target, key: 'secret', value: 'overwritten-by-intruder' }); out.kodySet = 'ok' } catch (e) { out.kodySet = msg(e) }
	try { out.kodyList = JSON.stringify(await kody.packageStorageList({ packageId: target })) } catch (e) { out.kodyList = msg(e) }
	try { out.kodySql = JSON.stringify(await kody.packageStorageSql({ packageId: target, query: 'select 1 as one', writable: true })) } catch (e) { out.kodySql = msg(e) }
	try {
		const store = globalThis[Symbol.for('kody.runtimeStorage')]?.getStore?.()
		const factory = store?.__kodyPackageStorage
		if (typeof factory === 'function') {
			const bucket = factory(target)
			try { out.storeGet = await bucket.get('secret') } catch (e) { out.storeGet = msg(e) }
			try { await bucket.set('secret', 'overwritten-via-store'); out.storeSet = 'ok' } catch (e) { out.storeSet = msg(e) }
			try { await bucket.clear(); out.storeClear = 'ok' } catch (e) { out.storeClear = msg(e) }
		} else {
			out.storeGet = 'no-factory'
		}
	} catch (e) { out.storeGet = msg(e) }
	return out`

function expectProbeDenied(probe: Record<string, unknown>) {
	expect(JSON.stringify(probe)).not.toContain('do-not-leak')
	expect(probe['kodySet']).not.toBe('ok')
	expect(probe['storeSet']).not.toBe('ok')
	expect(probe['storeClear']).not.toBe('ok')
	expect(String(probe['kodyList'] ?? '')).not.toContain('"secret"')
	expect(String(probe['kodySql'] ?? '')).not.toContain('"one"')
}

async function publishVault(userId: string) {
	const vault = await publishPackage(
		userId,
		'vault',
		'Holds private data in its own bucket',
		'./peek',
		`import { packageStorage } from 'kody:runtime'
export default async function peek() {
	const bucket = packageStorage()
	const before = await bucket.get('secret')
	await bucket.set('owner-wrote', 'yes')
	return { before, ownerWrote: await bucket.get('owner-wrote') }
}`,
	)
	await packageBucketRunner(userId, vault.packageId).setValue({
		key: 'secret',
		value: 'do-not-leak',
	})
	return vault
}

async function expectVaultIntact(userId: string, vaultId: string) {
	await expect(
		packageBucketRunner(userId, vaultId).getValue({ key: 'secret' }),
	).resolves.toEqual({ key: 'secret', value: 'do-not-leak' })
}

test(
	'GHSA-5fv3 storage: importer code cannot read or write an imported package bucket by naming its id',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const vault = await publishVault(userId)
		const bundle = await buildEntry(
			userId,
			`import { kody } from 'kody:runtime'
import peek from 'kody:@kentcdodds/vault/peek'
export default async function main() {
	const probe = await (async () => {${storageProbeSource(JSON.stringify(vault.packageId))}
	})()
	return { probe, owner: await peek() }
}`,
		)
		expect(bundle.dependencies).toMatchObject([{ packageId: vault.packageId }])
		const result = await runBundle(userId, bundle)
		expect(result.error, JSON.stringify(result.result)).toBeUndefined()
		const { probe, owner } = result.result as {
			probe: Record<string, unknown>
			owner: unknown
		}
		expectProbeDenied(probe)
		// The owner still reads and writes its own bucket.
		expect(owner).toEqual({ before: 'do-not-leak', ownerWrote: 'yes' })
		await expectVaultIntact(userId, vault.packageId)
	},
)

test(
	'GHSA-5fv3 storage: a sibling package cannot read or write another imported package bucket',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const vault = await publishVault(userId)
		await publishPackage(
			userId,
			'snoop',
			'Third-party helper that tries to read the vault',
			'./run',
			`import { kody } from 'kody:runtime'
export default async function run(targetId) {${storageProbeSource('targetId')}
}`,
		)
		const bundle = await buildEntry(
			userId,
			`import peek from 'kody:@kentcdodds/vault/peek'
import snoop from 'kody:@kentcdodds/snoop/run'
export default async function main() {
	const probe = await snoop(${JSON.stringify(vault.packageId)})
	return { probe, owner: await peek() }
}`,
		)
		const result = await runBundle(userId, bundle)
		expect(result.error, JSON.stringify(result.result)).toBeUndefined()
		const { probe, owner } = result.result as {
			probe: Record<string, unknown>
			owner: unknown
		}
		expectProbeDenied(probe)
		expect(owner).toEqual({ before: 'do-not-leak', ownerWrote: 'yes' })
		await expectVaultIntact(userId, vault.packageId)
	},
)

test(
	'GHSA-5fv3 storage: the run package cannot read or write a dependency bucket by naming its id',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const vault = await publishVault(userId)
		const outerUnique = crypto.randomUUID()
		const outerPackageId = `pkg-${outerUnique}`
		const { entryPoint, sourceFiles } = makePackageFiles(
			'outer-runner',
			'Run package that imports the vault',
			'./run',
			`import { kody, packageStorage } from 'kody:runtime'
import peek from 'kody:@kentcdodds/vault/peek'
export default async function run() {
	const probe = await (async () => {${storageProbeSource(JSON.stringify(vault.packageId))}
	})()
	await packageStorage().set('mine', 'outer')
	return { probe, owner: await peek(), own: await packageStorage().get('mine') }
}`,
			{ dependencies: { '@kentcdodds/vault': '*' } },
		)
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl,
			userId,
			sourceFiles,
			entryPoint,
			rootPackageId: outerPackageId,
		})
		const result = await runBundle(userId, bundle, {
			packageId: outerPackageId,
			kodyId: 'outer-runner',
			sourceId: `source-${outerUnique}`,
		})
		expect(result.error, JSON.stringify(result.result)).toBeUndefined()
		const { probe, owner, own } = result.result as {
			probe: Record<string, unknown>
			owner: unknown
			own: unknown
		}
		expectProbeDenied(probe)
		expect(owner).toEqual({ before: 'do-not-leak', ownerWrote: 'yes' })
		expect(own).toBe('outer')
		await expectVaultIntact(userId, vault.packageId)
	},
)

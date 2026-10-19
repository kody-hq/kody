import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'

const baseUrl = 'https://kody.dev'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSavedPackageArtifactSchema() {
	await runSql(`CREATE TABLE IF NOT EXISTS entity_sources (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		entity_kind TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		repo_id TEXT NOT NULL,
		published_commit TEXT,
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

/**
 * Saves a package with a published source snapshot for a fresh user; the
 * caller decides whether to also persist an importable artifact.
 */
async function publishSource(
	kodyId: string,
	description: string,
	indexSource: string,
) {
	silenceIncidentalRuntimeWarnings()
	await ensureSavedPackageArtifactSchema()
	await ensureUsageRollupsTestSchema(env.APP_DB)
	const unique = crypto.randomUUID()
	const userId = `user-${unique}`
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
	const sourceFiles = {
		'package.json': JSON.stringify({
			name,
			exports: { '.': './src/index.ts' },
			kody: { id: kodyId, description },
		}),
		'src/index.ts': indexSource,
	}
	await persistPublishedSourceSnapshot({
		env,
		userId,
		source,
		snapshot: { files: sourceFiles },
	})
	return { userId, packageId, source, sourceFiles }
}

async function runEntry(userId: string, entrySource: string) {
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl,
		userId,
		sourceFiles: { 'entry.ts': entrySource },
		entryPoint: 'entry.ts',
	})
	return await runBundledModuleWithRegistry(
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
		{ skipCapabilityRegistry: true },
	)
}

async function expectStaticCallRollup(
	userId: string,
	expected: {
		event_count: number
		error_count: number
		caught_count: number
	},
) {
	// Metering is fire-and-forget from the sandbox, so poll the rollup.
	await vi.waitFor(
		async () => {
			const rollup = await env.APP_DB.prepare(
				`SELECT event_count, error_count, caught_count, total_duration_ms
				FROM usage_rollups WHERE user_id = ?1 AND metric = 'package_static_call'`,
			)
				.bind(userId)
				.first()
			expect(rollup).toEqual({
				...expected,
				total_duration_ms: expect.any(Number),
			})
		},
		{ timeout: 10_000, interval: 100 },
	)
}

test(
	'statically imported package exports meter one package_static_call per call',
	{ timeout: 30_000 },
	async () => {
		const { userId } = await publishSource(
			'metered-dep',
			'Metered dependency',
			`export default async function compute(input: number) {
	return { doubled: input * 2 }
}
export function throwWhenAsked(shouldThrow: boolean) {
	if (shouldThrow) throw new Error('asked to throw')
	return 'calm'
}
export class Accumulator {
	total: number
	constructor(start: number) {
		this.total = start
	}
	bump() {
		return ++this.total
	}
}
export const answer = 42`,
		)

		const result = await runEntry(
			userId,
			`import compute, { throwWhenAsked, Accumulator, answer } from 'kody:@kentcdodds/metered-dep'
export default async function main() {
	const first = await compute(1)
	const second = await compute(2)
	const third = await compute(3)
	let thrownMessage = null
	try {
		throwWhenAsked(true)
	} catch (error) {
		thrownMessage = String(error instanceof Error ? error.message : error)
	}
	// The wrapper only traps [[Call]]: \`new\` on a wrapped class
	// constructs the real class (and is not metered).
	const accumulator = new Accumulator(10)
	return {
		first,
		second,
		third,
		thrownMessage,
		calm: throwWhenAsked(false),
		constructed: accumulator.bump(),
		answer,
		answerType: typeof answer,
	}
}`,
		)

		expect(result.error).toBeUndefined()
		// The throwing export still throws to the caller; class exports
		// construct through the wrapper; non-function exports pass through
		// unwrapped.
		expect(result.result).toEqual({
			first: { doubled: 2 },
			second: { doubled: 4 },
			third: { doubled: 6 },
			thrownMessage: 'asked to throw',
			calm: 'calm',
			constructed: 11,
			answer: 42,
			answerType: 'number',
		})
		// 3 default calls + 1 caught throw + 1 calm call = 5 events.
		// Caught throws are outcome `caught` (rollup caught_count), not errors.
		await expectStaticCallRollup(userId, {
			event_count: 5,
			error_count: 0,
			caught_count: 1,
		})
	},
)

test(
	'uncaught static package throw still counts as a package_static_call error',
	{ timeout: 30_000 },
	async () => {
		const { userId } = await publishSource(
			'metered-uncaught',
			'Metered dependency that fails the run',
			`export function boom() {
	throw new Error('uncaught boom')
}`,
		)

		const result = await runEntry(
			userId,
			`import { boom } from 'kody:@kentcdodds/metered-uncaught'
export default async function main() {
	boom()
	return 'unreachable'
}`,
		)

		expect(result.error).toBeTruthy()
		await expectStaticCallRollup(userId, {
			event_count: 1,
			error_count: 1,
			caught_count: 0,
		})
	},
)

test(
	'published-artifact static imports meter calls and drop forged stamped ids',
	{ timeout: 30_000 },
	async () => {
		const { userId, packageId, source, sourceFiles } = await publishSource(
			'artifact-dep',
			'Artifact dependency',
			`export default async function run() {
	return 'artifact-ok'
}
export function greet(name: string) {
	return \`hello \${name}\`
}`,
		)
		const artifactBundle = await buildKodyImportableModuleBundle({
			env,
			baseUrl,
			userId,
			sourceFiles,
			entryPoint: 'src/index.ts',
		})
		await persistPublishedBundleArtifact({
			env,
			userId,
			source,
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			mainModule: artifactBundle.mainModule,
			modules: artifactBundle.modules,
			dependencies: artifactBundle.dependencies,
			packageContext: {
				packageId,
				kodyId: 'artifact-dep',
				sourceId: source.id,
			},
		})

		const result = await runEntry(
			userId,
			`import run, { greet } from 'kody:@kentcdodds/artifact-dep'
import * as runtime from 'kody:runtime'
export default async function main() {
	// The stamp helper is bundler-internal, so forge an event for a
	// package this bundle does not statically depend on through the
	// run store meter: the host must drop it silently.
	const meter = globalThis[Symbol.for("kody.runtimeStorage")]
		?.getStore?.()?.__kodyStaticCallMeter
	meter.report({
		packageId: 'pkg-not-a-dependency',
		durationMs: 1,
		outcome: 'success',
	})
	return {
		ran: await run(),
		greeting: greet("kody"),
		meterHelperExported: "__kodyMeterStaticPackageExport" in runtime,
	}
}`,
		)

		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			ran: 'artifact-ok',
			greeting: 'hello kody',
			meterHelperExported: false,
		})
		// The forged event fires before the two granted ones; once the granted
		// events land, a count of exactly 2 proves the forged stamp was
		// dropped by the host-side dependency-provenance check.
		await expectStaticCallRollup(userId, {
			event_count: 2,
			error_count: 0,
			caught_count: 0,
		})
	},
)

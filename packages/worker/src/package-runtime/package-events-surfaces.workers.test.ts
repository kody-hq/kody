import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import type { PackageEventsDispatchQueueMessage } from '#worker/package-events/dispatch-queue-producer.ts'
import { entitySourcesTableSql } from '#worker/repo/entity-sources-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'

/**
 * `events.dispatch` from package code on every hosted execute surface,
 * against real bundler output: package code statically imported into ad hoc
 * execute, and one package's code imported into another package's run.
 * Each emit must carry the declaring package's identity and pass that
 * package's `kody.emits` check, whatever run it executes in.
 */

const baseUrl = 'https://kody.dev'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSchema() {
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
		built_in TEXT,
		built_context_name TEXT,
		bundle_sha256 TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await ensureSoftDeleteTestColumns(env.APP_DB)
}

type PublishedPackage = {
	packageId: string
	kodyId: string
	sourceId: string
}

async function publishPackage(input: {
	userId: string
	kodyId: string
	exportName: string
	entrySource: string
	emits?: Record<string, unknown>
}): Promise<PublishedPackage> {
	const unique = crypto.randomUUID()
	const packageId = `pkg-${unique}`
	const sourceId = `source-${unique}`
	const name = `@kentcdodds/${input.kodyId}`
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		packageId,
		input.userId,
		name,
		input.kodyId,
		`${name} package`,
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
	const entryPoint = `src/${input.exportName.slice(2)}.ts`
	const sourceFiles = {
		'package.json': JSON.stringify({
			name,
			exports: { [input.exportName]: `./${entryPoint}` },
			kody: {
				id: input.kodyId,
				description: `${name} package`,
				...(input.emits ? { emits: input.emits } : {}),
			},
		}),
		[entryPoint]: input.entrySource,
	}
	await persistPublishedSourceSnapshot({
		env,
		userId: input.userId,
		source,
		snapshot: { files: sourceFiles },
	})
	const artifactBundle = await buildKodyImportableModuleBundle({
		env,
		baseUrl,
		userId: input.userId,
		sourceFiles,
		entryPoint,
		rootPackageId: packageId,
	})
	await persistPublishedBundleArtifact({
		env,
		userId: input.userId,
		source,
		kind: 'importable-module',
		artifactName: input.exportName,
		entryPoint,
		mainModule: artifactBundle.mainModule,
		modules: artifactBundle.modules,
		dependencies: artifactBundle.dependencies,
		packageContext: { packageId, kodyId: input.kodyId, sourceId },
	})
	return { packageId, kodyId: input.kodyId, sourceId }
}

const emitterSource = `import { events } from 'kody:runtime'
export default async function emit(input = {}) {
	return await events.dispatch({
		topic: input.topic ?? '@kentcdodds/rooms.message.posted',
		idempotencyKey: 'room-1:message-1',
		payload: { roomId: 'room-1' },
	})
}`

async function publishEmitter(userId: string) {
	return await publishPackage({
		userId,
		kodyId: 'rooms',
		exportName: './emit',
		entrySource: emitterSource,
		emits: {
			'@kentcdodds/rooms.message.posted': {
				description: 'A room message was posted.',
			},
		},
	})
}

async function runEntry(input: {
	userId: string
	entrySource: string
	rootPackage?: PublishedPackage
}) {
	const bundle = await buildKodyModuleBundle({
		env,
		baseUrl,
		userId: input.userId,
		sourceFiles: { 'entry.ts': input.entrySource },
		entryPoint: 'entry.ts',
		...(input.rootPackage
			? { rootPackageId: input.rootPackage.packageId }
			: {}),
	})
	return await runBundledModuleWithRegistry(
		env,
		createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl,
			user: {
				userId: personIdFromStored(input.userId),
				email: 'worker@example.com',
				displayName: 'Worker Test',
			},
		}),
		bundle,
		undefined,
		{
			skipCapabilityRegistry: true,
			...(input.rootPackage ? { packageContext: input.rootPackage } : {}),
		},
	)
}

async function withCapturedQueue<T>(
	run: (sent: Array<PackageEventsDispatchQueueMessage>) => Promise<T>,
) {
	const sent: Array<PackageEventsDispatchQueueMessage> = []
	const previous = env.PACKAGE_EVENTS_DISPATCH_QUEUE
	const define = (value: unknown) =>
		Object.defineProperty(env, 'PACKAGE_EVENTS_DISPATCH_QUEUE', {
			configurable: true,
			enumerable: true,
			writable: true,
			value,
		})
	define({
		async send(message: PackageEventsDispatchQueueMessage) {
			sent.push(message)
		},
	})
	try {
		return await run(sent)
	} finally {
		define(previous)
	}
}

async function setupUser() {
	silenceIncidentalRuntimeWarnings()
	await ensureSchema()
	return `user-${crypto.randomUUID()}`
}

test(
	'package code statically imported into ad hoc execute emits as its own package',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const rooms = await publishEmitter(userId)
		await withCapturedQueue(async (sent) => {
			const result = await runEntry({
				userId,
				entrySource: `import emit from 'kody:@kentcdodds/rooms/emit'
export default async function main() {
	return await emit()
}`,
			})
			expect(result.error).toBeUndefined()
			expect(result.result).toMatchObject({
				topic: '@kentcdodds/rooms.message.posted',
				source: {
					type: 'package',
					packageId: rooms.packageId,
					kodyId: 'rooms',
				},
				status: 'enqueued',
			})
			expect(sent).toMatchObject([
				{
					userId: ownerIdFromStored(userId),
					topic: '@kentcdodds/rooms.message.posted',
					source: { packageId: rooms.packageId, kodyId: 'rooms' },
					invokeDepth: 1,
				},
			])
		})
	},
)

test(
	'imported package code cannot emit a topic its package does not declare',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		await publishEmitter(userId)
		await withCapturedQueue(async (sent) => {
			const result = await runEntry({
				userId,
				entrySource: `import emit from 'kody:@kentcdodds/rooms/emit'
export default async function main() {
	return await emit({ topic: '@kentcdodds/rooms.undeclared' })
}`,
			})
			expect(String(result.error)).toContain(
				'Package "rooms" does not declare emitted event "@kentcdodds/rooms.undeclared" in package.json#kody.emits.',
			)
			expect(sent).toEqual([])
		})
	},
)

test(
	'ad hoc execute code outside any package cannot emit and is told why',
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		await withCapturedQueue(async (sent) => {
			const result = await runEntry({
				userId,
				entrySource: `import { events } from 'kody:runtime'
export default async function main() {
	return await events.dispatch({
		topic: '@kentcdodds/rooms.message.posted',
		idempotencyKey: 'adhoc-1',
		payload: {},
	})
}`,
			})
			expect(String(result.error)).toContain(
				'events.dispatch requires package code',
			)
			expect(sent).toEqual([])
		})
	},
)

test(
	"one package's code imported into another package's run emits as the declaring package",
	{ timeout: 90_000 },
	async () => {
		const userId = await setupUser()
		const rooms = await publishEmitter(userId)
		const caller = await publishPackage({
			userId,
			kodyId: 'room-bot',
			exportName: './noop',
			entrySource: 'export default async function noop() { return null }',
		})
		await withCapturedQueue(async (sent) => {
			const result = await runEntry({
				userId,
				rootPackage: caller,
				entrySource: `import emit from 'kody:@kentcdodds/rooms/emit'
export default async function main() {
	return await emit()
}`,
			})
			expect(result.error).toBeUndefined()
			expect(sent).toMatchObject([
				{
					topic: '@kentcdodds/rooms.message.posted',
					source: { packageId: rooms.packageId, kodyId: 'rooms' },
				},
			])
		})
	},
)

import { beforeEach, expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { sha256Hex } from './module-hashes.ts'
import { publishBuildDocumentKey } from './store.ts'
import type * as Verify from './verify.ts'

vi.mock('./verify.ts', async (importOriginal) => ({
	...(await importOriginal<typeof Verify>()),
	assertSupportedBuilderVersion: () => {},
	verifySourceManifest: async () => {},
	matchUploadedTargets: () => [],
}))
vi.mock('#worker/package-runtime/published-bundle-artifact-persist.ts', () => ({
	persistPublishedPackageArtifactTargets: vi.fn(async () => []),
}))
vi.mock('#worker/package-runtime/module-graph-workspace.ts', () => ({
	resolveKodyDependenciesForEntryPoint: vi.fn(async () => []),
}))
vi.mock('./link-dependencies.ts', () => ({
	collectLinkedPackageImports: vi.fn(async () => new Map()),
	linkUploadedPackageImports: vi.fn(),
}))

const { handlePublishBuildRoute } = await import('./http.ts')
const { persistUploadedPublishBuild } = await import('./persist-uploaded.ts')

const buildId = 'pb_0123456789abcdef01234567'
const commit = 'a'.repeat(40)
const document = { builderVersion: 2, commit, files: [], targets: [] }
const lost = 'D1_ERROR: Network connection lost.'
const r2Internal = 'We encountered an internal error. Please try again. (10001)'

/** Queued failures per label; each matching call shifts one off and throws. */
type Faults = Map<string, Array<string>>

function throwFault(faults: Faults, label: string, attempts: Array<string>) {
	attempts.push(label)
	const message = faults.get(label)?.shift()
	if (message !== undefined) throw new Error(message)
}

/** D1 whose statements fail per `faults`, keyed by the SQL's first word. */
function flakyDb(db: D1Database, faults: Faults, attempts: Array<string>) {
	const wrap = (statement: D1PreparedStatement, label: string) =>
		({
			bind: (...args: Array<unknown>) => wrap(statement.bind(...args), label),
			first: async () => {
				throwFault(faults, label, attempts)
				return await statement.first()
			},
			run: async () => {
				throwFault(faults, label, attempts)
				return await statement.run()
			},
		}) as unknown as D1PreparedStatement
	return {
		prepare: (sql: string) =>
			wrap(db.prepare(sql), `d1.${sql.trim().split(/\s+/)[0]!.toLowerCase()}`),
	} as unknown as D1Database
}

function flakyBucket(faults: Faults, attempts: Array<string>) {
	const objects = new Map<string, string>()
	return {
		objects,
		put: async (key: string, body: string) => {
			throwFault(faults, 'r2.put', attempts)
			objects.set(key, body)
		},
		get: async (key: string) => {
			throwFault(faults, 'r2.get', attempts)
			const body = objects.get(key)
			return body === undefined ? null : { text: async () => body }
		},
		list: async ({ prefix }: { prefix: string }) => {
			throwFault(faults, 'r2.list', attempts)
			return {
				objects: [...objects.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({ key })),
				truncated: false,
			}
		},
	}
}

let sqlite: DatabaseSync
let faults: Faults
let attempts: Array<string>
let sleeps: Array<number>
let bucket: ReturnType<typeof flakyBucket>
let db: D1Database

beforeEach(async () => {
	sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE publish_builds (id TEXT PRIMARY KEY, source_id TEXT, commit_sha TEXT, origin TEXT, context_name TEXT, ticket_sha256 TEXT, status TEXT, document_sha256 TEXT, message TEXT, expires_at TEXT, updated_at TEXT, committed_at TEXT)`,
	)
	sqlite
		.prepare(
			`INSERT INTO publish_builds (id, source_id, commit_sha, origin, ticket_sha256, status, expires_at) VALUES (?, 'src_1', ?, 'cli', ?, 'uploading', ?)`,
		)
		.run(
			buildId,
			commit,
			await sha256Hex('kpb_good'),
			new Date(Date.now() + 60_000).toISOString(),
		)
	faults = new Map()
	attempts = []
	sleeps = []
	bucket = flakyBucket(faults, attempts)
	db = flakyDb(createD1FromSqlite(sqlite), faults, attempts)
})

function buildRow() {
	return sqlite
		.prepare(`SELECT status, document_sha256 FROM publish_builds WHERE id = ?`)
		.get(buildId)
}

function seal() {
	const url = new URL(`https://kody.test/v1/publish-builds/${buildId}/seal`)
	return handlePublishBuildRoute({
		request: new Request(url, {
			method: 'POST',
			body: JSON.stringify(document),
			headers: { Authorization: 'Bearer kpb_good' },
		}),
		env: { APP_DB: db, REPO_SESSION_BLOBS: bucket } as never,
		url,
		retrySleep: async (ms) => {
			sleeps.push(ms)
		},
	})
}

async function markSealed() {
	const body = JSON.stringify(document)
	const sha256 = await sha256Hex(body)
	bucket.objects.set(publishBuildDocumentKey(buildId, sha256), body)
	sqlite
		.prepare(
			`UPDATE publish_builds SET status = 'sealed', document_sha256 = ? WHERE id = ?`,
		)
		.run(sha256, buildId)
}

function commitBuild() {
	return persistUploadedPublishBuild({
		env: { APP_DB: db, REPO_SESSION_BLOBS: bucket } as never,
		buildId,
		baseUrl: 'https://kody.test',
		userId: 'user_1',
		source: { id: 'src_1' } as never,
		savedPackage: { id: 'pkg_1' } as never,
		publishedCommit: commit,
		sourceFiles: {},
		targets: [],
		retrySleep: async (ms) => {
			sleeps.push(ms)
		},
	})
}

test('seal retries a transient D1 error and then seals', async () => {
	faults.set('d1.update', ['D1_ERROR: internal error; reference = abc123'])
	const response = await seal()
	expect(response.status).toBe(200)
	expect(sleeps).toEqual([50])
	expect(attempts.filter((label) => label === 'd1.update')).toHaveLength(2)
	expect(buildRow()).toMatchObject({ status: 'sealed' })
})

test('seal does not retry a permanent R2 error', async () => {
	faults.set('r2.put', ['The specified bucket does not exist. (10006)'])
	await expect(seal()).rejects.toThrow('(10006)')
	expect(sleeps).toEqual([])
	expect(attempts.filter((label) => label === 'r2.put')).toHaveLength(1)
	expect(buildRow()).toEqual({ status: 'uploading', document_sha256: null })
})

test('seal answers 503 storage_busy when the request budget runs out, and the build stays uploading', async () => {
	// The ticket read spends 350 ms recovering; the chunk list then has 50 ms.
	faults.set('d1.select', [lost, lost, lost])
	faults.set('r2.list', [r2Internal, r2Internal])
	const error = await seal().catch((caught: unknown) => caught)
	expect(error).toMatchObject({
		status: 503,
		code: 'storage_busy',
		headers: { 'Retry-After': '5' },
	})
	expect(String((error as Error).message)).toContain('publish_build_blobs.list')
	expect(sleeps).toEqual([50, 100, 200, 50])
	expect(attempts).not.toContain('r2.put')
	expect(attempts).not.toContain('d1.update')
	expect(buildRow()).toEqual({ status: 'uploading', document_sha256: null })
	// The next seal request gets a fresh budget.
	faults.set('r2.list', [r2Internal, r2Internal])
	sleeps.length = 0
	expect((await seal()).status).toBe(200)
	expect(sleeps).toEqual([50, 100])
	expect(buildRow()).toMatchObject({ status: 'sealed' })
})

test('commit retries a transient R2 error and then commits', async () => {
	await markSealed()
	faults.set('r2.get', [r2Internal])
	await expect(commitBuild()).resolves.toEqual({ ok: true, targetCount: 0 })
	expect(sleeps).toEqual([50])
	expect(buildRow()).toMatchObject({ status: 'committed' })
})

test('commit returns a retryable not-ok result when the budget runs out, and the build stays sealed', async () => {
	await markSealed()
	faults.set('d1.select', [lost, lost, lost])
	faults.set('r2.get', [r2Internal, r2Internal])
	const result = await commitBuild()
	expect(result).toEqual({
		ok: false,
		message: expect.stringContaining('retry the publish'),
	})
	expect(result.ok === false && result.message).toContain(
		'publish_build_document.get',
	)
	expect(sleeps).toEqual([50, 100, 200, 50])
	expect(attempts).not.toContain('d1.update')
	expect(buildRow()).toMatchObject({ status: 'sealed' })
})

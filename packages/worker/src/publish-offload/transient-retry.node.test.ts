import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { handlePublishBuildRoute } from './http.ts'
import { sha256Hex } from './module-hashes.ts'
import { persistUploadedPublishBuild } from './persist-uploaded.ts'
import { publishBuildDocumentKey } from './store.ts'

// Transient storage retries through the Promise edges. Fake timers stand in
// for the backoff, so nothing really sleeps.

const buildId = 'pb_0123456789abcdef01234567'
const commit = 'b'.repeat(40)
const ticket = 'kpb_transient'
const emptyDocument = JSON.stringify({
	builderVersion: 2,
	commit,
	files: [],
	targets: [],
})

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
	vi.useRealTimers()
})

/** Rejects the first `failures.length` calls with those messages. */
function failingFirst(failures: Array<string>) {
	let calls = 0
	return {
		calls: () => calls,
		next: () => {
			const message = failures[calls++]
			if (message !== undefined) throw new Error(message)
		},
	}
}

async function setup(input: {
	status: string
	documentSha256?: string | null
	failPut?: Array<string>
	failGet?: Array<string>
	failSeal?: Array<string>
	failSelect?: Array<string>
}) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE publish_builds (
		id TEXT PRIMARY KEY, package_id TEXT, source_id TEXT, owner_user_id TEXT,
		requester_user_id TEXT, org_id TEXT, commit_sha TEXT, origin TEXT,
		context_id TEXT, context_name TEXT, ticket_sha256 TEXT, status TEXT,
		document_sha256 TEXT, message TEXT, created_at TEXT, updated_at TEXT,
		expires_at TEXT, committed_at TEXT)`)
	const now = new Date().toISOString()
	sqlite
		.prepare(
			`INSERT INTO publish_builds VALUES (?, 'pkg', 'src', 'u', 'u', 'org', ?, 'cli', NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
		)
		.run(
			buildId,
			commit,
			await sha256Hex(ticket),
			input.status,
			input.documentSha256 ?? null,
			now,
			now,
			new Date(Date.now() + 60_000).toISOString(),
		)
	const objects = new Map<string, string>()
	const put = failingFirst(input.failPut ?? [])
	const get = failingFirst(input.failGet ?? [])
	const bucket = {
		get: async (key: string) => {
			get.next()
			const text = objects.get(key)
			return text === undefined ? null : { text: async () => text }
		},
		put: async (key: string, body: string) => {
			put.next()
			objects.set(key, body)
		},
		list: async ({ prefix }: { prefix: string }) => ({
			objects: [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key })),
			truncated: false,
		}),
		delete: async (keys: string | Array<string>) => {
			for (const key of [keys].flat()) objects.delete(key)
		},
	}
	const seal = failingFirst(input.failSeal ?? [])
	const select = failingFirst(input.failSelect ?? [])
	const db = createD1FromSqlite(sqlite)
	const flakyDb = {
		...db,
		prepare: (sql: string) => {
			const statement = db.prepare(sql)
			const flaky = sql.includes(`SET status = 'sealed'`)
				? seal
				: sql.includes('SELECT') && sql.includes('FROM publish_builds')
					? select
					: undefined
			if (!flaky) return statement
			return {
				bind: (...params: Array<unknown>) => {
					const bound = statement.bind(...params)
					return {
						first: async () => (flaky.next(), bound.first()),
						run: async () => (flaky.next(), bound.run()),
					}
				},
			}
		},
	} as unknown as D1Database
	const env = {
		APP_DB: flakyDb,
		REPO_SESSION_BLOBS: bucket,
	} as unknown as Env
	const row = () =>
		sqlite
			.prepare(
				`SELECT status, document_sha256 FROM publish_builds WHERE id = ?`,
			)
			.get(buildId) as { status: string; document_sha256: string | null }
	return { env, objects, row, put, get, seal, select }
}

/**
 * Settles `promise`, stepping fake time 10 ms at a time and letting real I/O
 * (hashing, body reads) land between steps.
 */
async function settle<T>(promise: Promise<T>) {
	let done = false
	const settled = promise
		.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		)
		.finally(() => {
			done = true
		})
	for (let step = 0; !done && step < 1_000; step++) {
		await vi.advanceTimersByTimeAsync(10)
		await new Promise((resolve) => setImmediate(resolve))
	}
	return await settled
}

function sealRequest(env: Env) {
	const url = new URL(`https://kody.test/v1/publish-builds/${buildId}/seal`)
	return handlePublishBuildRoute({
		request: new Request(url, {
			method: 'POST',
			body: emptyDocument,
			headers: { Authorization: `Bearer ${ticket}` },
		}),
		env,
		url,
	})
}

function commitBuild(env: Env) {
	return persistUploadedPublishBuild({
		env,
		buildId,
		baseUrl: 'https://kody.test',
		userId: 'u',
		source: { id: 'src' } as never,
		savedPackage: { id: 'pkg' } as never,
		publishedCommit: commit,
		sourceFiles: {},
		targets: [],
	})
}

const lost = 'Network connection lost.'

test('a seal whose document write blips once is retried and seals the build', async () => {
	const { env, row, put } = await setup({
		status: 'uploading',
		failPut: [`put: internal error (10001)`],
	})
	const result = await settle(sealRequest(env))
	expect(result).toMatchObject({ ok: true })
	expect(put.calls()).toBe(2)
	expect(row()).toEqual({
		status: 'sealed',
		document_sha256: await sha256Hex(emptyDocument),
	})
})

test('a permanent storage failure on seal is not retried', async () => {
	const { env, row, put } = await setup({
		status: 'uploading',
		failPut: ['put: Unauthorized (10002)', lost],
	})
	const result = await settle(sealRequest(env))
	expect(result).toMatchObject({
		ok: false,
		error: { message: 'put: Unauthorized (10002)' },
	})
	expect(put.calls()).toBe(1)
	expect(row()).toEqual({ status: 'uploading', document_sha256: null })
})

test('a seal that spends its retry budget is a 503 storage_busy and leaves the build uploading', async () => {
	// 150 ms on the document write, then 50 + 100 ms on the seal; the next
	// 200 ms wait would pass the 400 ms budget for the request.
	const { env, objects, row, put, seal } = await setup({
		status: 'uploading',
		failPut: [lost, lost],
		failSeal: [
			'D1_ERROR: internal error',
			'D1_ERROR: internal error',
			'D1_ERROR: internal error',
		],
	})
	const result = await settle(sealRequest(env))
	expect(result).toMatchObject({
		ok: false,
		error: {
			status: 503,
			code: 'storage_busy',
			headers: { 'Retry-After': '5' },
		},
	})
	expect(put.calls()).toBe(3)
	expect(seal.calls()).toBe(3)
	expect(row()).toEqual({ status: 'uploading', document_sha256: null })
	expect(
		objects.has(
			publishBuildDocumentKey(buildId, await sha256Hex(emptyDocument)),
		),
	).toBe(false)
})

test('a commit that spends its retry budget is not ok, can be retried, and leaves the build sealed', async () => {
	const documentSha256 = await sha256Hex(emptyDocument)
	// 150 ms reading the row, then 50 + 100 ms reading the document; the next
	// 200 ms wait would pass the 400 ms budget for the commit.
	const { env, objects, row, select, get } = await setup({
		status: 'sealed',
		documentSha256,
		failSelect: [lost, lost],
		failGet: [
			'storage operation exceeded timeout',
			'storage operation exceeded timeout',
			'storage operation exceeded timeout',
		],
	})
	objects.set(publishBuildDocumentKey(buildId, documentSha256), emptyDocument)
	const result = await settle(commitBuild(env))
	expect(result).toMatchObject({ ok: true })
	if (!result.ok) return
	expect(result.value.ok).toBe(false)
	expect(result.value).toMatchObject({
		message: expect.stringContaining('the publish can be retried'),
	})
	expect(select.calls()).toBe(3)
	expect(get.calls()).toBe(3)
	expect(row()).toEqual({ status: 'sealed', document_sha256: documentSha256 })
})

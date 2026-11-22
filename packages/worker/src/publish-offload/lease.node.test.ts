import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { sha256Hex } from './module-hashes.ts'
import { handlePublishBuildRoute } from './http.ts'
import { publishBuildRetentionMs } from './policy.ts'
import {
	createPublishBuild,
	finishPublishBuild,
	publishBuildBlobPrefix,
	purgeExpiredPublishBuilds,
	resolveUploadedPublishBuildForPublish,
} from './store.ts'

vi.mock('./flag.ts', () => ({ isPublishOffloadEnabledFor: async () => true }))

const minute = 60 * 1000
const start = Date.parse('2026-11-22T12:00:00.000Z')
const commit = 'a'.repeat(40)

function memoryBucket(options: { pageSize?: number } = {}) {
	const objects = new Map<string, Uint8Array | string>()
	const bucket = {
		objects,
		failDeleteAfter: Infinity,
		deleteCalls: 0,
		head: async (key: string) => (objects.has(key) ? { key } : null),
		put: async (key: string, body: Uint8Array | string) => {
			objects.set(key, body)
		},
		list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
			// Like R2, a cursor resumes after the last listed key.
			const keys = [...objects.keys()]
				.filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
				.sort()
			const page = keys.slice(0, options.pageSize ?? keys.length)
			return {
				objects: page.map((key) => ({ key })),
				truncated: page.length < keys.length,
				cursor: page.at(-1),
			}
		},
		delete: async (keys: Array<string>) => {
			bucket.deleteCalls += 1
			if (bucket.deleteCalls > bucket.failDeleteAfter) {
				throw new Error('R2 delete failed')
			}
			for (const key of keys) objects.delete(key)
		},
	}
	return bucket
}

let sqlite: DatabaseSync
let db: D1Database
let bucket = memoryBucket()

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(start)
	sqlite = new DatabaseSync(':memory:')
	for (const file of [
		'0247-publish-builds.sql',
		'0289-publish-build-documents-in-r2.sql',
	]) {
		sqlite.exec(
			readFileSync(
				new URL(`../../migrations/${file}`, import.meta.url),
				'utf8',
			),
		)
	}
	db = createD1FromSqlite(sqlite)
	bucket = memoryBucket()
})

afterEach(() => {
	vi.useRealTimers()
	sqlite.close()
})

async function newBuild() {
	return await createPublishBuild({
		db,
		packageId: 'pkg_1',
		sourceId: 'src_1',
		ownerUserId: 'user_1',
		requesterUserId: 'user_1',
		orgId: 'org_1',
		commit,
		origin: 'cli',
	})
}

type Build = Awaited<ReturnType<typeof newBuild>>

async function call(
	build: Build,
	method: string,
	suffix = '',
	body?: BodyInit,
): Promise<{ status: number; code?: string; body?: Record<string, unknown> }> {
	const url = new URL(
		`https://kody.test/v1/publish-builds/${build.buildId}${suffix}`,
	)
	try {
		const response = await handlePublishBuildRoute({
			request: new Request(url, {
				method,
				body,
				headers: { Authorization: `Bearer ${build.ticket}` },
			}),
			env: { APP_DB: db, REPO_SESSION_BLOBS: bucket } as never,
			url,
		})
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		}
	} catch (error) {
		const failure = error as { status: number; code: string }
		return { status: failure.status, code: failure.code }
	}
}

function at(minutes: number) {
	vi.setSystemTime(start + minutes * minute)
}

function iso(minutes: number) {
	return new Date(start + minutes * minute).toISOString()
}

function row(buildId: string) {
	return sqlite
		.prepare(`SELECT status, expires_at FROM publish_builds WHERE id = ?`)
		.get(buildId) as { status: string; expires_at: string } | undefined
}

async function putChunk(build: Build, text: string) {
	const bytes = new TextEncoder().encode(text)
	const sha = await sha256Hex(bytes)
	return { sha, result: await call(build, 'PUT', `/blobs/${sha}`, bytes) }
}

function sealBody(chunks: Array<string>) {
	return JSON.stringify({
		builderVersion: 2,
		commit,
		files: [],
		targets: [
			{
				kind: 'module',
				bundleKind: 'module',
				entryPoint: 'src/index.ts',
				mainModule: 'index.js',
				modules: { 'index.js': { sha256: 'x', size: 1, chunks } },
			},
		],
	})
}

function chunkKeys(buildId: string) {
	return [...bucket.objects.keys()].filter((key) =>
		key.startsWith(publishBuildBlobPrefix(buildId)),
	)
}

test('a chunk PUT or status GET slides the lease to ten minutes from now', async () => {
	const build = await newBuild()
	expect(build.expiresAt).toBe(iso(10))
	at(8)
	const status = await call(build, 'GET')
	expect(status.status).toBe(200)
	expect(status.body?.expires_at).toBe(iso(18))
	expect(row(build.buildId)?.expires_at).toBe(iso(18))
	at(17)
	expect((await putChunk(build, 'one')).result.status).toBe(200)
	expect(row(build.buildId)?.expires_at).toBe(iso(27))
	at(26)
	expect((await call(build, 'GET')).status).toBe(200)
})

test('the lease never slides past two hours after the build was created', async () => {
	const build = await newBuild()
	for (let minutes = 9; minutes <= 108; minutes += 9) {
		at(minutes)
		expect((await call(build, 'GET')).status).toBe(200)
	}
	at(115)
	expect((await call(build, 'GET')).body?.expires_at).toBe(iso(120))
	at(119)
	expect((await putChunk(build, 'late')).result.status).toBe(200)
	expect(row(build.buildId)?.expires_at).toBe(iso(120))
	at(120)
	expect(await call(build, 'GET')).toMatchObject({
		status: 401,
		code: 'unauthorized',
	})
})

test('an expired lease answers 401 on every route, and seal does not renew it', async () => {
	const build = await newBuild()
	at(1)
	const { sha } = await putChunk(build, 'one')
	at(5)
	expect((await call(build, 'POST', '/seal', sealBody([sha]))).status).toBe(200)
	expect(row(build.buildId)).toEqual({ status: 'sealed', expires_at: iso(11) })

	const idle = await newBuild()
	at(15)
	for (const [method, suffix] of [
		['GET', ''],
		['POST', '/seal'],
		['POST', '/abandon'],
	] as const) {
		expect(
			await call(idle, method, suffix, method === 'POST' ? '{}' : undefined),
		).toMatchObject({
			status: 401,
			code: 'unauthorized',
		})
	}
	expect((await putChunk(idle, 'two')).result.status).toBe(401)
	expect(row(idle.buildId)?.status).toBe('uploading')
})

test('abandon deletes the chunks at once, is idempotent, and leaves the ticket useless', async () => {
	const build = await newBuild()
	const { sha } = await putChunk(build, 'one')
	await putChunk(build, 'two')
	expect(chunkKeys(build.buildId)).toHaveLength(2)

	const abandoned = await call(build, 'POST', '/abandon')
	expect(abandoned).toEqual({
		status: 200,
		body: { ok: true, build_id: build.buildId, status: 'abandoned' },
	})
	expect(chunkKeys(build.buildId)).toEqual([])
	expect(row(build.buildId)?.status).toBe('abandoned')
	expect(await call(build, 'POST', '/abandon')).toEqual(abandoned)

	for (const [method, suffix, body] of [
		['GET', '', undefined],
		['POST', '/seal', sealBody([sha])],
	] as const) {
		expect(await call(build, method, suffix, body)).toMatchObject({
			status: 401,
			code: 'unauthorized',
		})
	}
	expect((await putChunk(build, 'three')).result.status).toBe(401)
	expect(chunkKeys(build.buildId)).toEqual([])
	expect(row(build.buildId)?.expires_at).toBe(iso(10))
})

test('abandon after seal, commit or reject is a 409 conflict', async () => {
	const build = await newBuild()
	const { sha } = await putChunk(build, 'one')
	expect((await call(build, 'POST', '/seal', sealBody([sha]))).status).toBe(200)
	expect(await call(build, 'POST', '/abandon')).toMatchObject({
		status: 409,
		code: 'invalid_request',
	})
	expect(row(build.buildId)?.status).toBe('sealed')
	expect(chunkKeys(build.buildId)).toHaveLength(1)
	for (const status of ['committed', 'rejected'] as const) {
		await finishPublishBuild({ db, buildId: build.buildId, status })
		expect(await call(build, 'POST', '/abandon')).toMatchObject({
			status: 409,
			code: 'invalid_request',
		})
		expect(row(build.buildId)?.status).toBe(status)
	}
})

test('publishing an abandoned build is rejected with a clear message', async () => {
	const build = await newBuild()
	expect((await call(build, 'POST', '/abandon')).status).toBe(200)
	await expect(
		resolveUploadedPublishBuildForPublish({
			db,
			buildId: build.buildId,
			packageId: 'pkg_1',
			sourceId: 'src_1',
			commit,
			requesterUserId: 'user_1',
			orgId: 'org_1',
		}),
	).rejects.toThrow(/abandoned this upload before sealing it/)
})

test('a partial R2 delete still abandons; the purge drops the remaining chunks and the row', async () => {
	bucket = memoryBucket({ pageSize: 1 })
	bucket.failDeleteAfter = 1
	const build = await newBuild()
	await putChunk(build, 'one')
	await putChunk(build, 'two')
	await putChunk(build, 'three')

	expect(await call(build, 'POST', '/abandon')).toMatchObject({
		status: 200,
		body: { status: 'abandoned' },
	})
	expect(row(build.buildId)?.status).toBe('abandoned')
	expect(chunkKeys(build.buildId)).toHaveLength(2)

	bucket.failDeleteAfter = Infinity
	expect(
		await purgeExpiredPublishBuilds({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: start + 10 * minute + publishBuildRetentionMs - 1,
		}),
	).toBe(0)
	expect(
		await purgeExpiredPublishBuilds({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: start + 10 * minute + publishBuildRetentionMs + 1,
		}),
	).toBe(1)
	expect(chunkKeys(build.buildId)).toEqual([])
	expect(row(build.buildId)).toBeUndefined()
})

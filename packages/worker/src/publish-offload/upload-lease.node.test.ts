import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { runPublishOffload } from '#worker/test-support/publish-offload-effect.ts'
import { handlePublishBuildRoute } from './http.ts'
import { sha256Hex } from './module-hashes.ts'
import {
	publishBuildLeaseMs,
	publishBuildMaxLeaseMs,
	publishBuildRetentionMs,
} from './policy.ts'
import {
	publishBuildBlobKey,
	publishBuildDocumentKey,
	purgeExpiredPublishBuilds,
	resolveUploadedPublishBuildForPublish,
} from './store.ts'

vi.mock('./flag.ts', () => ({
	isPublishOffloadEnabledFor: () => Effect.succeed(true),
}))

const buildId = 'pb_0123456789abcdef01234567'
const otherBuildId = 'pb_76543210fedcba9876543210'
const commit = 'a'.repeat(40)
const ticket = 'kpb_lease'
const minute = 60_000
const chunk = new TextEncoder().encode('js\0export default 1')

function memoryBucket(options: { failDeleteAfter?: number } = {}) {
	const objects = new Map<string, Uint8Array>()
	let deletes = 0
	return {
		objects,
		head: async (key: string) => (objects.has(key) ? { key } : null),
		put: async (key: string, body: unknown) => {
			objects.set(
				key,
				typeof body === 'string'
					? new TextEncoder().encode(body)
					: new Uint8Array(body as ArrayBuffer),
			)
		},
		// One key per page so a delete can fail partway through a prefix.
		list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
			const keys = [...objects.keys()].filter((key) => key.startsWith(prefix))
			const index = cursor ? Number(cursor) : 0
			const key = keys[index]
			return {
				objects: key ? [{ key }] : [],
				truncated: index + 1 < keys.length,
				cursor: String(index + 1),
			}
		},
		delete: async (keys: Array<string>) => {
			deletes += 1
			if (
				options.failDeleteAfter !== undefined &&
				deletes > options.failDeleteAfter
			) {
				throw new Error('R2 delete failed')
			}
			for (const key of keys) objects.delete(key)
		},
	}
}

async function setup(input: {
	status?: string
	createdAgoMs?: number
	expiresInMs?: number
	failDeleteAfter?: number
}) {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`CREATE TABLE publish_builds (
		id TEXT PRIMARY KEY, package_id TEXT, source_id TEXT, owner_user_id TEXT,
		requester_user_id TEXT, org_id TEXT, commit_sha TEXT, origin TEXT,
		context_id TEXT, context_name TEXT, ticket_sha256 TEXT, status TEXT,
		document_sha256 TEXT, message TEXT, created_at TEXT, updated_at TEXT,
		expires_at TEXT, committed_at TEXT)`)
	const now = Date.now()
	const createdAt = new Date(now - (input.createdAgoMs ?? minute)).toISOString()
	sqlite
		.prepare(
			`INSERT INTO publish_builds VALUES (?, 'pkg', 'src', 'u', 'u', 'org', ?, 'cli', NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
		)
		.run(
			buildId,
			commit,
			await sha256Hex(ticket),
			input.status ?? 'uploading',
			createdAt,
			createdAt,
			new Date(now + (input.expiresInMs ?? minute)).toISOString(),
		)
	const bucket = memoryBucket({ failDeleteAfter: input.failDeleteAfter })
	const db = createD1FromSqlite(sqlite)
	const env = { APP_DB: db, REPO_SESSION_BLOBS: bucket } as unknown as Env
	const rowOf = () =>
		sqlite
			.prepare(`SELECT status, created_at, expires_at FROM publish_builds`)
			.get() as
			| { status: string; created_at: string; expires_at: string }
			| undefined
	const setExpiresIn = (ms: number) =>
		sqlite
			.prepare(`UPDATE publish_builds SET expires_at = ?`)
			.run(new Date(Date.now() + ms).toISOString())
	return { sqlite, db, bucket, env, rowOf, setExpiresIn }
}

function call(env: Env, method: string, suffix: string, body?: BodyInit) {
	const url = new URL(`https://kody.test/v1/publish-builds/${buildId}${suffix}`)
	return handlePublishBuildRoute({
		request: new Request(url, {
			method,
			body,
			headers: { Authorization: `Bearer ${ticket}` },
		}),
		env,
		url,
	})
}

const putChunk = async (env: Env) =>
	call(env, 'PUT', `/blobs/${await sha256Hex(chunk)}`, chunk)

const emptyDocument = JSON.stringify({
	builderVersion: 2,
	commit,
	files: [],
	targets: [],
})

function expectLeaseFromNow(expiresAt: string, before: number) {
	const expires = Date.parse(expiresAt)
	expect(expires).toBeGreaterThanOrEqual(before + publishBuildLeaseMs)
	expect(expires).toBeLessThanOrEqual(Date.now() + publishBuildLeaseMs)
}

test('a chunk upload and a status read renew the lease to 10 minutes from now; sealing does not', async () => {
	const { env, rowOf, setExpiresIn } = await setup({})
	let before = Date.now()
	expect((await putChunk(env)).status).toBe(200)
	expectLeaseFromNow(rowOf()!.expires_at, before)

	setExpiresIn(minute)
	before = Date.now()
	const status = (await (await call(env, 'GET', '')).json()) as {
		expires_at: string
	}
	expectLeaseFromNow(rowOf()!.expires_at, before)
	expect(status.expires_at).toBe(rowOf()!.expires_at)

	setExpiresIn(minute)
	const leaseBeforeSeal = rowOf()!.expires_at
	expect((await call(env, 'POST', '/seal', emptyDocument)).status).toBe(200)
	expect(rowOf()).toMatchObject({
		status: 'sealed',
		expires_at: leaseBeforeSeal,
	})
})

test('a renewed lease stops 2 hours after the build started', async () => {
	const { env, rowOf } = await setup({
		createdAgoMs: publishBuildMaxLeaseMs - 5 * minute,
	})
	const cap = new Date(
		Date.parse(rowOf()!.created_at) + publishBuildMaxLeaseMs,
	).toISOString()
	expect((await putChunk(env)).status).toBe(200)
	expect(rowOf()!.expires_at).toBe(cap)
	const status = (await (await call(env, 'GET', '')).json()) as {
		expires_at: string
	}
	expect(status.expires_at).toBe(cap)
	expect(rowOf()!.expires_at).toBe(cap)
})

test('an expired lease gets the 401 on every route and is not renewed', async () => {
	const { env, rowOf, bucket } = await setup({ expiresInMs: -1 })
	const expiredAt = rowOf()!.expires_at
	for (const request of [
		() => call(env, 'GET', ''),
		() => putChunk(env),
		() => call(env, 'POST', '/seal', emptyDocument),
		() => call(env, 'POST', '/abandon'),
	]) {
		await expect(request()).rejects.toMatchObject({
			status: 401,
			code: 'unauthorized',
		})
	}
	expect(rowOf()).toMatchObject({ status: 'uploading', expires_at: expiredAt })
	expect(bucket.objects.size).toBe(0)
})

test('abandon deletes the build chunks, then the ticket opens nothing and abandon repeats', async () => {
	const { env, rowOf, bucket } = await setup({})
	expect((await putChunk(env)).status).toBe(200)
	const otherKey = publishBuildBlobKey(otherBuildId, 'b'.repeat(64))
	bucket.objects.set(otherKey, chunk)

	const abandoned = await call(env, 'POST', '/abandon')
	expect(abandoned.status).toBe(200)
	expect(await abandoned.json()).toEqual({
		ok: true,
		build_id: buildId,
		status: 'abandoned',
	})
	expect(rowOf()!.status).toBe('abandoned')
	expect([...bucket.objects.keys()]).toEqual([otherKey])

	for (const request of [
		() => call(env, 'GET', ''),
		() => putChunk(env),
		() => call(env, 'POST', '/seal', emptyDocument),
	]) {
		await expect(request()).rejects.toMatchObject({
			status: 401,
			code: 'unauthorized',
		})
	}
	expect([...bucket.objects.keys()]).toEqual([otherKey])

	const again = await call(env, 'POST', '/abandon')
	expect(again.status).toBe(200)
	expect(await again.json()).toEqual({
		ok: true,
		build_id: buildId,
		status: 'abandoned',
	})
	expect(rowOf()!.status).toBe('abandoned')
})

test('a sealed, committed or rejected build cannot be abandoned (409)', async () => {
	for (const status of ['sealed', 'committed', 'rejected']) {
		const { env, rowOf } = await setup({ status })
		await expect(call(env, 'POST', '/abandon')).rejects.toMatchObject({
			status: 409,
			code: 'invalid_request',
			message: `This publish build is already ${status}.`,
		})
		expect(rowOf()!.status).toBe(status)
	}
})

test('abandon after a seal through the same ticket is a 409', async () => {
	const { env, rowOf } = await setup({})
	expect((await call(env, 'POST', '/seal', emptyDocument)).status).toBe(200)
	await expect(call(env, 'POST', '/abandon')).rejects.toMatchObject({
		status: 409,
		code: 'invalid_request',
		message: 'This publish build is already sealed.',
	})
	expect(rowOf()!.status).toBe('sealed')
})

test('publishing an abandoned build is rejected', async () => {
	const { env, db } = await setup({})
	expect((await call(env, 'POST', '/abandon')).status).toBe(200)
	const error = await runPublishOffload(
		Effect.flip(
			resolveUploadedPublishBuildForPublish({
				buildId,
				packageId: 'pkg',
				sourceId: 'src',
				commit,
				requesterUserId: 'u',
				orgId: 'org',
			}),
		),
		{ db },
	)
	expect(error).toMatchObject({
		_tag: 'PublishBuildRejected',
		reason: 'the upload was abandoned before it was sealed; start a new build.',
	})
})

test('an abandon whose R2 delete fails partway still answers 200 and the sweep drops the rest', async () => {
	const { env, db, rowOf, bucket } = await setup({ failDeleteAfter: 1 })
	const first = await sha256Hex(chunk)
	const secondBytes = new TextEncoder().encode('js\0export default 2')
	const second = await sha256Hex(secondBytes)
	expect((await putChunk(env)).status).toBe(200)
	expect((await call(env, 'PUT', `/blobs/${second}`, secondBytes)).status).toBe(
		200,
	)

	const abandoned = await call(env, 'POST', '/abandon')
	expect(abandoned.status).toBe(200)
	expect(await abandoned.json()).toEqual({
		ok: true,
		build_id: buildId,
		status: 'abandoned',
	})
	const row = rowOf()!
	expect(row.status).toBe('abandoned')
	const remaining = [...bucket.objects.keys()]
	expect(remaining).toHaveLength(1)
	expect([
		publishBuildBlobKey(buildId, first),
		publishBuildBlobKey(buildId, second),
	]).toContain(remaining[0])

	const healthyBucket = memoryBucket()
	for (const key of remaining) healthyBucket.objects.set(key, chunk)
	const purged = await runPublishOffload(purgeExpiredPublishBuilds(), {
		db,
		bucket: healthyBucket as unknown as R2Bucket,
		now: Date.parse(row.expires_at) + publishBuildRetentionMs + 1,
	})
	expect(purged).toBe(1)
	expect(healthyBucket.objects.size).toBe(0)
	expect(rowOf()).toBeUndefined()
})

test('the sweep drops abandoned rows like rejected ones, after the retention window', async () => {
	const { sqlite, db, rowOf } = await setup({ status: 'abandoned' })
	const abandonedAt = Date.parse(rowOf()!.expires_at)
	sqlite
		.prepare(
			`INSERT INTO publish_builds (id, status, document_sha256, expires_at)
			VALUES (?, 'rejected', ?, ?)`,
		)
		.run(otherBuildId, 'd'.repeat(64), rowOf()!.expires_at)
	const bucket = memoryBucket()
	const keys = [
		publishBuildBlobKey(buildId, 'a'.repeat(64)),
		publishBuildBlobKey(otherBuildId, 'b'.repeat(64)),
		publishBuildDocumentKey(otherBuildId, 'd'.repeat(64)),
	]
	for (const key of keys) bucket.objects.set(key, chunk)

	expect(
		await runPublishOffload(purgeExpiredPublishBuilds(), {
			db,
			bucket: bucket as unknown as R2Bucket,
			now: abandonedAt + publishBuildRetentionMs - minute,
		}),
	).toBe(0)
	expect([...bucket.objects.keys()]).toEqual(keys)

	expect(
		await runPublishOffload(purgeExpiredPublishBuilds(), {
			db,
			bucket: bucket as unknown as R2Bucket,
			now: abandonedAt + publishBuildRetentionMs + minute,
		}),
	).toBe(2)
	expect(bucket.objects.size).toBe(0)
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM publish_builds`).get(),
	).toEqual({ count: 0 })
})

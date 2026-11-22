import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { handlePublishBuildRoute } from './http.ts'
import { sha256Hex } from './module-hashes.ts'
import { persistUploadedPublishBuild } from './persist-uploaded.ts'
import { publishBuildBlobKey, publishBuildDocumentKey } from './store.ts'

// Regressions for bugs at a19df3d49f04, driven through the Promise edges so
// the same file runs against both implementations.

const buildId = 'pb_0123456789abcdef01234567'
const commit = 'a'.repeat(40)
const ticket = 'kpb_regression'

function memoryBucket() {
	const objects = new Map<string, Uint8Array>()
	const bytesOf = (body: unknown) =>
		typeof body === 'string'
			? new TextEncoder().encode(body)
			: new Uint8Array(body as ArrayBuffer)
	return {
		objects,
		head: async (key: string) => (objects.has(key) ? { key } : null),
		get: async (key: string) => {
			const bytes = objects.get(key)
			return bytes === undefined
				? null
				: {
						text: async () => new TextDecoder().decode(bytes),
						arrayBuffer: async () => bytes.slice().buffer,
					}
		},
		put: async (key: string, body: unknown) => {
			objects.set(key, bytesOf(body))
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
}

async function setup(status: string, documentSha256: string | null = null) {
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
			status,
			documentSha256,
			now,
			now,
			new Date(Date.now() + 60_000).toISOString(),
		)
	const bucket = memoryBucket()
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		REPO_SESSION_BLOBS: bucket,
	} as unknown as Env
	const statusOf = () =>
		(
			sqlite
				.prepare(`SELECT status FROM publish_builds WHERE id = ?`)
				.get(buildId) as { status: string }
		).status
	return { sqlite, bucket, env, statusOf }
}

function seal(env: Env, body: string) {
	const url = new URL(`https://kody.test/v1/publish-builds/${buildId}/seal`)
	return handlePublishBuildRoute({
		request: new Request(url, {
			method: 'POST',
			body,
			headers: { Authorization: `Bearer ${ticket}` },
		}),
		env,
		url,
	})
}

test('a seal body that is not JSON, or has malformed entries, is a 400 invalid_request', async () => {
	const { env } = await setup('uploading')
	for (const body of [
		'{"builderVersion": 2,',
		JSON.stringify({ builderVersion: 2, commit, files: [], targets: [null] }),
		JSON.stringify({ builderVersion: 2, commit, files: [7], targets: [] }),
	]) {
		await expect(seal(env, body)).rejects.toMatchObject({
			status: 400,
			code: 'invalid_request',
		})
	}
})

test('a seal that loses the race to another state change is a 409, not sealed', async () => {
	const { sqlite, env, statusOf } = await setup('uploading')
	const db = env.APP_DB
	// Another request rejects the build between the ticket check and the seal.
	const racing = {
		...db,
		prepare: (sql: string) => {
			if (sql.includes(`SET status = 'sealed'`)) {
				sqlite.exec(`UPDATE publish_builds SET status = 'rejected'`)
			}
			return db.prepare(sql)
		},
	} as D1Database
	const response = seal(
		{ ...env, APP_DB: racing },
		JSON.stringify({ builderVersion: 2, commit, files: [], targets: [] }),
	)
	await expect(response).rejects.toMatchObject({
		status: 409,
		code: 'invalid_request',
		message: 'This publish build is already rejected.',
	})
	expect(statusOf()).toBe('rejected')
})

test('an uploaded json module that is not JSON rejects the build instead of leaving it sealed', async () => {
	const moduleBytes = new TextEncoder().encode('json\0{not json')
	const chunk = await sha256Hex(moduleBytes)
	const document = JSON.stringify({
		builderVersion: 2,
		commit,
		files: [],
		targets: [
			{
				kind: 'module',
				bundleKind: 'module',
				artifactName: null,
				entryPoint: 'index.ts',
				mainModule: 'data.json',
				modules: {
					'data.json': {
						sha256: chunk,
						size: moduleBytes.byteLength,
						chunks: [chunk],
					},
				},
			},
		],
	})
	const documentSha256 = await sha256Hex(document)
	const { bucket, env, statusOf } = await setup('sealed', documentSha256)
	bucket.objects.set(
		publishBuildDocumentKey(buildId, documentSha256),
		new TextEncoder().encode(document),
	)
	bucket.objects.set(publishBuildBlobKey(buildId, chunk), moduleBytes)
	const result = await persistUploadedPublishBuild({
		env,
		buildId,
		baseUrl: 'https://kody.test',
		userId: 'u',
		source: { id: 'src' } as never,
		savedPackage: { id: 'pkg' } as never,
		publishedCommit: commit,
		sourceFiles: {},
		targets: [
			{
				kind: 'module',
				bundleKind: 'module',
				artifactName: null,
				entryPoint: 'index.ts',
			},
		],
	})
	expect(result).toEqual({
		ok: false,
		message: 'Publish build rejected: an uploaded json module is not JSON.',
	})
	expect(statusOf()).toBe('rejected')
})

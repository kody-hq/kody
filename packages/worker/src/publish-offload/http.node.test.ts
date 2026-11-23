import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { sha256Hex } from './module-hashes.ts'
import { publishOffloadLimits } from './policy.ts'

const row = {
	id: 'pb_0123456789abcdef01234567',
	commit_sha: 'a'.repeat(40),
	status: 'uploading',
	message: null,
	expires_at: new Date(Date.now() + 60_000).toISOString(),
}
const sealed = vi.fn()

vi.mock('./store.ts', async (importOriginal) => {
	const store = await importOriginal<typeof import('./store.ts')>()
	return {
		...store,
		authenticatePublishBuildTicket: async (input: {
			db: D1Database
			buildId: string
			ticket: string | null
		}) =>
			input.ticket === 'kpb_good'
				? await store.getPublishBuild(input.db, input.buildId)
				: null,
		sealPublishBuild: (input: unknown) => sealed(input),
	}
})

const { handlePublishBuildRoute } = await import('./http.ts')
const realStore =
	await vi.importActual<typeof import('./store.ts')>('./store.ts')

function memoryBucket() {
	const objects = new Map<string, Uint8Array>()
	const puts: Array<string> = []
	return {
		objects,
		puts,
		head: async (key: string) => (objects.has(key) ? { key } : null),
		get: async (key: string) => {
			const bytes = objects.get(key)
			return bytes
				? { text: async () => new TextDecoder().decode(bytes) }
				: null
		},
		put: async (key: string, bytes: Uint8Array | string) => {
			puts.push(key)
			objects.set(
				key,
				typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
			)
		},
		list: async ({ prefix }: { prefix: string }) => ({
			objects: [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key })),
			truncated: false,
		}),
	}
}

let bucket = memoryBucket()
let sqlite: DatabaseSync
let db: D1Database
beforeEach(() => {
	bucket = memoryBucket()
	sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		`CREATE TABLE publish_builds (id TEXT PRIMARY KEY, commit_sha TEXT, status TEXT, message TEXT, expires_at TEXT, document_sha256 TEXT, updated_at TEXT)`,
	)
	sqlite.exec(
		`CREATE TABLE publish_build_chunks (build_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (build_id, sha256))`,
	)
	sqlite
		.prepare(
			`INSERT INTO publish_builds (id, commit_sha, status, expires_at) VALUES (?, ?, ?, ?)`,
		)
		.run(row.id, row.commit_sha, row.status, row.expires_at)
	db = createD1FromSqlite(sqlite)
	sealed.mockReset()
	sealed.mockImplementation(realStore.sealPublishBuild)
})

function buildRow() {
	return sqlite
		.prepare(`SELECT * FROM publish_builds WHERE id = ?`)
		.get(row.id) as { status: string }
}

function chunkTotals() {
	return sqlite
		.prepare(
			`SELECT COUNT(*) AS chunks, COALESCE(SUM(bytes), 0) AS bytes FROM publish_build_chunks WHERE build_id = ?`,
		)
		.get(row.id) as { chunks: number; bytes: number }
}

function countChunks(count: number, bytesEach = 1) {
	const insert = sqlite.prepare(
		`INSERT INTO publish_build_chunks (build_id, sha256, bytes) VALUES (?, ?, ?)`,
	)
	for (let index = 0; index < count; index++) {
		insert.run(row.id, `seed-${index}`, bytesEach)
	}
}

function call(
	method: string,
	path: string,
	body?: BodyInit,
	ticket = 'kpb_good',
) {
	const url = new URL(`https://kody.test${path}`)
	return handlePublishBuildRoute({
		request: new Request(url, {
			method,
			body,
			headers: { Authorization: `Bearer ${ticket}` },
		}),
		env: { REPO_SESSION_BLOBS: bucket, APP_DB: db } as never,
		url,
	})
}

const chunk = new TextEncoder().encode('js\0export default 1')

test('a retried chunk upload is a no-op and status lists it for resume', async () => {
	const sha = await sha256Hex(chunk)
	expect(
		(
			await call(
				'PUT',
				`/v1/publish-builds/pb_0123456789abcdef01234567/blobs/${sha}`,
				chunk,
			)
		).status,
	).toBe(200)
	expect(
		(
			await call(
				'PUT',
				`/v1/publish-builds/pb_0123456789abcdef01234567/blobs/${sha}`,
				chunk,
			)
		).status,
	).toBe(200)
	expect(bucket.puts).toHaveLength(1)
	const status = (await (
		await call('GET', '/v1/publish-builds/pb_0123456789abcdef01234567')
	).json()) as {
		uploaded_chunks: Array<string>
	}
	expect(status.uploaded_chunks).toEqual([sha])
})

test('a chunk whose bytes do not match its sha256 is refused', async () => {
	await expect(
		call(
			'PUT',
			`/v1/publish-builds/pb_0123456789abcdef01234567/blobs/${'0'.repeat(64)}`,
			chunk,
		),
	).rejects.toThrow(/do not match/)
	expect(bucket.puts).toHaveLength(0)
})

test('a chunk over 4 MiB is refused', async () => {
	const big = new Uint8Array(4 * 1024 * 1024 + 1)
	await expect(
		call(
			'PUT',
			`/v1/publish-builds/pb_0123456789abcdef01234567/blobs/${await sha256Hex(big)}`,
			big,
		),
	).rejects.toThrow(/at most/)
})

test('a bad or expired ticket is refused', async () => {
	await expect(
		call(
			'GET',
			'/v1/publish-builds/pb_0123456789abcdef01234567',
			undefined,
			'kpb_bad',
		),
	).rejects.toThrow(/invalid or expired/)
})

test('sealing names missing chunks, then seals once they are uploaded', async () => {
	const sha = await sha256Hex(chunk)
	const document = JSON.stringify({
		builderVersion: 2,
		commit: row.commit_sha,
		files: [],
		targets: [
			{
				kind: 'module',
				bundleKind: 'module',
				artifactName: null,
				entryPoint: 'src/index.ts',
				mainModule: 'index.js',
				modules: {
					'index.js': { sha256: sha, size: chunk.byteLength, chunks: [sha] },
				},
			},
		],
	})
	const missing = await call(
		'POST',
		'/v1/publish-builds/pb_0123456789abcdef01234567/seal',
		document,
	)
	expect(missing.status).toBe(409)
	expect(await missing.json()).toEqual({ ok: false, missing_chunks: [sha] })
	expect(sealed).not.toHaveBeenCalled()
	await call(
		'PUT',
		`/v1/publish-builds/pb_0123456789abcdef01234567/blobs/${sha}`,
		chunk,
	)
	expect(
		(
			await call(
				'POST',
				'/v1/publish-builds/pb_0123456789abcdef01234567/seal',
				document,
			)
		).status,
	).toBe(200)
	expect(sealed).toHaveBeenCalledTimes(1)
})

test('a document for another commit cannot be sealed', async () => {
	await expect(
		call(
			'POST',
			'/v1/publish-builds/pb_0123456789abcdef01234567/seal',
			JSON.stringify({
				builderVersion: 2,
				commit: 'b'.repeat(40),
				files: [],
				targets: [],
			}),
		),
	).rejects.toThrow(/this build is for/)
})

const sealPath = '/v1/publish-builds/pb_0123456789abcdef01234567/seal'

test('an oversized chunk is refused without waiting for the rest of the body', async () => {
	const sha = '0'.repeat(64)
	let pulls = 0
	// Sends more than the 4 MiB cap, then never ends: a reader that buffers
	// the whole body before checking the cap would wait forever.
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls += 1
			if (pulls <= 5) controller.enqueue(new Uint8Array(1024 * 1024))
		},
	})
	const url = new URL(
		`https://kody.test/v1/publish-builds/pb_0123456789abcdef01234567/blobs/${sha}`,
	)
	const request = new Request(url, {
		method: 'PUT',
		body,
		headers: { Authorization: 'Bearer kpb_good' },
		duplex: 'half',
	} as RequestInit)
	const outcome = await Promise.race([
		handlePublishBuildRoute({
			request,
			env: { REPO_SESSION_BLOBS: bucket, APP_DB: db } as never,
			url,
		}).catch((error: unknown) => error),
		new Promise((resolve) => setTimeout(() => resolve('still reading'), 2_000)),
	])
	expect(outcome).toMatchObject({ status: 400, code: 'invalid_request' })
	expect(String((outcome as Error).message)).toMatch(/at most/)
	expect(bucket.puts).toHaveLength(0)
})

test('a seal body that is not JSON is a 400, not an internal error', async () => {
	await expect(
		call('POST', sealPath, '{"builderVersion":'),
	).rejects.toMatchObject({
		status: 400,
		code: 'invalid_request',
		message: 'Request body must be valid JSON.',
	})
	expect(sealed).not.toHaveBeenCalled()
})

test('a seal document whose targets have no module chunk lists is a 400, not an internal error', async () => {
	await expect(
		call(
			'POST',
			sealPath,
			JSON.stringify({
				builderVersion: 2,
				commit: row.commit_sha,
				files: [],
				targets: [{ kind: 'module', modules: { 'index.js': {} } }],
			}),
		),
	).rejects.toMatchObject({
		status: 400,
		code: 'invalid_request',
		message: expect.stringMatching(
			/^The build document is malformed: targets\.0/,
		),
	})
	expect(sealed).not.toHaveBeenCalled()
})

test('a seal that loses the race to another request is a 409, not a success', async () => {
	sealed.mockResolvedValue(false)
	await expect(
		call(
			'POST',
			sealPath,
			JSON.stringify({
				builderVersion: 2,
				commit: row.commit_sha,
				files: [],
				targets: [],
			}),
		),
	).rejects.toMatchObject({ status: 409, code: 'invalid_request' })
	expect(sealed).toHaveBeenCalledTimes(1)
})

test('a hung R2 call fails with a 503 at its deadline', async () => {
	let expire = () => {}
	let timerSet = () => {}
	const timerStarted = new Promise<void>((resolve) => {
		timerSet = resolve
	})
	const hungBucket = {
		...bucket,
		head: () => new Promise(() => {}),
	}
	const url = new URL(
		`https://kody.test/v1/publish-builds/pb_0123456789abcdef01234567/blobs/${'0'.repeat(64)}`,
	)
	const pending = handlePublishBuildRoute({
		request: new Request(url, {
			method: 'PUT',
			body: chunk,
			headers: { Authorization: 'Bearer kpb_good' },
		}),
		env: { REPO_SESSION_BLOBS: hungBucket, APP_DB: db } as never,
		url,
		clock: {
			setTimer: (_ms, onExpire) => {
				expire = onExpire
				timerSet()
				return () => {}
			},
		},
	})
	await timerStarted
	expire()
	await expect(pending).rejects.toMatchObject({
		status: 503,
		code: 'internal_error',
	})
})

function blobPath(sha: string) {
	return `/v1/publish-builds/${row.id}/blobs/${sha}`
}

function chunkOf(seed: number) {
	return new TextEncoder().encode(`js\0export default ${seed}`)
}

async function moduleTarget(
	bytes: Uint8Array,
	overrides: Record<string, unknown> = {},
) {
	const sha = await sha256Hex(bytes)
	return {
		kind: 'module',
		bundleKind: 'module',
		artifactName: null,
		entryPoint: 'src/index.ts',
		mainModule: 'index.js',
		modules: {
			'index.js': { sha256: sha, size: bytes.byteLength, chunks: [sha] },
		},
		...overrides,
	}
}

function sealBody(targets: Array<unknown>, files: Array<unknown> = []) {
	return JSON.stringify({
		builderVersion: 2,
		commit: row.commit_sha,
		files,
		targets,
	})
}

test('concurrent chunk PUTs cannot push a build past maxBlobsPerBuild', async () => {
	countChunks(publishOffloadLimits.maxBlobsPerBuild - 1)
	const outcomes = await Promise.all(
		Array.from({ length: 4 }, async (_, index) => {
			const bytes = chunkOf(index)
			return call('PUT', blobPath(await sha256Hex(bytes)), bytes).then(
				(response) => response.status,
				(error: { status: number; message: string }) => error.message,
			)
		}),
	)
	expect(outcomes.filter((outcome) => outcome === 200)).toHaveLength(1)
	expect(outcomes.filter((outcome) => outcome !== 200)).toEqual(
		Array.from({ length: 3 }, () =>
			expect.stringMatching(/at most 4096 chunks/),
		),
	)
	expect(bucket.puts).toHaveLength(1)
	expect(chunkTotals().chunks).toBe(publishOffloadLimits.maxBlobsPerBuild)
})

test('total uploaded bytes are capped at maxUploadBytes', async () => {
	const bytes = chunkOf(1)
	countChunks(1, publishOffloadLimits.maxUploadBytes - bytes.byteLength + 1)
	await expect(
		call('PUT', blobPath(await sha256Hex(bytes)), bytes),
	).rejects.toMatchObject({
		status: 400,
		message: `A build may upload at most ${publishOffloadLimits.maxUploadBytes} bytes.`,
	})
	expect(bucket.puts).toHaveLength(0)
})

test('a chunk retried after a failed write is counted once', async () => {
	const bytes = chunkOf(1)
	const sha = await sha256Hex(bytes)
	const put = bucket.put
	bucket.put = async () => {
		throw new Error('r2 down')
	}
	await expect(call('PUT', blobPath(sha), bytes)).rejects.toThrow('r2 down')
	bucket.put = put
	expect((await call('PUT', blobPath(sha), bytes)).status).toBe(200)
	expect(chunkTotals()).toEqual({ chunks: 1, bytes: bytes.byteLength })
})

test('concurrent PUTs of the same chunk count it once', async () => {
	const bytes = chunkOf(1)
	const sha = await sha256Hex(bytes)
	const statuses = await Promise.all(
		Array.from({ length: 3 }, () =>
			call('PUT', blobPath(sha), bytes).then((response) => response.status),
		),
	)
	expect(statuses).toEqual([200, 200, 200])
	expect(chunkTotals()).toEqual({ chunks: 1, bytes: bytes.byteLength })
})

test('the seal body is read with a size cap', async () => {
	const cap = publishOffloadLimits.maxSealDocumentBytes
	const piece = new Uint8Array(1024 * 1024).fill(0x20)
	let pulled = 0
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += piece.byteLength
			controller.enqueue(piece)
		},
	})
	const url = new URL(`https://kody.test${sealPath}`)
	await expect(
		handlePublishBuildRoute({
			request: new Request(url, {
				method: 'POST',
				body,
				headers: { Authorization: 'Bearer kpb_good' },
				duplex: 'half',
			} as RequestInit),
			env: { REPO_SESSION_BLOBS: bucket, APP_DB: db } as never,
			url,
		}),
	).rejects.toMatchObject({
		status: 400,
		message: `The build document is at most ${cap} bytes.`,
	})
	expect(pulled).toBeLessThanOrEqual(cap + 2 * piece.byteLength)
	expect(sealed).not.toHaveBeenCalled()
})

test('a seal document that repeats one chunk past its module size is a 400', async () => {
	const bytes = chunkOf(1)
	const sha = await sha256Hex(bytes)
	await call('PUT', blobPath(sha), bytes)
	await expect(
		call(
			'POST',
			sealPath,
			sealBody([
				await moduleTarget(bytes, {
					modules: {
						'index.js': {
							sha256: sha,
							size: 1,
							chunks: Array.from({ length: 10_000 }, () => sha),
						},
					},
				}),
			]),
		),
	).rejects.toMatchObject({
		status: 400,
		message: expect.stringMatching(
			/chunks: lists more chunks than its size needs/,
		),
	})
	expect(sealed).not.toHaveBeenCalled()
})

test('a seal document with malformed files entries is a 400', async () => {
	await expect(
		call('POST', sealPath, sealBody([], [null, 7])),
	).rejects.toMatchObject({
		status: 400,
		message: expect.stringMatching(
			/^The build document is malformed: files\.0/,
		),
	})
	expect(sealed).not.toHaveBeenCalled()
})

test('a seal document whose mainModule is an Object.prototype key is a 400', async () => {
	await expect(
		call(
			'POST',
			sealPath,
			sealBody([await moduleTarget(chunkOf(1), { mainModule: 'toString' })]),
		),
	).rejects.toMatchObject({
		status: 400,
		message: expect.stringMatching(
			/mainModule: must name one of the uploaded modules/,
		),
	})
})

test('retrying a seal that already succeeded answers 200 again', async () => {
	const bytes = chunkOf(1)
	await call('PUT', blobPath(await sha256Hex(bytes)), bytes)
	const document = sealBody([await moduleTarget(bytes)])
	expect((await call('POST', sealPath, document)).status).toBe(200)
	expect((await call('POST', sealPath, document)).status).toBe(200)
	expect(sealed).toHaveBeenCalledTimes(1)
	expect(buildRow().status).toBe('sealed')
})

test('sealing an already-sealed build with another document is a 409 that names the conflict', async () => {
	const bytes = chunkOf(1)
	await call('PUT', blobPath(await sha256Hex(bytes)), bytes)
	expect((await call('POST', sealPath, sealBody([]))).status).toBe(200)
	await expect(
		call('POST', sealPath, sealBody([await moduleTarget(bytes)])),
	).rejects.toMatchObject({
		status: 409,
		message: expect.stringMatching(
			/already sealed with a different build document/,
		),
	})
})

test('a seal that loses the race to the same document still succeeds', async () => {
	sealed.mockImplementation(
		async (input: Parameters<typeof realStore.sealPublishBuild>[0]) => {
			await realStore.sealPublishBuild(input)
			return false
		},
	)
	expect((await call('POST', sealPath, sealBody([]))).status).toBe(200)
})

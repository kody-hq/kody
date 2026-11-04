import { beforeEach, expect, test, vi } from 'vitest'
import { sha256Hex } from './module-hashes.ts'

const row = {
	id: 'pb_0123456789abcdef01234567',
	commit_sha: 'a'.repeat(40),
	status: 'uploading',
	message: null,
	expires_at: new Date(Date.now() + 60_000).toISOString(),
}
const sealed = vi.fn()

vi.mock('./store.ts', () => ({
	authenticatePublishBuildTicket: async (input: { ticket: string | null }) =>
		input.ticket === 'kpb_good' ? row : null,
	publishBuildBlobKey: (buildId: string, sha: string) =>
		`publish-builds/${buildId}/blobs/${sha}`,
	publishBuildBlobPrefix: (buildId: string) =>
		`publish-builds/${buildId}/blobs/`,
	sealPublishBuild: (input: unknown) => sealed(input),
}))

const { handlePublishBuildRoute } = await import('./http.ts')

function memoryBucket() {
	const objects = new Map<string, Uint8Array>()
	const puts: Array<string> = []
	return {
		objects,
		puts,
		head: async (key: string) => (objects.has(key) ? { key } : null),
		put: async (key: string, bytes: Uint8Array) => {
			puts.push(key)
			objects.set(key, bytes)
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
beforeEach(() => {
	bucket = memoryBucket()
	sealed.mockReset()
})

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
		env: { REPO_SESSION_BLOBS: bucket, APP_DB: {} } as never,
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
		builderVersion: 1,
		commit: row.commit_sha,
		files: [],
		inlinedPackageIds: [],
		targets: [
			{
				kind: 'module',
				bundleKind: 'module',
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
				builderVersion: 1,
				commit: 'b'.repeat(40),
				files: [],
				targets: [],
				inlinedPackageIds: [],
			}),
		),
	).rejects.toThrow(/this build is for/)
})

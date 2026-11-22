import { beforeEach, expect, test, vi } from 'vitest'
import { sha256Hex } from './module-hashes.ts'

const row: { status: string; message: string | null } & Record<
	string,
	unknown
> = {
	id: 'pb_0123456789abcdef01234567',
	commit_sha: 'a'.repeat(40),
	status: 'uploading',
	message: null,
	expires_at: new Date(Date.now() + 60_000).toISOString(),
}
const sealed = vi.fn()
const rejectBlocked = vi.fn(
	async (input: { buildId: string; message: string }) => {
		if (row.status !== 'uploading') return false
		row.status = 'rejected'
		row.message = input.message
		return true
	},
)

vi.mock('./store.ts', () => ({
	authenticatePublishBuildTicket: async (input: { ticket: string | null }) =>
		input.ticket === 'kpb_good' ? row : null,
	publishBuildBlobKey: (buildId: string, sha: string) =>
		`publish-builds/${buildId}/blobs/${sha}`,
	publishBuildBlobPrefix: (buildId: string) =>
		`publish-builds/${buildId}/blobs/`,
	sealPublishBuild: (input: unknown) => sealed(input),
	rejectBlockedChunkPublishBuild: (input: {
		buildId: string
		message: string
	}) => rejectBlocked(input),
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
let scanUrl: string | undefined
beforeEach(() => {
	bucket = memoryBucket()
	sealed.mockReset()
	rejectBlocked.mockClear()
	row.status = 'uploading'
	row.message = null
	scanUrl = undefined
	vi.unstubAllGlobals()
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
		env: {
			REPO_SESSION_BLOBS: bucket,
			APP_DB: {},
			PUBLISH_CHUNK_SCAN_URL: scanUrl,
		} as never,
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
			env: { REPO_SESSION_BLOBS: bucket, APP_DB: {} } as never,
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
		message: 'The build document needs files and targets.',
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
		env: { REPO_SESSION_BLOBS: hungBucket, APP_DB: {} } as never,
		url,
		clock: {
			setTimer: (_ms, onExpire) => {
				expire = onExpire
				return () => {}
			},
		},
	})
	await Promise.resolve()
	expire()
	await expect(pending).rejects.toMatchObject({
		status: 503,
		code: 'internal_error',
	})
})

const scanner = 'https://scanner.test/scan'
const blobPath = (sha: string) =>
	`/v1/publish-builds/pb_0123456789abcdef01234567/blobs/${sha}`

function stubScanner(answer: () => Promise<Response>) {
	const fetchMock = vi.fn<typeof fetch>(async () => await answer())
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

test('with no chunk scan URL (unset or empty) the chunk is stored without a scan', async () => {
	const fetchMock = stubScanner(async () => Response.json({ verdict: 'allow' }))
	const sha = await sha256Hex(chunk)
	expect((await call('PUT', blobPath(sha), chunk)).status).toBe(200)
	scanUrl = '  '
	bucket = memoryBucket()
	expect((await call('PUT', blobPath(sha), chunk)).status).toBe(200)
	expect(fetchMock).not.toHaveBeenCalled()
	expect(bucket.puts).toHaveLength(1)
})

test('an allowed chunk is scanned with its build, sha256 and size, then stored', async () => {
	scanUrl = scanner
	const fetchMock = stubScanner(async () => Response.json({ verdict: 'allow' }))
	const sha = await sha256Hex(chunk)
	const response = await call('PUT', blobPath(sha), chunk)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ ok: true, sha256: sha })
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const [url, init] = fetchMock.mock.calls[0]!
	expect(url).toBe(scanner)
	expect(init?.method).toBe('POST')
	expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
	expect(JSON.parse(String(init?.body))).toEqual({
		buildId: row.id,
		sha256: sha,
		bytes: chunk.byteLength,
	})
	expect(init?.signal).toBeInstanceOf(AbortSignal)
	expect(bucket.puts).toEqual([`publish-builds/${row.id}/blobs/${sha}`])
})

test('a blocked chunk is not stored, rejects the build with a 422, and later requests get a 409', async () => {
	scanUrl = scanner
	stubScanner(async () =>
		Response.json({ verdict: 'block', reason: 'matched malware signature' }),
	)
	const sha = await sha256Hex(chunk)
	const message = `chunk ${sha} blocked: matched malware signature`
	await expect(call('PUT', blobPath(sha), chunk)).rejects.toMatchObject({
		status: 422,
		code: 'chunk_blocked',
		message,
	})
	expect(bucket.puts).toHaveLength(0)
	expect(rejectBlocked).toHaveBeenCalledWith(
		expect.objectContaining({ buildId: row.id, message }),
	)
	expect(row).toMatchObject({ status: 'rejected', message })
	await expect(call('PUT', blobPath(sha), chunk)).rejects.toMatchObject({
		status: 409,
		code: 'invalid_request',
		message: 'This publish build is already rejected.',
	})
	expect(bucket.puts).toHaveLength(0)
})

test('a non-2xx scanner answer is a 503 with Retry-After and leaves the build uploading', async () => {
	scanUrl = scanner
	stubScanner(async () => new Response('busy', { status: 502 }))
	const sha = await sha256Hex(chunk)
	await expect(call('PUT', blobPath(sha), chunk)).rejects.toMatchObject({
		status: 503,
		code: 'chunk_scan_unavailable',
		message: expect.stringContaining('HTTP 502'),
		headers: { 'Retry-After': '30' },
	})
	expect(bucket.puts).toHaveLength(0)
	expect(rejectBlocked).not.toHaveBeenCalled()
	expect(row.status).toBe('uploading')
})

test('a scanner network error is a 503 chunk_scan_unavailable', async () => {
	scanUrl = scanner
	stubScanner(async () => {
		throw new TypeError('fetch failed')
	})
	const sha = await sha256Hex(chunk)
	await expect(call('PUT', blobPath(sha), chunk)).rejects.toMatchObject({
		status: 503,
		code: 'chunk_scan_unavailable',
		message: expect.stringContaining('network_error: fetch failed'),
		headers: { 'Retry-After': '30' },
	})
	expect(bucket.puts).toHaveLength(0)
	expect(row.status).toBe('uploading')
})

test('a scanner that does not answer within 10 seconds is aborted and is a 503', async () => {
	scanUrl = scanner
	let scanSignal: AbortSignal | undefined
	const fetchMock = vi.fn<typeof fetch>(
		(_url, init) =>
			new Promise<Response>(() => {
				scanSignal = init?.signal ?? undefined
			}),
	)
	vi.stubGlobal('fetch', fetchMock)
	const timers: Array<{ ms: number; onExpire: () => void }> = []
	const sha = await sha256Hex(chunk)
	const url = new URL(`https://kody.test${blobPath(sha)}`)
	const pending = handlePublishBuildRoute({
		request: new Request(url, {
			method: 'PUT',
			body: chunk,
			headers: { Authorization: 'Bearer kpb_good' },
		}),
		env: {
			REPO_SESSION_BLOBS: bucket,
			APP_DB: {},
			PUBLISH_CHUNK_SCAN_URL: scanner,
		} as never,
		url,
		clock: {
			setTimer: (ms, onExpire) => {
				timers.push({ ms, onExpire })
				return () => {}
			},
		},
	})
	await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
	const scanTimer = timers.find((timer) => timer.ms === 10_000)
	expect(scanTimer).toBeDefined()
	scanTimer!.onExpire()
	await expect(pending).rejects.toMatchObject({
		status: 503,
		code: 'chunk_scan_unavailable',
		message: expect.stringContaining('timeout'),
		headers: { 'Retry-After': '30' },
	})
	expect(scanSignal?.aborted).toBe(true)
	expect(bucket.puts).toHaveLength(0)
	expect(row.status).toBe('uploading')
})

test('a scanner answer that is not a verdict is a 503, not a block or an allow', async () => {
	scanUrl = scanner
	const sha = await sha256Hex(chunk)
	for (const body of [
		'not json',
		JSON.stringify({ verdict: 'maybe' }),
		JSON.stringify({ verdict: 'block' }),
		JSON.stringify(['allow']),
	]) {
		stubScanner(async () => new Response(body, { status: 200 }))
		await expect(call('PUT', blobPath(sha), chunk)).rejects.toMatchObject({
			status: 503,
			code: 'chunk_scan_unavailable',
			message: expect.stringContaining('malformed_verdict'),
			headers: { 'Retry-After': '30' },
		})
	}
	expect(bucket.puts).toHaveLength(0)
	expect(rejectBlocked).not.toHaveBeenCalled()
	expect(row.status).toBe('uploading')
})

test('an already stored chunk is not scanned again', async () => {
	const sha = await sha256Hex(chunk)
	bucket.objects.set(`publish-builds/${row.id}/blobs/${sha}`, chunk)
	scanUrl = scanner
	const fetchMock = stubScanner(async () =>
		Response.json({ verdict: 'block', reason: 'should not be asked' }),
	)
	expect((await call('PUT', blobPath(sha), chunk)).status).toBe(200)
	expect(fetchMock).not.toHaveBeenCalled()
	expect(bucket.puts).toHaveLength(0)
	expect(row.status).toBe('uploading')
})

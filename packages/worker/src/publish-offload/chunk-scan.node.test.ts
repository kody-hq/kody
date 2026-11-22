import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { handlePublishBuildRoute } from './http.ts'
import { sha256Hex } from './module-hashes.ts'
import { publishBuildBlobKey } from './store.ts'

const buildId = 'pb_0123456789abcdef01234567'
const ticket = 'kpb_scan'
const scanUrl = 'https://scanner.test/scan'
const chunk = new TextEncoder().encode('js\0export default 1')
const sha = await sha256Hex(chunk)
const blobKey = publishBuildBlobKey(buildId, sha)

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

async function setup(scan?: string) {
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
			`INSERT INTO publish_builds VALUES (?, 'pkg', 'src', 'u', 'u', 'org', ?, 'cli', NULL, NULL, ?, 'uploading', NULL, NULL, ?, ?, ?, NULL)`,
		)
		.run(
			buildId,
			'a'.repeat(40),
			await sha256Hex(ticket),
			now,
			now,
			new Date(Date.now() + 60_000).toISOString(),
		)
	const objects = new Map<string, Uint8Array>()
	const bucket = {
		head: async (key: string) => (objects.has(key) ? { key } : null),
		put: async (key: string, body: Uint8Array) => {
			objects.set(key, body)
		},
		list: async ({ prefix }: { prefix: string }) => ({
			objects: [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key })),
			truncated: false,
		}),
	}
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		REPO_SESSION_BLOBS: bucket,
		...(scan === undefined ? {} : { PUBLISH_CHUNK_SCAN_URL: scan }),
	} as unknown as Env
	const row = () =>
		sqlite
			.prepare(`SELECT status, message FROM publish_builds WHERE id = ?`)
			.get(buildId) as { status: string; message: string | null }
	const upload = () => {
		const url = new URL(
			`https://kody.test/v1/publish-builds/${buildId}/blobs/${sha}`,
		)
		return handlePublishBuildRoute({
			request: new Request(url, {
				method: 'PUT',
				body: chunk,
				headers: { Authorization: `Bearer ${ticket}` },
			}),
			env,
			url,
		})
	}
	return { objects, row, upload }
}

function stubScanner(answer: (signal: AbortSignal) => Promise<Response>) {
	const scanner = vi.fn(
		async (_url: string, init: RequestInit & { signal: AbortSignal }) =>
			await answer(init.signal),
	)
	vi.stubGlobal('fetch', scanner)
	return scanner
}

const unavailable = {
	status: 503,
	code: 'chunk_scan_unavailable',
	headers: { 'Retry-After': '30' },
}

test('an unset or empty PUBLISH_CHUNK_SCAN_URL stores the chunk without a scan', async () => {
	const scanner = stubScanner(async () => Response.json({ verdict: 'block' }))
	for (const scan of [undefined, '', '  ']) {
		const { objects, upload } = await setup(scan)
		expect((await upload()).status).toBe(200)
		expect(objects.has(blobKey)).toBe(true)
	}
	expect(scanner).not.toHaveBeenCalled()
})

test('an allow verdict stores the chunk after posting the build, sha256 and size', async () => {
	const scanner = stubScanner(async () => Response.json({ verdict: 'allow' }))
	const { objects, row, upload } = await setup(scanUrl)
	expect((await upload()).status).toBe(200)
	expect(objects.has(blobKey)).toBe(true)
	expect(row().status).toBe('uploading')
	expect(scanner).toHaveBeenCalledTimes(1)
	const [url, init] = scanner.mock.calls[0]!
	expect(url).toBe(scanUrl)
	expect(init.method).toBe('POST')
	expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
	expect(JSON.parse(String(init.body))).toEqual({
		buildId,
		sha256: sha,
		bytes: chunk.byteLength,
	})
})

test('a block verdict rejects the build with a 422, and the ticket then gets a 409', async () => {
	stubScanner(async () =>
		Response.json({ verdict: 'block', reason: 'malware signature' }),
	)
	const { objects, row, upload } = await setup(scanUrl)
	const message = `chunk ${sha} blocked: malware signature`
	await expect(upload()).rejects.toMatchObject({
		status: 422,
		code: 'chunk_blocked',
		message,
	})
	expect(objects.size).toBe(0)
	expect(row()).toEqual({ status: 'rejected', message })
	await expect(upload()).rejects.toMatchObject({
		status: 409,
		code: 'invalid_request',
		message: 'This publish build is already rejected.',
	})
})

test('a non-2xx or unreachable scanner is a 503 with Retry-After and the build keeps uploading', async () => {
	for (const answer of [
		async () => new Response('down', { status: 500 }),
		async () => new Response(null, { status: 404 }),
		async () => {
			throw new TypeError('fetch failed')
		},
	]) {
		stubScanner(answer)
		const { objects, row, upload } = await setup(scanUrl)
		await expect(upload()).rejects.toMatchObject(unavailable)
		expect(objects.size).toBe(0)
		expect(row()).toEqual({ status: 'uploading', message: null })
	}
})

test('a scanner past the 10 second deadline is aborted and answers 503', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	const { promise: scanning, resolve } = Promise.withResolvers<AbortSignal>()
	stubScanner((signal) => {
		resolve(signal)
		return new Promise<never>(() => {})
	})
	const { objects, row, upload } = await setup(scanUrl)
	const settled = expect(upload()).rejects.toMatchObject(unavailable)
	const signal = await scanning
	await vi.advanceTimersByTimeAsync(9_999)
	expect(signal.aborted).toBe(false)
	await vi.advanceTimersByTimeAsync(1)
	await settled
	expect(signal.aborted).toBe(true)
	expect(objects.size).toBe(0)
	expect(row().status).toBe('uploading')
})

test('a verdict that does not match the schema is a 503, not stored', async () => {
	for (const body of [
		'not json',
		JSON.stringify({ verdict: 'maybe' }),
		JSON.stringify({ verdict: 'block' }),
		JSON.stringify({ verdict: 'block', reason: 7 }),
	]) {
		stubScanner(async () => new Response(body, { status: 200 }))
		const { objects, row, upload } = await setup(scanUrl)
		await expect(upload()).rejects.toMatchObject(unavailable)
		expect(objects.size).toBe(0)
		expect(row().status).toBe('uploading')
	}
})

test('a chunk that is already stored is not scanned again', async () => {
	const scanner = stubScanner(async () => Response.json({ verdict: 'allow' }))
	const { upload } = await setup(scanUrl)
	expect((await upload()).status).toBe(200)
	expect((await upload()).status).toBe(200)
	expect(scanner).toHaveBeenCalledTimes(1)
})

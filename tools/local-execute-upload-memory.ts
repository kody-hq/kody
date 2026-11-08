/**
 * Synthetic large-upload memory harness for `kody execute --local`.
 *
 * Runs a real local workerd + CLI bridge against an in-process fake Kody API
 * that plays both the gateway and a credentialed resumable-upload sink. User
 * code uploads deterministic pseudo-random bytes through
 * `credential(key).fetch` with `x-kody-secret-resolution: headers-only`, one
 * Content-Range chunk per request. The sink checks the opaque credential
 * handle, hashes every accepted byte, and the harness compares the byte count
 * and SHA-256 with an independent Node computation while sampling Node and
 * workerd RSS separately. Synthetic only: no network, no real credentials.
 *
 *   npm run local-execute:upload-memory -- --bytes 426916543
 *
 * Flags: --bytes N, --chunk N (default 3 MiB), --body uint8|arraybuffer|blob|stream,
 * --kind secret|oauth, --unauthorized-every N (sink 401s every Nth chunk once),
 * --consume none|cancel|text (308 bodies), --resume-body (308 with a body),
 * --resolution headers-only|off|default (default omits the header),
 * --workerd-budget-mib N (abort above it), --out file.json
 */
import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import { createLocalExecuteRuntimeShimSource } from '../packages/worker/src/package-runtime/local-execute-runtime-support.ts'

const mib = 1024 * 1024
const { values: flags } = parseArgs({
	options: {
		bytes: { type: 'string', default: String(64 * mib) },
		chunk: { type: 'string', default: String(3 * mib) },
		body: { type: 'string', default: 'uint8' },
		kind: { type: 'string', default: 'secret' },
		'unauthorized-every': { type: 'string', default: '0' },
		consume: { type: 'string', default: 'text' },
		resolution: { type: 'string', default: 'headers-only' },
		'resume-body': { type: 'boolean', default: false },
		'workerd-budget-mib': { type: 'string', default: '1024' },
		'sample-ms': { type: 'string', default: '200' },
		seed: { type: 'string', default: '2463534242' },
		out: { type: 'string' },
		role: { type: 'string', default: 'harness' },
	},
})

const totalBytes = Number(flags.bytes)
const chunkBytes = Number(flags.chunk)
const unauthorizedEvery = Number(flags['unauthorized-every'])
const workerdBudgetBytes = Number(flags['workerd-budget-mib']) * mib
const seed = Number(flags.seed) >>> 0
const handle = 'kch1.synthetic-handle'
const sinkHost = 'upload.sink.test'
const uploadUrl = `https://${sinkHost}/upload/session?upload_id=synthetic-capability`

/** Same generator as the workerd module: xorshift32 per 32-bit word, per chunk. */
function createChunkGenerator(initial: number) {
	let state = initial >>> 0 || 1
	return (size: number) => {
		const bytes = new Uint8Array(size)
		const words = new Uint32Array(bytes.buffer, 0, size >>> 2)
		for (let index = 0; index < words.length; index += 1) {
			state ^= state << 13
			state >>>= 0
			state ^= state >>> 17
			state ^= state << 5
			state >>>= 0
			words[index] = state
		}
		for (let index = words.length * 4; index < size; index += 1) {
			state ^= state << 13
			state >>>= 0
			state ^= state >>> 17
			state ^= state << 5
			state >>>= 0
			bytes[index] = state & 0xff
		}
		return bytes
	}
}

function expectedSha256() {
	const hash = createHash('sha256')
	const next = createChunkGenerator(seed)
	for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
		hash.update(next(Math.min(chunkBytes, totalBytes - offset)))
	}
	return hash.digest('hex')
}

const userCode = `
import { credential } from 'kody:runtime'
export default async function main(params) {
	const client = await credential('synthetic-sink')
	const createChunkGenerator = ${createChunkGenerator.toString()}
	const next = createChunkGenerator(params.seed)
	const toBody = (bytes) => {
		if (params.body === 'arraybuffer') return bytes.buffer
		if (params.body === 'blob') return new Blob([bytes])
		if (params.body === 'stream') {
			let offset = 0
			return new ReadableStream({
				pull(controller) {
					if (offset >= bytes.byteLength) return controller.close()
					const end = Math.min(offset + 65536, bytes.byteLength)
					controller.enqueue(bytes.slice(offset, end))
					offset = end
				},
			})
		}
		return bytes
	}
	let offset = 0
	let requests = 0
	let callerRetries = 0
	let final = null
	while (offset < params.totalBytes) {
		const size = Math.min(params.chunkBytes, params.totalBytes - offset)
		const bytes = next(size)
		let response
		for (let attempt = 0; attempt < 3; attempt += 1) {
			requests += 1
			response = await client.fetch(params.uploadUrl, {
				method: 'PUT',
				headers: {
					'content-type': 'application/octet-stream',
					'content-range': 'bytes ' + offset + '-' + (offset + size - 1) + '/' + params.totalBytes,
					...(params.resolution === 'default'
						? {}
						: { 'x-kody-secret-resolution': params.resolution }),
				},
				body: toBody(bytes),
			})
			if (response.status !== 401) break
			callerRetries += 1
			await response.body?.cancel()
		}
		if (response.status === 200) {
			final = await response.json()
		} else if (response.status === 308) {
			if (params.consume === 'text') await response.text()
			else if (params.consume === 'cancel') await response.body?.cancel()
		} else {
			throw new Error('Unexpected sink status ' + response.status)
		}
		offset += size
	}
	return { requests, callerRetries, offset, final }
}
`

type SinkStats = {
	acceptedBytes: number
	requests: number
	streamHops: number
	jsonHops: number
	unauthorized: number
	rejected: Array<string>
}

const sink = {
	hash: createHash('sha256'),
	received: 0,
	digest: null as string | null,
	pendingUnauthorized: new Set<number>(),
	stats: {
		acceptedBytes: 0,
		requests: 0,
		streamHops: 0,
		jsonHops: 0,
		unauthorized: 0,
		rejected: [],
	} as SinkStats,
}

type SinkResult = {
	status: number
	headers: Record<string, string>
	body: Buffer
}

async function drain(body: AsyncIterable<Buffer> | Buffer) {
	if (Buffer.isBuffer(body)) return
	for await (const _chunk of body) {
		// Discard.
	}
}

/** A credentialed resumable sink (Content-Range chunks, 308 until complete). */
async function handleSinkRequest(input: {
	url: string
	method: string
	headers: Record<string, string>
	body: AsyncIterable<Buffer> | Buffer
}): Promise<SinkResult> {
	sink.stats.requests += 1
	const reject = async (status: number, reason: string) => {
		sink.stats.rejected.push(reason)
		await drain(input.body)
		return { status, headers: {}, body: Buffer.from(reason) }
	}
	const lower = Object.fromEntries(
		Object.entries(input.headers).map(([key, value]) => [
			key.toLowerCase(),
			value,
		]),
	)
	let host = ''
	try {
		host = new URL(input.url).hostname
	} catch {
		return reject(400, 'invalid url')
	}
	if (host !== sinkHost) return reject(403, 'host not allowed')
	// Stands in for the gateway placing the credential from the opaque handle.
	if (lower['x-kody-credential-client'] !== handle) {
		return reject(401, 'missing credential handle')
	}
	if (input.method !== 'PUT') return reject(405, 'method')
	const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(lower['content-range'] ?? '')
	if (!range) return reject(400, 'content-range')
	const start = Number(range[1])
	const end = Number(range[2])
	const total = Number(range[3])
	if (start !== sink.received) return reject(416, 'offset mismatch')
	if (unauthorizedEvery > 0) {
		const index = Math.floor(start / chunkBytes)
		if (
			index % unauthorizedEvery === unauthorizedEvery - 1 &&
			!sink.pendingUnauthorized.has(index)
		) {
			sink.pendingUnauthorized.add(index)
			sink.stats.unauthorized += 1
			await drain(input.body)
			return {
				status: 401,
				headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
				body: Buffer.from('expired'),
			}
		}
	}
	let count = 0
	const chunkHash = createHash('sha256')
	const parts: Array<Buffer> = []
	const take = (chunk: Buffer) => {
		count += chunk.length
		parts.push(chunk)
	}
	if (Buffer.isBuffer(input.body)) take(input.body)
	else for await (const chunk of input.body) take(chunk)
	if (count !== end - start + 1) return reject(400, `length ${count} != range`)
	for (const part of parts) {
		sink.hash.update(part)
		chunkHash.update(part)
	}
	parts.length = 0
	sink.received += count
	sink.stats.acceptedBytes += count
	if (sink.received >= total) {
		sink.digest = sink.hash.digest('hex')
		return {
			status: 200,
			headers: { 'content-type': 'application/json' },
			body: Buffer.from(
				JSON.stringify({ bytes: sink.received, sha256: sink.digest }),
			),
		}
	}
	return {
		status: 308,
		headers: { range: `bytes=0-${sink.received - 1}` },
		body: flags['resume-body']
			? Buffer.alloc(16 * 1024, 0x2e)
			: Buffer.alloc(0),
	}
}

async function readAll(request: IncomingMessage) {
	const chunks: Array<Buffer> = []
	for await (const chunk of request) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks)
}

const shim = createLocalExecuteRuntimeShimSource('.__kody_virtual__/runtime.js')

async function handleApi(request: IncomingMessage, response: ServerResponse) {
	const sendJson = (status: number, payload: unknown) => {
		response.writeHead(status, { 'content-type': 'application/json' })
		response.end(JSON.stringify(payload))
	}
	if (request.url === '/v1/capability-proxy/gateway-fetch') {
		sink.stats.streamHops += 1
		const rawHeaders = request.headers['x-kody-gateway-headers']
		const headers =
			typeof rawHeaders === 'string'
				? (JSON.parse(rawHeaders) as Record<string, string>)
				: {}
		const result = await handleSinkRequest({
			url: String(request.headers['x-kody-gateway-url'] ?? ''),
			method: String(request.headers['x-kody-gateway-method'] ?? 'GET'),
			headers,
			body: request as AsyncIterable<Buffer>,
		})
		response.writeHead(result.status, result.headers)
		response.end(result.body)
		return
	}
	const raw = await readAll(request)
	if (request.url === '/v1/capability-proxy/session') {
		sendJson(200, {
			scopes: ['capability-proxy'],
			expiresAt: null,
			features: ['credential-call-map'],
		})
		return
	}
	if (request.url === '/v1/local-execute/package-graph') {
		sendJson(200, {
			imports: [],
			warnings: [],
			modules: [{ name: '.__kody_virtual__/runtime.js', esModule: shim }],
		})
		return
	}
	if (request.url === '/v1/capability-proxy/call') {
		const call = JSON.parse(raw.toString('utf8')) as {
			path: Array<string>
			args: Array<{ request: unknown }>
		}
		const name = call.path.join('.')
		if (name === 'kody.credentialClientOpen') {
			sendJson(200, {
				result: {
					ok: true,
					value: {
						handle,
						key: 'synthetic-sink',
						name: 'synthetic-sink',
						scope: 'personal',
						kind: flags.kind,
						hosts: [sinkHost],
					},
				},
			})
			return
		}
		if (name === 'kody.credentialClientRefresh') {
			sendJson(200, { result: { ok: true, value: { refreshed: true } } })
			return
		}
		if (name === 'kody.gatewayFetch') {
			sink.stats.jsonHops += 1
			const hop = call.args[0]!.request as {
				url: string
				method?: string
				headers?: Record<string, string>
				bodyBase64?: string
			}
			const result = await handleSinkRequest({
				url: hop.url,
				method: hop.method ?? 'GET',
				headers: hop.headers ?? {},
				body: Buffer.from(hop.bodyBase64 ?? '', 'base64'),
			})
			sendJson(200, {
				result: {
					status: result.status,
					statusText: '',
					headers: result.headers,
					bodyBase64: result.body.toString('base64'),
				},
			})
			return
		}
		sendJson(200, { result: null })
		return
	}
	sendJson(404, { error: 'not found' })
}

function readRssBytes(pid: number): { rss: number; hwm: number } | null {
	try {
		const status = readFileSync(`/proc/${pid}/status`, 'utf8')
		const rss = /VmRSS:\s+(\d+) kB/.exec(status)
		const hwm = /VmHWM:\s+(\d+) kB/.exec(status)
		return {
			rss: Number(rss?.[1] ?? 0) * 1024,
			hwm: Number(hwm?.[1] ?? 0) * 1024,
		}
	} catch {
		return null
	}
}

function findWorkerdPid(): number | null {
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
			const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
			if (ppid !== process.pid) continue
			const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
			if (cmdline.includes('workerd')) return Number(entry)
		} catch {
			// Process exited.
		}
	}
	return null
}

async function main() {
	const expected = expectedSha256()
	// The fake API and sink run in their own process so Node RSS below is the
	// CLI host alone, the way it runs against a remote Kody API.
	const api: ChildProcess = fork(
		process.argv[1]!,
		[...process.argv.slice(2), '--role', 'api'],
		{
			execArgv: process.execArgv,
			stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
		},
	)
	const apiUrl = await new Promise<string>((resolve, reject) => {
		api.once('message', (message) =>
			resolve(String((message as { apiUrl: string }).apiUrl)),
		)
		api.once('exit', (code) => reject(new Error(`fake API exited ${code}`)))
	})
	const readSink = () =>
		new Promise<typeof sinkSnapshot>((resolve) => {
			api.once('message', (message) => resolve(message as typeof sinkSnapshot))
			api.send('stats')
		})
	let sinkSnapshot = {
		received: 0,
		digest: null as string | null,
		stats: sink.stats,
	}
	let reading = false
	const cliModulePath = '../packages/cli/src/local-execute.ts'
	const { runLocalExecute } = (await import(cliModulePath)) as {
		runLocalExecute: (input: Record<string, unknown>) => Promise<{
			isError: boolean
			structuredContent?: unknown
			content?: unknown
		}>
	}
	const controller = new AbortController()
	const samples: Array<{
		ms: number
		sinkBytes: number
		nodeRss: number
		workerdRss: number
	}> = []
	let workerdPid: number | null = null
	let workerdHwm = 0
	let budgetExceeded = false
	const started = Date.now()
	const sampler = setInterval(() => {
		workerdPid ??= findWorkerdPid()
		const workerd = workerdPid ? readRssBytes(workerdPid) : null
		if (workerd) workerdHwm = Math.max(workerdHwm, workerd.hwm)
		samples.push({
			ms: Date.now() - started,
			sinkBytes: sinkSnapshot.received,
			nodeRss: process.memoryUsage().rss,
			workerdRss: workerd?.rss ?? 0,
		})
		if (!reading) {
			reading = true
			void readSink().then((snapshot) => {
				sinkSnapshot = snapshot
				reading = false
			})
		}
		if (workerd && workerd.rss > workerdBudgetBytes && !budgetExceeded) {
			budgetExceeded = true
			controller.abort(new Error('workerd RSS budget exceeded'))
		}
	}, Number(flags['sample-ms']))
	let result: unknown
	let runError: string | null = null
	try {
		result = await runLocalExecute({
			code: userCode,
			params: {
				totalBytes,
				chunkBytes,
				uploadUrl,
				body: flags.body,
				consume: flags.consume,
				resolution: flags.resolution,
				seed,
			},
			token: 'kody_tok_synthetic',
			apiUrl,
			signal: controller.signal,
		})
	} catch (error) {
		runError = error instanceof Error ? error.message : String(error)
	} finally {
		clearInterval(sampler)
	}
	while (reading) await new Promise((resolve) => setTimeout(resolve, 10))
	sinkSnapshot = await readSink()
	api.kill()
	const finalSink = sinkSnapshot
	const mibOf = (value: number) => Math.round((value / mib) * 10) / 10
	const max = (key: 'nodeRss' | 'workerdRss') =>
		samples.reduce((peak, sample) => Math.max(peak, sample[key]), 0)
	const progress = [0.1, 0.25, 0.5, 0.75, 0.9, 1].map((fraction) => {
		const target = totalBytes * fraction
		const sample =
			samples.find((entry) => entry.sinkBytes >= target) ?? samples.at(-1)
		return {
			fraction,
			sinkMiB: mibOf(sample?.sinkBytes ?? 0),
			nodeRssMiB: mibOf(sample?.nodeRss ?? 0),
			workerdRssMiB: mibOf(sample?.workerdRss ?? 0),
		}
	})
	const ok =
		!runError &&
		!budgetExceeded &&
		finalSink.received === totalBytes &&
		finalSink.digest === expected
	const summary = {
		ok,
		config: {
			totalBytes,
			chunkBytes,
			body: flags.body,
			kind: flags.kind,
			unauthorizedEvery,
			consume: flags.consume,
			resolution: flags.resolution,
			resumeBody: flags['resume-body'],
			workerdBudgetMiB: Number(flags['workerd-budget-mib']),
		},
		durationMs: Date.now() - started,
		runError,
		budgetExceeded,
		run:
			(result as { structuredContent?: unknown; content?: unknown } | undefined)
				?.structuredContent ??
			(result as { content?: unknown } | undefined)?.content ??
			null,
		sink: {
			bytes: finalSink.received,
			sha256: finalSink.digest,
			expectedSha256: expected,
			...finalSink.stats,
			rejected: finalSink.stats.rejected.slice(0, 5),
		},
		rss: {
			nodePeakMiB: mibOf(max('nodeRss')),
			workerdPeakMiB: mibOf(max('workerdRss')),
			workerdHwmMiB: mibOf(workerdHwm),
			progress,
		},
	}
	const text = JSON.stringify(summary, null, 2)
	if (flags.out) writeFileSync(flags.out, `${text}\n`)
	console.log(text)
	process.exitCode = ok ? 0 : 1
}

async function serveApi() {
	const server = createServer((request, response) => {
		handleApi(request, response).catch((error: unknown) => {
			response.writeHead(500)
			response.end(error instanceof Error ? error.name : 'error')
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	process.on('message', () => {
		process.send?.({
			received: sink.received,
			digest: sink.digest,
			stats: sink.stats,
		})
	})
	process.send?.({
		apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	})
}

if (flags.role === 'api') await serveApi()
else await main()

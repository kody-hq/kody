import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runCli } from '../src/cli.js'
import { egressPolicyFromGrant } from '../src/local-egress.js'
import { reapLeftoverWorkers } from '../src/execution-context/worker-tracker.js'
import {
	buildLocalExecuteResult,
	hasSavedPackageImports,
	localExecutePackageGraphResolveStatus,
	runLocalExecute,
	savedPackageImportLocalResolveStatus,
} from '../src/local-execute.js'
import {
	createLocalEntrySource,
	createLocalRuntimeModuleSource,
	createWorkerdConfig,
} from '../src/local-runtime-source.js'
import {
	localExecuteGatewayFetchShimModuleName,
	localPackageGraphPath,
	localPackageGraphPlatformIssueUrl,
} from '../src/local-package-graph.js'

const gatewayFetchShimModule = {
	name: localExecuteGatewayFetchShimModuleName,
	esModule: 'export {}\n',
}

const goodToken = 'kody_tok_good'

test('workerd network access is public-only by default and keeps the loopback bridge', () => {
	const config = createWorkerdConfig({
		bridgePort: 4321,
		files: { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' },
	})
	assert.match(config, /allow = \["public"\]/)
	assert.match(config, /address = "127\.0\.0\.1:4321"/)
	assert.doesNotMatch(config, /allow = \["public", "private", "local"\]/)
	assert.match(config, /name = "\.__kody_runtime__\.js"/)

	const privateNetworkConfig = createWorkerdConfig({
		bridgePort: 4321,
		files: { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' },
		allowPrivateNetwork: true,
	})
	assert.match(privateNetworkConfig, /allow = \["public", "private", "local"\]/)
	assert.match(privateNetworkConfig, /address = "127\.0\.0\.1:4321"/)
})

type ProxyRequest = {
	method: string
	url: string
	authorization: string | null
	body: unknown
}

const proxyRequests: Array<ProxyRequest> = []
let sessionStatus: { status: number; body: unknown } = {
	status: 200,
	body: {
		scopes: ['capability-proxy'],
		expiresAt: null,
		features: ['credential-call-map'],
	},
}
let packageGraphStatus: { status: number; body: unknown } | null = null
let apiUrl = ''
let server: Server

before(async () => {
	server = createServer(async (request, response) => {
		const send = (status: number, payload: unknown) => {
			response.writeHead(status, { 'content-type': 'application/json' })
			response.end(JSON.stringify(payload))
		}
		const isGatewayFetch = request.url === '/v1/capability-proxy/gateway-fetch'
		const chunks: Array<Buffer> = []
		for await (const chunk of request) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
		}
		const raw = Buffer.concat(chunks).toString('utf8')
		const body = isGatewayFetch
			? {
					gatewayUrl: request.headers['x-kody-gateway-url'] ?? null,
					gatewayMethod: request.headers['x-kody-gateway-method'] ?? null,
					gatewayHeaders: request.headers['x-kody-gateway-headers'] ?? null,
					contentType: request.headers['content-type'] ?? null,
					rawBody: raw,
				}
			: raw
				? JSON.parse(raw)
				: null
		proxyRequests.push({
			method: request.method ?? '',
			url: request.url ?? '',
			authorization: request.headers.authorization ?? null,
			body,
		})
		if (request.headers.authorization !== `Bearer ${goodToken}`) {
			send(401, { error: { code: 'invalid_token', message: 'unknown token' } })
			return
		}
		if (isGatewayFetch) {
			response.writeHead(201, {
				'content-type': 'text/plain',
				'x-upstream': 'streamed',
			})
			response.end(`echo:${raw}`)
			return
		}
		if (request.url === '/v1/capability-proxy/session') {
			send(sessionStatus.status, sessionStatus.body)
			return
		}
		if (request.url === '/v1/capability-proxy/call') {
			const { path, args, credentials } = body as {
				path: Array<string>
				args: Array<unknown>
				credentials?: Record<string, unknown>
			}
			if (path.join('.') === 'kody.explode') {
				send(200, {
					error: { code: 'capability_failed', message: 'explode is broken' },
				})
				return
			}
			if (path.join('.') === 'kody.credentialClientCheck') {
				send(200, {
					result: {
						ok: true,
						value: {
							warnings: [],
							checked: credentials ?? null,
							strict:
								(args[0] as { strict?: boolean } | undefined)?.strict === true,
						},
					},
				})
				return
			}
			if (
				path.join('.') === 'kody.credentialClientOpen' ||
				path.join('.') === 'kody.credentialClientOpenAll'
			) {
				// Origin returns metadata + opaque handle only — never a secret value.
				const opened = {
					handle: 'kch1.test-handle',
					key: (args[0] as { key?: string } | undefined)?.key ?? null,
					name:
						typeof credentials?.resend === 'string'
							? credentials.resend
							: 'resend',
					scope: 'personal',
					kind: 'secret',
					hosts: ['api.resend.com'],
				}
				send(200, {
					result: {
						ok: true,
						value:
							path.join('.') === 'kody.credentialClientOpenAll'
								? [opened]
								: opened,
					},
				})
				return
			}
			send(200, { result: { echoed: path.join('.'), args } })
			return
		}
		if (request.url === `/${localPackageGraphPath}`) {
			if (packageGraphStatus) {
				send(packageGraphStatus.status, packageGraphStatus.body)
				return
			}
			const payload = body as { code?: string; imports?: Array<string> }
			const imports = payload.imports ?? []
			if (imports.some((specifier) => specifier.includes('@missing/'))) {
				send(422, {
					error: {
						code: 'package_import_unresolved',
						message:
							'Could not resolve saved package import kody:@missing/package/export.',
					},
				})
				return
			}
			if (imports.includes('kody:@test/pkg/hello')) {
				send(200, {
					imports: ['kody:@test/pkg/hello'],
					warnings: [],
					modules: [
						{
							name: 'kody:@test/pkg/hello',
							esModule: `export function greet(name) {
	return { hello: name, fromPackage: true }
}
export default greet
`,
						},
						gatewayFetchShimModule,
					],
				})
				return
			}
			// Origin always returns the gateway-fetch shim, including when the
			// entry has no kody:@ imports (kody-hq/kody#3020).
			if (imports.length === 0) {
				send(200, {
					imports: [],
					warnings: [],
					modules: [gatewayFetchShimModule],
				})
				return
			}
			send(404, {
				error: { code: 'not_found', message: 'package-graph not deployed' },
			})
			return
		}
		send(404, { error: 'not found' })
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
	server.closeAllConnections()
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

const hangAfterPing = `import { kody } from 'kody:runtime'
export default async function main() {
	await kody.ping({})
	return await new Promise((resolve) => setTimeout(resolve, 600_000))
}`

async function waitFor<T>(
	label: string,
	check: () => T | null | undefined,
): Promise<T> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const value = check()
		if (value != null) return value
		await delay(100)
	}
	throw new Error(`Timed out waiting for ${label}`)
}

/** os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows. */
function tmpEnv(dir: string) {
	return { TMPDIR: dir, TEMP: dir, TMP: dir }
}

function workerdPidUnder(dir: string): number | null {
	const listing =
		process.platform === 'win32'
			? execFileSync(
					'powershell.exe',
					[
						'-NoProfile',
						'-Command',
						`Get-CimInstance Win32_Process -Filter "Name='workerd.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`,
					],
					{ encoding: 'utf8' },
				)
			: execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
	for (const line of listing.split('\n')) {
		if (line.includes('workerd') && line.includes(dir))
			return Number(line.trim().split(/\s+/)[0])
	}
	return null
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function reset() {
	proxyRequests.length = 0
	sessionStatus = {
		status: 200,
		body: {
			scopes: ['capability-proxy'],
			expiresAt: null,
			features: ['credential-call-map'],
		},
	}
	packageGraphStatus = null
}

test('hasSavedPackageImports detects static and dynamic kody:@ imports', async () => {
	assert.equal(
		await hasSavedPackageImports(`import skill from 'kody:@me/skills/get'`),
		true,
	)
	assert.equal(
		await hasSavedPackageImports(
			`const m = await import("kody:@me/skills/get")`,
		),
		true,
	)
	assert.equal(
		await hasSavedPackageImports(`import { kody } from 'kody:runtime'`),
		false,
	)
})

test('createLocalEntrySource side-effect imports the gateway-fetch shim before user code', () => {
	const source = createLocalEntrySource({
		sideEffectModules: [localExecuteGatewayFetchShimModuleName],
	})
	assert.match(
		source,
		new RegExp(
			`^import ${JSON.stringify(localExecuteGatewayFetchShimModuleName)};`,
		),
	)
	assert.match(source, /import\(\s*"\.\/main\.js"\s*\)/)
})

test(
	'runLocalExecute with kody:@ imports bundles package modules into local workerd',
	{ timeout: 180_000 },
	async () => {
		reset()
		const statuses: Array<string> = []
		const code = `import { greet } from 'kody:@test/pkg/hello'
export default async function main(params) {
	return greet(params.name)
}`
		const result = await runLocalExecute({
			code,
			params: { name: 'kent' },
			conversationId: 'conv-pkg',
			token: goodToken,
			apiUrl,
			onStatus: (message) => statuses.push(message),
		})
		assert.equal(result.isError, false)
		assert.ok(statuses.includes(savedPackageImportLocalResolveStatus))
		assert.deepEqual((result.structuredContent as { result: unknown }).result, {
			hello: 'kent',
			fromPackage: true,
		})
		assert.equal(proxyRequests[0]?.url, `/${localPackageGraphPath}`)
		assert.equal(
			proxyRequests.some(
				(request) => request.url === `/${localPackageGraphPath}`,
			),
			true,
		)
		assert.equal(
			proxyRequests.every((request) => {
				if (request.url !== '/v1/capability-proxy/call') return true
				const path = (request.body as { path?: Array<string> } | null)?.path
				return !(Array.isArray(path) && path.join('.') === 'kody.execute')
			}),
			true,
			'must not hop the whole module to CapabilityProxy kody.execute',
		)
	},
)

test(
	'runLocalExecute with kody:@ imports fails clearly when the package cannot be resolved',
	{ timeout: 60_000 },
	async () => {
		reset()
		const code = `import missing from 'kody:@missing/package/export'
export default async function main() { return missing({}) }`
		await assert.rejects(
			() =>
				runLocalExecute({
					code,
					token: goodToken,
					apiUrl,
					workerdPath: '/nonexistent/workerd',
				}),
			/Could not resolve saved package import kody:@missing\/package\/export/,
		)
		assert.equal(
			proxyRequests.some(
				(request) => request.url === '/v1/capability-proxy/call',
			),
			false,
		)
	},
)

test(
	'runLocalExecute with kody:@ imports fails clearly when package-graph API is missing',
	{ timeout: 60_000 },
	async () => {
		reset()
		const code = `import x from 'kody:@other/pkg/export'
export default async function main() { return x }`
		await assert.rejects(
			() =>
				runLocalExecute({
					code,
					token: goodToken,
					apiUrl,
					workerdPath: '/nonexistent/workerd',
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error)
				assert.match(
					error.message,
					/will not silently fall back to cloud kody\.execute/,
				)
				assert.match(
					error.message,
					new RegExp(localPackageGraphPlatformIssueUrl.replace(/\./g, '\\.')),
				)
				return true
			},
		)
	},
)

test('buildLocalExecuteResult matches the cloud execute envelope', () => {
	const startedAt = new Date('2026-09-30T00:00:00.000Z')
	const endedAt = new Date('2026-09-30T00:00:00.250Z')
	assert.deepEqual(
		buildLocalExecuteResult({
			sandbox: { result: { ok: true }, logs: ['hi'] },
			startedAt,
			endedAt,
		}),
		{
			content: [{ type: 'text', text: '{\n  "ok": true\n}' }],
			structuredContent: {
				timing: {
					startedAt: '2026-09-30T00:00:00.000Z',
					endedAt: '2026-09-30T00:00:00.250Z',
					durationMs: 250,
				},
				returnedBytes: 11,
				result: { ok: true },
				logs: ['hi'],
			},
			isError: false,
		},
	)
	const failed = buildLocalExecuteResult({
		sandbox: { error: 'boom', logs: [] },
		startedAt,
		endedAt,
		conversationId: 'conv-1',
	})
	assert.equal(failed.isError, true)
	assert.deepEqual(failed.content, [{ type: 'text', text: 'Error: boom' }])
	assert.deepEqual(failed.structuredContent, {
		conversationId: 'conv-1',
		timing: {
			startedAt: '2026-09-30T00:00:00.000Z',
			endedAt: '2026-09-30T00:00:00.250Z',
			durationMs: 250,
		},
		returnedBytes: 0,
		error: 'boom',
		logs: [],
	})
	const text = buildLocalExecuteResult({
		sandbox: { result: 'hé' },
		startedAt,
		endedAt,
	})
	assert.deepEqual(text.content, [{ type: 'text', text: 'hé' }])
	assert.equal(
		(text.structuredContent as { returnedBytes: number }).returnedBytes,
		3,
	)
})

test(
	'runLocalExecute runs the module in workerd and proxies kody:runtime calls with the token',
	{ timeout: 180_000 },
	async () => {
		reset()
		const code = `
import { kody, workflows, packages, email } from 'kody:runtime'
export default async function main(params) {
	console.log('hello', params.name)
	console.warn('careful')
	const sent = await kody.emailSend({ to: params.name })
	const light = await kody.mcp.home.lights_on({ room: 'office' })
	const run = await workflows.create({ code: 'x' })
	let failure = null
	try {
		await kody.explode({})
	} catch (error) {
		failure = error.message
	}
	return { sent, light, run, packages, failure, email }
}
`
		const result = await runLocalExecute({
			code,
			params: { name: 'kent' },
			conversationId: 'conv-local',
			token: goodToken,
			apiUrl,
		})
		assert.equal(result.isError, false)
		const structured = result.structuredContent as Record<string, unknown>
		assert.deepEqual(structured.result, {
			sent: { echoed: 'kody.emailSend', args: [{ to: 'kent' }] },
			light: { echoed: 'kody.mcp.home.lights_on', args: [{ room: 'office' }] },
			run: { echoed: 'workflows.create', args: [{ code: 'x' }] },
			packages: null,
			failure: 'explode is broken',
			email: null,
		})
		assert.deepEqual(structured.logs, ['hello kent', '[warn] careful'])
		assert.equal(structured.conversationId, 'conv-local')
		assert.equal(proxyRequests[0]?.url, `/${localPackageGraphPath}`)
		assert.equal(proxyRequests.length, 5)
		for (const request of proxyRequests) {
			assert.equal(request.authorization, `Bearer ${goodToken}`)
		}
		assert.deepEqual(proxyRequests[1]?.body, {
			path: ['kody', 'emailSend'],
			args: [{ to: 'kent' }],
			conversationId: 'conv-local',
		})
	},
)

test('runLocalExecute returns cancelled without setup work when its signal is already aborted', async () => {
	reset()
	const abort = new AbortController()
	abort.abort()
	const result = await runLocalExecute({
		code: 'export default () => 1',
		token: goodToken,
		apiUrl,
		workerdPath: join(tmpdir(), 'missing-workerd-binary'),
		signal: abort.signal,
	})
	assert.equal(result.isError, true)
	const structured = result.structuredContent as Record<string, unknown>
	assert.match(String(structured.error), /cancelled/)
	assert.equal(proxyRequests.length, 0)
})

test(
	'runLocalExecute stops workerd when its signal aborts mid-run',
	{ timeout: 180_000 },
	async () => {
		reset()
		const abort = new AbortController()
		const code = `
export default async function main() {
	await new Promise((resolve) => setTimeout(resolve, 120_000))
	return 'finished'
}
`
		const startedAt = Date.now()
		const running = runLocalExecute({
			code,
			token: goodToken,
			apiUrl,
			signal: abort.signal,
		})
		setTimeout(() => abort.abort(), 3_000)
		const result = await running
		assert.equal(result.isError, true)
		const structured = result.structuredContent as Record<string, unknown>
		assert.match(String(structured.error), /cancelled/)
		assert.ok(Date.now() - startedAt < 60_000)
	},
)

test('createLocalRuntimeModuleSource exports credential and credentials for ad hoc local execute', () => {
	const source = createLocalRuntimeModuleSource()
	assert.match(
		source,
		/export const credential = __kodyCredentialRuntime\.credential/,
	)
	assert.match(
		source,
		/export const credentials = __kodyCredentialRuntime\.credentials/,
	)
	assert.match(source, /x-kody-credential-client/)
	assert.match(source, /credentialClientOpen/)
	assert.match(source, /credentialClientOpenAll/)
	assert.match(source, /opened\.hint/)
	// Secret values stay on origin: the host only hops tool names + opaque handles.
	assert.doesNotMatch(source, /secretValue|plaintext|apiKeyValue/)
	assert.match(source, /credential,\s*credentials,/s)
})

test('ad-hoc local host CAF does not send packageId (unbound)', () => {
	const source = createLocalRuntimeModuleSource()
	const cafStart = source.indexOf(
		'export async function createAuthenticatedFetch',
	)
	assert.ok(cafStart >= 0)
	const cafEnd = source.indexOf('export const secretHeaders', cafStart)
	assert.ok(cafEnd > cafStart)
	const caf = source.slice(cafStart, cafEnd)
	assert.match(caf, /authenticatedFetch/)
	assert.doesNotMatch(caf, /packageId/)
	assert.doesNotMatch(source, /kpb1\./)
	assert.doesNotMatch(source, /__kodyPackageBinding/)
})

test('createLocalRuntimeModuleSource implements kody.gatewayFetchStream as a host method', () => {
	const source = createLocalRuntimeModuleSource()
	assert.match(source, /async function gatewayFetchStream/)
	assert.match(source, /property === 'gatewayFetchStream'/)
	assert.match(source, /X-Kody-Gateway-Url/)
	assert.match(createLocalEntrySource(), /gateway-fetch/)
})

test(
	'runLocalExecute kody.gatewayFetchStream hops POST /v1/capability-proxy/gateway-fetch and returns a Response',
	{ timeout: 180_000 },
	async () => {
		reset()
		const code = `
import { kody } from 'kody:runtime'
export default async function main() {
	const response = await kody.gatewayFetchStream({
		packageId: 'pkg-stream',
		request: {
			url: 'https://api.example.com/upload',
			method: 'POST',
			headers: {
				authorization: 'Bearer {{secret:demoToken|scope=user}}',
				'content-type': 'text/plain',
			},
			body: 'stream-body-bytes',
		},
	})
	return {
		status: response.status,
		text: await response.text(),
		upstream: response.headers.get('x-upstream'),
		typeofGatewayFetchStream: typeof kody.gatewayFetchStream,
	}
}
`
		const result = await runLocalExecute({
			code,
			token: goodToken,
			apiUrl,
		})
		assert.equal(result.isError, false, JSON.stringify(result))
		const structured = result.structuredContent as {
			result: {
				status: number
				text: string
				upstream: string | null
				typeofGatewayFetchStream: string
			}
		}
		assert.equal(structured.result.typeofGatewayFetchStream, 'function')
		assert.equal(structured.result.status, 201)
		assert.equal(structured.result.text, 'echo:stream-body-bytes')
		assert.equal(structured.result.upstream, 'streamed')
		const hop = proxyRequests.find(
			(entry) => entry.url === '/v1/capability-proxy/gateway-fetch',
		)
		assert.ok(hop)
		assert.equal(hop?.authorization, `Bearer ${goodToken}`)
		assert.deepEqual(hop?.body, {
			gatewayUrl: 'https://api.example.com/upload',
			gatewayMethod: 'POST',
			gatewayHeaders: JSON.stringify({
				authorization: 'Bearer {{secret:demoToken|scope=user}}',
			}),
			contentType: 'text/plain',
			rawBody: 'stream-body-bytes',
		})
		assert.equal(
			proxyRequests.some(
				(entry) =>
					entry.url === '/v1/capability-proxy/call' &&
					(entry.body as { path?: Array<string> } | null)?.path?.join('.') ===
						'kody.gatewayFetchStream',
			),
			false,
			'gatewayFetchStream must not use the JSON /call hop',
		)
	},
)

test(
	'runLocalExecute exposes credential() on kody:runtime and hops credentialClientOpen without secret values',
	{ timeout: 180_000 },
	async () => {
		reset()
		const code = `
import { credential, credentials } from 'kody:runtime'
export default async function main() {
	const opened = await credential('resend')
	const listed = await credentials('resend')
	return {
		typeofCredential: typeof credential,
		typeofNamed: typeof credential.named,
		typeofFetch: typeof opened.fetch,
		name: opened.name,
		kind: opened.kind,
		scope: opened.scope,
		hosts: opened.hosts,
		listedCount: listed.length,
		listedName: listed[0]?.name ?? null,
		ownKeys: Reflect.ownKeys(opened).map(String).sort(),
	}
}
`
		const result = await runLocalExecute({
			code,
			token: goodToken,
			apiUrl,
		})
		assert.equal(result.isError, false)
		const structured = result.structuredContent as {
			result: {
				typeofCredential: string
				typeofNamed: string
				typeofFetch: string
				name: string
				kind: string
				scope: string
				hosts: Array<string>
				listedCount: number
				listedName: string | null
				ownKeys: Array<string>
			}
		}
		assert.equal(structured.result.typeofCredential, 'function')
		assert.equal(structured.result.typeofNamed, 'function')
		assert.equal(structured.result.typeofFetch, 'function')
		assert.equal(structured.result.name, 'resend')
		assert.equal(structured.result.kind, 'secret')
		assert.equal(structured.result.scope, 'personal')
		assert.deepEqual(structured.result.hosts, ['api.resend.com'])
		assert.equal(structured.result.listedCount, 1)
		assert.equal(structured.result.listedName, 'resend')
		// Client enumerates metadata only — never a handle or secret value.
		assert.deepEqual(structured.result.ownKeys, [
			'fetch',
			'hosts',
			'kind',
			'name',
			'scope',
		])
		const openCall = proxyRequests.find(
			(request) =>
				request.url === '/v1/capability-proxy/call' &&
				Array.isArray((request.body as { path?: unknown })?.path) &&
				(request.body as { path: Array<string> }).path.join('.') ===
					'kody.credentialClientOpen',
		)
		assert.ok(openCall)
		assert.deepEqual(openCall?.body, {
			path: ['kody', 'credentialClientOpen'],
			args: [{ key: 'resend' }],
		})
		const openAllCall = proxyRequests.find(
			(request) =>
				request.url === '/v1/capability-proxy/call' &&
				Array.isArray((request.body as { path?: unknown })?.path) &&
				(request.body as { path: Array<string> }).path.join('.') ===
					'kody.credentialClientOpenAll',
		)
		assert.ok(openAllCall)
		assert.deepEqual(openAllCall?.body, {
			path: ['kody', 'credentialClientOpenAll'],
			args: [{ key: 'resend' }],
		})
		const serialized = JSON.stringify(proxyRequests)
		assert.equal(serialized.includes('sk_live'), false)
		assert.equal(serialized.includes('secret-value'), false)
	},
)

test(
	'runLocalExecute preflights --credential and attaches the map outside args',
	{ timeout: 180_000 },
	async () => {
		reset()
		const code = `
import { credential } from 'kody:runtime'
export default async function main() {
	const opened = await credential('resend')
	return { name: opened.name }
}
`
		const result = await runLocalExecute({
			code,
			token: goodToken,
			apiUrl,
			credentials: { resend: 'prod' },
		})
		assert.equal(result.isError, false)
		const structured = result.structuredContent as { result: { name: string } }
		assert.equal(structured.result.name, 'prod')
		const checkCall = proxyRequests.find(
			(request) =>
				request.url === '/v1/capability-proxy/call' &&
				Array.isArray((request.body as { path?: unknown })?.path) &&
				(request.body as { path: Array<string> }).path.join('.') ===
					'kody.credentialClientCheck',
		)
		assert.ok(checkCall)
		assert.deepEqual(checkCall?.body, {
			path: ['kody', 'credentialClientCheck'],
			args: [{}],
			credentials: { resend: 'prod' },
		})
		const openCall = proxyRequests.find(
			(request) =>
				request.url === '/v1/capability-proxy/call' &&
				Array.isArray((request.body as { path?: unknown })?.path) &&
				(request.body as { path: Array<string> }).path.join('.') ===
					'kody.credentialClientOpen',
		)
		assert.ok(openCall)
		assert.deepEqual(openCall?.body, {
			path: ['kody', 'credentialClientOpen'],
			args: [{ key: 'resend' }],
			credentials: { resend: 'prod' },
		})
	},
)

test(
	'runLocalExecute refuses --credential when the session lacks credential-call-map',
	{ timeout: 180_000 },
	async () => {
		reset()
		sessionStatus = {
			status: 200,
			body: { scopes: ['capability-proxy'], expiresAt: null, features: [] },
		}
		await assert.rejects(
			() =>
				runLocalExecute({
					code: 'export default () => ({ ok: true })',
					token: goodToken,
					apiUrl,
					credentials: { github: 'work' },
				}),
			/This Kody host does not support --credential yet\./,
		)
	},
)

test(
	'runLocalExecute always fetches package-graph for Bearer secret placeholders with no kody:@ imports',
	{ timeout: 180_000 },
	async () => {
		reset()
		const statuses: Array<string> = []
		// Keep the Bearer {{secret:…}} shape in-source (kody-hq/kody#3020) but
		// do not fetch outbound — this asserts CLI wiring only (always call
		// package-graph + side-effect import the returned shim). Origin expands
		// or fails closed once the real shim wraps globalThis.fetch.
		const code = `export default async function main() {
	const authorization = 'Bearer {{secret:cloudflarePagesApiToken}}'
	return { authorization }
}`
		const result = await runLocalExecute({
			code,
			token: goodToken,
			apiUrl,
			onStatus: (message) => statuses.push(message),
		})
		assert.equal(result.isError, false)
		assert.ok(statuses.includes(localExecutePackageGraphResolveStatus))
		assert.equal(
			proxyRequests.some(
				(request) => request.url === `/${localPackageGraphPath}`,
			),
			true,
		)
		const graphRequest = proxyRequests.find(
			(request) => request.url === `/${localPackageGraphPath}`,
		)
		assert.deepEqual(
			(graphRequest?.body as { imports?: Array<string> } | null)?.imports,
			[],
		)
		assert.deepEqual((result.structuredContent as { result: unknown }).result, {
			authorization: 'Bearer {{secret:cloudflarePagesApiToken}}',
		})
	},
)

test(
	'runLocalExecute reports module errors like cloud execute',
	{ timeout: 180_000 },
	async () => {
		reset()
		const thrown = await runLocalExecute({
			code: `export default async function main() { console.error('bad'); throw new Error('boom') }`,
			token: goodToken,
			apiUrl,
		})
		assert.equal(thrown.isError, true)
		assert.deepEqual(thrown.content, [{ type: 'text', text: 'Error: boom' }])
		assert.deepEqual((thrown.structuredContent as { logs: unknown }).logs, [
			'[error] bad',
		])

		const noDefault = await runLocalExecute({
			code: 'export const value = 1',
			token: goodToken,
			apiUrl,
		})
		assert.deepEqual(noDefault.content, [
			{
				type: 'text',
				text: 'Error: Kody execute modules must default export a function.',
			},
		])

		const syntaxError = await runLocalExecute({
			code: 'export default () => {',
			token: goodToken,
			apiUrl,
		})
		assert.equal(syntaxError.isError, true)
		assert.match(
			String(syntaxError.content[0]?.text),
			/^Error: Local execute could not load the module \(workerd exit 1\)\n[\s\S]*SyntaxError/,
		)
	},
)

test('runLocalExecute rejects unresolvable --file imports before any network call', async () => {
	reset()
	const dir = mkdtempSync(join(tmpdir(), 'kody-unresolvable-'))
	const file = join(dir, 'entry.mjs')
	writeFileSync(
		file,
		`import { missing } from './nope.js'
export default () => missing
`,
	)
	await assert.rejects(
		() =>
			runLocalExecute({
				code: 'unused — bundler reads modulePath',
				modulePath: file,
				token: goodToken,
				apiUrl,
				workerdPath: '/nonexistent/workerd',
			}),
		(error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /Could not bundle .+entry\.mjs\./)
			assert.match(error.message, /Could not resolve|nope\.js/i)
			return true
		},
	)
	assert.equal(proxyRequests.length, 0)
})

test(
	'kody execute --local --file bundles relative imports and TypeScript before workerd',
	{ timeout: 180_000 },
	async () => {
		reset()
		const dir = mkdtempSync(join(tmpdir(), 'kody-bundle-file-'))
		writeFileSync(
			join(dir, 'helper.ts'),
			`export function pick(p: { a?: string }): string {
	return p.a ?? 'fallback'
}
`,
		)
		const file = join(dir, 'x.ts')
		writeFileSync(
			file,
			`import { pick } from './helper.js'
export default async function main(p: { a?: string }) {
	const value: string = pick(p)
	return { value }
}
`,
		)
		let stdout = ''
		let stderr = ''
		const code = await runCli(
			[
				'execute',
				'--local',
				'--token',
				goodToken,
				'--mcp-url',
				`${apiUrl}/mcp`,
				'--api-url',
				apiUrl,
				'--params',
				'{"a":"kept"}',
				'--file',
				file,
			],
			{
				stdout: (text) => (stdout += text),
				stderr: (text) => (stderr += text),
			},
		)
		assert.equal(code, 0, stderr)
		assert.deepEqual(JSON.parse(stdout), { value: 'kept' })
	},
)

test('runLocalExecute stops before starting workerd when the token or flag is rejected', async () => {
	reset()
	const neverRuns = '/nonexistent/workerd'
	await assert.rejects(
		() =>
			runLocalExecute({
				code: 'export default () => 1',
				token: 'kody_at_revoked',
				apiUrl,
				workerdPath: neverRuns,
			}),
		(error: Error) => {
			assert.match(
				error.message,
				/rejected the API token \(expired, revoked, or malformed\)/,
			)
			assert.match(error.message, /cliCredentialBootstrap/)
			assert.match(error.message, /cli_command/)
			assert.match(error.message, /never ask a human to paste a token/)
			assert.match(error.message, /kody login/)
			assert.match(
				error.message,
				/unset or replace that rejected value before retrying/,
			)
			return true
		},
	)
	packageGraphStatus = {
		status: 403,
		body: {
			error: { code: 'feature_disabled', message: 'local-execute is off' },
		},
	}
	await assert.rejects(
		() =>
			runLocalExecute({
				code: 'export default () => 1',
				token: goodToken,
				apiUrl,
				workerdPath: neverRuns,
			}),
		/feature flag `local-execute`/,
	)
	packageGraphStatus = {
		status: 403,
		body: { error: { code: 'forbidden', message: 'token cannot execute' } },
	}
	await assert.rejects(
		() =>
			runLocalExecute({
				code: 'export default () => 1',
				token: goodToken,
				apiUrl,
				workerdPath: neverRuns,
			}),
		(error: Error) => {
			assert.match(
				error.message,
				/not allowed to use CapabilityProxy \(forbidden\)/,
			)
			assert.match(
				error.message,
				/cliCredentialBootstrap|auth bootstrap|tokenCreate/,
			)
			assert.equal(error.message.includes('saved package import'), false)
			return true
		},
	)
	assert.equal(proxyRequests.length, 3)
	assert.ok(
		proxyRequests.every(
			(request) => request.url === `/${localPackageGraphPath}`,
		),
	)
})

test(
	'kody execute --local with --token never requires MCP login',
	{ timeout: 180_000 },
	async () => {
		reset()
		const previousMcpUrl = process.env.KODY_MCP_URL
		process.env.KODY_MCP_URL = 'http://127.0.0.1:9/unreachable-mcp'
		let stdout = ''
		let stderr = ''
		try {
			const code = await runCli(
				[
					'execute',
					'--local',
					'--token',
					goodToken,
					'--api-url',
					apiUrl,
					'--params',
					'{"to":"me@example.com"}',
					'--code',
					"import { kody } from 'kody:runtime'\nexport default (params) => kody.emailSend(params)",
				],
				{
					stdout: (text) => (stdout += text),
					stderr: (text) => (stderr += text),
				},
			)
			assert.equal(code, 0, stderr)
		} finally {
			if (previousMcpUrl === undefined) delete process.env.KODY_MCP_URL
			else process.env.KODY_MCP_URL = previousMcpUrl
		}
		assert.deepEqual(JSON.parse(stdout), {
			echoed: 'kody.emailSend',
			args: [{ to: 'me@example.com' }],
		})
		assert.equal(stdout.includes(goodToken), false)
	},
)

test(
	'runLocalExecute surfaces a workerd crash mid-run and cleans up',
	{ timeout: 180_000 },
	async () => {
		reset()
		const scratch = mkdtempSync(join(tmpdir(), 'kody-crash-'))
		const tmpKeys = Object.keys(tmpEnv(scratch)) as Array<'TMPDIR'>
		const previousTmp = tmpKeys.map((key) => process.env[key])
		Object.assign(process.env, tmpEnv(scratch))
		const abort = new AbortController()
		try {
			const run = runLocalExecute({
				code: hangAfterPing,
				token: goodToken,
				apiUrl,
				signal: abort.signal,
			})
			await waitFor('the module to start', () =>
				proxyRequests.some(
					(request) => request.url === '/v1/capability-proxy/call',
				)
					? true
					: null,
			)
			process.kill(
				await waitFor('workerd', () => workerdPidUnder(scratch)),
				'SIGKILL',
			)
			await assert.rejects(
				run,
				// Windows TerminateProcess reports exit code 1, not a signal.
				process.platform === 'win32'
					? /workerd exited during the run \(workerd exit 1\)/
					: /workerd exited during the run \(workerd exit SIGKILL\)/,
			)
		} finally {
			abort.abort()
			tmpKeys.forEach((key, index) => {
				const previous = previousTmp[index]
				if (previous === undefined) delete process.env[key]
				else process.env[key] = previous
			})
		}
		assert.deepEqual(readdirSync(scratch), [])
	},
)

test(
	'SIGTERM during kody execute --local stops workerd and removes the module',
	{
		timeout: 180_000,
		// Windows has no SIGTERM delivery: kill() is TerminateProcess, so the
		// SIGKILL reap test below covers it (the desktop stops in-process).
		skip:
			process.platform === 'win32'
				? 'Windows cannot deliver SIGTERM to another process'
				: false,
	},
	async () => {
		reset()
		const scratch = mkdtempSync(join(tmpdir(), 'kody-signal-'))
		const cli = spawn(
			process.execPath,
			[
				'--import',
				'tsx',
				'src/bin.ts',
				'execute',
				'--local',
				'--mcp-url',
				`${apiUrl}/mcp`,
				'--api-url',
				apiUrl,
				'--code',
				hangAfterPing,
			],
			{
				env: {
					...process.env,
					...tmpEnv(scratch),
					KODY_API_TOKEN: goodToken,
				},
				stdio: 'ignore',
			},
		)
		const exited = new Promise<NodeJS.Signals | null>((resolve) =>
			cli.once('exit', (_code, signal) => resolve(signal)),
		)
		await waitFor('the module to start', () =>
			proxyRequests.some(
				(request) => request.url === '/v1/capability-proxy/call',
			)
				? true
				: null,
		)
		const workerdPid = await waitFor('workerd', () => workerdPidUnder(scratch))
		cli.kill('SIGTERM')
		assert.equal(await exited, 'SIGTERM')
		await waitFor('workerd to stop', () =>
			isRunning(workerdPid) ? null : true,
		)
		assert.deepEqual(
			readdirSync(scratch).filter((entry) => entry.startsWith('kody-local-')),
			[],
		)
	},
)

test(
	'a SIGKILLed daemon leaves a tracked workerd that the next daemon reaps',
	{ timeout: 180_000 },
	async () => {
		reset()
		const scratch = mkdtempSync(join(tmpdir(), 'kody-daemon-kill-'))
		const workersDir = join(scratch, 'workers')
		const src = (path: string) =>
			// ESM import specifiers must be file URLs (a bare C:\\ path fails).
			JSON.stringify(new URL(`../src/${path}`, import.meta.url).href)
		const script = `
import { runLocalExecute } from ${src('local-execute.ts')}
import { createLocalWorkerTracker } from ${src('execution-context/worker-tracker.ts')}
await runLocalExecute({
	code: ${JSON.stringify(hangAfterPing)},
	token: ${JSON.stringify(goodToken)},
	apiUrl: ${JSON.stringify(apiUrl)},
	workerTracker: createLocalWorkerTracker(${JSON.stringify(workersDir)}),
})
`
		const daemon = spawn(
			process.execPath,
			['--import', 'tsx', '--input-type=module', '-e', script],
			{ env: { ...process.env, ...tmpEnv(scratch) }, stdio: 'ignore' },
		)
		const exited = new Promise((resolve) => daemon.once('exit', resolve))
		await waitFor('the module to start', () =>
			proxyRequests.some(
				(request) => request.url === '/v1/capability-proxy/call',
			)
				? true
				: null,
		)
		const workerdPid = await waitFor('workerd', () => workerdPidUnder(scratch))
		daemon.kill('SIGKILL')
		await exited
		await delay(500)
		assert.deepEqual(readdirSync(workersDir), [`${workerdPid}.json`])
		if (process.platform === 'win32') {
			// libuv puts children in a kill-on-close Job Object, so Windows takes
			// workerd down with the daemon; the next daemon only clears the record.
			await waitFor('workerd to stop', () =>
				isRunning(workerdPid) ? null : true,
			)
			assert.deepEqual(reapLeftoverWorkers(workersDir), [])
		} else {
			assert.ok(isRunning(workerdPid), 'SIGKILL skips every exit handler')
			assert.deepEqual(reapLeftoverWorkers(workersDir), [workerdPid])
			await waitFor('workerd to stop', () =>
				isRunning(workerdPid) ? null : true,
			)
		}
		assert.deepEqual(readdirSync(workersDir), [])
		assert.deepEqual(
			readdirSync(scratch).filter((entry) => entry.startsWith('kody-local-')),
			[],
		)
	},
)

test(
	'egress refusals are plain errors that name the mode, the host, and how to change it',
	{ timeout: 180_000 },
	async () => {
		reset()
		const lan = createServer((_request, response) => response.end('lan ok'))
		await new Promise<void>((resolve) => lan.listen(0, '127.0.0.1', resolve))
		const lanUrl = `http://127.0.0.1:${(lan.address() as AddressInfo).port}/`
		const code = `export default async function main({ url }) {
	try {
		const response = await fetch(url)
		return 'ok: ' + (await response.text())
	} catch (error) {
		return String(error?.message ?? error)
	}
}`
		const run = async (
			egress: Parameters<typeof egressPolicyFromGrant>[0],
			url: string,
		) => {
			const result = await runLocalExecute({
				code,
				params: { url },
				token: goodToken,
				apiUrl,
				egress: egressPolicyFromGrant(egress),
			})
			assert.equal(result.isError, false)
			return String((result.structuredContent as { result: unknown }).result)
		}
		try {
			const publicOnly = await run({ mode: 'public' }, 'http://192.168.1.1/')
			assert.match(
				publicOnly,
				/^Blocked by this execution context's network setting: the request to 192\.168\.1\.1 was refused because this context allows public internet only \(egress mode "public"\), and 192\.168\.1\.1 is a private or local network address\./,
			)
			assert.match(publicOnly, /executionContextUpdate grant\.egress/)
			assert.match(publicOnly, /an allowlist that includes 192\.168\.1\.1/)
			assert.doesNotMatch(publicOnly, /internal error/)
			assert.match(
				await run({ mode: 'public' }, lanUrl),
				/allows public internet only.*127\.0\.0\.1 is a private or local network address/,
			)
			assert.match(
				await run({ mode: 'none' }, 'https://example.com/'),
				/request to example\.com was refused because this context allows no network access \(egress mode "none"\)/,
			)
			assert.match(
				await run(
					{ mode: 'allowlist', hosts: ['api.example.com', '127.0.0.1'] },
					'https://other.example.com/',
				),
				/this context only allows api\.example\.com, 127\.0\.0\.1 \(egress mode "allowlist"\), and other\.example\.com is not on the list/,
			)
			assert.equal(
				await run({ mode: 'allowlist', hosts: ['127.0.0.1'] }, lanUrl),
				'ok: lan ok',
			)
			assert.match(
				await run(
					{ mode: 'allowlist', hosts: ['127.0.0.1'], ports: [443] },
					lanUrl,
				),
				/port \d+ is not one of the allowed ports \(443\)/,
			)
			assert.equal(await run({ mode: 'public-and-lan' }, lanUrl), 'ok: lan ok')
		} finally {
			await new Promise((resolve) => lan.close(resolve))
		}
	},
)

test(
	'kody execute --local names --allow-private-network when a LAN fetch is refused',
	{
		timeout: 180_000,
	},
	async () => {
		reset()
		const result = await runLocalExecute({
			code: `export default async () => {
	try { await fetch('http://10.0.0.1/'); return 'ok' } catch (error) { return error.message }
}`,
			token: goodToken,
			apiUrl,
		})
		assert.match(
			String((result.structuredContent as { result: unknown }).result),
			/^Blocked by kody execute --local's network setting: .*10\.0\.0\.1 is a private or local network address\. Re-run with --allow-private-network/,
		)
	},
)

test(
	'runLocalExecute mounts effective host folders at their real paths and refuses everything else',
	{ timeout: 180_000 },
	async () => {
		reset()
		const { effectiveFs } =
			await import('../src/execution-context/fs-access.js')
		const root = realpathSync.native(
			mkdtempSync(join(tmpdir(), 'kody-host-fs-')),
		)
		const rw = join(root, 'granted')
		const ro = join(root, 'readonly')
		const denied = join(root, 'granted-evil')
		for (const dir of [rw, ro, denied]) mkdirSync(dir)
		writeFileSync(join(ro, 'note.txt'), 'read me')
		const hostFs = await effectiveFs(
			[
				{ path: rw, mode: 'rw' },
				{ path: ro, mode: 'rw' },
				{ path: denied, mode: 'rw' },
			],
			[
				{ path: rw, mode: 'rw' },
				{ path: ro, mode: 'ro' },
			],
		)
		const code = `import { promises as fsp, readFileSync } from 'node:fs'
import { writeFile } from 'fs/promises'
const attempt = async (fn) => { try { return await fn() } catch (error) { return error.code + ': ' + error.message } }
export default async function main(p) {
	await fsp.writeFile(p.rw + '/a.txt', 'hello host')
	await writeFile(p.rw + '/b.txt', 'bare specifier')
	return {
		a: await fsp.readFile(p.rw + '/a.txt', 'utf8'),
		listing: (await fsp.readdir(p.rw)).sort(),
		note: await fsp.readFile(p.ro + '/note.txt', 'utf8'),
		roWrite: await attempt(() => fsp.writeFile(p.ro + '/x.txt', 'nope')),
		prefixTrick: await attempt(() => fsp.writeFile(p.denied + '/x.txt', 'nope')),
		dotDot: await attempt(() => fsp.readFile(p.rw + '/../readonly/../granted-evil/x.txt')),
		outside: await attempt(() => fsp.readFile(p.outside, 'utf8')),
		sync: await attempt(() => readFileSync(p.rw + '/a.txt')),
		virtualTmp: await attempt(async () => { await fsp.writeFile('/tmp/v.txt', 'v'); return fsp.readFile('/tmp/v.txt', 'utf8') }),
	}
}`
		const result = await runLocalExecute({
			code,
			params: {
				rw,
				ro,
				denied,
				// workerd reports process.platform 'linux' even on Windows.
				outside:
					process.platform === 'win32'
						? 'C:\\Windows\\win.ini'
						: '/etc/hostname',
			},
			token: goodToken,
			apiUrl,
			hostFs: () => hostFs,
		})
		assert.equal(result.isError, false, JSON.stringify(result.content))
		const out = (result.structuredContent as { result: Record<string, string> })
			.result
		assert.equal(out.a, 'hello host')
		assert.deepEqual(out.listing, ['a.txt', 'b.txt'])
		assert.equal(readFileSync(join(rw, 'b.txt'), 'utf8'), 'bare specifier')
		assert.equal(out.note, 'read me')
		assert.match(out.roWrite!, /^EROFS: .*read-only/)
		assert.equal(existsSync(join(ro, 'x.txt')), false)
		assert.match(
			out.prefixTrick!,
			/^EACCES: .*server grant, but this machine's local policy/,
		)
		assert.equal(existsSync(join(denied, 'x.txt')), false)
		assert.match(out.dotDot!, /^EACCES: .*local policy/)
		assert.match(
			out.outside!,
			/^EACCES: .*outside this execution context's server grant/,
		)
		assert.match(out.sync!, /^ENOTSUP: .*use await fs\.promises\.readFile/)
		assert.equal(out.virtualTmp, 'v')
		assert.equal(
			existsSync('/tmp/v.txt') && readFileSync('/tmp/v.txt', 'utf8') === 'v',
			false,
		)
	},
)

test(
	'runLocalExecute re-checks host folders on every call, so a narrowed grant stops a running run',
	{ timeout: 180_000 },
	async () => {
		reset()
		const { effectiveFs } =
			await import('../src/execution-context/fs-access.js')
		const root = realpathSync.native(
			mkdtempSync(join(tmpdir(), 'kody-host-fs-')),
		)
		const granted = await effectiveFs(
			[{ path: root, mode: 'rw' }],
			[{ path: root, mode: 'rw' }],
		)
		const revoked = await effectiveFs([], [])
		let calls = 0
		// Call 1 sets up the run, call 2 serves the first write; then access is gone.
		const hostFs = () => (++calls <= 2 ? granted : revoked)
		const result = await runLocalExecute({
			code: `import { promises as fsp } from 'node:fs'
export default async function main(p) {
	await fsp.writeFile(p.root + '/first.txt', 'ok')
	try { await fsp.writeFile(p.root + '/second.txt', 'nope'); return 'wrote' } catch (error) { return error.code }
}`,
			params: { root },
			token: goodToken,
			apiUrl,
			hostFs,
		})
		assert.equal(result.isError, false, JSON.stringify(result.content))
		assert.equal(
			(result.structuredContent as { result: string }).result,
			'EACCES',
		)
		assert.equal(readFileSync(join(root, 'first.txt'), 'utf8'), 'ok')
		assert.equal(existsSync(join(root, 'second.txt')), false)
	},
)

test('runLocalExecute only reuses cached package graphs for code without saved package imports', async () => {
	const { runLocalExecute } = await import('../src/local-execute.js')
	const failingFetch = (async () =>
		new Response('nope', { status: 500 })) as unknown as typeof fetch
	const slot = () => {
		const counts = { gets: 0, sets: 0 }
		return {
			counts,
			slot: {
				get: () => {
					counts.gets += 1
					return undefined
				},
				set: () => {
					counts.sets += 1
				},
			},
		}
	}
	const withImport = slot()
	await runLocalExecute({
		code: `import run from 'kody:@nobody/pkg'\nexport default () => run()`,
		token: goodToken,
		apiUrl: 'https://api.kody.test',
		fetchFn: failingFetch,
		packageGraphCache: withImport.slot,
	}).catch(() => {})
	assert.deepEqual(withImport.counts, { gets: 0, sets: 0 })
	const plain = slot()
	await runLocalExecute({
		code: 'export default () => 1',
		token: goodToken,
		apiUrl: 'https://api.kody.test',
		fetchFn: failingFetch,
		packageGraphCache: plain.slot,
	}).catch(() => {})
	assert.equal(plain.counts.gets, 1)
})

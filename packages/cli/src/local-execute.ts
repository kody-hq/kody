import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
	assertTokenSafeApiUrl,
	callCapabilityProxy,
	checkCredentialCallMap,
	openCapabilityProxySession,
	type CapabilityProxySession,
} from './capability-proxy.js'
import { forwardLocalGatewayFetchStream } from './local-gateway-fetch-forward.js'
import {
	startLocalRuntimeBridge,
	type LocalRuntimeBridge,
} from './local-runtime-bridge.js'
import { assertLocalPackageScopedSecretWriteAllowed } from './local-package-secret-write.js'
import {
	missingCredentialCallMapFeatureMessage,
	sessionSupportsCredentialCallMap,
	type CredentialCallMapInput,
} from './credential-call-map.js'
import { assertLocalExecuteNodeEngine } from './node-engine.js'
import { apiTokenEnvVar } from './defaults.js'
import {
	hasSavedPackageImports,
	localExecuteGatewayFetchShimModuleName,
	resolveLocalPackageGraph,
	writePackageModuleFiles as writeGraphModuleFiles,
	type LocalPackageGraph,
} from './local-package-graph.js'
import {
	createLocalEntrySource,
	createLocalRuntimeModuleSource,
	createRuntimeFlatAliasSource,
	createWorkerdConfig,
	localWorkerModuleNames,
	runSecretEnvVar,
	runSecretHeader,
	type WorkerdPackageModuleFile,
} from './local-runtime-source.js'
import { bundleLocalUserModule } from './local-bundle.js'
import { installMockFetchShimModules } from './mock/install-mock-fetch-shim.js'
import {
	resolveMockFetchGateway,
	tryHandleMockGatewayFetchCall,
} from './mock/mock-fetch-gateway.js'
import { redact } from './redact.js'
import { type ToolCallResult } from './tool-result.js'
import { ensureWorkerdBinary } from './workerd-binary.js'

export {
	hasSavedPackageImports,
	listSavedPackageImports,
	localPackageGraphPlatformIssueUrl,
} from './local-package-graph.js'

export type LocalExecuteInput = {
	code: string
	/**
	 * `--file` path when that file supplied `code`.
	 * Bundled (relative + npm imports; `kody:*` external) before `main.js` is
	 * written — same resolution shape as hosted execute / publish.
	 */
	modulePath?: string
	params?: unknown
	conversationId?: string
	/**
	 * ADR 0068 call map from `--credential`. Sent as the CapabilityProxy call's
	 * top-level `credentials` field on every hop (and on the preflight check).
	 */
	credentials?: CredentialCallMapInput
	token: string
	apiUrl: string
	/** Used for the package-graph request and proxied CapabilityProxy calls. */
	fetchFn?: typeof fetch
	/** User-owned token org selection (`?org=`). */
	org?: string
	/**
	 * When CapabilityProxy points at the CLI mock, still fetch stamped `kody:@`
	 * modules from prod package-graph with this client (published source only).
	 */
	depResolve?: {
		apiUrl: string
		token: string
		org?: string
		fetchFn?: typeof fetch
	}
	/** Skip the pinned download and run this workerd binary. */
	workerdPath?: string
	allowPrivateNetwork?: boolean
	/**
	 * Hosts that may hit the real network under --target mock when
	 * `.kody/mocks.ts` is active (never carries real secrets).
	 */
	passthroughHosts?: ReadonlyArray<string>
	/** Package root for optional `.kody/mocks.ts` (mock only). */
	packageRoot?: string
	/** `--target` for mock fetch gateway gating (default prod → no mocks). */
	target?: 'prod' | 'mock'
	onStatus?: (message: string) => void
	/** Aborting kills workerd and ends the run with a cancelled error. */
	signal?: AbortSignal
}

type SandboxResponse = {
	result?: unknown
	error?: string
	logs?: Array<string>
}

const workerdStartTimeoutMs = 30_000
const cancelledError = 'Local execute was cancelled before it finished.'
const setupCancelled = Symbol('setup cancelled')

let workerdAcquisition: Promise<string> | undefined

/** One in-flight workerd download per process, so a retry after a cancel reuses it. */
function acquireWorkerdBinary(onStatus: LocalExecuteInput['onStatus']) {
	workerdAcquisition ??= ensureWorkerdBinary({
		onDownload: (url) =>
			onStatus?.(`Downloading workerd for local execute from ${url}…`),
	}).finally(() => {
		workerdAcquisition = undefined
	})
	return workerdAcquisition
}

/** Settles with `setupCancelled` as soon as `signal` aborts, even if `work` stalls. */
function untilAborted<T>(
	work: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T | typeof setupCancelled> {
	if (!signal) return work
	return new Promise((resolve, reject) => {
		const onAbort = () => resolve(setupCancelled)
		if (signal.aborted) onAbort()
		else signal.addEventListener('abort', onAbort, { once: true })
		work.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			},
		)
	})
}
const workerdExitGraceMs = 1_000

export const savedPackageImportLocalResolveStatus =
	'Module imports saved packages (kody:@…). Fetching stamped package modules for local workerd bundling (no cloud kody.execute defer).'

export const localExecutePackageGraphResolveStatus =
	'Fetching local-execute package graph (gateway-fetch shim + any stamped kody:@ modules).'

export async function runLocalExecute(
	input: LocalExecuteInput,
): Promise<ToolCallResult> {
	assertLocalExecuteNodeEngine()
	assertTokenSafeApiUrl(input.apiUrl)
	const setupStartedAt = new Date()
	const cancelledDuringSetup = () =>
		buildLocalExecuteResult({
			sandbox: { error: cancelledError },
			startedAt: setupStartedAt,
			endedAt: new Date(),
			conversationId: input.conversationId,
		})
	if (input.signal?.aborted) return cancelledDuringSetup()
	const code =
		input.modulePath !== undefined
			? await bundleLocalUserModule(input.modulePath)
			: input.code
	const client = {
		apiUrl: input.apiUrl,
		token: input.token,
		fetchFn: input.fetchFn,
		...(input.org ? { org: input.org } : {}),
	}
	// Skip the session preflight on the hot path (package-graph authenticates).
	// `--credential` still opens a session for feature detection + call-map check.
	const credentials = input.credentials
	if (credentials) {
		const preflight = await untilAborted(
			(async () => {
				const session = await openCapabilityProxySession(client)
				assertCredentialCallMapSupported(session, input)
				input.onStatus?.('Checking --credential picks against CapabilityProxy…')
				const { warnings } = await checkCredentialCallMap({
					...client,
					credentials,
					conversationId: input.conversationId,
				})
				return warnings
			})(),
			input.signal,
		)
		if (preflight === setupCancelled) return cancelledDuringSetup()
		for (const warning of preflight) {
			input.onStatus?.(warning)
		}
	}

	// Always fetch package-graph: origin returns the gateway-fetch shim even
	// when there are no `kody:@` imports so ambient `{{secret:…}}` fetch hops
	// (or fails closed) instead of sending a raw placeholder (kody#3020).
	input.onStatus?.(
		(await hasSavedPackageImports(code))
			? savedPackageImportLocalResolveStatus
			: localExecutePackageGraphResolveStatus,
	)
	if (input.signal?.aborted) return cancelledDuringSetup()
	const packageGraph = await untilAborted(
		resolveLocalPackageGraph({
			...client,
			code,
			conversationId: input.conversationId,
			...(input.depResolve ? { depResolve: input.depResolve } : {}),
			...(input.packageRoot ? { packageRoot: input.packageRoot } : {}),
			onStatus: input.onStatus,
		}),
		input.signal,
	)
	if (packageGraph === setupCancelled) return cancelledDuringSetup()

	const workerdPath =
		input.workerdPath ??
		(await untilAborted(acquireWorkerdBinary(input.onStatus), input.signal))
	if (workerdPath === setupCancelled) return cancelledDuringSetup()

	const runSecret = randomBytes(32).toString('hex')
	const workDir = await mkdtemp(join(tmpdir(), 'kody-local-'))
	let child: ChildProcess | undefined
	let bridge: LocalRuntimeBridge | undefined
	// SIGTERM makes workerd drain in-flight requests, which a hung module never finishes.
	const stopWorkerd = () => child?.kill('SIGKILL')
	input.signal?.addEventListener('abort', stopWorkerd, { once: true })
	const cancelled = () => finish({ error: cancelledError })
	const releaseSignals = cleanupOnSignal(() => {
		stopWorkerd()
		rmSync(workDir, { recursive: true, force: true })
	})
	const startedAt = new Date()
	const finish = (sandbox: SandboxResponse) =>
		buildLocalExecuteResult({
			sandbox,
			startedAt,
			endedAt: new Date(),
			conversationId: input.conversationId,
		})
	try {
		const mockFetchGateway = await resolveMockFetchGateway({
			target: input.target ?? 'prod',
			packageRoot: input.packageRoot,
			passthroughHosts: input.passthroughHosts,
			allowPrivateNetwork: input.allowPrivateNetwork,
			onStatus: input.onStatus,
		})
		bridge = await startLocalRuntimeBridge({
			runSecret,
			forwardCall: async (call, signal) => {
				const mocked = tryHandleMockGatewayFetchCall({
					gateway: mockFetchGateway,
					path: call.path,
					args: call.args,
					signal,
				})
				if (mocked) return await mocked
				assertLocalPackageScopedSecretWriteAllowed(call.path, call.args)
				return await callCapabilityProxy({
					...client,
					...call,
					conversationId: input.conversationId,
					...(input.credentials !== undefined
						? { credentials: input.credentials }
						: {}),
					signal,
				})
			},
			forwardGatewayFetchStream: async ({ request, response, signal }) => {
				await forwardLocalGatewayFetchStream({
					request,
					response,
					signal,
					client,
					...(mockFetchGateway ? { mockFetchGateway } : {}),
				})
			},
		})
		const files = { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' }
		let packageModules = await writePackageModuleFiles(workDir, packageGraph)
		let gatewayFetchShimModules: Array<string> = packageGraph.modules
			.map((module) => module.name)
			.filter((name) => name === localExecuteGatewayFetchShimModuleName)
		if (mockFetchGateway) {
			const installed = await installMockFetchShimModules({
				workDir,
				packageModules,
			})
			packageModules = installed.packageModules
			gatewayFetchShimModules = installed.sideEffectModules
		}
		await writeFile(
			join(workDir, files.entry),
			createLocalEntrySource({ sideEffectModules: gatewayFetchShimModules }),
		)
		await writeFile(join(workDir, files.user), code)
		await writeFile(
			join(workDir, files.runtime),
			createLocalRuntimeModuleSource(),
		)
		await writeFile(
			join(workDir, localWorkerModuleNames.runtimeFlatAlias),
			createRuntimeFlatAliasSource(),
		)
		const configPath = join(workDir, 'config.capnp')
		await writeFile(
			configPath,
			createWorkerdConfig({
				bridgePort: bridge.port,
				files,
				packageModules,
				allowPrivateNetwork: input.allowPrivateNetwork,
			}),
		)

		const env: NodeJS.ProcessEnv = {
			...process.env,
			[runSecretEnvVar]: runSecret,
		}
		delete env[apiTokenEnvVar]
		if (input.signal?.aborted) return cancelled()
		child = spawn(workerdPath, ['serve', configPath, '--control-fd=3'], {
			cwd: workDir,
			env,
			stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
		})
		const workerd = watchWorkerd(child)
		const started = await workerd.listening
		if (input.signal?.aborted) return cancelled()
		if ('exitDetail' in started) {
			return finish({
				error: `Local execute could not load the module${started.exitDetail}`,
			})
		}
		let response: { status: number; body: string }
		try {
			response = await postToWorkerd({
				port: started.port,
				runSecret,
				body: JSON.stringify({ params: input.params ?? {} }),
			})
		} catch (error) {
			if (input.signal?.aborted) return cancelled()
			const exitDetail = await Promise.race([
				workerd.exited,
				delay(workerdExitGraceMs, null),
			])
			if (exitDetail !== null)
				throw new Error(`workerd exited during the run${exitDetail}`)
			const reason = error instanceof Error ? error.message : String(error)
			throw new Error(
				`Local execute run failed (${reason}).${workerd.stderr()}`,
			)
		}
		if (response.status !== 200) {
			throw new Error(
				`Local execute runtime returned HTTP ${response.status}.${workerd.stderr()}`,
			)
		}
		return finish(JSON.parse(response.body) as SandboxResponse)
	} finally {
		input.signal?.removeEventListener('abort', stopWorkerd)
		releaseSignals()
		stopWorkerd()
		await bridge?.close()
		await rm(workDir, { recursive: true, force: true })
	}
}

async function writePackageModuleFiles(
	workDir: string,
	graph: LocalPackageGraph,
): Promise<Array<WorkerdPackageModuleFile>> {
	return await writeGraphModuleFiles(workDir, graph, writeFile, join)
}

/** Same envelope as cloud execute so `formatToolResult` and `--json` behave identically. */
export function buildLocalExecuteResult(input: {
	sandbox: SandboxResponse
	startedAt: Date
	endedAt: Date
	conversationId?: string
}): ToolCallResult {
	const { sandbox } = input
	const logs = sandbox.logs ?? []
	const base = {
		...(input.conversationId !== undefined
			? { conversationId: input.conversationId }
			: {}),
		timing: {
			startedAt: input.startedAt.toISOString(),
			endedAt: input.endedAt.toISOString(),
			durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
		},
	}
	if (typeof sandbox.error === 'string') {
		return {
			content: [{ type: 'text', text: `Error: ${sandbox.error}` }],
			structuredContent: {
				...base,
				returnedBytes: 0,
				error: sandbox.error,
				logs,
			},
			isError: true,
		}
	}
	const text =
		typeof sandbox.result === 'string'
			? sandbox.result
			: (JSON.stringify(sandbox.result, null, 2) ?? 'undefined')
	const serialized =
		typeof sandbox.result === 'string'
			? sandbox.result
			: (JSON.stringify(sandbox.result) ?? 'undefined')
	return {
		content: [{ type: 'text', text }],
		structuredContent: {
			...base,
			returnedBytes: Buffer.byteLength(serialized),
			result: sandbox.result,
			logs,
		},
		isError: false,
	}
}

/**
 * `finally` does not run when the CLI is killed by a signal; without this,
 * workerd is orphaned and the user's module stays in the temp dir.
 */
function cleanupOnSignal(cleanup: () => void): () => void {
	const signals: Array<NodeJS.Signals> = ['SIGINT', 'SIGTERM', 'SIGHUP']
	const release = () => {
		for (const signal of signals) process.off(signal, handler)
	}
	const handler = (signal: NodeJS.Signals) => {
		release()
		cleanup()
		process.kill(process.pid, signal)
	}
	for (const signal of signals) process.once(signal, handler)
	return release
}

function watchWorkerd(child: ChildProcess) {
	let stderrText = ''
	child.stderr?.on('data', (chunk: Buffer) => {
		stderrText += chunk.toString('utf8')
	})
	child.stdout?.resume()
	const stderr = () => {
		const trimmed = redact(stderrText.trim())
		return trimmed ? `\n${trimmed}` : ''
	}
	const exited = new Promise<string>((resolve) => {
		child.once('exit', (code, signal) => {
			resolve(` (workerd exit ${signal ?? code})${stderr()}`)
		})
	})
	const listening = new Promise<{ port: number } | { exitDetail: string }>(
		(resolve, reject) => {
			const control = child.stdio[3] as Readable | null
			let buffered = ''
			const timer = setTimeout(() => {
				reject(
					new Error(
						`workerd did not start within ${workerdStartTimeoutMs / 1000}s.${stderr()}`,
					),
				)
			}, workerdStartTimeoutMs)
			control?.on('data', (chunk: Buffer) => {
				buffered += chunk.toString('utf8')
				for (const line of buffered.split('\n')) {
					const port = parseListenPort(line)
					if (port !== null) {
						clearTimeout(timer)
						resolve({ port })
					}
				}
			})
			child.once('error', (error) => {
				clearTimeout(timer)
				reject(new Error(`Could not start workerd: ${error.message}`))
			})
			void exited.then((exitDetail) => {
				clearTimeout(timer)
				resolve({ exitDetail })
			})
		},
	)
	return { listening, exited, stderr }
}

function parseListenPort(line: string): number | null {
	if (!line.trim()) return null
	try {
		const event = JSON.parse(line) as {
			event?: string
			socket?: string
			port?: number
		}
		return event.event === 'listen' &&
			event.socket === 'http' &&
			typeof event.port === 'number'
			? event.port
			: null
	} catch {
		return null
	}
}

/** node:http rather than fetch: local runs have no time limit, and fetch gives up after 300s. */
function postToWorkerd(input: {
	port: number
	runSecret: string
	body: string
}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: '127.0.0.1',
				port: input.port,
				method: 'POST',
				path: '/',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(input.body),
					[runSecretHeader]: input.runSecret,
				},
			},
			(response) => {
				readBody(response).then(
					(body) => resolve({ status: response.statusCode ?? 0, body }),
					reject,
				)
			},
		)
		request.on('error', reject)
		request.end(input.body)
	})
}

function assertCredentialCallMapSupported(
	session: CapabilityProxySession,
	input: LocalExecuteInput,
): void {
	if (!input.credentials) return
	if (sessionSupportsCredentialCallMap(session.features)) return
	throw new Error(missingCredentialCallMapFeatureMessage())
}

async function readBody(stream: IncomingMessage): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

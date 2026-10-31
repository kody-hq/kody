/**
 * Run one unpublished package module (export / job / webhook / subscription)
 * in local workerd against `--target prod|mock`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
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
} from './capability-proxy.js'
import { apiTokenEnvVar } from './defaults.js'
import { bundleLocalUserModule } from './local-bundle.js'
import { forwardLocalGatewayFetchStream } from './local-gateway-fetch-forward.js'
import {
	localExecuteGatewayFetchShimModuleName,
	resolveLocalPackageGraph,
	writePackageModuleFiles,
	type LocalPackageGraph,
} from './local-package-graph.js'
import {
	parseKodyPackageSpecifier,
	tryLoadSelfManifest,
} from './mock-local-deps.js'
import { callOpenApiOperation } from './open-api-client.js'
import {
	startLocalRuntimeBridge,
	type LocalRuntimeBridge,
} from './local-runtime-bridge.js'
import { assertLocalPackageScopedSecretWriteAllowed } from './local-package-secret-write.js'
import {
	createRuntimeFlatAliasSource,
	createWorkerdConfig,
} from './local-runtime-source.js'
import { installMockFetchShimModules } from './mock/install-mock-fetch-shim.js'
import {
	resolveMockFetchGateway,
	tryHandleMockGatewayFetchCall,
} from './mock/mock-fetch-gateway.js'
import {
	createPackageLocalRuntimeModuleSource,
	createPackageModuleEntrySource,
	localWorkerModuleNames,
	runSecretEnvVar,
	runSecretHeader,
	type PackageLocalContext,
} from './package-local-runtime-source.js'
import { redact } from './redact.js'
import { type KodyTarget } from './target.js'
import { type ToolCallResult } from './tool-result.js'
import { ensureWorkerdBinary } from './workerd-binary.js'

export type LocalPackageRunInput = {
	modulePath: string
	params?: unknown
	token: string
	apiUrl: string
	target: KodyTarget
	packageContext: PackageLocalContext
	fetchFn?: typeof fetch
	/** User-owned token org selection (`?org=`), same as execute --local. */
	org?: string
	/**
	 * Fetch stamped `kody:@` modules from prod while CapabilityProxy stays on
	 * mock (published source is not a secret).
	 */
	depResolve?: {
		apiUrl: string
		token: string
		org?: string
		fetchFn?: typeof fetch
	}
	workerdPath?: string
	allowPrivateNetwork?: boolean
	/**
	 * Hosts that may hit the real network under --target mock when
	 * `.kody/mocks.ts` is active (never carries real secrets).
	 */
	passthroughHosts?: ReadonlyArray<string>
	/** Package root for optional `.kody/mocks.ts` (mock only). */
	packageRoot?: string
	onStatus?: (message: string) => void
}

type SandboxResponse = {
	result?: unknown
	error?: string
	logs?: Array<string>
}

const workerdStartTimeoutMs = 30_000
const workerdExitGraceMs = 1_000

export async function runLocalPackageModule(
	input: LocalPackageRunInput,
): Promise<ToolCallResult> {
	assertTokenSafeApiUrl(input.apiUrl)
	input.onStatus?.(`Bundling ${input.modulePath}…`)
	const code = await bundleLocalUserModule(input.modulePath)
	const client = {
		apiUrl: input.apiUrl,
		token: input.token,
		fetchFn: input.fetchFn,
		...(input.org ? { org: input.org } : {}),
	}

	const workerdPath =
		input.workerdPath ??
		(await ensureWorkerdBinary({
			onDownload: (url) => input.onStatus?.(`Downloading workerd from ${url}…`),
		}))

	const runSecret = randomBytes(32).toString('hex')
	const workDir = await mkdtemp(join(tmpdir(), 'kody-pkg-'))
	let child: ChildProcess | undefined
	let bridge: LocalRuntimeBridge | undefined
	const stopWorkerd = () => child?.kill('SIGKILL')
	const releaseSignals = cleanupOnSignal(() => {
		stopWorkerd()
		rmSync(workDir, { recursive: true, force: true })
	})
	const startedAt = new Date()
	const finish = (sandbox: SandboxResponse): ToolCallResult => {
		const endedAt = new Date()
		const logs = sandbox.logs ?? []
		const base = {
			timing: {
				startedAt: startedAt.toISOString(),
				endedAt: endedAt.toISOString(),
				durationMs: endedAt.getTime() - startedAt.getTime(),
			},
			target: input.target,
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

	try {
		const mockFetchGateway = await resolveMockFetchGateway({
			target: input.target,
			packageRoot: input.packageRoot,
			passthroughHosts: input.passthroughHosts,
			allowPrivateNetwork: input.allowPrivateNetwork,
			onStatus: input.onStatus,
		})
		const packageGraph = await resolveLocalPackageGraph({
			...client,
			code,
			...(input.depResolve ? { depResolve: input.depResolve } : {}),
			...(input.packageRoot ? { packageRoot: input.packageRoot } : {}),
			onStatus: input.onStatus,
		})
		const boundPackage = await resolveLocalPackageBinding({
			graph: packageGraph,
			kodyId: input.packageContext.kodyId,
			packageRoot: input.packageRoot,
			apiUrl: input.apiUrl,
			token: input.token,
			...(input.org ? { org: input.org } : {}),
			...(input.depResolve
				? {
						listClient: {
							apiUrl: input.depResolve.apiUrl,
							token: input.depResolve.token,
							...(input.depResolve.org ? { org: input.depResolve.org } : {}),
							fetchFn: input.depResolve.fetchFn ?? input.fetchFn,
						},
					}
				: {
						listClient: {
							apiUrl: input.apiUrl,
							token: input.token,
							...(input.org ? { org: input.org } : {}),
							fetchFn: input.fetchFn,
						},
					}),
		})
		const packageContext: PackageLocalContext = boundPackage
			? {
					...input.packageContext,
					packageId: boundPackage.packageId,
				}
			: input.packageContext
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
		let packageModules = await writePackageModuleFiles(
			workDir,
			packageGraph,
			writeFile,
			join,
		)
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
			createPackageModuleEntrySource({
				sideEffectModules: gatewayFetchShimModules,
			}),
		)
		await writeFile(join(workDir, files.user), code)
		await writeFile(
			join(workDir, files.runtime),
			createPackageLocalRuntimeModuleSource({
				packageContext,
				mockStorage: input.target === 'mock',
				...(boundPackage?.packageBinding
					? { packageBinding: boundPackage.packageBinding }
					: {}),
			}),
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
		child = spawn(workerdPath, ['serve', configPath, '--control-fd=3'], {
			cwd: workDir,
			env,
			stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
			windowsHide: true,
		})
		const workerd = watchWorkerd(child)
		const started = await workerd.listening
		if ('exitDetail' in started) {
			return finish({
				error: `Local package run could not load the module${started.exitDetail}`,
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
			const exitDetail = await Promise.race([
				workerd.exited,
				delay(workerdExitGraceMs, null),
			])
			if (exitDetail !== null)
				throw new Error(`workerd exited during the run${exitDetail}`)
			const reason = error instanceof Error ? error.message : String(error)
			throw new Error(
				`Local package run failed (${reason}).${workerd.stderr()}`,
			)
		}
		if (response.status !== 200) {
			throw new Error(
				`Local package runtime returned HTTP ${response.status}.${workerd.stderr()}`,
			)
		}
		return finish(JSON.parse(response.body) as SandboxResponse)
	} finally {
		releaseSignals()
		stopWorkerd()
		await bridge?.close()
		// Windows keeps a dead process's files locked until it has exited.
		if (child && child.exitCode === null && child.signalCode === null) {
			await new Promise((resolve) => child?.once('exit', resolve))
		}
		await rm(workDir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		})
	}
}

/** Build the packageContext used for local unpublished package runs. */
export function buildLocalPackageContext(input: {
	kodyId: string
	/**
	 * Real package UUID when known from package-graph / packageList. Falls back
	 * to `local:${kodyId}` for unpublished checkouts. Never used as a
	 * CapabilityProxy package stamp — only signed `kpb1.` bindings are.
	 */
	packageId?: string
	hostedUrl: string
	appBasePath?: string
	clientModuleUrl?: string | null
}): PackageLocalContext {
	const appBasePath = input.appBasePath ?? ''
	const packageId =
		typeof input.packageId === 'string' && input.packageId.trim()
			? input.packageId.trim()
			: `local:${input.kodyId}`
	return {
		packageId,
		kodyId: input.kodyId,
		sourceId: `local:${input.kodyId}`,
		publishedCommit: null,
		appBasePath,
		hostedUrl: input.hostedUrl.replace(/\/+$/, ''),
		assetBasePath: appBasePath ? `${appBasePath}/_assets` : '/_assets',
		clientModuleUrl: input.clientModuleUrl ?? null,
		cookiePrefix: `__kapp_${createHash('sha256').update(packageId).digest('hex').slice(0, 12)}_`,
	}
}

/**
 * Pick the signed package binding for this local package run from the
 * package-graph response. Prefers `packageIdsByImport` for `kody:@…` keys that
 * belong to this package; falls back to `packageList` when bindings exist but
 * the import map did not name this package.
 */
export async function resolveLocalPackageBinding(input: {
	graph: LocalPackageGraph
	kodyId: string
	packageRoot?: string
	apiUrl: string
	token: string
	org?: string
	listClient?: {
		apiUrl: string
		token: string
		org?: string
		fetchFn?: typeof fetch
	}
}): Promise<{ packageId: string; packageBinding: string } | null> {
	const packageBindings = input.graph.packageBindings ?? {}
	const packageIdsByImport = input.graph.packageIdsByImport ?? {}
	if (Object.keys(packageBindings).length === 0) return null

	let packageName: string | undefined
	if (input.packageRoot) {
		const manifest = await tryLoadSelfManifest(input.packageRoot)
		packageName = manifest?.name
	}

	for (const [specifier, packageId] of Object.entries(packageIdsByImport)) {
		if (
			!packageIdMatchesLocalPackage({
				specifier,
				kodyId: input.kodyId,
				packageName,
			})
		) {
			continue
		}
		const binding = packageBindings[packageId]
		if (typeof binding === 'string' && binding.startsWith('kpb1.')) {
			return { packageId, packageBinding: binding }
		}
	}

	const listedId = await resolvePackageIdViaPackageList({
		kodyId: input.kodyId,
		packageName,
		client: input.listClient ?? {
			apiUrl: input.apiUrl,
			token: input.token,
			...(input.org ? { org: input.org } : {}),
		},
	})
	if (!listedId) return null
	const binding = packageBindings[listedId]
	if (typeof binding === 'string' && binding.startsWith('kpb1.')) {
		return { packageId: listedId, packageBinding: binding }
	}
	return null
}

/**
 * True when a package-graph import specifier belongs to this local package.
 * Prefer the manifest `packageName` (exact). Never match on an unscoped leaf
 * alone: `@other/pkg` must not stamp as `@someone/pkg` just because both end
 * in `pkg`.
 */
export function packageIdMatchesLocalPackage(input: {
	specifier: string
	kodyId: string
	packageName?: string
}): boolean {
	const parsed = parseKodyPackageSpecifier(input.specifier)
	if (!parsed) {
		// Also accept a bare `kody:${kodyId}/…` form if origin ever emits it.
		if (
			input.specifier === `kody:${input.kodyId}` ||
			input.specifier.startsWith(`kody:${input.kodyId}/`)
		) {
			return true
		}
		return false
	}
	if (input.packageName) {
		return parsed.packageName === input.packageName
	}
	return parsed.packageName === input.kodyId
}

async function resolvePackageIdViaPackageList(input: {
	kodyId: string
	packageName?: string
	client: {
		apiUrl: string
		token: string
		org?: string
		fetchFn?: typeof fetch
	}
}): Promise<string | null> {
	try {
		const listed = (await callOpenApiOperation({
			apiUrl: input.client.apiUrl,
			token: input.client.token,
			operationId: 'packageList',
			params: {},
			...(input.client.org ? { org: input.client.org } : {}),
			...(input.client.fetchFn ? { fetchFn: input.client.fetchFn } : {}),
		})) as {
			packages?: Array<{ package_id: string; kody_id: string; name: string }>
		}
		const packages = listed.packages ?? []
		// Exact scoped name first. Do not fall through to a leaf/`endsWith`
		// match: that would pick a different package that shares the unscoped
		// segment (same spoof Bugbot flagged on packageIdMatchesLocalPackage).
		if (input.packageName) {
			const byName = packages.filter((pkg) => pkg.name === input.packageName)
			if (byName.length === 1) return byName[0]!.package_id
			return null
		}
		const byKodyId = packages.filter(
			(pkg) => pkg.kody_id === input.kodyId || pkg.name === input.kodyId,
		)
		if (byKodyId.length === 1) return byKodyId[0]!.package_id
	} catch {
		return null
	}
	return null
}

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

async function readBody(stream: IncomingMessage): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

void localWorkerModuleNames

/**
 * Long-running `kody dev` app server: bundles `kody.app.entry` the same way
 * local-bundle/publish does for esbuild, serves via workerd behind a Node
 * proxy that strips the mount, and rebuilds on file changes.
 *
 * Each successful rebuild starts a new workerd "generation" and only swaps the
 * proxy over once it is listening; the previous generation drains in-flight
 * requests and is then stopped. Requests that arrive mid-rebuild wait for it,
 * so a save is never answered by a 503 or a stale bundle.
 */

import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import {
	assertTokenSafeApiUrl,
	callCapabilityProxy,
} from './capability-proxy.js'
import { apiTokenEnvVar } from './defaults.js'
import {
	createDevClientBundler,
	parseDevAssetPath,
	serveDevAsset,
	type DevClientBundle,
	type DevClientBundler,
} from './dev/dev-assets.js'
import { forwardLocalGatewayFetchStream } from './local-gateway-fetch-forward.js'
import {
	startLocalRuntimeBridge,
	type LocalRuntimeBridge,
} from './local-runtime-bridge.js'
import { assertLocalPackageScopedSecretWriteAllowed } from './local-package-secret-write.js'
import { createDevBundler, type DevBundle } from './dev/dev-bundler.js'
import {
	parseWorkerdStdoutLine,
	runtimeErrorFix,
	type DevEvent,
	type DevRequestTag,
} from './dev/dev-events.js'
import { devErrorHeader, devRequestIdHeader } from './dev/dev-protocol.js'
import {
	buildDevProxyUpstreamHeaders,
	buildTrustedDevForwardUrl,
	buildTrustedDevPublicUrl,
	isAllowedDevHost,
	trustedDevHostFromHostedUrl,
} from './dev/dev-proxy-origin.js'
import { listenDevServer } from './dev/dev-port.js'
import { devStatusPath, type DevServerStatus } from './dev/dev-registry.js'
import { createDevWatcher, type DevWatcher } from './dev/dev-watcher.js'
import { sendDevError, type DevErrorView } from './dev/error-page.js'
import {
	createLiveReloadHub,
	injectLiveReloadScript,
	liveReloadClientPath,
	liveReloadClientSource,
	liveReloadEventsPath,
	liveReloadScriptTag,
	shouldInjectLiveReload,
} from './dev/live-reload.js'
import {
	devWorkDirPrefix,
	startProcessReaper,
	sweepStaleDevDirs,
} from './dev/process-reaper.js'
import { runPrebuild } from './dev/prebuild.js'
import { createStackMapper, type StackMapper } from './dev/stack-trace.js'
import {
	cleanWorkerdStderrLine,
	startWorkerd,
	type WorkerdHandle,
} from './dev/workerd-process.js'
import {
	BundleError,
	formatBundleDiagnostic,
	type BundleDiagnostic,
} from './local-bundle.js'
import {
	localExecuteGatewayFetchShimModuleName,
	resolveLocalPackageGraph,
	writePackageModuleFiles,
} from './local-package-graph.js'
import {
	createRuntimeFlatAliasSource,
	createWorkerdConfig,
	localWorkerModuleNames,
} from './local-runtime-source.js'
import { buildLocalPackageContext } from './local-package-run.js'
import { installMockFetchShimModules } from './mock/install-mock-fetch-shim.js'
import {
	resolveMockFetchGateway,
	tryHandleMockGatewayFetchCall,
	type MockFetchGateway,
} from './mock/mock-fetch-gateway.js'
import {
	createPackageAppEntrySource,
	createPackageLocalRuntimeModuleSource,
	runSecretEnvVar,
	runSecretHeader,
	type PackageLocalContext,
} from './package-local-runtime-source.js'
import {
	type KodyPackageManifest,
	resolvePackagePath,
} from './package-manifest.js'
import { redact } from './redact.js'
import { type KodyTarget } from './target.js'
import { ensureWorkerdBinary } from './workerd-binary.js'

export type PackageAppDevOptions = {
	manifest: KodyPackageManifest
	token: string
	apiUrl: string
	target: KodyTarget
	host?: string
	/** Listen on exactly this port (0 = any free port); EADDRINUSE is an error. */
	port?: number
	/**
	 * Used when `port` is unset: try this port, then the next free ones above
	 * it. Without either, any free port.
	 */
	defaultPort?: number
	/** Public mount path the Node proxy strips (default ''). */
	appBasePath?: string
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
	allowPrivateNetwork?: boolean
	/**
	 * Hosts that may hit the real network under --target mock when
	 * `.kody/mocks.ts` is active (never carries real secrets).
	 */
	passthroughHosts?: ReadonlyArray<string>
	/**
	 * Extra Host header values allowed at the Node proxy (in addition to the
	 * listen host and loopback aliases). Unknown Hosts are rejected before
	 * workerd — never copy the incoming Host through (DNS rebinding).
	 */
	hostAliases?: ReadonlyArray<string>
	workerdPath?: string
	fetchFn?: typeof fetch
	/**
	 * Rebuild on file changes (default true). One-shot `dev fetch` turns this
	 * off, which also makes an initial build failure throw.
	 */
	watch?: boolean
	/** Quiet period after the last file event before rebuilding. */
	debounceMs?: number
	/**
	 * Inject the live-reload client into HTML responses and serve its SSE
	 * stream (default: on whenever `watch` is on).
	 */
	liveReload?: boolean
	onStatus?: (message: string) => void
	onError?: (message: string) => void
	/** Rebuilds, build/runtime errors, and app logs. */
	onEvent?: (event: DevEvent) => void
	/**
	 * Fired as soon as the HTTP port is bound (before the first build). Used
	 * to advertise the server in the attach registry so a second `kody dev`
	 * cannot start during the initial build window.
	 */
	onListening?: (info: {
		port: number
		hostedUrl: string
		appBasePath: string
	}) => void | Promise<void>
}

export type PackageAppDevServer = {
	url: string
	port: number
	hostedUrl: string
	appBasePath: string
	packageContext: PackageLocalContext
	fetchPath: (
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string },
	) => Promise<{
		status: number
		headers: Record<string, string>
		body: string
	}>
	/** Same JSON as `GET /__kody/dev/status`. */
	status: () => DevServerStatus
	close: () => Promise<void>
}

type Generation = {
	id: number
	dir: string
	workerd: WorkerdHandle
	code: string
	client: DevClientBundle | null
	mapStack: StackMapper
	inflight: number
	retired: boolean
	stopped: boolean
}

type BuildFailure = {
	message: string
	diagnostics: Array<BundleDiagnostic>
}

const defaultDebounceMs = 30
/** Watcher events this soon after a prebuild finishes are its own writes, not edits. */
const prebuildSettleMs = 150
/**
 * After a *failed* prebuild, ignore watcher events this long. Chokidar/poll
 * echoes of partial output can arrive well after {@link prebuildSettleMs} on
 * slower CI and would otherwise restart the rebuild loop.
 */
const failedPrebuildAbsorbMs = 1500
/** Longest a request waits for an in-progress rebuild before the old build answers. */
const rebuildGateMs = 10_000
/** Longest a retired generation may keep draining in-flight requests. */
const drainTimeoutMs = 10_000

export async function startPackageAppDev(
	options: PackageAppDevOptions,
): Promise<PackageAppDevServer> {
	if (!options.manifest.app?.entry) {
		throw new Error(
			'This package has no kody.app.entry. Add `"kody": { "app": { "entry": "./app/router.ts" } }` or use `kody dev job|webhook|emit|check`.',
		)
	}
	assertTokenSafeApiUrl(options.apiUrl)

	const host = options.host ?? '127.0.0.1'
	const appBasePath = normalizeBasePath(options.appBasePath ?? '')
	const root = options.manifest.root
	const runSecret = randomBytes(32).toString('hex')
	const emit = (event: DevEvent) => options.onEvent?.(event)
	const liveReload = options.liveReload ?? options.watch !== false
	const errorPageTail = liveReload
		? `<script>globalThis.__kodyDevErrorPage = true</script>${liveReloadScriptTag}`
		: ''
	void sweepStaleDevDirs().catch(() => {})
	const workDir = await mkdtemp(join(tmpdir(), devWorkDirPrefix))
	const reaper = await startProcessReaper({ workDir })
	const workerdPath =
		options.workerdPath ??
		(await ensureWorkerdBinary({
			onDownload: (url) =>
				options.onStatus?.(`Downloading workerd from ${url}…`),
		}))

	const client = {
		apiUrl: options.apiUrl,
		token: options.token,
		fetchFn: options.fetchFn,
		...(options.org ? { org: options.org } : {}),
	}

	const generations = new Set<Generation>()
	let active: Generation | undefined
	let buildFailure: BuildFailure | null = null
	let generationCounter = 0
	let requestCounter = 0
	let closed = false
	let buildLoop: Promise<void> | null = null
	let rebuildAgain = false
	const changedFiles = new Set<string>()
	/** True while the watcher debounce timer has paths waiting to rebuild. */
	let debouncePending = false
	/** Resolves when the current debounce window flushes into `requestBuild`. */
	let debounceFlush: Promise<void> | null = null
	let resolveDebounceFlush: (() => void) | null = null
	let debounceTimer: NodeJS.Timeout | undefined
	const liveReloadHub = createLiveReloadHub({
		state: () => ({
			buildId: active?.id ?? null,
			error: buildFailure ? buildErrorView(buildFailure) : null,
		}),
	})
	const startedAt = new Date().toISOString()
	let lastRebuild: DevServerStatus['lastRebuild'] = null
	let lastRuntimeError: DevServerStatus['lastError'] = null
	let buildFailureAt = startedAt
	let markStarted: () => void = () => {}
	const started = new Promise<void>((resolve) => {
		markStarted = resolve
	})

	const killAllSync = () => {
		for (const generation of generations) {
			try {
				process.kill(generation.workerd.pid, 'SIGKILL')
			} catch {}
		}
		try {
			rmSync(workDir, { recursive: true, force: true })
		} catch {}
	}
	process.once('exit', killAllSync)

	const proxy = createServer((req, res) => {
		void handleRequest(req, res)
	})
	try {
		await listenDevServer(proxy, {
			host,
			port: options.port ?? options.defaultPort ?? 0,
			explicit: options.port !== undefined,
		})
	} catch (error) {
		process.off('exit', killAllSync)
		reaper.close()
		await rm(workDir, { recursive: true, force: true })
		throw error
	}
	const address = proxy.address() as AddressInfo
	const hostedUrl = `http://${host}:${address.port}`
	try {
		await options.onListening?.({
			port: address.port,
			hostedUrl,
			appBasePath,
		})
	} catch (error) {
		// Port is bound but startPackageAppDev has not returned yet — close the
		// listen handle now or the process stays alive after the throw.
		process.off('exit', killAllSync)
		reaper.close()
		proxy.closeAllConnections()
		await new Promise<void>((resolve) => {
			proxy.close(() => resolve())
		})
		await rm(workDir, { recursive: true, force: true })
		throw error
	}
	const contextFor = (client: DevClientBundle | null) =>
		buildLocalPackageContext({
			kodyId: options.manifest.kodyId,
			packageId: `local:${options.manifest.kodyId}`,
			hostedUrl,
			appBasePath,
			clientModuleUrl: client ? clientModuleUrlFor(client) : null,
		})
	const clientModuleUrlFor = (client: DevClientBundle) =>
		`${hostedUrl}${appBasePath}/_assets/${client.name}`

	const mockFetchGateway = await resolveMockFetchGateway({
		target: options.target,
		packageRoot: root,
		passthroughHosts: options.passthroughHosts,
		allowPrivateNetwork: options.allowPrivateNetwork,
		onStatus: options.onStatus,
	})

	const bridge: LocalRuntimeBridge = await startLocalRuntimeBridge({
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

	const app = options.manifest.app
	const entryPath = resolvePackagePath(options.manifest, app.entry)
	const bundler = createDevBundler({ entryPath, root })
	const clientBundler: DevClientBundler | null = app.client
		? createDevClientBundler({
				entryPath: resolvePackagePath(options.manifest, app.client),
				root,
				externals: app.clientExternals,
			})
		: null
	const assetsDir = app.assets ? resolve(root, app.assets) : null
	const prebuild = options.manifest.dev?.prebuild
	let prebuildRunning = false
	let prebuildSettledAt = 0
	/** `performance.now()` until which onChange ignores events (failed-prebuild absorb). */
	let ignoreWatcherUntil = 0
	let prebuildAbort: AbortController | undefined
	const workerdEnv: NodeJS.ProcessEnv = {
		...process.env,
		[runSecretEnvVar]: runSecret,
	}
	delete workerdEnv[apiTokenEnvVar]

	function requestBuild(paths: Iterable<string>): Promise<void> {
		if (closed) return Promise.resolve()
		for (const path of paths) changedFiles.add(path)
		if (buildLoop) {
			rebuildAgain = true
			return buildLoop
		}
		buildLoop = (async () => {
			do {
				rebuildAgain = false
				const files = [...changedFiles]
				changedFiles.clear()
				await buildOnce(files)
			} while (rebuildAgain && !closed)
		})().finally(() => {
			buildLoop = null
		})
		return buildLoop
	}

	async function buildOnce(files: Array<string>): Promise<void> {
		const started = performance.now()
		emit({
			type: 'rebuild_start',
			files: files.map((file) => relative(root, file) || file),
		})
		const assetsChanged =
			assetsDir !== null &&
			files.some(
				(file) => file === assetsDir || file.startsWith(`${assetsDir}${sep}`),
			)
		try {
			if (prebuild) {
				await runPrebuildStep(prebuild)
			}
			const [bundle, client] = await Promise.all([
				bundler.build(),
				clientBundler ? clientBundler.build() : Promise.resolve(null),
			])
			const midBuildEdits =
				(await watcher?.track(
					[
						...bundle.inputs,
						...(client?.inputs ?? []),
						options.manifest.packageJsonPath,
					],
					{ ignoreChanges: files },
				)) ?? []
			// Queue mid-build edits for the next loop iteration directly — do not
			// call onChange (debounced); chokidar may already have the same paths
			// pending and would double-schedule a rebuild after debounce.
			if (midBuildEdits.length > 0) {
				for (const path of midBuildEdits) changedFiles.add(path)
				rebuildAgain = true
			}
			if (
				active &&
				!buildFailure &&
				bundle.code === active.code &&
				client?.name === active.client?.name
			) {
				// Still stamp lastRebuild so agents polling lastRebuild.at see
				// the no-op rebuild finish (status already flipped building→ready).
				lastRebuild = { ms: elapsed(started), at: new Date().toISOString() }
				emit({
					type: 'rebuild_ok',
					ms: lastRebuild.ms,
					buildId: active.id,
					restarted: false,
				})
				if (assetsChanged || prebuild) {
					liveReloadHub.broadcast({
						event: 'reload',
						data: { buildId: active.id },
					})
				}
				return
			}
			const generation = await startGeneration(bundle, client)
			if (closed) {
				await stopGeneration(generation)
				return
			}
			const previous = active
			active = generation
			buildFailure = null
			if (previous) retireGeneration(previous)
			lastRuntimeError = null
			lastRebuild = { ms: elapsed(started), at: new Date().toISOString() }
			emit({
				type: 'rebuild_ok',
				ms: lastRebuild.ms,
				buildId: generation.id,
				restarted: true,
			})
			liveReloadHub.broadcast({
				event: 'reload',
				data: { buildId: generation.id },
			})
		} catch (error) {
			buildFailure = toBuildFailure(error)
			buildFailureAt = new Date().toISOString()
			const [first] = buildFailure.diagnostics
			emit({
				type: 'build_error',
				ms: elapsed(started),
				message: buildFailure.message,
				file: first?.file ?? null,
				line: first?.line ?? null,
				col: first?.col ?? null,
				diagnostics: buildFailure.diagnostics,
			})
			liveReloadHub.broadcast({
				event: 'build_error',
				data: buildErrorView(buildFailure),
			})
		}
	}

	let clearWatcherPending: (() => void) | null = null

	async function runPrebuildStep(command: string): Promise<void> {
		prebuildRunning = true
		prebuildAbort = new AbortController()
		let failed = false
		try {
			await runPrebuild({
				command,
				cwd: root,
				signal: prebuildAbort.signal,
				onSpawn: (pid) => reaper.trackGroup(pid),
				onExit: (pid) => reaper.untrackGroup(pid),
				onLine: (line, stream) =>
					emit({
						type: 'log',
						source: 'prebuild',
						level: stream === 'stderr' ? 'warn' : 'log',
						message: redact(line),
						request: null,
					}),
			})
		} catch (error) {
			failed = true
			throw error
		} finally {
			prebuildAbort = undefined
			prebuildRunning = false
			prebuildSettledAt = performance.now()
			// Absorb writes even when prebuild fails — otherwise the 1s poll
			// treats partial/failed output as new edits and loops rebuilds.
			await watcher?.rebaseline()
			if (failed) {
				// Drop chokidar echoes of the failed prebuild / trigger burst so
				// they cannot restart the loop after buildLoop clears.
				changedFiles.clear()
				rebuildAgain = false
				clearWatcherPending?.()
				ignoreWatcherUntil = performance.now() + failedPrebuildAbsorbMs
			}
		}
	}

	async function startGeneration(
		bundle: DevBundle,
		client: DevClientBundle | null,
	): Promise<Generation> {
		const id = ++generationCounter
		const dir = join(workDir, `g${id}`)
		await writeWorkerFiles({
			workDir: dir,
			code: bundle.code,
			packageContext: contextFor(client),
			packageRoot: root,
			mockStorage: options.target === 'mock',
			bridgePort: bridge.port,
			allowPrivateNetwork: options.allowPrivateNetwork,
			apiUrl: options.apiUrl,
			token: options.token,
			org: options.org,
			fetchFn: options.fetchFn,
			depResolve: options.depResolve,
			mockFetchGateway,
			onStatus: options.onStatus,
		})
		let trackedPid: number | undefined
		let workerd: WorkerdHandle
		try {
			workerd = await startWorkerd({
				workerdPath,
				configPath: join(dir, 'config.capnp'),
				cwd: dir,
				env: workerdEnv,
				onSpawn: (pid) => {
					trackedPid = pid
					reaper.track(pid)
				},
				onStdoutLine: (line) => emit(parseWorkerdStdoutLine(line)),
				onStderrLine: (line) => {
					const cleaned = cleanWorkerdStderrLine(line)
					if (cleaned === null) return
					emit({
						type: 'log',
						source: 'workerd',
						level: 'error',
						message: redact(cleaned),
						request: null,
					})
				},
			})
		} catch (error) {
			// onSpawn tracks before listen; a failed start never reaches the
			// exited/untrack path, so drop the pid here before pid reuse.
			if (trackedPid !== undefined) reaper.untrack(trackedPid)
			await rm(dir, { recursive: true, force: true }).catch(() => {})
			throw error
		}
		const generation: Generation = {
			id,
			dir,
			workerd,
			code: bundle.code,
			client,
			mapStack: createStackMapper({
				sourceMap: bundle.sourceMap,
				userModule: localWorkerModuleNames.user,
			}),
			inflight: 0,
			retired: false,
			stopped: false,
		}
		generations.add(generation)
		void workerd.exited.then((detail) => {
			reaper.untrack(workerd.pid)
			if (closed || generation.retired || active !== generation) return
			active = undefined
			buildFailure = {
				message: `workerd stopped unexpectedly (${detail}). Save a file to restart it.`,
				diagnostics: [],
			}
			options.onError?.(buildFailure.message)
		})
		return generation
	}

	function retireGeneration(generation: Generation): void {
		generation.retired = true
		if (generation.inflight === 0) {
			void stopGeneration(generation)
			return
		}
		setTimeout(() => void stopGeneration(generation), drainTimeoutMs).unref()
	}

	async function stopGeneration(generation: Generation): Promise<void> {
		if (generation.stopped) return
		generation.stopped = true
		generation.retired = true
		await generation.workerd.kill()
		reaper.untrack(generation.workerd.pid)
		generations.delete(generation)
		await rm(generation.dir, { recursive: true, force: true })
	}

	async function waitForBuild(): Promise<void> {
		// Flush any watcher debounce first so a save → immediate fetch cannot
		// slip through on the previous generation while the timer is still open.
		const flush = debounceFlush
		if (flush) await flush
		const pending = buildLoop ?? (active || buildFailure ? null : started)
		if (!pending) return
		await Promise.race([
			pending.catch(() => {}),
			new Promise<void>((resolve) =>
				setTimeout(resolve, rebuildGateMs).unref(),
			),
		])
	}

	function status(): DevServerStatus {
		const [first] = buildFailure?.diagnostics ?? []
		return {
			ok: buildFailure === null && active !== undefined,
			state:
				buildLoop || debouncePending
					? 'building'
					: buildFailure
						? 'build_error'
						: active
							? 'ready'
							: 'starting',
			buildId: active?.id ?? null,
			url: `${hostedUrl}${appBasePath || '/'}`,
			port: address.port,
			basePath: appBasePath,
			target: options.target,
			package: {
				name: options.manifest.name,
				kodyId: options.manifest.kodyId,
				root,
			},
			pid: process.pid,
			startedAt,
			lastRebuild,
			lastError: buildFailure
				? {
						kind: 'build',
						message: buildFailure.message,
						file: first?.file ?? null,
						line: first?.line ?? null,
						col: first?.col ?? null,
						at: buildFailureAt,
					}
				: lastRuntimeError,
		}
	}

	function handleDevRoute(req: IncomingMessage, res: ServerResponse): boolean {
		const pathname = stripMount(
			new URL(req.url ?? '/', hostedUrl).pathname,
			appBasePath,
		)
		if (pathname === devStatusPath) {
			res.writeHead(200, {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store',
			})
			res.end(`${JSON.stringify(status(), null, 2)}\n`)
			return true
		}
		if (!liveReload) return false
		if (pathname === liveReloadEventsPath) {
			liveReloadHub.handleEvents(req, res)
			return true
		}
		if (pathname === liveReloadClientPath) {
			res.writeHead(200, {
				'content-type': 'text/javascript; charset=utf-8',
				'cache-control': 'no-store',
			})
			res.end(liveReloadClientSource)
			return true
		}
		return false
	}

	async function handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const trustedHost = trustedDevHostFromHostedUrl(hostedUrl)
			if (
				!isAllowedDevHost({
					incomingHost: req.headers.host,
					trustedHost,
					aliases: options.hostAliases,
				})
			) {
				res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
				res.end(
					`Unrecognized Host ${JSON.stringify(req.headers.host ?? '')}. ` +
						`Open the URL kody dev printed (${hostedUrl}).\n`,
				)
				return
			}
			if (handleDevRoute(req, res)) return
			await waitForBuild()
			const assetPath = parseDevAssetPath(
				stripMount(new URL(req.url ?? '/', hostedUrl).pathname, appBasePath),
			)
			if (assetPath !== null) {
				const client = active?.client ?? null
				await serveDevAsset({
					req,
					res,
					relativePath: assetPath,
					assetsDir,
					client,
					clientModuleUrl: client ? clientModuleUrlFor(client) : null,
					appBasePath,
				})
				return
			}
			if (buildFailure) {
				sendDevError(req, res, 500, buildErrorView(buildFailure), {
					htmlTail: errorPageTail,
				})
				return
			}
			const generation = active
			if (!generation) {
				res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
				res.end(
					closed
						? 'kody dev is shutting down.\n'
						: 'kody dev is still starting.\n',
				)
				return
			}
			generation.inflight += 1
			try {
				await forwardRequest(generation, req, res)
			} finally {
				generation.inflight -= 1
				if (generation.retired && generation.inflight === 0) {
					void stopGeneration(generation)
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			options.onError?.(`Dev proxy error: ${message}`)
			if (!res.headersSent) {
				res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
				res.end(`Dev proxy error: ${message}\n`)
			} else if (!res.writableEnded) {
				res.destroy()
			}
		}
	}

	function forwardRequest(
		generation: Generation,
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const trustedHost = trustedDevHostFromHostedUrl(hostedUrl)
		const incomingUrl = new URL(req.url ?? '/', hostedUrl)
		const restPath = stripMount(incomingUrl.pathname, appBasePath)
		const publicUrl = buildTrustedDevPublicUrl({
			hostedUrl,
			restPath,
			search: incomingUrl.search,
		})
		const forwardUrl = new URL(
			buildTrustedDevForwardUrl({
				baseUrl: `http://127.0.0.1:${generation.workerd.port}`,
				restPath,
				search: incomingUrl.search,
			}),
		)
		const tag: DevRequestTag = {
			id: String(++requestCounter),
			method: req.method ?? 'GET',
			path: restPath + incomingUrl.search,
		}
		const headers = buildDevProxyUpstreamHeaders({
			incoming: req.headers,
			trustedHost,
			publicUrl,
			runSecret,
			requestId: tag.id,
		})
		return new Promise<void>((resolve, reject) => {
			const upstream = httpRequest(
				forwardUrl,
				{ method: req.method, headers },
				(upstreamRes) => {
					if (upstreamRes.headers[devErrorHeader]) {
						void readStream(upstreamRes)
							.then((raw) => {
								respondWithRuntimeError(generation, req, res, tag, raw)
								resolve()
							})
							.catch(reject)
						return
					}
					const status = upstreamRes.statusCode ?? 502
					if (status >= 500) {
						emit({
							type: 'log',
							source: 'app',
							level: 'warn',
							message: `responded HTTP ${status}`,
							request: tag,
						})
					}
					if (
						liveReload &&
						shouldInjectLiveReload({
							method: req.method,
							accept: req.headers.accept,
							status,
							headers: upstreamRes.headers,
						})
					) {
						void readStream(upstreamRes)
							.then((html) => {
								const body = Buffer.from(injectLiveReloadScript(html), 'utf8')
								const headers = { ...upstreamRes.headers }
								delete headers['transfer-encoding']
								headers['content-length'] = String(body.length)
								res.writeHead(status, headers)
								res.end(body)
								resolve()
							})
							.catch(reject)
						return
					}
					res.writeHead(status, upstreamRes.headers)
					upstreamRes.pipe(res)
					upstreamRes.on('end', () => resolve())
					upstreamRes.on('error', reject)
				},
			)
			upstream.on('error', reject)
			res.on('close', () => {
				if (!res.writableFinished) upstream.destroy()
				resolve()
			})
			req.pipe(upstream)
		})
	}

	function respondWithRuntimeError(
		generation: Generation,
		req: IncomingMessage,
		res: ServerResponse,
		tag: DevRequestTag,
		raw: string,
	): void {
		let message = 'Uncaught error'
		let stack = ''
		try {
			const parsed = JSON.parse(raw) as {
				name?: string
				message?: string
				stack?: string
			}
			message = `${parsed.name ?? 'Error'}: ${parsed.message ?? ''}`
			stack = parsed.stack ?? message
		} catch {
			stack = raw
		}
		const mapped = redact(generation.mapStack(stack))
		const fix = runtimeErrorFix(message)
		lastRuntimeError = {
			kind: 'runtime',
			message: redact(message),
			stack: mapped,
			request: tag,
			...(fix ? { fix } : {}),
			at: new Date().toISOString(),
		}
		emit({
			type: 'runtime_error',
			message: redact(message),
			stack: mapped,
			request: tag,
			...(fix ? { fix } : {}),
		})
		const view: DevErrorView = {
			kind: 'runtime',
			title: redact(message),
			detail: fix ? `${mapped}\n\nfix: ${fix}` : mapped,
			request: `${tag.method} ${tag.path}`,
		}
		liveReloadHub.broadcast({ event: 'runtime_error', data: view })
		sendDevError(req, res, 500, view, { htmlTail: errorPageTail })
	}

	const watcher: DevWatcher | null =
		options.watch === false
			? null
			: (() => {
					const pending = new Set<string>()
					clearWatcherPending = () => {
						pending.clear()
						clearTimeout(debounceTimer)
						debouncePending = false
						const resolve = resolveDebounceFlush
						resolveDebounceFlush = null
						debounceFlush = null
						resolve?.()
					}
					return createDevWatcher({
						root,
						ignore: options.manifest.dev?.ignore,
						onChange: (path) => {
							if (closed) return
							const now = performance.now()
							// Soft absorb: fingerprint already advanced by the
							// poller — prebuild's own writes / brief settle chatter.
							if (
								prebuildRunning ||
								now - prebuildSettledAt < prebuildSettleMs
							) {
								return
							}
							// Hard defer after a *failed* prebuild: leave the
							// poll fingerprint so a real save in this window is
							// seen again after absorb (Bugbot: do not drop).
							if (now < ignoreWatcherUntil) {
								return false
							}
							// Fold mid-build watcher events into the active loop
							// (including another save of a file already building).
							// Debouncing them instead schedules a second rebuild
							// after buildLoop clears (often a no-op echo).
							if (buildLoop) {
								changedFiles.add(path)
								rebuildAgain = true
								return
							}
							pending.add(path)
							debouncePending = true
							if (!debounceFlush) {
								debounceFlush = new Promise<void>((resolve) => {
									resolveDebounceFlush = resolve
								})
							}
							clearTimeout(debounceTimer)
							debounceTimer = setTimeout(() => {
								const paths = [...pending]
								pending.clear()
								debouncePending = false
								// Start the build before releasing waiters so
								// waitForBuild sees buildLoop, not a ready gap.
								const build = requestBuild(paths)
								const resolve = resolveDebounceFlush
								resolveDebounceFlush = null
								debounceFlush = null
								resolve?.()
								void build
							}, options.debounceMs ?? defaultDebounceMs)
						},
					})
				})()

	const close = async () => {
		if (closed) return
		closed = true
		process.off('exit', killAllSync)
		clearTimeout(debounceTimer)
		debouncePending = false
		const resolve = resolveDebounceFlush
		resolveDebounceFlush = null
		debounceFlush = null
		resolve?.()
		prebuildAbort?.abort()
		await watcher?.close()
		await buildLoop?.catch(() => {})
		await bundler.dispose()
		await clientBundler?.dispose()
		await Promise.all(
			[...generations].map((generation) => stopGeneration(generation)),
		)
		reaper.close()
		await bridge.close()
		liveReloadHub.close()
		proxy.closeAllConnections()
		await new Promise<void>((resolve) => {
			proxy.close(() => resolve())
		})
		await rm(workDir, { recursive: true, force: true })
	}

	try {
		await Promise.all([requestBuild([]), watcher?.ready])
	} catch (error) {
		await close()
		throw error
	} finally {
		markStarted()
	}
	if (options.watch === false && buildFailure) {
		const message = (buildFailure as BuildFailure).message
		await close()
		throw new Error(message)
	}
	if (active)
		options.onStatus?.(`App ready at ${hostedUrl}${appBasePath || '/'}`)

	const fetchPath: PackageAppDevServer['fetchPath'] = async (
		path,
		init = {},
	) => {
		const url = new URL(joinUrlPath(appBasePath, path), hostedUrl)
		const response = await fetch(url, {
			method: init.method ?? 'GET',
			headers: init.headers,
			body: init.body,
		})
		const body = await response.text()
		const headers: Record<string, string> = {}
		response.headers.forEach((value, key) => {
			headers[key] = value
		})
		return { status: response.status, headers, body }
	}

	return {
		url: hostedUrl,
		port: address.port,
		hostedUrl,
		appBasePath,
		get packageContext() {
			return contextFor(active?.client ?? null)
		},
		fetchPath,
		status,
		close,
	}
}

function elapsed(started: number): number {
	return Math.round(performance.now() - started)
}

function toBuildFailure(error: unknown): BuildFailure {
	if (error instanceof BundleError) {
		return { message: error.message, diagnostics: error.diagnostics }
	}
	return {
		message: redact(error instanceof Error ? error.message : String(error)),
		diagnostics: [],
	}
}

function buildErrorView(failure: BuildFailure): DevErrorView {
	const [first] = failure.diagnostics
	return {
		kind: 'build',
		title: first
			? `${first.file ?? 'bundle'}${first.line !== null ? `:${first.line}:${first.col}` : ''} ${first.message}`
			: (failure.message.split('\n')[0] ?? 'Build failed'),
		detail:
			failure.diagnostics.length > 0
				? failure.diagnostics.map(formatBundleDiagnostic).join('\n\n')
				: failure.message,
	}
}

async function readStream(stream: IncomingMessage): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of stream) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

async function writeWorkerFiles(input: {
	workDir: string
	code: string
	packageContext: PackageLocalContext
	packageRoot?: string
	mockStorage: boolean
	bridgePort: number
	allowPrivateNetwork?: boolean
	apiUrl: string
	token: string
	org?: string
	fetchFn?: typeof fetch
	depResolve?: PackageAppDevOptions['depResolve']
	mockFetchGateway?: MockFetchGateway
	onStatus?: (message: string) => void
}): Promise<void> {
	await mkdir(input.workDir, { recursive: true })
	const packageGraph = await resolveLocalPackageGraph({
		code: input.code,
		apiUrl: input.apiUrl,
		token: input.token,
		...(input.org ? { org: input.org } : {}),
		fetchFn: input.fetchFn,
		...(input.depResolve ? { depResolve: input.depResolve } : {}),
		...(input.packageRoot ? { packageRoot: input.packageRoot } : {}),
		onStatus: input.onStatus,
	})
	const files = { entry: 'entry.js', user: 'main.js', runtime: 'runtime.js' }
	let packageModules = await writePackageModuleFiles(
		input.workDir,
		packageGraph,
		writeFile,
		join,
	)
	let gatewayFetchShimModules: Array<string> = packageGraph.modules
		.map((module) => module.name)
		.filter((name) => name === localExecuteGatewayFetchShimModuleName)
	if (input.mockFetchGateway) {
		const installed = await installMockFetchShimModules({
			workDir: input.workDir,
			packageModules,
		})
		packageModules = installed.packageModules
		gatewayFetchShimModules = installed.sideEffectModules
	}
	await writeFile(
		join(input.workDir, files.entry),
		createPackageAppEntrySource({ sideEffectModules: gatewayFetchShimModules }),
	)
	await writeFile(join(input.workDir, files.user), input.code)
	await writeFile(
		join(input.workDir, files.runtime),
		createPackageLocalRuntimeModuleSource({
			packageContext: input.packageContext,
			mockStorage: input.mockStorage,
		}),
	)
	await writeFile(
		join(input.workDir, localWorkerModuleNames.runtimeFlatAlias),
		createRuntimeFlatAliasSource(),
	)
	await writeFile(
		join(input.workDir, 'config.capnp'),
		createWorkerdConfig({
			bridgePort: input.bridgePort,
			files,
			packageModules,
			allowPrivateNetwork: input.allowPrivateNetwork,
		}),
	)
}

function normalizeBasePath(value: string): string {
	const trimmed = value.trim()
	if (!trimmed || trimmed === '/') return ''
	const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
	return withSlash.replace(/\/+$/, '')
}

function stripMount(pathname: string, appBasePath: string): string {
	if (!appBasePath) return pathname || '/'
	if (pathname === appBasePath) return '/'
	if (pathname.startsWith(`${appBasePath}/`)) {
		return pathname.slice(appBasePath.length) || '/'
	}
	return pathname || '/'
}

function joinUrlPath(base: string, path: string): string {
	const rest = path.startsWith('/') ? path : `/${path}`
	if (!base) return rest
	return `${base}${rest === '/' ? '' : rest}` || base
}

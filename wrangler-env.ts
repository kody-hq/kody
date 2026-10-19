import { type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import getPort from 'get-port'
import {
	signalChildProcessTree,
	spawnChildProcess,
	stopChildProcessTree,
} from './tools/dev-process-utils.ts'
import { resolveLocalBinary } from './tools/node-runtime.ts'
import { ensureWorkerBundlerModules } from './tools/build-worker-bundler-modules.ts'
import { ensureGuideCatalogModules } from './tools/build-guide-catalog-modules.ts'
import { ensureWranglerFiltersKodyGeneratedWatch } from './tools/wrangler-filter-kody-generated-watch.ts'
import {
	getDefaultWranglerConfigPath,
	highlightWorkerWranglerConfigPath,
	jobsWorkerWranglerConfigPath,
	resolveWranglerConfigPath,
} from './tools/wrangler-env-config.ts'
import { writeLocalSiblingDevConfig } from './tools/local-sibling-dev-config.ts'
import { writeRuntimeDryRunConfig } from './tools/local-runtime-dry-run-config.ts'
import {
	isWranglerD1MigrationsApply,
	runWranglerDeployWithRetry,
	wranglerD1MigrationsRetryBaseDelayMs,
	wranglerD1MigrationsRetryMaxAttempts,
} from './tools/ci/retry-classifiers.ts'

const envName = process.env.CLOUDFLARE_ENV ?? 'production'
const portWaitTimeoutMs = 5000
const args = process.argv.slice(2)
const defaultWranglerConfigPath = getDefaultWranglerConfigPath()

const hasEnvFlag = args.includes('--env') || args.includes('-e')
const isDevCommand = args[0] === 'dev'
const hasPortFlag = args.includes('--port')
const hasConfigFlag = args.some(
	(arg) => arg === '--config' || arg.startsWith('--config='),
)
const hasInspectorPortFlag = args.some(
	(arg) => arg === '--inspector-port' || arg.startsWith('--inspector-port='),
)

const commandArgs = [...args]
let shouldAddRuntimeDevConfig = false
let shouldAddPlatformDevConfig = false

if (
	!hasConfigFlag &&
	existsSync(
		resolveWranglerConfigPath(defaultWranglerConfigPath, process.cwd()),
	)
) {
	commandArgs.push('--config', defaultWranglerConfigPath)
	// Multi-worker local dev (ADR 0016): the main worker's JOBS service
	// binding targets the jobs worker, so `wrangler dev` runs both configs
	// together and resolves the service bindings in-process.
	if (
		isDevCommand &&
		existsSync(
			resolveWranglerConfigPath(jobsWorkerWranglerConfigPath, process.cwd()),
		)
	) {
		commandArgs.push('--config', jobsWorkerWranglerConfigPath)
	}
	if (
		isDevCommand &&
		existsSync(
			resolveWranglerConfigPath(
				highlightWorkerWranglerConfigPath,
				process.cwd(),
			),
		)
	) {
		commandArgs.push('--config', highlightWorkerWranglerConfigPath)
	}
	// Multi-worker local dev (ADR 0016): the main worker's production env
	// binds the runtime worker (RUNTIME_WORKER service binding plus
	// cross-script Durable Objects), so `wrangler dev` runs both scripts in
	// one Miniflare via a secondary --config, which resolves those bindings
	// locally. The secondary config is a generated local-dev variant (see
	// tools/local-sibling-dev-config.ts) because wrangler applies `--var`
	// only to the primary config, registers workers under `<name>-<env>`,
	// and treats a secondary `ai` binding as always-remote.
	const runtimeWorkerConfigPath = 'packages/runtime-worker/wrangler.jsonc'
	// The test env runs the runtime lane in-process (no RUNTIME_WORKER
	// binding), and the runtime config defines no test env.
	if (
		args[0] === 'dev' &&
		envName !== 'test' &&
		existsSync(
			resolveWranglerConfigPath(runtimeWorkerConfigPath, process.cwd()),
		)
	) {
		shouldAddRuntimeDevConfig = true
	}
	const platformWorkerConfigPath = 'packages/platform-worker/wrangler.jsonc'
	if (
		args[0] === 'dev' &&
		envName !== 'test' &&
		existsSync(
			resolveWranglerConfigPath(platformWorkerConfigPath, process.cwd()),
		)
	) {
		shouldAddPlatformDevConfig = true
	}
}

// The main worker config references pre-bundled modules in
// `packages/worker/.generated/` (worker-bundler) and `src/generated/`
// (guide catalog); see tools/build-worker-bundler-modules.ts and
// tools/build-guide-catalog-modules.ts. Make sure they exist before any
// wrangler command that builds the worker. Skipped for explicit `--config`
// invocations (mock servers, backup control plane) which don't use them —
// except the runtime worker, whose entry module lives in the same source
// tree as the main worker and imports the same generated modules.
const isWorkerBuildCommand = ['dev', 'build', 'deploy', 'versions'].includes(
	args[0] ?? '',
)
const configArgValue = getArgValue(args, '--config')
const isRuntimeWorkerConfig = Boolean(
	configArgValue?.includes('runtime-worker'),
)
const isPlatformWorkerConfig = Boolean(
	configArgValue?.includes('platform-worker'),
)
const isDefaultWorkerConfig =
	configArgValue !== undefined &&
	resolveWranglerConfigPath(configArgValue, process.cwd()) ===
		resolveWranglerConfigPath(defaultWranglerConfigPath, process.cwd())
if (
	isWorkerBuildCommand &&
	(!hasConfigFlag ||
		isDefaultWorkerConfig ||
		isRuntimeWorkerConfig ||
		isPlatformWorkerConfig)
) {
	await ensureWorkerBundlerModules()
	await ensureGuideCatalogModules()
	if (isDevCommand) {
		await ensureWranglerFiltersKodyGeneratedWatch()
	}
}

if (!hasEnvFlag) {
	commandArgs.push('--env', envName)
}

if (isDevCommand) {
	commandArgs.push('--var', 'WRANGLER_IS_LOCAL_DEV:true')
}

if (
	isDevCommand &&
	envName === 'test' &&
	!args.includes('--live-reload') &&
	!args.some((arg) => arg.startsWith('--live-reload='))
) {
	// Playwright / MCP e2e do not edit worker source. HTML live-reload
	// still arms wrangler's additional-module watcher; bundler artifacts
	// live under `src/node_modules/.kody-generated/` and that collector's
	// watchFiles / watchDirs are cleared (Friction #1789).
	commandArgs.push('--live-reload', 'false')
}

let resolvedPort = process.env.PORT

if (isDevCommand && hasPortFlag) {
	resolvedPort = getPortArg(args) ?? resolvedPort
}

if (isDevCommand && !hasPortFlag) {
	if (process.env.PORT) {
		resolvedPort = process.env.PORT
	} else {
		const desiredPort = 3742
		const portRange = Array.from(
			{ length: 10 },
			(_, index) => desiredPort + index,
		)
		resolvedPort = String(
			await getPort({
				port: portRange,
			}),
		)
	}
	commandArgs.push('--port', resolvedPort)
}

if (isDevCommand && !hasInspectorPortFlag) {
	const parsedPort = resolvedPort ? Number.parseInt(resolvedPort, 10) : NaN
	const inspectorPortRange = Number.isFinite(parsedPort)
		? (() => {
				const preferredBase =
					parsedPort + 10_000 <= 65_535
						? parsedPort + 10_000
						: parsedPort - 10_000
				const safeBase = Math.max(1, preferredBase)
				return Array.from(
					{ length: 10 },
					(_, index) => safeBase + index,
				).filter((port) => port > 0 && port <= 65_535)
			})()
		: undefined
	const resolvedInspectorPort = String(
		await getPort({
			host: '127.0.0.1',
			...(inspectorPortRange ? { port: inspectorPortRange } : {}),
		}),
	)
	commandArgs.push('--inspector-port', resolvedInspectorPort)
}

if (shouldAddRuntimeDevConfig) {
	const runtimeDevConfigPath = await writeLocalSiblingDevConfig({
		configPath: 'packages/runtime-worker/wrangler.jsonc',
		envName,
		mainWorkerDevName: `kody-${envName}`,
		port: resolvedPort,
	})
	commandArgs.push('--config', runtimeDevConfigPath)
}

if (shouldAddPlatformDevConfig) {
	const platformDevConfigPath = await writeLocalSiblingDevConfig({
		configPath: 'packages/platform-worker/wrangler.jsonc',
		envName,
		mainWorkerDevName: `kody-${envName}`,
		port: resolvedPort,
		dropAlwaysRemoteBindings: ['ai', 'artifacts'],
	})
	commandArgs.push('--config', platformDevConfigPath)
}

const processEnv = {
	...process.env,
	CLOUDFLARE_ENV: envName,
	...(resolvedPort ? { PORT: resolvedPort } : {}),
	...(isDevCommand
		? {
				// Wrangler 4.127+ enables Miniflare's local explorer by default.
				// On Cloud Agent / CI hosts, explorer writes under `.wrangler/tmp`
				// retrigger esbuild and leave ProxyWorker in a pause/reload
				// loop. Opt in with X_LOCAL_EXPLORER=true.
				X_LOCAL_EXPLORER: process.env.X_LOCAL_EXPLORER ?? 'false',
			}
		: {}),
	...(envName === 'test'
		? {
				X_LOCAL_OBSERVABILITY: process.env.X_LOCAL_OBSERVABILITY ?? 'false',
				WRANGLER_CI_DISABLE_CONFIG_WATCHING:
					process.env.WRANGLER_CI_DISABLE_CONFIG_WATCHING ?? 'true',
				// Overlay FS retriggers esbuild's native source-graph watcher
				// after the first compile (Friction #1789). Playwright does not
				// edit worker source; skip that watch in the test env.
				WRANGLER_DISABLE_BUNDLE_WATCH:
					process.env.WRANGLER_DISABLE_BUNDLE_WATCH ?? 'true',
			}
		: {}),
}

const localWranglerPath = path.join(
	process.cwd(),
	'node_modules',
	'.bin',
	process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
)
const wranglerCommand =
	(existsSync(localWranglerPath) && localWranglerPath) ||
	resolveLocalBinary('wrangler')

if (
	args[0] === 'deploy' &&
	args.includes('--dry-run') &&
	isRuntimeWorkerConfig &&
	configArgValue
) {
	const dryRunConfigPath = await writeRuntimeDryRunConfig({
		runtimeConfigPath: resolveWranglerConfigPath(configArgValue, process.cwd()),
		envName,
	})
	replaceConfigArg(commandArgs, dryRunConfigPath)
}

if (args[0] === 'deploy') {
	const deployResult = await runWranglerDeployWithRetry({
		command: wranglerCommand,
		args: commandArgs,
		env: processEnv,
	})
	process.exitCode = deployResult.status
} else if (isWranglerD1MigrationsApply(args)) {
	// Production `d1 migrations apply` talks to the Cloudflare API before
	// any worker upload. A one-shot Wrangler "fetch failed" connectivity
	// flake failed AUDIT_DB after APP_DB succeeded (main 2026-10-02).
	// Apply is idempotent, so reuse the deploy retry helper.
	const migrateResult = await runWranglerDeployWithRetry({
		command: wranglerCommand,
		args: commandArgs,
		env: processEnv,
		maxAttempts: wranglerD1MigrationsRetryMaxAttempts,
		baseDelayMs: wranglerD1MigrationsRetryBaseDelayMs,
	})
	process.exitCode = migrateResult.status
} else {
	await runAttachedWranglerProcess()
}

async function runAttachedWranglerProcess() {
	const proc = spawnChildProcess(wranglerCommand, commandArgs, {
		stdio: ['inherit', 'inherit', 'inherit'],
		env: processEnv,
	})
	const procExited = createExitPromise(proc)

	let isShuttingDown = false

	process.once('exit', () => {
		signalChildProcessTree(proc, 'SIGTERM')
	})

	function handleSignal(signal: NodeJS.Signals) {
		if (isShuttingDown) return
		isShuttingDown = true
		void (async () => {
			await stopChildProcessTree(proc, {
				sigintTimeoutMs: signal === 'SIGINT' ? 5000 : 0,
				sigtermTimeoutMs: 5000,
				sigkillTimeoutMs: 1000,
			})
			// A signal-initiated shutdown is a normal stop (Ctrl+C, supervisor
			// stop), not a failure; exiting 1 here fails CI steps that stop the
			// dev server deliberately.
			process.exit(0)
		})()
	}

	process.on('SIGINT', () => handleSignal('SIGINT'))
	process.on('SIGTERM', () => handleSignal('SIGTERM'))

	let exitCode: number | null
	try {
		exitCode = await procExited
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(1)
	}
	if (isDevCommand && resolvedPort) {
		const didFreePort = await waitForPortFree(
			Number.parseInt(resolvedPort, 10),
			portWaitTimeoutMs,
		)
		if (!didFreePort) {
			console.warn(
				`Timed out waiting for port ${resolvedPort} to free up before exit.`,
			)
		}
	}
	process.exitCode = exitCode ?? 1
}

function createExitPromise(proc: ChildProcess) {
	return new Promise<number | null>((resolve, reject) => {
		proc.once('error', reject)
		proc.once('exit', (code) => resolve(code))
	})
}

function getPortArg(argumentList: ReadonlyArray<string>) {
	return getArgValue(argumentList, '--port')
}

function replaceConfigArg(argumentList: Array<string>, nextPath: string) {
	const inlineIndex = argumentList.findIndex((arg) =>
		arg.startsWith('--config='),
	)
	if (inlineIndex >= 0) {
		argumentList[inlineIndex] = `--config=${nextPath}`
		return
	}
	const flagIndex = argumentList.findIndex((arg) => arg === '--config')
	if (flagIndex >= 0 && argumentList[flagIndex + 1]) {
		argumentList[flagIndex + 1] = nextPath
		return
	}
	argumentList.push('--config', nextPath)
}

function getArgValue(argumentList: ReadonlyArray<string>, flagName: string) {
	const inlineArg = argumentList.find((arg) => arg.startsWith(`${flagName}=`))
	if (inlineArg) {
		const separatorIndex = inlineArg.indexOf('=')
		const value =
			separatorIndex >= 0 ? inlineArg.slice(separatorIndex + 1) : undefined
		return value || undefined
	}

	const flagIndex = argumentList.findIndex((arg) => arg === flagName)
	if (flagIndex >= 0) {
		const value = argumentList[flagIndex + 1]
		return value || undefined
	}

	return undefined
}

async function waitForPortFree(port: number, timeoutMs: number) {
	const start = Date.now()
	while (await isPortInUse(port)) {
		if (Date.now() - start >= timeoutMs) {
			return false
		}
		await delay(100)
	}
	return true
}

function isPortInUse(port: number) {
	return new Promise<boolean>((resolve) => {
		const socket = new net.Socket()

		const finish = (inUse: boolean) => {
			socket.removeAllListeners()
			socket.destroy()
			resolve(inUse)
		}

		socket.setTimeout(250)
		socket.once('connect', () => finish(true))
		socket.once('timeout', () => finish(true))
		socket.once('error', (error) => {
			if ('code' in error && error.code === 'ECONNREFUSED') {
				finish(false)
				return
			}
			finish(true)
		})

		socket.connect(port, '127.0.0.1')
	})
}

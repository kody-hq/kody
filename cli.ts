import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { platform } from 'node:os'
import readline from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import getPort, { clearLockedPorts } from 'get-port'
import {
	spawnInOwnProcessGroup,
	stopChildProcessTree,
} from './tools/dev-process-utils.ts'
import {
	createProcessOutputController,
	type ProcessOutputMode,
} from './tools/dev-process-output.ts'
import {
	defaultWorkerPort,
	isWorkerHealthOk,
	workerPortRange,
} from './tools/dev-server.ts'
import { resolveNpmCommand } from './tools/node-runtime.ts'
const defaultMockPort = 8788
const mockReadyTimeoutMs = 10_000
const mockReadyPollMs = 200
const workerReadyTimeoutMs = 90_000
const workerReadyPollMs = 250

const ansiReset = '\x1b[0m'
const ansiBright = '\x1b[1m'
const ansiDim = '\x1b[2m'
const colorCodes = {
	cyan: '\x1b[36m',
	green: '\x1b[32m',
	cornflowerblue: '\x1b[38;2;100;149;237m',
	yellow: '\x1b[33m',
	orange: '\x1b[38;2;255;165;0m',
	magenta: '\x1b[35m',
	firebrick: '\x1b[38;2;178;34;34m',
} as const

function colorize(text: string, color: keyof typeof colorCodes) {
	const colorCode = colorCodes[color] ?? ''
	return colorCode ? `${colorCode}${text}${ansiReset}` : text
}

function bright(text: string) {
	return `${ansiBright}${text}${ansiReset}`
}

function dim(text: string) {
	return `${ansiDim}${text}${ansiReset}`
}

type OutputFilterKey = 'client' | 'worker' | 'default'

type ChildOutputConfig = {
	filterKey?: OutputFilterKey
	label?: string
	mode?: ProcessOutputMode
	cwd?: string
}

type ResolvedChildOutputConfig = Required<Omit<ChildOutputConfig, 'cwd'>>

const outputFilters: Record<OutputFilterKey, Array<RegExp>> = {
	client: [],
	worker: [],
	default: [],
}

const extraArgs = process.argv.slice(2)
let shutdown: (() => void) | null = null
let devChildren: Array<ChildProcess> = []
let workerOrigin = ''
let mockCloudflareProcess: ChildProcess | null = null
let mockEnvOverrides: Record<string, string> = {}

void startDev().catch((error) => {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
})

async function startDev() {
	const ready = await restartDev({ announce: false })
	setupInteractiveCli({
		getWorkerOrigin: () => workerOrigin,
		restart: restartDev,
		ready,
	})
	shutdown = setupShutdown(
		() => devChildren,
		() => [mockCloudflareProcess].filter(Boolean) as Array<ChildProcess>,
	)
}

function resolveWorkerOrigin(port: number) {
	const envOrigin = process.env.WORKER_DEV_ORIGIN
	if (envOrigin) return envOrigin.trim()
	return `http://127.0.0.1:${port}`
}

function runNpmScript(
	script: string,
	args: Array<string> = [],
	envOverrides: Record<string, string> = {},
	options: ChildOutputConfig = {},
): ChildProcess {
	const outputConfig = {
		filterKey: options.filterKey ?? 'default',
		label: options.label ?? script,
		mode: options.mode ?? 'live',
	} satisfies ResolvedChildOutputConfig
	const child = spawnInOwnProcessGroup(
		resolveNpmCommand(),
		['run', '--silent', script, '--', ...args],
		{
			stdio: ['inherit', 'pipe', 'pipe'],
			cwd: options.cwd,
			env: { ...process.env, ...envOverrides },
		},
	)

	pipeOutput(child, {
		...outputConfig,
	})

	child.on('exit', (code, signal) => {
		if (signal) return
		if (code && code !== 0) {
			process.exitCode = code
		}
	})

	return child
}

function pipeOutput(child: ChildProcess, options: ResolvedChildOutputConfig) {
	const controller = createProcessOutputController({
		label: options.label,
		mode: options.mode,
		filters: outputFilters[options.filterKey],
	})

	if (child.stdout) {
		pipeStream(child.stdout, 'stdout', controller.writeLine)
	}
	if (child.stderr) {
		pipeStream(child.stderr, 'stderr', controller.writeLine)
	}

	child.on('close', (code, signal) => {
		controller.handleExit({ code, signal })
	})
}

function pipeStream(
	source: NodeJS.ReadableStream,
	target: 'stdout' | 'stderr',
	writeLine: (target: 'stdout' | 'stderr', line: string) => void,
) {
	const rl = readline.createInterface({ input: source })
	rl.on('line', (line) => {
		writeLine(target, line)
	})
}

function setupShutdown(
	getChildren: () => Array<ChildProcess>,
	getMockProcesses: () => Array<ChildProcess>,
) {
	let isShuttingDown = false
	function doShutdown() {
		if (isShuttingDown) return
		isShuttingDown = true
		console.log(dim('\nShutting down...'))
		const children = getChildren().filter((child) => child.exitCode === null)
		for (const mockProcess of getMockProcesses()) {
			if (mockProcess.exitCode === null) {
				children.push(mockProcess)
			}
		}
		void (async () => {
			await Promise.all(children.map((child) => stopChild(child)))
			process.exit(0)
		})()
	}

	process.on('SIGINT', doShutdown)
	process.on('SIGTERM', doShutdown)
	return doShutdown
}

function setupInteractiveCli(options: {
	getWorkerOrigin: () => string
	restart: () => Promise<boolean>
	ready: boolean
}) {
	const stdin = process.stdin
	let ready = options.ready
	if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
		if (ready) logAppRunning(options.getWorkerOrigin)
		return
	}

	showHelp()
	if (ready) logAppRunning(options.getWorkerOrigin)

	readline.emitKeypressEvents(stdin)
	stdin.setRawMode(true)
	stdin.resume()

	stdin.on('keypress', (_key, key) => {
		if (key?.ctrl && key.name === 'c') {
			shutdown?.()
			return
		}

		if (key?.name === 'return') {
			process.stdout.write('\n')
			return
		}

		switch (key?.name) {
			case 'o': {
				openInBrowser(options.getWorkerOrigin())
				break
			}
			case 'u': {
				copyToClipboard(options.getWorkerOrigin())
				break
			}
			case 'c': {
				console.clear()
				showHelp()
				if (ready) logAppRunning(options.getWorkerOrigin)
				break
			}
			case 'r': {
				ready = false
				void options.restart().then((nextReady) => {
					ready = nextReady
				})
				break
			}
			case 'h':
			case '?': {
				showHelp()
				break
			}
			case 'q': {
				shutdown?.()
				break
			}
		}
	})
}

function showHelp(header?: string) {
	if (header) console.log(header)
	console.log(`\n${bright('CLI shortcuts:')}`)
	console.log(
		`  ${colorize('o', 'cyan')} - ${colorize('open browser', 'green')}`,
	)
	console.log(
		`  ${colorize('u', 'cyan')} - ${colorize('copy URL', 'cornflowerblue')}`,
	)
	console.log(
		`  ${colorize('c', 'cyan')} - ${colorize('clear console', 'yellow')}`,
	)
	console.log(`  ${colorize('r', 'cyan')} - ${colorize('restart', 'orange')}`)
	console.log(`  ${colorize('h', 'cyan')} - ${colorize('help', 'magenta')}`)
	console.log(`  ${colorize('q', 'cyan')} - ${colorize('quit', 'firebrick')}`)
}

async function restartDev(
	{ announce }: { announce: boolean } = { announce: true },
) {
	await stopChildren(devChildren)
	const mockEnv = await ensureMockServers()
	const desiredPort = Number.parseInt(
		process.env.PORT ?? String(defaultWorkerPort),
		10,
	)
	const portRange = workerPortRange(desiredPort)
	clearLockedPorts()
	const workerPort = await getPort({ port: portRange })
	workerOrigin = resolveWorkerOrigin(workerPort)
	const worker = runNpmScript(
		'dev:vite',
		['--host', '127.0.0.1', '--port', String(workerPort), ...extraArgs],
		{
			PORT: String(workerPort),
			WRANGLER_IS_LOCAL_DEV: 'true',
			X_LOCAL_EXPLORER: process.env.X_LOCAL_EXPLORER ?? 'false',
			CLOUDFLARE_ENV: process.env.CLOUDFLARE_ENV?.trim() || 'production',
			...mockEnv,
		},
		{
			filterKey: 'worker',
			label: 'vite',
			mode: 'live',
		},
	)
	const workerDidStart = await waitForWorkerReady(workerOrigin, worker)
	if (!workerDidStart) {
		console.warn(
			`Vite origin did not become ready within ${workerReadyTimeoutMs}ms; ` +
				`check the vite output above before using ${workerOrigin}.`,
		)
	}
	devChildren = [worker]

	if (announce) {
		console.log(dim('\nRestarted dev servers.'))
		// Only claim the app is running when /health actually responded.
		if (workerDidStart) logAppRunning(() => workerOrigin)
	}
	return workerDidStart
}

function hasEnvValue(value: string | undefined) {
	return typeof value === 'string' && value.trim().length > 0
}

function isChildRunning(child: ChildProcess | null) {
	return Boolean(child && !child.killed && child.exitCode === null)
}

async function isMockReady(baseUrl: string) {
	try {
		const response = await fetch(`${baseUrl}/__mocks/meta`)
		await response.body?.cancel()
		return response.ok
	} catch {
		return false
	}
}

async function waitForMockReady(baseUrl: string, child: ChildProcess) {
	const start = Date.now()
	while (Date.now() - start < mockReadyTimeoutMs) {
		if (child.killed || child.exitCode !== null) {
			return false
		}
		if (await isMockReady(baseUrl)) {
			return true
		}
		await delay(mockReadyPollMs)
	}
	return false
}

async function waitForWorkerReady(workerOrigin: string, child: ChildProcess) {
	const start = Date.now()
	while (Date.now() - start < workerReadyTimeoutMs) {
		if (child.killed || child.exitCode !== null) {
			return false
		}
		// Cold Start requests import the route graph. Aborting after the short
		// discovery timeout can strand that shared initialization in workerd.
		// Give a started server the remaining startup budget to answer.
		if (
			await isWorkerHealthOk(workerOrigin, {
				timeoutMs: Math.max(1, workerReadyTimeoutMs - (Date.now() - start)),
			})
		) {
			return true
		}
		await delay(workerReadyPollMs)
	}
	return false
}

async function attachCloudflareMock(
	mockEnv: Record<string, string>,
	anchorPort: number,
) {
	if (process.env.SKIP_CLOUDFLARE_MOCK?.trim() === '1') {
		return
	}
	if (
		hasEnvValue(mockEnv.CLOUDFLARE_API_BASE_URL) &&
		isChildRunning(mockCloudflareProcess)
	) {
		return
	}
	if (mockCloudflareProcess && !mockCloudflareProcess.killed) {
		await stopChild(mockCloudflareProcess)
		mockCloudflareProcess = null
	}
	const cloudflarePort = await getPort({
		port: Array.from({ length: 20 }, (_, index) => anchorPort + 240 + index),
	})
	const baseUrl = `http://127.0.0.1:${cloudflarePort}`
	const apiToken = `mock-cloudflare-${randomUUID()}`
	const child = runNpmScript(
		'dev:mock-cloudflare',
		[
			'--port',
			String(cloudflarePort),
			'--ip',
			'127.0.0.1',
			'--var',
			`MOCK_API_TOKEN:${apiToken}`,
		],
		{},
		{
			label: 'dev:mock-cloudflare',
			mode: 'buffer-on-error',
		},
	)
	mockCloudflareProcess = child
	child.once('exit', () => {
		if (mockCloudflareProcess === child) {
			mockCloudflareProcess = null
		}
	})
	mockEnv.CLOUDFLARE_API_BASE_URL = baseUrl
	mockEnv.CLOUDFLARE_API_TOKEN = apiToken
	mockEnv.CLOUDFLARE_ACCOUNT_ID = 'cf_account_mock_123'
	mockEnv.CLOUDFLARE_API_SOURCE_SNAPSHOTS = 'true'
	const didStart = await waitForMockReady(baseUrl, child)
	if (!didStart) {
		console.warn(
			`Mock Cloudflare worker did not become ready within ${mockReadyTimeoutMs}ms.`,
		)
	}
	console.log(dim(`Cloudflare mock base URL ${baseUrl}`))
}

async function ensureMockServers() {
	const canReuseCachedCloudflareEnv =
		isChildRunning(mockCloudflareProcess) &&
		hasEnvValue(mockEnvOverrides.CLOUDFLARE_API_BASE_URL) &&
		hasEnvValue(mockEnvOverrides.CLOUDFLARE_API_TOKEN) &&
		hasEnvValue(mockEnvOverrides.CLOUDFLARE_ACCOUNT_ID)

	if (canReuseCachedCloudflareEnv) {
		const cloudflareForAnchor = new URL(
			mockEnvOverrides.CLOUDFLARE_API_BASE_URL ??
				`http://127.0.0.1:${defaultMockPort + 240}`,
		)
		const anchorFromReuse = Number.parseInt(
			cloudflareForAnchor.port || String(defaultMockPort + 240),
			10,
		)
		await attachCloudflareMock(mockEnvOverrides, anchorFromReuse)
		return mockEnvOverrides
	}

	if (mockCloudflareProcess && !mockCloudflareProcess.killed) {
		await stopChild(mockCloudflareProcess)
		mockCloudflareProcess = null
	}
	const desiredPort = Number.parseInt(
		process.env.MOCK_API_PORT ?? String(defaultMockPort),
		10,
	)
	const portRange = Array.from(
		{ length: 10 },
		(_, index) => desiredPort + index,
	)
	const mockPort = await getPort({ port: portRange })
	mockEnvOverrides = {}

	await attachCloudflareMock(mockEnvOverrides, mockPort)

	return mockEnvOverrides
}

async function stopChildren(children: Array<ChildProcess>) {
	await Promise.all(children.map((child) => stopChild(child)))
}

async function stopChild(child: ChildProcess) {
	await stopChildProcessTree(child)
}

function logAppRunning(getOrigin: () => string) {
	console.log(`\n${dim('App running at')} ${bright(getOrigin())}`)
}

function openInBrowser(url: string) {
	const os = platform()
	if (os === 'darwin') {
		spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
		return
	}

	if (os === 'win32') {
		spawn('cmd', ['/c', 'start', url], {
			stdio: 'ignore',
			detached: true,
		}).unref()
		return
	}

	spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
}

function copyToClipboard(text: string) {
	const os = platform()
	if (os === 'darwin') {
		const proc = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
		proc.stdin?.write(text)
		proc.stdin?.end()
		return
	}

	if (os === 'win32') {
		const proc = spawn('clip', [], { stdio: ['pipe', 'ignore', 'ignore'] })
		proc.stdin?.write(text)
		proc.stdin?.end()
		return
	}

	const proc = spawn('xclip', ['-selection', 'clipboard'], {
		stdio: ['pipe', 'ignore', 'ignore'],
	})
	proc.stdin?.write(text)
	proc.stdin?.end()
}

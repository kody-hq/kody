import { startStripeMock } from '../e2e/stripe-mock-server.ts'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import {
	e2eCloudflareMockAccountId,
	writeE2eCloudflareMockState,
} from './e2e-cloudflare-mock-state.ts'
import { isExecutedDirectly, resolveNpmCommand } from './node-runtime.ts'
import { spawnChildProcess, stopChildProcessTree } from './dev-process-utils.ts'
import { workerOriginForPort } from './dev-server.ts'
import {
	createDefaultEnsureDevDeps,
	hasKodyDevListeners,
	type ProcessIdentity,
} from './ensure-dev.ts'

/** Same default as `playwright.config.ts` when `--port` is omitted. */
export const defaultE2eWebServerPort = '3847'

export function resolveE2eWebServerHealthUrl(
	args: ReadonlyArray<string>,
	host = '127.0.0.1',
) {
	const portIndex = args.indexOf('--port')
	const portArg = portIndex === -1 ? undefined : args[portIndex + 1]
	const port =
		portArg && !portArg.startsWith('-') ? portArg : defaultE2eWebServerPort
	return `http://${host}:${port}/health`
}

/**
 * Restart Vite only while the first process has never answered `/health`.
 * After Playwright starts specs, a crash must kill this wrapper so the
 * suite-level dead-server retry can start a fresh run.
 */
function formatUnhealthyOriginDevServerHint() {
	return 'An existing kody `dev:ensure` server is listening but /health is failing. Stop or restart that Vite/workerd process before `npm run test:e2e:run`; a crash-looping origin on 3742–3751 collides with the e2e web server (inspector / fetchWorkerExportTypes). A healthy origin can stay up — e2e isolates on port 3847 with its own persist dir and inspector disabled (#3731). Or set PLAYWRIGHT_BASE_URL to reuse a server.'
}

export async function findUnhealthyOriginDevServerMessage(input: {
	ports: ReadonlyArray<number>
	probeHealth: (origin: string) => Promise<boolean>
	listListenerPids: (port: number) => Array<number>
	readProcess: (pid: number) => ProcessIdentity | null
	protectedPids: ReadonlySet<number>
}) {
	for (const port of input.ports) {
		const hasListener = hasKodyDevListeners({
			...input,
			ports: [port],
		})
		if (!hasListener) continue
		if (await input.probeHealth(workerOriginForPort(port))) continue
		return formatUnhealthyOriginDevServerHint()
	}
	return null
}

export function shouldRetryE2eWebServerFirstStart(input: {
	allowRetry: boolean
	shuttingDown: boolean
	servedHealth: boolean
	exitCode: number | null
}) {
	return (
		input.allowRetry &&
		!input.shuttingDown &&
		!input.servedHealth &&
		(input.exitCode ?? 1) !== 0
	)
}

/**
 * The mock's 60s readiness budget can lapse on a busy VM (leftover `workerd
 * serve` processes from earlier validate runs, #3430). Each attempt spawns a
 * fresh wrangler with its own persist dir and token, so one retry does not
 * inherit a wedged first process. `playwright.config.ts` sizes the webServer
 * timeout for both attempts.
 */
export async function startCloudflareMockWithRetry<Mock>(input: {
	start: (token: string) => Promise<Mock>
	createToken: () => string
	log: (message: string) => void
}): Promise<Mock> {
	try {
		return await input.start(input.createToken())
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		input.log(
			`Mock Cloudflare did not start (${message.split('\n')[0]}); retrying once with a fresh process.`,
		)
		return await input.start(input.createToken())
	}
}

function runSetup(command: string, args: Array<string>) {
	const result = spawnSync(command, args, {
		stdio: 'inherit',
		env: process.env,
	})
	const status = result.status ?? 1
	if (status !== 0) process.exit(status)
}

async function startE2eWebServer() {
	const staleOrigin = await findUnhealthyOriginDevServerMessage(
		createDefaultEnsureDevDeps(),
	)
	if (staleOrigin) {
		throw new Error(staleOrigin)
	}

	runSetup(process.execPath, ['tools/prepare-e2e-env.ts'])
	runSetup(resolveNpmCommand(), ['run', 'migrate:e2e'])

	const mock = await startCloudflareMockWithRetry({
		start: startCloudflareMock,
		createToken: () => `e2e-cloudflare-${randomUUID()}`,
		log: (message) => console.error(message),
	})
	try {
		await writeE2eCloudflareMockState({
			origin: mock.origin,
			token: mock.token,
			accountId: e2eCloudflareMockAccountId,
		})
	} catch (error) {
		await mock[Symbol.asyncDispose]()
		throw error
	}

	const stripe = await startStripeMock().catch(async (error) => {
		await mock[Symbol.asyncDispose]()
		throw error
	})
	const extraArgs = process.argv.slice(2)
	// Isolate from a concurrent healthy `dev:ensure` origin: own persist dir,
	// dedicated e2e flag (disables the Vite Cloudflare inspector), and the
	// Playwright port (default 3847). PLAYWRIGHT_BASE_URL still opts into
	// reuseExistingServer in playwright.config.ts (#3731).
	const viteEnv = {
		...process.env,
		STRIPE_API_BASE_URL: stripe.origin,
		KODY_E2E_STRIPE_TOKEN: stripe.token,
		CLOUDFLARE_API_BASE_URL: mock.origin,
		CLOUDFLARE_API_TOKEN: mock.token,
		CLOUDFLARE_ACCOUNT_ID: e2eCloudflareMockAccountId,
		CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
		WRANGLER_IS_LOCAL_DEV: 'true',
		// Local event injection needs inbox addresses, without changing domains
		// in the separate Worker unit-test fixtures or sending external mail.
		USER_EMAIL_DOMAIN: 'inbox.localhost',
		SYSTEM_EMAIL_DOMAIN: 'localhost',
		WRANGLER_PERSIST_TO: '.wrangler/state/e2e',
		X_LOCAL_EXPLORER: 'false',
		KODY_E2E_WEB_SERVER: '1',
	}

	function spawnVite() {
		return spawnChildProcess(
			process.execPath,
			[
				'--env-file=packages/worker/.env',
				'node_modules/vite/bin/vite.js',
				'--host',
				'127.0.0.1',
				// Fail on a busy port rather than testing another checkout's server.
				'--strictPort',
				...extraArgs,
			],
			{
				stdio: 'inherit',
				env: viteEnv,
			},
		)
	}

	let shuttingDown = false
	let servedHealth = false
	let vite = spawnVite()
	const healthUrl = resolveE2eWebServerHealthUrl(extraArgs)

	async function shutdown(exitCode: number) {
		if (shuttingDown) return
		shuttingDown = true
		await stopChildProcessTree(vite)
		await stripe.close()
		await mock[Symbol.asyncDispose]()
		process.exit(exitCode)
	}

	async function watchFirstStartHealth() {
		while (!shuttingDown && !servedHealth) {
			try {
				const response = await fetch(healthUrl, {
					signal: AbortSignal.timeout(2_000),
				})
				if (response.ok) {
					servedHealth = true
					return
				}
			} catch {
				// Vite has not bound /health yet, or the first process already died.
			}
			await delay(250)
		}
	}

	function watchVite(child: ReturnType<typeof spawnVite>, allowRetry: boolean) {
		vite = child
		child.once('exit', (code) => {
			if (shuttingDown) return
			if (
				shouldRetryE2eWebServerFirstStart({
					allowRetry,
					shuttingDown,
					servedHealth,
					exitCode: code,
				})
			) {
				console.error(
					'Vite e2e webServer exited before /health; retrying once with a fresh process.',
				)
				watchVite(spawnVite(), false)
				void watchFirstStartHealth()
				return
			}
			void shutdown(code ?? 1)
		})
		child.once('error', () => {
			if (shuttingDown) return
			if (
				shouldRetryE2eWebServerFirstStart({
					allowRetry,
					shuttingDown,
					servedHealth,
					exitCode: 1,
				})
			) {
				console.error(
					'Vite e2e webServer failed to spawn before /health; retrying once with a fresh process.',
				)
				watchVite(spawnVite(), false)
				void watchFirstStartHealth()
				return
			}
			void shutdown(1)
		})
	}

	watchVite(vite, true)
	void watchFirstStartHealth()
	process.once('SIGINT', () => {
		void shutdown(0)
	})
	process.once('SIGTERM', () => {
		void shutdown(0)
	})
}

if (isExecutedDirectly(import.meta.url)) {
	void startE2eWebServer().catch((error) => {
		console.error(error instanceof Error ? error.message : error)
		process.exit(1)
	})
}

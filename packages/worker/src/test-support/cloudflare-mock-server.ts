import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import {
	captureOutput,
	spawnProcess,
	stopProcess,
	wranglerBin,
	type SpawnedProcess,
} from '#mcp/test-process.ts'

const workerConfig = 'packages/mock-servers/cloudflare/wrangler.jsonc'
const projectRoot = process.cwd()
const startupTimeout = 60_000

type CloudflareMockMeta = {
	authorized?: unknown
	artifactRepoCount?: unknown
}

export type CloudflareMockProbeResult =
	| { ready: true }
	| { ready: false; reason: string }

/**
 * Durable-Object-backed readiness. Unauthenticated `/__mocks/meta` can
 * return 200 before SQLite DOs accept RPCs; the first artifacts/email
 * request then 503s or returns an empty body (`Unexpected end of JSON
 * input`) under a parallel `test:node` run.
 */
export async function probeCloudflareMockReady(
	origin: string,
	token: string,
	options?: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<CloudflareMockProbeResult> {
	const fetchImpl = options?.fetch ?? fetch
	const timeoutMs = options?.timeoutMs ?? 1_000
	const url = new URL('/__mocks/meta', origin)
	url.searchParams.set('token', token)
	let response: Response | undefined
	try {
		response = await fetchImpl(url, {
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!response.ok) {
			return { ready: false, reason: `HTTP ${String(response.status)}` }
		}
		const rawBody = await response.text()
		if (!rawBody.trim()) {
			return { ready: false, reason: 'empty body' }
		}
		let meta: CloudflareMockMeta
		try {
			meta = JSON.parse(rawBody) as CloudflareMockMeta
		} catch {
			return { ready: false, reason: 'invalid JSON' }
		}
		if (meta.authorized !== true) {
			return { ready: false, reason: 'unauthorized' }
		}
		if (typeof meta.artifactRepoCount !== 'number') {
			return { ready: false, reason: 'durable objects not ready' }
		}
		return { ready: true }
	} catch (error) {
		return {
			ready: false,
			reason: error instanceof Error ? error.message : 'fetch failed',
		}
	} finally {
		await response?.body?.cancel().catch(() => undefined)
	}
}

async function waitForCloudflareMock(
	proc: ReturnType<typeof spawnProcess>,
	readStdout: () => string,
	readStderr: () => string,
	token: string,
) {
	const deadline = Date.now() + startupTimeout
	const exited = proc.exited.then(
		(code) => ({ status: 'exited' as const, code }),
		(error: unknown) => ({ status: 'error' as const, error }),
	)
	let origin: string | undefined
	let lastProbeReason: string | undefined
	while (Date.now() < deadline) {
		const output = `${readStdout()}\n${readStderr()}`
		if (!origin) {
			const readyMatch = stripVTControlCharacters(output).match(
				/\bReady on (http:\/\/127\.0\.0\.1:\d+)\b/,
			)
			origin = readyMatch?.[1]
		}
		if (origin) {
			const remainingTime = Math.max(1, deadline - Date.now())
			const probe = await probeCloudflareMockReady(origin, token, {
				timeoutMs: Math.min(1_000, remainingTime),
			})
			if (probe.ready) {
				return origin
			}
			lastProbeReason = probe.reason
		}

		const exitResult = await Promise.race([exited, delay(200).then(() => null)])
		if (exitResult?.status === 'error') {
			throw new Error('mock cloudflare failed to start', {
				cause: exitResult.error,
			})
		}
		if (exitResult?.status === 'exited') {
			throw new Error(
				`mock cloudflare exited before becoming ready (code ${String(exitResult.code)})\n${output}`,
			)
		}
	}
	const lastProbe =
		lastProbeReason === undefined ? '' : ` (last probe: ${lastProbeReason})`
	throw new Error(
		`mock cloudflare did not become ready within ${startupTimeout}ms${lastProbe}\n${readStdout()}\n${readStderr()}`,
	)
}

async function disposeCloudflareMock(proc: SpawnedProcess, persistDir: string) {
	try {
		await stopProcess(proc)
	} finally {
		await rm(persistDir, { recursive: true, force: true })
	}
}

export async function startCloudflareMock(
	token: string,
	options: { gitBackendUrl?: string } = {},
) {
	// Isolated persist dir: this mock uses SQLite-backed Durable Objects.
	// Sharing Wrangler's default `.wrangler/state` across parallel `wrangler
	// dev` processes (email + artifacts node-unit, or a leftover local dev
	// lock) crashes workerd with SQLITE_BUSY_RECOVERY before Ready.
	const persistDir = await mkdtemp(path.join(tmpdir(), 'kody-cf-mock-'))
	const proc = spawnProcess({
		cmd: [
			wranglerBin,
			'dev',
			'--local',
			'--persist-to',
			persistDir,
			'--config',
			workerConfig,
			'--var',
			`MOCK_API_TOKEN:${token}`,
			// Without a git backend, Artifacts remotes point at this mock's
			// token-gated API and git clients get 401.
			...(options.gitBackendUrl
				? ['--var', `MOCK_GIT_BACKEND_URL:${options.gitBackendUrl}`]
				: []),
			'--port',
			'0',
			'--inspector-port',
			'0',
			'--ip',
			'127.0.0.1',
			'--show-interactive-dev-session=false',
			'--live-reload',
			'false',
			'--log-level',
			'info',
		],
		cwd: projectRoot,
		env: {
			...process.env,
			// Wrangler 4.118+ local observability collector/tail services
			// contend with parallel mock wranglers during `test:node` and
			// return 503 / empty JSON on the first DO-backed request.
			X_LOCAL_OBSERVABILITY: 'false',
			// Wrangler 4.127+ starts Miniflare's local explorer by default.
			// On Cloud Agent / CI hosts, explorer writes under `.wrangler/tmp`
			// retrigger esbuild and leave ProxyWorker in a pause/reload loop
			// (Ready prints; authenticated `/__mocks/meta` hangs).
			X_LOCAL_EXPLORER: 'false',
			WRANGLER_CI_DISABLE_CONFIG_WATCHING: 'true',
		},
	})
	const readStdout = captureOutput(proc.stdout)
	const readStderr = captureOutput(proc.stderr)
	try {
		const origin = await waitForCloudflareMock(
			proc,
			readStdout,
			readStderr,
			token,
		)
		return {
			origin,
			token,
			async [Symbol.asyncDispose]() {
				await disposeCloudflareMock(proc, persistDir)
			},
		}
	} catch (error) {
		await disposeCloudflareMock(proc, persistDir)
		throw error
	}
}

/**
 * Start the real Kody workers locally for `kody dev`. Everything runs in
 * local workerd through Wrangler: D1, Durable Objects (StorageRunner,
 * realtime, MCP, meters), KV, R2, queues, workflows and worker loaders.
 * System boundaries are local mocks: the mock Cloudflare worker answers the
 * Cloudflare REST API (Artifacts, email sending), a local git server backs
 * Artifacts repos, and every key the worker needs is generated per state dir.
 * Nothing here reaches hosted Kody or reads a real secret.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { orgPermissions } from '@kody-internal/shared/org-permissions.ts'
import { startMockArtifactsGitServer } from '../../../tools/mock-artifacts-git-server.ts'
import {
	buildSeedUserSql,
	seedStableUserIdFromEmail,
} from '../../../tools/seed-sql.ts'
import { localWorkerNames } from './local-config.ts'

export { localWorkerNames }

export const mockCloudflareAccountId = 'cf_account_mock_123'

export type DevRuntimeLogLine = {
	source: 'wrangler' | 'mock-cloudflare'
	stream: 'stdout' | 'stderr'
	line: string
}

export type StartDevRuntimeInput = {
	/** Where local D1, Durable Object and git state persists. */
	stateDir: string
	/** Local origin port. A free port is picked when omitted. */
	port?: number
	/** Username of the seeded local account (the package scope). */
	username: string
	/** Built runtime directory (defaults to this package's `dist`). */
	distDir?: string
	onLog?: (line: DevRuntimeLogLine) => void
	/** Max wait for the origin `/health`. */
	readyTimeoutMs?: number
	/** Opt-in simulations; approximations, not exact Cloudflare timing. */
	simulation?: DevRuntimeSimulation
	/**
	 * Where package outbound fetch goes instead of the internet: the CLI's
	 * `.kody/mocks.ts` gateway.
	 */
	outboundUrl?: string
}

export type DevRuntimeSimulation = {
	/** Added before every package storage call. */
	storageLatencyMs?: number
	/** A fresh package app isolate for every request. */
	coldIsolates?: boolean
	/** Shift `Date` inside package app isolates by this many ms. */
	clockOffsetMs?: number
}

export function simulationVars(simulation: DevRuntimeSimulation | undefined) {
	const vars: Record<string, string> = {}
	if (simulation?.storageLatencyMs) {
		vars.KODY_DEV_STORAGE_LATENCY_MS = String(simulation.storageLatencyMs)
	}
	if (simulation?.coldIsolates) vars.KODY_DEV_COLD_ISOLATES = 'true'
	if (simulation?.clockOffsetMs) {
		vars.KODY_DEV_CLOCK_OFFSET_MS = String(simulation.clockOffsetMs)
	}
	return vars
}

export type DevRuntime = {
	origin: string
	username: string
	email: string
	/** Local-only API token for the seeded account. */
	apiToken: string
	/** `Cookie` header for the seeded account's browser session. */
	sessionCookie: string
	/** Mock Cloudflare worker origin (email outbox, Artifacts). */
	mockCloudflareOrigin: string
	mockCloudflareToken: string
	listOutbox: () => Promise<unknown>
	close: () => Promise<void>
}

type LocalState = {
	username: string
	email: string
	password: string
	apiToken: string | null
	mockCloudflareToken: string
	cookieSecret: string
	secretStoreKey: string
	oidcPrivateKeyPem: string
	/**
	 * Stable per state dir: saved rows (Artifacts remotes, app URLs) embed
	 * these origins, so a restart must come back on the same ports.
	 */
	ports?: { origin: number; mockCloudflare: number; git: number }
}

const here = dirname(fileURLToPath(import.meta.url))

function defaultDistDir() {
	// Bundled: dist/index.js. Source (tests): src/index.ts.
	return here.endsWith('src') ? resolve(here, '../dist') : here
}

function randomToken(bytes = 32) {
	return randomBytes(bytes).toString('base64url')
}

function readOrCreateState(stateDir: string, username: string): LocalState {
	const path = join(stateDir, 'local-state.json')
	if (existsSync(path)) {
		const state = JSON.parse(readFileSync(path, 'utf8')) as LocalState
		if (state.username === username) return state
	}
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
	const state: LocalState = {
		username,
		email: `${username}@kody.localhost`,
		password: randomToken(18),
		apiToken: null,
		mockCloudflareToken: `mock-cloudflare-${randomToken(12)}`,
		cookieSecret: randomToken(36),
		secretStoreKey: randomToken(36),
		oidcPrivateKeyPem: privateKey
			.export({ type: 'pkcs8', format: 'pem' })
			.toString(),
	}
	writeLocalState(stateDir, state)
	return state
}

function writeLocalState(stateDir: string, state: LocalState) {
	writeFileSync(
		join(stateDir, 'local-state.json'),
		`${JSON.stringify(state, null, '\t')}\n`,
		{ mode: 0o600 },
	)
}

export async function getFreePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address ? address.port : 0
			server.close(() => resolvePort(port))
		})
	})
}

function wranglerBin() {
	const require = createRequire(import.meta.url)
	const packageJsonPath = require.resolve('wrangler/package.json')
	const { bin } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
		bin: string | Record<string, string>
	}
	const relativeBin = typeof bin === 'string' ? bin : bin.wrangler!
	return join(dirname(packageJsonPath), relativeBin)
}

/**
 * Per-state configs: absolute module paths into the built runtime plus the
 * vars of this local instance. Generated keys are random, local-only values.
 */
export function writeStateConfigs(input: {
	distDir: string
	configDir: string
	vars: Record<string, string>
	mockCloudflareVars: Record<string, string>
}) {
	const configs: Record<string, string> = {}
	for (const worker of [...localWorkerNames, 'mock-cloudflare'] as const) {
		const builtDir = join(input.distDir, 'workers', worker)
		const config = JSON.parse(
			readFileSync(join(builtDir, 'wrangler.json'), 'utf8'),
		) as Record<string, unknown>
		config.main = join(builtDir, String(config.main))
		config.base_dir = builtDir
		const assets = config.assets as Record<string, unknown> | undefined
		if (assets?.directory) {
			config.assets = {
				...assets,
				directory: resolve(builtDir, String(assets.directory)),
			}
		}
		if (Array.isArray(config.d1_databases)) {
			config.d1_databases = config.d1_databases.map(
				(db: Record<string, unknown>) =>
					db.migrations_dir
						? {
								...db,
								migrations_dir: resolve(builtDir, String(db.migrations_dir)),
							}
						: db,
			)
		}
		config.vars = {
			...(config.vars as Record<string, unknown> | undefined),
			...(worker === 'mock-cloudflare' ? input.mockCloudflareVars : input.vars),
		}
		const dir = join(input.configDir, worker)
		mkdirSync(dir, { recursive: true })
		const path = join(dir, 'wrangler.json')
		writeFileSync(path, `${JSON.stringify(config, null, '\t')}\n`)
		configs[worker] = path
	}
	return configs as Record<
		(typeof localWorkerNames)[number] | 'mock-cloudflare',
		string
	>
}

function spawnWrangler(input: {
	args: Array<string>
	cwd: string
	source: DevRuntimeLogLine['source']
	onLog?: StartDevRuntimeInput['onLog']
}): ChildProcess {
	const child = spawn(process.execPath, [wranglerBin(), ...input.args], {
		cwd: input.cwd,
		env: {
			...process.env,
			CI: 'true',
			WRANGLER_SEND_METRICS: 'false',
			// Never let a developer's Cloudflare login leak into local runs.
			CLOUDFLARE_API_TOKEN: '',
			CLOUDFLARE_ACCOUNT_ID: '',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	for (const stream of ['stdout', 'stderr'] as const) {
		let buffer = ''
		child[stream]?.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8')
			let index = buffer.indexOf('\n')
			while (index !== -1) {
				const line = buffer.slice(0, index)
				buffer = buffer.slice(index + 1)
				input.onLog?.({ source: input.source, stream, line })
				index = buffer.indexOf('\n')
			}
		})
	}
	return child
}

async function runWrangler(input: {
	args: Array<string>
	cwd: string
	onLog?: StartDevRuntimeInput['onLog']
}) {
	const lines: Array<string> = []
	const child = spawnWrangler({
		...input,
		source: 'wrangler',
		onLog: (line) => {
			lines.push(line.line)
			input.onLog?.(line)
		},
	})
	const code = await new Promise<number | null>((done) =>
		child.once('exit', done),
	)
	if (code !== 0) {
		throw new Error(
			`wrangler ${input.args.slice(0, 3).join(' ')} failed (${code}):\n${lines.slice(-20).join('\n')}`,
		)
	}
}

function stopChild(child: ChildProcess) {
	return new Promise<void>((done) => {
		if (child.exitCode !== null || child.signalCode !== null) return done()
		child.once('exit', () => done())
		child.kill('SIGTERM')
		setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
	})
}

async function waitForOk(url: string, timeoutMs: number, child: ChildProcess) {
	const started = Date.now()
	let lastError = ''
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) {
			throw new Error(`Local Kody stopped before ${url} was ready.`)
		}
		try {
			const response = await fetch(url)
			if (response.ok) return
			lastError = `HTTP ${response.status}`
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
		}
		await new Promise((done) => setTimeout(done, 250))
	}
	throw new Error(`Timed out waiting for ${url} (${lastError}).`)
}

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

/** Local API token row for the seeded account, with every org permission. */
export function buildLocalApiTokenSql(input: { userId: string; now?: Date }): {
	token: string
	sql: string
} {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
	const id = Array.from(randomBytes(20), (b) => alphabet[b % 36]).join('')
	const secret = randomBytes(32).toString('base64url')
	const hash = createHash('sha256').update(secret).digest('hex')
	const now = input.now ?? new Date()
	const expires = new Date(now.getTime() + 365 * 86_400_000).toISOString()
	const created = now.toISOString()
	const sql = `INSERT INTO api_tokens (id, user_id, org_id, name, token_hash, scopes_json, idle_ttl_seconds, expires_at, max_expires_at, created_via, created_at, updated_at, org_binding) VALUES (${[
		id,
		input.userId,
		input.userId,
		'kody dev',
		hash,
		JSON.stringify(orgPermissions),
	]
		.map(sqlString)
		.join(
			', ',
		)}, 31536000, ${sqlString(expires)}, ${sqlString(expires)}, 'cli-login', ${sqlString(created)}, ${sqlString(created)}, 'org');`
	return { token: `kody_at_${id}_${secret}`, sql }
}

async function login(origin: string, state: LocalState) {
	const response = await fetch(`${origin}/auth`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			email: state.email,
			password: state.password,
			mode: 'login',
		}),
	})
	const cookies = response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(';')[0])
		.filter(Boolean)
	if (!response.ok || cookies.length === 0) {
		throw new Error(`Local sign-in failed (HTTP ${response.status}).`)
	}
	return cookies.join('; ')
}

export async function startDevRuntime(
	input: StartDevRuntimeInput,
): Promise<DevRuntime> {
	const distDir = input.distDir ?? defaultDistDir()
	const stateDir = resolve(input.stateDir)
	const persistDir = join(stateDir, 'wrangler')
	mkdirSync(persistDir, { recursive: true })
	const state = readOrCreateState(stateDir, input.username)
	if (!state.ports || (input.port && input.port !== state.ports.origin)) {
		state.ports = {
			origin: input.port ?? (await getFreePort()),
			mockCloudflare: await getFreePort(),
			git: await getFreePort(),
		}
		writeLocalState(stateDir, state)
	}
	const port = state.ports.origin
	const mockPort = state.ports.mockCloudflare
	const origin = `http://localhost:${port}`
	const mockCloudflareOrigin = `http://127.0.0.1:${mockPort}`
	const children: Array<ChildProcess> = []
	const git = await startMockArtifactsGitServer({
		root: join(stateDir, 'artifacts-git'),
		port: state.ports.git,
	})
	const close = async () => {
		await Promise.all(children.map(stopChild))
		await git.close()
	}
	try {
		const configs = writeStateConfigs({
			distDir,
			configDir: join(stateDir, 'config'),
			vars: {
				...simulationVars(input.simulation),
				...(input.outboundUrl
					? { KODY_DEV_OUTBOUND_URL: input.outboundUrl }
					: {}),
				APP_BASE_URL: origin,
				COOKIE_SECRET: state.cookieSecret,
				SECRET_STORE_KEY: state.secretStoreKey,
				OIDC_SIGNING_KEY_ID: 'kody-dev-local',
				OIDC_SIGNING_PRIVATE_KEY_PEM: state.oidcPrivateKeyPem,
				CLOUDFLARE_API_BASE_URL: mockCloudflareOrigin,
				CLOUDFLARE_API_TOKEN: state.mockCloudflareToken,
				CLOUDFLARE_ACCOUNT_ID: mockCloudflareAccountId,
				CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
			},
			mockCloudflareVars: {
				MOCK_API_TOKEN: state.mockCloudflareToken,
				MOCK_GIT_BACKEND_URL: git.origin,
			},
		})
		const persist = ['--local', '--persist-to', persistDir]
		for (const [binding, config] of [
			['APP_DB', configs.origin],
			['AUDIT_DB', configs.origin],
			['JOBS_DB', configs.jobs],
		] as const) {
			await runWrangler({
				args: ['d1', 'migrations', 'apply', binding, ...persist, '-c', config],
				cwd: stateDir,
				onLog: input.onLog,
			})
		}
		if (!state.apiToken) {
			const userId = seedStableUserIdFromEmail(state.email)
			const token = buildLocalApiTokenSql({ userId })
			const seedPath = join(stateDir, 'seed.sql')
			writeFileSync(
				seedPath,
				`${buildSeedUserSql({
					email: state.email,
					username: state.username,
					passwordHash: await createPasswordHash(state.password),
				})}\n${token.sql}\n`,
				{ mode: 0o600 },
			)
			await runWrangler({
				args: [
					'd1',
					'execute',
					'APP_DB',
					...persist,
					'-c',
					configs.origin,
					'--file',
					seedPath,
					'--yes',
				],
				cwd: stateDir,
				onLog: input.onLog,
			})
			state.apiToken = token.token
			writeLocalState(stateDir, state)
		}
		const mock = spawnWrangler({
			args: [
				'dev',
				'-c',
				configs['mock-cloudflare'],
				...persist,
				'--port',
				String(mockPort),
				'--ip',
				'127.0.0.1',
				'--inspector-port',
				String(await getFreePort()),
				'--show-interactive-dev-session=false',
			],
			cwd: stateDir,
			source: 'mock-cloudflare',
			onLog: input.onLog,
		})
		children.push(mock)
		const kody = spawnWrangler({
			args: [
				'dev',
				...localWorkerNames.flatMap((worker) => ['-c', configs[worker]]),
				...persist,
				'--port',
				String(port),
				'--ip',
				'127.0.0.1',
				'--inspector-port',
				String(await getFreePort()),
				'--show-interactive-dev-session=false',
			],
			cwd: stateDir,
			source: 'wrangler',
			onLog: input.onLog,
		})
		children.push(kody)
		const timeout = input.readyTimeoutMs ?? 120_000
		await waitForOk(
			`${mockCloudflareOrigin}/__mocks/meta?token=${encodeURIComponent(state.mockCloudflareToken)}`,
			timeout,
			mock,
		).catch(() => {})
		await waitForOk(`${origin}/health`, timeout, kody)
		const sessionCookie = await login(origin, state)
		return {
			origin,
			username: state.username,
			email: state.email,
			apiToken: state.apiToken,
			sessionCookie,
			mockCloudflareOrigin,
			mockCloudflareToken: state.mockCloudflareToken,
			listOutbox: async () => {
				const response = await fetch(
					`${mockCloudflareOrigin}/__mocks/messages`,
					{
						headers: { authorization: `Bearer ${state.mockCloudflareToken}` },
					},
				)
				return await response.json()
			},
			close,
		}
	} catch (error) {
		await close()
		throw error
	}
}

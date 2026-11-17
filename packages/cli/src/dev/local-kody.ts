/**
 * `kody dev` on the real Kody workers: install `@kodycodes/dev-runtime` (the
 * same version as this CLI) into the Kody cache on first use, start the local
 * stack, and save the working tree into it on every build. Nothing here
 * talks to hosted Kody.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { windowsFileLaunch } from '../execution-context/windows-command.js'
import { npmInstallEnv } from '../mock/ensure-msw.js'
import {
	resolveMockFetchGateway,
	type MockFetchGateway,
} from '../mock/mock-fetch-gateway.js'
import { lexableModuleSource } from '../fetch-body-package-scan.js'
import { listSavedPackageImports } from '../local-package-graph.js'
import {
	listMappedLocalDeps,
	localDepsRelativePath,
} from '../mock-local-deps.js'
import { collectPackageCheckFiles } from '../package-check-files.js'
import type { KodyPackageManifest } from '../package-manifest.js'
import { readPackageVersion } from '../package-info.js'
import { StructuredCliError } from '../structured-error.js'
import { userCacheDir } from '../workerd-binary.js'
import type { LocalKodyUpstream } from '../package-app-dev.js'
import {
	buildPackageAppOpenPath,
	packageAppHostEntryQueryParam,
} from '@kody-internal/shared/public-urls.ts'
import { localUsernameFor } from './dev-app-origin.js'

const devRuntimePackageName = '@kodycodes/dev-runtime'

/** Structural type of `@kodycodes/dev-runtime` so the CLI never imports it statically. */
export type DevRuntimeModule = {
	startDevRuntime: (input: {
		stateDir: string
		port?: number
		username: string
		packageAppPort?: number
		simulation?: {
			storageLatencyMs?: number
			coldIsolates?: boolean
			clockOffsetMs?: number
		}
		onLog?: (line: {
			source: string
			stream: 'stdout' | 'stderr'
			line: string
		}) => void
	}) => Promise<{
		origin: string
		username: string
		apiToken: string
		sessionCookie: string
		listOutbox: () => Promise<unknown>
		close: () => Promise<void>
	}>
}

export type LocalKody = Awaited<ReturnType<DevRuntimeModule['startDevRuntime']>>

function cachedDevRuntimeRoot(cacheDir: string, version: string) {
	return join(cacheDir, 'deps', 'dev-runtime', version)
}

function installedEntry(root: string): string | null {
	const entry = join(
		root,
		'node_modules',
		'@kodycodes',
		'dev-runtime',
		'dist',
		'index.js',
	)
	return existsSync(entry) ? entry : null
}

/** A monorepo checkout builds the runtime in place (`npm run build -w @kodycodes/dev-runtime`). */
function monorepoEntry(): string | null {
	let dir = dirname(fileURLToPath(import.meta.url))
	for (let depth = 0; depth < 5; depth += 1) {
		const entry = join(dir, 'dev-runtime', 'dist', 'index.js')
		if (existsSync(entry)) return entry
		dir = dirname(dir)
	}
	return null
}

async function ensureDevRuntime(
	input: {
		env?: NodeJS.ProcessEnv
		version?: string
		onInstall?: (spec: string) => void
		installInto?: (stagingDir: string, spec: string) => Promise<void>
	} = {},
): Promise<string> {
	const env = input.env ?? process.env
	if (env.KODY_DEV_RUNTIME_DIR) {
		const entry = join(resolve(env.KODY_DEV_RUNTIME_DIR), 'dist', 'index.js')
		if (existsSync(entry)) return entry
	}
	const version = input.version ?? readPackageVersion()
	const root = cachedDevRuntimeRoot(userCacheDir(env), version)
	const cached = installedEntry(root)
	if (cached) return cached
	if (!input.installInto) {
		const local = monorepoEntry()
		if (local) return local
	}
	const spec = `${devRuntimePackageName}@${version}`
	input.onInstall?.(spec)
	await mkdir(dirname(root), { recursive: true })
	const staging = await mkdtemp(join(dirname(root), `.dev-runtime-${version}-`))
	try {
		if (input.installInto) await input.installInto(staging, spec)
		else await npmInstall(staging, version, env)
		if (!installedEntry(staging)) {
			throw new Error('install finished but the runtime entry was missing')
		}
		await rm(root, { recursive: true, force: true })
		await rename(staging, root)
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {})
		throw new StructuredCliError({
			code: 'bundle_failed',
			message: `Could not install ${spec} for kody dev (${error instanceof Error ? error.message : String(error)}).`,
			target: 'mock',
			where: root,
			fix: `Connect to the network and retry so the CLI can install ${spec} into the Kody cache (${dirname(root)}).`,
			details: { package: spec, cacheDir: root },
		})
	}
	const entry = installedEntry(root)
	if (!entry) throw new Error(`${spec} is missing from ${root} after install.`)
	return entry
}

async function npmInstall(
	stagingDir: string,
	version: string,
	env: NodeJS.ProcessEnv,
) {
	await writeFile(
		join(stagingDir, 'package.json'),
		`${JSON.stringify({ name: 'kody-dev-runtime-cache', private: true, dependencies: { [devRuntimePackageName]: version } }, null, 2)}\n`,
	)
	const args = [
		'install',
		'--omit=dev',
		'--no-audit',
		'--no-fund',
		'--no-update-notifier',
		'--no-progress',
	]
	const installEnv = npmInstallEnv(env)
	const launch =
		process.platform === 'win32'
			? windowsFileLaunch('npm', args, installEnv)
			: { file: 'npm', argv: args, verbatim: false }
	await new Promise<void>((done, fail) => {
		const child = spawn(launch.file, launch.argv, {
			cwd: stagingDir,
			env: installEnv,
			windowsHide: true,
			windowsVerbatimArguments: launch.verbatim,
			stdio: ['ignore', 'ignore', 'pipe'],
		})
		let stderr = ''
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = (stderr + chunk.toString('utf8')).slice(-64_000)
		})
		const timer = setTimeout(() => {
			child.kill('SIGTERM')
			fail(new Error('npm install timed out after 600s'))
		}, 600_000)
		child.on('error', (error) => {
			clearTimeout(timer)
			fail(error)
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code === 0) done()
			else
				fail(
					new Error(stderr.trim().split('\n').at(-1) ?? `npm exited ${code}`),
				)
		})
	})
}

export { localUsernameFor }

export async function startLocalKody(input: {
	manifest: KodyPackageManifest
	/** Port package apps are reached on (the `kody dev` proxy port). */
	packageAppPort: number
	env?: NodeJS.ProcessEnv
	simulation?: Parameters<DevRuntimeModule['startDevRuntime']>[0]['simulation']
	passthroughHosts?: ReadonlyArray<string>
	allowPrivateNetwork?: boolean
	onStatus?: (message: string) => void
}): Promise<LocalKody> {
	const entry = await ensureDevRuntime({
		env: input.env,
		onInstall: (spec) =>
			input.onStatus?.(
				`Installing ${spec} into the Kody cache (first kody dev only)...`,
			),
	})
	const runtime = (await import(pathToFileURL(entry).href)) as DevRuntimeModule
	// Outside the package root so local state never lands in the saved tree.
	const stateDir = join(
		userCacheDir(input.env ?? process.env),
		'dev-state',
		createHash('sha256').update(input.manifest.root).digest('hex').slice(0, 16),
	)
	await mkdir(stateDir, { recursive: true })
	const log = createWriteStream(join(stateDir, 'runtime.log'), { flags: 'a' })
	input.onStatus?.(
		'Starting local Kody (real workers, local D1 and Durable Objects)...',
	)
	const gateway = await resolveMockFetchGateway({
		target: 'mock',
		packageRoot: input.manifest.root,
		passthroughHosts: input.passthroughHosts,
		allowPrivateNetwork: input.allowPrivateNetwork,
	})
	const outbound = gateway ? await startOutboundGateway(gateway) : null
	try {
		const kody = await runtime.startDevRuntime({
			stateDir,
			username: localUsernameFor(input.manifest),
			packageAppPort: input.packageAppPort,
			...(input.simulation ? { simulation: input.simulation } : {}),
			...(outbound ? { outboundUrl: outbound.url } : {}),
			onLog: (line) => log.write(`[${line.source}] ${line.line}\n`),
		})
		return {
			...kody,
			close: async () => {
				await kody.close()
				await outbound?.close()
			},
		}
	} catch (error) {
		await outbound?.close()
		throw error
	}
}

/**
 * Package outbound fetch on the local workers lands here and runs through the
 * same `.kody/mocks.ts` gateway as the rest of `--target mock`, so it never
 * reaches a third-party service unless `--passthrough` allows the host.
 */
async function startOutboundGateway(gateway: MockFetchGateway) {
	const server = createServer((req, res) => {
		const chunks: Array<Buffer> = []
		req.on('data', (chunk: Buffer) => chunks.push(chunk))
		req.on('end', () => {
			void (async () => {
				let status = 200
				let body: unknown
				try {
					const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
					body = await gateway.handle({ request })
				} catch (error) {
					status = 502
					body = {
						error: error instanceof Error ? error.message : String(error),
					}
				}
				res.writeHead(status, { 'content-type': 'application/json' })
				res.end(JSON.stringify(body))
			})()
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

/**
 * `name=value` of each cookie local Kody sets for `host`. node:http because
 * fetch cannot send a Host other than the address it connects to.
 */
function readSetCookies(input: { origin: string; host: string; path: string }) {
	return new Promise<Array<string>>((resolve, reject) => {
		const request = httpRequest(
			new URL(input.path, input.origin),
			{ headers: { host: input.host } },
			(response) => {
				response.resume()
				resolve(
					(response.headers['set-cookie'] ?? [])
						.map((cookie) => cookie.split(';')[0]!.trim())
						.filter((pair) => !pair.endsWith('=')),
				)
			},
		)
		request.on('error', reject)
		request.end()
	})
}

/** Saves the working tree into local Kody through the real packageSave route. */
export function createLocalKodyUpstream(input: {
	kody: LocalKody
	manifest: KodyPackageManifest
	/** Leave package jobs on their real schedule (`kody dev --run-jobs`). */
	runJobs?: boolean
	fetchFn?: typeof fetch
}): LocalKodyUpstream {
	const fetchFn = input.fetchFn ?? fetch
	let packageId: string | null = null
	const savedIds = new Map<string, string>()
	const savedHashes = new Map<string, string>()
	let watchPaths: ReadonlyArray<string> = []
	// The same capability proxy `kody execute --local` uses, so each call runs
	// the real capability handler on the local stack.
	const call = async (operation: string, args: unknown) => {
		const response = await fetchFn(
			`${input.kody.origin}/v1/capability-proxy/call`,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${input.kody.apiToken}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ path: ['kody', operation], args: [args] }),
			},
		)
		const body = (await response.json().catch(() => null)) as {
			result?: unknown
			error?: { code?: string; message?: string }
		} | null
		if (!response.ok || !body || 'error' in body) {
			throw new StructuredCliError({
				code: 'dev_local_call_failed',
				message: `Local Kody ${operation} failed (HTTP ${response.status}): ${body?.error?.message ?? 'no response body'}`,
				target: 'mock',
			})
		}
		return body.result
	}
	const pauseJobs = async () => {
		const listed = (await call('jobList', {})) as {
			jobs?: Array<{ id: string; enabled: boolean }>
		}
		for (const job of listed.jobs ?? []) {
			if (job.enabled) await call('jobUpdate', { id: job.id, enabled: false })
		}
	}
	// Local subscriptions are on by default so `kody dev emit` and package
	// events reach their handlers; enabling them touches nothing outside.
	const enableSubscriptions = async (id: string) => {
		for (const topic of Object.keys(input.manifest.subscriptions ?? {})) {
			await call('enablementEnable', {
				packageId: id,
				triggerKind: 'subscription',
				triggerName: topic,
			})
		}
	}
	const save = async (request: {
		files: Array<{ path: string; content: string }>
		packageId: string | undefined
		what: string
	}) => {
		const response = await fetchFn(`${input.kody.origin}/v1/packages`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${input.kody.apiToken}`,
				'content-type': 'application/json',
			},
			// The local copy is owned by kody dev and mirrors the working tree, so
			// replacing it on each build is the intent, not a destructive edit.
			body: JSON.stringify({
				...(request.packageId ? { package_id: request.packageId } : {}),
				confirm_destructive_overwrite: true,
				files: request.files,
			}),
		})
		const body = (await response.json().catch(() => null)) as Record<
			string,
			unknown
		> | null
		if (!response.ok) {
			throw new Error(
				`Saving ${request.what} into local Kody failed (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 500)}`,
			)
		}
		const saved = (body?.package ?? body) as Record<string, unknown> | null
		const id = saved?.package_id ?? saved?.id
		return typeof id === 'string' ? id : null
	}
	return {
		origin: input.kody.origin,
		username: input.kody.username,
		appSessionCookie: async ({ rootMounted }) => {
			// The sign-in a browser does: Kody hands its session off to the app's
			// host, which answers with that host's own session cookie.
			const open = new URL(
				buildPackageAppOpenPath({
					username: input.kody.username,
					kodyId: input.manifest.kodyId,
				}),
				input.kody.origin,
			)
			if (rootMounted) open.searchParams.set(packageAppHostEntryQueryParam, '1')
			const handoff = await fetchFn(open, {
				redirect: 'manual',
				headers: { cookie: input.kody.sessionCookie },
			})
			const location = handoff.headers.get('location')
			const target = location ? new URL(location, open) : null
			const cookies = target
				? await readSetCookies({
						origin: input.kody.origin,
						host: target.host,
						path: `${target.pathname}${target.search}`,
					})
				: []
			if (cookies.length === 0) {
				throw new Error(
					`Local Kody did not sign in to the app${target ? ` at ${target.origin}` : ''} (HTTP ${handoff.status}).`,
				)
			}
			return cookies.join('; ')
		},
		listOutbox: () => input.kody.listOutbox(),
		packageId: () => packageId,
		call,
		sync: async () => {
			const trees = new Map<string, Record<string, string>>()
			const readTree = async (root: string) => {
				let files = trees.get(root)
				if (!files) {
					files = (await collectPackageCheckFiles(root)).files
					trees.set(root, files)
				}
				return files
			}
			// The same dep map `kody execute --local` binds from: each mapped dep
			// is saved under its mapped name before anything that imports it.
			const deps = await listMappedLocalDeps({
				selfManifest: input.manifest,
				listImports: async (root) => listTreeImports(await readTree(root)),
			})
			const packages = [
				...deps.map((dep) => ({
					name: dep.name,
					root: dep.manifest.root,
					rename: dep.manifest.name !== dep.name,
				})),
				{ name: input.manifest.name, root: input.manifest.root, rename: false },
			]
			// Watched before saving, so fixing a dep that failed to save rebuilds.
			// The root's dep map sits under `.kody/`, which the root watch skips.
			const depFiles = [join(input.manifest.root, localDepsRelativePath)]
			for (const dep of deps) {
				const tree = await readTree(dep.manifest.root)
				depFiles.push(
					...Object.keys(tree).map((path) => join(dep.manifest.root, path)),
				)
			}
			watchPaths = depFiles
			// Recorded only once every save lands, so a failed dependent is not
			// skipped on the next sync because its dep already saved.
			const hashes = new Map<string, string>()
			let changed = false
			for (const pkg of packages) {
				const tree = await readTree(pkg.root)
				const files = Object.entries(tree).map(([path, content]) => ({
					path,
					content:
						pkg.rename && path === 'package.json'
							? renamePackageJson(content, pkg.name)
							: content,
				}))
				const hash = createHash('sha256')
					.update(JSON.stringify(files))
					.digest('hex')
				// Unchanged deps are not re-saved. Once one changes, everything
				// after it (its dependents) is, so none keeps a stale copy.
				const isRoot = pkg.root === input.manifest.root
				if (!isRoot && !changed && savedHashes.get(pkg.name) === hash) continue
				changed = true
				const id = await save({
					files,
					packageId: savedIds.get(pkg.name),
					what: isRoot
						? 'the working tree'
						: `mapped local dep ${pkg.name} (${pkg.root})`,
				})
				if (id) savedIds.set(pkg.name, id)
				hashes.set(pkg.name, hash)
			}
			for (const [name, hash] of hashes) savedHashes.set(name, hash)
			packageId = savedIds.get(input.manifest.name) ?? packageId
			// Saving re-syncs package jobs onto the real local scheduler. They only
			// fire on schedule with --run-jobs; otherwise `kody dev job` runs them.
			if (!input.runJobs) await pauseJobs()
			if (packageId) await enableSubscriptions(packageId)
		},
		watchPaths: () => watchPaths,
	}
}

const sourceModulePattern = /\.[cm]?[jt]sx?$/

/** `kody:@` specifiers the source modules in a package tree import. */
async function listTreeImports(files: Record<string, string>) {
	const found = new Set<string>()
	for (const [path, source] of Object.entries(files)) {
		if (!sourceModulePattern.test(path) || /\.d\.[cm]?ts$/.test(path)) continue
		const code = await lexableModuleSource(path, source).catch(() => null)
		if (code === null) continue
		for (const specifier of await listSavedPackageImports(code)) {
			found.add(specifier)
		}
	}
	return [...found]
}

/**
 * `package.json` with `name` set to the name importers use for the dep, and
 * an explicit `kody.id` set to match its leaf.
 */
function renamePackageJson(content: string, name: string) {
	try {
		const pkg = JSON.parse(content) as Record<string, unknown>
		const kody = pkg.kody as Record<string, unknown> | undefined
		const id = name.split('/').at(-1)
		return `${JSON.stringify(
			{
				...pkg,
				name,
				...(kody && typeof kody === 'object' && 'id' in kody
					? { kody: { ...kody, id } }
					: {}),
			},
			null,
			'\t',
		)}\n`
	} catch {
		return content
	}
}

/** Default added latency for a bare `--simulate-latency`, in ms. */
export const defaultSimulatedStorageLatencyMs = 25

/** Parses `--simulate-latency [--latency-ms <n>]`, `--cold` and `--clock`. */
export function parseDevSimulation(input: {
	simulateLatency?: string | boolean
	latencyMs?: string | boolean
	cold?: string | boolean
	clock?: string | boolean
	now?: number
}) {
	const simulation: {
		storageLatencyMs?: number
		coldIsolates?: boolean
		clockOffsetMs?: number
	} = {}
	if (input.simulateLatency === true || typeof input.latencyMs === 'string') {
		const raw =
			typeof input.latencyMs === 'string' ? input.latencyMs.trim() : ''
		const ms = raw === '' ? defaultSimulatedStorageLatencyMs : Number(raw)
		if (!Number.isSafeInteger(ms) || ms < 0) {
			throw new StructuredCliError({
				code: 'invalid_flag',
				message: `--latency-ms expects whole milliseconds, got ${JSON.stringify(raw)}.`,
				target: 'mock',
			})
		}
		if (ms > 0) simulation.storageLatencyMs = ms
	}
	if (input.cold === true) simulation.coldIsolates = true
	if (typeof input.clock === 'string' && input.clock.trim() !== '') {
		const raw = input.clock.trim()
		const offset = /^[+-]?\d+$/.test(raw)
			? Number(raw)
			: Date.parse(raw) - (input.now ?? Date.now())
		if (!Number.isSafeInteger(offset)) {
			throw new StructuredCliError({
				code: 'invalid_flag',
				message: `--clock expects an ISO date or an offset in ms, got ${JSON.stringify(raw)}.`,
				target: 'mock',
			})
		}
		if (offset !== 0) simulation.clockOffsetMs = offset
	}
	return Object.keys(simulation).length > 0 ? simulation : undefined
}

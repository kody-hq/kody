/**
 * `kody dev` on the real Kody workers: install `@kodycodes/dev-runtime` (the
 * same version as this CLI) into the Kody cache on first use, start the local
 * stack, and save the working tree into it on every build. Nothing here
 * talks to hosted Kody.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { windowsFileLaunch } from '../execution-context/windows-command.js'
import { npmInstallEnv } from '../mock/ensure-msw.js'
import { collectPackageCheckFiles } from '../package-check-files.js'
import type { KodyPackageManifest } from '../package-manifest.js'
import { readPackageVersion } from '../package-info.js'
import { StructuredCliError } from '../structured-error.js'
import { userCacheDir } from '../workerd-binary.js'
import type { LocalKodyUpstream } from '../package-app-dev.js'

export const devRuntimePackageName = '@kodycodes/dev-runtime'

/** Structural type of `@kodycodes/dev-runtime` so the CLI never imports it statically. */
export type DevRuntimeModule = {
	startDevRuntime: (input: {
		stateDir: string
		port?: number
		username: string
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

export function cachedDevRuntimeRoot(cacheDir: string, version: string) {
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

export async function ensureDevRuntime(
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

/** Local account username: the package scope when there is one. */
export function localUsernameFor(manifest: Pick<KodyPackageManifest, 'name'>) {
	const scope = /^@([a-z0-9][a-z0-9-]*)\//i.exec(manifest.name)?.[1]
	return (scope ?? 'dev').toLowerCase()
}

export async function startLocalKody(input: {
	manifest: KodyPackageManifest
	env?: NodeJS.ProcessEnv
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
	return await runtime.startDevRuntime({
		stateDir,
		username: localUsernameFor(input.manifest),
		onLog: (line) => log.write(`[${line.source}] ${line.line}\n`),
	})
}

/** Saves the working tree into local Kody through the real packageSave route. */
export function createLocalKodyUpstream(input: {
	kody: LocalKody
	manifest: KodyPackageManifest
	fetchFn?: typeof fetch
}): LocalKodyUpstream {
	const fetchFn = input.fetchFn ?? fetch
	let packageId: string | null = null
	return {
		origin: input.kody.origin,
		appPath: `/@${input.kody.username}/packages/${input.manifest.kodyId}`,
		cookie: input.kody.sessionCookie,
		sync: async () => {
			const tree = await collectPackageCheckFiles(input.manifest.root)
			const files = Object.entries(tree.files).map(([path, content]) => ({
				path,
				content,
			}))
			const response = await fetchFn(`${input.kody.origin}/v1/packages`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${input.kody.apiToken}`,
					'content-type': 'application/json',
				},
				// The local copy is owned by kody dev and mirrors the working tree, so
				// replacing it on each build is the intent, not a destructive edit.
				body: JSON.stringify({
					...(packageId ? { package_id: packageId } : {}),
					confirm_destructive_overwrite: true,
					files,
				}),
			})
			const body = (await response.json().catch(() => null)) as Record<
				string,
				unknown
			> | null
			if (!response.ok) {
				throw new Error(
					`Saving the working tree into local Kody failed (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 500)}`,
				)
			}
			const saved = (body?.package ?? body) as Record<string, unknown> | null
			const id = saved?.package_id ?? saved?.id
			if (typeof id === 'string') packageId = id
		},
	}
}

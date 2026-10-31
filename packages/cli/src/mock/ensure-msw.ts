/**
 * On-demand MSW for `--target mock` fetch mocking.
 *
 * Kept out of `dependencies` so cold `npx @kodycodes/cli` stays small; when a
 * mock path actually needs MSW (`.kody/mocks.ts` / handler dispatch), install
 * the pinned version into the Kody user cache (never the user project / global).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { windowsFileLaunch } from '../execution-context/windows-command.js'
import { StructuredCliError } from '../structured-error.js'
import { userCacheDir } from '../workerd-binary.js'

/** Exact pin — bump deliberately when changing mock MSW behavior. */
export const mswPinnedVersion = '3.0.3'

export const mswPackageSpec = `msw@${mswPinnedVersion}`

/**
 * The MSW surface `kody dev` / `--target mock` uses. Kept as a structural type
 * so the published bundle does not emit `import "msw"` (msw is installed into
 * the Kody cache on demand, not shipped as a dependency).
 */
export type MswModule = {
	getResponse: (
		handlers: Array<unknown>,
		request: Request,
	) => Promise<Response | null | undefined>
	isPassthroughResponse: (response: Response) => boolean
}

export function cachedMswRoot(
	cacheDir: string,
	version: string = mswPinnedVersion,
): string {
	return join(cacheDir, 'deps', 'msw', version)
}

export function cachedMswPackagePath(
	cacheDir: string,
	version: string = mswPinnedVersion,
): string {
	return join(cachedMswRoot(cacheDir, version), 'node_modules', 'msw')
}

function isMswInstalled(root: string): boolean {
	return existsSync(join(root, 'node_modules', 'msw', 'package.json'))
}

export type EnsureMswInput = {
	env?: NodeJS.ProcessEnv
	cacheDir?: string
	/** Called once when an install is about to start (print one short line). */
	onInstall?: (spec: string) => void
	/** Test seam: replace `npm install` into a fresh directory. */
	installInto?: (stagingDir: string) => Promise<void>
}

/**
 * Ensure the pinned `msw` is available and return its package directory
 * (`…/node_modules/msw`). Prefers the Kody cache; falls back to a
 * CLI-local resolve (devDependency / tests); otherwise installs into the cache.
 */
export async function ensureMsw(input: EnsureMswInput = {}): Promise<string> {
	const env = input.env ?? process.env
	const cacheDir = input.cacheDir ?? userCacheDir(env)
	const root = cachedMswRoot(cacheDir)
	const packageDir = cachedMswPackagePath(cacheDir)
	if (isMswInstalled(root)) return packageDir

	// Tests / local checkout: msw may already be resolvable from the CLI tree.
	// Skip this when a custom cacheDir or installInto seam is provided so the
	// on-demand install path stays testable.
	if (!input.cacheDir && !input.installInto) {
		const local = tryResolveLocalMswPackageDir()
		if (local) return local
	}

	input.onInstall?.(mswPackageSpec)
	const parent = dirname(root)
	await mkdir(parent, { recursive: true })
	const staging = await mkdtemp(join(parent, `.msw-${mswPinnedVersion}-`))
	try {
		if (input.installInto) {
			await input.installInto(staging)
		} else {
			await npmInstallMsw(staging, env)
		}
		if (!isMswInstalled(staging)) {
			throw mswInstallFailedError({
				reason: 'install finished but msw package.json was missing',
				packageDir,
			})
		}
		await rm(root, { recursive: true, force: true })
		await rename(staging, root)
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {})
		if (error instanceof StructuredCliError) throw error
		throw mswInstallFailedError({
			reason: error instanceof Error ? error.message : String(error),
			packageDir,
		})
	}

	if (!isMswInstalled(root)) {
		throw mswInstallFailedError({
			reason: 'cache move finished but msw package.json was missing',
			packageDir,
		})
	}
	return packageDir
}

function tryResolveLocalMswPackageDir(): string | null {
	try {
		const require = createRequire(import.meta.url)
		return dirname(require.resolve('msw/package.json'))
	} catch {
		return null
	}
}

/**
 * Ensure + dynamic-import the pinned MSW module from the Kody cache.
 */
export async function importMsw(
	input: EnsureMswInput = {},
): Promise<MswModule> {
	const packageDir = await ensureMsw(input)
	const require = createRequire(join(packageDir, 'package.json'))
	const entry = require.resolve('msw')
	return (await import(pathToFileURL(entry).href)) as MswModule
}

/** Absolute `file://` href for rewriting bundled `.kody/mocks.ts` imports. */
export async function resolveMswEntryHref(
	input: EnsureMswInput = {},
): Promise<string> {
	const packageDir = await ensureMsw(input)
	const require = createRequire(join(packageDir, 'package.json'))
	return pathToFileURL(require.resolve('msw')).href
}

async function npmInstallMsw(
	stagingDir: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	await writeFile(
		join(stagingDir, 'package.json'),
		`${JSON.stringify(
			{
				name: 'kody-msw-cache',
				private: true,
				dependencies: { msw: mswPinnedVersion },
			},
			null,
			2,
		)}\n`,
	)
	await new Promise<void>((resolve, reject) => {
		const installEnv = npmInstallEnv(env)
		const args = [
			'install',
			'--omit=dev',
			'--no-audit',
			'--no-fund',
			'--no-update-notifier',
			'--no-progress',
		]
		// Windows ships npm as npm.cmd, which spawn cannot run without cmd.exe.
		const launch =
			process.platform === 'win32'
				? windowsFileLaunch('npm', args, installEnv)
				: { file: 'npm', argv: args, verbatim: false }
		const child = spawn(launch.file, launch.argv, {
			cwd: stagingDir,
			env: installEnv,
			windowsHide: true,
			windowsVerbatimArguments: launch.verbatim,
			// Ignore stdout so a full pipe buffer cannot hang npm; keep stderr
			// for the failure message.
			stdio: ['ignore', 'ignore', 'pipe'],
		})
		let stderr = ''
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8')
			if (stderr.length > 64_000) stderr = stderr.slice(-64_000)
		})
		const timer = setTimeout(() => {
			child.kill('SIGTERM')
			reject(new Error(`npm install ${mswPackageSpec} timed out after 120s`))
		}, 120_000)
		child.on('error', (error) => {
			clearTimeout(timer)
			reject(
				new Error(
					`could not spawn npm (${error instanceof Error ? error.message : String(error)})`,
				),
			)
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code === 0) {
				resolve()
				return
			}
			const detail = stderr.trim().split('\n').at(-1) ?? `npm exited ${code}`
			reject(new Error(detail))
		})
	})
}

/**
 * Minimal env for the on-demand install: keep PATH/home/proxy/certs, drop user
 * `npm_config_*` so verbose/json logging cannot flood or change behavior.
 * Registry/cache overrides are re-applied when set (tests / offline mirrors).
 */
function npmInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const keep = new Set([
		'PATH',
		'HOME',
		'USERPROFILE',
		'TMPDIR',
		'TEMP',
		'TMP',
		'HTTP_PROXY',
		'HTTPS_PROXY',
		'NO_PROXY',
		'ALL_PROXY',
		'NODE_EXTRA_CA_CERTS',
		'SSL_CERT_FILE',
		'SSL_CERT_DIR',
		// Windows: npm.cmd needs cmd.exe, PATHEXT, and its per-user dirs.
		'PATHEXT',
		'SYSTEMROOT',
		'COMSPEC',
		'APPDATA',
		'LOCALAPPDATA',
	])
	const out: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue
		if (keep.has(key.toUpperCase())) out[key] = value
	}
	if (env.npm_config_registry) out.npm_config_registry = env.npm_config_registry
	if (env.npm_config_cache) out.npm_config_cache = env.npm_config_cache
	if (env.NPM_CONFIG_REGISTRY) out.NPM_CONFIG_REGISTRY = env.NPM_CONFIG_REGISTRY
	if (env.NPM_CONFIG_CACHE) out.NPM_CONFIG_CACHE = env.NPM_CONFIG_CACHE
	return {
		...out,
		CI: 'true',
		npm_config_yes: 'true',
		npm_config_fund: 'false',
		npm_config_audit: 'false',
		npm_config_update_notifier: 'false',
		npm_config_loglevel: 'error',
		// Never install into a user project / global prefix.
		npm_config_global: 'false',
	}
}

function mswInstallFailedError(input: {
	reason: string
	packageDir: string
}): StructuredCliError {
	return new StructuredCliError({
		code: 'bundle_failed',
		message: `Could not install ${mswPackageSpec} for --target mock (${input.reason}).`,
		target: 'mock',
		where: input.packageDir,
		fix:
			`Connect to the network and retry so the CLI can install ${mswPackageSpec} into the Kody cache ` +
			`(${dirname(input.packageDir)}). Offline? Set KODY_CACHE_DIR to a writable cache and install ` +
			`${mswPackageSpec} there first, then retry.`,
		details: { package: mswPackageSpec, cachePackageDir: input.packageDir },
	})
}

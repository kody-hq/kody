/**
 * Install pinned npm packages into the Kody user cache on demand, for tools
 * the CLI only needs on some paths (MSW for `--target mock`, the browser
 * stack for `kody app check`). Nothing is installed into the user project or
 * the global prefix, and nothing becomes a CLI install-time dependency.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { windowsFileLaunch } from './execution-context/windows-command.js'

/** True when every package in `names` has a `package.json` under `root`. */
export function cachedPackagesInstalled(
	root: string,
	names: ReadonlyArray<string>,
): boolean {
	return names.every((name) =>
		existsSync(join(root, 'node_modules', name, 'package.json')),
	)
}

/**
 * Install `dependencies` into `root` (`root/node_modules/...`) unless they are
 * already there. Installs into a sibling staging dir and renames it into
 * place, so an interrupted install never leaves a half-filled cache.
 * Throws a plain Error naming the reason; callers wrap it in their own fix.
 */
export async function ensureCachedNpmPackages(input: {
	root: string
	dependencies: Record<string, string>
	env: NodeJS.ProcessEnv
	timeoutMs?: number
	/** Called once when an install is about to start. */
	onInstall?: () => void
	/** Replaces `npm install` into the staging directory. */
	installInto?: (stagingDir: string) => Promise<void>
}): Promise<void> {
	const names = Object.keys(input.dependencies)
	if (cachedPackagesInstalled(input.root, names)) return
	input.onInstall?.()
	const parent = dirname(input.root)
	await mkdir(parent, { recursive: true })
	const staging = await mkdtemp(
		join(parent, `.${input.root.split(/[\\/]/).at(-1) ?? 'deps'}-`),
	)
	try {
		if (input.installInto) {
			await input.installInto(staging)
		} else {
			await npmInstallInto({
				dir: staging,
				dependencies: input.dependencies,
				env: input.env,
				timeoutMs: input.timeoutMs ?? 120_000,
			})
		}
		if (!cachedPackagesInstalled(staging, names)) {
			throw new Error(
				`install finished but ${names.join(', ')} package.json was missing`,
			)
		}
		await rm(input.root, { recursive: true, force: true })
		await rename(staging, input.root)
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => {})
		throw error
	}
	if (!cachedPackagesInstalled(input.root, names)) {
		throw new Error(
			`cache move finished but ${names.join(', ')} package.json was missing`,
		)
	}
}

async function npmInstallInto(input: {
	dir: string
	dependencies: Record<string, string>
	env: NodeJS.ProcessEnv
	timeoutMs: number
}): Promise<void> {
	await writeFile(
		join(input.dir, 'package.json'),
		`${JSON.stringify(
			{
				name: 'kody-cli-cache',
				private: true,
				dependencies: input.dependencies,
			},
			null,
			2,
		)}\n`,
	)
	const specs = Object.entries(input.dependencies)
		.map(([name, version]) => `${name}@${version}`)
		.join(' ')
	await new Promise<void>((resolve, reject) => {
		const installEnv = npmInstallEnv(input.env)
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
			cwd: input.dir,
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
			reject(
				new Error(
					`npm install ${specs} timed out after ${Math.round(input.timeoutMs / 1000)}s`,
				),
			)
		}, input.timeoutMs)
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
export function npmInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

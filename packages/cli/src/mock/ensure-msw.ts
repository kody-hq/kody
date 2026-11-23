/**
 * On-demand MSW for `--target mock` fetch mocking.
 *
 * Kept out of `dependencies` so cold `npx @kodycodes/cli` stays small; when a
 * mock path actually needs MSW (`.kody/mocks.ts` / handler dispatch), install
 * the pinned version into the Kody user cache (never the user project / global).
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	cachedPackagesInstalled,
	ensureCachedNpmPackages,
} from '../cached-npm-install.js'
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
	if (cachedPackagesInstalled(root, ['msw'])) return packageDir

	// Tests / local checkout: msw may already be resolvable from the CLI tree.
	// Skip this when a custom cacheDir or installInto seam is provided so the
	// on-demand install path stays testable.
	if (!input.cacheDir && !input.installInto) {
		const local = tryResolveLocalMswPackageDir()
		if (local) return local
	}

	try {
		await ensureCachedNpmPackages({
			root,
			dependencies: { msw: mswPinnedVersion },
			env,
			onInstall: () => input.onInstall?.(mswPackageSpec),
			...(input.installInto ? { installInto: input.installInto } : {}),
		})
	} catch (error) {
		throw mswInstallFailedError({
			reason: error instanceof Error ? error.message : String(error),
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

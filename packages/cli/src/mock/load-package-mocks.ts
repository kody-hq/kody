/**
 * Load optional `<packageRoot>/.kody/mocks.ts` for `--target mock` outbound
 * fetch mocking. Missing file → no MSW handlers (ambient/gatewayFetch use
 * public-network passthrough via the Node gateway; credentialed /
 * createAuthenticatedFetch hops still fail closed). Never imported into
 * published package bundles.
 */

import * as esbuild from 'esbuild'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StructuredCliError } from '../structured-error.js'
import {
	type EnsureMswInput,
	mswPackageSpec,
	resolveMswEntryHref,
} from './ensure-msw.js'

export const packageMocksRelativePath = '.kody/mocks.ts'

export type LoadedPackageMocks = {
	path: string
	handlers: Array<unknown>
}

export async function resolvePackageMocksPath(
	packageRoot: string,
): Promise<string | null> {
	const path = join(packageRoot, packageMocksRelativePath)
	try {
		await access(path)
		return path
	} catch {
		return null
	}
}

/**
 * Bundle and evaluate `.kody/mocks.ts`. Expects `export const handlers = […]`
 * (MSW `http.*` handlers) or a default export of that array.
 */
export async function loadPackageMocks(
	packageRoot: string,
	msw: EnsureMswInput = {},
): Promise<LoadedPackageMocks | null> {
	const path = await resolvePackageMocksPath(packageRoot)
	if (!path) return null

	const workDir = await mkdtemp(join(tmpdir(), 'kody-mocks-'))
	const outfile = join(workDir, 'mocks.mjs')
	try {
		const mswHref = await resolveMswEntryHref(msw)
		let result: esbuild.BuildResult
		try {
			result = await esbuild.build({
				entryPoints: [path],
				bundle: true,
				platform: 'node',
				format: 'esm',
				target: 'node22',
				outfile,
				write: true,
				logLevel: 'silent',
				// Leave MSW external; rewrite the import to the cache-resolved absolute URL.
				external: ['msw', 'msw/*'],
			})
		} catch (error) {
			throw bundleFailedError(path, error)
		}
		if (result.errors.length > 0) {
			throw bundleFailedError(path, { errors: result.errors })
		}
		const bundled = await readFile(outfile, 'utf8')
		const rewritten = bundled.replace(
			/(from\s*|import\s*\(|require\s*\()\s*(['"])msw\2/g,
			(_match, prefix: string, quote: string) =>
				`${prefix}${quote}${mswHref}${quote}`,
		)
		await writeFile(outfile, rewritten)
		const mod = (await import(pathToFileURL(outfile).href)) as {
			handlers?: unknown
			default?: unknown
		}
		const raw = mod.handlers ?? mod.default
		if (!Array.isArray(raw)) {
			throw new StructuredCliError({
				code: 'package_manifest_invalid',
				message: `${packageMocksRelativePath} must export \`handlers\` (or default) as an array of MSW http handlers.`,
				target: 'mock',
				where: path,
				fix: `export const handlers = [http.get('https://api.example.com/…', () => HttpResponse.json({ ok: true }))]`,
			})
		}
		return { path, handlers: raw as Array<unknown> }
	} catch (error) {
		if (error instanceof StructuredCliError) throw error
		throw new StructuredCliError({
			code: 'bundle_failed',
			message: `Could not load ${packageMocksRelativePath}.`,
			target: 'mock',
			where: path,
			fix:
				`Ensure the file exports MSW handlers. The CLI installs ${mswPackageSpec} into the Kody ` +
				`cache on first --target mock use that needs MSW.`,
			details: {
				cause: error instanceof Error ? error.message : String(error),
			},
		})
	} finally {
		await rm(workDir, { recursive: true, force: true })
	}
}

function bundleFailedError(path: string, error: unknown): StructuredCliError {
	const formatted = formatEsbuildErrors(path, error)
	return new StructuredCliError({
		code: 'bundle_failed',
		message: `Could not bundle ${packageMocksRelativePath} for --target mock.${formatted.summary ? ` ${formatted.summary}` : ''}`,
		target: 'mock',
		where: formatted.where ?? path,
		fix:
			`Fix TypeScript/syntax errors in .kody/mocks.ts and retry. Import handlers from \`msw\` ` +
			`(the CLI installs ${mswPackageSpec} into the Kody cache on demand).`,
		details: { errors: formatted.errors },
	})
}

function formatEsbuildErrors(
	mocksPath: string,
	error: unknown,
): { summary: string; where?: string; errors: Array<string> } {
	const messages: Array<esbuild.Message> = []
	if (error && typeof error === 'object' && 'errors' in error) {
		messages.push(...(error as esbuild.BuildFailure).errors)
	}
	if (messages.length === 0) {
		const text = error instanceof Error ? error.message : String(error)
		return { summary: text, errors: [text] }
	}
	const errors = messages.map((item) => {
		const loc = item.location
		if (loc?.file && typeof loc.line === 'number') {
			return `${loc.file}:${loc.line}:${loc.column ?? 0}: ${item.text}`
		}
		return item.text
	})
	const first = messages[0]?.location
	const where =
		first?.file && typeof first.line === 'number'
			? `${first.file}:${first.line}:${first.column ?? 0}`
			: mocksPath
	return {
		summary: errors[0] ?? '',
		where,
		errors,
	}
}

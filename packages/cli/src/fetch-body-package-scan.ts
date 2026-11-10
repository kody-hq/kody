/**
 * Walk a package entry's relative imports and collect fetch bodies that still
 * go through secret resolution. Stays off node_modules and test files.
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import {
	init as initEsModuleLexer,
	parse as parseEsModule,
} from 'es-module-lexer'
import { transform, type Loader } from 'esbuild'
import { findFetchBodiesMissingSecretResolution } from './fetch-body-secret-resolution.js'

const esModuleLexerReady = initEsModuleLexer()

const sourceExtensions = [
	'.ts',
	'.tsx',
	'.mts',
	'.cts',
	'.js',
	'.mjs',
	'.cjs',
	'.jsx',
]

const maxModules = 200

export async function findPackageFetchBodyWarnings(input: {
	entryPath: string
	packageRoot: string
}): Promise<Array<{ path: string; line: number }>> {
	await esModuleLexerReady
	const hits: Array<{ path: string; line: number }> = []
	const seen = new Set<string>()
	const queue = [input.entryPath]
	while (queue.length > 0 && seen.size < maxModules) {
		const resolved = await resolveSourceFile(queue.pop()!)
		if (resolved == null || seen.has(resolved)) continue
		const rel = relative(input.packageRoot, resolved).split('\\').join('/')
		if (
			rel.startsWith('..') ||
			rel.split('/').includes('node_modules') ||
			isTestModule(rel)
		) {
			continue
		}
		seen.add(resolved)
		let source: string
		try {
			source = await readFile(resolved, 'utf8')
		} catch {
			continue
		}
		for (const hit of findFetchBodiesMissingSecretResolution(source)) {
			hits.push({ path: rel, line: hit.line })
		}
		let imports: ReturnType<typeof parseEsModule>[0]
		try {
			imports = parseEsModule(await lexableModuleSource(resolved, source))[0]
		} catch {
			continue
		}
		for (const im of imports) {
			if (im.type === 'dynamic' || im.typeOnly === true) continue
			const specifier = im.specifier
			if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue
			queue.push(resolve(dirname(resolved), specifier))
		}
	}
	return hits
}

/**
 * es-module-lexer reads JavaScript only, so TypeScript and JSX are stripped
 * first with the loader the bundler picks for the extension (`.ts` is not
 * TSX, so `<T>(x: T) => x` stays a generic arrow).
 */
export function moduleLoaderForPath(path: string): Loader {
	switch (extname(path).toLowerCase()) {
		case '.ts':
		case '.mts':
		case '.cts':
			return 'ts'
		case '.tsx':
			return 'tsx'
		case '.jsx':
			return 'jsx'
		default:
			return 'js'
	}
}

async function lexableModuleSource(
	path: string,
	source: string,
): Promise<string> {
	const loader = moduleLoaderForPath(path)
	if (loader === 'js') return source
	const result = await transform(source, { loader, format: 'esm' })
	return result.code
}

function isTestModule(path: string): boolean {
	return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
}

async function resolveSourceFile(absPath: string): Promise<string | null> {
	const candidates = [absPath]
	if (extname(absPath) === '') {
		for (const ext of sourceExtensions) {
			candidates.push(`${absPath}${ext}`)
			candidates.push(join(absPath, `index${ext}`))
		}
	}
	for (const candidate of candidates) {
		try {
			const info = await stat(candidate)
			if (info.isFile()) return candidate
		} catch {
			// Try the next extension or index file.
		}
	}
	return null
}

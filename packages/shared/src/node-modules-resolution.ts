import * as resolveExports from 'resolve.exports'

/**
 * Bare-specifier resolution shared by the local CLI bundle (`kody dev`,
 * `kody check`) and hosted publish/rebuild bundles, so both pick the same
 * installed file for every npm import.
 *
 * Node/npm semantics: walk `node_modules` from the importing file's directory
 * up to the root, so a nested `pkg/node_modules/dep` wins over a hoisted
 * `node_modules/dep` of another major. When the package declares `exports`,
 * only `exports` applies; otherwise `module`, then `main`, then `index`.
 */

export type NodeModulesImportKind = 'import' | 'require'

export type NodeModulesFileSystem = {
	/** Contents of a file, or null when it does not exist. */
	readFile(path: string): string | null
	fileExists(path: string): boolean
}

export type NodeModulesResolution =
	| { kind: 'resolved'; path: string }
	/** No ancestor `node_modules` contains the package. */
	| { kind: 'not-found' }
	| { kind: 'error'; message: string }

/**
 * `default` always applies, plus `import` or `require` by import kind. The
 * hosted bundler historically matched `browser` and `node` together; keep
 * that so existing packages keep resolving the same entry.
 */
export const nodeModulesExportConditions = ['browser', 'node'] as const

export const nodeModulesResolveExtensions = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mts',
	'.mjs',
	'.json',
] as const

const legacyEntryFields = ['module', 'main'] as const

/** Maps an esbuild resolve `kind` to the `exports` condition it activates. */
export function nodeModulesImportKind(
	esbuildKind: string,
): NodeModulesImportKind {
	return esbuildKind === 'require-call' || esbuildKind === 'require-resolve'
		? 'require'
		: 'import'
}

export function parseBarePackageSpecifier(
	specifier: string,
): { packageName: string; subpath: string } | null {
	if (
		specifier.length === 0 ||
		specifier.startsWith('.') ||
		specifier.startsWith('/') ||
		specifier.includes('\\') ||
		/^[a-z][a-z0-9+.-]*:/i.test(specifier)
	) {
		return null
	}
	const segments = specifier.split('/')
	const scoped = segments[0]!.startsWith('@')
	if (scoped && (segments.length < 2 || segments[1] === '')) return null
	const nameSegmentCount = scoped ? 2 : 1
	const packageName = segments.slice(0, nameSegmentCount).join('/')
	if (
		packageName.endsWith('/') ||
		segments.slice(0, nameSegmentCount).includes('')
	) {
		return null
	}
	const rest = segments.slice(nameSegmentCount).join('/')
	return { packageName, subpath: rest ? `./${rest}` : '.' }
}

/**
 * Package directories to try, nearest first. `importerDirectory` uses `/`
 * separators and may be workspace-relative (`src`, `node_modules/a`) or
 * absolute (`/repo/src`, `C:/repo/src`). `node_modules/node_modules` is
 * skipped, as in Node.
 */
export function listNodeModulesPackageDirectories(
	importerDirectory: string,
	packageName: string,
): Array<string> {
	const absolute = importerDirectory.startsWith('/')
	const segments = importerDirectory.split('/').filter(Boolean)
	const lowest = /^[A-Za-z]:$/.test(segments[0] ?? '') ? 1 : 0
	const directories: Array<string> = []
	for (let depth = segments.length; depth >= lowest; depth -= 1) {
		if (depth > 0 && segments[depth - 1] === 'node_modules') continue
		const base = segments.slice(0, depth).join('/')
		const prefix = absolute ? `/${base}` : base
		directories.push(
			prefix === '' || prefix === '/'
				? `${prefix}node_modules/${packageName}`
				: `${prefix}/node_modules/${packageName}`,
		)
	}
	return directories
}

export function resolveNodeModulesImport(input: {
	specifier: string
	/** Directory of the importing file, `/`-separated. */
	importerDirectory: string
	kind: NodeModulesImportKind
	fs: NodeModulesFileSystem
}): NodeModulesResolution {
	const parsed = parseBarePackageSpecifier(input.specifier)
	if (!parsed) return { kind: 'not-found' }
	for (const packageDirectory of listNodeModulesPackageDirectories(
		input.importerDirectory,
		parsed.packageName,
	)) {
		const manifestSource = input.fs.readFile(`${packageDirectory}/package.json`)
		const manifest =
			manifestSource == null ? null : parseManifest(manifestSource)
		if (manifest?.exports != null) {
			return resolveViaExports({
				...input,
				manifest,
				packageDirectory,
				packageName: parsed.packageName,
				subpath: parsed.subpath,
			})
		}
		const resolved =
			parsed.subpath === '.'
				? resolveLegacyEntry(input.fs, packageDirectory, manifest)
				: resolveFileOrDirectory(
						input.fs,
						`${packageDirectory}/${parsed.subpath.slice(2)}`,
					)
		if (resolved) return { kind: 'resolved', path: resolved }
	}
	return { kind: 'not-found' }
}

type PackageManifest = Record<string, unknown> & { exports?: unknown }

function parseManifest(source: string): PackageManifest | null {
	try {
		const parsed: unknown = JSON.parse(source)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as PackageManifest)
			: null
	} catch {
		return null
	}
}

function resolveViaExports(input: {
	specifier: string
	kind: NodeModulesImportKind
	fs: NodeModulesFileSystem
	manifest: PackageManifest
	packageDirectory: string
	packageName: string
	subpath: string
}): NodeModulesResolution {
	let targets: Array<string> | void
	try {
		targets = resolveExports.exports(
			{ ...input.manifest, name: input.packageName },
			input.subpath,
			{
				conditions: [input.kind, ...nodeModulesExportConditions],
				unsafe: true,
			},
		)
	} catch (error) {
		return {
			kind: 'error',
			message: `Could not resolve "${input.specifier}" from "${input.packageDirectory}": ${
				error instanceof Error ? error.message : String(error)
			}`,
		}
	}
	for (const target of targets ?? []) {
		const path = normalizeJoin(input.packageDirectory, target)
		if (path && input.fs.fileExists(path)) return { kind: 'resolved', path }
	}
	return {
		kind: 'error',
		message: `Could not resolve "${input.specifier}": "${input.packageDirectory}/package.json" exports ${JSON.stringify(
			input.subpath,
		)} to a file that does not exist.`,
	}
}

function resolveLegacyEntry(
	fs: NodeModulesFileSystem,
	packageDirectory: string,
	manifest: PackageManifest | null,
) {
	for (const field of legacyEntryFields) {
		const entry = manifest?.[field]
		if (typeof entry !== 'string' || entry.trim() === '') continue
		const path = normalizeJoin(packageDirectory, entry)
		const resolved = path ? resolveFileOrDirectory(fs, path) : null
		if (resolved) return resolved
	}
	return resolveFileOrDirectory(fs, `${packageDirectory}/index`)
}

function resolveFileOrDirectory(fs: NodeModulesFileSystem, path: string) {
	const trimmed = path.replace(/\/+$/, '')
	if (fs.fileExists(trimmed) && path === trimmed) return trimmed
	for (const extension of nodeModulesResolveExtensions) {
		if (fs.fileExists(`${trimmed}${extension}`)) return `${trimmed}${extension}`
	}
	for (const extension of nodeModulesResolveExtensions) {
		const index = `${trimmed}/index${extension}`
		if (fs.fileExists(index)) return index
	}
	return null
}

function normalizeJoin(directory: string, relativePath: string) {
	const absolute = directory.startsWith('/')
	const segments = directory.split('/').filter(Boolean)
	const floor = segments.length
	for (const segment of relativePath.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') {
			if (segments.length <= floor) return null
			segments.pop()
			continue
		}
		segments.push(segment)
	}
	const joined = segments.join('/')
	return absolute ? `/${joined}` : joined
}

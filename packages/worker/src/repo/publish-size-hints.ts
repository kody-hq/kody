import { shouldStoreArtifactBlobAsLatin1 } from '#universal/package-file-media.ts'
import { kodyIgnoreFileName, omitKodyIgnoredFiles } from './kodyignore.ts'

export type LargePathHint = { path: string; bytes: number }

const moduleFilePattern = /\.(?:[cm]?[jt]sx?)$/i
const resolvableExtensions = [
	'',
	'.ts',
	'.tsx',
	'.mts',
	'.cts',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'/index.ts',
	'/index.tsx',
	'/index.js',
	'/index.mjs',
]
const relativeSpecifierPattern =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g

function normalizePath(path: string) {
	const parts: Array<string> = []
	for (const part of path.split('/')) {
		if (!part || part === '.') continue
		if (part === '..') parts.pop()
		else parts.push(part)
	}
	return parts.join('/')
}

function collectManifestEntryPaths(value: unknown, into: Set<string>) {
	if (typeof value === 'string') {
		if (moduleFilePattern.test(value)) into.add(normalizePath(value))
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) collectManifestEntryPaths(item, into)
		return
	}
	if (value && typeof value === 'object') {
		for (const item of Object.values(value)) {
			collectManifestEntryPaths(item, into)
		}
	}
}

function resolveRelativeModule(
	files: Record<string, string>,
	fromPath: string,
	specifier: string,
) {
	const fromDir = fromPath.split('/').slice(0, -1).join('/')
	const base = normalizePath(`${fromDir}/${specifier}`)
	const candidates = [base]
	// TypeScript ESM sources import `./x.js` for `./x.ts`.
	const jsToTs = base.replace(/\.([cm]?)js(x?)$/, '.$1ts$2')
	if (jsToTs !== base) candidates.push(jsToTs)
	for (const candidate of candidates) {
		for (const extension of resolvableExtensions) {
			const path = `${candidate}${extension}`
			if (Object.hasOwn(files, path)) return path
		}
	}
	return null
}

/**
 * The largest files under the package source root that runtime code does
 * not appear to import, for the memory/CPU limit error. Reachability is a
 * cheap text scan of relative imports from the `package.json` entry points
 * (no parsing, so it is safe to run after an isolate reset), so a file that
 * is only reached through a computed import can be listed.
 */
export function largestNonRuntimePaths(input: {
	files: Record<string, string>
	sourceRoot?: string
	limit?: number
}): Array<LargePathHint> {
	const trimmed = (input.sourceRoot ?? '').replace(/^(?:\.\/|\/)+|\/+$/g, '')
	const root = trimmed === '.' ? '' : trimmed
	const prefix = root === '' ? '' : `${root}/`
	const packageFiles: Record<string, string> = {}
	for (const [path, content] of Object.entries(
		omitKodyIgnoredFiles(input.files, root),
	)) {
		const relative = path.replace(/^\/+/, '')
		if (prefix !== '' && !relative.startsWith(prefix)) continue
		packageFiles[relative.slice(prefix.length)] = content
	}
	const entries = new Set<string>()
	try {
		const manifest = JSON.parse(packageFiles['package.json'] ?? '{}') as Record<
			string,
			unknown
		>
		for (const field of ['exports', 'main', 'module', 'kody']) {
			collectManifestEntryPaths(manifest[field], entries)
		}
	} catch {
		// An unparseable manifest leaves every file listed as a candidate.
	}
	const reachable = new Set<string>()
	const queue = [...entries].filter((path) => Object.hasOwn(packageFiles, path))
	while (queue.length > 0) {
		const path = queue.pop()!
		if (reachable.has(path)) continue
		reachable.add(path)
		if (!moduleFilePattern.test(path)) continue
		for (const match of packageFiles[path]!.matchAll(
			relativeSpecifierPattern,
		)) {
			const resolved = resolveRelativeModule(packageFiles, path, match[1]!)
			if (resolved && !reachable.has(resolved)) queue.push(resolved)
		}
	}
	const encoder = new TextEncoder()
	const hints: Array<LargePathHint> = []
	for (const [path, content] of Object.entries(packageFiles)) {
		if (reachable.has(path)) continue
		if (path === 'package.json' || path === kodyIgnoreFileName) continue
		// Binary snapshot files are Latin-1 strings: one char per byte.
		const bytes = shouldStoreArtifactBlobAsLatin1(path)
			? content.length
			: encoder.encode(content).byteLength
		hints.push({ path, bytes })
	}
	return hints
		.sort((left, right) => right.bytes - left.bytes)
		.slice(0, input.limit ?? 5)
}

function formatBytes(bytes: number) {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
	return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

/** One sentence naming the hints, or '' when there are none. */
export function formatLargestNonRuntimePaths(hints: Array<LargePathHint>) {
	if (hints.length === 0) return ''
	const list = hints
		.map((hint) => `\`${hint.path}\` (${formatBytes(hint.bytes)})`)
		.join(', ')
	return (
		`The largest files under the source root that runtime code does not ` +
		`import: ${list}. Add them (or their folders) to \`.kodyignore\` next ` +
		'to package.json if publish does not need them.'
	)
}

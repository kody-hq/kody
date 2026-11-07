import { shouldStoreArtifactBlobAsLatin1 } from '#universal/package-file-media.ts'
import { requiredPackageDocNames } from './required-package-docs.ts'
import type { RepoCheckStep } from './isolated-runner-limit-message.ts'
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
const requiredRootDocPaths = new Set<string>(
	requiredPackageDocNames.map((name) => name.toLowerCase()),
)

function scanPackageFiles(input: {
	files: Record<string, string>
	sourceRoot?: string
}) {
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
	let manifest: Record<string, unknown> = {}
	try {
		manifest = JSON.parse(packageFiles['package.json'] ?? '{}') as Record<
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
	const sized = Object.entries(packageFiles).map(([path, content]) => ({
		path,
		// Binary snapshot files are Latin-1 strings: one char per byte.
		bytes: shouldStoreArtifactBlobAsLatin1(path)
			? content.length
			: encoder.encode(content).byteLength,
	}))
	const dependencies =
		manifest.dependencies && typeof manifest.dependencies === 'object'
			? Object.keys(manifest.dependencies as Record<string, unknown>)
			: []
	return { reachable, sized, dependencies }
}

function bySizeDescending(left: LargePathHint, right: LargePathHint) {
	return right.bytes - left.bytes
}

export function largestNonRuntimePaths(input: {
	files: Record<string, string>
	sourceRoot?: string
	limit?: number
	/** Leave out files smaller than this; tiny configs never move the limit. */
	minBytes?: number
}): Array<LargePathHint> {
	const { reachable, sized } = scanPackageFiles(input)
	return sized
		.filter(
			(hint) =>
				!reachable.has(hint.path) &&
				hint.path !== 'package.json' &&
				hint.path !== kodyIgnoreFileName &&
				// Publish requires these, so never suggest ignoring them.
				!requiredRootDocPaths.has(hint.path.toLowerCase()) &&
				hint.bytes >= (input.minBytes ?? 0),
		)
		.sort(bySizeDescending)
		.slice(0, input.limit ?? 5)
}

/**
 * Smallest non-runtime file worth suggesting for `.kodyignore` after a limit
 * hit. Below this a file cannot plausibly have driven memory or CPU.
 */
export const ignorableHintMinBytes = 32 * 1024

/**
 * What a memory/CPU limit hit most likely had to process: the runtime source
 * reachable from the entry points (largest first), the npm dependencies the
 * bundler pulls in for it, and only the non-runtime files big enough to be
 * worth a `.kodyignore` entry.
 */
export type PublishSizeHints = {
	runtime: { fileCount: number; bytes: number; largest: Array<LargePathHint> }
	npmDependencies: Array<string>
	ignorable: Array<LargePathHint>
}

export function publishSizeHints(input: {
	files: Record<string, string>
	sourceRoot?: string
}): PublishSizeHints {
	const { reachable, sized, dependencies } = scanPackageFiles(input)
	const runtime = sized.filter((hint) => reachable.has(hint.path))
	return {
		runtime: {
			fileCount: runtime.length,
			bytes: runtime.reduce((total, hint) => total + hint.bytes, 0),
			largest: [...runtime].sort(bySizeDescending).slice(0, 5),
		},
		npmDependencies: dependencies,
		ignorable: largestNonRuntimePaths({
			...input,
			minBytes: ignorableHintMinBytes,
		}),
	}
}

/**
 * Steps that bundle (or could have, when the step is unknown). The other
 * steps read source text only, so naming npm dependencies or the runtime
 * import graph there blames work that never ran.
 */
function stepBundles(step: RepoCheckStep | null) {
	return step === null || step === 'bundle' || step === 'rebuild'
}

function stepReadsRuntimeGraph(step: RepoCheckStep | null) {
	return stepBundles(step) || step === 'typecheck'
}

/**
 * Sentences naming what drove the limit at `step`, or '' when nothing is
 * known. Pass `null` only when the step is unknown.
 */
export function formatPublishSizeHints(
	hints: PublishSizeHints | null,
	step: RepoCheckStep | null = null,
) {
	if (!hints) return ''
	const parts: Array<string> = []
	if (hints.runtime.fileCount > 0 && stepReadsRuntimeGraph(step)) {
		parts.push(
			`Runtime code reachable from the entry points: ${hints.runtime.fileCount} file(s), ${formatBytes(hints.runtime.bytes)}; the largest are ${formatHintList(hints.runtime.largest)}.`,
		)
	}
	if (hints.npmDependencies.length > 0 && stepBundles(step)) {
		const shown = hints.npmDependencies.slice(0, 10)
		const more = hints.npmDependencies.length - shown.length
		parts.push(
			`Every target also bundles the npm dependencies it imports (${shown
				.map((name) => `\`${name}\``)
				.join(
					', ',
				)}${more > 0 ? `, and ${more} more` : ''}); a large dependency graph usually costs more than the package's own source.`,
		)
	}
	const ignorable = formatLargestNonRuntimePaths(hints.ignorable)
	if (ignorable) parts.push(ignorable)
	return parts.join(' ')
}

function formatHintList(hints: Array<LargePathHint>) {
	return hints
		.map((hint) => `\`${hint.path}\` (${formatBytes(hint.bytes)})`)
		.join(', ')
}

function formatBytes(bytes: number) {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
	return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

/** One sentence naming the hints, or '' when there are none. */
export function formatLargestNonRuntimePaths(hints: Array<LargePathHint>) {
	if (hints.length === 0) return ''
	const list = formatHintList(hints)
	return (
		`The largest files under the source root that runtime code does not ` +
		`import: ${list}. Add them (or their folders) to \`.kodyignore\` next ` +
		'to package.json if publish does not need them.'
	)
}

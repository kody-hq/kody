import * as esbuild from 'esbuild'
import { relative, resolve } from 'node:path'

/** One esbuild diagnostic with a 1-based line/column and a code frame. */
export type BundleDiagnostic = {
	/** Path relative to the working directory, or null for location-less errors. */
	file: string | null
	line: number | null
	col: number | null
	message: string
	/** Source line plus caret, or null when esbuild gave no location. */
	frame: string | null
}

/** Thrown when esbuild fails; `diagnostics` keeps the structured locations. */
export class BundleError extends Error {
	readonly diagnostics: Array<BundleDiagnostic>
	constructor(message: string, diagnostics: Array<BundleDiagnostic>) {
		super(message)
		this.name = 'BundleError'
		this.diagnostics = diagnostics
	}
}

/**
 * Node builtins workerd resolves under `nodejs_compat` without the `node:`
 * prefix. Must match the hosted publish list
 * (`nodeBuiltinPackageNames` in the worker's bare-package-import-declarations),
 * so a dependency that does `require('stream')` bundles locally exactly when it
 * publishes.
 */
export const nodeBuiltinModuleNames = [
	'_http_agent',
	'_http_client',
	'_http_common',
	'_http_incoming',
	'_http_outgoing',
	'_http_server',
	'_stream_duplex',
	'_stream_passthrough',
	'_stream_readable',
	'_stream_transform',
	'_stream_wrap',
	'_stream_writable',
	'_tls_common',
	'_tls_wrap',
	'assert',
	'async_hooks',
	'buffer',
	'child_process',
	'cluster',
	'console',
	'constants',
	'crypto',
	'dgram',
	'diagnostics_channel',
	'dns',
	'domain',
	'events',
	'fs',
	'http',
	'http2',
	'https',
	'inspector',
	'module',
	'net',
	'os',
	'path',
	'perf_hooks',
	'process',
	'punycode',
	'querystring',
	'readline',
	'repl',
	'stream',
	'string_decoder',
	'sys',
	'timers',
	'tls',
	'trace_events',
	'tty',
	'url',
	'util',
	'v8',
	'vm',
	'wasi',
	'worker_threads',
	'zlib',
] as const

/**
 * Absolute paths of every non-node_modules package input in an esbuild
 * metafile (`absWorkingDir`-relative keys → absolute).
 */
export function bundleInputs(
	metafile: esbuild.Metafile | undefined,
	workingDir: string,
): Array<string> {
	return Object.keys(metafile?.inputs ?? {})
		.filter((path) => {
			// Virtual modules use `:`; real `node_modules` is a path segment
			// (not a filename like `node_modules-generated.ts`).
			if (path.includes(':') && !/^[A-Za-z]:[\\/]/.test(path)) return false
			return !path.split(/[/\\]/).includes('node_modules')
		})
		.map((path) => resolve(workingDir, path))
}

/**
 * esbuild options shared by one-shot bundles and `kody dev` rebuilds: follow
 * relative imports and npm packages, keep `kody:*` external for package-graph
 * + runtime binding, and leave Node builtins (`node:*` and bare `stream`,
 * `fs/promises`, …) external for workerd `nodejs_compat`.
 */
export function localBundleOptions(entry: string) {
	return {
		absWorkingDir: process.cwd(),
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'esm' as const,
		platform: 'neutral' as const,
		target: 'esnext',
		logLevel: 'silent' as const,
		packages: 'bundle' as const,
		external: [
			'kody:*',
			'node:*',
			...nodeBuiltinModuleNames.flatMap((name) => [name, `${name}/*`]),
		],
	} satisfies esbuild.BuildOptions
}

export type LocalUserBundle = {
	code: string
	/** Absolute paths of every non-node_modules input in the graph. */
	inputs: Array<string>
}

/**
 * Bundle a `--file` entry for local workerd the same way hosted execute /
 * publish resolves code. Includes the input graph (metafile) so callers can
 * compare against the publish snapshot.
 */
export async function bundleLocalUserModuleWithInputs(
	modulePath: string,
): Promise<LocalUserBundle> {
	const entry = resolve(modulePath)
	const options = { ...localBundleOptions(entry), metafile: true as const }
	let result: esbuild.BuildResult<{ metafile: true; write: false }>
	try {
		result = await esbuild.build(options)
	} catch (error) {
		throw createBundleError(modulePath, error)
	}
	const output = result.outputFiles?.[0]
	if (output === undefined) {
		throw new BundleError(
			`Could not bundle ${modulePath}: esbuild produced no output.`,
			[],
		)
	}
	if (result.errors.length > 0) {
		throw createBundleError(modulePath, { errors: result.errors })
	}
	return {
		code: output.text,
		inputs: bundleInputs(result.metafile, options.absWorkingDir),
	}
}

/**
 * Bundle a `--file` entry for local workerd the same way hosted execute /
 * publish resolves code.
 */
export async function bundleLocalUserModule(
	modulePath: string,
): Promise<string> {
	return (await bundleLocalUserModuleWithInputs(modulePath)).code
}

/**
 * `workingDir` is esbuild's `absWorkingDir` (locations are relative to it);
 * `displayRoot` is what reported paths are relative to.
 */
export function createBundleError(
	modulePath: string,
	error: unknown,
	paths: { workingDir: string; displayRoot: string } = {
		workingDir: process.cwd(),
		displayRoot: process.cwd(),
	},
): BundleError {
	const diagnostics = bundleDiagnostics(error, paths)
	const details = diagnostics.map(formatBundleDiagnostic).join('\n')
	const header = `Could not bundle ${modulePath}.`
	const body = details.length > 0 ? `${header}\n${details}` : header
	const messages = diagnostics.map((item) => item.message).join('\n')
	// Only when the unresolved specifier itself is kody:@ (not a path that happens
	// to contain that substring).
	if (/Could not resolve ["']kody:@/i.test(messages)) {
		return new BundleError(
			`${body}\nfix: Map the dependency in .kody/deps.json (or package.json#kody.localDeps), keep it in this package's exports, or log in so published package-graph can supply it.`,
			diagnostics,
		)
	}
	if (/Could not resolve|Cannot find module|ENOENT/i.test(body)) {
		return new BundleError(
			`${body}\nfix: Run \`npm install\` in the package directory (and any local deps), then retry.`,
			diagnostics,
		)
	}
	return new BundleError(body, diagnostics)
}

/** `file:line:col: message` followed by an indented code frame. */
export function formatBundleDiagnostic(item: BundleDiagnostic): string {
	const where =
		item.file !== null
			? `${item.file}${item.line !== null ? `:${item.line}` : ''}${item.col !== null ? `:${item.col}` : ''}: `
			: ''
	return `${where}${item.message}${item.frame ? `\n${item.frame}` : ''}`
}

function bundleDiagnostics(
	error: unknown,
	paths: { workingDir: string; displayRoot: string },
): Array<BundleDiagnostic> {
	if (isEsbuildFailure(error)) {
		return error.errors
			.filter((item) => item.text.trim().length > 0)
			.map((item) => toDiagnostic(item, paths))
	}
	return [
		{
			file: null,
			line: null,
			col: null,
			message: error instanceof Error ? error.message : String(error),
			frame: null,
		},
	]
}

function toDiagnostic(
	item: esbuild.Message,
	paths: { workingDir: string; displayRoot: string },
): BundleDiagnostic {
	const location = item.location
	if (!location) {
		return {
			file: null,
			line: null,
			col: null,
			message: item.text.trim(),
			frame: null,
		}
	}
	const absolute = resolve(paths.workingDir, location.file)
	const fromRoot = relative(paths.displayRoot, absolute)
	const file = fromRoot && !fromRoot.startsWith('..') ? fromRoot : absolute
	return {
		file,
		line: location.line,
		col: location.column + 1,
		message: item.text.trim(),
		frame: codeFrame(location),
	}
}

function codeFrame(location: esbuild.Location): string | null {
	if (!location.lineText) return null
	const gutter = String(location.line)
	const pad = ' '.repeat(gutter.length)
	const caretWidth = Math.max(
		1,
		Math.min(location.length || 1, location.lineText.length),
	)
	return (
		`  ${gutter} | ${location.lineText}\n` +
		`  ${pad} | ${' '.repeat(location.column)}${'^'.repeat(caretWidth)}`
	)
}

function isEsbuildFailure(error: unknown): error is esbuild.BuildFailure {
	return (
		typeof error === 'object' &&
		error !== null &&
		'errors' in error &&
		Array.isArray((error as { errors: unknown }).errors)
	)
}

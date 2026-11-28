import { rootSourcePrefix } from './module-graph-paths.ts'

type BundleSide = 'worker' | 'client' | 'any'

type UnsupportedImportsPluginBuild = {
	onResolve(
		options: { filter: RegExp },
		callback: (args: {
			path: string
			kind: string
		}) => { errors: Array<{ text: string }> } | undefined,
	): void
	onLoad(
		options: { filter: RegExp; namespace: string },
		callback: (args: {
			path: string
		}) => { errors: Array<{ text: string }> } | undefined,
	): void
}

const wasmSpecifierPattern = /\.wasm(?:[?#].*)?$/
const textModulePathPattern = /\.(?:[cm]?[jt]sx?|json|css)$/

/** `kody:` package exports are rewritten to JavaScript proxies before bundling. */
export function isWasmImportSpecifier(specifier: string) {
	return !specifier.startsWith('kody:') && wasmSpecifierPattern.test(specifier)
}

/**
 * The package bundler has no WebAssembly loader (it would parse the bytes as
 * JavaScript), so name the import and the supported alternatives instead.
 */
export function unsupportedWasmImportMessage(input: {
	specifier: string
	side: BundleSide
}) {
	const where =
		input.side === 'client'
			? 'browser client'
			: input.side === 'worker'
				? 'Worker (app entry, export, job)'
				: 'Worker or browser client'
	const head = `Cannot import "${input.specifier}": .wasm imports are not supported in package ${where} bundles.`
	const browserWorkaround =
		"Put the .wasm file in the app's `kody.app.assets` directory and load it in the browser with `WebAssembly.instantiateStreaming(fetch(<asset URL>))`."
	if (input.side === 'client') return `${head} ${browserWorkaround}`
	const workerReason =
		'Workers also block compiling WebAssembly from bytes at runtime, so server code needs a pure-JavaScript build of the library.'
	if (input.side === 'worker') {
		return `${head} ${workerReason} Or run the WebAssembly in the browser client (serve the .wasm from \`kody.app.assets\`).`
	}
	return `${head} ${browserWorkaround} ${workerReason}`
}

export function unsupportedBinaryImportMessage(path: string) {
	return `Cannot bundle "${displayPath(path)}": it is a binary file, and package bundles only import JavaScript, TypeScript, JSON and CSS. Serve it from the app's \`kody.app.assets\` directory instead.`
}

function displayPath(path: string) {
	const prefix = `${rootSourcePrefix}/`
	return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * Fails `.wasm` and other binary imports with an explanation at the import
 * site instead of letting esbuild parse the bytes as JavaScript.
 */
export function createUnsupportedImportsPlugin(input: {
	files: Record<string, string>
	side: BundleSide
}) {
	return {
		name: 'kody-unsupported-imports',
		setup(build: UnsupportedImportsPluginBuild) {
			build.onResolve({ filter: wasmSpecifierPattern }, (args) => {
				if (args.kind === 'entry-point' || !isWasmImportSpecifier(args.path)) {
					return
				}
				return {
					errors: [
						{
							text: unsupportedWasmImportMessage({
								specifier: args.path,
								side: input.side,
							}),
						},
					],
				}
			})
			build.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
				if (textModulePathPattern.test(args.path)) return
				const content = input.files[args.path]
				if (content == null || !content.includes('\0')) return
				return { errors: [{ text: unsupportedBinaryImportMessage(args.path) }] }
			})
		},
	}
}

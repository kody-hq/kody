import { rootSourcePrefix } from './module-graph-paths.ts'

type BundleSide = 'worker' | 'client'

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

export function isWasmImportSpecifier(specifier: string) {
	return wasmSpecifierPattern.test(specifier)
}

/**
 * Package bundles hand esbuild every non-TS/JSON/CSS file as JavaScript, so a
 * `.wasm` import used to fail as `Unexpected "\x00"` on the binary bytes.
 */
export function unsupportedWasmImportMessage(input: {
	specifier: string
	side: BundleSide
}) {
	const head = `Cannot import "${input.specifier}": .wasm imports are not supported in package ${input.side === 'client' ? 'browser client' : 'Worker (app entry, export, job)'} bundles.`
	if (input.side === 'client') {
		return `${head} Put the .wasm file in the app's \`kody.app.assets\` directory and load it with \`WebAssembly.instantiateStreaming(fetch(<asset URL>))\`.`
	}
	return `${head} Workers also block compiling WebAssembly from bytes at runtime, so run the WebAssembly in the browser client (serve the .wasm from \`kody.app.assets\`) or use a pure-JavaScript build of the library.`
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
				if (args.kind === 'entry-point') return
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
				const content = input.files[args.path]
				if (content == null || !content.includes('\0')) return
				return { errors: [{ text: unsupportedBinaryImportMessage(args.path) }] }
			})
		},
	}
}

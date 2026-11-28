import { scannableModuleFilePattern } from '#worker/credentials/module-placeholder-scan.ts'
import { collectModuleImportNodes } from '#worker/package-runtime/import-specifiers.ts'
import {
	dirname,
	joinPath,
	resolveWorkspaceSourceFilePath,
} from '#worker/package-runtime/module-graph-paths.ts'
import {
	isWasmImportSpecifier,
	unsupportedWasmImportMessage,
} from '#worker/package-runtime/package-bundle-unsupported-imports.ts'
import { isTypeDeclarationFilePath } from '#worker/package-runtime/static-kody-imports.ts'

export type UnresolvedRelativeImport = {
	importer: string
	specifier: string
}

/**
 * Static relative imports reachable from the entrypoints that resolve to no
 * file in `files`, and `.wasm` imports, the way the bundler would fail on
 * them. Cheap stand-in for esbuild when publish defers bundling to rebuild. Awaits
 * `collectModuleImportNodes` (lazy Babel parse). Files that do not parse are
 * skipped: other checks report them.
 */
export async function collectUnbundleableImports(input: {
	files: Record<string, string>
	entryPoints: ReadonlyArray<string>
}) {
	const unresolved: Array<UnresolvedRelativeImport> = []
	const wasm: Array<UnresolvedRelativeImport> = []
	const visited = new Set<string>()
	const stack = input.entryPoints.flatMap((entryPoint) => {
		const resolved = resolveWorkspaceSourceFilePath({
			files: input.files,
			path: entryPoint,
		})
		return resolved ? [resolved] : []
	})
	while (stack.length > 0) {
		const filePath = stack.pop()!
		if (visited.has(filePath)) continue
		visited.add(filePath)
		if (
			isTypeDeclarationFilePath(filePath) ||
			!scannableModuleFilePattern.test(filePath)
		) {
			continue
		}
		const source = input.files[filePath]
		if (source == null) continue
		let imports
		try {
			imports = (await collectModuleImportNodes(source, { filePath }))
				.literalImports
		} catch {
			continue
		}
		for (const node of imports) {
			const { specifier } = node
			if (node.kind !== 'static') continue
			if (isWasmImportSpecifier(specifier)) {
				wasm.push({ importer: filePath, specifier })
				continue
			}
			if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
			if (/[?#]/.test(specifier)) continue
			const resolved = resolveWorkspaceSourceFilePath({
				files: input.files,
				path: joinPath(dirname(filePath), specifier),
			})
			if (resolved) {
				stack.push(resolved)
			} else {
				unresolved.push({ importer: filePath, specifier })
			}
		}
	}
	return { unresolved, wasm }
}

export function formatWasmImportsMessage(
	wasm: ReadonlyArray<UnresolvedRelativeImport>,
) {
	const [first] = wasm
	if (!first) return ''
	const others = wasm
		.slice(1, 10)
		.map((entry) => `"${entry.specifier}" in "${entry.importer}"`)
	const more = others.length > 0 ? ` Also: ${others.join(', ')}.` : ''
	return `${unsupportedWasmImportMessage({ specifier: first.specifier, side: 'worker' })} Imported from "${first.importer}".${more}`
}

export function formatUnresolvedRelativeImportsMessage(
	unresolved: ReadonlyArray<UnresolvedRelativeImport>,
) {
	const shown = unresolved
		.slice(0, 10)
		.map((entry) => `"${entry.specifier}" in "${entry.importer}"`)
	const more =
		unresolved.length > shown.length
			? ` (and ${unresolved.length - shown.length} more)`
			: ''
	return `Package bundle target(s) import relative module(s) missing from the publish snapshot: ${shown.join(', ')}${more}. Add the file(s), fix the import path(s), or check .kodyignore, then publish again.`
}

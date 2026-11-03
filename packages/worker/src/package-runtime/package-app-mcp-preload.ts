import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	packageRuntimeModulePrefix,
	publicRuntimeModulePath,
	runtimeModulePath,
} from './module-graph-paths.ts'

function readModuleSource(
	module: WorkerLoaderModules[string] | undefined,
): string | null {
	if (typeof module === 'string') return module
	if (typeof module?.js === 'string') return module.js
	if (typeof module?.cjs === 'string') return module.cjs
	if (typeof module?.text === 'string') return module.text
	return null
}

const directKodyMcpPattern =
	/\bkody\s*\.\s*mcp\b|\bkody\s*\[\s*['"]mcp['"]\s*\]/
const runtimeImportSpecifierPattern =
	/(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g
const mcpAccessPattern = /\.\s*mcp\b|\[\s*['"]mcp['"]\s*\]/

/**
 * Bundled package-app modules rewrite `kody:runtime` to a relative virtual
 * path (`public-runtime.js`, `runtime.js`, or `package-runtime/<id>.js`).
 * Match both the bare specifier and those rewritten forms.
 */
function isKodyRuntimeImportSpecifier(specifier: string): boolean {
	if (specifier === 'kody:runtime') return true
	if (
		specifier === runtimeModulePath ||
		specifier.endsWith(`/${runtimeModulePath}`) ||
		specifier === publicRuntimeModulePath ||
		specifier.endsWith(`/${publicRuntimeModulePath}`)
	) {
		return true
	}
	const packageRuntimeSegment = `/${packageRuntimeModulePrefix}/`
	return (
		(specifier.startsWith(`${packageRuntimeModulePrefix}/`) ||
			specifier.includes(packageRuntimeSegment)) &&
		specifier.endsWith('.js')
	)
}

function sourceImportsKodyRuntime(source: string): boolean {
	for (const match of source.matchAll(runtimeImportSpecifierPattern)) {
		const specifier = match[1]
		if (specifier != null && isKodyRuntimeImportSpecifier(specifier)) {
			return true
		}
	}
	return false
}

/**
 * True when authored package modules reference `kody.mcp`. Those apps need
 * MCP server names advertised before Workerd ownKeys+GOPD destructuring, so
 * the generated entrypoint preloads `listMcpServerNames`. Hello-world and
 * other non-MCP modules stay on the lazy loader path.
 *
 * Same-module aliased access (`import { kody as api }` plus `api.mcp`,
 * including rewritten virtual runtime paths and `require()` / `import()`)
 * is a hit. Runtime import and `.mcp` access may also live in different
 * modules after a re-export, so the scan ORs those signals across the
 * whole module set rather than requiring both in one file.
 */
export function modulesReferenceKodyMcp(modules: WorkerLoaderModules): boolean {
	const sources: Array<string> = []
	for (const module of Object.values(modules)) {
		const source = readModuleSource(module)
		if (source != null) sources.push(source)
	}
	if (sources.some((source) => directKodyMcpPattern.test(source))) {
		return true
	}
	const importsRuntime = sources.some((source) =>
		sourceImportsKodyRuntime(source),
	)
	if (!importsRuntime) return false
	return sources.some((source) => mcpAccessPattern.test(source))
}

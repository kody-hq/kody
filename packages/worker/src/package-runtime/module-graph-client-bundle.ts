import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import {
	getPackageAppClientExternals,
	normalizePackageWorkspacePath,
} from '#worker/package-registry/manifest.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { importWorkerBundler } from '#worker/worker-bundler-modules.ts'
import { throwUnresolvedBarePackageImportsError } from './bare-package-import-declarations.ts'
import {
	collectLiteralImportNodes,
	isBarePackageImportSpecifier,
} from './import-specifiers.ts'
import {
	resolveWorkspaceSourceFilePath,
	wranglerConfigPaths,
} from './module-graph-paths.ts'
import {
	collectReachableSourceFilePaths,
	isBundlerRootConfigPath,
	isBundlerRootDependencyPath,
	readRootPackage,
} from './module-graph-workspace.ts'
import {
	buildPackageAppClientModuleName,
	clientModuleHashLength,
} from './package-app-client-module-name.ts'
import {
	assertNoPlatformSuppliedNodeModules,
	createNodeModulesResolutionPlugin,
} from './package-bundle-node-modules.ts'
import { createPackageAppJsxBundleOptions } from './package-app-tsconfig.ts'
import type { RuntimeBundle } from './runtime-bundle-types.ts'
import { iterateModuleSourceTexts } from './runtime-source-modules.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'

/**
 * Browser-side bundle for `package.json#kody.app.client`.
 *
 * The Worker `app` bundle rewrites `kody:` imports into runtime proxies that
 * only exist inside the package-app isolate. Nothing of the sort exists in a
 * browser, so the client graph is bundled from the raw workspace files with
 * esbuild's browser platform and any server-only specifier is rejected with a
 * message that names the file. The output is a single ESM module whose file
 * name carries a content hash, so the platform can serve it with immutable
 * cache headers and authors read the URL from `packageContext.clientModuleUrl`
 * instead of hardcoding it.
 */

/**
 * Specifier schemes that only resolve inside the Worker runtime. `kody:` is
 * the package runtime, `cloudflare:` is workerd, `node:` is nodejs_compat.
 */
const serverOnlySpecifierPrefixes = ['kody:', 'cloudflare:', 'node:'] as const

function isServerOnlySpecifier(specifier: string) {
	return serverOnlySpecifierPrefixes.some((prefix) =>
		specifier.startsWith(prefix),
	)
}

function isStylesheetSpecifier(specifier: string) {
	return /\.css(?:[?#].*)?$/i.test(specifier)
}

function formatSpecifierList(specifiers: Iterable<string>) {
	return [...new Set(specifiers)]
		.sort((left, right) => left.localeCompare(right))
		.map((specifier) => `"${specifier}"`)
		.join(', ')
}

type ClientGraphProblem = {
	modulePath: string
	specifiers: Array<string>
}

function collectServerOnlyImports(input: {
	files: Record<string, string>
	reachable: Set<string>
}) {
	const serverOnly: Array<ClientGraphProblem> = []
	const stylesheets: Array<ClientGraphProblem> = []
	for (const modulePath of [...input.reachable].sort()) {
		if (isTypeDeclarationFilePath(modulePath)) continue
		const source = input.files[modulePath]
		if (source == null) continue
		const serverOnlySpecifiers = new Set<string>()
		const stylesheetSpecifiers = new Set<string>()
		for (const node of collectLiteralImportNodes(source)) {
			if (isServerOnlySpecifier(node.specifier)) {
				serverOnlySpecifiers.add(node.specifier)
			} else if (isStylesheetSpecifier(node.specifier)) {
				stylesheetSpecifiers.add(node.specifier)
			}
		}
		if (serverOnlySpecifiers.size > 0) {
			serverOnly.push({
				modulePath,
				specifiers: [...serverOnlySpecifiers],
			})
		}
		if (stylesheetSpecifiers.size > 0) {
			stylesheets.push({
				modulePath,
				specifiers: [...stylesheetSpecifiers],
			})
		}
	}
	return { serverOnly, stylesheets }
}

function formatProblems(problems: Array<ClientGraphProblem>) {
	return problems
		.map(
			(problem) =>
				`${problem.modulePath}: ${formatSpecifierList(problem.specifiers)}`,
		)
		.join('; ')
}

function assertClientGraphIsBrowserSafe(input: {
	files: Record<string, string>
	reachable: Set<string>
	bundleLabel: string
}) {
	const { serverOnly, stylesheets } = collectServerOnlyImports(input)
	if (serverOnly.length > 0) {
		throw new Error(
			`${input.bundleLabel} imports server-only modules that cannot run in the browser (${formatProblems(
				serverOnly,
			)}). ` +
				'Keep kody:runtime, kody:@ package imports, cloudflare:*, and node:* in the Worker entry (kody.app.entry) and expose what the page needs over fetch or the realtime facet. ' +
				'If a client module needs a URL from a server-only route contract, pass that href as a prop instead of importing the server module.',
		)
	}
	if (stylesheets.length > 0) {
		throw new Error(
			`${input.bundleLabel} imports stylesheets (${formatProblems(
				stylesheets,
			)}), which the client bundle does not process. ` +
				'Put the .css file in the kody.app.assets directory and link it from the page, or inline the styles.',
		)
	}
}

function collectBrowserBundleFiles(input: {
	sourceFiles: Record<string, string>
	reachable: Set<string>
}) {
	const files: Record<string, string> = {}
	for (const [filePath, content] of Object.entries(input.sourceFiles)) {
		const normalizedPath = normalizePackageWorkspacePath(filePath)
		// Wrangler config would flip the bundler into nodejs_compat mode; the
		// browser bundle must always target the browser platform.
		if (wranglerConfigPaths.includes(normalizedPath)) continue
		if (
			isBundlerRootConfigPath(normalizedPath) ||
			isBundlerRootDependencyPath(normalizedPath) ||
			input.reachable.has(normalizedPath)
		) {
			files[normalizedPath] = content
		}
	}
	return files
}

/**
 * Whether a bare specifier is covered by a declared external: the external
 * itself or one of its subpaths (`preact` covers `preact/hooks`).
 */
export function isDeclaredClientExternal(
	specifier: string,
	externals: ReadonlyArray<string>,
) {
	return externals.some(
		(external) =>
			specifier === external || specifier.startsWith(`${external}/`),
	)
}

type EsbuildResolveArgs = { path: string }
type EsbuildPluginBuild = {
	onResolve(
		options: { filter: RegExp },
		callback: (
			args: EsbuildResolveArgs,
		) => { path: string; external: true } | undefined,
	): void
}

/**
 * Marks declared externals (exact specifier or a subpath of it) as external
 * for esbuild. The bundler's own `externals` option matches by raw string
 * prefix, so `preact` would also externalize `preact-render-to-string`,
 * which then fails the post-bundle check even though the author meant to
 * inline it. This plugin applies the same rule as `isDeclaredClientExternal`,
 * so what stays external is exactly what the import map is expected to map.
 */
export function createClientExternalsPlugin(externals: ReadonlyArray<string>) {
	return {
		name: 'kody-package-app-client-externals',
		setup(build: EsbuildPluginBuild) {
			// Bare specifiers only: relative and absolute paths never match.
			build.onResolve({ filter: /^[^./]/ }, (args) =>
				isDeclaredClientExternal(args.path, externals)
					? { path: args.path, external: true }
					: undefined,
			)
		},
	}
}

function assertBrowserBundleHasNoUnresolvedImports(input: {
	modules: WorkerLoaderModules
	bundleLabel: string
	externals: ReadonlyArray<string>
	sourceFiles: Record<string, string>
}) {
	const serverOnly = new Set<string>()
	const unresolved = new Set<string>()
	for (const [, source] of iterateModuleSourceTexts(input.modules)) {
		for (const node of collectLiteralImportNodes(source)) {
			if (isServerOnlySpecifier(node.specifier)) {
				serverOnly.add(node.specifier)
			} else if (
				isBarePackageImportSpecifier(node.specifier) &&
				!isDeclaredClientExternal(node.specifier, input.externals)
			) {
				unresolved.add(node.specifier)
			}
		}
	}
	if (serverOnly.size > 0) {
		throw new Error(
			`${input.bundleLabel} still references server-only modules after bundling (${formatSpecifierList(
				serverOnly,
			)}). A dependency pulled them in; pick a browser-compatible package or move that code to the Worker entry.`,
		)
	}
	if (unresolved.size > 0) {
		const unresolvedSpecifiers = [...unresolved].sort((left, right) =>
			left.localeCompare(right),
		)
		throwUnresolvedBarePackageImportsError({
			message: `${input.bundleLabel} still contains unresolved bare package imports after bundling (${formatSpecifierList(
				unresolved,
			)}). Declare the dependency in package.json so publish can install and inline it, list it under kody.app.client.externals and resolve it with an import map on the page, or import it from a full https:// URL the browser can load.`,
			unresolvedSpecifiers,
			sourceFiles: input.sourceFiles,
			clientExternals: input.externals,
		})
	}
}

export async function buildKodyAppClientBundle(input: {
	sourceFiles: Record<string, string>
	entryPoint: string
}): Promise<RuntimeBundle> {
	const bundleLabel = `Saved package app client "${normalizePackageWorkspacePath(
		input.entryPoint,
	)}" bundle`
	const entryPoint = resolveWorkspaceSourceFilePath({
		files: input.sourceFiles,
		path: input.entryPoint,
	})
	if (!entryPoint) {
		throw new Error(
			`${bundleLabel} entry was not found in the package source. Point package.json#kody.app.client at a .ts, .tsx, .js, or .jsx file in the repo.`,
		)
	}
	const rootPackage = readRootPackage(input.sourceFiles)
	const reachable = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint,
		rootPackage,
	})
	assertClientGraphIsBrowserSafe({
		files: input.sourceFiles,
		reachable,
		bundleLabel,
	})
	const files = collectBrowserBundleFiles({
		sourceFiles: input.sourceFiles,
		reachable,
	})
	assertNoPlatformSuppliedNodeModules({
		snapshotFiles: input.sourceFiles,
		bundlerFiles: files,
		bundleLabel,
	})
	// Externals come from the manifest in the files being built (not a cached
	// manifest) so a republish that changes them rebuilds against itself.
	const externals = rootPackage
		? getPackageAppClientExternals(rootPackage.manifest)
		: []
	// Keep the experimental bundler out of the Worker's top-level deploy graph.
	const { createWorker } = await importWorkerBundler()
	const bundle = await createWorker({
		files,
		entryPoint,
		bundle: true,
		target: 'es2022',
		...createPackageAppJsxBundleOptions(input.sourceFiles),
		__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
			...(externals.length > 0 ? [createClientExternalsPlugin(externals)] : []),
			createNodeModulesResolutionPlugin(files),
		],
	})
	const bundledModule = bundle.modules[bundle.mainModule]
	const source =
		typeof bundledModule === 'string'
			? bundledModule
			: typeof bundledModule?.js === 'string'
				? bundledModule.js
				: null
	if (source == null) {
		throw new Error(
			`${bundleLabel} produced no JavaScript output for "${entryPoint}".`,
		)
	}
	const modules: WorkerLoaderModules = { [bundle.mainModule]: source }
	assertBrowserBundleHasNoUnresolvedImports({
		modules,
		bundleLabel,
		externals,
		sourceFiles: input.sourceFiles,
	})
	const hash = (await sha256Base64Url(source)).slice(0, clientModuleHashLength)
	const mainModule = buildPackageAppClientModuleName(hash)
	return {
		mainModule,
		modules: { [mainModule]: source },
		dependencies: [],
	}
}

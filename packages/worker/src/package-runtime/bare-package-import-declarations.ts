import {
	getPackageAppClientExternals,
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import type { AuthoredPackageJson } from '#worker/package-registry/types.ts'
import type { ModuleSourceParseError } from '#worker/module-source.ts'
import { UserCodeError } from '#worker/user-code-error.ts'
import {
	getBarePackageNameFromSpecifier,
	isBarePackageImportSpecifier,
	parseBundlerResolvedSpecifiers,
} from './import-specifiers.ts'
import {
	dirname,
	joinPath,
	resolveWorkspaceSourceFilePath,
} from './module-graph-paths.ts'
import { readRootPackage } from './module-graph-workspace.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from './package-import-resolution.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'

export type PackageBundleImportTarget = {
	path: string
	bundleKind: 'app' | 'client' | 'callable' | 'importable'
}

export type BareImportParseFailure = ModuleSourceParseError & {
	path: string
}

export type UndeclaredBarePackageImport = {
	packageName: string
	entryPoints: Array<string>
	specifiers: Array<string>
}

/**
 * True when a bare package name is already available to the bundler from the
 * authored snapshot: declared in package.json#dependencies (what install uses)
 * or vendored at node_modules/<name>/package.json. devDependencies do not
 * count — createWorker only installs dependencies.
 */
export function isBarePackageResolvableFromPackageSource(input: {
	packageName: string
	declaredDependencies: ReadonlyArray<string>
	sourceFiles: Record<string, string>
}) {
	if (input.declaredDependencies.includes(input.packageName)) {
		return true
	}
	return (
		input.sourceFiles[
			normalizePackageWorkspacePath(
				`node_modules/${input.packageName}/package.json`,
			)
		] != null
	)
}

export function parseDeclaredNpmDependencyNames(
	packageJsonContent: string | null | undefined,
) {
	if (!packageJsonContent) return [] as Array<string>
	const parsed = JSON.parse(packageJsonContent) as {
		dependencies?: unknown
	}
	const dependencies = parsed.dependencies
	if (
		dependencies !== undefined &&
		(!dependencies ||
			typeof dependencies !== 'object' ||
			Array.isArray(dependencies))
	) {
		throw new Error('package.json dependencies must be an object when present.')
	}
	return Object.keys(dependencies ?? {}).sort((left, right) =>
		left.localeCompare(right),
	)
}

function formatQuotedList(values: ReadonlyArray<string>) {
	return values.map((value) => `"${value}"`).join(', ')
}

/**
 * Host Node builtins that Workers resolves under `nodejs_compat` without an
 * npm install (unprefixed `path`, `fs/promises`, …). Prefixed `node:` imports
 * are already excluded by `isBarePackageImportSpecifier`. Package names are
 * the unscoped root (`fs` covers `fs/promises`). This is a host runtime
 * affordance, not a framework special case.
 */
const nodeBuiltinPackageNames = new Set([
	'_http_agent',
	'_http_client',
	'_http_common',
	'_http_incoming',
	'_http_outgoing',
	'_http_server',
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
])

export function isNodeBuiltinBarePackageName(packageName: string) {
	return nodeBuiltinPackageNames.has(packageName)
}

/**
 * Authored sources Babel can parse for import edges. Bundler-supported
 * non-JS leaves (JSON, CSS, wasm, …) are reachable but not parsed here.
 */
function isBundlerParsedModuleSourcePath(filePath: string) {
	return (
		/\.(?:[cm]?[jt]sx?)$/i.test(filePath) &&
		!isTypeDeclarationFilePath(filePath)
	)
}

/**
 * Same rule as module-graph-client-bundle `isDeclaredClientExternal`: an
 * external covers itself and its subpaths (`preact` covers `preact/hooks`).
 * Kept local so this module does not import the client bundler (cycle risk).
 */
function isCoveredByDeclaredExternal(
	specifier: string,
	externals: ReadonlyArray<string>,
) {
	return externals.some(
		(external) =>
			specifier === external || specifier.startsWith(`${external}/`),
	)
}

function resolveBundlerLocalImportPath(input: {
	files: Record<string, string>
	fromPath: string
	specifier: string
}) {
	if (!input.specifier.startsWith('./') && !input.specifier.startsWith('../')) {
		return null
	}
	return resolveWorkspaceSourceFilePath({
		files: input.files,
		path: joinPath(dirname(input.fromPath), input.specifier),
	})
}

/**
 * Reachable authored sources for the undeclared-bare-import gate. Follows the
 * same literal edges `createWorker` resolves (`import` / `export … from`,
 * `import()`, and `require()` / `import = require()`), including helpers only
 * reached through relative `require('./helper')`. Unparseable sources are
 * recorded so the gate can fail closed instead of skipping them.
 */
/** Bundler specifiers (or the parse error) per module path. */
type BundlerSpecifiersCache = Map<
	string,
	ReturnType<typeof parseBundlerResolvedSpecifiers>
>

function bundlerSpecifiersFor(
	cache: BundlerSpecifiersCache,
	filePath: string,
	source: string,
) {
	const cached = cache.get(filePath)
	if (cached) return cached
	const result = parseBundlerResolvedSpecifiers(source, { filePath })
	cache.set(filePath, result)
	return result
}

function collectBundlerReachableSourceFilePaths(input: {
	files: Record<string, string>
	entryPoint: string
	rootPackage: ReturnType<typeof readRootPackage>
	specifiersCache: BundlerSpecifiersCache
}) {
	const reachable = new Set<string>()
	const unparseableFiles = new Map<string, BareImportParseFailure>()
	const stack = [
		resolveWorkspaceSourceFilePath({
			files: input.files,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint),
	]
	while (stack.length > 0) {
		const filePath = stack.pop()
		if (
			!filePath ||
			reachable.has(filePath) ||
			isTypeDeclarationFilePath(filePath)
		) {
			continue
		}
		const source = input.files[filePath]
		if (source == null) continue
		reachable.add(filePath)
		if (!isBundlerParsedModuleSourcePath(filePath)) {
			continue
		}
		const parsed = bundlerSpecifiersFor(input.specifiersCache, filePath, source)
		if (!parsed.ok) {
			unparseableFiles.set(filePath, { path: filePath, ...parsed.error })
			continue
		}
		for (const specifier of parsed.specifiers) {
			if (specifier.startsWith(packageSpecifierPrefix)) {
				// Dynamic import()/require() of kody:@ can be malformed or name a
				// missing self-export. Do not abort the dependencies gate — other
				// check phases surface those caller errors.
				try {
					const parsed = parseKodyPackageSpecifier(specifier)
					if (
						input.rootPackage &&
						parsed.packageName === input.rootPackage.manifest.name
					) {
						const exportPath = resolvePackageExportPath({
							manifest: input.rootPackage.manifest,
							exportName: parsed.exportName,
						})
						stack.push(
							resolveWorkspaceSourceFilePath({
								files: input.files,
								path: exportPath,
							}) ?? exportPath,
						)
					}
				} catch {
					// skip unresolvable self-package edges
				}
				continue
			}
			const localPath = resolveBundlerLocalImportPath({
				files: input.files,
				fromPath: filePath,
				specifier,
			})
			if (localPath && !reachable.has(localPath)) {
				stack.push(localPath)
			}
		}
	}
	return { reachable, unparseableFiles }
}

/**
 * Walk each publishable entry's reachable graph and collect bare package names
 * that are neither declared in package.json#dependencies nor present under
 * snapshot node_modules/. Client-entry targets also treat
 * kody.app.client.externals as resolved (left for the page import map).
 * Node builtins and unparseable sources are handled by the validator.
 */
export function collectUndeclaredBarePackageImports(input: {
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
	entryPoints: ReadonlyArray<PackageBundleImportTarget>
	declaredDependencies?: ReadonlyArray<string>
}): {
	undeclared: Array<UndeclaredBarePackageImport>
	unparseableFiles: Array<string>
	parseFailures: Array<BareImportParseFailure>
} {
	const declaredDependencies =
		input.declaredDependencies ??
		parseDeclaredNpmDependencyNames(input.sourceFiles['package.json'] ?? null)
	const rootPackage = readRootPackage(input.sourceFiles)
	const clientExternals = getPackageAppClientExternals(input.manifest)
	const byPackage = new Map<
		string,
		{ entryPoints: Set<string>; specifiers: Set<string> }
	>()
	const unparseableFiles = new Map<string, BareImportParseFailure>()
	// Entries share most modules (about 100 targets on big packages): parse
	// each module once for the whole walk, not twice per entry.
	const specifiersCache: BundlerSpecifiersCache = new Map()

	for (const target of input.entryPoints) {
		const entryPoint = normalizePackageWorkspacePath(target.path)
		const reachable = collectBundlerReachableSourceFilePaths({
			files: input.sourceFiles,
			entryPoint,
			rootPackage,
			specifiersCache,
		})
		for (const [filePath, failure] of reachable.unparseableFiles) {
			unparseableFiles.set(filePath, failure)
		}
		for (const filePath of reachable.reachable) {
			if (!isBundlerParsedModuleSourcePath(filePath)) continue
			const source = input.sourceFiles[filePath]
			if (source == null) continue
			const parsed = bundlerSpecifiersFor(specifiersCache, filePath, source)
			if (!parsed.ok) {
				unparseableFiles.set(filePath, { path: filePath, ...parsed.error })
				continue
			}
			for (const specifier of parsed.specifiers) {
				if (!isBarePackageImportSpecifier(specifier)) continue
				const packageName = getBarePackageNameFromSpecifier(specifier)
				if (!packageName) continue
				if (isNodeBuiltinBarePackageName(packageName)) continue
				if (
					isBarePackageResolvableFromPackageSource({
						packageName,
						declaredDependencies,
						sourceFiles: input.sourceFiles,
					})
				) {
					continue
				}
				if (
					target.bundleKind === 'client' &&
					isCoveredByDeclaredExternal(specifier, clientExternals)
				) {
					continue
				}
				let existing = byPackage.get(packageName)
				if (!existing) {
					existing = { entryPoints: new Set(), specifiers: new Set() }
					byPackage.set(packageName, existing)
				}
				existing.entryPoints.add(entryPoint)
				existing.specifiers.add(specifier)
			}
		}
	}

	return {
		undeclared: [...byPackage.entries()]
			.map(([packageName, value]) => ({
				packageName,
				entryPoints: [...value.entryPoints].sort((left, right) =>
					left.localeCompare(right),
				),
				specifiers: [...value.specifiers].sort((left, right) =>
					left.localeCompare(right),
				),
			}))
			.sort((left, right) => left.packageName.localeCompare(right.packageName)),
		unparseableFiles: [...unparseableFiles.keys()].sort((left, right) =>
			left.localeCompare(right),
		),
		parseFailures: [...unparseableFiles.values()].sort((left, right) =>
			left.path.localeCompare(right.path),
		),
	}
}

export function formatUndeclaredBarePackageImportsMessage(
	undeclared: ReadonlyArray<UndeclaredBarePackageImport>,
) {
	const details = undeclared.map(
		(entry) =>
			`${formatQuotedList([entry.packageName])} (from ${formatQuotedList(entry.entryPoints)})`,
	)
	return (
		`Package entry imports undeclared bare package(s): ${details.join('; ')}. ` +
		'Add them to package.json#dependencies (or vendor node_modules/<name> in the package snapshot) before publish.'
	)
}

function formatBareImportParseFailure(failure: BareImportParseFailure) {
	const location =
		failure.line == null
			? ''
			: failure.column == null
				? `:${failure.line}`
				: `:${failure.line}:${failure.column}`
	return `"${failure.path}${location}": ${failure.message}`
}

function formatUnparseableBareImportFilesMessage(
	failures: ReadonlyArray<BareImportParseFailure>,
) {
	return (
		`Package entry source could not be parsed for bare-import dependency checks (${failures.map(formatBareImportParseFailure).join('; ')}). ` +
		'Fix the syntax so publish can verify declared dependencies before advancing published_commit.'
	)
}

export function validateBarePackageImportDeclarations(input: {
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
	entryPoints: ReadonlyArray<PackageBundleImportTarget>
	declaredDependencies?: ReadonlyArray<string>
}) {
	const { undeclared, unparseableFiles, parseFailures } =
		collectUndeclaredBarePackageImports(input)
	if (unparseableFiles.length > 0) {
		return {
			ok: false as const,
			message: formatUnparseableBareImportFilesMessage(parseFailures),
			undeclared,
			unparseableFiles,
			parseFailures,
		}
	}
	if (undeclared.length === 0) {
		return {
			ok: true as const,
			message:
				'Package entry imports resolve from package.json#dependencies or vendored node_modules.',
		}
	}
	return {
		ok: false as const,
		message: formatUndeclaredBarePackageImportsMessage(undeclared),
		undeclared,
	}
}

/**
 * Specifiers left in a post-bundle module graph that still look like bare
 * package imports (createWorker marked them external because install/resolution
 * did not inline them).
 */
export function listUnresolvedBarePackageNames(
	specifiers: ReadonlyArray<string>,
) {
	return [
		...new Set(
			specifiers
				.map((specifier) => getBarePackageNameFromSpecifier(specifier))
				.filter((name): name is string => name != null),
		),
	].sort((left, right) => left.localeCompare(right))
}

/**
 * True when every unresolved bare package is missing from both
 * package.json#dependencies and snapshot node_modules — a caller-fixable
 * declaration mistake. False when any unresolved package *is* declared or
 * vendored (install/subpath/Workers resolution failed → platform error).
 */
export function isUndeclaredBarePackageImportFailure(input: {
	unresolvedSpecifiers: ReadonlyArray<string>
	sourceFiles: Record<string, string>
	declaredDependencies?: ReadonlyArray<string>
	/**
	 * Specifiers the client bundle intentionally leaves external. Only apply
	 * for app-client asserts; server/module bundles pass [].
	 */
	clientExternals?: ReadonlyArray<string>
}) {
	const declaredDependencies =
		input.declaredDependencies ??
		parseDeclaredNpmDependencyNames(input.sourceFiles['package.json'] ?? null)
	const clientExternals = input.clientExternals ?? []
	const unresolvedPackages = listUnresolvedBarePackageNames(
		input.unresolvedSpecifiers.filter(
			(specifier) => !isCoveredByDeclaredExternal(specifier, clientExternals),
		),
	)
	if (unresolvedPackages.length === 0) return false
	return unresolvedPackages.every(
		(packageName) =>
			!isNodeBuiltinBarePackageName(packageName) &&
			!isBarePackageResolvableFromPackageSource({
				packageName,
				declaredDependencies,
				sourceFiles: input.sourceFiles,
			}),
	)
}

/**
 * Throw UserCodeError when the unresolved bare imports are entirely
 * undeclared/unvendored; otherwise a plain Error (declared dep failed to
 * install or resolve — keep as a platform signal).
 */
export function throwUnresolvedBarePackageImportsError(input: {
	message: string
	unresolvedSpecifiers: ReadonlyArray<string>
	sourceFiles: Record<string, string>
	clientExternals?: ReadonlyArray<string>
}): never {
	if (
		isUndeclaredBarePackageImportFailure({
			unresolvedSpecifiers: input.unresolvedSpecifiers,
			sourceFiles: input.sourceFiles,
			clientExternals: input.clientExternals,
		})
	) {
		throw new UserCodeError(input.message)
	}
	throw new Error(input.message)
}

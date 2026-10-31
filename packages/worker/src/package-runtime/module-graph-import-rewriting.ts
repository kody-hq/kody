import { publishedArtifactNeedsPackageBindingRebuild } from './pre-binding-artifact-repair.ts'
import { collectTopLevelFetchCollisionNames } from './rewrite-local-execute-secret-fetch.ts'
import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	normalizePackageExportKey,
	normalizePackageWorkspacePath,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
	resolveSavedPackageImport,
	SavedPackageNotFoundError,
} from './package-import-resolution.ts'
import {
	loadPublishedBundleArtifactByIdentity,
	loadPublishedBundleArtifactsByIdentities,
	publishedBundleLoadIdentityKey,
	type LoadedPublishedBundleArtifact,
} from './published-bundle-artifacts.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'
import { isTypeDeclarationFilePath } from './static-kody-imports.ts'
import { assertNotSealedSecretProviderExport } from '#mcp/secrets/secret-providers/sealed-export.ts'
import {
	collectBundlerResolvedSpecifiers,
	collectModuleImportNodesCached,
	type ModuleImportNodesCache,
} from './import-specifiers.ts'
import { type BundleArtifactDependency } from './published-runtime-artifacts.ts'
import {
	createPackageProxyPathSegment,
	createRelativeImportSpecifier,
	encodePathKeyAsPath,
	joinPath,
	normalizeWorkspaceModulePath,
	packageImportProxyPrefix,
	packageManifestPath,
	packageSourcePrefix,
	rootSourcePrefix,
	dynamicPackageImportProxyPrefix,
	publicRuntimeModulePath,
	resolveRelativeModulePath,
	specifierTargetsKodyVirtualModule,
	textMentionsKodyVirtualModule,
	resolveWorkspaceSourceFilePath,
	runtimeModulePath,
} from './module-graph-paths.ts'
import {
	buildInternalKodyVirtualImportMessage,
	buildPackageRuntimeModulePath,
	createComputedDynamicImportGuardSource,
	createRemovedDynamicKodyImportHelperSource,
	createMeteredPackageImportProxySource,
	createPackageImportProxySource,
	createPackageRuntimeModuleSource,
	createPublicRuntimeModuleSource,
	createRuntimeModuleSource,
	iterateModuleSourceTexts,
	refreshKodyRuntimeModules,
} from './runtime-source-modules.ts'
import { collectModuleExportNames } from './module-export-names.ts'
import { materializePublishedArtifactModules } from './module-graph-artifacts.ts'
import {
	collectReachableSourceFilePaths,
	isBundlerRootConfigPath,
	isBundlerRootDependencyPath,
	readRootPackage,
	resolvePackageExportSourcePath,
} from './module-graph-workspace.ts'

type RewriteReplacement = {
	start: number
	end: number
	value: string
}

export type LoadedKodyGraphPackage = LoadedPackageSource & {
	row: SavedPackageRecord
	prefix: string
	/**
	 * True once this package's published source snapshot has been rewritten
	 * into `RewriteState.files` for a live rebuild. Published importable
	 * artifacts skip that materialization so dual heavy export graphs (for
	 * example two zod trees from one package) do not inflate the bundler VFS.
	 */
	sourceMaterialized?: boolean
}

export type LoadedKodyGraphPackages = Map<string, LoadedKodyGraphPackage>

type RewriteState = {
	env: Env
	baseUrl: string
	userId: string
	files: Record<string, string>
	sourceFiles: Record<string, string>
	rootPackage: {
		manifest: AuthoredPackageJson
		prefix: string
	} | null
	/**
	 * Saved-package UUID of the root source when the graph is being built for
	 * a saved package's own module (publish/invocation builds). Root modules
	 * are then stamped with per-package runtime modules just like statically
	 * imported dependency modules, so the stamp survives into published
	 * artifacts that later get composed into foreign bundles.
	 */
	rootPackageId: string | null
	proxies: Map<string, string>
	dynamicPackageImports: Map<string, string>
	packages: LoadedKodyGraphPackages
	/**
	 * Dependencies recorded on published importable artifacts that were
	 * composed without materializing package source into the bundler VFS.
	 * Merged into consumer dependency metadata so transitive packageStorage
	 * grants still work when nested `kody:@` imports never trigger a live
	 * rewrite pass.
	 */
	publishedArtifactDependencies: Array<BundleArtifactDependency>
	/**
	 * Shared with reachability so each source string is parsed once per
	 * prepare.
	 */
	importNodesCache: ModuleImportNodesCache
	/**
	 * Importable-module artifacts prefetched in one batched identity SELECT
	 * per module, keyed by {@link publishedBundleLoadIdentityKey}.
	 */
	prefetchedPublishedArtifacts: Map<
		string,
		LoadedPublishedBundleArtifact | null
	>
}

async function maybeEnsurePublishedArtifactTarget(input: {
	state: RewriteState
	specifier: string
	loaded: LoadedKodyGraphPackage
}): Promise<string | null> {
	if (!input.loaded.source.published_commit) {
		return null
	}
	const parsed = parseKodyPackageSpecifier(input.specifier)
	assertNotSealedSecretProviderExport(parsed.exportName)
	const exportName = normalizePackageExportKey(parsed.exportName)
	const entryPoint = resolvePackageExportPath({
		manifest: input.loaded.manifest,
		exportName,
	})
	const identity = {
		sourceId: input.loaded.row.sourceId,
		kind: 'importable-module' as const,
		artifactName: exportName,
		entryPoint,
	}
	const prefetchKey = publishedBundleLoadIdentityKey(identity)
	const artifact = input.state.prefetchedPublishedArtifacts.has(prefetchKey)
		? input.state.prefetchedPublishedArtifacts.get(prefetchKey)
		: await loadPublishedBundleArtifactByIdentity({
				env: input.state.env,
				userId: input.state.userId,
				...identity,
			})
	if (!artifact?.artifact) {
		return null
	}
	// A pre-fix bundle that inlines other packages cannot be bound to one
	// package in place (the reader binds single-package ones), so build this
	// package from source instead. When that source needs an npm install it
	// cannot rebuild here: keep composing the published artifact, as the other
	// load sites do, and `publishedArtifactNeedsPackageBindingRebuild` logs
	// `pre_binding_bundle_needs_republish` so the unbound bundle is visible.
	if (
		publishedArtifactNeedsPackageBindingRebuild({
			artifact: artifact.artifact,
			sourceFiles: input.loaded.files,
		})
	) {
		return null
	}
	const artifactPrefix = joinPath(
		input.loaded.prefix,
		'.__published_bundle__',
		encodePathKeyAsPath(exportName),
	)
	for (const [modulePath, module] of Object.entries(
		materializePublishedArtifactModules({
			artifactPrefix,
			modules: artifact.artifact.modules,
		}),
	)) {
		input.state.files[modulePath] = module
	}
	for (const dependency of artifact.artifact.dependencies) {
		input.state.publishedArtifactDependencies.push(dependency)
	}
	return joinPath(artifactPrefix, artifact.artifact.mainModule)
}

function applyReplacements(
	source: string,
	replacements: Array<RewriteReplacement>,
) {
	if (replacements.length === 0) return source
	let cursor = 0
	let nextSource = ''
	for (const replacement of replacements) {
		nextSource += source.slice(cursor, replacement.start)
		nextSource += replacement.value
		cursor = replacement.end
	}
	nextSource += source.slice(cursor)
	return nextSource
}

function assertReplacementsDoNotOverlap(
	replacements: Array<RewriteReplacement>,
) {
	for (let index = 1; index < replacements.length; index += 1) {
		const previous = replacements[index - 1]
		const current = replacements[index]
		if (!previous || !current || current.start >= previous.end) continue
		throw new Error(
			'Nested dynamic import expressions involving Kody package imports are unsupported. Keep import("kody:@scope/package/export") as its own expression.',
		)
	}
}

/**
 * Resolve a saved-package import into `state.packages` without rewriting its
 * published source snapshot into the bundler VFS. Callers that need a live
 * rebuild must {@link materializePackageSourceIntoFiles} after an artifact miss.
 */
/**
 * Load every published importable artifact a module's static `kody:@` imports
 * may compose in one batched identity SELECT instead of one per import
 * (issue #4290). Best effort: anything that fails here falls back to the
 * per-import path, which raises the real error.
 */
async function prefetchPublishedArtifactTargets(
	state: RewriteState,
	specifiers: ReadonlyArray<string>,
) {
	const identities: Array<{
		sourceId: string
		kind: 'importable-module'
		artifactName: string
		entryPoint: string
	}> = []
	for (const specifier of new Set(specifiers)) {
		if (state.proxies.has(specifier)) continue
		try {
			const parsed = parseKodyPackageSpecifier(specifier)
			if (parsed.packageName === state.rootPackage?.manifest.name) continue
			assertNotSealedSecretProviderExport(parsed.exportName)
			const loaded = await ensurePackageResolved(state, specifier)
			if (!loaded.source.published_commit) continue
			const exportName = normalizePackageExportKey(parsed.exportName)
			const identity = {
				sourceId: loaded.row.sourceId,
				kind: 'importable-module' as const,
				artifactName: exportName,
				entryPoint: resolvePackageExportPath({
					manifest: loaded.manifest,
					exportName,
				}),
			}
			if (
				!state.prefetchedPublishedArtifacts.has(
					publishedBundleLoadIdentityKey(identity),
				)
			) {
				identities.push(identity)
			}
		} catch {
			continue
		}
	}
	if (identities.length < 2) return
	try {
		const loaded = await loadPublishedBundleArtifactsByIdentities({
			env: state.env,
			userId: state.userId,
			identities,
		})
		for (const [key, artifact] of loaded) {
			state.prefetchedPublishedArtifacts.set(key, artifact)
		}
	} catch {
		// The per-import fallback repeats these reads and surfaces any failure.
	}
}

async function ensurePackageResolved(
	state: RewriteState,
	specifier: string,
): Promise<LoadedKodyGraphPackage> {
	const parsed = parseKodyPackageSpecifier(specifier)
	const packageKey = parsed.packageName
	const existing = state.packages.get(packageKey)
	if (existing) return existing
	const resolution = await resolveSavedPackageImport({
		db: state.env.APP_DB,
		userId: state.userId,
		specifier: parsed,
	})
	if (!resolution) {
		throw new SavedPackageNotFoundError(parsed.packageName)
	}
	const { row } = resolution
	const loaded = await loadPackageSourceBySourceId({
		env: state.env,
		baseUrl: state.baseUrl,
		userId: state.userId,
		sourceId: row.sourceId,
	})
	const entry: LoadedKodyGraphPackage = {
		...loaded,
		row,
		prefix: joinPath(packageSourcePrefix, packageKey),
		sourceMaterialized: false,
	}
	state.packages.set(packageKey, entry)
	return entry
}

async function materializePackageSourceIntoFiles(
	state: RewriteState,
	loaded: LoadedKodyGraphPackage,
) {
	if (loaded.sourceMaterialized === true) return
	for (const [filePath, content] of Object.entries(loaded.files)) {
		const normalizedPath = normalizePackageWorkspacePath(filePath)
		assertNoKodyVirtualModuleReference(normalizedPath, content)
		const targetPath = joinPath(loaded.prefix, normalizedPath)
		if (isTypeDeclarationFilePath(normalizedPath)) {
			state.files[targetPath] = content
			continue
		}
		state.files[targetPath] = await rewriteKodyImports({
			state,
			source: content,
			modulePath: targetPath,
			sourcePackageId: loaded.row.id,
		})
	}
	loaded.sourceMaterialized = true
}

async function ensurePackageProxy(
	state: RewriteState,
	specifier: string,
): Promise<string> {
	const existing = state.proxies.get(specifier)
	if (existing) return existing
	const parsed = parseKodyPackageSpecifier(specifier)
	assertNotSealedSecretProviderExport(parsed.exportName)
	// Callee saved-package UUID stamped into the metered proxy below. Root
	// self-imports resolve back into the bundle's own source and are not
	// stamped: the surrounding run already meters that package via
	// `package_export`.
	let calleePackageId: string | null = null
	const absoluteExportPath =
		parsed.packageName === state.rootPackage?.manifest.name
			? joinPath(
					state.rootPackage.prefix,
					resolvePackageExportSourcePath({
						files: state.sourceFiles,
						manifest: state.rootPackage.manifest,
						exportName: parsed.exportName,
					}),
				)
			: await (async () => {
					// Prefer a published importable artifact before rewriting the
					// full package source (including node_modules) into the
					// bundler VFS. Multiple heavy exports from one package
					// otherwise stack unused source graphs beside each artifact.
					const loaded = await ensurePackageResolved(state, specifier)
					calleePackageId = loaded.row.id
					const publishedTarget = await maybeEnsurePublishedArtifactTarget({
						state,
						specifier,
						loaded,
					})
					if (publishedTarget) return publishedTarget
					await materializePackageSourceIntoFiles(state, loaded)
					assertPublishedSourceCanRebuildWithoutInstallingDeps({
						sourceFiles: loaded.files,
						bundleLabel: `Saved package export "${normalizePackageExportKey(
							parsed.exportName,
						)}"`,
					})
					const exportPath = resolvePackageExportSourcePath({
						files: loaded.files,
						manifest: loaded.manifest,
						exportName: parsed.exportName,
					})
					return joinPath(loaded.prefix, exportPath)
				})()
	const proxyPath = joinPath(
		packageImportProxyPrefix,
		`${createPackageProxyPathSegment(specifier)}.js`,
	)
	const proxyTarget = createRelativeImportSpecifier(
		proxyPath,
		absoluteExportPath,
	)
	state.files[proxyPath] = calleePackageId
		? createMeteredPackageImportProxySource({
				targetPath: proxyTarget,
				runtimeSpecifier: createRelativeImportSpecifier(
					proxyPath,
					runtimeModulePath,
				),
				packageId: calleePackageId,
				exportNames: collectModuleExportNames({
					files: state.files,
					modulePath: absoluteExportPath,
				}),
			})
		: createPackageImportProxySource({
				targetPath: proxyTarget,
			})
	state.proxies.set(specifier, proxyPath)
	return proxyPath
}

export function collectDynamicPackageImportProxyModules(
	files: Record<string, string>,
	emittedModules: WorkerLoaderModules,
) {
	const referencedProxyPaths =
		collectReferencedDynamicPackageImportProxyPaths(emittedModules)
	return Object.fromEntries(
		Object.entries(files).filter(([modulePath]) => {
			const normalizedPath = normalizeWorkspaceModulePath(modulePath)
			return (
				isDynamicPackageImportProxyPath(normalizedPath) &&
				referencedProxyPaths.has(normalizedPath)
			)
		}),
	)
}

function isDynamicPackageImportProxyPath(modulePath: string) {
	return (
		modulePath.startsWith(`${dynamicPackageImportProxyPrefix}/`) ||
		modulePath.includes(`/${dynamicPackageImportProxyPrefix}/`)
	)
}

function collectReferencedDynamicPackageImportProxyPaths(
	modules: WorkerLoaderModules,
) {
	const referencedPaths = new Set<string>()
	const proxyReferencePattern =
		/["']((?:\.\.?\/)?[^"']*\.?__kody_virtual__\/dynamic-imports\/[^"']+?\.js)["']/g
	for (const [modulePath, module] of iterateModuleSourceTexts(modules)) {
		if (
			isDynamicPackageImportProxyPath(normalizeWorkspaceModulePath(modulePath))
		) {
			referencedPaths.add(normalizeWorkspaceModulePath(modulePath))
		}
		for (const match of module.matchAll(proxyReferencePattern)) {
			const specifier = match[1]
			if (!specifier) continue
			const resolvedPath = resolveRelativeModulePath(modulePath, specifier)
			referencedPaths.add(
				resolvedPath ?? normalizeWorkspaceModulePath(specifier),
			)
		}
	}
	return referencedPaths
}

function createUniqueHelperName(source: string, baseName: string) {
	let candidate = baseName
	let suffix = 0
	while (source.includes(candidate)) {
		suffix += 1
		candidate = `${baseName}${suffix}`
	}
	return candidate
}

function ensurePackageRuntimeModule(state: RewriteState, packageId: string) {
	const modulePath = buildPackageRuntimeModulePath(packageId)
	state.files[modulePath] ??= createPackageRuntimeModuleSource(packageId)
	return modulePath
}

function ensurePublicRuntimeModule(state: RewriteState) {
	state.files[publicRuntimeModulePath] ??= createPublicRuntimeModuleSource()
	return publicRuntimeModulePath
}

const bundlerScriptSourcePathPattern = /\.(?:[cm]?[jt]sx?)$/i
const bundlerConfigSourcePathPattern = /\.(?:jsonc?|toml)$/i

function jsonValueTargetsKodyVirtualModule(value: unknown): boolean {
	if (typeof value === 'string') {
		return !/\s/.test(value) && specifierTargetsKodyVirtualModule(value)
	}
	if (Array.isArray(value)) {
		return value.some(jsonValueTargetsKodyVirtualModule)
	}
	if (value != null && typeof value === 'object') {
		return Object.values(value).some(jsonValueTargetsKodyVirtualModule)
	}
	return false
}

/**
 * Whether a package-authored file can make the bundler resolve a module in
 * the virtual directory. Scripts are judged by the specifiers the bundler
 * resolves (`import`, `export … from`, literal `import()` / `require()`), so
 * a comment or string that only names the directory (for example an esbuild
 * `// virtual:` marker in committed bundle output) still builds. JSON is
 * judged by whitespace-free string values (`main`, `exports`, `alias`, …),
 * so prose does not match. Files that mention the directory but cannot be
 * inspected precisely (unparseable scripts, JSONC with comments, TOML) fail
 * closed.
 */
function fileReachesKodyVirtualModule(filePath: string, content: string) {
	if (!textMentionsKodyVirtualModule(content)) return false
	if (bundlerScriptSourcePathPattern.test(filePath)) {
		const specifiers = collectBundlerResolvedSpecifiers(content)
		return (
			specifiers == null || specifiers.some(specifierTargetsKodyVirtualModule)
		)
	}
	if (/\.jsonc?$/i.test(filePath)) {
		try {
			return jsonValueTargetsKodyVirtualModule(JSON.parse(content))
		} catch {
			return true
		}
	}
	return bundlerConfigSourcePathPattern.test(filePath)
}

/**
 * Covers every package-authored file handed to the bundler, including
 * `node_modules/` and config copied without import rewriting (package.json
 * `exports` / `imports` / `main` and wrangler `main` / `alias` could
 * otherwise point there).
 */
function assertNoKodyVirtualModuleReference(filePath: string, content: string) {
	if (isTypeDeclarationFilePath(filePath)) return
	if (!fileReachesKodyVirtualModule(filePath, content)) return
	const label = bundlerScriptSourcePathPattern.test(filePath)
		? `Package source "${filePath}"`
		: `Package config "${filePath}"`
	throw new Error(buildInternalKodyVirtualImportMessage(label))
}

async function rewriteKodyImports(input: {
	state: RewriteState
	source: string
	modulePath: string
	/**
	 * Saved-package UUID the module's source belongs to, or null for
	 * unprovenanced source (ad hoc execute entry code). Stamped modules get
	 * their `kody:runtime` import rewritten to a per-package virtual runtime
	 * module so `packageStorage()` resolves to the declaring package.
	 */
	sourcePackageId: string | null
}) {
	// Stamped package modules get a lexical, module-bound `fetch` so outbound
	// calls carry their own identity (GHSA-5fv3). Callbacks/getters from other
	// modules keep their own binding.
	let boundFetchPrefix = ''
	if (input.sourcePackageId && /\bfetch\b/.test(input.source)) {
		const collisions = collectTopLevelFetchCollisionNames(input.source)
		if (collisions && !collisions.has('fetch')) {
			const facadePath = ensurePackageRuntimeModule(
				input.state,
				input.sourcePackageId,
			)
			boundFetchPrefix = `import { __kodyBoundFetch as fetch } from ${JSON.stringify(
				createRelativeImportSpecifier(input.modulePath, facadePath),
			)};\n`
		}
	}
	const {
		literalImports: importNodes,
		dynamicImportExpressions: dynamicImportNodes,
	} = collectModuleImportNodesCached(input.state.importNodesCache, input.source)
	if (importNodes.length === 0 && dynamicImportNodes.length === 0) {
		return boundFetchPrefix + input.source
	}
	await prefetchPublishedArtifactTargets(
		input.state,
		importNodes
			.filter(
				(node) =>
					node.kind !== 'dynamic' &&
					node.specifier.startsWith(packageSpecifierPrefix),
			)
			.map((node) => node.specifier),
	)
	const replacements: Array<RewriteReplacement> = []
	for (const node of importNodes) {
		if (node.specifier === 'kody:runtime') {
			const runtimeTargetPath = input.sourcePackageId
				? ensurePackageRuntimeModule(input.state, input.sourcePackageId)
				: ensurePublicRuntimeModule(input.state)
			replacements.push({
				start: node.start,
				end: node.end,
				value: JSON.stringify(
					createRelativeImportSpecifier(input.modulePath, runtimeTargetPath),
				),
			})
			continue
		}
		if (!node.specifier.startsWith(packageSpecifierPrefix)) {
			continue
		}
		if (node.kind === 'dynamic') {
			continue
		}
		const proxyPath = await ensurePackageProxy(input.state, node.specifier)
		replacements.push({
			start: node.start,
			end: node.end,
			value: JSON.stringify(
				createRelativeImportSpecifier(input.modulePath, proxyPath),
			),
		})
	}
	let computedImportHelperName: string | null = null
	let removedDynamicImportHelperName: string | null = null
	for (const node of dynamicImportNodes) {
		if (node.literalSpecifier?.startsWith(packageSpecifierPrefix)) {
			// Permanent guard: the call site becomes a teaching error naming the
			// replacement, matching the publish-time rejection.
			removedDynamicImportHelperName ??= createUniqueHelperName(
				input.source,
				'__kodyRemovedDynamicKodyImport',
			)
			replacements.push({
				start: node.start,
				end: node.end,
				value: `${removedDynamicImportHelperName}(${JSON.stringify(
					node.literalSpecifier,
				)})`,
			})
			continue
		}
		if (node.literalSpecifier != null) continue
		computedImportHelperName ??= createUniqueHelperName(
			input.source,
			'__kodyDynamicImportGuard',
		)
		replacements.push({
			start: node.start,
			end: node.end,
			value: `${computedImportHelperName}(${input.source.slice(
				node.sourceStart,
				node.sourceEnd,
			)})`,
		})
	}
	const sortedReplacements = replacements.sort(
		(left, right) => left.start - right.start,
	)
	assertReplacementsDoNotOverlap(sortedReplacements)
	const rewritten = applyReplacements(input.source, sortedReplacements)
	const helpers = [
		removedDynamicImportHelperName
			? createRemovedDynamicKodyImportHelperSource({
					helperName: removedDynamicImportHelperName,
				})
			: '',
		computedImportHelperName
			? createComputedDynamicImportGuardSource({
					helperName: computedImportHelperName,
				})
			: '',
	].filter(Boolean)
	return (
		boundFetchPrefix +
		(helpers.length > 0 ? `${helpers.join('\n')}\n${rewritten}` : rewritten)
	)
}

export type PreparedKodyGraph = {
	files: Record<string, string>
	packages: LoadedKodyGraphPackages
	publishedArtifactDependencies: Array<BundleArtifactDependency>
	entryPoint: string
}

/**
 * Request-scoped prepare cache keyed by entry + root package. Callers that build both module and importable-module bootstraps for
 * the same export must share one Map so prepare runs once per graph.
 */
export type PreparedKodyGraphCache = Map<string, Promise<PreparedKodyGraph>>

function preparedKodyGraphCacheKey(input: {
	entryPoint: string
	rootPackageId: string | null
}) {
	return JSON.stringify([
		normalizePackageWorkspacePath(input.entryPoint),
		input.rootPackageId,
	])
}

export async function prepareKodyGraphFiles(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	rootPackageId?: string | null
}): Promise<PreparedKodyGraph> {
	const files: Record<string, string> = {
		[runtimeModulePath]: createRuntimeModuleSource(),
	}
	const rootPackage = readRootPackage(input.sourceFiles)
	const entryPoint =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint)
	const importNodesCache: ModuleImportNodesCache = new Map()
	const reachableRootFiles = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint,
		rootPackage,
		importNodesCache,
	})
	const state: RewriteState = {
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		files,
		sourceFiles: input.sourceFiles,
		rootPackage,
		rootPackageId: input.rootPackageId?.trim() || null,
		proxies: new Map(),
		dynamicPackageImports: new Map(),
		packages: new Map(),
		publishedArtifactDependencies: [],
		importNodesCache,
		prefetchedPublishedArtifacts: new Map(),
	}
	for (const [filePath, content] of Object.entries(input.sourceFiles)) {
		const normalizedSourcePath = normalizePackageWorkspacePath(filePath)
		if (
			isBundlerRootConfigPath(normalizedSourcePath) ||
			isBundlerRootDependencyPath(normalizedSourcePath) ||
			reachableRootFiles.has(normalizedSourcePath)
		) {
			assertNoKodyVirtualModuleReference(normalizedSourcePath, content)
		}
		if (isBundlerRootConfigPath(normalizedSourcePath)) {
			files[normalizedSourcePath] = content
		}
		if (isBundlerRootDependencyPath(normalizedSourcePath)) {
			// Same rewrite dependency packages get after an artifact miss in
			// materializePackageSourceIntoFiles, so computed import() in
			// installed dependency code hits the guard.
			files[normalizedSourcePath] =
				bundlerScriptSourcePathPattern.test(normalizedSourcePath) &&
				!isTypeDeclarationFilePath(normalizedSourcePath)
					? await rewriteKodyImports({
							state,
							source: content,
							modulePath: normalizedSourcePath,
							sourcePackageId: state.rootPackageId,
						})
					: content
			continue
		}
		const normalizedPath = joinPath(rootSourcePrefix, normalizedSourcePath)
		if (normalizedSourcePath === packageManifestPath) {
			files[normalizedPath] = content
			continue
		}
		if (!reachableRootFiles.has(normalizedSourcePath)) {
			continue
		}
		if (isTypeDeclarationFilePath(normalizedSourcePath)) {
			files[normalizedPath] = content
			continue
		}
		files[normalizedPath] = await rewriteKodyImports({
			state,
			source: content,
			modulePath: normalizedPath,
			sourcePackageId: state.rootPackageId,
		})
	}
	return {
		files: refreshKodyRuntimeModules(files) as Record<string, string>,
		packages: state.packages,
		publishedArtifactDependencies: state.publishedArtifactDependencies,
		entryPoint,
	}
}

/**
 * Prepare once per export graph within a request. Concurrent module +
 * importable-module builders for the same entry share the pending promise.
 * Failures are not cached so a retry can rebuild.
 */
export async function getOrPrepareKodyGraphFiles(
	input: Parameters<typeof prepareKodyGraphFiles>[0] & {
		prepareCache?: PreparedKodyGraphCache
	},
): Promise<PreparedKodyGraph> {
	const rootPackageId = input.rootPackageId?.trim() || null
	const cache = input.prepareCache
	if (!cache) {
		return await prepareKodyGraphFiles(input)
	}
	const key = preparedKodyGraphCacheKey({
		entryPoint: input.entryPoint,
		rootPackageId,
	})
	const existing = cache.get(key)
	if (existing) return await existing
	const pending = prepareKodyGraphFiles(input)
	cache.set(key, pending)
	try {
		return await pending
	} catch (error) {
		cache.delete(key)
		throw error
	}
}

/**
 * Fold published-artifact dependency metadata into the consumer's dependency
 * list. Nested packages that never received a live rewrite pass still need
 * packageStorage grants; mark them transitive when they are not already
 * direct imports of the consumer entry.
 */
export function mergePublishedArtifactDependencies(input: {
	dependencies: Array<BundleArtifactDependency>
	publishedArtifactDependencies: Array<BundleArtifactDependency>
}): Array<BundleArtifactDependency> {
	if (input.publishedArtifactDependencies.length === 0) {
		return input.dependencies
	}
	const byPackageId = new Map<string, BundleArtifactDependency>()
	for (const dependency of input.dependencies) {
		if (!dependency.packageId) continue
		byPackageId.set(dependency.packageId, dependency)
	}
	for (const dependency of input.publishedArtifactDependencies) {
		if (!dependency.packageId || byPackageId.has(dependency.packageId)) {
			continue
		}
		byPackageId.set(dependency.packageId, {
			...dependency,
			transitive: true,
		})
	}
	return [...byPackageId.values()].sort(
		(left, right) =>
			left.kodyId.localeCompare(right.kodyId) ||
			left.sourceId.localeCompare(right.sourceId),
	)
}

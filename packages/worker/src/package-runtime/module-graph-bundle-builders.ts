import { executeModuleTarget } from '@kody-internal/shared/execute-module.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { normalizePackageWorkspacePath } from '#worker/package-registry/manifest.ts'
import {
	createPublishedPackageCacheKey,
	createPublishedPackagePromiseCache,
} from '#worker/package-registry/published-package-cache.ts'
import { servingArtifactCommitForSource } from '#worker/repo/serving-commit.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { importWorkerBundler } from '#worker/worker-bundler-modules.ts'
import type { RuntimeBundle } from './runtime-bundle-types.ts'
import {
	createRelativeImportSpecifier,
	joinPath,
	linkedPackageImportPrefix,
	normalizeWorkspaceModulePath,
	resolveRelativeModulePath,
	rootSourcePrefix,
} from './module-graph-paths.ts'
import {
	assertBundleHasNoUnresolvedBareImports,
	includeDynamicDependenciesWhenPresent,
} from './module-graph-artifacts.ts'
import {
	collectDynamicPackageImportProxyModules,
	getOrPrepareKodyGraphFiles,
	mergePublishedArtifactDependencies,
	type PreparedKodyGraph,
	type PreparedKodyGraphCache,
} from './module-graph-import-rewriting.ts'
import { moduleSourceDeclaresDefaultExport } from './module-export-names.ts'
import { resolveKodyDependenciesForEntryPoint } from './module-graph-workspace.ts'
import {
	assertNoPlatformSuppliedNodeModules,
	createNodeModulesResolutionPlugin,
} from './package-bundle-node-modules.ts'
import { createPackageAppJsxBundleOptions } from './package-app-tsconfig.ts'
import { createUnsupportedImportsPlugin } from './package-bundle-unsupported-imports.ts'
import {
	createAppEntrypointSource,
	createExecuteEntrypointSource,
	createImportableEntrypointSource,
	isKodyRuntimeModulePath,
	stripKodyRuntimeModules,
} from './runtime-source-modules.ts'

const packageAppBundleCache =
	createPublishedPackagePromiseCache<RuntimeBundle>()
const moduleBundleCache = createPublishedPackagePromiseCache<RuntimeBundle>()

type EsbuildRuntimeResolveArgs = {
	path: string
	resolveDir: string
	kind: string
}

type EsbuildRuntimePluginBuild = {
	onResolve(
		options: { filter: RegExp },
		callback: (
			args: EsbuildRuntimeResolveArgs,
		) => { path: string; external: true } | undefined,
	): void
}

/**
 * Keep the shared `.__kody_virtual__/runtime.js` module out of the esbuild
 * graph. Inlining it duplicates the stamp AsyncLocalStorage: metering writes
 * one store while the sealed Symbol.for getter (and host fetch capture) read
 * another. Package/public runtime facades stay inlined — they are thin
 * binders that import the shared runtime. Strip + hydrate already install one
 * shared runtime module; externalizing makes that the only ALS owner.
 */
export function createKodyRuntimeExternalsPlugin() {
	return {
		name: 'kody-runtime-externals',
		setup(build: EsbuildRuntimePluginBuild) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === 'entry-point') return
				const resolved = resolveKodyRuntimeExternalPath(
					args.resolveDir ?? '',
					args.path,
				)
				if (resolved == null || !isKodyRuntimeModulePath(resolved)) {
					return
				}
				// Emit a root-relative specifier so Worker Loader resolves the
				// hydrated module key and refresh can see the import.
				return {
					path: resolved.startsWith('./') ? resolved : `./${resolved}`,
					external: true,
				}
			})
		},
	}
}

function resolveKodyRuntimeExternalPath(resolveDir: string, specifier: string) {
	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		const fromPath = resolveDir
			? `${normalizeWorkspaceModulePath(resolveDir)}/__importer__`
			: '__importer__'
		return resolveRelativeModulePath(fromPath, specifier)
	}
	const normalized = normalizeWorkspaceModulePath(
		specifier.startsWith('/') ? specifier.slice(1) : specifier,
	)
	// Specifiers like `./.__kody_virtual__/runtime.js` already match relative.
	return isKodyRuntimeModulePath(normalized) ? normalized : null
}

const kodyRuntimeExternalsPlugin = createKodyRuntimeExternalsPlugin()

/**
 * Publish offload builds leave other Kody packages as imports of
 * `.__kody_linked__/…` placeholders; Kody writes those modules when it
 * commits the upload, so the build never contains another package's code.
 */
const kodyLinkedPackageImportsPlugin = {
	name: 'kody-linked-package-imports',
	setup(build: EsbuildRuntimePluginBuild) {
		build.onResolve({ filter: /__kody_linked__\// }, (args) => {
			if (args.kind === 'entry-point') return
			const resolved = resolveRelativeModulePath(
				args.resolveDir
					? `${normalizeWorkspaceModulePath(args.resolveDir)}/__importer__`
					: '__importer__',
				args.path,
			)
			if (!resolved?.startsWith(`${linkedPackageImportPrefix}/`)) return
			return { path: `./${resolved}`, external: true }
		})
	},
}

/**
 * Keep imports of attached published artifact modules out of the esbuild
 * graph. Those modules are added to the dynamic worker unchanged, so an
 * import of one stays a root-relative import of its module key.
 */
function createAttachedModulesExternalsPlugin(
	attachedModulePaths: ReadonlySet<string>,
) {
	return {
		name: 'kody-attached-published-artifacts',
		setup(build: EsbuildRuntimePluginBuild) {
			build.onResolve({ filter: /__published_bundle__\// }, (args) => {
				if (args.kind === 'entry-point') return
				const resolved = resolveRelativeModulePath(
					args.resolveDir
						? `${normalizeWorkspaceModulePath(args.resolveDir)}/__importer__`
						: '__importer__',
					args.path,
				)
				if (resolved == null || !attachedModulePaths.has(resolved)) return
				return { path: `./${resolved}`, external: true }
			})
		},
	}
}

/**
 * Split a prepared graph into the files esbuild bundles and the published
 * artifact modules attached to the dynamic worker as they are. Runtime
 * modules inside an artifact are dropped; hydration installs the one shared
 * runtime.
 */
function splitAttachedPublishedArtifactModules(
	files: Record<string, string>,
	moduleRoles: PreparedKodyGraph['moduleRoles'],
) {
	const bundlerFiles: Record<string, string> = {}
	const attachedModules: Record<string, string> = {}
	for (const [modulePath, source] of Object.entries(files)) {
		if (moduleRoles.get(modulePath) !== 'published-artifact') {
			bundlerFiles[modulePath] = source
			continue
		}
		const normalized = normalizeWorkspaceModulePath(modulePath)
		if (isKodyRuntimeModulePath(normalized)) continue
		attachedModules[normalized] = source
	}
	return { bundlerFiles, attachedModules }
}

async function createWorkerBundle(input: {
	files: Record<string, string>
	entryPoint: string
	sourceFiles?: Record<string, string>
	linkKodyPackageImports?: boolean
	attachedModulePaths?: ReadonlySet<string>
}) {
	const snapshotFiles = input.sourceFiles ?? input.files
	assertNoPlatformSuppliedNodeModules({
		snapshotFiles,
		bundlerFiles: input.files,
		bundleLabel: 'Package bundle',
	})
	// Keep the experimental bundler out of the Worker's top-level deploy graph.
	const { createWorker } = await importWorkerBundler()
	return await createWorker({
		files: input.files,
		entryPoint: input.entryPoint,
		target: executeModuleTarget,
		...createPackageAppJsxBundleOptions(snapshotFiles),
		__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
			createUnsupportedImportsPlugin({ files: input.files, side: 'worker' }),
			kodyRuntimeExternalsPlugin,
			...(input.linkKodyPackageImports ? [kodyLinkedPackageImportsPlugin] : []),
			...(input.attachedModulePaths?.size
				? [createAttachedModulesExternalsPlugin(input.attachedModulePaths)]
				: []),
			createNodeModulesResolutionPlugin(input.files),
		],
	})
}

function serializePreparedFilesRecord(files: Record<string, string>) {
	const sortedKeys = Object.keys(files).sort()
	const record: Record<string, string> = {}
	for (const key of sortedKeys) {
		const content = files[key]
		if (content === undefined) continue
		record[key] = content
	}
	return JSON.stringify(record)
}

async function createModuleBundleCacheKey(input: {
	userId: string
	entryPoint: string
	files: Record<string, string>
	packages: PreparedKodyGraph['packages']
	publishedArtifactVersions: PreparedKodyGraph['publishedArtifactVersions']
}) {
	// Digest the bundled prepared files (not raw source) so rewritten graph
	// contents invalidate the cache. Attached artifacts are not digested: each
	// loaded package's serving and published commits name the artifact loaded.
	const filesDigest = await sha256Base64Url(
		serializePreparedFilesRecord(input.files),
	)
	const packageCommits = [...input.packages.values()]
		.map((loaded) => [
			loaded.row.sourceId,
			servingArtifactCommitForSource(loaded.source),
			// Without a serving pointer readers load the newest build, so the
			// published commit is what changes on a republish.
			loaded.source.published_commit,
		])
		.sort(([left], [right]) => String(left).localeCompare(String(right)))
	return JSON.stringify([
		'module-bundle',
		input.userId,
		input.entryPoint,
		filesDigest,
		packageCommits,
		[...input.publishedArtifactVersions].sort(),
	])
}

function cloneRuntimeBundle(bundle: RuntimeBundle): RuntimeBundle {
	return {
		mainModule: bundle.mainModule,
		modules: { ...bundle.modules },
		dependencies: [...bundle.dependencies],
		...(bundle.dynamicDependencies
			? { dynamicDependencies: [...bundle.dynamicDependencies] }
			: {}),
	}
}

function clonePreparedGraphFiles(files: Record<string, string>) {
	return { ...files }
}

export async function buildKodyModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	// Saved-package UUID when the root source is a saved package's own module;
	// stamps root modules with package provenance (see RewriteState).
	rootPackageId?: string | null
	// Opt-in: cache createWorkerBundle by prepared-files digest (see createModuleBundleCacheKey).
	reuseCachedBundle?: boolean
	bundleContext?: 'ad-hoc-execute' | 'saved-package-module'
	/**
	 * Request-scoped prepare cache so module + importable-module targets for
	 * the same entry share one prepareKodyGraphFiles pass.
	 */
	prepareCache?: PreparedKodyGraphCache
	/**
	 * Publish offload builds: other Kody packages stay linked imports and
	 * `dependencies` is empty; Kody resolves both when it commits the upload.
	 */
	linkKodyPackageImports?: boolean
	/**
	 * Ad hoc execute: add each imported published artifact to the bundle as
	 * its own modules, unchanged, and bundle only the rest of the graph.
	 */
	attachPublishedArtifacts?: boolean
}) {
	const prepared = await getOrPrepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		rootPackageId: input.rootPackageId,
		prepareCache: input.prepareCache,
		linkKodyPackageImports: input.linkKodyPackageImports,
	})
	// JSON, CommonJS, and text modules keep their types only through esbuild.
	const { bundlerFiles: files, attachedModules } =
		input.attachPublishedArtifacts && !prepared.hasTypedPublishedArtifactModules
			? splitAttachedPublishedArtifactModules(
					prepared.files,
					prepared.moduleRoles,
				)
			: {
					bundlerFiles: clonePreparedGraphFiles(prepared.files),
					attachedModules: {},
				}
	const attachedModulePaths = new Set(Object.keys(attachedModules))
	const { packages, publishedArtifactDependencies } = prepared
	const entryPoint = prepared.entryPoint
	const normalizedEntrypoint = joinPath(rootSourcePrefix, entryPoint)
	const bootstrapPath = joinPath(rootSourcePrefix, '.__kody_execute_entry__.js')
	const entrySource = input.sourceFiles[entryPoint]
	files[bootstrapPath] = createExecuteEntrypointSource({
		modulePath: createRelativeImportSpecifier(
			bootstrapPath,
			normalizedEntrypoint,
		),
		entryPoint,
		hasDefaultExport:
			typeof entrySource !== 'string' ||
			(await moduleSourceDeclaresDefaultExport(entrySource)) !== false,
	})
	const assembleBundle = async (): Promise<RuntimeBundle> => {
		const bundle = await createWorkerBundle({
			files,
			entryPoint: bootstrapPath,
			sourceFiles: input.sourceFiles,
			linkKodyPackageImports: input.linkKodyPackageImports,
			attachedModulePaths,
		})
		const emittedModules: WorkerLoaderModules = {
			...(bundle.modules as WorkerLoaderModules),
			...attachedModules,
		}
		const modules = {
			...stripKodyRuntimeModules(emittedModules),
			...collectDynamicPackageImportProxyModules(files, emittedModules),
		}
		// Attached artifacts were checked when they were published, and
		// parsing them again would cost far more memory than bundling.
		await assertBundleHasNoUnresolvedBareImports({
			modules: Object.fromEntries(
				Object.entries(modules).filter(
					([modulePath]) => !attachedModulePaths.has(modulePath),
				),
			),
			bundleLabel:
				input.bundleContext === 'ad-hoc-execute'
					? 'Ad hoc execute module bundle'
					: `Saved package module "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
			sourceFiles: input.sourceFiles,
			...(input.bundleContext === 'ad-hoc-execute'
				? {
						resolutionHint:
							'Use a registry package that can be bundled for the Cloudflare Workers runtime, or remove the import.',
					}
				: {}),
		})
		const dependencies = input.linkKodyPackageImports
			? []
			: mergePublishedArtifactDependencies({
					dependencies: await resolveKodyDependenciesForEntryPoint({
						...input,
						loadedPackages: packages,
					}),
					publishedArtifactDependencies,
				})
		return {
			mainModule: bundle.mainModule,
			modules,
			dependencies,
			...includeDynamicDependenciesWhenPresent(modules),
		}
	}

	if (!input.reuseCachedBundle) {
		return await assembleBundle()
	}

	const cacheKey = await createModuleBundleCacheKey({
		userId: input.userId,
		entryPoint,
		files,
		packages,
		publishedArtifactVersions: prepared.publishedArtifactVersions,
	})
	let built = false
	const cached = await moduleBundleCache.getOrCreate({
		cacheKey,
		create: async () => {
			built = true
			return await assembleBundle()
		},
	})
	console.info(
		JSON.stringify({
			event: 'module_bundle_cache',
			outcome: built ? 'miss' : 'hit',
			bundleContext: input.bundleContext ?? null,
			moduleCount: Object.keys(cached.modules).length,
			attachedModuleCount: attachedModulePaths.size,
		}),
	)
	return cloneRuntimeBundle(cached)
}

export async function buildKodyImportableModuleBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	// Saved-package UUID when the root source is a saved package's own module;
	// stamps root modules with package provenance (see RewriteState).
	rootPackageId?: string | null
	/**
	 * Request-scoped prepare cache so module + importable-module targets for
	 * the same entry share one prepareKodyGraphFiles pass.
	 */
	prepareCache?: PreparedKodyGraphCache
	/**
	 * Publish offload builds: other Kody packages stay linked imports and
	 * `dependencies` is empty; Kody resolves both when it commits the upload.
	 */
	linkKodyPackageImports?: boolean
}) {
	const prepared = await getOrPrepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		rootPackageId: input.rootPackageId,
		prepareCache: input.prepareCache,
		linkKodyPackageImports: input.linkKodyPackageImports,
	})
	const files = clonePreparedGraphFiles(prepared.files)
	const { packages, publishedArtifactDependencies } = prepared
	const entryPoint = prepared.entryPoint
	const normalizedEntrypoint = joinPath(rootSourcePrefix, entryPoint)
	const bootstrapPath = joinPath(rootSourcePrefix, '.__kody_import_entry__.js')
	files[bootstrapPath] = createImportableEntrypointSource({
		modulePath: createRelativeImportSpecifier(
			bootstrapPath,
			normalizedEntrypoint,
		),
	})
	const bundle = await createWorkerBundle({
		files,
		entryPoint: bootstrapPath,
		sourceFiles: input.sourceFiles,
		linkKodyPackageImports: input.linkKodyPackageImports,
	})
	const modules = {
		...stripKodyRuntimeModules(bundle.modules as WorkerLoaderModules),
		...collectDynamicPackageImportProxyModules(
			files,
			bundle.modules as WorkerLoaderModules,
		),
	}
	await assertBundleHasNoUnresolvedBareImports({
		modules,
		bundleLabel: `Saved package import "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
		sourceFiles: input.sourceFiles,
	})
	return {
		mainModule: bundle.mainModule,
		modules,
		dependencies: input.linkKodyPackageImports
			? []
			: mergePublishedArtifactDependencies({
					dependencies: await resolveKodyDependenciesForEntryPoint({
						...input,
						loadedPackages: packages,
					}),
					publishedArtifactDependencies,
				}),
		...includeDynamicDependenciesWhenPresent(modules),
	}
}

export async function buildKodyAppBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	// Saved-package UUID when the root source is a saved package's own module;
	// stamps root modules with package provenance (see RewriteState).
	rootPackageId?: string | null
	cacheKey?: string | null
	prepareCache?: PreparedKodyGraphCache
	/**
	 * Publish offload builds: other Kody packages stay linked imports and
	 * `dependencies` is empty; Kody resolves both when it commits the upload.
	 */
	linkKodyPackageImports?: boolean
}) {
	const buildBundle = async () => {
		const prepared = await getOrPrepareKodyGraphFiles({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles: input.sourceFiles,
			entryPoint: input.entryPoint,
			rootPackageId: input.rootPackageId,
			prepareCache: input.prepareCache,
			linkKodyPackageImports: input.linkKodyPackageImports,
		})
		const files = clonePreparedGraphFiles(prepared.files)
		const { packages, publishedArtifactDependencies } = prepared
		const entryPoint = prepared.entryPoint
		const normalizedEntrypoint = joinPath(rootSourcePrefix, entryPoint)
		const bootstrapPath = joinPath(rootSourcePrefix, '.__kody_app_entry__.js')
		files[bootstrapPath] = createAppEntrypointSource({
			modulePath: createRelativeImportSpecifier(
				bootstrapPath,
				normalizedEntrypoint,
			),
		})
		const bundle = await createWorkerBundle({
			files,
			entryPoint: bootstrapPath,
			sourceFiles: input.sourceFiles,
			linkKodyPackageImports: input.linkKodyPackageImports,
		})
		const modules = {
			...stripKodyRuntimeModules(bundle.modules as WorkerLoaderModules),
			...collectDynamicPackageImportProxyModules(
				files,
				bundle.modules as WorkerLoaderModules,
			),
		}
		await assertBundleHasNoUnresolvedBareImports({
			modules,
			bundleLabel: `Saved package app "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
			sourceFiles: input.sourceFiles,
		})
		return {
			mainModule: bundle.mainModule,
			modules,
			dependencies: input.linkKodyPackageImports
				? []
				: mergePublishedArtifactDependencies({
						dependencies: await resolveKodyDependenciesForEntryPoint({
							...input,
							loadedPackages: packages,
						}),
						publishedArtifactDependencies,
					}),
			...includeDynamicDependenciesWhenPresent(modules),
		}
	}

	const cacheKey = input.cacheKey?.trim() || null
	if (!cacheKey) {
		return await buildBundle()
	}

	return await packageAppBundleCache.getOrCreate({
		cacheKey,
		create: buildBundle,
	})
}

export function createPublishedPackageAppBundleCacheKey(input: {
	userId: string
	source: {
		id: string
		published_commit: string | null
		manifest_path: string
		source_root: string
	}
	entryPoint: string
}) {
	return createPublishedPackageCacheKey({
		userId: input.userId,
		source: input.source,
		entryPoint: input.entryPoint,
	})
}

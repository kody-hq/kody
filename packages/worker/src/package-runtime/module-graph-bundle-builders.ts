import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { normalizePackageWorkspacePath } from '#worker/package-registry/manifest.ts'
import {
	createPublishedPackageCacheKey,
	createPublishedPackagePromiseCache,
} from '#worker/package-registry/published-package-cache.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { importWorkerBundler } from '#worker/worker-bundler-modules.ts'
import type { RuntimeBundle } from './runtime-bundle-types.ts'
import {
	createRelativeImportSpecifier,
	joinPath,
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
	type PreparedKodyGraphCache,
} from './module-graph-import-rewriting.ts'
import { moduleSourceDeclaresDefaultExport } from './module-export-names.ts'
import { resolveKodyDependenciesForEntryPoint } from './module-graph-workspace.ts'
import { assertNoPlatformSuppliedNodeModules } from './package-bundle-node-modules.ts'
import { createPackageAppJsxBundleOptions } from './package-app-tsconfig.ts'
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

async function createWorkerBundle(input: {
	files: Record<string, string>
	entryPoint: string
	sourceFiles?: Record<string, string>
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
		...createPackageAppJsxBundleOptions(snapshotFiles),
		__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
			kodyRuntimeExternalsPlugin,
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
}) {
	// Digest prepared files (not raw source) so package republishes that change
	// rewritten graph contents invalidate the cache without a staleness window.
	const filesDigest = await sha256Base64Url(
		serializePreparedFilesRecord(input.files),
	)
	return JSON.stringify([
		'module-bundle',
		input.userId,
		input.entryPoint,
		filesDigest,
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
}) {
	const prepared = await getOrPrepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		rootPackageId: input.rootPackageId,
		prepareCache: input.prepareCache,
	})
	const files = clonePreparedGraphFiles(prepared.files)
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
			moduleSourceDeclaresDefaultExport(entrySource) !== false,
	})
	const assembleBundle = async (): Promise<RuntimeBundle> => {
		const bundle = await createWorkerBundle({
			files,
			entryPoint: bootstrapPath,
			sourceFiles: input.sourceFiles,
		})
		const modules = {
			...stripKodyRuntimeModules(bundle.modules as WorkerLoaderModules),
			...collectDynamicPackageImportProxyModules(
				files,
				bundle.modules as WorkerLoaderModules,
			),
		}
		assertBundleHasNoUnresolvedBareImports({
			modules,
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
		const dependencies = mergePublishedArtifactDependencies({
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
	})
	const cached = await moduleBundleCache.getOrCreate({
		cacheKey,
		create: assembleBundle,
	})
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
}) {
	const prepared = await getOrPrepareKodyGraphFiles({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		rootPackageId: input.rootPackageId,
		prepareCache: input.prepareCache,
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
	})
	const modules = {
		...stripKodyRuntimeModules(bundle.modules as WorkerLoaderModules),
		...collectDynamicPackageImportProxyModules(
			files,
			bundle.modules as WorkerLoaderModules,
		),
	}
	assertBundleHasNoUnresolvedBareImports({
		modules,
		bundleLabel: `Saved package import "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
		sourceFiles: input.sourceFiles,
	})
	return {
		mainModule: bundle.mainModule,
		modules,
		dependencies: mergePublishedArtifactDependencies({
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
		})
		const modules = {
			...stripKodyRuntimeModules(bundle.modules as WorkerLoaderModules),
			...collectDynamicPackageImportProxyModules(
				files,
				bundle.modules as WorkerLoaderModules,
			),
		}
		assertBundleHasNoUnresolvedBareImports({
			modules,
			bundleLabel: `Saved package app "${normalizePackageWorkspacePath(input.entryPoint)}" bundle`,
			sourceFiles: input.sourceFiles,
		})
		return {
			mainModule: bundle.mainModule,
			modules,
			dependencies: mergePublishedArtifactDependencies({
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

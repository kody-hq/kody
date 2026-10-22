import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { createRelativeImportSpecifier } from './module-graph-path-basics.ts'
import { listMissingPublishedSourceInstalledDependencies } from './published-source-dependencies.ts'
import { collectTopLevelFetchCollisionNames } from './rewrite-local-execute-secret-fetch.ts'
import {
	buildPackageRuntimeModulePath,
	isKodyPublicRuntimeModulePath,
	isKodyRuntimeModulePath,
	parsePackageRuntimeModulePathPackageId,
} from './runtime-source-modules.ts'

/**
 * Published bundles built before GHSA-5fv3-qv7j-rqf5 shipped have no lexical
 * package `fetch`: a package's free `fetch` used to pick up that package's
 * identity from an ambient scope the metering wrapper entered. The fix made
 * identity lexical (`import { __kodyBoundFetch as fetch }` from the package's
 * own runtime facade, added at build time), so those older bundles now reach
 * the run's fetch and act as the caller.
 *
 * Bundles built with the lexical rewrite carry this marker. Unmarked bundles
 * that still mention `__kodyBoundFetch` were built by the fixed builder
 * before the marker existed.
 */
export const packageBindingRewriteVersion = 1

type RepairableArtifact = {
	modules: WorkerLoaderModules
	dependencies: Array<{ packageId?: string }>
	packageContext: { packageId: string } | null
	packageBindingRewrite?: number
}

const boundFetchExportName = '__kodyBoundFetch'
const freeFetchPattern = /\bfetch\b/

function moduleSource(module: WorkerLoaderModules[string]) {
	if (typeof module === 'string') return module
	if (module && typeof module === 'object' && typeof module.js === 'string') {
		return module.js
	}
	return null
}

function withModuleSource(
	module: WorkerLoaderModules[string],
	source: string,
): WorkerLoaderModules[string] {
	if (typeof module === 'string') return source
	return { ...module, js: source }
}

function isPlatformRuntimeModulePath(modulePath: string) {
	return (
		isKodyRuntimeModulePath(modulePath) ||
		isKodyPublicRuntimeModulePath(modulePath) ||
		parsePackageRuntimeModulePathPackageId(modulePath) != null
	)
}

/** True for a bundle built before package `fetch` became lexical. */
export function isPreBindingPublishedArtifact(artifact: RepairableArtifact) {
	if (artifact.packageBindingRewrite === packageBindingRewriteVersion) {
		return false
	}
	let mentionsFetch = false
	for (const [modulePath, module] of Object.entries(artifact.modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const source = moduleSource(module)
		if (source == null) continue
		if (source.includes(boundFetchExportName)) return false
		if (!mentionsFetch && freeFetchPattern.test(source)) mentionsFetch = true
	}
	return mentionsFetch
}

/**
 * True when the bundle inlines code from another saved package. Its modules
 * mix packages, so one package's `fetch` cannot be bound to the whole bundle;
 * such a bundle has to be rebuilt from source instead.
 */
export function publishedArtifactInlinesOtherPackages(
	artifact: RepairableArtifact,
) {
	const ownPackageId = artifact.packageContext?.packageId ?? null
	return artifact.dependencies.some(
		(dependency) => !dependency.packageId || dependency.packageId !== ownPackageId,
	)
}

/**
 * Bind a pre-fix single-package bundle's free `fetch` to its own package,
 * exactly as the builder now does for package source: every module gets
 * `import { __kodyBoundFetch as fetch }` from the package's runtime facade,
 * so outbound calls act as that package through its host-minted binding.
 * Identity comes from the artifact's stored package context (bundler
 * provenance), never from anything the sandbox supplies. Bundles that are
 * current, have no package context, or inline other packages come back
 * unchanged.
 */
export function repairPreBindingPublishedArtifact<
	Artifact extends RepairableArtifact,
>(artifact: Artifact): Artifact {
	const ownPackageId = artifact.packageContext?.packageId?.trim()
	if (!ownPackageId) return artifact
	if (!isPreBindingPublishedArtifact(artifact)) return artifact
	if (publishedArtifactInlinesOtherPackages(artifact)) return artifact
	const facadePath = buildPackageRuntimeModulePath(ownPackageId)
	let modules: WorkerLoaderModules | null = null
	for (const [modulePath, module] of Object.entries(artifact.modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const source = moduleSource(module)
		if (source == null || !freeFetchPattern.test(source)) continue
		const collisions = collectTopLevelFetchCollisionNames(source)
		if (!collisions || collisions.has('fetch')) continue
		const prefix = `import { ${boundFetchExportName} as fetch } from ${JSON.stringify(
			createRelativeImportSpecifier(modulePath, facadePath),
		)};\n`
		modules ??= { ...artifact.modules }
		modules[modulePath] = withModuleSource(module, prefix + source)
	}
	if (!modules) return artifact
	return { ...artifact, modules }
}

/**
 * True when a load site holding the package's published source should
 * rebuild this bundle instead of serving it: it predates lexical package
 * `fetch`, inlines other packages (so it cannot be repaired in place), and
 * the source can rebuild without installing npm dependencies. Bundles that
 * cannot rebuild keep serving as before.
 */
export function publishedArtifactNeedsPackageBindingRebuild(input: {
	artifact: RepairableArtifact
	sourceFiles: Record<string, string>
}) {
	if (!input.artifact.packageContext?.packageId) return false
	if (!isPreBindingPublishedArtifact(input.artifact)) return false
	if (!publishedArtifactInlinesOtherPackages(input.artifact)) return false
	return (
		listMissingPublishedSourceInstalledDependencies(input.sourceFiles)
			.length === 0
	)
}

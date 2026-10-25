import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { runtimeModulePath } from './module-graph-path-basics.ts'
import { listMissingPublishedSourceInstalledDependencies } from './published-source-dependencies.ts'
import { collectTopLevelFetchCollisionNames } from './rewrite-local-execute-secret-fetch.ts'
import {
	isKodyPublicRuntimeModulePath,
	isKodyRuntimeModulePath,
	parsePackageRuntimeModulePathPackageId,
} from './runtime-source-modules.ts'

/**
 * Published bundles built before GHSA-5fv3-qv7j-rqf5 shipped have no lexical
 * package `fetch`: a package's free `fetch` used to pick up that package's
 * identity from an ambient scope the metering wrapper entered. The fix made
 * identity lexical (each stamped module gets a `fetch` and `kody` bound to
 * its package at build time; the bundler inlines them as
 * `var __kodyBoundFetch = __kodyCreatePackageBoundFetch(<id>)`), so those
 * older bundles now reach the run's fetch and act as the caller.
 *
 * Bundles built with the lexical rewrite carry this marker. Unmarked bundles
 * that already name a bound creator were built by the fixed builder before
 * the marker existed.
 */
export const packageBindingRewriteVersion = 1

type RepairableArtifact = {
	/**
	 * Bundle artifact kind (`BundleArtifactKind`). Only kinds loaded into a
	 * Worker isolate can be repaired; see {@link isRepairableArtifactKind}.
	 * Absent means an isolate-loaded bundle.
	 */
	kind?: string
	modules: WorkerLoaderModules
	dependencies: Array<{ packageId?: string }>
	packageContext: { packageId: string } | null
	packageBindingRewrite?: number
	sourceId?: string
}

/**
 * A module the repair cannot bind keeps its pre-fix `fetch`. Report it so the
 * gap is visible instead of silent. The repair runs on every read (it is not
 * persisted), so the warning repeats until the package is republished.
 */
function warnUnrepairedModule(input: {
	artifact: RepairableArtifact
	modulePath: string
	reason: 'parse-failed' | 'creator-name-collision'
}) {
	console.warn(
		JSON.stringify({
			event: 'pre_binding_module_unrepaired',
			sourceId: input.artifact.sourceId ?? null,
			modulePath: input.modulePath,
			reason: input.reason,
		}),
	)
}

const lexicalBindingNames = [
	'__kodyCreatePackageBoundFetch',
	'__kodyCreatePackageBoundKody',
	'__kodyBoundFetch',
]
const repairFetchCreatorName = '__kodyPreBindingBoundFetch'
const repairKodyCreatorName = '__kodyPreBindingBoundKody'
const freeFetchPattern = /\bfetch\b/
// A bundled `import { ..., kody, ... } from "<...>/.__kody_virtual__/runtime.js"`.
const sharedRuntimeImportPattern =
	/^import\s*\{([^}]*)\}\s*from\s*("[^"\n]*\.__kody_virtual__\/runtime\.js");?[ \t]*$/gm

function parseImportedNames(list: string) {
	return list
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
				entry,
			)
			return match
				? { entry, imported: match[1]!, local: match[2] ?? match[1]! }
				: { entry, imported: null, local: null }
		})
}

/**
 * Drop `kody` from the module's shared-runtime imports and report the local
 * names it was bound to, so the repair can rebind them to the package.
 */
function stripSharedKodyImports(source: string) {
	const kodyLocalNames: Array<string> = []
	const nextSource = source.replace(
		sharedRuntimeImportPattern,
		(statement, list: string, specifier: string) => {
			const names = parseImportedNames(list)
			if (names.some((name) => name.imported == null)) return statement
			const kept = names.filter((name) => {
				if (name.imported !== 'kody') return true
				kodyLocalNames.push(name.local!)
				return false
			})
			if (kept.length === names.length) return statement
			if (kept.length === 0) return ''
			return `import { ${kept.map((name) => name.entry).join(', ')} } from ${specifier};`
		},
	)
	return { source: nextSource, kodyLocalNames }
}

function importsSharedKody(source: string) {
	return stripSharedKodyImports(source).kodyLocalNames.length > 0
}

/**
 * Specifier from a bundle module to the artifact's shared runtime module.
 * Bundle module paths are relative to the artifact root.
 */
function runtimeSpecifierFrom(modulePath: string) {
	const depth = modulePath.split('/').filter(Boolean).length - 1
	return `${depth > 0 ? '../'.repeat(depth) : './'}${runtimeModulePath}`
}

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

/**
 * Artifact kinds that never load into a Worker isolate. `app-client` is the
 * browser ESM a package app serves as a static module: its free `fetch` is
 * the browser's own, it has no package identity to restore, and the shared
 * runtime module the repair imports does not exist in the browser (the
 * import 404s and the module never runs). These bundles are served exactly
 * as built.
 */
const browserArtifactKinds = new Set(['app-client'])

/**
 * True when the artifact kind loads into a Worker isolate, where the shared
 * runtime module resolves and the pre-binding repair can bind `fetch` and
 * `kody` to the package. False for browser bundles, which must stay
 * byte-identical.
 */
export function isRepairableArtifactKind(kind: string | null | undefined) {
	return kind == null || !browserArtifactKinds.has(kind)
}

/** True for a bundle built before package `fetch` became lexical. */
export function isPreBindingPublishedArtifact(artifact: RepairableArtifact) {
	if (!isRepairableArtifactKind(artifact.kind)) return false
	if (artifact.packageBindingRewrite === packageBindingRewriteVersion) {
		return false
	}
	let needsBinding = false
	for (const [modulePath, module] of Object.entries(artifact.modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const source = moduleSource(module)
		if (source == null) continue
		if (lexicalBindingNames.some((name) => source.includes(name))) return false
		if (
			!needsBinding &&
			(freeFetchPattern.test(source) || importsSharedKody(source))
		) {
			needsBinding = true
		}
	}
	return needsBinding
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
		(dependency) =>
			!dependency.packageId || dependency.packageId !== ownPackageId,
	)
}

/**
 * Bind a pre-fix single-package bundle's free `fetch` and its shared-runtime
 * `kody` to its own package, the same bindings the builder now inlines for
 * package source: each module gets a top-level `fetch` and `kody` from the
 * shared runtime's `__kodyCreatePackageBoundFetch(<own id>)` and
 * `__kodyCreatePackageBoundKody(<own id>)`, so outbound calls act as that
 * package through its host-minted binding.
 * Identity comes from the artifact's stored package context (bundler
 * provenance), never from anything the sandbox supplies. Bundles that are
 * current, have no package context, inline other packages, or are browser
 * bundles (`app-client`) come back unchanged.
 */
export function repairPreBindingPublishedArtifact<
	Artifact extends RepairableArtifact,
>(artifact: Artifact): Artifact {
	if (!isRepairableArtifactKind(artifact.kind)) return artifact
	const ownPackageId = artifact.packageContext?.packageId?.trim()
	if (!ownPackageId) return artifact
	if (!isPreBindingPublishedArtifact(artifact)) return artifact
	if (publishedArtifactInlinesOtherPackages(artifact)) return artifact
	let modules: WorkerLoaderModules | null = null
	for (const [modulePath, module] of Object.entries(artifact.modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const original = moduleSource(module)
		if (original == null) continue
		const collisions = collectTopLevelFetchCollisionNames(original)
		if (!collisions) {
			// The module does not parse, so its top-level names are unknown and
			// inserting bindings could shadow or break it.
			warnUnrepairedModule({ artifact, modulePath, reason: 'parse-failed' })
			continue
		}
		if (
			collisions.has(repairFetchCreatorName) ||
			collisions.has(repairKodyCreatorName)
		) {
			// The module already declares a name the repair would insert.
			warnUnrepairedModule({
				artifact,
				modulePath,
				reason: 'creator-name-collision',
			})
			continue
		}
		const { source, kodyLocalNames } = stripSharedKodyImports(original)
		const bindFetch = freeFetchPattern.test(source) && !collisions.has('fetch')
		if (!bindFetch && kodyLocalNames.length === 0) continue
		const packageIdLiteral = JSON.stringify(ownPackageId)
		const imported = [
			bindFetch
				? `__kodyCreatePackageBoundFetch as ${repairFetchCreatorName}`
				: null,
			kodyLocalNames.length > 0
				? `__kodyCreatePackageBoundKody as ${repairKodyCreatorName}`
				: null,
		].filter(Boolean)
		const lines = [
			`import { ${imported.join(', ')} } from ${JSON.stringify(
				runtimeSpecifierFrom(modulePath),
			)};`,
		]
		if (bindFetch) {
			lines.push(
				`const fetch = ${repairFetchCreatorName}(${packageIdLiteral});`,
			)
		}
		for (const localName of kodyLocalNames) {
			lines.push(
				`const ${localName} = ${repairKodyCreatorName}(${packageIdLiteral});`,
			)
		}
		modules ??= { ...artifact.modules }
		modules[modulePath] = withModuleSource(
			module,
			`${lines.join('\n')}\n${source}`,
		)
	}
	if (!modules) return artifact
	return { ...artifact, modules }
}

/**
 * True when any isolate-loaded module already names a lexical package-binding
 * creator. Bundles built after GHSA-5fv3 but before the rewrite marker use
 * these names; treat them as current even without `packageBindingRewrite`.
 */
function artifactMentionsLexicalPackageBinding(artifact: RepairableArtifact) {
	for (const [modulePath, module] of Object.entries(artifact.modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const source = moduleSource(module)
		if (source == null) continue
		if (lexicalBindingNames.some((name) => source.includes(name))) {
			return true
		}
	}
	return false
}

/**
 * True for a stored bundle that inlines other packages and cannot be bound in
 * place, so every load site (module/export invoke, scheduled jobs, package
 * workflows via that same export path, static/dynamic imports, package apps)
 * must rebuild it from source or keep serving with a republish warning.
 *
 * Covers two shapes:
 * - Classic pre-binding: free `fetch` / shared `kody` with no lexical creators
 *   ({@link isPreBindingPublishedArtifact}).
 * - Missing binding marker without free `fetch`: inlined callees that only use
 *   `packageStorage()` / secrets still run as the caller until rebuilt. The
 *   free-fetch heuristic alone missed those, so same-commit publish and
 *   workflow export steps kept reusing the stale multi-package bundle.
 */
export function isUnrepairablePreBindingArtifact(artifact: RepairableArtifact) {
	if (!artifact.packageContext?.packageId) return false
	if (!isRepairableArtifactKind(artifact.kind)) return false
	if (!publishedArtifactInlinesOtherPackages(artifact)) return false
	if (artifact.packageBindingRewrite === packageBindingRewriteVersion) {
		return false
	}
	// Post-fix, pre-marker builds already inlined lexical creators.
	if (
		!isPreBindingPublishedArtifact(artifact) &&
		artifactMentionsLexicalPackageBinding(artifact)
	) {
		return false
	}
	return true
}

/**
 * True when a load site holding the package's published source should
 * rebuild this bundle instead of serving it: it predates lexical package
 * identity and inlines other packages (so it cannot be repaired in place), and
 * the source can rebuild without installing npm dependencies. Bundles that
 * cannot rebuild keep serving and log `pre_binding_bundle_needs_republish`.
 */
export function publishedArtifactNeedsPackageBindingRebuild(input: {
	artifact: RepairableArtifact
	sourceFiles: Record<string, string>
}) {
	if (!isUnrepairablePreBindingArtifact(input.artifact)) return false
	const missing = listMissingPublishedSourceInstalledDependencies(
		input.sourceFiles,
	)
	if (missing.length === 0) return true
	// Rebuilding needs an npm install, which only a republish can do. Keep
	// serving, but make the unbound bundle visible.
	console.warn(
		JSON.stringify({
			event: 'pre_binding_bundle_needs_republish',
			sourceId: input.artifact.sourceId ?? null,
			missingDependencyCount: missing.length,
		}),
	)
	return false
}

/**
 * True when load sites holding `sourceFiles` refuse to serve this stored
 * bundle and build the package from source instead (see
 * {@link publishedArtifactNeedsPackageBindingRebuild}). Local execute has no
 * source fallback, so a refused bundle reads there as a missing importable
 * artifact. Publish repair uses this to treat such a bundle as not built.
 * Without source files it falls back to the shape check alone. Does not log.
 */
export function isPublishedArtifactRefusedByLoadSites(input: {
	artifact: RepairableArtifact
	sourceFiles?: Record<string, string> | null
}) {
	if (!isUnrepairablePreBindingArtifact(input.artifact)) return false
	if (!input.sourceFiles) return true
	return (
		listMissingPublishedSourceInstalledDependencies(input.sourceFiles)
			.length === 0
	)
}

/**
 * Errors a still-unbound pre-fix bundle produces when an inlined package's
 * code runs as the caller instead of as itself: package storage and
 * credentials refuse a caller that is not the owning package, a bound
 * helper with no binding refuses to fall back, and a package-scoped secret is
 * not visible from the caller's runtime.
 */
const unboundPackageIdentityErrorPatterns = [
	/packageStorage\(\) for package "[^"]+" is only available to that package's own code/,
	/credential\(\) for package "[^"]+" is only available to that package's own code/,
	/for package "[^"]+" has no package binding in this run/,
	/ and is not visible from this runtime\./,
]

export const preBindingRepublishHint =
	"This run used a published bundle built before package code ran as its own package, and the bundle inlines another package's code, so that code acted as the calling package. Kody rebuilds such bundles from source automatically, but this package's source needs an npm install to rebuild. Republish the package (or the imported package) to rebuild it."

/**
 * Append a republish hint to a run error that comes from a stored pre-fix
 * bundle the load site could not rebuild (see
 * {@link publishedArtifactNeedsPackageBindingRebuild}). Returns null when the
 * bundle is current, is repairable in place, or the error is unrelated, so
 * ordinary failures keep their message unchanged.
 */
export function describePreBindingIdentityError(input: {
	message: string
	artifact: RepairableArtifact
}) {
	if (input.message.includes(preBindingRepublishHint)) return null
	if (
		!unboundPackageIdentityErrorPatterns.some((pattern) =>
			pattern.test(input.message),
		)
	) {
		return null
	}
	if (!isUnrepairablePreBindingArtifact(input.artifact)) return null
	return `${input.message} ${preBindingRepublishHint}`
}

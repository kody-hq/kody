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
	modules: WorkerLoaderModules
	dependencies: Array<{ packageId?: string }>
	packageContext: { packageId: string } | null
	packageBindingRewrite?: number
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

/** True for a bundle built before package `fetch` became lexical. */
export function isPreBindingPublishedArtifact(artifact: RepairableArtifact) {
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
	let modules: WorkerLoaderModules | null = null
	for (const [modulePath, module] of Object.entries(artifact.modules)) {
		if (isPlatformRuntimeModulePath(modulePath)) continue
		const original = moduleSource(module)
		if (original == null) continue
		const collisions = collectTopLevelFetchCollisionNames(original)
		if (
			!collisions ||
			collisions.has(repairFetchCreatorName) ||
			collisions.has(repairKodyCreatorName)
		) {
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

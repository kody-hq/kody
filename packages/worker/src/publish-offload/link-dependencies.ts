import type { ModuleImportNodesCache } from '#worker/package-runtime/import-specifiers.ts'
/**
 * 6C: a bundle built outside Kody cloud never contains another Kody
 * package. Each `kody:@…` import is left as an import of a
 * `.__kody_linked__/…` placeholder, and Kody writes those modules here when
 * it commits the upload: the dependency's own published importable artifact
 * (resolved as the publisher, so read access applies) behind a metered
 * proxy. Package id, storage, secret and capability provenance all come from
 * the registry, never from the upload.
 */
import { collectModuleExportNames } from '#worker/package-runtime/module-export-names.ts'
import {
	linkedArtifactPrefix,
	materializeDependencyArtifactModules,
} from '#worker/package-runtime/module-graph-artifacts.ts'
import { resolveCurrentDynamicPackageArtifact } from '#worker/package-runtime/module-graph-hydration.ts'
import { runtimeModulePath } from '#worker/package-runtime/module-graph-path-basics.ts'
import {
	createRelativeImportSpecifier,
	joinPath,
	linkedPackageImportPath,
	resolveWorkspaceSourceFilePath,
} from '#worker/package-runtime/module-graph-paths.ts'
import {
	collectReachableSourceFilePaths,
	readRootPackage,
} from '#worker/package-runtime/module-graph-workspace.ts'
import type { BundleArtifactDependency } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	createMeteredPackageImportProxySource,
	stripKodyRuntimeModules,
} from '#worker/package-runtime/runtime-source-modules.ts'
import { collectStaticKodyPackageImportsFromFiles } from '#worker/package-runtime/static-kody-imports.ts'
import { normalizePackageWorkspacePath } from '#worker/package-registry/manifest.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { PublishBuildVerificationError } from './verify.ts'

/**
 * Placeholder path → `kody:@…` specifier for every other-package import the
 * entry reaches in source. The server derives this; an upload may only
 * import placeholders in this map.
 */
export function collectLinkedPackageImports(input: {
	sourceFiles: Record<string, string>
	entryPoint: string
	importNodesCache?: ModuleImportNodesCache
}) {
	const rootPackage = readRootPackage(input.sourceFiles)
	const entryPoint =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint)
	const reachable = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint,
		rootPackage,
		...(input.importNodesCache
			? { importNodesCache: input.importNodesCache }
			: {}),
	})
	const linked = new Map<string, string>()
	for (const imported of collectStaticKodyPackageImportsFromFiles(
		Object.fromEntries(
			Object.entries(input.sourceFiles).filter(([path]) => reachable.has(path)),
		),
	)) {
		if (imported.packageName === rootPackage?.manifest.name) continue
		linked.set(linkedPackageImportPath(imported.specifier), imported.specifier)
	}
	return linked
}

type LinkedDependencyArtifact = Awaited<
	ReturnType<typeof resolveCurrentDynamicPackageArtifact>
>

/**
 * One publish's resolved dependency artifacts by `kody:@` specifier, so
 * targets that import the same package load its artifact once.
 */
export type LinkedDependencyArtifactCache = Map<
	string,
	Promise<LinkedDependencyArtifact>
>

/**
 * Writes each referenced placeholder: the dependency's published artifact
 * under `.__kody_linked__/artifacts/…` and a metered proxy at the
 * placeholder. Returns the artifacts' own dependencies so the caller records
 * them as transitive grants, like a cloud build that composes the artifact.
 */
export async function linkUploadedPackageImports(input: {
	env: Env
	baseUrl: string
	userId: string
	modules: WorkerLoaderModules
	linkedImports: ReadonlyMap<string, string>
	referenced: ReadonlySet<string>
	artifactCache?: LinkedDependencyArtifactCache
}) {
	const modules: WorkerLoaderModules = { ...input.modules }
	const publishedArtifactDependencies: Array<BundleArtifactDependency> = []
	for (const placeholder of [...input.referenced].sort()) {
		const specifier = input.linkedImports.get(placeholder)
		if (!specifier) {
			throw new PublishBuildVerificationError(
				`the build imports "${placeholder}", which is not a Kody package this source imports.`,
			)
		}
		let pendingArtifact = input.artifactCache?.get(specifier)
		if (!pendingArtifact) {
			pendingArtifact = resolveCurrentDynamicPackageArtifact({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				specifier,
			})
			input.artifactCache?.set(specifier, pendingArtifact)
		}
		const artifact = await pendingArtifact
		const packageId = artifact.packageContext?.packageId
		if (!packageId) {
			throw new PublishBuildVerificationError(
				`"${specifier}" has no recorded package identity, so Kody cannot link it. Ask its owner to publish it again.`,
			)
		}
		const artifactPrefix = linkedArtifactPrefix({
			specifier,
			sourceId: artifact.sourceId,
			publishedCommit: artifact.publishedCommit,
		})
		const materialized = materializeDependencyArtifactModules({
			artifactPrefix,
			modules: artifact.modules,
		})
		Object.assign(modules, materialized)
		const mainPath = joinPath(artifactPrefix, artifact.mainModule)
		modules[placeholder] = createMeteredPackageImportProxySource({
			targetPath: createRelativeImportSpecifier(placeholder, mainPath),
			runtimeSpecifier: createRelativeImportSpecifier(
				placeholder,
				runtimeModulePath,
			),
			packageId,
			exportNames: collectModuleExportNames({
				files: materialized,
				modulePath: mainPath,
			}),
		})
		publishedArtifactDependencies.push(...artifact.dependencies)
	}
	return {
		modules: stripKodyRuntimeModules(modules),
		publishedArtifactDependencies,
	}
}

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
import { Duration, Effect, Schema } from 'effect'
import { outbound } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import { PublishBuildVerificationError } from './verify.ts'
import { workerLoaderModulesByteSize } from './module-hashes.ts'

/**
 * Placeholder path → `kody:@…` specifier for every other-package import the
 * entry reaches in source. The server derives this; an upload may only
 * import placeholders in this map.
 */
export const collectLinkedPackageImports = Effect.fn(
	'PublishBuildLink.collectLinkedPackageImports',
)(function* (input: {
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
	const reachable = yield* Effect.promise(() =>
		collectReachableSourceFilePaths({
			files: input.sourceFiles,
			entryPoint,
			rootPackage,
			...(input.importNodesCache
				? { importNodesCache: input.importNodesCache }
				: {}),
		}),
	)
	const imports = yield* Effect.promise(() =>
		collectStaticKodyPackageImportsFromFiles(
			Object.fromEntries(
				Object.entries(input.sourceFiles).filter(([path]) =>
					reachable.has(path),
				),
			),
		),
	)
	const linked = new Map<string, string>()
	for (const imported of imports) {
		if (imported.packageName === rootPackage?.manifest.name) continue
		linked.set(linkedPackageImportPath(imported.specifier), imported.specifier)
	}
	return linked
})

/** One `kody:@` import, ready to write into any target that references it. */
type LinkedDependency = {
	modules: Record<string, string>
	dependencies: Array<BundleArtifactDependency>
}

/**
 * One publish's linked dependencies by `kody:@` specifier. Linking parses
 * the whole dependency artifact, and the result is the same for every
 * target, so targets that import the same export share one.
 */
export type LinkedDependencyArtifactCache = Map<string, LinkedDependency>

export type LinkedArtifactReporter = (artifact: {
	path: string
	bytes: number
}) => Promise<void>

/** A dependency Kody cannot link; the commit fails without a verdict. */
export class PublishBuildLinkFailed extends Schema.TaggedError<PublishBuildLinkFailed>()(
	'PublishBuildLinkFailed',
	{ message: Schema.String },
) {}

/** Reading a dependency's published artifact walks its KV and D1 rows. */
const dependencyArtifactTimeout = Duration.minutes(2)

const linkDependency = Effect.fnUntraced(function* (input: {
	baseUrl: string
	userId: string
	placeholder: string
	specifier: string
	onArtifact: LinkedArtifactReporter | undefined
}) {
	const env = yield* WorkerEnv
	const { placeholder, specifier } = input
	const artifact = yield* outbound(
		'package_runtime.resolve_dependency_artifact',
		() =>
			resolveCurrentDynamicPackageArtifact({
				env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				specifier,
			}),
		{ timeout: dependencyArtifactTimeout },
	)
	const packageId = artifact.packageContext?.packageId
	if (!packageId) {
		return yield* new PublishBuildLinkFailed({
			message: `"${specifier}" has no recorded package identity, so Kody cannot link it. Ask its owner to publish it again.`,
		})
	}
	const onArtifact = input.onArtifact
	if (onArtifact) {
		yield* outbound('publish_build.report_linked_artifact', () =>
			onArtifact({
				path: specifier,
				bytes: workerLoaderModulesByteSize(artifact.modules),
			}),
		)
	}
	const artifactPrefix = linkedArtifactPrefix({
		specifier,
		sourceId: artifact.sourceId,
		publishedCommit: artifact.publishedCommit,
	})
	const modules = yield* Effect.promise(() =>
		materializeDependencyArtifactModules({
			artifactPrefix,
			modules: artifact.modules,
			linkedRoot: '',
			// linkUploadedPackageImports strips runtime modules from the result.
			omitRuntimeModules: true,
		}),
	)
	const mainPath = joinPath(artifactPrefix, artifact.mainModule)
	const exportNames = yield* Effect.promise(() =>
		collectModuleExportNames({ files: modules, modulePath: mainPath }),
	)
	modules[placeholder] = createMeteredPackageImportProxySource({
		targetPath: createRelativeImportSpecifier(placeholder, mainPath),
		runtimeSpecifier: createRelativeImportSpecifier(
			placeholder,
			runtimeModulePath,
		),
		packageId,
		exportNames,
	})
	const linked: LinkedDependency = {
		modules,
		dependencies: artifact.dependencies,
	}
	return linked
})

/**
 * Writes each referenced placeholder: the dependency's published artifact
 * under `.__kody_linked__/artifacts/…` and a metered proxy at the
 * placeholder. Returns the artifacts' own dependencies so the caller records
 * them as transitive grants, like a cloud build that composes the artifact.
 */
export const linkUploadedPackageImports = Effect.fn(
	'PublishBuildLink.linkUploadedPackageImports',
)(function* (input: {
	baseUrl: string
	userId: string
	modules: WorkerLoaderModules
	linkedImports: ReadonlyMap<string, string>
	referenced: ReadonlySet<string>
	artifactCache?: LinkedDependencyArtifactCache
	onArtifact?: LinkedArtifactReporter
}) {
	const modules: WorkerLoaderModules = { ...input.modules }
	const publishedArtifactDependencies: Array<BundleArtifactDependency> = []
	for (const placeholder of [...input.referenced].sort()) {
		const specifier = input.linkedImports.get(placeholder)
		if (!specifier) {
			return yield* new PublishBuildVerificationError({
				message: `the build imports "${placeholder}", which is not a Kody package this source imports.`,
			})
		}
		let linked = input.artifactCache?.get(specifier)
		if (!linked) {
			linked = yield* linkDependency({
				baseUrl: input.baseUrl,
				userId: input.userId,
				placeholder,
				specifier,
				onArtifact: input.onArtifact,
			})
			input.artifactCache?.set(specifier, linked)
		}
		Object.assign(modules, linked.modules)
		publishedArtifactDependencies.push(...linked.dependencies)
	}
	return {
		modules: stripKodyRuntimeModules(modules),
		publishedArtifactDependencies,
	}
})

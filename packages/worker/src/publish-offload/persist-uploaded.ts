import {
	publishedPackageArtifactBuildKey,
	type PublishedPackageArtifactBuildTarget,
} from '#worker/package-runtime/package-artifact-targets.ts'
import {
	persistPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuilders,
} from '#worker/package-runtime/published-bundle-artifact-persist.ts'
import { mergePublishedArtifactDependencies } from '#worker/package-runtime/module-graph-import-rewriting.ts'
import {
	type LoadedDependencyPackage,
	resolveKodyDependenciesForEntryPoint,
} from '#worker/package-runtime/module-graph-workspace.ts'
import type { ModuleImportNodesCache } from '#worker/package-runtime/import-specifiers.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { Clock, Duration, Effect, Match, Option, Schema } from 'effect'
import { runEdge, rethrow } from '#worker/effect/edge.ts'
import { outbound } from '#worker/effect/outbound.ts'
import {
	retryTransient,
	TransientRetryBudget,
} from '#worker/effect/transient-retry.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import { PublishBuildBucket, publishOffloadRuntime } from './services.ts'
import {
	finishPublishBuild,
	getPublishBuild,
	readPublishBuildDocument,
	publishBuildBlobKey,
} from './store.ts'
import {
	collectLinkedPackageImports,
	type LinkedArtifactReporter,
	type LinkedDependencyArtifactCache,
	linkUploadedPackageImports,
} from './link-dependencies.ts'
import type {
	PersistUploadedPublishBuildResult,
	PublishBuildModuleEntry,
	PublishBuildTargetEntry,
} from './types.ts'
import {
	assertSameBuildUploadMatches,
	assertSupportedBuilderVersion,
	matchUploadedTargets,
	PublishBuildVerificationError,
	verifySourceManifest,
	verifyUploadedTargetModules,
} from './verify.ts'

const decoder = new TextDecoder()

/** Storage failed after verification passed; the build stays sealed. */
export class PublishBuildArtifactWriteFailed extends Schema.TaggedError<PublishBuildArtifactWriteFailed>()(
	'PublishBuildArtifactWriteFailed',
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Resolving a target's Kody dependencies walks their KV and D1 rows. */
const dependencyResolveTimeout = Duration.minutes(2)
/** One KV value per target, then the batched D1 rows, for every target. */
const artifactWriteTimeout = Duration.minutes(5)

const fail = (message: string) => new PublishBuildVerificationError({ message })

const decodeJsonModule = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Unknown),
)

const readModule = Effect.fnUntraced(function* (input: {
	buildId: string
	entry: PublishBuildModuleEntry
}) {
	const bucket = yield* PublishBuildBucket
	const parts: Array<Uint8Array> = []
	let size = 0
	for (const chunk of input.entry.chunks) {
		const bytes = yield* retryTransient(
			'r2.get publish build chunk',
			bucket.getBytes(publishBuildBlobKey(input.buildId, chunk)),
		)
		if (!bytes) {
			return yield* fail(
				`chunk ${chunk.slice(0, 12)} was never uploaded (or expired); upload the build again.`,
			)
		}
		parts.push(bytes)
		size += bytes.byteLength
	}
	const joined = new Uint8Array(size)
	let offset = 0
	for (const part of parts) {
		joined.set(part, offset)
		offset += part.byteLength
	}
	// Mirrors workerLoaderModuleBytes: `<kind>\0<content>`.
	const separator = joined.indexOf(0)
	if (separator < 0) {
		return yield* fail('an uploaded module has no kind tag.')
	}
	const kind = decoder.decode(joined.subarray(0, separator))
	const body = joined.subarray(separator + 1)
	switch (kind) {
		case 'js':
			return { js: decoder.decode(body) }
		case 'cjs':
			return { cjs: decoder.decode(body) }
		case 'text':
			return { text: decoder.decode(body) }
		case 'json': {
			const json = yield* decodeJsonModule(decoder.decode(body)).pipe(
				Effect.mapError(() => fail('an uploaded json module is not JSON.')),
			)
			return { json: json as object }
		}
		case 'data':
			return { data: body.slice().buffer }
		default:
			return yield* fail(`an uploaded module has unknown kind "${kind}".`)
	}
})

const readTargetModules = Effect.fnUntraced(function* (input: {
	buildId: string
	uploaded: PublishBuildTargetEntry
}) {
	const modules: WorkerLoaderModules = {}
	for (const [path, entry] of Object.entries(input.uploaded.modules)) {
		modules[path] = yield* readModule({ buildId: input.buildId, entry })
	}
	return modules
})
type UploadedTargetBundle = Awaited<
	ReturnType<PublishedPackageArtifactBuilders['buildModuleBundle']>
>

/**
 * Serves each target its own verified upload. An export's `module` and
 * `importable-module` targets share an entry point, so match the bundle kind
 * as well, or the importable slot gets the callable (default-only) bundle.
 */
export function createUploadedTargetBuilders(
	prepared: ReadonlyMap<
		PublishedPackageArtifactBuildTarget,
		UploadedTargetBundle
	>,
): PublishedPackageArtifactBuilders {
	const fromUpload =
		(bundleKind: PublishedPackageArtifactBuildTarget['bundleKind']) =>
		async ({ entryPoint }: { entryPoint: string }) => {
			for (const [target, bundle] of prepared) {
				if (
					target.bundleKind === bundleKind &&
					target.entryPoint === entryPoint
				) {
					return bundle
				}
			}
			throw fail(`no verified ${bundleKind} upload for "${entryPoint}".`)
		}
	return {
		buildAppBundle: fromUpload('app'),
		buildAppClientBundle: fromUpload('app-client'),
		buildModuleBundle: fromUpload('module'),
		buildImportableModuleBundle: fromUpload('importable-module'),
	}
}

type PersistUploadedInput = {
	buildId: string
	baseUrl: string
	userId: string
	source: EntitySourceRow
	savedPackage: SavedPackageRecord
	publishedCommit: string
	sourceFiles: Record<string, string>
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	onLinkedArtifact?: LinkedArtifactReporter
}

const rejectBuild = Effect.fn('PublishBuildPersist.reject')(function* (
	buildId: string,
	message: string,
) {
	yield* finishPublishBuild({ buildId, status: 'rejected', message }).pipe(
		Effect.catchTag(
			['DatabaseError', 'TransientRetryBudgetExhausted'],
			(error) =>
				Effect.logDebug('publish_build_reject_record_failed', {
					buildId,
					message: error.message,
				}),
		),
	)
	const result: PersistUploadedPublishBuildResult = {
		ok: false,
		message: `Publish build rejected: ${message}`,
	}
	return result
})

const verifyAndPersist = Effect.fnUntraced(function* (
	input: PersistUploadedInput,
) {
	const env = yield* WorkerEnv
	// Wall time per step: the clock only advances at I/O, so a step that
	// does no I/O is counted with the next one that does.
	let stepStartedAt = yield* Clock.currentTimeMillis
	const stepMs: Record<string, number> = {}
	const endStep = Effect.fnUntraced(function* (step: string) {
		const now = yield* Clock.currentTimeMillis
		stepMs[step] = (stepMs[step] ?? 0) + (now - stepStartedAt)
		stepStartedAt = now
		// Logged as it goes: a CPU limit reset loses anything held for later.
		yield* Effect.logInfo('publish_upload_persist_step', {
			sourceId: input.source.id,
			buildId: input.buildId,
			step,
			totalMs: stepMs[step],
		})
	})
	const found = yield* retryTransient(
		'publish_builds.get',
		getPublishBuild(input.buildId),
	)
	const row = Option.getOrUndefined(found)
	const document = row ? yield* readPublishBuildDocument({ row }) : null
	if (
		!row ||
		!document ||
		row.source_id !== input.source.id ||
		row.commit_sha !== input.publishedCommit ||
		document.commit !== input.publishedCommit
	) {
		return yield* fail('the sealed build does not match this publish.')
	}
	yield* assertSupportedBuilderVersion(document)
	yield* verifySourceManifest({
		serverFiles: input.sourceFiles,
		claimed: document.files,
	})
	yield* endStep('verify-source')
	const matched = yield* matchUploadedTargets({
		expected: input.targets,
		uploaded: document.targets,
	})
	const ownPackageId = input.savedPackage.id
	const prepared = new Map<
		PublishedPackageArtifactBuildTarget,
		UploadedTargetBundle
	>()
	// One parse per module and one load per Kody dependency for the whole
	// build, instead of once per target (about 100 targets on big packages).
	const importNodesCache: ModuleImportNodesCache = new Map()
	const loadedPackages = new Map<string, LoadedDependencyPackage>()
	const artifactCache: LinkedDependencyArtifactCache = new Map()
	// Targets that share a build (an export and the jobs on its file) get
	// the first one's verified, linked upload; see createUploadedTargetBuilders.
	const linkedBuilds = new Map<string, PublishBuildTargetEntry>()
	for (const { target, uploaded } of matched) {
		const buildKey = publishedPackageArtifactBuildKey(target)
		const kept = linkedBuilds.get(buildKey)
		if (kept) {
			yield* assertSameBuildUploadMatches({ kept, uploaded })
			continue
		}
		linkedBuilds.set(buildKey, uploaded)
		const dependencies =
			target.bundleKind === 'app-client'
				? []
				: yield* outbound(
						'package_runtime.resolve_dependencies',
						() =>
							resolveKodyDependenciesForEntryPoint({
								env,
								baseUrl: input.baseUrl,
								userId: input.userId,
								sourceFiles: input.sourceFiles,
								entryPoint: target.entryPoint,
								importNodesCache,
								loadedPackages,
							}),
						{ timeout: dependencyResolveTimeout },
					)
		yield* endStep('resolve-dependencies')
		const linkedImports =
			target.bundleKind === 'app-client'
				? new Map<string, string>()
				: yield* collectLinkedPackageImports({
						sourceFiles: input.sourceFiles,
						entryPoint: target.entryPoint,
						importNodesCache,
					})
		const modules = yield* readTargetModules({
			buildId: input.buildId,
			uploaded,
		})
		yield* endStep('read-modules')
		const { referencedLinkedImports } = yield* verifyUploadedTargetModules({
			uploaded,
			modules,
			ownPackageId,
			linkedImports,
		})
		yield* endStep('verify-modules')
		const linked = yield* linkUploadedPackageImports({
			baseUrl: input.baseUrl,
			userId: input.userId,
			modules,
			linkedImports,
			referenced: referencedLinkedImports,
			artifactCache,
			...(input.onLinkedArtifact ? { onArtifact: input.onLinkedArtifact } : {}),
		})
		yield* endStep('link-imports')
		prepared.set(target, {
			mainModule: uploaded.mainModule,
			modules: linked.modules,
			dependencies: mergePublishedArtifactDependencies({
				dependencies,
				publishedArtifactDependencies: linked.publishedArtifactDependencies,
			}),
		})
	}
	const results = yield* outbound(
		'package_runtime.persist_artifact_targets',
		() =>
			persistPublishedPackageArtifactTargets({
				env,
				userId: input.userId,
				source: { ...input.source, published_commit: input.publishedCommit },
				savedPackage: input.savedPackage,
				targets: input.targets,
				builtIn: { origin: row.origin, contextName: row.context_name },
				...createUploadedTargetBuilders(prepared),
			}),
		{ timeout: artifactWriteTimeout },
	)
	yield* endStep('write-artifacts')
	const failed = results.filter((result) => !result.ok)
	if (failed.length > 0) {
		// Not a verification verdict: storage failed. Leave the build sealed
		// so the same upload can be committed again.
		return yield* new PublishBuildArtifactWriteFailed({
			message: `Writing uploaded artifacts failed: ${failed.map((result) => getErrorMessage(result.error)).join('; ')}`,
			cause: failed[0]?.error,
		})
	}
	yield* finishPublishBuild({ buildId: input.buildId, status: 'committed' })
	const result: PersistUploadedPublishBuildResult = {
		ok: true,
		targetCount: matched.length,
	}
	return result
})

/**
 * Publish offload commit step, run on the RepoSession that owns the publish:
 * verify the sealed upload against the pushed commit, link the Kody
 * packages it imports (6C), then write every target the same way a rebuild
 * does (one KV value per target, then the batched D1 rows). Nothing is built
 * here, but verification, linking and writes still use Kody compute. The caller
 * advances `serving_commit` only after this returns ok.
 */
export const persistUploaded = Effect.fn('PublishBuildPersist.persistUploaded')(
	function* (input: PersistUploadedInput) {
		return yield* verifyAndPersist(input).pipe(
			Effect.catchTag('PublishBuildVerificationError', (error) =>
				rejectBuild(input.buildId, error.message),
			),
			// One retry budget for the whole commit.
			Effect.provide(TransientRetryBudget.layer),
		)
	},
)

type PersistUploadedError = Effect.Error<ReturnType<typeof persistUploaded>>

const persistUploadedFailure = Match.type<PersistUploadedError>().pipe(
	Match.tagsExhaustive({
		PublishBuildArtifactWriteFailed: (
			error,
		): PersistUploadedPublishBuildResult => {
			throw new Error(error.message, { cause: error.cause })
		},
		PublishBuildLinkFailed: (error): PersistUploadedPublishBuildResult => {
			throw new Error(error.message)
		},
		PublishBuildDocumentUnreadable: (
			error,
		): PersistUploadedPublishBuildResult => {
			throw new Error(error.message)
		},
		// Storage stayed busy: the build is still sealed, so commit it again.
		TransientRetryBudgetExhausted: ({
			label,
		}): PersistUploadedPublishBuildResult => ({
			ok: false,
			message: `Publish storage was busy (${label}). The build is still sealed, so the publish can be retried.`,
		}),
		DatabaseError: rethrow,
		OutboundCallError: rethrow,
	}),
)

/** The RepoSession edge (`RepoSession.persistUploadedPublishBuild`). */
export async function persistUploadedPublishBuild(
	input: PersistUploadedInput & { env: Env },
): Promise<PersistUploadedPublishBuildResult> {
	return await runEdge(
		publishOffloadRuntime(input.env),
		persistUploaded(input),
		persistUploadedFailure,
	)
}

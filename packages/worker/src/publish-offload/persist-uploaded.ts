import type { PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/package-artifact-targets.ts'
import {
	persistPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuilders,
} from '#worker/package-runtime/published-bundle-artifact-persist.ts'
import { mergePublishedArtifactDependencies } from '#worker/package-runtime/module-graph-import-rewriting.ts'
import { resolveKodyDependenciesForEntryPoint } from '#worker/package-runtime/module-graph-workspace.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { serverRebuildSampleSize } from './policy.ts'
import {
	finishPublishBuild,
	getPublishBuild,
	parsePublishBuildDocument,
	publishBuildBlobKey,
} from './store.ts'
import {
	collectLinkedPackageImports,
	linkUploadedPackageImports,
} from './link-dependencies.ts'
import type {
	PersistUploadedPublishBuildResult,
	PublishBuildModuleEntry,
	PublishBuildTargetEntry,
} from './types.ts'
import {
	assertServerRebuildMatches,
	assertSupportedBuilderVersion,
	matchUploadedTargets,
	pickServerRebuildSample,
	PublishBuildVerificationError,
	verifySourceManifest,
	verifyUploadedTargetModules,
} from './verify.ts'

const decoder = new TextDecoder()

async function readModule(input: {
	bucket: R2Bucket
	buildId: string
	entry: PublishBuildModuleEntry
}) {
	const parts: Array<Uint8Array> = []
	let size = 0
	for (const chunk of input.entry.chunks) {
		const object = await input.bucket.get(
			publishBuildBlobKey(input.buildId, chunk),
		)
		if (!object) {
			throw new PublishBuildVerificationError(
				`chunk ${chunk.slice(0, 12)} was never uploaded (or expired); upload the build again.`,
			)
		}
		const bytes = new Uint8Array(await object.arrayBuffer())
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
		throw new PublishBuildVerificationError(
			'an uploaded module has no kind tag.',
		)
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
		case 'json':
			return { json: JSON.parse(decoder.decode(body)) as object }
		case 'data':
			return { data: body.slice().buffer }
		default:
			throw new PublishBuildVerificationError(
				`an uploaded module has unknown kind "${kind}".`,
			)
	}
}

async function readTargetModules(input: {
	bucket: R2Bucket
	buildId: string
	uploaded: PublishBuildTargetEntry
}) {
	const modules: WorkerLoaderModules = {}
	for (const [path, entry] of Object.entries(input.uploaded.modules)) {
		modules[path] = await readModule({ ...input, entry })
	}
	return modules
}

/**
 * Publish offload commit step, run on the RepoSession that owns the publish:
 * verify the sealed upload against the pushed commit, link the Kody
 * packages it imports (6C), re-check a sample by rebuilding it here, then
 * write every target the same way a rebuild does
 * (one KV value per target, then the batched D1 rows). The caller advances
 * `serving_commit` only after this returns ok.
 */
export async function persistUploadedPublishBuild(input: {
	env: Env
	buildId: string
	communityListed: boolean
	baseUrl: string
	userId: string
	source: EntitySourceRow
	savedPackage: SavedPackageRecord
	publishedCommit: string
	sourceFiles: Record<string, string>
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	rebuildSample: (
		targets: Array<PublishedPackageArtifactBuildTarget>,
	) => Promise<
		Array<{ mainModule: string; moduleHashes: Record<string, string> } | Error>
	>
}): Promise<PersistUploadedPublishBuildResult> {
	const db = input.env.APP_DB
	const reject = async (message: string) => {
		await finishPublishBuild({
			db,
			buildId: input.buildId,
			status: 'rejected',
			message,
		}).catch(() => {})
		return {
			ok: false as const,
			message: `Publish build rejected: ${message}`,
		}
	}
	try {
		const row = await getPublishBuild(db, input.buildId)
		const document = row ? parsePublishBuildDocument(row) : null
		if (
			!row ||
			!document ||
			row.source_id !== input.source.id ||
			row.commit_sha !== input.publishedCommit ||
			document.commit !== input.publishedCommit
		) {
			return await reject('the sealed build does not match this publish.')
		}
		assertSupportedBuilderVersion(document)
		await verifySourceManifest({
			serverFiles: input.sourceFiles,
			claimed: document.files,
		})
		const matched = matchUploadedTargets({
			expected: input.targets,
			uploaded: document.targets,
		})
		const ownPackageId = input.savedPackage.id
		const bucket = input.env.REPO_SESSION_BLOBS
		const prepared = new Map<
			PublishedPackageArtifactBuildTarget,
			Awaited<ReturnType<PublishedPackageArtifactBuilders['buildModuleBundle']>>
		>()
		for (const { target, uploaded } of matched) {
			const dependencies =
				target.bundleKind === 'app-client'
					? []
					: await resolveKodyDependenciesForEntryPoint({
							env: input.env,
							baseUrl: input.baseUrl,
							userId: input.userId,
							sourceFiles: input.sourceFiles,
							entryPoint: target.entryPoint,
						})
			const linkedImports =
				target.bundleKind === 'app-client'
					? new Map<string, string>()
					: collectLinkedPackageImports({
							sourceFiles: input.sourceFiles,
							entryPoint: target.entryPoint,
						})
			const modules = await readTargetModules({
				bucket,
				buildId: input.buildId,
				uploaded,
			})
			const { referencedLinkedImports } = await verifyUploadedTargetModules({
				uploaded,
				modules,
				ownPackageId,
				linkedImports,
			})
			const linked = await linkUploadedPackageImports({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				modules,
				linkedImports,
				referenced: referencedLinkedImports,
			})
			prepared.set(target, {
				mainModule: uploaded.mainModule,
				modules: linked.modules,
				dependencies: mergePublishedArtifactDependencies({
					dependencies,
					publishedArtifactDependencies: linked.publishedArtifactDependencies,
				}),
			})
		}
		const sample = pickServerRebuildSample(
			matched,
			serverRebuildSampleSize({ communityListed: input.communityListed }),
		)
		const rebuilt = await input.rebuildSample(
			sample.map((entry) => entry.target),
		)
		for (const [index, entry] of sample.entries()) {
			const result = rebuilt[index]
			if (!result || result instanceof Error) {
				return await reject(
					`the server could not rebuild "${entry.uploaded.entryPoint}" to compare it: ${result ? result.message : 'no result'}.`,
				)
			}
			assertServerRebuildMatches({ uploaded: entry.uploaded, rebuilt: result })
		}
		const fromUpload = async ({ entryPoint }: { entryPoint: string }) => {
			for (const [target, bundle] of prepared) {
				if (target.entryPoint === entryPoint) return bundle
			}
			throw new PublishBuildVerificationError(
				`no verified upload for "${entryPoint}".`,
			)
		}
		const results = await persistPublishedPackageArtifactTargets({
			env: input.env,
			userId: input.userId,
			source: { ...input.source, published_commit: input.publishedCommit },
			savedPackage: input.savedPackage,
			targets: input.targets,
			buildAppBundle: fromUpload,
			buildAppClientBundle: fromUpload,
			buildModuleBundle: fromUpload,
			buildImportableModuleBundle: fromUpload,
		})
		const failed = results.filter((result) => !result.ok)
		if (failed.length > 0) {
			// Not a verification verdict: storage failed. Leave the build sealed
			// so the same upload can be committed again.
			return {
				ok: false,
				message: failed
					.map((result) => (result.ok ? '' : getErrorMessage(result.error)))
					.join('; '),
			}
		}
		await finishPublishBuild({
			db,
			buildId: input.buildId,
			status: 'committed',
		})
		return {
			ok: true,
			targetCount: matched.length,
			sampledTargetCount: sample.length,
		}
	} catch (error) {
		if (error instanceof PublishBuildVerificationError) {
			return await reject(error.message)
		}
		throw error
	}
}

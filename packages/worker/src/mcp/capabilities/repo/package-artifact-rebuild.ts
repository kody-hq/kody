import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	formatErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import {
	isRetryableD1LockError,
	isRetryableD1StorageUnavailabilityError,
} from '#worker/d1-retry.ts'
import {
	isPublishedPackageArtifactBuiltForCommit,
	loadPublishedBundleArtifactsForPackageTargets,
	publishedBundleArtifactForPackageTarget,
	reusePublishedPackageArtifactIfUnchanged,
	type PublishedPackageArtifactReuseSnapshotCache,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	hasPublishedRuntimeArtifacts,
	readPublishedSourceSnapshot,
	type PublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/package-artifact-targets.ts'
import {
	createIsolatedArtifactRebuildRunner,
	isolatedArtifactRebuildChunkConcurrency,
	isolatedArtifactRebuildChunkSize,
} from '#worker/repo/isolated-artifact-rebuild.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-rpc.ts'
import {
	isDurableObjectIsolateResourceLimitResetError,
	isTransientDurableObjectResetError,
} from '#worker/durable-object-reset-retry.ts'
import { isUserCodeError, UserCodeError } from '#worker/user-code-error.ts'

/**
 * Same-session rebuild RPCs hit one Durable Object, which serializes
 * execution. Depth 2 pipelines the next RPC while the DO finishes the current
 * one (cuts inter-call worker round-trip idle time) without flooding the DO
 * input gate the way unbounded Promise.all would. Isolated throwaway-DO
 * rebuilds use the same concurrency cap across target chunks.
 */
export const publishedPackageArtifactRebuildConcurrency =
	isolatedArtifactRebuildChunkConcurrency

/**
 * Deploy-time DO code resets and other genuinely transient platform isolate
 * resets during staging or target rebuilds. Rebuilds are idempotent
 * (already-built targets are skipped), so a short bounded retry recovers
 * without re-running publish. Memory/CPU / SQLITE_NOMEM resource limits are
 * excluded — they repeat for the same targets. Matches
 * packagePublishExternalPush delays.
 */
export const publishedPackageArtifactRebuildRetryDelaysMs = [100, 500] as const

/**
 * D1 lock / long-running export blips need a longer bounded budget than DO
 * code resets. Nightly DR export (02:15 UTC) holds APP_DB far longer than the
 * DO-reset window; waiting tens of seconds gives publish a real chance near
 * export end without holding the MCP request for the full export. Exhausted
 * attempts still surface as retryable 503 via toApiError
 * (`isRetryableD1LockError`).
 */
export const publishedPackageArtifactRebuildD1LockRetryDelaysMs = [
	500, 2_000, 5_000, 10_000,
] as const

function isTransientArtifactRebuildError(error: unknown) {
	// `isRetryableD1LockError` still matches isolate memory/CPU / SQLITE_NOMEM
	// (D1 is DO-backed). Those limits are deterministic for the same targets —
	// do not burn the rebuild retry budget on them.
	if (isDurableObjectIsolateResourceLimitResetError(error)) {
		return false
	}
	return (
		isTransientDurableObjectResetError(error) || isRetryableD1LockError(error)
	)
}

function artifactRebuildRetryDelaysMsFor(
	error: unknown,
): ReadonlyArray<number> {
	// Nightly export / SQLITE_BUSY / overload / opaque D1 internal blips get
	// the longer window. DO isolate resets (including D1_ERROR:-prefixed
	// code-updated) share the broader D1 retry matcher because D1 is
	// DO-backed — keep their short budget.
	return isRetryableD1StorageUnavailabilityError(error)
		? publishedPackageArtifactRebuildD1LockRetryDelaysMs
		: publishedPackageArtifactRebuildRetryDelaysMs
}

function logArtifactRebuildRetry(input: {
	sourceId: string
	publishedCommit: string
	attempt: number
	nextDelayMs: number
	error: unknown
}) {
	console.warn(
		JSON.stringify({
			message:
				'rebuildPublishedPackageArtifactsViaRepoSession transient platform error',
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			attempt: input.attempt,
			nextDelayMs: input.nextDelayMs,
			errorMessage: getErrorMessage(input.error),
		}),
	)
}

async function delay(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

function describePackageArtifactTarget(
	target: PublishedPackageArtifactBuildTarget,
) {
	return [
		`kind "${target.kind}"`,
		`artifact "${target.artifactName ?? '<default>'}"`,
		`entry "${target.entryPoint}"`,
		`bundle "${target.bundleKind}"`,
	].join(', ')
}

function buildRebuildFailureMessage(input: {
	sourceId: string
	publishedCommit: string
	succeeded: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	failed: ReadonlyArray<{
		target: PublishedPackageArtifactBuildTarget
		error: unknown
	}>
	error?: unknown
}) {
	const succeededSummary =
		input.succeeded.length === 0
			? 'none'
			: input.succeeded
					.map((target) => `{ ${describePackageArtifactTarget(target)} }`)
					.join(', ')
	const failedSummary =
		input.failed.length === 0
			? input.error
				? formatErrorCauseChain(input.error)
				: 'unknown'
			: input.failed
					.map(
						({ target, error }) =>
							`{ ${describePackageArtifactTarget(target)} }: ${formatErrorCauseChain(error)}`,
					)
					.join('; ')
	// Partial artifact writes were already possible with sequential rebuilds
	// (earlier targets stay written when a later one fails). Bounded concurrency
	// only widens that to the in-flight peer in the current chunk; later chunks
	// are not scheduled after a failure.
	return `Package source publish succeeded, but bundle artifact rebuild failed for source "${input.sourceId}" at commit "${input.publishedCommit}". Succeeded: ${succeededSummary}. Failed: ${failedSummary}. Re-run the publish capability to repair artifacts.`
}

/**
 * Rebuild wrap that keeps undeclared-bare-import (and other UserCodeError)
 * failures as caller errors for Sentry, while leaving platform rebuild
 * failures as plain Errors.
 */
function throwRebuildFailure(input: {
	sourceId: string
	publishedCommit: string
	succeeded: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	failed: ReadonlyArray<{
		target: PublishedPackageArtifactBuildTarget
		error: unknown
	}>
	error?: unknown
}): never {
	const message = buildRebuildFailureMessage(input)
	const causes = [
		...input.failed.map((entry) => entry.error),
		...(input.error !== undefined ? [input.error] : []),
	]
	const callerOnly =
		causes.length > 0 && causes.every((cause) => isUserCodeError(cause))
	if (callerOnly) {
		throw new UserCodeError(message, { cause: causes[0] })
	}
	// Prefer a platform cause so a mixed wave (caller + platform) still
	// reaches Sentry via isUserCodeError / beforeSend. Attaching a
	// UserCodeError cause would drop the whole rebuild failure.
	const platformCause = causes.find((cause) => !isUserCodeError(cause))
	throw new Error(message, { cause: platformCause ?? causes[0] })
}

function rebuildFailureFromTargetResult(input: {
	target: PublishedPackageArtifactBuildTarget
	message: string
	callerFailure?: boolean
}) {
	return {
		target: input.target,
		error: input.callerFailure
			? new UserCodeError(input.message)
			: new Error(input.message),
	}
}

async function filterTargetsNeedingRebuild(input: {
	env: Env
	userId: string
	sourceId: string
	publishedCommit: string
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	force?: boolean
}) {
	if (input.force) {
		return {
			remaining: [...input.targets],
			alreadyBuilt: [] as Array<PublishedPackageArtifactBuildTarget>,
			reused: [] as Array<PublishedPackageArtifactBuildTarget>,
		}
	}
	const remaining: Array<PublishedPackageArtifactBuildTarget> = []
	const alreadyBuilt: Array<PublishedPackageArtifactBuildTarget> = []
	const reused: Array<PublishedPackageArtifactBuildTarget> = []
	if (input.targets.length === 0) {
		return { remaining, alreadyBuilt, reused }
	}
	// Load this rebuild's published snapshot once and pass that value to every
	// target. A later rebuild loads again. Prior-commit snapshots are shared
	// for this call. Dependency source rows are not: a dependency can publish
	// between sequential targets, and a shared row would let later targets
	// copy a bundle that still embeds the older dependency commit.
	const publishedSnapshot: PublishedSourceSnapshot | null | undefined =
		hasPublishedRuntimeArtifacts(input.env)
			? await readPublishedSourceSnapshot({
					env: input.env,
					sourceId: input.sourceId,
					publishedCommit: input.publishedCommit,
				})
			: undefined
	const sharedSnapshot =
		publishedSnapshot !== undefined ? { publishedSnapshot } : {}
	const snapshotCache: PublishedPackageArtifactReuseSnapshotCache = new Map()
	const loadedByIdentity = hasPublishedRuntimeArtifacts(input.env)
		? await loadPublishedBundleArtifactsForPackageTargets({
				env: input.env,
				userId: input.userId,
				sourceId: input.sourceId,
				targets: input.targets,
			})
		: null
	for (const target of input.targets) {
		const preloaded = loadedByIdentity
			? publishedBundleArtifactForPackageTarget({
					sourceId: input.sourceId,
					target,
					loadedByIdentity,
				})
			: undefined
		const built = await isPublishedPackageArtifactBuiltForCommit({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			target,
			...sharedSnapshot,
			...(preloaded !== undefined ? { preloaded } : {}),
		})
		if (built) {
			alreadyBuilt.push(target)
			continue
		}
		const didReuse = await reusePublishedPackageArtifactIfUnchanged({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			target,
			snapshotCache,
			...sharedSnapshot,
			...(preloaded !== undefined ? { preloaded } : {}),
		})
		if (didReuse) {
			// Reuse copies prior-commit bytes under this tip — that is artifact
			// work for artifacts_rebuilt, not a no-op skip.
			reused.push(target)
			continue
		}
		remaining.push(target)
	}
	return { remaining, alreadyBuilt, reused }
}

async function listTargetsOrThrow(input: {
	session: ReturnType<typeof repoSessionRpc>
	repoSessionId?: string
	sourceId: string
	userId: string
	publishedCommit: string
}) {
	try {
		return await input.session.listPublishedPackageArtifactTargets({
			sessionId: input.repoSessionId,
			sourceId: input.sourceId,
			userId: input.userId,
		})
	} catch (error) {
		throwRebuildFailure({
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			succeeded: [],
			failed: [],
			error,
		})
	}
}

/**
 * Read-only: how many of the package's artifact targets are not built for
 * `publishedCommit`. Unlike the rebuild filter it never reuses or writes.
 */
export async function countUnbuiltPublishedPackageArtifactTargets(input: {
	env: Env
	rpcSessionId: string
	sourceId: string
	userId: OwnerId
	publishedCommit: string
}) {
	const targets = await repoSessionRpc(
		input.env,
		input.rpcSessionId,
	).listPublishedPackageArtifactTargets({
		sourceId: input.sourceId,
		userId: input.userId,
	})
	const loadedByIdentity = await loadPublishedBundleArtifactsForPackageTargets({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		targets,
	})
	let unbuilt = 0
	for (const target of targets) {
		const built = await isPublishedPackageArtifactBuiltForCommit({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			target,
			preloaded: publishedBundleArtifactForPackageTarget({
				sourceId: input.sourceId,
				target,
				loadedByIdentity,
			}),
		})
		if (!built) unbuilt += 1
	}
	return { targetCount: targets.length, unbuiltCount: unbuilt }
}

export type RebuildPublishedPackageArtifactsResult = {
	/**
	 * Targets that were not already built for this commit and therefore ran
	 * rebuild or reuse work. Zero means every target was already current.
	 */
	rebuiltTargetCount: number
}

async function rebuildPublishedPackageArtifactsOnSession(input: {
	env: Env
	rpcSessionId: string
	repoSessionId?: string
	sourceId: string
	userId: string
	publishedCommit: string
	baseUrl: string
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	force?: boolean
}): Promise<RebuildPublishedPackageArtifactsResult> {
	const session = repoSessionRpc(input.env, input.rpcSessionId)
	const succeeded: Array<PublishedPackageArtifactBuildTarget> = []
	const { remaining, alreadyBuilt, reused } = await filterTargetsNeedingRebuild(
		{
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			targets: input.targets,
			force: input.force,
		},
	)
	succeeded.push(...alreadyBuilt, ...reused)

	const failed: Array<{
		target: PublishedPackageArtifactBuildTarget
		error: unknown
	}> = []

	for (const targetChunk of chunkArray(
		remaining,
		publishedPackageArtifactRebuildConcurrency,
	)) {
		if (failed.length > 0) break

		const settled = await Promise.allSettled(
			targetChunk.map(async (target) => {
				await session.rebuildPublishedPackageArtifact({
					sessionId: input.repoSessionId,
					sourceId: input.sourceId,
					userId: input.userId,
					publishedCommit: input.publishedCommit,
					target,
					baseUrl: input.baseUrl,
				})
				return target
			}),
		)

		for (const [index, result] of settled.entries()) {
			const target = targetChunk[index]
			if (!target) continue
			if (result.status === 'fulfilled') {
				succeeded.push(target)
				continue
			}
			failed.push({ target, error: result.reason })
		}
	}

	if (failed.length === 0) {
		return { rebuiltTargetCount: remaining.length + reused.length }
	}

	throwRebuildFailure({
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		succeeded,
		failed,
	})
}

async function resolveRebuildTargets(input: {
	session: ReturnType<typeof repoSessionRpc>
	repoSessionId?: string
	sourceId: string
	userId: OwnerId
	publishedCommit: string
	targets?: ReadonlyArray<PublishedPackageArtifactBuildTarget>
}): Promise<ReadonlyArray<PublishedPackageArtifactBuildTarget>> {
	if (input.targets) return input.targets
	return await listTargetsOrThrow({
		session: input.session,
		repoSessionId: input.repoSessionId,
		sourceId: input.sourceId,
		userId: input.userId,
		publishedCommit: input.publishedCommit,
	})
}

async function rebuildPublishedPackageArtifactsViaRepoSessionOnce(input: {
	env: Env
	rpcSessionId: string
	repoSessionId?: string
	sourceId: string
	userId: OwnerId
	publishedCommit: string
	baseUrl: string
	targets?: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	force?: boolean
}): Promise<RebuildPublishedPackageArtifactsResult> {
	const session = repoSessionRpc(input.env, input.rpcSessionId)
	const isolatedRunner = createIsolatedArtifactRebuildRunner(input.env)

	if (!isolatedRunner) {
		const targets = await resolveRebuildTargets({
			session,
			repoSessionId: input.repoSessionId,
			sourceId: input.sourceId,
			userId: input.userId,
			publishedCommit: input.publishedCommit,
			targets: input.targets,
		})
		return await rebuildPublishedPackageArtifactsOnSession({
			...input,
			targets,
		})
	}

	// List + skip before staging so already_published / repair resumes and
	// unchanged prior-commit targets do not pay collectWorkspaceFiles + KV
	// stage when nothing remains to rebuild. Callers such as the importable
	// backfill may pass a filtered target list to stay in scope.
	const targets = await resolveRebuildTargets({
		session,
		repoSessionId: input.repoSessionId,
		sourceId: input.sourceId,
		userId: input.userId,
		publishedCommit: input.publishedCommit,
		targets: input.targets,
	})

	const { remaining, alreadyBuilt, reused } = await filterTargetsNeedingRebuild(
		{
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			targets,
			force: input.force,
		},
	)
	const succeeded: Array<PublishedPackageArtifactBuildTarget> = [
		...alreadyBuilt,
		...reused,
	]
	if (remaining.length === 0) {
		return { rebuiltTargetCount: reused.length }
	}

	let stagingKey: string
	try {
		;({ stagingKey } = await session.stagePublishedPackageArtifactRebuild({
			sessionId: input.repoSessionId,
			sourceId: input.sourceId,
			userId: input.userId,
			publishedCommit: input.publishedCommit,
		}))
	} catch (error) {
		throwRebuildFailure({
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			succeeded,
			failed: [],
			error,
		})
	}

	const failed: Array<{
		target: PublishedPackageArtifactBuildTarget
		error: unknown
	}> = []

	try {
		const isolateChunks = chunkArray(
			remaining,
			isolatedArtifactRebuildChunkSize,
		)
		const waves = chunkArray(
			isolateChunks,
			publishedPackageArtifactRebuildConcurrency,
		)
		for (const [waveIndex, wave] of waves.entries()) {
			if (failed.length > 0) break
			if (waveIndex > 0) {
				await isolatedRunner.touch(stagingKey)
			}

			const settled = await Promise.allSettled(
				wave.map(async (targets) => {
					const outcome = await isolatedRunner.run({
						stagingKey,
						sourceId: input.sourceId,
						userId: input.userId,
						publishedCommit: input.publishedCommit,
						targets,
						baseUrl: input.baseUrl,
						force: input.force,
					})
					return { targets, outcome }
				}),
			)

			for (const [index, result] of settled.entries()) {
				const targets = wave[index]
				if (!targets) continue
				if (result.status === 'rejected') {
					for (const target of targets) {
						failed.push({ target, error: result.reason })
					}
					continue
				}
				const { outcome } = result.value
				const targetResults = outcome.results ?? []
				if (targetResults.length > 0) {
					for (const targetResult of targetResults) {
						if (targetResult.ok) {
							succeeded.push(targetResult.target)
							continue
						}
						failed.push(
							rebuildFailureFromTargetResult({
								target: targetResult.target,
								message: targetResult.message,
								callerFailure: targetResult.callerFailure,
							}),
						)
					}
					continue
				}
				if (outcome.ok) {
					succeeded.push(...targets)
					continue
				}
				for (const target of targets) {
					failed.push({ target, error: new Error(outcome.message) })
				}
			}
		}
	} finally {
		await isolatedRunner.discard(stagingKey)
	}

	if (failed.length === 0) {
		return { rebuiltTargetCount: remaining.length + reused.length }
	}

	throwRebuildFailure({
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		succeeded,
		failed,
	})
}

export async function rebuildPublishedPackageArtifactsViaRepoSession(input: {
	env: Env
	rpcSessionId: string
	repoSessionId?: string
	sourceId: string
	userId: OwnerId
	publishedCommit: string
	baseUrl: string
	/** When set, rebuild only these targets instead of every package target. */
	targets?: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	force?: boolean
}): Promise<RebuildPublishedPackageArtifactsResult> {
	let lastTransientError: unknown = null
	let attempt = 0
	for (;;) {
		attempt += 1
		try {
			return await rebuildPublishedPackageArtifactsViaRepoSessionOnce(input)
		} catch (error) {
			if (!isTransientArtifactRebuildError(error)) {
				throw error
			}
			lastTransientError = error
			const delays = artifactRebuildRetryDelaysMsFor(error)
			const delayIndex = attempt - 1
			const willRetry = delayIndex < delays.length
			const nextDelayMs = willRetry ? (delays[delayIndex] ?? 0) : 0
			logArtifactRebuildRetry({
				sourceId: input.sourceId,
				publishedCommit: input.publishedCommit,
				attempt,
				nextDelayMs,
				error,
			})
			if (!willRetry) {
				break
			}
			await delay(nextDelayMs)
		}
	}
	// Preserve the last transient as `cause` so toApiError / Sentry remap can
	// walk exact D1 platform sentences (export, overload, internal error with
	// reference) that are only embedded — not bare — in the outer message.
	throw new Error(
		`rebuildPublishedPackageArtifactsViaRepoSession could not recover after ${attempt} transient platform error attempts: ${getErrorMessage(
			lastTransientError,
		)}`,
		lastTransientError === null ? undefined : { cause: lastTransientError },
	)
}

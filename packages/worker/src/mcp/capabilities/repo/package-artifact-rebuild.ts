import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	errorCauseChainIncludes,
	formatErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import {
	isPublishedPackageArtifactBuiltForCommit,
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
import { isDurableObjectIsolateResetMessage } from '#worker/sentry-options.ts'
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
 * Deploy-time DO code resets, other platform isolate resets, and D1
 * `internal error; reference = …` blips during staging or target rebuilds
 * are transient. Rebuilds are idempotent (already-built targets are skipped),
 * so a short bounded retry recovers without re-running publish. Matches
 * packagePublishExternalPush delays.
 */
export const publishedPackageArtifactRebuildRetryDelaysMs = [100, 500] as const

function isTransientDurableObjectResetError(error: unknown) {
	return errorCauseChainIncludes(error, isDurableObjectIsolateResetMessage)
}

function isTransientArtifactRebuildError(error: unknown) {
	return (
		isTransientDurableObjectResetError(error) || isRetryableD1LockError(error)
	)
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
			alreadyBuilt: [],
		}
	}
	const remaining: Array<PublishedPackageArtifactBuildTarget> = []
	const alreadyBuilt: Array<PublishedPackageArtifactBuildTarget> = []
	if (input.targets.length === 0) {
		return { remaining, alreadyBuilt }
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
	for (const target of input.targets) {
		const built = await isPublishedPackageArtifactBuiltForCommit({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			target,
			...sharedSnapshot,
		})
		if (built) {
			alreadyBuilt.push(target)
			continue
		}
		const reused = await reusePublishedPackageArtifactIfUnchanged({
			env: input.env,
			userId: input.userId,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			target,
			snapshotCache,
			...sharedSnapshot,
		})
		if (reused) {
			alreadyBuilt.push(target)
			continue
		}
		remaining.push(target)
	}
	return { remaining, alreadyBuilt }
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
	const { remaining, alreadyBuilt } = await filterTargetsNeedingRebuild({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		targets: input.targets,
		force: input.force,
	})
	succeeded.push(...alreadyBuilt)

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
		return { rebuiltTargetCount: remaining.length }
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

	const { remaining, alreadyBuilt } = await filterTargetsNeedingRebuild({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		targets,
		force: input.force,
	})
	const succeeded: Array<PublishedPackageArtifactBuildTarget> = [
		...alreadyBuilt,
	]
	if (remaining.length === 0) {
		return { rebuiltTargetCount: 0 }
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
		return { rebuiltTargetCount: remaining.length }
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
	const maxAttempts = publishedPackageArtifactRebuildRetryDelaysMs.length + 1
	let lastTransientError: unknown = null
	for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
		const attempt = attemptIndex + 1
		try {
			return await rebuildPublishedPackageArtifactsViaRepoSessionOnce(input)
		} catch (error) {
			if (!isTransientArtifactRebuildError(error)) {
				throw error
			}
			lastTransientError = error
			const willRetry =
				attemptIndex < publishedPackageArtifactRebuildRetryDelaysMs.length
			const nextDelayMs = willRetry
				? (publishedPackageArtifactRebuildRetryDelaysMs[attemptIndex] ?? 0)
				: 0
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
	throw new Error(
		`rebuildPublishedPackageArtifactsViaRepoSession could not recover after ${maxAttempts} transient platform error attempts: ${getErrorMessage(
			lastTransientError,
		)}`,
	)
}

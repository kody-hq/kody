import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { publishedPackageArtifactBuildKey } from '#worker/package-runtime/package-artifact-targets.ts'
import type { PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import type { EntitySourceRow } from './types.ts'
import {
	isolatedRunnerResourceLimitAdvice,
	publishOutsideCloudAdvice,
} from './isolated-runner-limit-message.ts'

/**
 * Heavy published-package artifact rebuilds run in fresh, throwaway
 * `REPO_SESSION` isolates instead of the long-lived publish session Durable
 * Object. One large package (for example morning-briefing) could otherwise
 * push the session isolate (workspace + git state + esbuild-wasm) over the
 * Durable Object memory limit and kill the publish (same class of failure as
 * kody-hq/kody#987 for check phases). Each rebuild chunk gets a brand-new
 * DO id, so:
 *
 * - rebuilds never stack their peak memory on top of the session isolate or
 *   each other (esbuild-wasm memory in particular never shrinks once grown),
 * - a package too large for even a single target surfaces as a failed rebuild
 *   with an actionable message instead of an opaque isolate reset, and
 * - the throwaway instances never touch their own Durable Object storage, so
 *   nothing persists for their random ids.
 *
 * Workspace source files are staged once in KV with a short TTL (collected by
 * the session DO) and fetched by each rebuild isolate; the RPC payloads stay
 * small. The orchestrator refreshes that TTL between isolate waves so large
 * packages cannot outlive the initial lease mid-fan-out.
 *
 * Targets are chunked per throwaway isolate (same pattern as check-phase
 * bundle validation) so a multi-export package does not pay one cold
 * esbuild-wasm boot per export. Chunk size stays small so one isolate does
 * not stack toward the memory limit that motivated kody-hq/kody#987;
 * isolate concurrency stays capped so publish cannot stampede DO capacity.
 */

export const isolatedArtifactRebuildStagingKeyPrefix =
	'repo-artifact-rebuild-staging:v1:'
const stagingTtlSeconds = 15 * 60
/**
 * Artifact targets rebuilt per throwaway isolate. Matches check-phase bundle
 * chunking: small enough to stay far from the isolate memory limit, large
 * enough to keep cold-boot fan-out modest for typical packages.
 */
export const isolatedArtifactRebuildChunkSize = 4
/**
 * Max throwaway isolates running rebuild chunks at once. Chunk size bounds
 * work *inside* one isolate; this bounds how many of those isolates a single
 * publish may start together.
 */
export const isolatedArtifactRebuildChunkConcurrency = 2

/**
 * Targets one throwaway isolate compares with the published commit. Each one
 * loads its whole current artifact, which is megabytes for an app bundle.
 */
export const isolatedArtifactReuseScanChunkSize = 16

export type IsolatedArtifactRebuildRequest = {
	stagingKey: string
	sourceId: string
	userId: OwnerId
	publishedCommit: string
	targets: Array<PublishedPackageArtifactBuildTarget>
	baseUrl?: string
	/**
	 * Rebuild even when a same-commit artifact already exists. Used when
	 * already_published rewrote a mismatched snapshot. Missing-snapshot
	 * finalize races do not force: live artifacts stay and skip if they
	 * already match this commit.
	 */
	force?: boolean
}

/**
 * One `packageCheck` chunk: build `targets` from staged files the way the
 * rebuild does, without a published commit and without saving anything.
 */
export type IsolatedArtifactBuildCheckRequest = {
	stagingKey: string
	userId: OwnerId
	baseUrl: string
	/** The saved package's id, when the checked package was published before. */
	rootPackageId?: string
	targets: Array<PublishedPackageArtifactBuildTarget>
}

/**
 * `packageCheck`'s unchanged-artifact scan: which of `targets` the publish
 * rebuild would copy from the current artifact instead of building. It loads
 * every current artifact, the published snapshot, and parses both trees, so
 * it runs in a throwaway isolate, never in the shared request isolate.
 */
export type IsolatedArtifactReuseScanRequest = {
	stagingKey: string
	userId: OwnerId
	source: Pick<EntitySourceRow, 'id' | 'manifest_path' | 'source_root'>
	targets: Array<PublishedPackageArtifactBuildTarget>
}

export type IsolatedArtifactReuseScanOutcome =
	| { ok: true; reusableIndexes: Array<number> }
	| { ok: false; message: string }

/**
 * Staged snapshots are user-owned content, so the staging key is namespaced
 * by `userId` and the consuming Durable Object verifies the key belongs to
 * the requesting user before reading it.
 */
export function isolatedArtifactRebuildStagingKeyForUser(userId: string) {
	return `${isolatedArtifactRebuildStagingKeyPrefix}${userId}:${crypto.randomUUID()}`
}

export function isolatedArtifactRebuildStagingKeyBelongsToUser(input: {
	stagingKey: string
	userId: string
}) {
	return input.stagingKey.startsWith(
		`${isolatedArtifactRebuildStagingKeyPrefix}${input.userId}:`,
	)
}

export type IsolatedArtifactRebuildTargetResult = {
	ok: boolean
	message: string
	/**
	 * True when the failure is a caller-fixable package mistake (for example
	 * undeclared bare imports). Orchestrators rehydrate as UserCodeError so
	 * Sentry drops the event after the DO serializes the error to a string.
	 */
	callerFailure?: boolean
	skipped?: boolean
	kvKey?: string | null
	target: PublishedPackageArtifactBuildTarget
}

export type IsolatedArtifactRebuildOutcome = {
	ok: boolean
	message: string
	results: Array<IsolatedArtifactRebuildTargetResult>
}

type IsolatedArtifactRebuildStub = {
	runIsolatedArtifactRebuild(
		input: IsolatedArtifactRebuildRequest,
	): Promise<IsolatedArtifactRebuildOutcome>
	runIsolatedArtifactBuildCheck(
		input: IsolatedArtifactBuildCheckRequest,
	): Promise<IsolatedArtifactRebuildOutcome>
	runIsolatedArtifactReuseScan(
		input: IsolatedArtifactReuseScanRequest,
	): Promise<IsolatedArtifactReuseScanOutcome>
}

export type IsolatedArtifactRebuildRunner = {
	/**
	 * Re-put the existing staging payload so its TTL resets. Call between
	 * rebuild chunks so multi-target publishes do not expire mid-fan-out.
	 */
	touch(stagingKey: string): Promise<void>
	run(
		request: IsolatedArtifactRebuildRequest,
	): Promise<IsolatedArtifactRebuildOutcome>
	/** Stage `sourceFiles` for {@link buildCheck}; returns the staging key. */
	stage(input: {
		userId: OwnerId
		sourceFiles: Record<string, string>
	}): Promise<string>
	buildCheck(
		request: IsolatedArtifactBuildCheckRequest,
	): Promise<IsolatedArtifactRebuildOutcome>
	/** The staged targets publish would copy instead of building. */
	reuseScan(
		request: IsolatedArtifactReuseScanRequest,
	): Promise<IsolatedArtifactReuseScanOutcome>
	discard(stagingKey: string): Promise<void>
}

function isDurableObjectResourceLimitResetError(error: unknown) {
	// Remap only memory/CPU limits to the "package too large" outcome.
	// Deploy resets ("code was updated") must propagate so publish can retry.
	return errorCauseChainIncludes(
		error,
		isDurableObjectIsolateResourceLimitResetMessage,
	)
}

function describeTarget(target: PublishedPackageArtifactBuildTarget) {
	return [
		`kind "${target.kind}"`,
		`artifact "${target.artifactName ?? '<default>'}"`,
		`entry "${target.entryPoint}"`,
		`bundle "${target.bundleKind}"`,
	].join(', ')
}

function describeTargets(
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>,
) {
	return targets.map((target) => `{ ${describeTarget(target)} }`).join(', ')
}

/**
 * Returns a runner when the env carries the bindings the offload needs;
 * callers fall back to per-target session rebuild otherwise (unit tests and
 * minimal envs).
 */
export function createIsolatedArtifactRebuildRunner(
	env: Env | undefined,
): IsolatedArtifactRebuildRunner | null {
	const namespace = (
		env as (Env & { REPO_SESSION?: DurableObjectNamespace }) | undefined
	)?.REPO_SESSION
	const stagingKv = (
		env as (Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace }) | undefined
	)?.BUNDLE_ARTIFACTS_KV
	if (!namespace || !stagingKv) return null
	function throwawayStub(userId: OwnerId) {
		// A fresh, user-namespaced id per call puts every heavy step in its own
		// isolate. The instance never touches its Durable Object storage, so
		// nothing persists for the random name.
		return namespace!.get(
			namespace!.idFromName(
				`isolated-artifact-rebuild-${userId}-${crypto.randomUUID()}`,
			),
		) as unknown as IsolatedArtifactRebuildStub
	}
	async function runInThrowawayIsolate(
		request: {
			userId: OwnerId
			targets: Array<PublishedPackageArtifactBuildTarget>
		},
		call: (
			stub: IsolatedArtifactRebuildStub,
		) => Promise<IsolatedArtifactRebuildOutcome>,
	): Promise<IsolatedArtifactRebuildOutcome> {
		const stub = throwawayStub(request.userId)
		try {
			return await call(stub)
		} catch (error) {
			if (isDurableObjectResourceLimitResetError(error)) {
				const message =
					`Artifact rebuild for ${describeTargets(request.targets)} ` +
					"exceeded the isolated rebuild runner's memory or CPU limits " +
					`even on its own. ${isolatedRunnerResourceLimitAdvice()} ${publishOutsideCloudAdvice()}`
				return {
					ok: false,
					message,
					results: request.targets.map((target) => ({
						ok: false,
						message,
						target,
					})),
				}
			}
			throw error
		}
	}
	return {
		async touch(stagingKey) {
			const payload = await stagingKv.get(stagingKey, 'text')
			if (payload == null) return
			await stagingKv.put(stagingKey, payload, {
				expirationTtl: stagingTtlSeconds,
			})
		},
		async run(request) {
			return await runInThrowawayIsolate(request, (stub) =>
				stub.runIsolatedArtifactRebuild(request),
			)
		},
		async stage(input) {
			const stagingKey = isolatedArtifactRebuildStagingKeyForUser(input.userId)
			await stagingKv.put(
				stagingKey,
				JSON.stringify({ sourceFiles: input.sourceFiles }),
				{ expirationTtl: stagingTtlSeconds },
			)
			return stagingKey
		},
		async buildCheck(request) {
			return await runInThrowawayIsolate(request, (stub) =>
				stub.runIsolatedArtifactBuildCheck(request),
			)
		},
		async reuseScan(request) {
			// Each isolate loads the current artifact of every target it scans,
			// so the artifacts are spread over isolates like the builds are.
			const chunks = chunkArray(
				request.targets.map((target, index) => ({ target, index })),
				isolatedArtifactReuseScanChunkSize,
			)
			const reusableIndexes: Array<number> = []
			try {
				for (const wave of chunkArray(
					chunks,
					isolatedArtifactRebuildChunkConcurrency,
				)) {
					const outcomes = await Promise.all(
						wave.map((chunk) =>
							throwawayStub(request.userId).runIsolatedArtifactReuseScan({
								...request,
								targets: chunk.map((entry) => entry.target),
							}),
						),
					)
					for (const [waveIndex, outcome] of outcomes.entries()) {
						if (!outcome.ok) return outcome
						const chunk = wave[waveIndex] ?? []
						for (const index of outcome.reusableIndexes) {
							const entry = chunk[index]
							if (entry) reusableIndexes.push(entry.index)
						}
					}
				}
			} catch (error) {
				if (isDurableObjectResourceLimitResetError(error)) {
					return {
						ok: false,
						message:
							`Comparing ${request.targets.length} runtime artifact(s) with ` +
							"the published commit exceeded the isolated runner's memory " +
							`or CPU limits. ${isolatedRunnerResourceLimitAdvice()} ${publishOutsideCloudAdvice()}`,
					}
				}
				throw error
			}
			return { ok: true, reusableIndexes }
		},
		async discard(stagingKey) {
			try {
				await stagingKv.delete(stagingKey)
			} catch {
				// Best effort: the staging entry expires via its TTL anyway.
			}
		},
	}
}

/**
 * Per-isolate chunks of up to `isolatedArtifactRebuildChunkSize` distinct
 * builds. Targets that build the same bundle share a chunk, so the isolate's
 * memoized builders build that bundle once instead of once per target.
 */
export function chunkArtifactTargetsPerIsolate(
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>,
) {
	const sameBuild = new Map<
		string,
		Array<PublishedPackageArtifactBuildTarget>
	>()
	for (const target of targets) {
		const key = publishedPackageArtifactBuildKey(target)
		const group = sameBuild.get(key)
		if (group) group.push(target)
		else sameBuild.set(key, [target])
	}
	return chunkArray(
		[...sameBuild.values()],
		isolatedArtifactRebuildChunkSize,
	).map((groups) => groups.flat())
}

/**
 * The rebuild fan-out: `isolatedArtifactRebuildChunkSize` distinct builds per
 * throwaway isolate, `isolatedArtifactRebuildChunkConcurrency` isolates per
 * wave, staging TTL refreshed between waves, and no new wave after a failed
 * one. Publish rebuilds and `packageCheck` both go through here, so a dev
 * check meets the same per-isolate batching as the publish rebuild.
 */
export async function runIsolatedArtifactRebuildWaves(input: {
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	runChunk(
		targets: Array<PublishedPackageArtifactBuildTarget>,
	): Promise<IsolatedArtifactRebuildOutcome>
	beforeNextWave(): Promise<void>
	/** Records one settled chunk; returns true when it failed. */
	recordChunk(
		targets: Array<PublishedPackageArtifactBuildTarget>,
		result: PromiseSettledResult<IsolatedArtifactRebuildOutcome>,
	): boolean
}) {
	const isolateChunks = chunkArtifactTargetsPerIsolate(input.targets)
	const waves = chunkArray(
		isolateChunks,
		isolatedArtifactRebuildChunkConcurrency,
	)
	let failed = false
	for (const [waveIndex, wave] of waves.entries()) {
		if (failed) break
		if (waveIndex > 0) await input.beforeNextWave()
		const settled = await Promise.allSettled(
			wave.map((targets) => input.runChunk(targets)),
		)
		for (const [index, result] of settled.entries()) {
			const targets = wave[index]
			if (!targets) continue
			if (input.recordChunk(targets, result)) failed = true
		}
	}
}

export { stagingTtlSeconds as isolatedArtifactRebuildStagingTtlSeconds }

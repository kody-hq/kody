import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { PublishedPackageArtifactBuildTarget } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import { isolatedRunnerResourceLimitAdvice } from './isolated-runner-limit-message.ts'

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
	return {
		async touch(stagingKey) {
			const payload = await stagingKv.get(stagingKey, 'text')
			if (payload == null) return
			await stagingKv.put(stagingKey, payload, {
				expirationTtl: stagingTtlSeconds,
			})
		},
		async run(request) {
			// A fresh, user-namespaced id per chunk puts every heavy rebuild
			// wave in its own isolate. The instance never touches its Durable
			// Object storage, so nothing persists for the random name.
			const stub = namespace.get(
				namespace.idFromName(
					`isolated-artifact-rebuild-${request.userId}-${crypto.randomUUID()}`,
				),
			) as unknown as IsolatedArtifactRebuildStub
			try {
				return await stub.runIsolatedArtifactRebuild(request)
			} catch (error) {
				if (isDurableObjectResourceLimitResetError(error)) {
					const message =
						`Artifact rebuild for ${describeTargets(request.targets)} ` +
						"exceeded the isolated rebuild runner's memory or CPU limits " +
						`even on its own. ${isolatedRunnerResourceLimitAdvice()}`
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

export { stagingTtlSeconds as isolatedArtifactRebuildStagingTtlSeconds }

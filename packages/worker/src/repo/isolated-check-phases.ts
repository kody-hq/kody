import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import type { PackageBundleTarget, PackageTypecheckTarget } from './checks.ts'
import type {
	CredentialTreeChunk,
	CredentialTreeChunkRequest,
	CredentialTreeScanPlan,
} from './credential-pattern-check.ts'
import {
	isRepoCheckStep,
	repoCheckStepLabel,
	repoCheckStepResourceLimitAdvice,
	isolatedCheckRunnerLimitMessage,
	authoringCheckRunnerLimitLead,
	resourceLimitVarianceNote,
	type RepoCheckStep,
} from './isolated-runner-limit-message.ts'
import {
	formatPublishSizeHints,
	type PublishSizeHints,
} from './publish-size-hints.ts'

/**
 * Heavy repo-check phases (esbuild-wasm bundle validation, TypeScript
 * language-service typecheck) run in fresh, throwaway `REPO_SESSION`
 * isolates instead of the session/publish Durable Object. One large package
 * could otherwise push the session isolate (workspace + git state + checks)
 * over the Durable Object memory limit and kill every publish attempt
 * (kody-hq/kody#987). Each phase invocation gets a brand-new DO id, so:
 *
 * - phases never stack their peak memory on top of the session isolate or
 *   each other (esbuild-wasm memory in particular never shrinks once grown),
 * - callers may overlap typecheck with bundle chunks (and overlap chunks with
 *   each other) without stacking DO heap — `runRepoChecks` does this,
 * - a package too large for even a single phase surfaces as a failed check
 *   with an actionable message instead of an opaque isolate reset, and
 * - the throwaway instances never touch their own Durable Object storage, so
 *   nothing persists for their random ids.
 *
 * The collected source files (bounded by the repo-check source caps) are
 * staged once in KV with a short TTL and fetched by each phase isolate;
 * the RPC payloads stay small.
 */

export const isolatedCheckStagingKeyPrefix = 'repo-checks-staging:v1:'
const stagingTtlSeconds = 15 * 60
/**
 * Bundle targets validated per throwaway isolate. Small enough that a chunk
 * stays far from the isolate memory limit, large enough to keep the isolate
 * fan-out modest for typical packages.
 */
export const isolatedBundleChunkSize = 4
/**
 * Max throwaway isolates running bundle chunks at once. Chunk size bounds
 * work *inside* one isolate; this bounds how many of those isolates a single
 * check request may start together.
 */
export const isolatedBundleChunkConcurrency = 2

/** Typecheck targets per throwaway isolate (see runChunkedTypecheck). */
export const isolatedTypecheckChunkSize = 20

export type IsolatedCheckPhaseRequest =
	| {
			phase: 'bundle-chunk'
			stagingKey: string
			baseUrl: string
			userId: string
			bundleTargets: Array<PackageBundleTarget>
	  }
	| {
			phase: 'typecheck'
			stagingKey: string
			userId: string
			typecheckTargets: Array<PackageTypecheckTarget>
	  }
	| {
			phase: 'credentials-plan'
			stagingKey: string
			userId: string
			/** Most syntax nodes the modules of one chunk hold. */
			maxChunkAstNodes: number
	  }
	| {
			phase: 'credentials-chunk'
			stagingKey: string
			userId: string
			chunk: CredentialTreeChunkRequest
	  }

/**
 * Staged snapshots are user-owned content, so the staging key is namespaced
 * by `userId` and the consuming Durable Object verifies the key belongs to
 * the requesting user before reading it.
 */
export function isolatedCheckStagingKeyForUser(userId: string) {
	return `${isolatedCheckStagingKeyPrefix}${userId}:${crypto.randomUUID()}`
}

export function isolatedCheckStagingKeyBelongsToUser(input: {
	stagingKey: string
	userId: string
}) {
	return input.stagingKey.startsWith(
		`${isolatedCheckStagingKeyPrefix}${input.userId}:`,
	)
}

export type IsolatedCheckPhaseOutcome = {
	ok: boolean
	message: string
	/** Staging expired or missing: a Kody failure, not an authored one. */
	failureOrigin?: 'platform'
	/** `credentials-plan` phase only. */
	credentialPlan?: CredentialTreeScanPlan
	/** `credentials-chunk` phase only. */
	credentialChunk?: CredentialTreeChunk
}

type IsolatedCheckPhaseStub = {
	runIsolatedCheckPhase(
		input: IsolatedCheckPhaseRequest,
	): Promise<IsolatedCheckPhaseOutcome>
}

export type IsolatedCheckPhaseRunner = {
	stage(input: {
		userId: string
		sourceFiles: Record<string, string>
	}): Promise<string>
	run(request: IsolatedCheckPhaseRequest): Promise<IsolatedCheckPhaseOutcome>
	discard(stagingKey: string): Promise<void>
}

function isDurableObjectResourceLimitResetError(error: unknown) {
	// Remap only memory/CPU limits. Deploy resets must keep propagating.
	return errorCauseChainIncludes(
		error,
		isDurableObjectIsolateResourceLimitResetMessage,
	)
}

function phaseStep(request: IsolatedCheckPhaseRequest): RepoCheckStep {
	switch (request.phase) {
		case 'bundle-chunk':
			return 'bundle'
		case 'typecheck':
			return 'typecheck'
		case 'credentials-plan':
		case 'credentials-chunk':
			return 'credentials'
		default: {
			const exhaustive: never = request
			throw new Error(`Unexpected check phase: ${JSON.stringify(exhaustive)}`)
		}
	}
}

function phaseLabel(request: IsolatedCheckPhaseRequest) {
	switch (request.phase) {
		case 'bundle-chunk':
			return `Bundle validation for ${request.bundleTargets
				.map((target) => `"${target.path}"`)
				.join(', ')}`
		case 'typecheck':
			return 'The TypeScript typecheck'
		case 'credentials-plan':
			return 'Planning the credential stamp scan'
		case 'credentials-chunk':
			return `The credential stamp scan of ${request.chunk.visit.length} module(s) starting at "${request.chunk.visit[0]?.path ?? ''}"`
		default: {
			const exhaustive: never = request
			throw new Error(`Unexpected check phase: ${JSON.stringify(exhaustive)}`)
		}
	}
}

/**
 * Returns a runner when the env carries the bindings the offload needs;
 * callers fall back to inline phase execution otherwise (unit tests and
 * minimal envs).
 */
export function createIsolatedCheckPhaseRunner(
	env: Env | undefined,
): IsolatedCheckPhaseRunner | null {
	const namespace = (
		env as (Env & { REPO_SESSION?: DurableObjectNamespace }) | undefined
	)?.REPO_SESSION
	const stagingKv = (
		env as (Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace }) | undefined
	)?.BUNDLE_ARTIFACTS_KV
	if (!namespace || !stagingKv) return null
	return {
		async stage(input) {
			const stagingKey = isolatedCheckStagingKeyForUser(input.userId)
			await stagingKv.put(
				stagingKey,
				JSON.stringify({ sourceFiles: input.sourceFiles }),
				{
					expirationTtl: stagingTtlSeconds,
				},
			)
			return stagingKey
		},
		async run(request) {
			// A fresh, user-namespaced id per phase invocation puts every heavy
			// phase in its own isolate. The instance never touches its Durable
			// Object storage, so nothing persists for the random name.
			const stub = namespace.get(
				namespace.idFromName(
					`isolated-check-phase-${request.userId}-${crypto.randomUUID()}`,
				),
			) as unknown as IsolatedCheckPhaseStub
			try {
				return await stub.runIsolatedCheckPhase(request)
			} catch (error) {
				if (isDurableObjectResourceLimitResetError(error)) {
					return {
						ok: false,
						message: `${isolatedCheckRunnerLimitMessage(phaseLabel(request))} ${repoCheckStepResourceLimitAdvice(phaseStep(request))}`,
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

/**
 * Message for a `packageCheck` run whose throwaway isolate hit a memory or
 * CPU reset. Names the limit so callers never see a generic outage.
 */
export function authoringChecksResourceLimitMessage(
	step: RepoCheckStep | null = null,
	sizeHints: PublishSizeHints | null = null,
) {
	const where = step ? ` during ${repoCheckStepLabel(step)}` : ''
	return [
		`${authoringCheckRunnerLimitLead(where)} This is a server limit, not a ` +
			'login or network problem, and publish runs the same checks under ' +
			'the same limits, so a run near the limit can fail there too. ' +
			resourceLimitVarianceNote,
		repoCheckStepResourceLimitAdvice(step),
		formatPublishSizeHints(sizeHints, step),
	]
		.filter(Boolean)
		.join(' ')
}

/**
 * Best effort: an instance on an older deploy may not have the method, and
 * the step only sharpens the message.
 */
export async function readLastCheckStep(stub: {
	takeLastCheckStep?: () => Promise<unknown>
}): Promise<RepoCheckStep | null> {
	try {
		const recorded = await stub.takeLastCheckStep?.()
		return isRepoCheckStep(recorded) ? recorded : null
	} catch {
		return null
	}
}

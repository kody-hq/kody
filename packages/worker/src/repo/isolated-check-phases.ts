import { errorCauseChainIncludes } from '@kody-internal/shared/error-message.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { isDurableObjectIsolateResourceLimitResetMessage } from '#worker/sentry-options.ts'
import {
	type PackageBundleTarget,
	type PackageTypecheckTarget,
	type RepoCheckKind,
	type RepoCheckResult,
} from './checks.ts'
import { type ResolvedSecretProviderSlots } from '#worker/credentials/secret-provider-slots.ts'
import {
	isRepoCheckStep,
	repoCheckStepLabel,
	repoCheckStepResourceLimitAdvice,
	type RepoCheckStep,
} from './isolated-runner-limit-message.ts'

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
			phase: 'credentials'
			stagingKey: string
			userId: string
			secretProviders?: ResolvedSecretProviderSlots
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
	/** `credentials` phase only: staged files the stamp merge rewrote. */
	changedFiles?: Record<string, string>
	/** `credentials` phase only. */
	stampKeys?: Array<string>
}

type IsolatedCheckPhaseStub = {
	runIsolatedCheckPhase(
		input: IsolatedCheckPhaseRequest,
	): Promise<IsolatedCheckPhaseOutcome>
}

/**
 * The whole authoring publish check run (`runAuthoringPublishChecksOnFiles`)
 * for a staged in-memory tree, as `packageCheck` (`kody dev check`) asks.
 */
export type IsolatedAuthoringChecksRequest = {
	stagingKey: string
	userId: OwnerId
	baseUrl: string
	sourceId?: string
	expectedPackageScope?: string
}

export type IsolatedAuthoringChecksOutcome = {
	ok: boolean
	results: Array<RepoCheckResult>
}

type IsolatedAuthoringChecksStub = {
	runIsolatedAuthoringChecks(
		input: IsolatedAuthoringChecksRequest,
	): Promise<IsolatedAuthoringChecksOutcome>
	takeLastCheckStep(): Promise<RepoCheckStep | null>
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
		case 'credentials':
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
		case 'credentials':
			return 'The credential stamp scan'
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
						message:
							`${phaseLabel(request)} exceeded the isolated check runner's ` +
							`memory or CPU limits even on its own. ${repoCheckStepResourceLimitAdvice(phaseStep(request))}`,
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
) {
	const where = step ? ` during ${repoCheckStepLabel(step)}` : ''
	return (
		`The publish checks ran out of memory or CPU time in the check runner${where} ` +
		'before they finished. This is a server limit, not a login or network ' +
		'problem, and publish runs the same checks under the same limits, so ' +
		'it would fail the same way. ' +
		repoCheckStepResourceLimitAdvice(step)
	)
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

function repoCheckKindForStep(step: RepoCheckStep | null): RepoCheckKind {
	switch (step) {
		case 'credentials':
			return 'credentials'
		case 'lint':
			return 'lint'
		case 'typecheck':
			return 'typecheck'
		default:
			return 'bundle'
	}
}

/**
 * Run the full authoring publish checks for an in-memory tree in a fresh,
 * throwaway `REPO_SESSION` isolate, the same kind of Durable Object isolate
 * publish runs its checks in. `packageCheck` used to run them inline in the
 * shared origin request isolate, where a large tree (every module parsed for
 * the credential stamp, lint, and the bundler snapshot) could push that
 * isolate over its memory limit. That reset killed the request and the API
 * edge could only answer 503 "temporarily unavailable".
 *
 * Returns null when the env lacks the bindings (unit tests, minimal envs);
 * callers then run the checks inline.
 */
export async function runAuthoringChecksInIsolate(input: {
	env: Env | undefined
	userId: OwnerId
	baseUrl: string
	files: Record<string, string>
	binaryFileSizes?: Record<string, number>
	sourceId?: string
	expectedPackageScope?: string
}): Promise<IsolatedAuthoringChecksOutcome | null> {
	const namespace = (
		input.env as (Env & { REPO_SESSION?: DurableObjectNamespace }) | undefined
	)?.REPO_SESSION
	const stagingKv = (
		input.env as (Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace }) | undefined
	)?.BUNDLE_ARTIFACTS_KV
	if (!namespace || !stagingKv) return null
	const stagingKey = isolatedCheckStagingKeyForUser(input.userId)
	await stagingKv.put(
		stagingKey,
		JSON.stringify({
			sourceFiles: input.files,
			...(input.binaryFileSizes
				? { binaryFileSizes: input.binaryFileSizes }
				: {}),
		}),
		{ expirationTtl: stagingTtlSeconds },
	)
	try {
		const stub = namespace.get(
			namespace.idFromName(
				`isolated-authoring-checks-${input.userId}-${crypto.randomUUID()}`,
			),
		) as unknown as IsolatedAuthoringChecksStub
		try {
			return await stub.runIsolatedAuthoringChecks({
				stagingKey,
				userId: input.userId,
				baseUrl: input.baseUrl,
				...(input.sourceId ? { sourceId: input.sourceId } : {}),
				...(input.expectedPackageScope !== undefined
					? { expectedPackageScope: input.expectedPackageScope }
					: {}),
			})
		} catch (error) {
			if (isDurableObjectResourceLimitResetError(error)) {
				// The step marker lives in the reset instance's storage; the
				// next call reaches a fresh isolate for the same id.
				const step = await readLastCheckStep(stub)
				return {
					ok: false,
					results: [
						{
							kind: repoCheckKindForStep(step),
							ok: false,
							message: authoringChecksResourceLimitMessage(step),
						},
					],
				}
			}
			throw error
		}
	} finally {
		try {
			await stagingKv.delete(stagingKey)
		} catch {
			// Best effort: the staging entry expires via its TTL anyway.
		}
	}
}

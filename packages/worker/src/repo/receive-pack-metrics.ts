/**
 * Per-push cost and outcome signals for plain-repo `git-receive-pack`.
 *
 * Every push through the smart-HTTP proxy records one observe-only `git_push`
 * usage event for the repo owner (Analytics Engine in production/preview, the
 * D1 rollup in local dev), plus a `repo-push-queue` exposure for that owner
 * when the flag was evaluated. Queued pushes report the Durable Object's own
 * numbers (wall time, wait, depth on arrival, attempts) from response headers;
 * direct pushes report the isolate-local wait-and-retry proxy's equivalents.
 * Nothing here touches D1 in production and nothing here throws.
 */

import {
	repoPushQueueAttemptsHeader,
	repoPushQueueDepthHeader,
	repoPushQueueOutcomeHeader,
	repoPushQueuePositionHeader,
	repoPushQueueWaitMsHeader,
	repoPushQueueWallMsHeader,
} from '@kody-internal/shared/repo-push-queue-protocol.ts'
import { recordRepoPushOwnersFlagExposure } from '#worker/feature-flags/repo-push-owners-exposure.ts'
import { type FeatureFlagEvaluation } from '#worker/feature-flags/service.ts'
import { recordUsage, type UsageEnv } from '#worker/usage/record-usage.ts'
import { type FeatureFlagExposureEnv } from '#worker/feature-flags/exposure.ts'

/** `git_push` entity id: which receive-pack path served the push. */
export type ReceivePackPath = 'queued' | 'direct'

/**
 * `ok`: 2xx (git's own ref rejections included). `busy`: 503 + Retry-After
 * because the repo was busy (queue full, or the direct proxy's wait ran out).
 * `timeout`: the queue's 90s budget expired. `error`: anything else.
 */
export type ReceivePackOutcomeKind = 'ok' | 'busy' | 'timeout' | 'error'

export type ReceivePackOutcome = {
	kind: ReceivePackOutcomeKind
	/** Closed `git_push` error name (AE blob13); null on ok. */
	errorName: string | null
}

/** Direct-path counters filled in by the wait-and-retry proxy. */
export type DirectReceivePackStats = {
	attempts: number
	/** When this push got the isolate-local gate (before its body is read). */
	gateAcquiredAt: number | null
	firstSendAt: number | null
}

export function createDirectReceivePackStats(): DirectReceivePackStats {
	return { attempts: 0, gateAcquiredAt: null, firstSendAt: null }
}

export function classifyReceivePackResponse(
	response: Response | null,
	path: ReceivePackPath,
): ReceivePackOutcome {
	if (!response) return { kind: 'error', errorName: 'proxy_error' }
	const { status } = response
	if (status >= 200 && status < 300) return { kind: 'ok', errorName: null }
	if (status === 503) {
		if (path === 'queued') {
			const outcome = response.headers.get(repoPushQueueOutcomeHeader)
			if (outcome === 'timeout')
				return { kind: 'timeout', errorName: 'timeout' }
			if (outcome === 'full') return { kind: 'busy', errorName: 'busy' }
			if (outcome === 'unavailable') {
				return { kind: 'error', errorName: 'queue_unavailable' }
			}
		} else if (response.headers.has('Retry-After')) {
			return { kind: 'busy', errorName: 'busy' }
		}
	}
	if (status === 413) return { kind: 'error', errorName: 'too_large' }
	if (status === 408) return { kind: 'error', errorName: 'body_timeout' }
	return {
		kind: 'error',
		errorName: `upstream_${Math.floor(status / 100)}xx`,
	}
}

function headerNumber(headers: Headers | undefined, name: string) {
	const raw = headers?.get(name)
	if (raw === null || raw === undefined || raw.trim() === '') return null
	const value = Number(raw)
	return Number.isFinite(value) && value >= 0 ? value : null
}

export type ReceivePackMetrics = {
	path: ReceivePackPath
	outcome: ReceivePackOutcome
	/** Queued: Durable Object wall time. Direct: proxy wall time. */
	durationMs: number
	waitMs: number
	queueDepth: number
	attempts: number
}

export function measureReceivePack(input: {
	path: ReceivePackPath
	response: Response | null
	startedAt: number
	endedAt: number
	direct: DirectReceivePackStats
}): ReceivePackMetrics {
	const elapsedMs = Math.max(0, input.endedAt - input.startedAt)
	const outcome = classifyReceivePackResponse(input.response, input.path)
	if (input.path === 'queued') {
		const headers = input.response?.headers
		return {
			path: input.path,
			outcome,
			durationMs: headerNumber(headers, repoPushQueueWallMsHeader) ?? elapsedMs,
			waitMs: headerNumber(headers, repoPushQueueWaitMsHeader) ?? 0,
			queueDepth:
				headerNumber(headers, repoPushQueueDepthHeader) ??
				headerNumber(headers, repoPushQueuePositionHeader) ??
				0,
			attempts: headerNumber(headers, repoPushQueueAttemptsHeader) ?? 0,
		}
	}
	return {
		path: input.path,
		outcome,
		durationMs: elapsedMs,
		waitMs: directWaitMs(input.direct, outcome, input.startedAt, elapsedMs),
		queueDepth: 0,
		attempts: input.direct.attempts,
	}
}

/**
 * Time before the first Artifacts send. Without a send, the gate wait still
 * counts (a body rejected with 408/413 after its turn); a gate timeout spent
 * the whole request waiting.
 */
function directWaitMs(
	direct: DirectReceivePackStats,
	outcome: ReceivePackOutcome,
	startedAt: number,
	elapsedMs: number,
) {
	const waitedUntil = direct.firstSendAt ?? direct.gateAcquiredAt
	if (waitedUntil !== null) return Math.max(0, waitedUntil - startedAt)
	return outcome.kind === 'busy' ? elapsedMs : 0
}

export async function recordReceivePackMetrics(input: {
	env: UsageEnv & FeatureFlagExposureEnv
	ownerId: string
	metrics: ReceivePackMetrics
	/** Present when the flag was evaluated (the queue binding exists). */
	evaluation: FeatureFlagEvaluation | null
}): Promise<void> {
	const { metrics } = input
	await Promise.all([
		recordUsage(input.env, {
			userId: input.ownerId,
			eventType: 'git_push',
			entityId: metrics.path,
			durationMs: metrics.durationMs,
			outcome: metrics.outcome.kind === 'ok' ? 'success' : 'error',
			errorName: metrics.outcome.errorName,
			waitMs: metrics.waitMs,
			queueDepth: metrics.queueDepth,
			attempts: metrics.attempts,
		}),
		input.evaluation
			? recordRepoPushOwnersFlagExposure({
					env: input.env,
					ownerId: input.ownerId,
					evaluation: input.evaluation,
				})
			: undefined,
	])
}

/**
 * Per-evaluate host counters for Durable Object reset retry.
 *
 * LOADER requires a real Fetcher for `globalOutbound`, so we cannot wrap
 * outbound fetch on the host. Fetch attempts are recorded through this
 * evaluate's RPC dispatcher *before* the sandbox calls native fetch.
 * Dispatcher attempts increment before `await` so a reset mid-call still
 * counts.
 */

import * as Sentry from '@sentry/cloudflare'

export const hostSideEffectProviderName = '__kodyHostSideEffects'

export const staticCallMeterRuntimeBridgeProviderName =
	'__kodyStaticCallMeterRuntimeBridge'

const platformOnlyHostSideEffectProviderNames = new Set([
	hostSideEffectProviderName,
	staticCallMeterRuntimeBridgeProviderName,
])

export type EvaluationHostSideEffects = {
	dispatcherAttempts: number
	fetchAttempts: number
}

export type EvaluationSideEffectTracker = {
	recordDispatcherAttempt: () => void
	recordFetchAttempt: () => void
	snapshot: () => EvaluationHostSideEffects
}

export function isPlatformOnlyHostSideEffectProvider(providerName: string) {
	return platformOnlyHostSideEffectProviderNames.has(providerName)
}

export function createEvaluationSideEffectTracker(): EvaluationSideEffectTracker {
	let dispatcherAttempts = 0
	let fetchAttempts = 0
	return {
		recordDispatcherAttempt() {
			dispatcherAttempts += 1
		},
		recordFetchAttempt() {
			fetchAttempts += 1
		},
		snapshot() {
			return { dispatcherAttempts, fetchAttempts }
		},
	}
}

export function createHostSideEffectProvider(
	sideEffects: EvaluationSideEffectTracker,
) {
	return {
		name: hostSideEffectProviderName,
		fns: {
			recordFetch: async () => {
				sideEffects.recordFetchAttempt()
			},
		},
	}
}

/** Sandbox-side count of `recordFetch` calls that failed (fetch went ahead). */
export type SandboxFetchRecordFailures = {
	count: number
	message: string | null
}

let reportedSandboxFetchRecordFailure = false

const globalScopeDisallowedPattern =
	/^Disallowed operation called within global scope\b/

/**
 * The sandbox never fails a fetch because its attempt could not be recorded.
 * Count the fetch here instead so the run still reads as having side
 * effects, and report the first failure per isolate.
 */
export function noteSandboxFetchRecordFailures(
	failures: SandboxFetchRecordFailures | null | undefined,
	sideEffects: EvaluationSideEffectTracker,
) {
	const count = typeof failures?.count === 'number' ? failures.count : 0
	if (count <= 0) return
	for (let index = 0; index < count; index += 1) {
		sideEffects.recordFetchAttempt()
	}
	if (reportedSandboxFetchRecordFailure) return
	const message =
		typeof failures?.message === 'string'
			? failures.message.slice(0, 200)
			: 'unknown'
	// Package code fetching at module top level: the runtime rejects the
	// fetch itself too, so the caller already sees it (KODY-CZ).
	if (globalScopeDisallowedPattern.test(message)) return
	reportedSandboxFetchRecordFailure = true
	Sentry.withScope((scope) => {
		scope.setTag('executor.fetch_record_failure', 'true')
		scope.setContext('executor_fetch_record_failure', { count, message })
		Sentry.captureMessage(
			`Executor fetch-attempt recording failed: ${message}`,
			'warning',
		)
	})
}

/**
 * Missing snapshot is treated as dirty: a thrown evaluate that never
 * attached host counters is "unknown side effects," not a clean retry.
 */
export function evaluationHasHostMediatedSideEffects(
	sideEffects: EvaluationHostSideEffects | null | undefined,
) {
	if (sideEffects == null) return true
	return sideEffects.dispatcherAttempts > 0 || sideEffects.fetchAttempts > 0
}

/**
 * Confirms a derived handle suggestion is free before the UI offers it. The
 * check is the same one live username fields use (reserved names, taken
 * usernames, org handles). When the suggestion itself is taken, the first
 * verified-available variant the server returns (`-2`, `-3`, ...) wins; when
 * nothing can be confirmed, no suggestion is offered.
 */

import { isCanonicalHandle } from '@kody-internal/shared/handle-rules.ts'

export type PickedSuggestion = { suggestion: string | null; verified: boolean }

function readRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: null
}

/**
 * Map one availability response for `candidate` to a suggestion that is known
 * to be free. `verified` is false when the check failed (rate limit, network),
 * so callers do not cache the empty result.
 */
export function pickAvailableHandleSuggestion(
	candidate: string,
	response: unknown,
): PickedSuggestion {
	const result = readRecord(response)
	if (!result || result.ok !== true) {
		return { suggestion: null, verified: false }
	}
	if (result.status === 'available') {
		const username =
			typeof result.username === 'string' ? result.username : candidate
		return {
			suggestion: username === candidate ? candidate : null,
			verified: true,
		}
	}
	if (
		result.status === 'taken' ||
		result.status === 'reserved' ||
		result.status === 'invalid'
	) {
		const alternatives = Array.isArray(result.suggestions)
			? result.suggestions
			: []
		const first = alternatives.find(
			(value): value is string =>
				typeof value === 'string' &&
				value !== candidate &&
				isCanonicalHandle(value),
		)
		return { suggestion: first ?? null, verified: true }
	}
	return { suggestion: null, verified: false }
}

export const verifiedHandleSuggestionDebounceMs = 300
export const verifiedHandleSuggestionCacheMs = 30_000

/** Resolves after `ms`, or rejects with the abort reason once `signal` aborts. */
export function waitForDebounce(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		const timer = setTimeout(resolve, ms)
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer)
				reject(signal.reason)
			},
			{ once: true },
		)
	})
}

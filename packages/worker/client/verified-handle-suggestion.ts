/**
 * Confirms a derived handle suggestion is free before the UI offers it. The
 * check is the same one live username fields use (reserved names, taken
 * usernames, org handles). When the suggestion itself is taken, the first
 * verified-available variant the server returns (`-2`, `-3`, ...) wins; when
 * nothing can be confirmed, no suggestion is offered.
 */

import { isCanonicalHandle } from '@kody-internal/shared/handle-rules.ts'

export type VerifiedHandleSuggestionState =
	| { status: 'idle'; candidate: null; suggestion: null }
	| { status: 'checking'; candidate: string; suggestion: null }
	| { status: 'ready'; candidate: string; suggestion: string | null }

export type HandleAvailabilityCheck = (
	candidate: string,
	signal: AbortSignal,
) => Promise<unknown>

type PickedSuggestion = { suggestion: string | null; verified: boolean }

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

const verifiedHandleSuggestionDebounceMs = 300
const cacheTtlMs = 30_000

/**
 * Debounced, race-safe suggestion checks. Every `request` supersedes the one
 * before it: pending timers are cleared, in-flight checks are aborted, and a
 * late response for an older candidate is dropped.
 */
export function createVerifiedHandleSuggestions(options: {
	onChange: (state: VerifiedHandleSuggestionState) => void
	debounceMs?: number
	now?: () => number
}) {
	const debounceMs = options.debounceMs ?? verifiedHandleSuggestionDebounceMs
	const now = options.now ?? Date.now
	const cache = new Map<string, { suggestion: string | null; at: number }>()
	let generation = 0
	let timer: ReturnType<typeof setTimeout> | null = null
	let inFlight: AbortController | null = null

	function cancel() {
		generation += 1
		if (timer) clearTimeout(timer)
		timer = null
		inFlight?.abort()
		inFlight = null
	}

	function request(candidate: string | null, check: HandleAvailabilityCheck) {
		cancel()
		if (!candidate) {
			options.onChange({ status: 'idle', candidate: null, suggestion: null })
			return
		}
		const cached = cache.get(candidate)
		if (cached && now() - cached.at < cacheTtlMs) {
			options.onChange({
				status: 'ready',
				candidate,
				suggestion: cached.suggestion,
			})
			return
		}
		options.onChange({ status: 'checking', candidate, suggestion: null })
		const current = generation
		timer = setTimeout(() => {
			timer = null
			const controller = new AbortController()
			inFlight = controller
			void (async () => {
				let picked: PickedSuggestion
				try {
					picked = pickAvailableHandleSuggestion(
						candidate,
						await check(candidate, controller.signal),
					)
				} catch {
					picked = { suggestion: null, verified: false }
				}
				if (current !== generation || controller.signal.aborted) return
				inFlight = null
				if (picked.verified) {
					cache.set(candidate, { suggestion: picked.suggestion, at: now() })
				}
				options.onChange({
					status: 'ready',
					candidate,
					suggestion: picked.suggestion,
				})
			})()
		}, debounceMs)
	}

	return { request, cancel }
}

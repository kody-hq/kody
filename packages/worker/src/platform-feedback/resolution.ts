import {
	platformFeedbackResolutionHistoryMaxEntries,
	platformFeedbackResolutionNoteMaxLength,
	platformFeedbackResolutionPrUrlMaxCount,
	platformFeedbackResolutionPrUrlMaxLength,
	platformFeedbackResolutionPrUrlsJsonMaxLength,
} from './limits.ts'
import { type PlatformFeedbackResolutionHistoryEntry } from './types.ts'

/**
 * Normalize an optional submitter-visible resolution note (same text as the
 * close-the-loop email `user_message`). Empty/whitespace becomes null.
 */
export function normalizePlatformFeedbackResolutionNote(
	value: string | undefined,
): string | null | undefined {
	if (value === undefined) return undefined
	const normalized = value.trim()
	if (normalized.length > platformFeedbackResolutionNoteMaxLength) {
		throw new Error(
			`resolution_note must contain at most ${platformFeedbackResolutionNoteMaxLength} characters.`,
		)
	}
	return normalized.length > 0 ? normalized : null
}

/**
 * Validate and normalize optional https PR URLs for a feedback outcome.
 * Returns undefined when the caller omitted the field, null when cleared or
 * empty after trim, otherwise a de-duplicated list preserving first-seen order.
 */
export function normalizePlatformFeedbackResolutionPrUrls(
	value: Array<string> | undefined,
): Array<string> | null | undefined {
	if (value === undefined) return undefined
	if (value.length > platformFeedbackResolutionPrUrlMaxCount) {
		throw new Error(
			`pr_urls must contain at most ${platformFeedbackResolutionPrUrlMaxCount} URLs.`,
		)
	}
	const normalized: Array<string> = []
	const seen = new Set<string>()
	for (const raw of value) {
		const trimmed = raw.trim()
		if (trimmed.length < 1) {
			throw new Error('pr_urls entries must not be empty.')
		}
		if (trimmed.length > platformFeedbackResolutionPrUrlMaxLength) {
			throw new Error(
				`Each pr_urls entry must be at most ${platformFeedbackResolutionPrUrlMaxLength} characters.`,
			)
		}
		let parsed: URL
		try {
			parsed = new URL(trimmed)
		} catch {
			throw new Error(`pr_urls entry is not a valid URL: ${trimmed}`)
		}
		if (parsed.protocol !== 'https:') {
			throw new Error(
				`pr_urls must use https only (got ${parsed.protocol || 'unknown protocol'}).`,
			)
		}
		const canonical = parsed.toString()
		if (seen.has(canonical)) continue
		seen.add(canonical)
		normalized.push(canonical)
	}
	return normalized.length > 0 ? normalized : null
}

/** Serialize PR URLs for D1 storage, or null when absent/empty. */
export function serializePlatformFeedbackResolutionPrUrls(
	urls: Array<string> | null,
): string | null {
	if (urls === null || urls.length === 0) return null
	const serialized = JSON.stringify(urls)
	if (serialized.length > platformFeedbackResolutionPrUrlsJsonMaxLength) {
		throw new Error(
			`resolution_pr_urls JSON must be at most ${platformFeedbackResolutionPrUrlsJsonMaxLength} characters.`,
		)
	}
	return serialized
}

/** Parse stored JSON PR URLs; corrupt or non-array values become []. */
export function parsePlatformFeedbackResolutionPrUrls(
	value: unknown,
): Array<string> {
	if (value == null) return []
	if (typeof value !== 'string' || value.length < 1) return []
	try {
		const parsed: unknown = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return parsed.filter(
			(entry): entry is string =>
				typeof entry === 'string' && entry.trim().length > 0,
		)
	} catch {
		return []
	}
}

/** Serialize resolution history (newest kept when over the cap), or null when empty. */
export function serializePlatformFeedbackResolutionHistory(
	entries: ReadonlyArray<PlatformFeedbackResolutionHistoryEntry>,
): string | null {
	const kept = entries.slice(-platformFeedbackResolutionHistoryMaxEntries)
	if (kept.length === 0) return null
	return JSON.stringify(
		kept.map((entry) => ({
			note: entry.note,
			pr_urls: entry.prUrls,
			recorded_at: entry.recordedAt,
		})),
	)
}

/** Parse stored resolution history; corrupt values become []. */
export function parsePlatformFeedbackResolutionHistory(
	value: unknown,
): Array<PlatformFeedbackResolutionHistoryEntry> {
	if (typeof value !== 'string' || value.length < 1) return []
	try {
		const parsed: unknown = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return parsed.flatMap((entry) => {
			if (!entry || typeof entry !== 'object') return []
			const record = entry as Record<string, unknown>
			const recordedAt =
				typeof record['recorded_at'] === 'string' ? record['recorded_at'] : ''
			if (!recordedAt) return []
			return [
				{
					note: typeof record['note'] === 'string' ? record['note'] : null,
					prUrls: Array.isArray(record['pr_urls'])
						? record['pr_urls'].filter(
								(url): url is string => typeof url === 'string',
							)
						: [],
					recordedAt,
				},
			]
		})
	} catch {
		return []
	}
}

/**
 * Stable id for one stored follow-up outcome, used as its email claim
 * version. Derived from the written note, PR URLs, and history so retries
 * and internal admin-note edits reuse it while each new follow-up differs.
 */
export async function platformFeedbackFollowUpVersion(input: {
	note: string
	prUrls: ReadonlyArray<string>
	history: ReadonlyArray<PlatformFeedbackResolutionHistoryEntry>
}): Promise<string> {
	const bytes = new TextEncoder().encode(
		JSON.stringify([
			input.note,
			input.prUrls,
			serializePlatformFeedbackResolutionHistory(input.history),
		]),
	)
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
	return Array.from(digest.slice(0, 12), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

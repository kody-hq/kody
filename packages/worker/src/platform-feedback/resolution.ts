import {
	platformFeedbackResolutionNoteMaxLength,
	platformFeedbackResolutionPrUrlMaxCount,
	platformFeedbackResolutionPrUrlMaxLength,
	platformFeedbackResolutionPrUrlsJsonMaxLength,
} from './limits.ts'

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

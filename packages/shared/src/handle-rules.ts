/**
 * Permanent handle rules (usernames and organization slugs). One source of
 * truth for format checks, HTML progressive-enhancement hints, and the
 * client-side copy that explains what is wrong and suggests a valid handle.
 *
 * The DNS-safe pattern lives in {@link dnsSafeUsernamePattern} because every
 * handle is also a subdomain label; this module owns diagnosis and messaging.
 */

import {
	dnsSafeUsernamePattern,
	dnsSafeUsernamePatternSource,
} from './public-urls.ts'

export const handleMinLength = 3
export const handleMaxLength = 32

/** Short format hint for `title` / helper text under handle fields. */
export const handleFormatHint =
	'Use 3 to 32 letters (a–z), numbers, and single hyphens. Start and end with a letter or number.'

/**
 * HTML `pattern` value (no anchors). Forms that set `noValidate` keep this as
 * a progressive-enhancement hint only — JS owns blocking validation.
 */
export const handleHtmlPattern = dnsSafeUsernamePatternSource

/** Case-insensitive HTML pattern for fields that lowercase on submit. */
export const handleHtmlPatternCaseInsensitive =
	'(?![A-Za-z0-9\\-]*--)[A-Za-z0-9][A-Za-z0-9\\-]{1,30}[A-Za-z0-9]'

export type HandleFormatIssue =
	| 'required'
	| 'spaces'
	| 'diacritics'
	| 'underscores'
	| 'dots'
	| 'other-characters'
	| 'too-short'
	| 'too-long'
	| 'leading-hyphen'
	| 'trailing-hyphen'
	| 'consecutive-hyphens'

export type HandleFormatLabel = 'Username' | 'Handle'

export function normalizeHandle(value: unknown) {
	return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * True when the value is a valid handle after trim + lowercase. Use on the
 * client where the person may still be typing mixed case.
 */
export function isValidHandle(value: string) {
	return dnsSafeUsernamePattern.test(normalizeHandle(value))
}

/**
 * True when the value is already in canonical form (lowercase DNS label).
 * Server paths that receive a pre-normalized username must use this — do not
 * accept uppercase here or callers skip their own canonicalize step.
 */
export function isCanonicalHandle(value: string) {
	return typeof value === 'string' && dnsSafeUsernamePattern.test(value)
}

/**
 * Derive a valid handle suggestion from free-form input (names with spaces or
 * diacritics, underscores, dots). Returns null when nothing usable remains.
 * Never auto-applies — the person must see and accept the permanent value.
 */
export function suggestHandle(raw: string): string | null {
	const slug = raw
		.trim()
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, handleMaxLength)
		.replace(/-+$/g, '')
	if (slug.length < handleMinLength) return null
	if (!dnsSafeUsernamePattern.test(slug)) return null
	return slug
}

function hasDiacriticsOrNonAsciiLetters(value: string) {
	for (const char of value) {
		if (char.charCodeAt(0) > 127) return true
	}
	const stripped = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
	return stripped !== value
}

/**
 * Diagnose why a handle fails the permanent format rules. Trims before
 * checking so a predictive-keyboard trailing space is not a false failure.
 */
export function diagnoseHandleFormat(raw: string): HandleFormatIssue | null {
	const trimmed = typeof raw === 'string' ? raw.trim() : ''
	if (!trimmed) return 'required'

	// Prefer diacritics over spaces when both appear (e.g. "Ján Kováč"): the
	// accent rule is the surprising one for speakers who read "letters" as
	// including á/č/ľ.
	if (hasDiacriticsOrNonAsciiLetters(trimmed)) return 'diacritics'
	if (/\s/.test(trimmed)) return 'spaces'
	if (trimmed.includes('_')) return 'underscores'
	if (trimmed.includes('.')) return 'dots'

	const normalized = trimmed.toLowerCase()
	if (normalized.length < handleMinLength) return 'too-short'
	if (normalized.length > handleMaxLength) return 'too-long'
	if (normalized.startsWith('-')) return 'leading-hyphen'
	if (normalized.endsWith('-')) return 'trailing-hyphen'
	if (/^[a-z0-9-]+$/.test(normalized) && normalized.includes('--')) {
		return 'consecutive-hyphens'
	}

	if (!dnsSafeUsernamePattern.test(normalized)) {
		if (/[^a-z0-9-]/.test(normalized)) return 'other-characters'
		return 'other-characters'
	}
	return null
}

function issueMessage(
	issue: HandleFormatIssue,
	label: HandleFormatLabel,
): string {
	switch (issue) {
		case 'required':
			return `${label} is required.`
		case 'spaces':
			return `${label} can't include spaces.`
		case 'diacritics':
			return `${label} can only use a–z letters (no accents), numbers, and hyphens.`
		case 'underscores':
			return `${label} can't include underscores.`
		case 'dots':
			return `${label} can't include periods.`
		case 'other-characters':
			return `${label} can only use a–z letters, numbers, and hyphens.`
		case 'too-short':
			return `${label} must be at least ${handleMinLength} characters.`
		case 'too-long':
			return `${label} must be at most ${handleMaxLength} characters.`
		case 'leading-hyphen':
			return `${label} can't start with a hyphen.`
		case 'trailing-hyphen':
			return `${label} can't end with a hyphen.`
		case 'consecutive-hyphens':
			return `${label} can't include two hyphens in a row.`
		default: {
			const exhaustive: never = issue
			return exhaustive
		}
	}
}

/**
 * Human-facing format error for a handle field. Includes a `Try …` suggestion
 * when one can be derived and differs from the trimmed lowercase input.
 */
export function getHandleFormatError(
	raw: string,
	options: { label?: HandleFormatLabel } = {},
): string | null {
	const label = options.label ?? 'Username'
	const issue = diagnoseHandleFormat(raw)
	if (!issue) return null

	const message = issueMessage(issue, label)
	if (issue === 'required') return message

	const suggestion = suggestHandle(raw)
	const normalized = normalizeHandle(raw)
	if (suggestion && suggestion !== normalized) {
		return `${message} Try ${suggestion}.`
	}
	return message
}

/** Generic server-style requirements line (API responses, reserved fallbacks). */
export const handleFormatRequirements =
	'Username must be 3 to 32 characters, use only letters, numbers, and single hyphens (no two in a row), and start and end with a letter or number.'

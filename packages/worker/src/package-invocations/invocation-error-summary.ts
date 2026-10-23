import { redactKodyCredentials } from '@kody-internal/shared/api-token-format.ts'

/**
 * Longest export error detail copied into a webhook run or a pre-execution
 * export run record. Long enough for a few TypeScript or bundler diagnostics,
 * short enough that Activity stays readable.
 */
export const invocationErrorSummaryMaxLength = 1_000

const redacted = '[redacted]'

/** Well-known credential shapes (provider API keys, PATs, JWTs). */
const credentialShapedToken =
	/\b(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g
/** `Authorization: Bearer ...` style values. */
const authorizationValue = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
/** `scheme://user:password@host` user info. */
const urlUserInfo = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
/** Secret-carrying query parameters. */
const sensitiveQueryParam =
	/([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|client_secret|password|signature|sig|code)=)[^&\s"'<>]+/gi
/** `password=...` / `"apiKey": "..."` style assignments in free text. */
const sensitiveAssignment =
	/(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*(?:=\s*["']?|:\s*["']))(?!\[redacted\])[^\s"',;}&]{4,}/gi

/** Drop control characters other than newline and tab. */
function stripControlCharacters(value: string) {
	let result = ''
	for (const char of value) {
		const code = char.charCodeAt(0)
		if (code === 0x0a || code === 0x09 || (code >= 0x20 && code !== 0x7f)) {
			result += char
		}
	}
	return result
}

/**
 * Make an export error message safe to copy into another run record
 * (webhook run, pre-execution export run) and Activity. The source message
 * is already owner-visible on the export's own response; this additionally
 * strips credential-shaped values and bounds the length, so a secret echoed
 * into an error by user code does not spread to more records.
 */
export function sanitizeInvocationErrorMessage(message: string) {
	const cleaned = redactKodyCredentials(message)
		.replace(credentialShapedToken, redacted)
		.replace(
			authorizationValue,
			(_match, scheme: string) => `${scheme} ${redacted}`,
		)
		.replace(urlUserInfo, (_match, scheme: string) => `${scheme}${redacted}@`)
		.replace(
			sensitiveQueryParam,
			(_match, prefix: string) => `${prefix}${redacted}`,
		)
		.replace(
			sensitiveAssignment,
			(_match, prefix: string) => `${prefix}${redacted}`,
		)
	const printable = stripControlCharacters(cleaned).trim()
	if (printable.length <= invocationErrorSummaryMaxLength) return printable
	return `${printable.slice(0, invocationErrorSummaryMaxLength - 1)}…`
}

/** Sanitized message for any thrown value, or null when it carries none. */
export function summarizeInvocationError(error: unknown): string | null {
	const message =
		error instanceof Error
			? error.message
			: typeof error === 'string'
				? error
				: error &&
					  typeof error === 'object' &&
					  typeof (error as { message?: unknown }).message === 'string'
					? (error as { message: string }).message
					: null
	if (!message) return null
	const sanitized = sanitizeInvocationErrorMessage(message)
	return sanitized.length > 0 ? sanitized : null
}

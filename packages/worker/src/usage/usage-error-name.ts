/**
 * Sanitize error names/codes for Analytics Engine blob13 on usage events.
 *
 * Prefer a structured `code`, then a leading `[code]` in the message (how
 * credential-need refusals survive fetch rejection), then `Error.name`.
 * Never store free-form messages — only a short token safe for GROUP BY.
 */

export const usageErrorNameMaxLength = 96
export const usageErrorNameUnrecorded = ''

const allowedErrorNamePattern = /^[A-Za-z0-9._:-]+$/
const bracketCodePattern = /^\[([A-Za-z0-9._:-]{1,96})\]/

/**
 * Normalize a candidate name/code for AE. Empty string means "unrecorded"
 * (success paths, pre-dimension rows, or nothing extractable).
 */
export function sanitizeUsageErrorName(raw: string | null | undefined): string {
	const trimmed = raw?.trim() ?? ''
	if (!trimmed) return usageErrorNameUnrecorded
	const clipped = trimmed.slice(0, usageErrorNameMaxLength)
	if (!allowedErrorNamePattern.test(clipped)) return usageErrorNameUnrecorded
	return clipped
}

/**
 * Best-effort error name/code for metering. Safe on any thrown value that
 * crossed a sandbox boundary (string message, Error, or `{ code, name }`).
 */
export function usageErrorNameFromUnknown(error: unknown): string {
	if (error == null) return usageErrorNameUnrecorded
	if (typeof error === 'string') {
		return sanitizeUsageErrorName(bracketCodeFromMessage(error) ?? '')
	}
	if (typeof error !== 'object') return usageErrorNameUnrecorded
	const record = error as Record<string, unknown>
	const code = record['code']
	if (typeof code === 'string') {
		const fromCode = sanitizeUsageErrorName(code)
		if (fromCode) return fromCode
	}
	const body = record['body']
	if (body && typeof body === 'object') {
		const bodyCode = (body as Record<string, unknown>)['code']
		if (typeof bodyCode === 'string') {
			const fromBody = sanitizeUsageErrorName(bodyCode)
			if (fromBody) return fromBody
		}
	}
	const message = record['message']
	if (typeof message === 'string') {
		const fromMessage = sanitizeUsageErrorName(bracketCodeFromMessage(message))
		if (fromMessage) return fromMessage
	}
	const name = record['name']
	if (typeof name === 'string' && name !== 'Error') {
		const fromName = sanitizeUsageErrorName(name)
		if (fromName) return fromName
	}
	if (typeof name === 'string') {
		return sanitizeUsageErrorName(name)
	}
	return usageErrorNameUnrecorded
}

function bracketCodeFromMessage(message: string): string | null {
	const match = bracketCodePattern.exec(message.trim())
	return match?.[1] ?? null
}

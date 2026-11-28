/**
 * Prefer a validated string `message` on Error and Error-shaped objects
 * (for example Cloudflare Artifacts binding throws that do not survive JSRPC
 * as `Error`). Fall back to `String(error)` for everything else. Never
 * returns blank: an empty message falls back to esbuild-style `errors[].text`,
 * the cause, then the error name. Raw NUL characters are escaped because
 * transports that treat them as string terminators truncate the message.
 */
export function getErrorMessage(error: unknown): string {
	return escapeNulCharacters(readErrorMessage(error, new Set()))
}

function readErrorMessage(error: unknown, seen: Set<unknown>): string {
	if (typeof error === 'string') {
		return error.trim() ? error : 'Error (no error message was provided)'
	}
	if (error === null || typeof error !== 'object') return String(error)
	seen.add(error)
	const message = (error as { message?: unknown }).message
	if (typeof message !== 'string') {
		return error instanceof Error
			? describeBlankError(error, seen)
			: String(error)
	}
	if (message.trim()) return message
	return describeBlankError(error, seen)
}

function describeBlankError(error: object, seen: Set<unknown>): string {
	const details = readStructuredErrorTexts(error)
	if (details) return details
	const cause = getErrorCause(error)
	if (cause !== undefined && !seen.has(cause)) {
		const causeMessage = readErrorMessage(cause, seen)
		if (causeMessage.trim()) return causeMessage
	}
	const name = (error as { name?: unknown }).name
	const label = typeof name === 'string' && name.trim() ? name : 'Error'
	return `${label} (no error message was provided)`
}

function readStructuredErrorTexts(error: object) {
	const errors = (error as { errors?: unknown }).errors
	if (!Array.isArray(errors)) return ''
	return errors
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return ''
			const text = (entry as { text?: unknown }).text
			return typeof text === 'string' ? text.trim() : ''
		})
		.filter(Boolean)
		.join('; ')
}

function escapeNulCharacters(message: string) {
	return message.includes('\0') ? message.replaceAll('\0', '\\0') : message
}

export function getErrorCause(error: unknown) {
	if (error && typeof error === 'object' && 'cause' in error) {
		return (error as { cause?: unknown }).cause
	}
	return undefined
}

export function getErrorCauseChain(error: unknown) {
	const chain: Array<unknown> = []
	const seen = new Set<unknown>()
	let current: unknown = error
	while (current !== undefined && !seen.has(current)) {
		seen.add(current)
		chain.push(current)
		current = getErrorCause(current)
	}
	return chain
}

export function errorCauseChainIncludes(
	error: unknown,
	matches: (message: string) => boolean,
) {
	return getErrorCauseChain(error).some((entry) =>
		matches(getErrorMessage(entry)),
	)
}

export function formatErrorCauseChain(error: unknown) {
	return getErrorCauseChain(error)
		.map(getErrorMessage)
		.filter((message, index, messages) => message !== messages[index - 1])
		.join(' Caused by: ')
}

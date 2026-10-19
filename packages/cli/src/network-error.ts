/**
 * `fetch failed` alone hides why; undici puts ECONNREFUSED / ENOTFOUND /
 * UND_ERR_* on `cause.code`. Connect-phase codes mean the request body never
 * left the machine; anything else means the outcome is unknown.
 */

/** TCP/DNS/TLS never completed — nothing was sent to the origin. */
const connectPhaseNetworkCodes = new Set([
	'UND_ERR_CONNECT_TIMEOUT',
	'ECONNREFUSED',
	'ENOTFOUND',
	'EAI_AGAIN',
	'ENETUNREACH',
	'EHOSTUNREACH',
])

export type RequestSentStatus = false | 'unknown'

export function networkErrorCauseCode(error: unknown): string | null {
	for (const value of errorCauseChain(error)) {
		if (
			value &&
			typeof value === 'object' &&
			'code' in value &&
			typeof value.code === 'string' &&
			value.code.length > 0
		) {
			return value.code
		}
	}
	return null
}

/** `fetch failed` alone hides why; undici puts ECONNREFUSED / ENOTFOUND on `cause.code`. */
export function describeNetworkError(error: unknown): string {
	if (!(error instanceof Error)) return String(error)
	const causeCode = networkErrorCauseCode(error)
	return causeCode ? `${error.message}: ${causeCode}` : error.message
}

/**
 * Whether the HTTP request body could have reached the server.
 * - `false` — connect-phase failure; safe to retry the same write.
 * - `"unknown"` — connection may have progressed; do not assume unsent.
 */
export function requestSentStatus(error: unknown): RequestSentStatus {
	const code = networkErrorCauseCode(error)
	if (code && connectPhaseNetworkCodes.has(code)) return false
	if (error instanceof Error) {
		const message = error.message
		// CapabilityProxy connect bound (TCP/TLS) fails before any bytes of the
		// request body are written.
		if (/did not connect within \d+ms/i.test(message)) return false
	}
	return 'unknown'
}

/**
 * Human + agent guidance when `fetch` rejects before a usable HTTP response.
 * Connect-phase failures say the request was not sent; other failures say the
 * outcome is unknown and point at `workflowRunList` for long writes (publish).
 */
export function formatUnreachableApiMessage(input: {
	origin: string
	error: unknown
}): string {
	const reason = describeNetworkError(input.error)
	const sent = requestSentStatus(input.error)
	const base = `Could not reach the Kody API at ${input.origin} (${reason}).`
	const networkHint = 'Check --api-url / KODY_API_URL and your network.'
	if (sent === false) {
		return `${base} The request was not sent. ${networkHint}`
	}
	return (
		`${base} The request may have been sent; outcome is unknown. ` +
		`If this was a write such as \`kody package publish\`, list recent runs with ` +
		`\`kody api workflowRunList\` (or MCP \`workflowRunList\`) before publishing again. ` +
		networkHint
	)
}

function errorCauseChain(error: unknown): Array<unknown> {
	const chain: Array<unknown> = []
	let current: unknown = error
	const seen = new Set<unknown>()
	while (current != null && !seen.has(current)) {
		seen.add(current)
		chain.push(current)
		if (typeof current !== 'object' || !('cause' in current)) break
		current = current.cause
	}
	return chain
}

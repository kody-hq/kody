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

/**
 * undici's own wait limits: the server accepted the request but sent no
 * response headers (or body) in time. Node's fetch waits 300 s by default.
 */
const responseTimeoutNetworkCodes = new Set([
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
])

/** True when the request reached Kody but no answer came back in time. */
export function isResponseTimeoutNetworkError(error: unknown): boolean {
	const code = networkErrorCauseCode(error)
	return code != null && responseTimeoutNetworkCodes.has(code)
}

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
	const networkHint = 'Check --api-url / KODY_API_URL and your network.'
	if (isResponseTimeoutNetworkError(input.error)) {
		return (
			`The Kody API at ${input.origin} accepted the request but sent no answer within the CLI's wait (${networkErrorCauseCode(input.error)}, about 5 minutes); the server may still be working. ` +
			'This is retryable: run read-only commands such as `kody dev check` again. ' +
			'For a write such as `kody package publish`, list recent runs with `kody api workflowRunList` first so you do not publish twice.'
		)
	}
	const base = `Could not reach the Kody API at ${input.origin} (${reason}).`
	if (sent === false) {
		return `${base} The request was not sent. ${networkHint}`
	}
	return (
		`${base} The request may have been sent; outcome is unknown. ` +
		`If this was a write such as \`kody package publish\`, list recent runs with ` +
		`\`kody api workflowRunList\` (or MCP \`workflowRunList\`; pass \`workflow_id\` when known) before publishing again. ` +
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

/**
 * Preview `kody context register` hops that failed before a usable HTTP
 * response. Windows GHA has hit a bare `fetch failed` against the preview
 * API after the app-origin session already succeeded; retry register once.
 * Do not retry `execute`: it has no idempotency key, so a lost response
 * would start a second run.
 */

const retryableExecutionContextCliPatterns = [
	/\bfetch failed\b/,
	/Could not reach the Kody API/,
	/\bECONNRESET\b/,
	/\bETIMEDOUT\b/,
	/\bUND_ERR_CONNECT_TIMEOUT\b/,
	/\bUND_ERR_SOCKET\b/,
	/\bEAI_AGAIN\b/,
	/\bENOTFOUND\b/,
	/socket hang up/,
] as const

export function cliFailureText(error: unknown): string {
	if (!(error instanceof Error)) return String(error)
	const extra = error as Error & { stdout?: unknown; stderr?: unknown }
	return [error.message, extra.stdout, extra.stderr]
		.filter((part): part is string => typeof part === 'string')
		.join('\n')
}

export function isRetryableExecutionContextCliFailure(text: string) {
	return retryableExecutionContextCliPatterns.some((pattern) =>
		pattern.test(text),
	)
}

export function shouldRetryExecutionContextCli(
	error: unknown,
	args: ReadonlyArray<string> = [],
) {
	if (args[0] === 'execute') return false
	return isRetryableExecutionContextCliFailure(cliFailureText(error))
}

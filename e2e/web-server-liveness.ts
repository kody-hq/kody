/**
 * Detect when the Playwright `webServer` (Wrangler / workerd) has exited
 * mid-suite. Remaining tests would otherwise burn CI retries on
 * ECONNREFUSED / ERR_CONNECTION_REFUSED (see KODY main Validate flake on
 * #1316). Once marked dead, every later check fails immediately with a clear
 * message pointing at the `logs.local/` CI artifact and the unread
 * `request.clone()` tee fix.
 */

const e2eWebServerDeadCode = 'E2E_WEB_SERVER_DEAD'

/**
 * Stable pointer for agents: unread `request.clone()` tees are the common
 * wrangler-dev killer.
 */
const e2eUnreadRequestCloneTeeRemediation =
	'If wrangler logs show "Network connection lost" or "Error inside ProxyWorker", ' +
	'an unread request.clone() body teed the stream and workerd killed the isolate; ' +
	'wrangler 4.114+ then exits (workers-sdk#14926). Fix: consume the original ' +
	'Request (request.json() / request.formData()) or drain the unused tee with ' +
	'discardUnreadRequestBody from #worker/request-body.ts before returning. ' +
	'Do not restart wrangler as the fix.'

export class E2eWebServerDeadError extends Error {
	readonly code = e2eWebServerDeadCode

	constructor(message: string) {
		super(message)
		this.name = 'E2eWebServerDeadError'
	}
}

let webServerDead = false

const connectionRefusedPattern =
	/(?:ECONNREFUSED|ERR_CONNECTION_REFUSED|net::ERR_CONNECTION_REFUSED)/i

function isE2eWebServerConnectionError(error: unknown): boolean {
	const seen = new Set<unknown>()
	const queue: Array<unknown> = [error]
	while (queue.length > 0) {
		const current = queue.shift()
		if (current === undefined || current === null || seen.has(current)) {
			continue
		}
		seen.add(current)
		if (typeof current === 'string') {
			if (connectionRefusedPattern.test(current)) return true
			continue
		}
		if (typeof current !== 'object') continue
		if (
			'code' in current &&
			typeof current.code === 'string' &&
			current.code === 'ECONNREFUSED'
		) {
			return true
		}
		if (
			'message' in current &&
			typeof current.message === 'string' &&
			connectionRefusedPattern.test(current.message)
		) {
			return true
		}
		if ('cause' in current) queue.push(current.cause)
		if (
			'errors' in current &&
			Array.isArray((current as { errors?: unknown }).errors)
		) {
			for (const nested of (current as { errors: Array<unknown> }).errors) {
				queue.push(nested)
			}
		}
	}
	return false
}

function webServerDeadMessage(origin: string, detail?: string) {
	const suffix = detail ? ` (${detail})` : ''
	return (
		`Playwright webServer (wrangler) is not reachable at ${origin}${suffix}. ` +
		'The process likely exited mid-suite — remaining tests will fail fast. ' +
		'On CI, download the e2e-wrangler-logs artifact (logs.local/) from the ' +
		`failed 🎭 E2E job. ${e2eUnreadRequestCloneTeeRemediation}`
	)
}

function markE2eWebServerDead(origin: string, detail?: string): never {
	webServerDead = true
	throw new E2eWebServerDeadError(webServerDeadMessage(origin, detail))
}

type E2eWebServerHintSink = {
	status?: string
	errors: Array<{ message?: string }>
	annotations: Array<{ type: string; description?: string }>
}

/**
 * Attach the unread-clone tee fix to the Playwright test that actually saw
 * the connection drop, not only the next test that hits the dead latch.
 */
export function attachUnreadCloneTeeHintIfNeeded(
	testInfo: E2eWebServerHintSink,
) {
	if (testInfo.status === 'passed' || testInfo.status === 'skipped') return
	const blob = testInfo.errors.map((error) => error.message ?? '').join('\n')
	if (
		!isE2eWebServerConnectionError(blob) &&
		!blob.includes('E2eWebServerDeadError')
	) {
		return
	}
	testInfo.annotations.push({
		type: 'warning',
		description: e2eUnreadRequestCloneTeeRemediation,
	})
}

/**
 * If `error` is a connection-refused / already-dead signal, mark the suite
 * dead and throw {@link E2eWebServerDeadError}. Otherwise return so the caller
 * can rethrow the original error.
 */
export function throwIfE2eWebServerDead(
	error: unknown,
	origin = 'http://127.0.0.1:3847',
): void {
	if (error instanceof E2eWebServerDeadError) {
		webServerDead = true
		throw error
	}
	if (webServerDead || isE2eWebServerConnectionError(error)) {
		const detail =
			error instanceof Error
				? error.message
				: typeof error === 'string'
					? error
					: undefined
		markE2eWebServerDead(origin, detail)
	}
}

/**
 * Probe `/health`. Any HTTP response means the server is still listening;
 * connection failures latch the suite as dead.
 */
export async function assertE2eWebServerAlive(
	baseURL: string | undefined,
): Promise<void> {
	const origin = new URL(baseURL ?? 'http://127.0.0.1:3847').origin
	if (webServerDead) {
		throw new E2eWebServerDeadError(webServerDeadMessage(origin))
	}

	const healthUrl = new URL('/health', origin)
	try {
		await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) })
	} catch (error) {
		throwIfE2eWebServerDead(error, origin)
		throw error
	}
}

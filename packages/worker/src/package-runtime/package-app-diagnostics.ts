import { fetchPreservingWebSocketUpgrade } from '#worker/package-runtime/websocket-upgrade.ts'

/** Correlation id for one inline package-app attempt. Never a cookie or token. */
export const packageAppRequestIdHeader = 'x-kody-request-id'

/**
 * Set on a package-app 500 by the runtime worker so the serve path can log the
 * run id, then removed before the response reaches the browser.
 */
export const packageAppRuntimeRunIdHeader = 'x-kody-runtime-run-id'

/**
 * Marks a Dynamic Worker fetch response that stands in for a thrown package
 * handler error. Fetch semantics do not preserve custom Error properties, so
 * the runtime returns this tagged 500 instead of throwing across APP_LOADER.
 * Serve converts it to the package-entrypoint error page; strip before the
 * browser.
 */
export const packageAppRuntimeErrorHeader = 'x-kody-runtime-error'

const requestIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function packageAppRequestIdFromRequest(
	request: Request,
): string | null {
	const existing = request.headers.get(packageAppRequestIdHeader)?.trim() ?? ''
	return requestIdPattern.test(existing) ? existing : null
}

/**
 * Keep a valid request id, or assign a new one. Client-supplied values that
 * are not UUIDs are replaced so logs cannot be stuffed with arbitrary text.
 */
/**
 * Copies the request id onto the request forwarded to package code, which
 * the serve path strips of every `x-kody-*` header first. The app wrapper
 * reads it to tag a CPU sample with the id the response exposes.
 */
export function withForwardedPackageAppRequestId(
	forwarded: Request,
	requestId: string | null,
): Request {
	if (!requestId) return forwarded
	const headers = new Headers(forwarded.headers)
	headers.set(packageAppRequestIdHeader, requestId)
	return new Request(forwarded, { headers })
}

export function withPackageAppRequestId(request: Request): {
	request: Request
	requestId: string
} {
	const existing = packageAppRequestIdFromRequest(request)
	if (existing) return { request, requestId: existing }
	const requestId = crypto.randomUUID()
	const headers = new Headers(request.headers)
	headers.set(packageAppRequestIdHeader, requestId)
	return {
		request: new Request(request, { headers }),
		requestId,
	}
}

export function logPackageAppAuthFailed(input: {
	requestId: string
	method: string
	pathname: string
}) {
	console.warn('package-app-auth-failed', {
		requestId: input.requestId,
		method: input.method,
		pathname: input.pathname,
		sessionCookiePresent: true,
	})
}

export function logPackageAppHttpError(input: {
	request: Request
	status: number
	phase: string
	runtimeRunId: string | null
}) {
	if (input.status < 500) return
	const url = new URL(input.request.url)
	console.error('package-app-http-error', {
		requestId: packageAppRequestIdFromRequest(input.request),
		status: input.status,
		pathname: url.pathname,
		runtimeRunId: input.runtimeRunId,
		phase: input.phase,
	})
}

export function runtimeRunIdFromError(error: unknown): string | null {
	if (!error || typeof error !== 'object' || !('kodyRuntimeRunId' in error)) {
		return null
	}
	const runtimeRunId = error.kodyRuntimeRunId
	return typeof runtimeRunId === 'string' && runtimeRunId.length > 0
		? runtimeRunId
		: null
}

export function stripPackageAppRuntimeRunId(response: Response): {
	response: Response
	runtimeRunId: string | null
} {
	const runtimeRunId = response.headers.get(packageAppRuntimeRunIdHeader)
	const runtimeError = response.headers.get(packageAppRuntimeErrorHeader)
	if (response.webSocket || response.status === 101) {
		return { response, runtimeRunId }
	}
	if (!runtimeRunId && !runtimeError) {
		return { response, runtimeRunId }
	}
	const headers = new Headers(response.headers)
	headers.delete(packageAppRuntimeRunIdHeader)
	headers.delete(packageAppRuntimeErrorHeader)
	return {
		runtimeRunId,
		response: new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		}),
	}
}

export function isPackageAppRuntimeThrownResponse(response: Response): boolean {
	return (
		response.status >= 500 &&
		response.headers.get(packageAppRuntimeErrorHeader) === '1'
	)
}

/**
 * Forward a runtime-owned request and log HTTP 500s with the request id.
 * The runtime run id is included when the runtime worker attached it.
 */
export async function forwardRuntimeWorkerFetch(
	fetcher: { fetch: typeof fetch },
	request: Request,
): Promise<Response> {
	const tagged = withPackageAppRequestId(request)
	const pathname = new URL(tagged.request.url).pathname
	try {
		const fetched = await fetchPreservingWebSocketUpgrade(
			fetcher,
			tagged.request,
		)
		const stripped = stripPackageAppRuntimeRunId(fetched)
		logPackageAppHttpError({
			request: tagged.request,
			status: stripped.response.status,
			phase: 'runtime-worker-forward',
			runtimeRunId: stripped.runtimeRunId,
		})
		return stripped.response
	} catch (error) {
		console.error('runtime-worker-forward-failed', {
			requestId: tagged.requestId,
			pathname,
			errorName: error instanceof Error ? error.name : 'Error',
		})
		throw error
	}
}

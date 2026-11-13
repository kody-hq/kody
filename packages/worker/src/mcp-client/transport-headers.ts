/**
 * Mirror static `transport.headers` into `transport.requestInit.headers`.
 *
 * `PersistedMcpTransportOptions` accepts a `headers` field and the Agents SDK
 * persists it, but the underlying transports never read it — they only merge
 * `requestInit` into outbound fetches.
 *
 * Without this, a server configured with a static `Authorization` header never
 * receives one, so any MCP server that answers 401 instead of using OAuth can
 * never connect — it fails with no diagnostic, because the client falls back to
 * OAuth discovery and reports the discovery failure rather than the 401.
 *
 * Explicit `requestInit.headers` win so callers can still override a stored
 * value.
 */
export function withStaticTransportHeaders<
	T extends {
		headers?: HeadersInit
		requestInit?: RequestInit
		[key: string]: unknown
	},
>(transport: T): T {
	if (!transport.headers) return transport
	return {
		...transport,
		requestInit: {
			...transport.requestInit,
			headers: {
				...headersToRecord(transport.headers),
				...headersToRecord(transport.requestInit?.headers),
			},
		},
	}
}

function headersToRecord(
	init: HeadersInit | undefined,
): Record<string, string> {
	if (!init) return {}
	return Object.fromEntries(new Headers(init).entries())
}

/**
 * Remove static headers from a persisted Agents SDK `server_options` blob.
 * Returns the blob without `transport.headers` and
 * `transport.requestInit.headers`, plus the headers that were removed (null
 * when there were none). Unparseable blobs are returned unchanged.
 */
export function splitPersistedStaticHeaders(serverOptions: string | null): {
	serverOptions: string | null
	headers: Record<string, string> | null
} {
	if (!serverOptions) return { serverOptions, headers: null }
	let parsed: unknown
	try {
		parsed = JSON.parse(serverOptions)
	} catch {
		return { serverOptions, headers: null }
	}
	if (!isPlainRecord(parsed) || !isPlainRecord(parsed.transport)) {
		return { serverOptions, headers: null }
	}
	const transport = { ...parsed.transport }
	const requestInit = isPlainRecord(transport.requestInit)
		? { ...transport.requestInit }
		: null
	const headers = {
		...headersToRecord(transport.headers as HeadersInit | undefined),
		...headersToRecord(requestInit?.headers as HeadersInit | undefined),
	}
	if (Object.keys(headers).length === 0) return { serverOptions, headers: null }
	delete transport.headers
	if (requestInit) {
		delete requestInit.headers
		if (Object.keys(requestInit).length === 0) delete transport.requestInit
		else transport.requestInit = requestInit
	}
	return {
		serverOptions: JSON.stringify({ ...parsed, transport }),
		headers,
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

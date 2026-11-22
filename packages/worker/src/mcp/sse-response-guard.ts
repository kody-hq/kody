import { isRecord } from '@kody-internal/shared/is-record.ts'

/**
 * Extract JSON-RPC request IDs from a parsed body. Only messages with both
 * a `method` (indicating a request, not a response/notification) and an `id`
 * are included.
 */
export function extractJsonRpcRequestIds(
	parsedBody: unknown,
): Array<string | number> {
	const messages = Array.isArray(parsedBody)
		? parsedBody.filter(isRecord)
		: isRecord(parsedBody)
			? [parsedBody]
			: []
	return messages
		.filter(
			(msg) => typeof msg['method'] === 'string' && msg['id'] !== undefined,
		)
		.map((msg) => msg['id'] as string | number)
}

/**
 * Wraps a legacy-lane SSE `Response` so that every JSON-RPC request ID
 * from the original POST body receives at least one JSON-RPC
 * result-or-error frame before the stream closes.
 *
 * **Why this exists:** the agents SDK's WebSocket-to-SSE bridge closes the
 * writer silently when the Durable Object WebSocket drops (edge timeout,
 * DO reset, transport.send failure). The MCP SDK's `Protocol._onrequest`
 * promise chain swallows the send error via `_onerror` (log-only), so no
 * JSON-RPC response ever reaches the client — the client sees "SSE stream
 * ended without a response".
 *
 * This guard sits between the bridge and the client, tracking which
 * request IDs receive responses. If the upstream closes the stream before
 * all IDs are answered, the guard injects a JSON-RPC internal-error frame
 * per orphaned ID before closing the client-facing stream.
 *
 * Only 200 SSE streaming responses to POST requests are guarded; every
 * other shape (non-200, non-SSE, non-POST) passes through unchanged.
 * Remove when: MCP protocol metrics show no 2025-era lane traffic.
 */
export function guardLegacyLaneSseResponse(
	requestIds: Array<string | number>,
	response: Response,
): Response {
	if (
		requestIds.length === 0 ||
		response.status !== 200 ||
		!response.body ||
		!response.headers.get('Content-Type')?.includes('text/event-stream')
	) {
		return response
	}

	const pendingIds = new Set(requestIds.map((id) => JSON.stringify(id)))
	const reader = response.body.getReader()
	const encoder = new TextEncoder()
	const decoder = new TextDecoder()

	let buffered = ''

	function injectOrphanErrors(
		controller: ReadableStreamDefaultController<Uint8Array>,
	) {
		for (const idJson of pendingIds) {
			const id: string | number = JSON.parse(idJson)
			controller.enqueue(encoder.encode(formatSseErrorFrame(id)))
		}
		pendingIds.clear()
	}

	const guarded = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read()
				if (done) {
					if (pendingIds.size > 0) injectOrphanErrors(controller)
					controller.close()
					return
				}

				const chunk = decoder.decode(value, { stream: true })
				buffered += chunk

				let boundary: number
				while ((boundary = buffered.indexOf('\n\n')) !== -1) {
					const event = buffered.slice(0, boundary + 2)
					buffered = buffered.slice(boundary + 2)
					trackResponseIds(event, pendingIds)
				}

				controller.enqueue(value)
			} catch {
				if (pendingIds.size > 0) injectOrphanErrors(controller)
				controller.close()
			}
		},
		cancel(reason) {
			reader.cancel(reason).catch(() => {})
		},
	})

	return new Response(guarded, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

function trackResponseIds(sseText: string, pendingIds: Set<string>): void {
	for (const line of sseText.split('\n')) {
		if (!line.startsWith('data: ')) continue
		try {
			const parsed: unknown = JSON.parse(line.slice(6))
			if (!isRecord(parsed)) continue
			if (
				parsed['id'] !== undefined &&
				('result' in parsed || 'error' in parsed)
			) {
				pendingIds.delete(JSON.stringify(parsed['id']))
			}
		} catch {
			// Non-JSON data line; ignore.
		}
	}
}

function formatSseErrorFrame(id: string | number): string {
	const payload = {
		jsonrpc: '2.0' as const,
		id,
		error: {
			code: -32603,
			message:
				'Internal error: the server connection closed before delivering a response. Please retry.',
		},
	}
	return `event: message\ndata: ${JSON.stringify(payload)}\n\n`
}

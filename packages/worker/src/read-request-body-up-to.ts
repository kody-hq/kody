export type RequestBodyUpTo =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; byteLength: number }

/**
 * Reads a request body without buffering more than `maxBytes`. A declared
 * `Content-Length` over the cap is refused before reading; otherwise the
 * stream is counted as it arrives (chunked bodies included) and cancelled
 * once it passes the cap. `byteLength` on failure is the declared length or
 * the bytes counted before cancelling.
 */
export async function readRequestBodyUpTo(
	request: Request,
	maxBytes: number,
): Promise<RequestBodyUpTo> {
	const declaredLength = Number(request.headers.get('Content-Length') ?? '')
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		return { ok: false, byteLength: declaredLength }
	}
	if (!request.body) return { ok: true, bytes: new Uint8Array() }

	const reader = request.body.getReader()
	const chunks: Array<Uint8Array> = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value || value.byteLength === 0) continue
			total += value.byteLength
			if (total > maxBytes) {
				void reader.cancel().catch(() => {})
				return { ok: false, byteLength: total }
			}
			chunks.push(value)
		}
	} catch (error) {
		void reader.cancel().catch(() => {})
		throw error
	}

	if (chunks.length === 1) return { ok: true, bytes: chunks[0]! }
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return { ok: true, bytes }
}

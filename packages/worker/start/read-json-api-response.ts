/**
 * Parse a JSON API response without throwing on empty or non-JSON bodies.
 * Callers still check `ok` / payload fields for domain errors.
 */
export async function readJsonApiResponse<T = unknown>(
	response: Response,
): Promise<{
	ok: boolean
	status: number
	data: T | null
	error: string | null
}> {
	const contentType = response.headers.get('content-type') ?? ''
	const looksJson = contentType.toLowerCase().includes('application/json')
	if (!looksJson) {
		const text = (await response.text().catch(() => '')).trim()
		return {
			ok: response.ok,
			status: response.status,
			data: null,
			error:
				text ||
				(response.ok
					? 'Unexpected non-JSON response.'
					: `Request failed (${response.status}).`),
		}
	}
	try {
		const data = (await response.json()) as T
		return { ok: response.ok, status: response.status, data, error: null }
	} catch {
		return {
			ok: false,
			status: response.status,
			data: null,
			error:
				response.status === 401
					? 'Please sign in again.'
					: `Request failed (${response.status}) with an empty or invalid JSON body.`,
		}
	}
}

/** Business operations return data, independently of HTTP or Start transport. */
export function operationResult<const T>(
	data: T,
	init: number | ResponseInit = 200,
) {
	return {
		data,
		status: typeof init === 'number' ? init : (init.status ?? 200),
		headers: typeof init === 'number' ? undefined : init.headers,
	}
}
export function requireOperationResult<
	T extends { data: unknown; status: number },
>(result: T): Exclude<T['data'], { readonly ok: false }> {
	if (result.status >= 400) {
		const data = result.data
		throw new Error(
			data &&
				typeof data === 'object' &&
				'error' in data &&
				typeof data.error === 'string'
				? data.error
				: 'Unable to complete operation.',
		)
	}
	return result.data as Exclude<T['data'], { readonly ok: false }>
}

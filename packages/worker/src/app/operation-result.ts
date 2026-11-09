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
	// `status` must be the HTTP code from `operationResult`. Passing an
	// already-unwrapped website payload whose `status` is an outcome string
	// (for example community install `'installed'`) used to fall through and
	// return `undefined` via `.data` — which then crashed UI as
	// `Cannot read properties of undefined (reading 'ok')`.
	if (typeof result?.status !== 'number') {
		throw new Error('Unable to complete operation.')
	}
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
	if (result.data === undefined || result.data === null) {
		throw new Error('Unable to complete operation.')
	}
	return result.data as Exclude<T['data'], { readonly ok: false }>
}

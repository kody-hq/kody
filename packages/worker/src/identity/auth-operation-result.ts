/** Cookie/header effects are applied by the caller, never serialized to the browser as data. */
export function authOperationResult<T>(
	data: T,
	init: number | ResponseInit = {},
) {
	const options = typeof init === 'number' ? { status: init } : init
	return {
		data,
		status: options.status ?? 200,
		headers: new Headers(options.headers),
	}
}

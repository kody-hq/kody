/**
 * The lowercased `type/subtype` of a Content-Type value, without parameters.
 * Compare this with `===`; `includes` also matches parameter values such as
 * `text/plain; note=application/json`.
 */
export function mediaType(contentType: string | null | undefined) {
	return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

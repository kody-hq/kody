/** Execute a server callback and its input validator in service-level tests.
 * HTTP serialization and middleware belong to compiled worker contract tests. */
export function createTestServerFn() {
	let validate = (data: unknown): unknown => data
	const builder = {
		validator(
			fn: ((data: unknown) => unknown) | { parse: (data: unknown) => unknown },
		) {
			validate = typeof fn === 'function' ? fn : (data) => fn.parse(data)
			return builder
		},
		inputValidator(
			fn: ((data: unknown) => unknown) | { parse: (data: unknown) => unknown },
		) {
			return builder.validator(fn)
		},
		handler(fn: (input: { data: unknown }) => unknown) {
			return (input: { data?: unknown } = {}) =>
				fn({ data: validate(input.data) })
		},
	}
	return builder
}

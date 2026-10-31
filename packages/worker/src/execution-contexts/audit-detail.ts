/** session-do stores at most 2048 chars of detail JSON; stay under it. */
export const maxAuditDetailChars = 2000

/**
 * Trims the named string fields (in order) until the detail's JSON fits the
 * audit store's cut, so a stored row is never cut mid-JSON.
 */
export function fitAuditStrings<T extends Record<string, unknown>>(
	detail: T,
	fields: ReadonlyArray<keyof T>,
): T & { truncated?: true } {
	let fitted: T & { truncated?: true } = detail
	const size = () => JSON.stringify(fitted).length
	for (const field of fields) {
		while (size() > maxAuditDetailChars) {
			const value = fitted[field]
			if (typeof value !== 'string' || value.length === 0) break
			const over = size() - maxAuditDetailChars
			fitted = {
				...fitted,
				[field]: value.slice(
					0,
					Math.max(0, value.length - Math.max(1, Math.ceil(over / 6))),
				),
				truncated: true,
			}
		}
	}
	return fitted
}

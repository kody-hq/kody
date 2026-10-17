/** JSON records cross the server function boundary without unknown values. */
type JsonValue =
	| null
	| string
	| number
	| boolean
	| JsonValue[]
	| { [key: string]: JsonValue }
function readJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (Array.isArray(value)) return value.map(readJsonValue)
	if (
		typeof value === 'object' &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	)
		return readJsonRecord(value)
	throw new Error('Stored value is not valid JSON')
}
export function readJsonRecord(value: object): { [key: string]: JsonValue } {
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, readJsonValue(item)]),
	)
}

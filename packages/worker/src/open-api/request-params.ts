import { isRecord } from '@kody-internal/shared/is-record.ts'
import { readRequestBodyUpTo } from '#worker/read-request-body-up-to.ts'
import { maxApiRequestBodyBytes } from './api-body-limits.ts'
import { invalidRequest } from './errors.ts'

export { maxApiRequestBodyBytes }

type JsonSchema = Record<string, unknown>

function schemaTypes(schema: JsonSchema | undefined): Set<string> {
	const types = new Set<string>()
	if (!schema) return types
	const type = schema['type']
	if (typeof type === 'string') types.add(type)
	if (Array.isArray(type)) {
		for (const entry of type) if (typeof entry === 'string') types.add(entry)
	}
	for (const key of ['anyOf', 'oneOf'] as const) {
		const variants = schema[key]
		if (!Array.isArray(variants)) continue
		for (const variant of variants) {
			if (isRecord(variant)) {
				for (const entry of schemaTypes(variant)) types.add(entry)
			}
		}
	}
	return types
}

function coerceScalar(value: string, schema: JsonSchema | undefined): unknown {
	const types = schemaTypes(schema)
	if (types.has('string') || types.size === 0) return value
	if (types.has('boolean') && (value === 'true' || value === 'false')) {
		return value === 'true'
	}
	if (
		(types.has('integer') || types.has('number')) &&
		value.trim() !== '' &&
		Number.isFinite(Number(value))
	) {
		return Number(value)
	}
	if (types.has('null') && value === 'null') return null
	return value
}

/**
 * Reserved query keys consumed by API authentication, not operation inputs.
 * User-owned tokens select the request org with `?org=<slug>` (ADR 0069).
 */
export const apiAuthReservedQueryKeys = new Set(['org'])

/**
 * Turn query parameters into capability input using the input JSON Schema:
 * numbers and booleans are coerced, and array inputs collect repeated keys
 * (`?tags=a&tags=b`). Values that do not fit are passed through so the
 * capability's own validation reports them. Auth-reserved keys such as
 * `org` are skipped so GET/DELETE with `?org=` do not fail strict schemas.
 */
export function readQueryParams(
	searchParams: URLSearchParams,
	inputSchema: JsonSchema,
) {
	const properties = isRecord(inputSchema['properties'])
		? (inputSchema['properties'] as Record<string, JsonSchema>)
		: {}
	const params: Record<string, unknown> = {}
	for (const name of new Set(searchParams.keys())) {
		if (apiAuthReservedQueryKeys.has(name)) continue
		const schema = properties[name]
		const values = searchParams.getAll(name)
		if (schemaTypes(schema).has('array')) {
			const items = isRecord(schema?.['items'])
				? (schema['items'] as JsonSchema)
				: undefined
			params[name] = values.map((value) => coerceScalar(value, items))
			continue
		}
		if (values.length > 1) {
			throw invalidRequest(`Query parameter "${name}" must appear once.`)
		}
		params[name] = coerceScalar(values[0]!, schema)
	}
	return params
}

export async function readJsonBody(request: Request) {
	const read = await readRequestBodyUpTo(request, maxApiRequestBodyBytes)
	if (!read.ok) {
		return { kind: 'too_large' as const, byteLength: read.byteLength }
	}
	const text = new TextDecoder().decode(read.bytes)
	if (!text.trim()) return { kind: 'ok' as const, body: {} }
	const contentType = request.headers.get('Content-Type') ?? ''
	if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType.trim())) {
		return { kind: 'unsupported_media_type' as const }
	}
	let body: unknown
	try {
		body = JSON.parse(text) as unknown
	} catch {
		throw invalidRequest('Request body must be valid JSON.')
	}
	if (!isRecord(body)) {
		throw invalidRequest('Request body must be a JSON object.')
	}
	return { kind: 'ok' as const, body }
}

/** Path params win; a conflicting body/query value is a caller error. */
export function mergeApiParams(
	pathParams: Record<string, string>,
	params: Record<string, unknown>,
) {
	for (const [name, value] of Object.entries(pathParams)) {
		if (name in params && params[name] !== value) {
			throw invalidRequest(
				`"${name}" is set by the URL path and must not differ in the query or body.`,
			)
		}
	}
	return { ...params, ...pathParams }
}

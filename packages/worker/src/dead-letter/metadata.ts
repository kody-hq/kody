/**
 * Redacted, admin-safe metadata for a dead-letter message body. Only shapes
 * and stable identifiers leave this module: never values that could carry
 * user content, message text, tokens, or secrets.
 */
export type DeadLetterPayloadType =
	| 'object'
	| 'array'
	| 'string'
	| 'number'
	| 'boolean'
	| 'null'
	| 'unserializable'

export type DeadLetterPayloadMetadata = {
	payloadType: DeadLetterPayloadType
	payloadBytes: number
	topLevelKeys: Array<string>
	topLevelKeyCount: number
	kind: string | null
	stableIds: Record<string, string>
}

export type SerializedDeadLetterBody = {
	bodyJson: string | null
	metadata: DeadLetterPayloadMetadata
}

const maxTopLevelKeys = 50
const maxStableIds = 10
const safeKeyNamePattern = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/
const kindKeys = ['kind', 'type', 'lane', 'eventType', 'event', 'action']
const kindValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/
const idKeyPattern = /(^id$|Id$|_id$|^uuid$)/
const sensitiveKeyPattern =
	/(token|secret|password|passwd|key|auth|cookie|session|signature|credential|email|phone|address)/i
const idValuePattern = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/

const textEncoder = new TextEncoder()

function payloadTypeOf(body: unknown): DeadLetterPayloadType {
	if (body === null) return 'null'
	if (Array.isArray(body)) return 'array'
	switch (typeof body) {
		case 'object':
			return 'object'
		case 'string':
			return 'string'
		case 'number':
			return 'number'
		case 'boolean':
			return 'boolean'
		default:
			return 'unserializable'
	}
}

function serializeBody(body: unknown): string | null {
	try {
		const json = JSON.stringify(body)
		return typeof json === 'string' ? json : null
	} catch {
		return null
	}
}

function stableIdValue(value: unknown): string | null {
	if (typeof value === 'string') {
		return idValuePattern.test(value) ? value : null
	}
	if (typeof value === 'number' && Number.isSafeInteger(value)) {
		return String(value)
	}
	return null
}

/**
 * Serializes a dead-letter body for replay storage and derives its redacted
 * metadata. Top-level key names are kept only when they look like
 * identifiers; values are kept only for a kind/type field and for id-shaped
 * fields whose name and value both look like stable identifiers.
 */
export function describeDeadLetterBody(
	body: unknown,
): SerializedDeadLetterBody {
	const bodyJson = serializeBody(body)
	const payloadType = bodyJson === null ? 'unserializable' : payloadTypeOf(body)
	const metadata: DeadLetterPayloadMetadata = {
		payloadType,
		payloadBytes: bodyJson === null ? 0 : textEncoder.encode(bodyJson).length,
		topLevelKeys: [],
		topLevelKeyCount: 0,
		kind: null,
		stableIds: {},
	}
	if (payloadType !== 'object') return { bodyJson, metadata }
	const record = body as Record<string, unknown>
	const keys = Object.keys(record)
	metadata.topLevelKeyCount = keys.length
	metadata.topLevelKeys = keys
		.filter((key) => safeKeyNamePattern.test(key))
		.slice(0, maxTopLevelKeys)
	for (const key of kindKeys) {
		const value = record[key]
		if (typeof value === 'string' && kindValuePattern.test(value)) {
			metadata.kind = value
			break
		}
	}
	for (const key of metadata.topLevelKeys) {
		if (Object.keys(metadata.stableIds).length >= maxStableIds) break
		if (!idKeyPattern.test(key) || sensitiveKeyPattern.test(key)) continue
		const value = stableIdValue(record[key])
		if (value !== null) metadata.stableIds[key] = value
	}
	return { bodyJson, metadata }
}

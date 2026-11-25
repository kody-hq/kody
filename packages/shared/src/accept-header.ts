import { mediaType } from './media-type.ts'

export type AcceptedMediaRange = { range: string; quality: number }

/** Splits on `separator` outside double-quoted strings (RFC 9110 quoted-string). */
function splitOutsideQuotes(value: string, separator: string) {
	const parts: Array<string> = []
	let current = ''
	let quoted = false
	for (let index = 0; index < value.length; index++) {
		const char = value[index]!
		if (quoted && char === '\\') {
			current += char + (value[index + 1] ?? '')
			index++
			continue
		}
		if (char === '"') quoted = !quoted
		if (!quoted && char === separator) {
			parts.push(current)
			current = ''
			continue
		}
		current += char
	}
	parts.push(current)
	return parts
}

/** Media ranges from an Accept header, in header order, with their `q` weight. */
export function parseAcceptHeader(accept: string | null | undefined) {
	const ranges: Array<AcceptedMediaRange> = []
	for (const entry of splitOutsideQuotes(accept ?? '', ',')) {
		const [rangePart = '', ...parameters] = splitOutsideQuotes(entry, ';')
		const range = mediaType(rangePart)
		if (!range) continue
		let quality = 1
		for (const parameter of parameters) {
			const separator = parameter.indexOf('=')
			if (separator === -1) continue
			const name = parameter.slice(0, separator).trim().toLowerCase()
			const value = parameter.slice(separator + 1).trim()
			if (name !== 'q' || !value) continue
			const parsed = Number(value)
			quality = Number.isFinite(parsed) ? parsed : 0
		}
		ranges.push({ range, quality })
	}
	return ranges
}

/** The weight the header gives this exact media type, or 0 when absent. */
export function acceptQuality(accept: string | null | undefined, type: string) {
	return Math.max(
		0,
		...parseAcceptHeader(accept)
			.filter((entry) => entry.range === type)
			.map((entry) => entry.quality),
	)
}

/**
 * The weight of the most specific range matching `type` (exact, then
 * `type/*`, then `*\/*`), or 0 when nothing matches.
 */
export function negotiatedAcceptQuality(
	accept: string | null | undefined,
	type: string,
) {
	const ranges = parseAcceptHeader(accept)
	const typeWildcard = `${type.split('/')[0]}/*`
	for (const candidate of [type, typeWildcard, '*/*']) {
		const matches = ranges.filter((entry) => entry.range === candidate)
		if (matches.length > 0) {
			return Math.max(0, ...matches.map((entry) => entry.quality))
		}
	}
	return 0
}

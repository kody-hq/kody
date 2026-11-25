import { mediaType } from './media-type.ts'

export type AcceptedMediaRange = { range: string; quality: number }

/** Media ranges from an Accept header, in header order, with their `q` weight. */
export function parseAcceptHeader(accept: string | null | undefined) {
	const ranges: Array<AcceptedMediaRange> = []
	for (const entry of (accept ?? '').split(',')) {
		const range = mediaType(entry)
		if (!range) continue
		let quality = 1
		for (const parameter of entry.split(';').slice(1)) {
			const [name, value] = parameter.split('=').map((part) => part.trim())
			if (name?.toLowerCase() !== 'q' || !value) continue
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

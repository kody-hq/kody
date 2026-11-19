/**
 * Read sealed paced D1 nights from the backup bucket: walk a chain back to its
 * full base, verify chain links, and stream table lines one part at a time.
 * Shared by the verify drill and the isolated restore.
 */
import {
	pacedD1BackupSchemaVersion,
	pacedD1RetentionTierForDay,
	pacedD1SealedDataKey,
	pacedD1SealedDataPartKey,
	pacedD1SealedIndexKey,
	pacedD1SealedIndexPartKey,
	pacedD1SealedManifestKey,
	parsePacedD1NightManifest,
	type PacedD1NightManifest,
	type PacedD1TableManifest,
} from './backup-d1-paced.ts'
import {
	hashPacedD1RowLine,
	parsePacedD1DataLine,
	sha256HexOfBytes,
	sha256HexOfText,
} from './backup-d1-paced-encode.ts'
import { isRecord } from './is-record.ts'
import { sha256Hex } from './sha256.ts'

export type PacedD1ObjectReader = {
	getText: (key: string) => Promise<{ text: string } | null>
	getBytes: (key: string) => Promise<Uint8Array | null>
}

export type PacedD1SourceRef = { id: string; name: string }

export type PacedD1PartsPointer = {
	schemaVersion: typeof pacedD1BackupSchemaVersion
	kind: 'paced-d1-parts'
	partCount: number
	dataSha256: string
	indexSha256: string
	dataPartDigests: Array<string>
	indexPartDigests: Array<string>
}

const sha256Pattern = /^[0-9a-f]{64}$/

export function parsePacedD1PartsPointer(
	text: string,
): PacedD1PartsPointer | null {
	const trimmed = text.trim()
	if (!trimmed.startsWith('{')) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed) as unknown
	} catch {
		return null
	}
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== pacedD1BackupSchemaVersion ||
		parsed.kind !== 'paced-d1-parts' ||
		!Number.isSafeInteger(parsed.partCount) ||
		(parsed.partCount as number) < 0 ||
		typeof parsed.dataSha256 !== 'string' ||
		!sha256Pattern.test(parsed.dataSha256) ||
		typeof parsed.indexSha256 !== 'string' ||
		!sha256Pattern.test(parsed.indexSha256) ||
		!Array.isArray(parsed.dataPartDigests) ||
		!Array.isArray(parsed.indexPartDigests) ||
		parsed.dataPartDigests.length !== parsed.partCount ||
		parsed.indexPartDigests.length !== parsed.partCount ||
		!parsed.dataPartDigests.every(
			(digest) => typeof digest === 'string' && sha256Pattern.test(digest),
		) ||
		!parsed.indexPartDigests.every(
			(digest) => typeof digest === 'string' && sha256Pattern.test(digest),
		)
	) {
		return null
	}
	return parsed as PacedD1PartsPointer
}

export async function loadSealedPacedD1Manifest(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	day: string
}): Promise<{
	manifest: PacedD1NightManifest
	raw: string
	key: string
} | null> {
	const tier = pacedD1RetentionTierForDay(input.day)
	const key = pacedD1SealedManifestKey(tier, input.source.id, input.day)
	const raw = await input.reader.getText(key)
	if (!raw) return null
	return {
		manifest: parsePacedD1NightManifest(JSON.parse(raw.text)),
		raw: raw.text,
		key,
	}
}

/**
 * Walk sealed nights backward until every table is covered by a `full` base
 * (or the chain ends). Returns oldest-first for apply.
 */
async function loadSealedPacedD1NightChain(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	day: string
}): Promise<
	Array<{ manifest: PacedD1NightManifest; raw: string; key: string }>
> {
	const chain: Array<{
		manifest: PacedD1NightManifest
		raw: string
		key: string
	}> = []
	let cursor: string | null = input.day
	const seen = new Set<string>()
	while (cursor) {
		if (seen.has(cursor)) {
			throw new Error(`paced D1 chain cycle at ${cursor}`)
		}
		seen.add(cursor)
		const night = await loadSealedPacedD1Manifest({
			reader: input.reader,
			source: input.source,
			day: cursor,
		})
		if (!night) {
			if (chain.length === 0) return []
			throw new Error(
				`paced D1 broken chain: missing sealed night ${cursor} for ${input.source.name}`,
			)
		}
		chain.push(night)
		const allFull = Object.values(night.manifest.tables).every(
			(table) => table.mode === 'full',
		)
		if (allFull || night.manifest.prevDay === null) break
		cursor = night.manifest.prevDay
	}
	return chain.reverse()
}

export type SealedPacedD1Night = { manifest: PacedD1NightManifest; key: string }

/** Load the chain oldest-first and verify every prevManifestSha256 link once. */
export async function loadVerifiedPacedD1NightChain(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	day: string
}): Promise<Array<SealedPacedD1Night>> {
	const chain = await loadSealedPacedD1NightChain(input)
	for (let index = 1; index < chain.length; index += 1) {
		const expectedPrev = await sha256Hex(chain[index - 1]!.raw)
		if (chain[index]!.manifest.prevManifestSha256 !== expectedPrev) {
			throw new Error(
				`CHAIN BROKEN: prevManifestSha256 mismatch at ${chain[index]!.manifest.day}`,
			)
		}
	}
	return chain.map(({ manifest, key }) => ({ manifest, key }))
}

/** Calls `onLine` for each complete line; returns the unterminated tail. */
function forEachCompleteLine(text: string, onLine: (line: string) => void) {
	let position = 0
	for (;;) {
		const newline = text.indexOf('\n', position)
		if (newline < 0) break
		if (newline > position) onLine(text.slice(position, newline))
		position = newline + 1
	}
	return text.slice(position)
}

/**
 * Stream one night's sealed table data line by line, one part body at a time.
 * Lines are handed to `onLine` and never retained here.
 */
export async function streamSealedPacedD1TableLines(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	day: string
	table: string
	tableManifest: PacedD1TableManifest
	onLine: (line: string) => void
	onPart?: () => Promise<void>
	/** Only stream parts in [start, end). Each part ends at a line boundary. */
	parts?: { start: number; end: number }
}): Promise<void> {
	const tier = pacedD1RetentionTierForDay(input.day)
	const dataKey = pacedD1SealedDataKey(
		tier,
		input.source.id,
		input.day,
		input.table,
	)
	const indexKey = pacedD1SealedIndexKey(
		tier,
		input.source.id,
		input.day,
		input.table,
	)
	const dataObj = await input.reader.getText(dataKey)
	if (!dataObj) {
		throw new Error(`paced D1 missing sealed data at ${dataKey}`)
	}
	const indexObj = await input.reader.getText(indexKey)
	if (!indexObj) {
		throw new Error(`paced D1 missing sealed index at ${indexKey}`)
	}

	const dataPointer = parsePacedD1PartsPointer(dataObj.text)
	const indexPointer = parsePacedD1PartsPointer(indexObj.text)

	if (!dataPointer) {
		if (input.parts && input.parts.start > 0) return
		if (
			(await sha256HexOfText(indexObj.text)) !== input.tableManifest.indexSha256
		) {
			throw new Error(
				`paced D1 index digest mismatch for ${input.source.name}.${input.table}`,
			)
		}
		if (
			(await sha256HexOfText(dataObj.text)) !== input.tableManifest.dataSha256
		) {
			throw new Error(
				`CORRUPT artifact ${input.table}: sha256 mismatch, refusing to restore`,
			)
		}
		const lines: Array<string> = []
		const tail = forEachCompleteLine(dataObj.text, (line) => lines.push(line))
		if (tail.length > 0) lines.push(tail)
		for (const line of lines) {
			const parsed = parsePacedD1DataLine(line)
			if (parsed.kind === 'U' && parsed.h !== '-') {
				if ((await hashPacedD1RowLine(parsed.row)) !== parsed.h) {
					throw new Error(`CORRUPT row in ${input.table}`)
				}
			}
			input.onLine(line)
		}
		return
	}

	if (!indexPointer || indexPointer.partCount !== dataPointer.partCount) {
		throw new Error(
			`paced D1 parts pointer mismatch for ${input.source.name}.${input.table}`,
		)
	}
	if (dataPointer.dataSha256 !== input.tableManifest.dataSha256) {
		throw new Error(
			`paced D1 parts data digest disagrees with manifest for ${input.source.name}.${input.table}`,
		)
	}
	if (indexPointer.indexSha256 !== input.tableManifest.indexSha256) {
		throw new Error(
			`paced D1 parts index digest disagrees with manifest for ${input.source.name}.${input.table}`,
		)
	}

	const chainSha = await sha256HexOfText(
		`${dataPointer.dataPartDigests.join('\n')}\n`,
	)
	if (chainSha !== input.tableManifest.dataSha256) {
		throw new Error(
			`paced D1 data parts chain digest mismatch for ${input.source.name}.${input.table}`,
		)
	}
	const indexChainSha = await sha256HexOfText(
		`${indexPointer.indexPartDigests.join('\n')}\n`,
	)
	if (indexChainSha !== input.tableManifest.indexSha256) {
		throw new Error(
			`paced D1 index parts chain digest mismatch for ${input.source.name}.${input.table}`,
		)
	}

	let residual = ''
	const end = Math.min(
		input.parts?.end ?? dataPointer.partCount,
		dataPointer.partCount,
	)
	for (
		let partIndex = input.parts?.start ?? 0;
		partIndex < end;
		partIndex += 1
	) {
		const partKey = pacedD1SealedDataPartKey(
			tier,
			input.source.id,
			input.day,
			input.table,
			partIndex,
		)
		const indexPartKey = pacedD1SealedIndexPartKey(
			tier,
			input.source.id,
			input.day,
			input.table,
			partIndex,
		)
		// Index part first so only one part body is alive at a time.
		const indexBytes = await input.reader.getBytes(indexPartKey)
		if (!indexBytes) {
			throw new Error(
				`paced D1 missing index part ${partIndex} at ${indexPartKey}`,
			)
		}
		const indexDigest = await sha256HexOfBytes(indexBytes)
		if (indexDigest !== indexPointer.indexPartDigests[partIndex]) {
			throw new Error(
				`paced D1 index part ${partIndex} digest mismatch for ${input.source.name}.${input.table}`,
			)
		}
		const dataBytes = await input.reader.getBytes(partKey)
		if (!dataBytes) {
			throw new Error(`paced D1 missing data part ${partIndex} at ${partKey}`)
		}
		const dataDigest = await sha256HexOfBytes(dataBytes)
		if (dataDigest !== dataPointer.dataPartDigests[partIndex]) {
			throw new Error(
				`paced D1 data part ${partIndex} digest mismatch for ${input.source.name}.${input.table}`,
			)
		}
		residual = forEachCompleteLine(
			residual + new TextDecoder().decode(dataBytes),
			input.onLine,
		)
		await input.onPart?.()
	}
	if (residual.length > 0) {
		if (input.parts) {
			throw new Error(
				`paced D1 part ${end - 1} does not end at a line boundary for ${input.source.name}.${input.table}`,
			)
		}
		input.onLine(residual)
	}
}

/** Parts in one sealed table data object (1 when it is not split). */
export async function readPacedD1TablePartCount(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	day: string
	table: string
}): Promise<number> {
	const key = pacedD1SealedDataKey(
		pacedD1RetentionTierForDay(input.day),
		input.source.id,
		input.day,
		input.table,
	)
	const data = await input.reader.getText(key)
	if (!data) throw new Error(`paced D1 missing sealed data at ${key}`)
	return parsePacedD1PartsPointer(data.text)?.partCount ?? 1
}

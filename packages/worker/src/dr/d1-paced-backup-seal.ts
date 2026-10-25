import {
	pacedD1BackupSchemaVersion,
	pacedD1RetentionTierForDay,
	pacedD1SealedDataKey,
	pacedD1SealedDataPartKey,
	pacedD1SealedIndexKey,
	pacedD1SealedIndexPartKey,
	pacedD1SealedManifestKey,
	pacedD1StagingDataKey,
	pacedD1StagingDataPartKey,
	pacedD1StagingIndexKey,
	pacedD1StagingIndexPartKey,
	pacedD1StagingManifestKey,
	parsePacedD1NightManifest,
	type PacedD1NightManifest,
	type PacedD1RetentionTier,
} from '@kody-internal/shared/backup-d1-paced.ts'
import {
	sha256HexOfBytes,
	sha256HexOfText,
} from '@kody-internal/shared/backup-d1-paced-encode.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import {
	DrBackupPreconditionFailedError,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { type PacedD1SourceConfig } from '#worker/dr/d1-paced-backup-sources.ts'

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

async function putImmutable(
	s3: DrBackupS3Client,
	key: string,
	body: string | Uint8Array,
	contentType: string,
): Promise<Uint8Array> {
	const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
	try {
		await s3.put(key, bytes, { contentType, ifNoneMatch: '*' })
		return bytes
	} catch (error) {
		if (!(error instanceof DrBackupPreconditionFailedError)) throw error
		const existing = await s3.getBytes(key)
		if (!existing) {
			throw new Error(`paced D1 sealed object disappeared: ${key}`)
		}
		if (
			existing.byteLength !== bytes.byteLength ||
			!existing.every((value, index) => value === bytes[index])
		) {
			throw new Error(`paced D1 sealed object content mismatch: ${key}`)
		}
		return existing
	}
}

async function readStagingBytes(input: {
	s3: DrBackupS3Client
	stagingKey: string
}): Promise<Uint8Array> {
	const bytes = await input.s3.getBytes(input.stagingKey)
	if (!bytes) {
		throw new Error(`paced D1 missing staging object: ${input.stagingKey}`)
	}
	return bytes
}

async function verifyMonolithicSha(
	bytes: Uint8Array,
	expected: string,
	label: string,
) {
	const actual = await sha256HexOfBytes(bytes)
	if (actual !== expected) {
		throw new Error(
			`paced D1 seal verify failed for ${label}: sha256 ${actual} vs ${expected}`,
		)
	}
}

/**
 * Verify staging digests before writing immutable sealed keys. Writing first
 * and verifying after leaves a poisoned sealed object that blocks every reseal
 * until an operator deletes it by hand.
 */
async function sealVerifiedStagingBytes(input: {
	s3: DrBackupS3Client
	stagingKey: string
	sealedKey: string
	contentType: string
	expectedSha: string
	label: string
}): Promise<Uint8Array> {
	const bytes = await readStagingBytes({
		s3: input.s3,
		stagingKey: input.stagingKey,
	})
	await verifyMonolithicSha(bytes, input.expectedSha, input.label)
	return putImmutable(input.s3, input.sealedKey, bytes, input.contentType)
}

async function sealTableArtifacts(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
	tier: PacedD1RetentionTier
	table: string
	dataSha256: string
	indexSha256: string
}): Promise<void> {
	const stagingDataKey = pacedD1StagingDataKey(
		input.day,
		input.source.name,
		input.table,
	)
	const stagingIndexKey = pacedD1StagingIndexKey(
		input.day,
		input.source.name,
		input.table,
	)
	const sealedDataKey = pacedD1SealedDataKey(
		input.tier,
		input.source.id,
		input.day,
		input.table,
	)
	const sealedIndexKey = pacedD1SealedIndexKey(
		input.tier,
		input.source.id,
		input.day,
		input.table,
	)

	const stagingDataText = await input.s3.getText(stagingDataKey)
	const stagingIndexText = await input.s3.getText(stagingIndexKey)
	if (!stagingDataText || !stagingIndexText) {
		throw new Error(
			`paced D1 missing staging data/index for ${input.source.name}.${input.table}`,
		)
	}

	const dataPointer = parsePacedD1PartsPointer(stagingDataText.text)
	const indexPointer = parsePacedD1PartsPointer(stagingIndexText.text)
	if (dataPointer || indexPointer) {
		if (
			!dataPointer ||
			!indexPointer ||
			dataPointer.partCount !== indexPointer.partCount ||
			dataPointer.dataSha256 !== indexPointer.dataSha256 ||
			dataPointer.indexSha256 !== indexPointer.indexSha256
		) {
			throw new Error(
				`paced D1 parts pointer mismatch for ${input.source.name}.${input.table}`,
			)
		}
		if (
			dataPointer.dataSha256 !== input.dataSha256 ||
			dataPointer.indexSha256 !== input.indexSha256
		) {
			throw new Error(
				`paced D1 parts pointer digests disagree with manifest for ${input.source.name}.${input.table}`,
			)
		}

		const dataPartDigests: Array<string> = []
		const indexPartDigests: Array<string> = []
		for (let partIndex = 0; partIndex < dataPointer.partCount; partIndex += 1) {
			const dataExpected = dataPointer.dataPartDigests[partIndex]
			const indexExpected = dataPointer.indexPartDigests[partIndex]
			if (!dataExpected || !indexExpected) {
				throw new Error(
					`paced D1 parts pointer missing digest for ${input.source.name}.${input.table} part ${partIndex}`,
				)
			}
			// Sequential: verify-before-write one part body at a time (large
			// APP/AUDIT parts previously spiked when data+index loaded together).
			const dataPart = await sealVerifiedStagingBytes({
				s3: input.s3,
				stagingKey: pacedD1StagingDataPartKey(
					input.day,
					input.source.name,
					input.table,
					partIndex,
				),
				sealedKey: pacedD1SealedDataPartKey(
					input.tier,
					input.source.id,
					input.day,
					input.table,
					partIndex,
				),
				contentType: 'text/tab-separated-values',
				expectedSha: dataExpected,
				label: `${input.source.name}.${input.table} data part ${partIndex}`,
			})
			dataPartDigests.push(await sha256HexOfBytes(dataPart))

			const indexPart = await sealVerifiedStagingBytes({
				s3: input.s3,
				stagingKey: pacedD1StagingIndexPartKey(
					input.day,
					input.source.name,
					input.table,
					partIndex,
				),
				sealedKey: pacedD1SealedIndexPartKey(
					input.tier,
					input.source.id,
					input.day,
					input.table,
					partIndex,
				),
				contentType: 'text/tab-separated-values',
				expectedSha: indexExpected,
				label: `${input.source.name}.${input.table} index part ${partIndex}`,
			})
			indexPartDigests.push(await sha256HexOfBytes(indexPart))
		}

		const dataSha256 = await sha256HexOfText(`${dataPartDigests.join('\n')}\n`)
		const indexSha256 = await sha256HexOfText(
			`${indexPartDigests.join('\n')}\n`,
		)
		if (dataSha256 !== input.dataSha256 || indexSha256 !== input.indexSha256) {
			throw new Error(
				`paced D1 sealed parts chain digest mismatch for ${input.source.name}.${input.table}`,
			)
		}

		await Promise.all([
			putImmutable(
				input.s3,
				sealedDataKey,
				stagingDataText.text,
				'application/json',
			),
			putImmutable(
				input.s3,
				sealedIndexKey,
				stagingIndexText.text,
				'application/json',
			),
		])
		return
	}

	// Legacy monolithic staging bodies (pre-parts-pointer nights). Sequential
	// verify-before-write so reseal never holds data+index together.
	await sealVerifiedStagingBytes({
		s3: input.s3,
		stagingKey: stagingDataKey,
		sealedKey: sealedDataKey,
		contentType: 'text/tab-separated-values',
		expectedSha: input.dataSha256,
		label: `${input.source.name}.${input.table} data`,
	})
	await sealVerifiedStagingBytes({
		s3: input.s3,
		stagingKey: stagingIndexKey,
		sealedKey: sealedIndexKey,
		contentType: 'text/tab-separated-values',
		expectedSha: input.indexSha256,
		label: `${input.source.name}.${input.table} index`,
	})
}

export type SealPacedD1SourceNightResult = {
	day: string
	databaseName: string
	databaseId: string
	tier: PacedD1RetentionTier
	manifestKey: string
	alreadySealed: boolean
	tablesSealed: number
	/** False when a time budget stopped the seal before the sealed manifest. */
	complete: boolean
}

/**
 * Copy a finished staging night to the immutable sealed prefix. Idempotent:
 * existing sealed objects must byte-match (If-None-Match: *). Table copies
 * can span ticks — pass `timeBudgetMs` so catch-up does not OOM/timeout while
 * sealing a large APP night; the sealed manifest is written only when every
 * table has been copied.
 */
export async function sealPacedD1SourceNight(input: {
	s3: DrBackupS3Client
	source: PacedD1SourceConfig
	day: string
	manifest?: PacedD1NightManifest
	startedAtMs?: number
	timeBudgetMs?: number
}): Promise<SealPacedD1SourceNightResult> {
	const tier = pacedD1RetentionTierForDay(input.day)
	const sealedManifestKey = pacedD1SealedManifestKey(
		tier,
		input.source.id,
		input.day,
	)
	const existingSealed = await input.s3.head(sealedManifestKey)
	const startedAtMs = input.startedAtMs ?? Date.now()
	const timeBudgetMs = input.timeBudgetMs

	let manifest = input.manifest
	let manifestBody: string
	if (manifest) {
		manifestBody = `${JSON.stringify(manifest, null, 1)}\n`
	} else {
		const staging = await input.s3.getText(
			pacedD1StagingManifestKey(input.day, input.source.name),
		)
		if (!staging) {
			throw new Error(
				`paced D1 missing staging manifest for ${input.source.name} on ${input.day}`,
			)
		}
		manifest = parsePacedD1NightManifest(JSON.parse(staging.text))
		manifestBody = staging.text.endsWith('\n')
			? staging.text
			: `${staging.text}\n`
	}

	if (
		manifest.day !== input.day ||
		manifest.databaseName !== input.source.name ||
		manifest.databaseId.toLowerCase() !== input.source.id.toLowerCase()
	) {
		throw new Error(
			`paced D1 seal identity mismatch for ${input.source.name} on ${input.day}`,
		)
	}

	let tablesSealed = 0
	for (const [table, tableManifest] of Object.entries(manifest.tables)) {
		if (
			timeBudgetMs !== undefined &&
			Date.now() - startedAtMs >= timeBudgetMs
		) {
			return {
				day: input.day,
				databaseName: input.source.name,
				databaseId: input.source.id,
				tier,
				manifestKey: sealedManifestKey,
				alreadySealed: existingSealed.exists,
				tablesSealed,
				complete: false,
			}
		}
		await sealTableArtifacts({
			s3: input.s3,
			source: input.source,
			day: input.day,
			tier,
			table,
			dataSha256: tableManifest.dataSha256,
			indexSha256: tableManifest.indexSha256,
		})
		tablesSealed += 1
	}

	await putImmutable(
		input.s3,
		sealedManifestKey,
		manifestBody,
		'application/json',
	)

	return {
		day: input.day,
		databaseName: input.source.name,
		databaseId: input.source.id,
		tier,
		manifestKey: sealedManifestKey,
		alreadySealed: existingSealed.exists,
		tablesSealed,
		complete: true,
	}
}

/**
 * Assemble sealed (or staging) table data into a single TSV body. When the
 * object is a parts pointer, concatenates part files in order and verifies
 * the chain digest against the expected sha.
 */
export async function loadPacedD1TableDataBody(input: {
	s3: DrBackupS3Client
	location: 'sealed' | 'staging'
	day: string
	databaseName: string
	databaseId: string
	table: string
	expectedSha256: string
	kind: 'data' | 'index'
}): Promise<string> {
	const tier = pacedD1RetentionTierForDay(input.day)
	const key =
		input.location === 'sealed'
			? input.kind === 'data'
				? pacedD1SealedDataKey(tier, input.databaseId, input.day, input.table)
				: pacedD1SealedIndexKey(tier, input.databaseId, input.day, input.table)
			: input.kind === 'data'
				? pacedD1StagingDataKey(input.day, input.databaseName, input.table)
				: pacedD1StagingIndexKey(input.day, input.databaseName, input.table)

	const text = await input.s3.getText(key)
	if (!text) {
		throw new Error(`paced D1 missing ${input.kind} artifact at ${key}`)
	}
	const pointer = parsePacedD1PartsPointer(text.text)
	if (!pointer) {
		const sha = await sha256HexOfText(text.text)
		if (sha !== input.expectedSha256) {
			throw new Error(
				`paced D1 ${input.kind} sha256 mismatch for ${input.databaseName}.${input.table}`,
			)
		}
		return text.text
	}

	const expectedChain =
		input.kind === 'data' ? pointer.dataSha256 : pointer.indexSha256
	if (expectedChain !== input.expectedSha256) {
		throw new Error(
			`paced D1 parts pointer ${input.kind} digest disagrees with manifest for ${input.databaseName}.${input.table}`,
		)
	}

	const digests: Array<string> = []
	const chunks: Array<Uint8Array> = []
	for (let partIndex = 0; partIndex < pointer.partCount; partIndex += 1) {
		const partKey =
			input.location === 'sealed'
				? input.kind === 'data'
					? pacedD1SealedDataPartKey(
							tier,
							input.databaseId,
							input.day,
							input.table,
							partIndex,
						)
					: pacedD1SealedIndexPartKey(
							tier,
							input.databaseId,
							input.day,
							input.table,
							partIndex,
						)
				: input.kind === 'data'
					? pacedD1StagingDataPartKey(
							input.day,
							input.databaseName,
							input.table,
							partIndex,
						)
					: pacedD1StagingIndexPartKey(
							input.day,
							input.databaseName,
							input.table,
							partIndex,
						)
		const bytes = await input.s3.getBytes(partKey)
		if (!bytes) {
			throw new Error(
				`paced D1 missing ${input.kind} part ${partIndex} at ${partKey}`,
			)
		}
		const digest = await sha256HexOfBytes(bytes)
		const expected =
			input.kind === 'data'
				? pointer.dataPartDigests[partIndex]
				: pointer.indexPartDigests[partIndex]
		if (digest !== expected) {
			throw new Error(
				`paced D1 ${input.kind} part ${partIndex} digest mismatch for ${input.databaseName}.${input.table}`,
			)
		}
		digests.push(digest)
		chunks.push(bytes)
	}
	const chainSha = await sha256HexOfText(`${digests.join('\n')}\n`)
	if (chainSha !== input.expectedSha256) {
		throw new Error(
			`paced D1 ${input.kind} parts chain digest mismatch for ${input.databaseName}.${input.table}`,
		)
	}
	let total = 0
	for (const chunk of chunks) total += chunk.byteLength
	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(out)
}

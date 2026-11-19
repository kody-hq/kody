/** Test fixture: a sealed paced chain (2-part full base plus one delta). */
import {
	addPacedD1Checksum,
	hashPacedD1RowLine,
	sha256HexOfText,
} from './backup-d1-paced-encode.ts'
import type { PacedD1ObjectReader } from './backup-d1-paced-read.ts'
import {
	pacedD1BackupSchemaVersion,
	pacedD1RetentionTierForDay,
	pacedD1SealedDataKey,
	pacedD1SealedDataPartKey,
	pacedD1SealedIndexKey,
	pacedD1SealedIndexPartKey,
	pacedD1SealedManifestKey,
	type PacedD1NightManifest,
	type PacedD1TableManifest,
} from './backup-d1-paced.ts'

export const pacedTestSource = {
	id: '8c1014d1-6b41-4695-a0a2-159071f0f919',
	name: 'kody',
}
export const pacedTestTable = 'items'
export const pacedTestBaseDay = '2026-11-15'
export const pacedTestTipDay = '2026-11-16'

async function upsert(rowid: number, version: number) {
	const row = `[${rowid},"v${version}"]`
	return {
		line: `U\t${await hashPacedD1RowLine(row)}\t[${rowid}]\t${row}\n`,
		hash: await hashPacedD1RowLine(row),
	}
}

function manifestFor(
	day: string,
	prev: { day: string; sha: string } | null,
	tableManifest: PacedD1TableManifest,
): PacedD1NightManifest {
	return {
		schemaVersion: pacedD1BackupSchemaVersion,
		databaseName: pacedTestSource.name,
		databaseId: pacedTestSource.id,
		day,
		retentionTier: pacedD1RetentionTierForDay(day),
		startedAt: `${day}T01:00:00.000Z`,
		finishedAt: `${day}T02:00:00.000Z`,
		prevDay: prev?.day ?? null,
		prevManifestSha256: prev?.sha ?? null,
		schemaHash: '0'.repeat(64),
		schemaStableDuringWalk: true,
		timeTravelBookmark: null,
		extras: [
			{
				type: 'index',
				name: 'items_body',
				table: 'items',
				sql: 'CREATE INDEX items_body ON items(body)',
			},
		],
		sqliteSequence: [],
		tables: { [pacedTestTable]: tableManifest },
		stats: {
			wallMs: 0,
			queries: 0,
			rowsRead: 0,
			d1RowsRead: 0,
			bytesOut: 0,
			queryMs: { p50: 0, p95: 0, p99: 0, max: 0, sum: 0 },
			dbTimeShare: 0,
		},
		shadow: false,
	}
}

function tableManifest(
	mode: 'full' | 'delta',
	values: Partial<PacedD1TableManifest>,
): PacedD1TableManifest {
	return {
		mode,
		schemaHash: '0'.repeat(64),
		sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)',
		cols: ['id', 'body'],
		pk: ['rowid'],
		declaredPk: ['id'],
		count: 0,
		checksum: '0'.repeat(16),
		upserts: 0,
		deletes: 0,
		dataSha256: '0'.repeat(64),
		indexSha256: '0'.repeat(64),
		...values,
	}
}

function sumOf(hashes: Array<string>) {
	return hashes.reduce(
		(sum, hash) => addPacedD1Checksum(sum, hash),
		'0'.repeat(16),
	)
}

export async function buildSealedPacedChain() {
	const objects = new Map<string, string>()
	const baseTier = pacedD1RetentionTierForDay(pacedTestBaseDay)
	const rows = await Promise.all([1, 2, 3, 4].map((rowid) => upsert(rowid, 1)))
	const parts = [rows[0]!.line + rows[1]!.line, rows[2]!.line + rows[3]!.line]
	const dataDigests = await Promise.all(
		parts.map((part) => sha256HexOfText(part)),
	)
	const indexParts = ['i0\n', 'i1\n']
	const indexDigests = await Promise.all(
		indexParts.map((part) => sha256HexOfText(part)),
	)
	const dataSha256 = await sha256HexOfText(`${dataDigests.join('\n')}\n`)
	const indexSha256 = await sha256HexOfText(`${indexDigests.join('\n')}\n`)
	const pointer = JSON.stringify({
		schemaVersion: pacedD1BackupSchemaVersion,
		kind: 'paced-d1-parts',
		partCount: 2,
		dataSha256,
		indexSha256,
		dataPartDigests: dataDigests,
		indexPartDigests: indexDigests,
	})
	objects.set(
		pacedD1SealedDataKey(
			baseTier,
			pacedTestSource.id,
			pacedTestBaseDay,
			pacedTestTable,
		),
		pointer,
	)
	objects.set(
		pacedD1SealedIndexKey(
			baseTier,
			pacedTestSource.id,
			pacedTestBaseDay,
			pacedTestTable,
		),
		pointer,
	)
	parts.forEach((part, index) => {
		objects.set(
			pacedD1SealedDataPartKey(
				baseTier,
				pacedTestSource.id,
				pacedTestBaseDay,
				pacedTestTable,
				index,
			),
			part,
		)
		objects.set(
			pacedD1SealedIndexPartKey(
				baseTier,
				pacedTestSource.id,
				pacedTestBaseDay,
				pacedTestTable,
				index,
			),
			indexParts[index]!,
		)
	})
	const baseManifest = JSON.stringify(
		manifestFor(
			pacedTestBaseDay,
			null,
			tableManifest('full', { count: 4, dataSha256, indexSha256 }),
		),
	)
	objects.set(
		pacedD1SealedManifestKey(baseTier, pacedTestSource.id, pacedTestBaseDay),
		baseManifest,
	)

	const tipTier = pacedD1RetentionTierForDay(pacedTestTipDay)
	const changed = await upsert(2, 2)
	const added = await upsert(5, 2)
	const delta = `${changed.line}D\t[3]\n${added.line}`
	const deltaIndex = 'delta-index\n'
	objects.set(
		pacedD1SealedDataKey(
			tipTier,
			pacedTestSource.id,
			pacedTestTipDay,
			pacedTestTable,
		),
		delta,
	)
	objects.set(
		pacedD1SealedIndexKey(
			tipTier,
			pacedTestSource.id,
			pacedTestTipDay,
			pacedTestTable,
		),
		deltaIndex,
	)
	const expectedHashes = [
		rows[0]!.hash,
		changed.hash,
		rows[3]!.hash,
		added.hash,
	]
	objects.set(
		pacedD1SealedManifestKey(tipTier, pacedTestSource.id, pacedTestTipDay),
		JSON.stringify(
			manifestFor(
				pacedTestTipDay,
				{ day: pacedTestBaseDay, sha: await sha256HexOfText(baseManifest) },
				tableManifest('delta', {
					count: 4,
					checksum: sumOf(expectedHashes),
					upserts: 2,
					deletes: 1,
					dataSha256: await sha256HexOfText(delta),
					indexSha256: await sha256HexOfText(deltaIndex),
				}),
			),
		),
	)
	const reads: Array<string> = []
	const reader: PacedD1ObjectReader = {
		async getText(key) {
			reads.push(key)
			const text = objects.get(key)
			return text === undefined ? null : { text }
		},
		async getBytes(key) {
			reads.push(key)
			const text = objects.get(key)
			return text === undefined ? null : new TextEncoder().encode(text)
		},
	}
	return { reader, reads, objects, expectedChecksum: sumOf(expectedHashes) }
}

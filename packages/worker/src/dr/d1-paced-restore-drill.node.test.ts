import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import v8 from 'node:v8'
import vm from 'node:vm'
import { expect, test } from 'vitest'
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
} from '@kody-internal/shared/backup-d1-paced.ts'
import { sha256HexOfBytes } from '@kody-internal/shared/backup-d1-paced-encode.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import type { DrBackupS3Client } from '#worker/dr/backup-s3.ts'
import { runD1PacedRestoreDrillTick } from '#worker/dr/d1-paced-restore-drill.ts'
import { readLatestD1PacedRestoreDrill } from '#worker/dr/d1-paced-restore-drill-progress.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

/**
 * Realistic-size memory harness for the weekly drill. The Nov 1 2026 drill
 * OOMed (128 MB isolate) on APP_DB; this replays a ~150 MB parts-backed full
 * base plus a delta night and asserts retained heap stays bounded by one part
 * body plus the delta's touched rows, not the table size.
 */

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void

const sourceId = '8c1014d1-6b41-4695-a0a2-159071f0f919'
const baseDay = '2026-10-30'
const tipDay = '2026-10-31'
const table = 'big_rows'
const partCount = 100
const rowsPerPart = 3_000
const baseRows = partCount * rowsPerPart
// ~500-byte rows -> ~1.5 MB per part (pacedD1BackupDefaultMaxPageBytes).
const rowPadding = 'x'.repeat(460)
const deltaUpserts = 20_000
const deltaDeletes = 5_000
const deltaAdds = 10_000

const mask = 0xffffffffffffffffn
const encoder = new TextEncoder()
const zeroHash = '0'.repeat(64)

function rowHash(rowid: number, version: number) {
	let value =
		BigInt(rowid) * 0x9e3779b97f4a7c15n + BigInt(version) * 0xbf58476d1ce4e5b9n
	value = (value ^ (value >> 31n)) & mask
	return value
}

function upsertLine(rowid: number, version: number) {
	const h = `${rowHash(rowid, version).toString(16).padStart(16, '0')}${'0'.repeat(48)}`
	return `U\t${h}\t[${rowid}]\t[${rowid},"v${version}-${rowPadding}"]`
}

/**
 * Lines are newline-prefixed (except the first) so every part boundary splits
 * a line terminator into the next part, exercising the residual carry.
 */
function basePartText(partIndex: number) {
	const lines: Array<string> = []
	const first = partIndex * rowsPerPart + 1
	for (let rowid = first; rowid < first + rowsPerPart; rowid += 1) {
		lines.push(upsertLine(rowid, 1))
	}
	const body = lines.join('\n')
	const prefixed = partIndex === 0 ? body : `\n${body}`
	return partIndex === partCount - 1 ? `${prefixed}\n` : prefixed
}

function deltaText() {
	const lines: Array<string> = []
	for (let rowid = 1; rowid <= deltaUpserts; rowid += 1) {
		lines.push(upsertLine(rowid, 2))
	}
	for (let rowid = baseRows - deltaDeletes + 1; rowid <= baseRows; rowid += 1) {
		lines.push(`D\t[${rowid}]`)
	}
	for (let rowid = baseRows + 1; rowid <= baseRows + deltaAdds; rowid += 1) {
		lines.push(upsertLine(rowid, 2))
	}
	return `${lines.join('\n')}\n`
}

function expectedTip() {
	let sum = 0n
	let count = 0
	const add = (rowid: number, version: number) => {
		sum = (sum + rowHash(rowid, version)) & mask
		count += 1
	}
	for (let rowid = 1; rowid <= baseRows - deltaDeletes; rowid += 1) {
		add(rowid, rowid <= deltaUpserts ? 2 : 1)
	}
	for (let rowid = baseRows + 1; rowid <= baseRows + deltaAdds; rowid += 1) {
		add(rowid, 2)
	}
	return { count, checksum: sum.toString(16).padStart(16, '0') }
}

type Generated = () => Uint8Array

/** S3 whose large part bodies are generated on read (never stored). */
async function createProceduralS3() {
	const objects = new Map<string, Generated>()
	const heapSamples: Array<number> = []
	const putStatic = (key: string, text: string) => {
		const bytes = encoder.encode(text)
		objects.set(key, () => bytes)
	}
	const tableManifest = (
		mode: 'full' | 'delta',
		values: Partial<PacedD1TableManifest>,
	): PacedD1TableManifest => ({
		mode,
		schemaHash: zeroHash,
		sql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, body TEXT)`,
		cols: ['id', 'body'],
		pk: ['rowid'],
		declaredPk: ['id'],
		count: 0,
		checksum: '0'.repeat(16),
		upserts: 0,
		deletes: 0,
		dataSha256: zeroHash,
		indexSha256: zeroHash,
		...values,
	})
	const manifestFor = (
		day: string,
		prevDay: string | null,
		prevManifestSha256: string | null,
		tables: Record<string, PacedD1TableManifest>,
	): PacedD1NightManifest => ({
		schemaVersion: pacedD1BackupSchemaVersion,
		databaseName: 'kody',
		databaseId: sourceId,
		day,
		retentionTier: pacedD1RetentionTierForDay(day),
		startedAt: `${day}T01:00:00.000Z`,
		finishedAt: `${day}T02:00:00.000Z`,
		prevDay,
		prevManifestSha256,
		schemaHash: zeroHash,
		schemaStableDuringWalk: true,
		timeTravelBookmark: null,
		extras: [],
		sqliteSequence: [],
		tables,
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
	})

	async function putPartsNight(input: {
		day: string
		parts: Array<() => string>
	}) {
		const tier = pacedD1RetentionTierForDay(input.day)
		const dataDigests: Array<string> = []
		const indexDigests: Array<string> = []
		for (const [index, part] of input.parts.entries()) {
			dataDigests.push(await sha256HexOfBytes(encoder.encode(part())))
			const indexBytes = encoder.encode(`index-${input.day}-${index}\n`)
			indexDigests.push(await sha256HexOfBytes(indexBytes))
			objects.set(
				pacedD1SealedDataPartKey(tier, sourceId, input.day, table, index),
				() => {
					gc()
					heapSamples.push(process.memoryUsage().heapUsed)
					return encoder.encode(part())
				},
			)
			objects.set(
				pacedD1SealedIndexPartKey(tier, sourceId, input.day, table, index),
				() => indexBytes,
			)
		}
		const dataSha256 = await sha256Hex(`${dataDigests.join('\n')}\n`)
		const indexSha256 = await sha256Hex(`${indexDigests.join('\n')}\n`)
		const pointer = (kind: 'data' | 'index') =>
			JSON.stringify({
				schemaVersion: pacedD1BackupSchemaVersion,
				kind: 'paced-d1-parts',
				partCount: input.parts.length,
				dataSha256,
				indexSha256,
				dataPartDigests: dataDigests,
				indexPartDigests: indexDigests,
				pointerFor: kind,
			})
		putStatic(
			pacedD1SealedDataKey(tier, sourceId, input.day, table),
			pointer('data'),
		)
		putStatic(
			pacedD1SealedIndexKey(tier, sourceId, input.day, table),
			pointer('index'),
		)
		return { dataSha256, indexSha256 }
	}

	const base = await putPartsNight({
		day: baseDay,
		parts: Array.from(
			{ length: partCount },
			(_, index) => () => basePartText(index),
		),
	})
	const baseManifest = JSON.stringify(
		manifestFor(baseDay, null, null, {
			[table]: tableManifest('full', { count: baseRows, ...base }),
		}),
	)
	putStatic(
		pacedD1SealedManifestKey(
			pacedD1RetentionTierForDay(baseDay),
			sourceId,
			baseDay,
		),
		baseManifest,
	)
	const deltaBody = deltaText()
	const delta = await putPartsNight({
		day: tipDay,
		parts: [() => deltaBody],
	})
	const expected = expectedTip()
	putStatic(
		pacedD1SealedManifestKey(
			pacedD1RetentionTierForDay(tipDay),
			sourceId,
			tipDay,
		),
		JSON.stringify(
			manifestFor(tipDay, baseDay, await sha256Hex(baseManifest), {
				[table]: tableManifest('delta', {
					count: expected.count,
					checksum: expected.checksum,
					upserts: deltaUpserts + deltaAdds,
					deletes: deltaDeletes,
					...delta,
				}),
			}),
		),
	)

	const client: DrBackupS3Client = {
		async head(key) {
			return objects.has(key)
				? { exists: true, status: 200, etag: '"x"' }
				: { exists: false, status: 404, etag: null }
		},
		async getText(key) {
			const object = objects.get(key)
			return object
				? { text: new TextDecoder().decode(object()), etag: '"x"' }
				: null
		},
		async getBytes(key) {
			return objects.get(key)?.() ?? null
		},
		async put(key, body) {
			const bytes = typeof body === 'string' ? encoder.encode(body) : body
			objects.set(key, () => bytes)
			return { etag: '"x"' }
		},
	}
	return { client, heapSamples, expected }
}

function createProgressDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0237-dr-paced-restore-drill-progress.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return createD1FromSqlite(sqlite)
}

test(
	'restore drill keeps retained heap bounded on a ~150 MB parts table',
	{ timeout: 120_000 },
	async () => {
		const { client, heapSamples, expected } = await createProceduralS3()
		const appDb = createProgressDb()
		const env = {
			DR_D1_PACED_BACKUP_ENABLED: 'true',
			DR_D1_PACED_RESTORE_DRILL_ENABLED: 'true',
			DR_BACKUP_ACCOUNT_ID: 'acct',
			DR_BACKUP_BUCKET_NAME: 'bucket',
			DR_BACKUP_ACCESS_KEY_ID: 'key',
			DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
			DR_D1_PACED_SOURCES: JSON.stringify([
				{ binding: 'APP_DB', name: 'kody', id: sourceId },
			]),
			APP_DB: appDb,
		} as unknown as Env

		gc()
		const baseline = process.memoryUsage().heapUsed
		const drill = await runD1PacedRestoreDrillTick({
			env,
			now: new Date(`${tipDay}T07:05:00.000Z`),
			s3: client,
			day: tipDay,
		})

		expect(drill).toMatchObject({
			complete: true,
			sourcesChecked: 1,
			sourcesOk: 1,
		})
		expect(drill.sources[0]?.tables[0]).toMatchObject({
			table,
			manifestCount: expected.count,
			restoredCount: expected.count,
			ok: true,
		})
		// One sample per data part read (100 base parts + 1 delta part).
		expect(heapSamples).toHaveLength(partCount + 1)
		const peakRetainedMb = (Math.max(...heapSamples) - baseline) / 1024 / 1024
		const totalDataMb = (baseRows * upsertLine(1, 1).length) / 1024 / 1024
		expect(totalDataMb).toBeGreaterThan(140)
		// Worker isolates have 128 MB; the drill must not scale with table size.
		expect(peakRetainedMb).toBeLessThan(24)

		const progress = await readLatestD1PacedRestoreDrill(appDb)
		expect(progress?.run).toMatchObject({ day: tipDay, status: 'passed' })
		expect(progress?.sources[0]).toMatchObject({
			databaseName: 'kody',
			status: 'passed',
			activePhase: null,
		})
	},
)

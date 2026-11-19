/**
 * Replay a sealed paced D1 chain into one D1 database through the import API,
 * one workflow step per restore unit, then verify the target against the
 * sealed tip manifest by re-hashing every restored row. Shared by the
 * isolated drill and graduated production restore.
 */
import { createHash } from 'node:crypto'

import {
	pacedD1TargetPageSql,
	planPacedD1Restore,
	runPacedD1RestoreUnit,
	scanPacedD1TargetPage,
	type PacedD1RestoreUnit,
	type PacedD1RestoreUnitResult,
	type PacedD1TargetScan,
} from '@kody-internal/shared/backup-d1-paced-materialize.ts'
import {
	loadVerifiedPacedD1NightChain,
	type PacedD1ObjectReader,
	type PacedD1SourceRef,
} from '@kody-internal/shared/backup-d1-paced-read.ts'

import { BackupError } from './backup-policy.ts'
import type { ApiOptions } from './d1-export-api.ts'
import { importSqlIntoD1, queryD1Database } from './d1-import-api.ts'

export type PacedTargetStep = {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>
}

export type PacedTargetTable = {
	table: string
	cols: Array<string>
	manifestCount: number
	manifestChecksum: string
}

export type PacedTargetPlan = {
	chainDays: Array<string>
	units: Array<PacedD1RestoreUnit>
	tables: Array<PacedTargetTable>
}

export type PacedTargetD1 = {
	accountId: string
	databaseId: string
	token: string
	options?: ApiOptions
}

const partsPerUnit = 4
const verifyPageRows = 500
const verifyPagesPerStep = 40
const maxChunkBytes = 16 * 1024 * 1024

export function bucketReader(bucket: R2Bucket): PacedD1ObjectReader {
	return {
		async getText(key) {
			const object = await bucket.get(key)
			return object ? { text: await object.text() } : null
		},
		async getBytes(key) {
			const object = await bucket.get(key)
			return object ? new Uint8Array(await object.arrayBuffer()) : null
		},
	}
}

function md5Hex(text: string): string {
	return createHash('md5').update(text).digest('hex')
}

export async function planPacedTargetRestore(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef & { name: string }
	day: string
	step: PacedTargetStep
	missingCode: string
}): Promise<PacedTargetPlan> {
	const { reader, source, day } = input
	return input.step.do(`plan:${source.id}`, async () => {
		const chain = await loadVerifiedPacedD1NightChain({ reader, source, day })
		if (chain.length === 0) {
			throw new BackupError(
				input.missingCode,
				`no sealed paced manifest for ${source.name} on ${day}`,
			)
		}
		const tip = chain[chain.length - 1]!.manifest
		return {
			chainDays: chain.map((night) => night.manifest.day),
			units: await planPacedD1Restore({ reader, source, chain, partsPerUnit }),
			tables: Object.entries(tip.tables).map(([table, manifest]) => ({
				table,
				cols: manifest.cols,
				manifestCount: manifest.count,
				manifestChecksum: manifest.checksum,
			})),
		}
	})
}

export async function importPacedTargetUnits(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	day: string
	step: PacedTargetStep
	plan: PacedTargetPlan
	target: PacedTargetD1
	onUnit: (unitIndex: number, result: PacedD1RestoreUnitResult) => Promise<void>
}): Promise<void> {
	const { reader, source, day, target } = input
	for (const [unitIndex, unit] of input.plan.units.entries()) {
		const result: PacedD1RestoreUnitResult = await input.step.do(
			`unit:${source.id}:${unitIndex}`,
			async () =>
				runPacedD1RestoreUnit({
					reader,
					source,
					chain: await loadVerifiedPacedD1NightChain({ reader, source, day }),
					unit,
					maxChunkBytes,
					importChunk: async (sql) => {
						await importSqlIntoD1({
							accountId: target.accountId,
							databaseId: target.databaseId,
							token: target.token,
							sourceMd5Etag: md5Hex(sql),
							loadSqlBody: async () => sql,
							options: target.options,
						})
					},
				}),
		)
		await input.onUnit(unitIndex, result)
	}
}

/**
 * Read and verify every part the plan will replay, without importing, so a
 * missing or corrupt backup object fails before the target is touched.
 */
export async function preflightPacedTargetUnits(input: {
	reader: PacedD1ObjectReader
	source: PacedD1SourceRef
	day: string
	step: PacedTargetStep
	plan: PacedTargetPlan
}): Promise<void> {
	const { reader, source, day } = input
	for (const [unitIndex, unit] of input.plan.units.entries()) {
		await input.step.do(`preflight:${source.id}:${unitIndex}`, async () => {
			await runPacedD1RestoreUnit({
				reader,
				source,
				chain: await loadVerifiedPacedD1NightChain({ reader, source, day }),
				unit,
				maxChunkBytes,
				importChunk: async () => undefined,
			})
		})
	}
}

export async function quickCheckPacedTarget(input: {
	source: PacedD1SourceRef
	step: PacedTargetStep
	target: PacedTargetD1
}): Promise<string> {
	const { target } = input
	return input.step.do(`quick-check:${input.source.id}`, async () => {
		const rows = await queryD1Database({
			accountId: target.accountId,
			databaseId: target.databaseId,
			token: target.token,
			sql: 'PRAGMA quick_check',
			options: target.options,
		})
		return String(rows[0]?.quick_check)
	})
}

/** Re-hash every restored row of one table in bounded pages. */
export async function scanPacedTargetTable(input: {
	source: PacedD1SourceRef
	step: PacedTargetStep
	target: PacedTargetD1
	table: PacedTargetTable
	tableIndex: number
}): Promise<PacedD1TargetScan> {
	const { target, table } = input
	let scan: PacedD1TargetScan = {
		count: 0,
		checksum: '0'.padStart(16, '0'),
		lastRowid: null,
		done: false,
	}
	for (let batch = 0; !scan.done; batch += 1) {
		const from = scan
		scan = await input.step.do(
			`verify:${input.source.id}:${input.tableIndex}:${batch}`,
			async () => {
				let next = from
				for (let page = 0; page < verifyPagesPerStep && !next.done; page += 1) {
					next = await scanPacedD1TargetPage({
						cols: table.cols,
						rows: await queryD1Database({
							accountId: target.accountId,
							databaseId: target.databaseId,
							token: target.token,
							sql: pacedD1TargetPageSql({
								table: table.table,
								cols: table.cols,
								afterRowid: next.lastRowid,
								limit: verifyPageRows,
							}),
							options: target.options,
						}),
						limit: verifyPageRows,
						scan: next,
					})
				}
				return next
			},
		)
	}
	return scan
}

/**
 * Isolated paced restore drill: replay the latest sealed paced base plus
 * deltas for every paced source into fresh D1 databases in DRILL_ACCOUNT_ID,
 * then compare row counts and checksums with the sealed tip manifest. It
 * never writes to a production database.
 */
import { createHash } from 'node:crypto'

import {
	addPacedD1Checksums,
	planPacedD1Restore,
	runPacedD1RestoreUnit,
	type PacedD1RestoreUnit,
	type PacedD1RestoreUnitResult,
} from '@kody-internal/shared/backup-d1-paced-materialize.ts'
import {
	loadSealedPacedD1Manifest,
	loadVerifiedPacedD1NightChain,
	type PacedD1ObjectReader,
} from '@kody-internal/shared/backup-d1-paced-read.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'

import {
	BackupError,
	pacedSourceDatabases,
	safeLog,
	utcDay,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import type { ApiOptions } from './d1-export-api.ts'
import {
	createD1Database,
	deleteD1Database,
	importSqlIntoD1,
	queryD1Database,
} from './d1-import-api.ts'
import {
	assertDrillAccountIsolated,
	requireDrillToken,
} from './restore-drill.ts'

export type PacedDrillPayload = { runId: string; day: string }

export type PacedDrillTableProgress = {
	table: string
	manifestCount: number
	manifestChecksum: string
	restoredRows: number
	restoredChecksum: string
	targetCount: number | null
	ok: boolean | null
}

export type PacedDrillSourceProgress = {
	databaseName: string
	databaseId: string
	targetDatabaseId: string | null
	phase: 'pending' | 'restoring' | 'verifying' | 'passed' | 'failed'
	chainDays: Array<string>
	unitsDone: number
	unitsTotal: number
	quickCheck: string | null
	keptForInspection: boolean
	tables: Array<PacedDrillTableProgress>
	error: string | null
}

export type PacedDrillProgress = {
	runId: string
	day: string
	status: 'running' | 'passed' | 'failed'
	updatedAt: string
	sources: Array<PacedDrillSourceProgress>
}

export type PacedDrillStep = {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>
}

const partsPerUnit = 4
const maxChunkBytes = 16 * 1024 * 1024
const runIdPattern = /^paced-drill-(\d{4}-\d{2}-\d{2})-\d+$/

export function pacedDrillRunId(day: string, now: Date): string {
	return `paced-drill-${day}-${now.getTime()}`
}

export function dayFromPacedDrillRunId(runId: string): string | null {
	return runIdPattern.exec(runId)?.[1] ?? null
}

export function pacedDrillProgressKey(day: string, runId: string): string {
	return `staging/${day}/d1-paced/isolated-restore-drill/${runId}.json`
}

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

/** Most recent day, up to a week back, sealed by every paced source. */
export async function latestPacedSealedDay(
	env: BackupEnvironment,
	now: Date,
): Promise<string> {
	const reader = bucketReader(env.BACKUP_BUCKET)
	const sources = pacedSourceDatabases(env)
	for (let back = 0; back <= 7; back += 1) {
		const day = utcDay(new Date(now.getTime() - back * 86_400_000))
		const sealed = await Promise.all(
			sources.map((source) =>
				loadSealedPacedD1Manifest({ reader, source, day }),
			),
		)
		if (sealed.every((night) => night !== null)) return day
	}
	throw new BackupError(
		'paced-drill-seal-missing',
		'no day in the last week has sealed paced manifests for every source',
	)
}

export async function readPacedDrillProgress(
	env: BackupEnvironment,
	runId: string,
): Promise<PacedDrillProgress | null> {
	const day = dayFromPacedDrillRunId(runId)
	if (day === null) return null
	const object = await env.BACKUP_BUCKET.get(pacedDrillProgressKey(day, runId))
	return object ? (JSON.parse(await object.text()) as PacedDrillProgress) : null
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function md5Hex(text: string): string {
	return createHash('md5').update(text).digest('hex')
}

export async function runPacedRestoreDrill(input: {
	env: BackupEnvironment
	payload: PacedDrillPayload
	step: PacedDrillStep
	now?: () => Date
	options?: ApiOptions & { maxPollAttempts?: number; pollDelayMs?: number }
}): Promise<PacedDrillProgress> {
	const { env, payload, step } = input
	const now = input.now ?? (() => new Date())
	assertDrillAccountIsolated(env)
	const token = requireDrillToken(env)
	const accountId = env.DRILL_ACCOUNT_ID.trim()
	const reader = bucketReader(env.BACKUP_BUCKET)
	const sources = pacedSourceDatabases(env)
	const progress: PacedDrillProgress = {
		runId: payload.runId,
		day: payload.day,
		status: 'running',
		updatedAt: now().toISOString(),
		sources: sources.map((source) => ({
			databaseName: source.name,
			databaseId: source.id,
			targetDatabaseId: null,
			phase: 'pending',
			chainDays: [],
			unitsDone: 0,
			unitsTotal: 0,
			quickCheck: null,
			keptForInspection: false,
			tables: [],
			error: null,
		})),
	}
	const save = async () => {
		progress.updatedAt = now().toISOString()
		await env.BACKUP_BUCKET.put(
			pacedDrillProgressKey(payload.day, payload.runId),
			JSON.stringify(progress),
			{ httpMetadata: { contentType: 'application/json' } },
		)
	}
	await save()

	for (const [index, source] of sources.entries()) {
		const entry = progress.sources[index]!
		try {
			const plan = await step.do(`plan:${source.id}`, async () => {
				const chain = await loadVerifiedPacedD1NightChain({
					reader,
					source,
					day: payload.day,
				})
				if (chain.length === 0) {
					throw new BackupError(
						'paced-drill-seal-missing',
						`no sealed paced manifest for ${source.name} on ${payload.day}`,
					)
				}
				const tip = chain[chain.length - 1]!.manifest
				return {
					chainDays: chain.map((night) => night.manifest.day),
					units: await planPacedD1Restore({
						reader,
						source,
						chain,
						partsPerUnit,
					}),
					tables: Object.entries(tip.tables).map(([table, manifest]) => ({
						table,
						manifestCount: manifest.count,
						manifestChecksum: manifest.checksum,
					})),
				}
			})
			entry.chainDays = plan.chainDays
			entry.unitsTotal = plan.units.length
			entry.tables = plan.tables.map((table) => ({
				...table,
				restoredRows: 0,
				restoredChecksum: '0'.padStart(16, '0'),
				targetCount: null,
				ok: null,
			}))
			entry.phase = 'restoring'
			const target = await step.do(`create-db:${source.id}`, async () => {
				const created = await createD1Database({
					accountId,
					name: `kody-dr-paced-${payload.day}-${source.name}-${payload.runId.slice(-6)}`,
					token,
					options: input.options,
				})
				return created.uuid
			})
			entry.targetDatabaseId = target
			await save()

			for (const [unitIndex, unit] of plan.units.entries()) {
				const result: PacedD1RestoreUnitResult = await step.do(
					`unit:${source.id}:${unitIndex}`,
					async () =>
						runPacedD1RestoreUnit({
							reader,
							source,
							chain: await loadVerifiedPacedD1NightChain({
								reader,
								source,
								day: payload.day,
							}),
							unit: unit as PacedD1RestoreUnit,
							maxChunkBytes,
							importChunk: async (sql) => {
								await importSqlIntoD1({
									accountId,
									databaseId: target,
									token,
									sourceMd5Etag: md5Hex(sql),
									loadSqlBody: async () => sql,
									options: input.options,
								})
							},
						}),
				)
				const table = entry.tables.find((row) => row.table === result.table)
				if (table) {
					table.restoredRows += result.rows
					table.restoredChecksum = addPacedD1Checksums(
						table.restoredChecksum,
						result.checksumSum,
					)
				}
				entry.unitsDone = unitIndex + 1
				await save()
			}

			entry.phase = 'verifying'
			await save()
			const verified = await step.do(`verify:${source.id}`, async () => {
				const quickCheckRows = await queryD1Database({
					accountId,
					databaseId: target,
					token,
					sql: 'PRAGMA quick_check',
					options: input.options,
				})
				const counts: Record<string, number | null> = {}
				for (const table of plan.tables) {
					const rows = await queryD1Database({
						accountId,
						databaseId: target,
						token,
						sql: `SELECT COUNT(*) AS n FROM ${quoteSqlIdentifier(table.table)}`,
						options: input.options,
					})
					const value = rows[0]?.n
					counts[table.table] = typeof value === 'number' ? value : null
				}
				return { quickCheck: String(quickCheckRows[0]?.quick_check), counts }
			})
			entry.quickCheck = verified.quickCheck
			for (const table of entry.tables) {
				table.targetCount = verified.counts[table.table] ?? null
				table.ok =
					table.restoredRows === table.manifestCount &&
					table.restoredChecksum === table.manifestChecksum &&
					table.targetCount === table.manifestCount
			}
			const passed =
				entry.quickCheck === 'ok' && entry.tables.every((table) => table.ok)
			if (passed) {
				await step.do(`delete-db:${source.id}`, async () => {
					await deleteD1Database({
						accountId,
						databaseId: target,
						token,
						options: input.options,
					})
					return true
				})
			}
			entry.keptForInspection = !passed
			entry.phase = passed ? 'passed' : 'failed'
			if (!passed) {
				const failing = entry.tables
					.filter((table) => !table.ok)
					.map((table) => table.table)
				entry.error =
					entry.quickCheck === 'ok'
						? `count or checksum mismatch: ${failing.join(', ')}`
						: `PRAGMA quick_check returned ${entry.quickCheck}`
			}
		} catch (error) {
			entry.phase = 'failed'
			entry.keptForInspection = entry.targetDatabaseId !== null
			entry.error = errorMessage(error)
		}
		safeLog({
			event:
				entry.phase === 'passed'
					? 'paced-restore-drill-source-passed'
					: 'paced-restore-drill-source-failed',
			status: entry.phase === 'passed' ? 'success' : 'failure',
			day: payload.day,
			databaseId: source.id,
			databaseName: source.name,
		})
		await save()
	}

	progress.status = progress.sources.every((entry) => entry.phase === 'passed')
		? 'passed'
		: 'failed'
	await save()
	return progress
}

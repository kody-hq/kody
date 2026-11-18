/**
 * Isolated paced restore drill: replay the latest sealed paced base plus
 * deltas for every paced source into fresh D1 databases in DRILL_ACCOUNT_ID,
 * then compare row counts and checksums with the sealed tip manifest. It
 * never writes to a production database.
 */
import { loadSealedPacedD1Manifest } from '@kody-internal/shared/backup-d1-paced-read.ts'
import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'

import {
	BackupError,
	pacedSourceDatabases,
	safeLog,
	utcDay,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import type { ApiOptions } from './d1-export-api.ts'
import { createD1Database, deleteD1Database } from './d1-import-api.ts'
import {
	bucketReader,
	importPacedTargetUnits,
	planPacedTargetRestore,
	quickCheckPacedTarget,
	scanPacedTargetTable,
	type PacedTargetD1,
	type PacedTargetStep,
} from './paced-d1-target-restore.ts'
import {
	assertDrillAccountIsolated,
	requireDrillToken,
} from './restore-drill.ts'

export type PacedDrillPayload = { runId: string; day: string }

type PacedDrillTableProgress = {
	table: string
	manifestCount: number
	manifestChecksum: string
	importedRows: number
	targetChecksum: string | null
	targetCount: number | null
	ok: boolean | null
}

type PacedDrillSourceProgress = {
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

export type PacedDrillStep = PacedTargetStep

const runIdPattern = /^paced-drill-(\d{4}-\d{2}-\d{2})-\d+$/

export function pacedDrillRunId(day: string, now: Date): string {
	return `paced-drill-${day}-${now.getTime()}`
}

export function dayFromPacedDrillRunId(runId: string): string | null {
	return runIdPattern.exec(runId)?.[1] ?? null
}

function pacedDrillProgressKey(day: string, runId: string): string {
	return `staging/${day}/d1-paced/isolated-restore-drill/${runId}.json`
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
			const plan = await planPacedTargetRestore({
				reader,
				source,
				day: payload.day,
				step,
				missingCode: 'paced-drill-seal-missing',
			})
			entry.chainDays = plan.chainDays
			entry.unitsTotal = plan.units.length
			entry.tables = plan.tables.map((table) => ({
				...table,
				importedRows: 0,
				targetChecksum: null,
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

			const d1: PacedTargetD1 = {
				accountId,
				databaseId: target,
				token,
				options: input.options,
			}
			await importPacedTargetUnits({
				reader,
				source,
				day: payload.day,
				step,
				plan,
				target: d1,
				onUnit: async (unitIndex, result) => {
					const table = entry.tables.find((row) => row.table === result.table)
					if (table) table.importedRows += result.rows
					entry.unitsDone = unitIndex + 1
					await save()
				},
			})

			entry.phase = 'verifying'
			await save()
			entry.quickCheck = await quickCheckPacedTarget({
				source,
				step,
				target: d1,
			})
			for (const [tableIndex, table] of plan.tables.entries()) {
				const scan = await scanPacedTargetTable({
					source,
					step,
					target: d1,
					table,
					tableIndex,
				})
				const row = entry.tables[tableIndex]!
				row.targetCount = scan.count
				row.targetChecksum = scan.checksum
				row.ok =
					row.targetCount === row.manifestCount &&
					row.targetChecksum === row.manifestChecksum
				await save()
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

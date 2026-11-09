import {
	BackupError,
	backupPayload,
	bindSourceDatabase,
	resolveSourceDatabase,
	safeLog,
} from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import {
	createD1Database,
	deleteD1Database,
	importSqlIntoD1,
	queryD1Database,
} from './d1-import-api.ts'
import type { ApiOptions } from './d1-export-api.ts'
import { readManifest } from './immutable-storage.ts'
import { verifyBackupManifestSignature } from './manifest-signing.ts'
import { assertSqlRestorable } from './sql-statement-stats.ts'

export type DrillReport = {
	day: string
	sourceDatabaseName: string
	sourceDatabaseId: string
	databaseName: string
	databaseId: string | null
	keptForInspection: boolean
	quickCheck: string | null
	tableCounts: Array<{ table: string; count: number | null }>
	errorCode: string | null
	errorMessage: string | null
}

function randomHex(bytes: number): string {
	const buffer = new Uint8Array(bytes)
	crypto.getRandomValues(buffer)
	return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function assertDrillAccountIsolated(env: BackupEnvironment): void {
	const drillAccountId = env.DRILL_ACCOUNT_ID?.trim()
	if (!drillAccountId) {
		throw new BackupError(
			'drill-account-missing',
			'DRILL_ACCOUNT_ID is required',
		)
	}
	if (drillAccountId.toLowerCase() === env.SOURCE_ACCOUNT_ID.toLowerCase()) {
		throw new BackupError(
			'drill-account-not-isolated',
			'DRILL_ACCOUNT_ID must differ from SOURCE_ACCOUNT_ID',
		)
	}
}

function requireDrillToken(env: BackupEnvironment): string {
	const token = env.DRILL_API_TOKEN?.trim()
	if (!token) {
		throw new BackupError('drill-token-missing', 'DRILL_API_TOKEN is required')
	}
	return token
}

async function listUserTables(input: {
	accountId: string
	databaseId: string
	token: string
	options?: ApiOptions
}): Promise<Array<string>> {
	const rows = await queryD1Database({
		...input,
		sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name LIMIT 20`,
	})
	return rows
		.map((row) => row.name)
		.filter((name): name is string => typeof name === 'string')
}

export async function runRestoreDrill(
	env: BackupEnvironment,
	day: string,
	options: ApiOptions & {
		maxPollAttempts?: number
		pollDelayMs?: number
		database?: string
	} = {},
): Promise<DrillReport> {
	assertDrillAccountIsolated(env)
	const token = requireDrillToken(env)
	const accountId = env.DRILL_ACCOUNT_ID.trim()
	const source = resolveSourceDatabase(env, options.database)
	const sourceEnv = bindSourceDatabase(env, source)
	const payload = backupPayload(sourceEnv, new Date(`${day}T12:00:00.000Z`))
	const manifest = await readManifest(env.BACKUP_BUCKET, payload.manifestKey)
	if (manifest === null) {
		throw new BackupError(
			'drill-manifest-missing',
			`D1 manifest missing for ${day}`,
		)
	}
	if (!(await verifyBackupManifestSignature(sourceEnv, manifest))) {
		throw new BackupError(
			'drill-manifest-signature-invalid',
			`D1 manifest signature invalid for ${day}`,
		)
	}
	const sqlObjectKey = manifest.payload.sql.objectKey
	await assertSqlRestorable(env.BACKUP_BUCKET, day, sqlObjectKey)
	const sqlHead = await env.BACKUP_BUCKET.head(sqlObjectKey)
	if (sqlHead === null) {
		throw new BackupError('drill-sql-missing', `SQL object missing for ${day}`)
	}

	const databaseName = `kody-dr-drill-${day}-${randomHex(3)}`
	const report: DrillReport = {
		day,
		sourceDatabaseName: source.name,
		sourceDatabaseId: source.id,
		databaseName,
		databaseId: null,
		keptForInspection: false,
		quickCheck: null,
		tableCounts: [],
		errorCode: null,
		errorMessage: null,
	}

	safeLog({
		event: 'restore-drill-started',
		status: 'success',
		day,
		databaseId: source.id,
		databaseName: source.name,
		objectKey: sqlObjectKey,
	})

	try {
		const created = await createD1Database({
			accountId,
			name: databaseName,
			token,
			options,
		})
		report.databaseId = created.uuid
		await importSqlIntoD1({
			accountId,
			databaseId: created.uuid,
			token,
			sourceMd5Etag: manifest.payload.sql.r2Etag,
			loadSqlBody: async () => {
				const sqlObject = await env.BACKUP_BUCKET.get(sqlObjectKey)
				if (sqlObject?.body == null) {
					throw new BackupError(
						'drill-sql-missing',
						`SQL object missing for ${day}`,
					)
				}
				return sqlObject.body
			},
			options,
		})
		const quickCheckRows = await queryD1Database({
			accountId,
			databaseId: created.uuid,
			token,
			sql: 'PRAGMA quick_check',
			options,
		})
		const quickCheckValue = quickCheckRows[0]?.quick_check
		report.quickCheck =
			typeof quickCheckValue === 'string'
				? quickCheckValue
				: String(quickCheckValue)
		if (report.quickCheck !== 'ok') {
			throw new BackupError(
				'drill-quick-check-failed',
				`PRAGMA quick_check returned ${report.quickCheck}`,
			)
		}
		const tables = await listUserTables({
			accountId,
			databaseId: created.uuid,
			token,
			options,
		})
		for (const table of tables.slice(0, 5)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue
			const countRows = await queryD1Database({
				accountId,
				databaseId: created.uuid,
				token,
				sql: `SELECT COUNT(*) AS count FROM ${table}`,
				options,
			})
			const count = countRows[0]?.count
			report.tableCounts.push({
				table,
				count: typeof count === 'number' ? count : null,
			})
		}
		await deleteD1Database({
			accountId,
			databaseId: created.uuid,
			token,
			options,
		})
		report.keptForInspection = false
		safeLog({
			event: 'restore-drill-success',
			status: 'success',
			day,
			databaseId: source.id,
			databaseName: source.name,
		})
		return report
	} catch (error) {
		report.keptForInspection = report.databaseId !== null
		report.errorCode =
			error instanceof BackupError ? error.code : 'unexpected-error'
		report.errorMessage =
			error instanceof Error ? error.message : 'unexpected drill failure'
		safeLog({
			event: 'restore-drill-failure',
			status: 'failure',
			day,
			databaseId: source.id,
			databaseName: source.name,
			errorCode: report.errorCode,
		})
		return report
	}
}

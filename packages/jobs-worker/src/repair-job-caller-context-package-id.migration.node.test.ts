import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { buildPackageJobId } from '@kody-internal/shared/jobs/package-job-id.ts'

function applyMigrationFiles(db: DatabaseSync, fileNames: Array<string>) {
	const migrationsDirectory = new URL('../migrations/', import.meta.url)
	for (const fileName of fileNames) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

test('0006 restores missing storageContext.packageId from the package job id', () => {
	const sqlite = new DatabaseSync(':memory:')
	const migrationsDirectory = new URL('../migrations/', import.meta.url)
	const all = readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()
	const beforeRepair = all.filter((file) => file < '0006')
	const repairAndAfter = all.filter((file) => file >= '0006')
	applyMigrationFiles(sqlite, beforeRepair)

	const packageId = 'pkg-damaged-1'
	const jobId = buildPackageJobId(packageId, 'nightly')
	const damagedContext = JSON.stringify({
		baseUrl: 'https://example.com',
		executionOrigin: 'interactive',
		storageContext: {
			sessionId: 'sess',
			appId: null,
			packageId: null,
			storageId: null,
		},
	})
	sqlite
		.prepare(
			`INSERT INTO jobs (
				id, user_id, name, source_id, published_commit, storage_id,
				params_json, schedule_json, timezone, enabled, kill_switch_enabled,
				expires_at, caller_context_json, created_at, updated_at, next_run_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?)`,
		)
		.run(
			jobId,
			'user-1',
			'nightly',
			'source-1',
			'commit-1',
			`job:${jobId}`,
			null,
			JSON.stringify({ type: 'interval', every: '1h' }),
			'UTC',
			damagedContext,
			'2026-10-19T00:00:00.000Z',
			'2026-10-19T00:00:00.000Z',
			'2026-10-20T00:00:00.000Z',
		)

	applyMigrationFiles(sqlite, repairAndAfter)

	const row = sqlite
		.prepare(
			`SELECT caller_context_json AS ctx, repaired_count AS repaired
			 FROM jobs, job_caller_context_package_id_repair
			 WHERE jobs.id = ?`,
		)
		.get(jobId) as { ctx: string; repaired: number }
	const parsed = JSON.parse(row.ctx) as {
		executionOrigin: string
		storageContext: { packageId: string; appId: string }
	}
	expect(parsed.storageContext.packageId).toBe(packageId)
	expect(parsed.storageContext.appId).toBe(packageId)
	expect(parsed.executionOrigin).toBe('background')
	expect(row.repaired).toBe(1)
})

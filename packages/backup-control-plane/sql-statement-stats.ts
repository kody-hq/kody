import {
	backupSqlStatsKey,
	backupSqlStatsRequired,
	parseBackupSqlStats,
	type BackupSqlStats,
} from '@kody-internal/shared/backup-sql-stats.ts'
import { d1ImportMaxStatementBytes } from '@kody-internal/shared/backup-restore-safety.ts'

import { BackupError, safeLog } from './backup-policy.ts'

type SqlRestorability =
	| { kind: 'restorable'; stats: BackupSqlStats }
	| { kind: 'unrestorable'; stats: BackupSqlStats }
	| { kind: 'legacy-unknown' }
	| { kind: 'missing' }
	| { kind: 'corrupt' }

async function readSqlRestorability(
	bucket: R2Bucket,
	day: string,
	objectKey: string,
): Promise<SqlRestorability> {
	const object = await bucket.get(backupSqlStatsKey(objectKey))
	if (object === null) {
		return backupSqlStatsRequired(day)
			? { kind: 'missing' }
			: { kind: 'legacy-unknown' }
	}
	let stats: BackupSqlStats
	try {
		stats = parseBackupSqlStats(await object.json<unknown>())
	} catch {
		return { kind: 'corrupt' }
	}
	if (stats.day !== day || stats.objectKey !== objectKey) {
		return { kind: 'corrupt' }
	}
	return stats.oversizedStatementCount > 0 ||
		stats.maxStatementBytes > d1ImportMaxStatementBytes
		? { kind: 'unrestorable', stats }
		: { kind: 'restorable', stats }
}

export async function assertSqlRestorable(
	bucket: R2Bucket,
	day: string,
	objectKey: string,
): Promise<void> {
	const result = await readSqlRestorability(bucket, day, objectKey)
	switch (result.kind) {
		case 'restorable':
			return
		case 'legacy-unknown':
			safeLog({
				event: 'backup-stats-legacy-missing',
				status: 'stale-success',
				day,
				objectKey,
			})
			return
		case 'unrestorable':
			throw new BackupError(
				'backup-unrestorable-statements',
				`D1 SQL for ${day} contains ${String(result.stats.oversizedStatementCount)} oversized statement(s)`,
			)
		case 'missing':
			throw new BackupError(
				'backup-sql-stats-missing',
				`D1 SQL stats are missing for ${day}`,
			)
		case 'corrupt':
			throw new BackupError(
				'backup-sql-stats-corrupt',
				`D1 SQL stats are corrupt for ${day}`,
			)
		default: {
			const exhaustive: never = result
			throw exhaustive
		}
	}
}

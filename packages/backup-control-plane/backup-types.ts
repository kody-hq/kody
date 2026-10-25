export { type BackupManifest } from '@kody-internal/shared/backup-manifest.ts'

export type RetentionTier = 'daily' | 'weekly'

export interface BackupEnvironment {
	BACKUP_BUCKET: R2Bucket
	BACKUP_WORKFLOW: Workflow
	RESTORE_WORKFLOW: Workflow
	SEAL_WORKFLOW: Workflow
	CLOUDFLARE_API_TOKEN: string
	SOURCE_ACCOUNT_ID: string
	SOURCE_DATABASE_ID: string
	SOURCE_DATABASE_NAME: string
	SOURCE_DATABASES?: string
	ALLOWED_SOURCE_ACCOUNT_IDS: string
	ALLOWED_SOURCE_DATABASE_IDS: string
	ENABLE_PRODUCTION_D1_BACKUPS: string
	BACKUP_BENCHMARK_APPROVED: string
	BUILD_COMMIT: string
	BACKUP_MANIFEST_SIGNING_KEY_ID: string
	BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64: string
	BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64: string
	TRUSTED_RESTORE_BASELINE_ID: string
	TRUSTED_RESTORE_BASELINE_SHA256: string
	BACKUP_MAX_AGE_HOURS?: string
	BACKUP_MAX_SOURCE_BYTES?: string
	ACCESS_TEAM_DOMAIN: string
	ACCESS_APP_AUD: string
	ACCESS_ALLOWED_EMAIL: string
	DRILL_ACCOUNT_ID: string
	PRIMARY_WORKER_ORIGIN: string
	DRILL_API_TOKEN?: string
	RESTORE_CONFIRM_SECRET?: string
	DR_RESTORE_SECRET?: string
	/** Bearer for agent seal enqueue/status on `/__maintenance/dr-seal` only. */
	DR_OPS_SECRET?: string
}

export interface ScheduledBackupPayload {
	kind: 'scheduled'
	scheduledAt: string
	day: string
	objectPrefix: string
	manifestKey: string
	retentionTier: RetentionTier
}

export type LegacyScheduledBackupPayload = Omit<ScheduledBackupPayload, 'kind'>

export type ScheduledBackupWorkflowPayload =
	| ScheduledBackupPayload
	| LegacyScheduledBackupPayload

export type BackupPayload = ScheduledBackupPayload

export interface ExportReady {
	kind: 'complete'
	bookmark: string
	signedUrl: string
}

interface ExportPending {
	kind: 'pending'
	bookmark: string
}

/** Polling result expired from D1's short retention window. */
interface ExportLost {
	kind: 'lost'
}

export type ExportState = ExportReady | ExportPending | ExportLost

/**
 * Statement-length statistics for one exported SQL object, measured while
 * streaming during upload. `oversizedStatementCount > 0` means the object is
 * not restorable through the D1 import API (statement too long:
 * SQLITE_TOOBIG); the condition is persisted next to the object before the
 * Workflow fails without writing a day manifest.
 */
export interface SqlStatementStats {
	maxStatementBytes: number
	oversizedStatementCount: number
	/** The import statement-length limit the stats were measured against. */
	limit: number
}

export interface StoredBackup {
	bytes: number
	sha256: string
	r2Etag: string
	alreadyExisted: boolean
	/** Absent only on step results cached by pre-stats deployments. */
	sqlStatementStats?: SqlStatementStats
}

export interface LogRecord {
	event:
		| 'backup-disabled'
		| 'backup-catch-up-enqueued'
		| 'backup-enqueued'
		| 'backup-overlap'
		| 'backup-restarted'
		| 'backup-export-result-expired-recover'
		| 'backup-export-signed-url-fallback'
		| 'backup-success'
		| 'backup-failure'
		| 'backup-sql-stats'
		| 'backup-unrestorable-statements'
		| 'backup-stats-legacy-missing'
		| 'freshness-success'
		| 'freshness-stale'
		| 'freshness-unrestorable'
		| 'source-size-success'
		| 'source-size-failure'
		| 'full-backup-sealed'
		| 'full-backup-already-sealed'
		| 'full-backup-seal-skipped'
		| 'full-backup-seal-failure'
		| 'restore-drill-started'
		| 'restore-drill-success'
		| 'restore-drill-failure'
		| 'production-restore-safety-export-started'
		| 'production-restore-safety-export-complete'
		| 'production-restore-d1-import-started'
		| 'production-restore-d1-import-complete'
		| 'production-restore-complete'
		| 'production-restore-failure'
		| 'ui-run-backup'
		| 'ui-seal-day'
		| 'ui-run-drill'
		| 'ui-restore-prepare'
		| 'ui-restore-execute'
		| 'ui-auth-rejected'
		| 'ui-action-failure'
	status: 'success' | 'failure' | 'stale-success' | 'disabled'
	day?: string
	instanceId?: string
	databaseId?: string
	databaseName?: string
	objectKey?: string
	manifestKey?: string
	bytes?: number
	sha256?: string
	errorCode?: string
	ageHours?: number
	sourceBytes?: number
	maxSourceBytes?: number
	blobsVerified?: number
	maxStatementBytes?: number
	oversizedStatementCount?: number
	attempt?: number
	maxAttempts?: number
}

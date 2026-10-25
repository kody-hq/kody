import {
	backupSqlStatsKey,
	backupSqlStatsRequired,
	backupSqlStatsSchemaVersion,
	parseBackupSqlStats,
} from '@kody-internal/shared/backup-sql-stats.ts'

import {
	refreshCompletedD1Export,
	verifySourceDatabaseIdentity,
	type ApiOptions,
} from './d1-export-api.ts'
import { runDurableExport, type DurableExportStep } from './durable-export.ts'
import {
	assertDuplicateMatchesManifest,
	isBucketLockPolicyPutError,
	putImmutableManifest,
	storeSignedDownload,
} from './immutable-storage.ts'
import {
	BackupError,
	backupPayload,
	bindSourceDatabase,
	errorCode,
	isBackupEnabled,
	objectKeyForPayload,
	retentionTier,
	safeLog,
	sourceDatabaseFromObjectPrefix,
	utcDay,
} from './backup-policy.ts'
import {
	type BackupEnvironment,
	type BackupManifest,
	type BackupPayload,
	type LegacyScheduledBackupPayload,
	type SqlStatementStats,
} from './backup-types.ts'
import { signBackupManifest } from './manifest-signing.ts'

/**
 * Persist per-object statement-length statistics next to the SQL object and
 * log them. An oversized statement means the object cannot be re-imported
 * through the D1 import API (SQLITE_TOOBIG), so the Workflow fails before it
 * can publish a canonical day manifest.
 */
async function recordSqlStatementStats(input: {
	env: BackupEnvironment
	day: string
	instanceId: string
	objectKey: string
	stats: SqlStatementStats | undefined
}): Promise<void> {
	const { stats } = input
	// Step replays from pre-stats deployments have no measurements to record.
	if (!stats) {
		if (backupSqlStatsRequired(input.day)) {
			throw new BackupError(
				'backup-sql-stats-missing',
				`D1 SQL statement measurements are missing for ${input.day}`,
				true,
			)
		}
		safeLog({
			event: 'backup-stats-legacy-missing',
			status: 'stale-success',
			day: input.day,
			instanceId: input.instanceId,
			objectKey: input.objectKey,
		})
		return
	}
	const persistedStats = {
		schemaVersion: backupSqlStatsSchemaVersion,
		day: input.day,
		objectKey: input.objectKey,
		maxStatementBytes: stats.maxStatementBytes,
		oversizedStatementCount: stats.oversizedStatementCount,
		importStatementLimitBytes: stats.limit,
	}
	const body = JSON.stringify(persistedStats)
	// An existing object from a replayed step wins and is left alone (the prefix
	// is under the bucket's immutable lock, which rejects puts on existing keys
	// with error 10069 before the conditional is evaluated).
	const statsKey = backupSqlStatsKey(input.objectKey)
	const putResult = await input.env.BACKUP_BUCKET.put(statsKey, body, {
		onlyIf: { etagDoesNotMatch: '*' },
		httpMetadata: { contentType: 'application/json' },
	}).catch((error: unknown) => {
		if (isBucketLockPolicyPutError(error)) return null
		throw error
	})
	if (putResult === null) {
		const existing = await input.env.BACKUP_BUCKET.get(statsKey)
		let existingStats
		try {
			existingStats =
				existing === null
					? null
					: parseBackupSqlStats(await existing.json<unknown>())
		} catch {
			existingStats = null
		}
		if (
			existingStats === null ||
			existingStats.schemaVersion !== persistedStats.schemaVersion ||
			existingStats.day !== persistedStats.day ||
			existingStats.objectKey !== persistedStats.objectKey ||
			existingStats.maxStatementBytes !== persistedStats.maxStatementBytes ||
			existingStats.oversizedStatementCount !==
				persistedStats.oversizedStatementCount ||
			existingStats.importStatementLimitBytes !==
				persistedStats.importStatementLimitBytes
		) {
			throw new BackupError(
				'backup-sql-stats-conflict',
				'Existing immutable SQL stats differ from the streamed export',
			)
		}
	}
	safeLog({
		event: 'backup-sql-stats',
		status: stats.oversizedStatementCount > 0 ? 'failure' : 'success',
		day: input.day,
		instanceId: input.instanceId,
		objectKey: input.objectKey,
		maxStatementBytes: stats.maxStatementBytes,
		oversizedStatementCount: stats.oversizedStatementCount,
	})
	if (stats.oversizedStatementCount > 0) {
		safeLog({
			event: 'backup-unrestorable-statements',
			status: 'failure',
			day: input.day,
			instanceId: input.instanceId,
			objectKey: input.objectKey,
			maxStatementBytes: stats.maxStatementBytes,
			oversizedStatementCount: stats.oversizedStatementCount,
		})
		throw new BackupError(
			'backup-unrestorable-statements',
			`D1 export contains ${String(stats.oversizedStatementCount)} statement(s) above the import limit`,
			true,
		)
	}
}

interface BackupRuntimeEvent {
	instanceId: string
	payload: unknown
	timestamp: Date
}

export interface BackupRuntimeStep extends DurableExportStep {
	do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>
	do<T>(name: string, callback: () => Promise<T>): Promise<T>
}

interface BackupRuntimeOptions {
	api?: ApiOptions
	downloadFetcher?: typeof fetch
}

const legacyScheduledPayloadKeys = [
	'scheduledAt',
	'day',
	'objectPrefix',
	'manifestKey',
	'retentionTier',
] as const
const scheduledPayloadKeys = ['kind', ...legacyScheduledPayloadKeys] as const

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	)
}

function hasExactDataKeys(
	value: Record<string, unknown>,
	expectedKeys: ReadonlyArray<string>,
): boolean {
	const actualKeys = Reflect.ownKeys(value)
	return (
		actualKeys.length === expectedKeys.length &&
		actualKeys.every(
			(key) => typeof key === 'string' && expectedKeys.includes(key),
		) &&
		expectedKeys.every((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			return descriptor?.enumerable === true && 'value' in descriptor
		})
	)
}

function canonicalScheduledDate(value: unknown): Date {
	if (typeof value !== 'string') {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow scheduledAt must be a canonical UTC timestamp',
		)
	}
	const date = new Date(value)
	if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow scheduledAt must be a canonical UTC timestamp',
		)
	}
	return date
}

function matchesExpectedPayload(
	payload: Record<string, unknown>,
	expected: BackupPayload | LegacyScheduledBackupPayload,
): boolean {
	return Object.entries(expected).every(
		([key, value]) => payload[key] === value,
	)
}

function expectedPayloadForRecord(
	env: BackupEnvironment,
	payload: Record<string, unknown>,
): BackupPayload {
	const scheduledAt = canonicalScheduledDate(payload.scheduledAt)
	const day = utcDay(scheduledAt)
	const tier = retentionTier(day)
	if (typeof payload.objectPrefix !== 'string') {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow payload did not match deterministic backup keys',
		)
	}
	return backupPayload(
		env,
		scheduledAt,
		sourceDatabaseFromObjectPrefix(env, payload.objectPrefix, day, tier),
	)
}

function validatePayload(
	env: BackupEnvironment,
	payload: unknown,
): BackupPayload {
	if (!isPlainDataRecord(payload)) {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow payload must be a plain object with exact data fields',
		)
	}
	if (!Object.hasOwn(payload, 'kind')) {
		if (!hasExactDataKeys(payload, legacyScheduledPayloadKeys)) {
			throw new BackupError(
				'invalid-workflow-payload',
				'legacy workflow payload did not have exact scheduled fields',
			)
		}
		const expected = expectedPayloadForRecord(env, payload)
		const legacyExpected: LegacyScheduledBackupPayload = {
			scheduledAt: expected.scheduledAt,
			day: expected.day,
			objectPrefix: expected.objectPrefix,
			manifestKey: expected.manifestKey,
			retentionTier: expected.retentionTier,
		}
		if (!matchesExpectedPayload(payload, legacyExpected)) {
			throw new BackupError(
				'invalid-workflow-payload',
				'legacy workflow payload did not match deterministic backup keys',
			)
		}
		if (!env.BUILD_COMMIT) {
			throw new BackupError('missing-commit', 'BUILD_COMMIT must be configured')
		}
		return expected
	}
	if (payload.kind !== 'scheduled') {
		throw new BackupError(
			'invalid-workflow-payload-kind',
			'workflow payload kind is not approved for this Workflow',
		)
	}
	if (!hasExactDataKeys(payload, scheduledPayloadKeys)) {
		throw new BackupError(
			'invalid-workflow-payload',
			'scheduled workflow payload did not have exact fields',
		)
	}
	const expected = expectedPayloadForRecord(env, payload)
	if (!matchesExpectedPayload(payload, expected)) {
		throw new BackupError(
			'invalid-workflow-payload',
			'workflow payload did not match deterministic backup keys',
		)
	}
	if (!env.BUILD_COMMIT) {
		throw new BackupError('missing-commit', 'BUILD_COMMIT must be configured')
	}
	return expected
}

export async function runBackupRuntime(
	env: BackupEnvironment,
	event: BackupRuntimeEvent,
	step: BackupRuntimeStep,
	options: BackupRuntimeOptions = {},
): Promise<BackupManifest> {
	const startedAt = event.timestamp.toISOString()
	let payload: BackupPayload | undefined
	let objectKey: string | undefined
	try {
		if (!isBackupEnabled(env)) {
			throw new BackupError(
				'backup-disabled',
				'backup workflow is explicitly disabled',
			)
		}
		const checkedPayload = validatePayload(env, event.payload)
		payload = checkedPayload
		const source = sourceDatabaseFromObjectPrefix(
			env,
			checkedPayload.objectPrefix,
			checkedPayload.day,
			checkedPayload.retentionTier,
		)
		const sourceEnv = bindSourceDatabase(env, source)
		await step.do(
			'verify-source-identity',
			{ retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' },
			async () => verifySourceDatabaseIdentity(sourceEnv, options.api),
		)
		// Export + upload can fail with export-result-expired when D1's short
		// signed URL window elapses between durable poll completion and the
		// upload refresh. Catch-up `restart()` replays the successful export
		// steps, so recovery must use new durable step names in-workflow.
		const maxExportUploadAttempts = 3
		let stored: {
			objectKey: string
			bookmark: string
			bytes: number
			sha256: string
			r2Etag: string
			sqlStatementStats: SqlStatementStats | undefined
		} | null = null
		for (let attempt = 1; attempt <= maxExportUploadAttempts; attempt += 1) {
			const stepNamePrefix = attempt === 1 ? '' : `recover-${String(attempt)}-`
			try {
				const exported = await runDurableExport(sourceEnv, step, {
					api: options.api,
					stepNamePrefix,
				})
				stored = await step.do(
					`${stepNamePrefix}stream-export-to-immutable-r2`,
					{
						retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' },
						timeout: '15 minutes',
					},
					async () => {
						// Refresh only re-polls the durable export bookmark for a
						// fresh signed URL. It never starts a new export here.
						const refreshed = await refreshCompletedD1Export(
							sourceEnv,
							exported.bookmark,
							options.api,
						)
						const refreshedObjectKey = objectKeyForPayload(
							checkedPayload,
							refreshed.bookmark,
						)
						const uploaded = await storeSignedDownload(
							env.BACKUP_BUCKET,
							refreshedObjectKey,
							refreshed.signedUrl,
							options.downloadFetcher,
						)
						return {
							...uploaded,
							objectKey: refreshedObjectKey,
							bookmark: refreshed.bookmark,
						}
					},
				)
				break
			} catch (error) {
				// Step boundary wraps non-retryable BackupError as
				// NonRetryableError; match via errorCode() message parse.
				const code = errorCode(error)
				if (
					code !== 'export-result-expired' ||
					attempt >= maxExportUploadAttempts
				) {
					throw error
				}
				safeLog({
					event: 'backup-export-result-expired-recover',
					status: 'stale-success',
					day: checkedPayload.day,
					instanceId: event.instanceId,
					databaseId: source.id,
					databaseName: source.name,
					attempt,
					maxAttempts: maxExportUploadAttempts,
					errorCode: code,
				})
			}
		}
		if (!stored) {
			throw new BackupError(
				'export-result-expired',
				'D1 export result expired before upload; recovery attempts exhausted',
			)
		}
		objectKey = stored.objectKey
		const completedAt = await step.do('record-completion-time', async () =>
			new Date().toISOString(),
		)
		await step.do(
			'record-statement-stats',
			{ retries: { limit: 2, delay: '10 seconds' }, timeout: '2 minutes' },
			async () =>
				recordSqlStatementStats({
					env,
					day: checkedPayload.day,
					instanceId: event.instanceId,
					objectKey: stored.objectKey,
					stats: stored.sqlStatementStats,
				}),
		)
		const unsignedManifest = {
			source: {
				accountId: sourceEnv.SOURCE_ACCOUNT_ID,
				databaseId: sourceEnv.SOURCE_DATABASE_ID,
				databaseName: sourceEnv.SOURCE_DATABASE_NAME,
			},
			export: {
				bookmark: stored.bookmark,
				scheduledAt: checkedPayload.scheduledAt,
				startedAt,
				completedAt,
			},
			sql: {
				objectKey: stored.objectKey,
				bytes: stored.bytes,
				sha256: stored.sha256,
				r2Etag: stored.r2Etag,
			},
			buildCommit: env.BUILD_COMMIT,
			retentionTier: checkedPayload.retentionTier,
		}
		const manifest = await step.do<BackupManifest>(
			'verify-stored-object-and-write-immutable-manifest',
			{
				retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' },
				timeout: '15 minutes',
			},
			async () => {
				// Finalization verifies the stored object against the durable
				// upload-step digest (size, ETag, full SHA-256 re-read). It must
				// not re-download from D1: expired poll results can only be
				// refreshed by starting a new export of a *newer* database
				// state, whose bytes legitimately differ from the stored object
				// whenever production wrote anything in between.
				await assertDuplicateMatchesManifest(
					env.BACKUP_BUCKET,
					checkedPayload.manifestKey,
					stored.objectKey,
					stored,
				)
				const signedManifest = await signBackupManifest(env, unsignedManifest)
				await putImmutableManifest(
					env.BACKUP_BUCKET,
					checkedPayload.manifestKey,
					signedManifest,
				)
				return signedManifest
			},
		)
		safeLog({
			event: 'backup-success',
			status: 'success',
			day: checkedPayload.day,
			instanceId: event.instanceId,
			databaseId: source.id,
			databaseName: source.name,
			objectKey: stored.objectKey,
			manifestKey: checkedPayload.manifestKey,
			bytes: stored.bytes,
			sha256: stored.sha256,
		})
		return manifest
	} catch (error) {
		safeLog({
			event: 'backup-failure',
			status: 'failure',
			day: payload?.day,
			instanceId: event.instanceId,
			objectKey,
			manifestKey: payload?.manifestKey,
			errorCode: errorCode(error),
		})
		throw error
	}
}

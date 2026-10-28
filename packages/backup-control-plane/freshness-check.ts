import {
	MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES,
	readManifest,
} from './immutable-storage.ts'
import {
	verifySourceDatabaseIdentity,
	type ApiOptions,
} from './d1-export-api.ts'
import {
	BackupError,
	assertConfiguredIdentity,
	backupPayload,
	bindSourceDatabase,
	isBookmarkObjectKey,
	restExportSourceDatabases,
	safeLog,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import { verifyBackupManifestSignature } from './manifest-signing.ts'
import { readSqlRestorability } from './sql-statement-stats.ts'

function latestExpectedDate(scheduledAt: Date): Date {
	const expected = new Date(scheduledAt)
	const beforeDailyBackup =
		scheduledAt.getUTCHours() < 2 ||
		(scheduledAt.getUTCHours() === 2 && scheduledAt.getUTCMinutes() < 15)
	if (beforeDailyBackup) {
		expected.setUTCDate(expected.getUTCDate() - 1)
	}
	return expected
}

async function checkOneSourceFreshness(
	env: BackupEnvironment,
	scheduledAt: Date,
	apiOptions: ApiOptions = {},
): Promise<boolean> {
	assertConfiguredIdentity(env)
	await verifySourceDatabaseIdentity(env, apiOptions)
	const payload = backupPayload(env, latestExpectedDate(scheduledAt))
	const maxAgeHours = Number(env.BACKUP_MAX_AGE_HOURS ?? '26')
	if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
		throw new BackupError(
			'invalid-max-age',
			'BACKUP_MAX_AGE_HOURS must be a positive number',
		)
	}
	let manifest
	try {
		manifest = await readManifest(env.BACKUP_BUCKET, payload.manifestKey)
	} catch (error) {
		if (error instanceof BackupError && error.code === 'manifest-corrupt') {
			safeLog({
				event: 'freshness-stale',
				status: 'stale-success',
				day: payload.day,
				databaseId: env.SOURCE_DATABASE_ID,
				databaseName: env.SOURCE_DATABASE_NAME,
				manifestKey: payload.manifestKey,
				errorCode: error.code,
			})
			return false
		}
		throw error
	}
	let ageHours: number | undefined
	let statsErrorCode: string | undefined
	let unrestorableStats:
		| { maxStatementBytes: number; oversizedStatementCount: number }
		| undefined
	const signatureValid =
		manifest !== null && (await verifyBackupManifestSignature(env, manifest))
	let stale = manifest === null || !signatureValid
	if (manifest !== null && signatureValid) {
		const validObjectKey = isBookmarkObjectKey(
			payload.objectPrefix,
			manifest.payload.sql.objectKey,
		)
		const object = validObjectKey
			? await env.BACKUP_BUCKET.head(manifest.payload.sql.objectKey)
			: null
		if (validObjectKey) {
			const restorability = await readSqlRestorability(
				env.BACKUP_BUCKET,
				payload.day,
				manifest.payload.sql.objectKey,
			)
			switch (restorability.kind) {
				case 'restorable':
					break
				case 'legacy-unknown':
					safeLog({
						event: 'backup-stats-legacy-missing',
						status: 'stale-success',
						day: payload.day,
						databaseId: env.SOURCE_DATABASE_ID,
						databaseName: env.SOURCE_DATABASE_NAME,
						objectKey: manifest.payload.sql.objectKey,
					})
					break
				case 'unrestorable':
					unrestorableStats = restorability.stats
					break
				case 'missing':
					statsErrorCode = 'backup-sql-stats-missing'
					break
				case 'corrupt':
					statsErrorCode = 'backup-sql-stats-corrupt'
					break
				default: {
					const exhaustive: never = restorability
					throw exhaustive
				}
			}
		}
		ageHours =
			(scheduledAt.valueOf() -
				new Date(manifest.payload.export.completedAt).valueOf()) /
			3_600_000
		stale =
			!Number.isFinite(ageHours) ||
			ageHours < 0 ||
			ageHours > maxAgeHours ||
			manifest.payload.source.accountId.toLowerCase() !==
				env.SOURCE_ACCOUNT_ID.toLowerCase() ||
			manifest.payload.source.databaseId.toLowerCase() !==
				env.SOURCE_DATABASE_ID.toLowerCase() ||
			manifest.payload.source.databaseName !== env.SOURCE_DATABASE_NAME ||
			!validObjectKey ||
			unrestorableStats !== undefined ||
			statsErrorCode !== undefined ||
			manifest.payload.sql.bytes <= 0 ||
			!/^[0-9a-f]{64}$/.test(manifest.payload.sql.sha256) ||
			!manifest.payload.sql.r2Etag ||
			object === null ||
			(object !== null &&
				(object.size !== manifest.payload.sql.bytes ||
					object.size >= MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES ||
					object.etag !== manifest.payload.sql.r2Etag))
	}
	safeLog({
		event:
			unrestorableStats !== undefined
				? 'freshness-unrestorable'
				: stale
					? 'freshness-stale'
					: 'freshness-success',
		status: stale ? 'stale-success' : 'success',
		day: payload.day,
		databaseId: env.SOURCE_DATABASE_ID,
		databaseName: env.SOURCE_DATABASE_NAME,
		objectKey: manifest?.payload.sql.objectKey,
		manifestKey: payload.manifestKey,
		ageHours,
		errorCode: statsErrorCode,
		maxStatementBytes: unrestorableStats?.maxStatementBytes,
		oversizedStatementCount: unrestorableStats?.oversizedStatementCount,
	})
	return !stale
}

export async function checkFreshness(
	env: BackupEnvironment,
	scheduledAt: Date,
	apiOptions: ApiOptions = {},
): Promise<boolean> {
	const sources = restExportSourceDatabases(env)
	const results: Array<boolean> = []
	const errors: Array<unknown> = []
	for (const source of sources) {
		try {
			results.push(
				await checkOneSourceFreshness(
					bindSourceDatabase(env, source),
					scheduledAt,
					apiOptions,
				),
			)
		} catch (error) {
			errors.push(error)
		}
	}
	if (errors.length === 1) throw errors[0]
	if (errors.length > 1) {
		throw new AggregateError(errors, 'One or more D1 freshness checks failed.')
	}
	return results.every(Boolean)
}

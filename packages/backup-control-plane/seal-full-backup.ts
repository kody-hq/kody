import {
	parseBackupFullManifest,
	serializeBackupFullManifest,
	type BackupFullD1Source,
	type BackupFullFileRef,
	type BackupFullManifest,
} from '@kody-internal/shared/backup-full-manifest.ts'
import {
	assertBackupDay,
	backupBlobKey,
	backupR2BucketLabels,
	backupStagingSchemaVersion,
	parseStagingSummary,
	sealedFullManifestKey,
	sealedFullPrefix,
	stagingPrefix,
	stagingSummaryKey,
	type StagingFileSummary,
	type StagingSummary,
	type MailboxIndex,
	type RunLogIndex,
	type StorageIndex,
} from '@kody-internal/shared/backup-staging.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'

import {
	BackupError,
	backupPayload,
	bindSourceDatabase,
	errorCode,
	primarySourceDatabase,
	restExportSourceDatabases,
	safeLog,
	utcDay,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import {
	signBackupFullManifest,
	verifyBackupFullManifestSignature,
} from './full-manifest-signing.ts'
import {
	isBucketLockPolicyPutError,
	readManifest,
} from './immutable-storage.ts'
import { verifyBackupManifestSignature } from './manifest-signing.ts'
import { readSqlRestorability } from './sql-statement-stats.ts'

const sha256Pattern = /^[0-9a-f]{64}$/

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const copy = Uint8Array.from(bytes)
	return hex(await crypto.subtle.digest('SHA-256', copy))
}

function parseStorageIndex(value: unknown, day: string): StorageIndex {
	if (
		!isRecord(value) ||
		value.schemaVersion !== backupStagingSchemaVersion ||
		value.day !== day ||
		!Array.isArray(value.entries)
	) {
		throw new BackupError(
			'storage-index-corrupt',
			'storage index JSON is corrupt',
		)
	}
	for (const entry of value.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.storageId !== 'string' ||
			typeof entry.objectKey !== 'string' ||
			!Number.isSafeInteger(entry.entryCount) ||
			!Number.isSafeInteger(entry.bytes) ||
			typeof entry.sha256 !== 'string' ||
			!sha256Pattern.test(entry.sha256)
		) {
			throw new BackupError(
				'storage-index-corrupt',
				'storage index entry is corrupt',
			)
		}
	}
	return value as StorageIndex
}

function parseOwnerIndex(
	value: unknown,
	day: string,
	kind: 'mailbox' | 'run-log',
): MailboxIndex | RunLogIndex {
	if (
		!isRecord(value) ||
		value.schemaVersion !== backupStagingSchemaVersion ||
		value.day !== day ||
		!Array.isArray(value.entries)
	) {
		throw new BackupError(
			`${kind}-index-corrupt`,
			`${kind} index JSON is corrupt`,
		)
	}
	for (const entry of value.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.ownerId !== 'string' ||
			entry.ownerId.length === 0 ||
			typeof entry.objectKey !== 'string' ||
			!Number.isSafeInteger(entry.entryCount) ||
			Number(entry.entryCount) < 0 ||
			!Number.isSafeInteger(entry.bytes) ||
			Number(entry.bytes) < 0 ||
			typeof entry.sha256 !== 'string' ||
			!sha256Pattern.test(entry.sha256)
		) {
			throw new BackupError(
				`${kind}-index-corrupt`,
				`${kind} index entry is corrupt`,
			)
		}
	}
	return value as MailboxIndex | RunLogIndex
}

function sealedKeyForStagingObject(day: string, stagingKey: string): string {
	const prefix = stagingPrefix(day)
	if (!stagingKey.startsWith(prefix)) {
		throw new BackupError(
			'staging-key-outside-day',
			'staged object key is outside the day prefix',
		)
	}
	return `${sealedFullPrefix(day)}${stagingKey.slice(prefix.length)}`
}

function toSealedRef(
	day: string,
	summary: StagingFileSummary,
): BackupFullFileRef {
	return {
		objectKey: sealedKeyForStagingObject(day, summary.objectKey),
		bytes: summary.bytes,
		sha256: summary.sha256,
	}
}

async function readObjectBytes(
	bucket: R2Bucket,
	key: string,
): Promise<Uint8Array> {
	const object = await bucket.get(key)
	if (object === null) {
		throw new BackupError('staging-object-missing', `missing object ${key}`)
	}
	return new Uint8Array(await object.arrayBuffer())
}

async function verifyStagingFile(
	bucket: R2Bucket,
	summary: StagingFileSummary,
): Promise<Uint8Array> {
	const bytes = await readObjectBytes(bucket, summary.objectKey)
	if (bytes.byteLength !== summary.bytes) {
		throw new BackupError(
			'staging-sha-mismatch',
			`byte count mismatch for ${summary.objectKey}`,
		)
	}
	const digest = await sha256Bytes(bytes)
	if (digest !== summary.sha256) {
		throw new BackupError(
			'staging-sha-mismatch',
			`sha-256 mismatch for ${summary.objectKey}`,
		)
	}
	return bytes
}

async function sealedObjectMatchesExpectedBytes(
	bucket: R2Bucket,
	sealedKey: string,
	expectedBytes: number,
): Promise<boolean> {
	const head = await bucket.head(sealedKey)
	return head !== null && head.size === expectedBytes
}

/**
 * When a prior seal attempt already copied this object under the locked
 * daily/full prefix, skip staging re-download + put/byte-compare. Size match
 * against the staging summary/index entry is enough for resume; a first-time
 * seal still verifies sha-256 from staging.
 */
async function copyStagingObjectIfNeeded(
	bucket: R2Bucket,
	day: string,
	summary: StagingFileSummary,
	contentType: string,
): Promise<void> {
	const sealedKey = sealedKeyForStagingObject(day, summary.objectKey)
	if (
		await sealedObjectMatchesExpectedBytes(bucket, sealedKey, summary.bytes)
	) {
		return
	}
	const bytes = await verifyStagingFile(bucket, summary)
	await putImmutableBytes(bucket, sealedKey, bytes, contentType)
}

async function sealOwnerDumps(input: {
	bucket: R2Bucket
	day: string
	summary: StagingFileSummary
	kind: 'mailbox' | 'run-log'
}): Promise<BackupFullFileRef> {
	// Indexes stay small: always re-read staging so resume can discover dump
	// entries even when the sealed index already exists.
	const indexBytes = await verifyStagingFile(input.bucket, input.summary)
	const index = parseOwnerIndex(
		JSON.parse(new TextDecoder().decode(indexBytes)),
		input.day,
		input.kind,
	)
	for (const entry of index.entries) {
		await copyStagingObjectIfNeeded(
			input.bucket,
			input.day,
			{
				objectKey: entry.objectKey,
				bytes: entry.bytes,
				sha256: entry.sha256,
			},
			'application/x-ndjson',
		)
	}
	const sealedIndex = toSealedRef(input.day, input.summary)
	await putImmutableBytes(
		input.bucket,
		sealedIndex.objectKey,
		indexBytes,
		'application/json',
	)
	return sealedIndex
}

async function putImmutableBytes(
	bucket: R2Bucket,
	key: string,
	bytes: Uint8Array,
	contentType: string,
): Promise<void> {
	// Cheap resume: matching size under a locked key means a prior seal
	// attempt already wrote this object — skip put and the 10069 full-body
	// compare that would otherwise re-download every dump.
	if (await sealedObjectMatchesExpectedBytes(bucket, key, bytes.byteLength)) {
		return
	}
	// A bucket-lock rule rejects puts on existing keys with error 10069
	// before evaluating the conditional, so a partially sealed day (or a
	// duplicate index entry) must fall through to byte comparison instead of
	// failing the whole seal.
	const result = await bucket
		.put(key, bytes, {
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: { contentType },
		})
		.catch((error: unknown) => {
			if (isBucketLockPolicyPutError(error)) return null
			throw error
		})
	if (result !== null) return
	const existing = await bucket.get(key)
	if (existing === null) {
		throw new BackupError(
			'sealed-put-race',
			'sealed object disappeared after immutable put conflict',
			true,
		)
	}
	const existingBytes = new Uint8Array(await existing.arrayBuffer())
	if (
		existingBytes.byteLength !== bytes.byteLength ||
		!existingBytes.every((byte, index) => byte === bytes[index])
	) {
		throw new BackupError(
			'sealed-object-conflict',
			`immutable sealed object differs at ${key}`,
		)
	}
}

async function putImmutableFullManifest(
	bucket: R2Bucket,
	key: string,
	manifest: BackupFullManifest,
): Promise<void> {
	const body = serializeBackupFullManifest(manifest)
	const result = await bucket
		.put(key, body, {
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: { contentType: 'application/json' },
		})
		.catch((error: unknown) => {
			if (isBucketLockPolicyPutError(error)) return null
			throw error
		})
	if (result !== null) return
	const existing = await bucket.get(key)
	if (existing === null) {
		throw new BackupError(
			'full-manifest-put-race',
			'full manifest disappeared after immutable put conflict',
			true,
		)
	}
	if ((await existing.text()) !== body) {
		throw new BackupError(
			'full-manifest-conflict',
			'immutable full manifest differs from this seal result',
		)
	}
}

export async function readFullManifest(
	bucket: R2Bucket,
	key: string,
): Promise<BackupFullManifest | null> {
	const object = await bucket.get(key)
	if (object === null) return null
	try {
		return parseBackupFullManifest(await object.json<unknown>())
	} catch {
		throw new BackupError(
			'full-manifest-corrupt',
			'full backup manifest JSON is corrupt',
		)
	}
}

function collectReferencedBlobHashes(input: {
	r2IndexBodies: Array<string>
	artifactsBody: string
}): Array<string> {
	const hashes: Array<string> = []
	const seen = new Set<string>()
	const push = (hash: string) => {
		if (!sha256Pattern.test(hash) || seen.has(hash)) return
		seen.add(hash)
		hashes.push(hash)
	}
	for (const body of input.r2IndexBodies) {
		for (const line of body.split('\n')) {
			const trimmed = line.trim()
			if (trimmed.length === 0) continue
			let parsed: unknown
			try {
				parsed = JSON.parse(trimmed) as unknown
			} catch {
				throw new BackupError(
					'r2-index-corrupt',
					'r2 index NDJSON line is corrupt',
				)
			}
			if (
				!isRecord(parsed) ||
				typeof parsed.sha256 !== 'string' ||
				!sha256Pattern.test(parsed.sha256)
			) {
				throw new BackupError(
					'r2-index-corrupt',
					'r2 index entry is missing a sha-256',
				)
			}
			push(parsed.sha256)
		}
	}
	let artifacts: unknown
	try {
		artifacts = JSON.parse(input.artifactsBody) as unknown
	} catch {
		throw new BackupError(
			'artifacts-index-corrupt',
			'artifacts index JSON is corrupt',
		)
	}
	if (!isRecord(artifacts) || !Array.isArray(artifacts.entries)) {
		throw new BackupError(
			'artifacts-index-corrupt',
			'artifacts index JSON is corrupt',
		)
	}
	for (const entry of artifacts.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.snapshotSha256 !== 'string' ||
			!sha256Pattern.test(entry.snapshotSha256)
		) {
			throw new BackupError(
				'artifacts-index-corrupt',
				'artifacts index entry is missing snapshotSha256',
			)
		}
		push(entry.snapshotSha256)
	}
	return hashes
}

// 2026-09-04 had 3168 unique referenced blob hashes. Sequential HEAD at
// ~20ms wall ≈ 63s, which matches the scheduled seal failure (~67s wall,
// ~227ms CPU, observability "Network connection lost.") — an R2/runtime
// drop during long sequential binding I/O, not only browser disconnect.
// Keep this in the 20–50 range; cheap sealed-object skip alone is not enough.
const referencedBlobHeadConcurrency = 32

async function mapPool<T, R>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<R>,
): Promise<Array<R>> {
	if (items.length === 0) return []
	const limit = Math.max(1, Math.min(concurrency, items.length))
	const results: Array<R> = new Array(items.length)
	let nextIndex = 0
	let firstError: unknown
	async function worker() {
		while (nextIndex < items.length) {
			const index = nextIndex
			nextIndex += 1
			const item = items[index]
			if (item === undefined) return
			try {
				results[index] = await mapper(item)
			} catch (error) {
				firstError ??= error
			}
		}
	}
	await Promise.all(Array.from({ length: limit }, () => worker()))
	if (firstError !== undefined) throw firstError
	return results
}

async function verifyReferencedBlobs(
	bucket: R2Bucket,
	hashes: Array<string>,
): Promise<
	| { kind: 'ok'; blobsVerified: number }
	| { kind: 'missing'; reason: 'blob-missing' }
> {
	// Hashes are already unique from collectReferencedBlobHashes.
	const heads = await mapPool(
		hashes,
		referencedBlobHeadConcurrency,
		async (hash) => bucket.head(backupBlobKey(hash)),
	)
	if (heads.some((head) => head === null)) {
		return { kind: 'missing', reason: 'blob-missing' }
	}
	return { kind: 'ok', blobsVerified: hashes.length }
}

async function loadVerifiedStagingSummary(
	env: BackupEnvironment,
	day: string,
): Promise<StagingSummary> {
	const object = await env.BACKUP_BUCKET.get(stagingSummaryKey(day))
	if (object === null) {
		throw new BackupError(
			'staging-summary-missing',
			`staging summary missing for ${day}`,
		)
	}
	try {
		const summary = parseStagingSummary(await object.json<unknown>())
		if (summary.day !== day) {
			throw new Error('staging summary day mismatch')
		}
		return summary
	} catch (error) {
		if (error instanceof BackupError) throw error
		throw new BackupError(
			'staging-summary-corrupt',
			`staging summary corrupt for ${day}`,
		)
	}
}

export type SealDayResult =
	| { kind: 'sealed'; day: string; manifestKey: string; alreadySealed: boolean }
	| { kind: 'incomplete'; day: string; reason: string }

async function assertSourceDayRestorable(
	env: BackupEnvironment,
	day: string,
): Promise<{ kind: 'ok' } | { kind: 'incomplete'; reason: string }> {
	const d1Payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const d1Manifest = await readManifest(
		env.BACKUP_BUCKET,
		d1Payload.manifestKey,
	)
	if (d1Manifest === null) {
		return { kind: 'incomplete', reason: 'd1-manifest-missing' }
	}
	if (!(await verifyBackupManifestSignature(env, d1Manifest))) {
		throw new BackupError(
			'd1-manifest-signature-invalid',
			`D1 manifest signature invalid for ${day}`,
		)
	}
	const restorability = await readSqlRestorability(
		env.BACKUP_BUCKET,
		day,
		d1Manifest.payload.sql.objectKey,
	)
	switch (restorability.kind) {
		case 'restorable':
			return { kind: 'ok' }
		case 'legacy-unknown':
			safeLog({
				event: 'backup-stats-legacy-missing',
				status: 'stale-success',
				day,
				databaseId: env.SOURCE_DATABASE_ID,
				databaseName: env.SOURCE_DATABASE_NAME,
				objectKey: d1Manifest.payload.sql.objectKey,
			})
			return { kind: 'ok' }
		case 'unrestorable':
			return { kind: 'incomplete', reason: 'backup-unrestorable-statements' }
		case 'missing':
			return { kind: 'incomplete', reason: 'backup-sql-stats-missing' }
		case 'corrupt':
			return { kind: 'incomplete', reason: 'backup-sql-stats-corrupt' }
		default: {
			const exhaustive: never = restorability
			throw exhaustive
		}
	}
}

function incompleteForSqlStats(day: string, reason: string): SealDayResult {
	safeLog({
		event: 'full-backup-seal-skipped',
		status: 'failure',
		day,
		errorCode: reason,
	})
	return { kind: 'incomplete', day, reason }
}

export async function sealFullBackupDay(
	env: BackupEnvironment,
	day: string,
	now: Date = new Date(),
): Promise<SealDayResult> {
	assertBackupDay(day)
	const manifestKey = sealedFullManifestKey(day)
	const existing = await readFullManifest(env.BACKUP_BUCKET, manifestKey)
	if (existing !== null) {
		if (!(await verifyBackupFullManifestSignature(env, existing))) {
			throw new BackupError(
				'full-manifest-signature-invalid',
				`existing full manifest signature is invalid for ${day}`,
			)
		}
		if (existing.payload.day !== day) {
			throw new BackupError(
				'full-manifest-day-mismatch',
				`existing full manifest day mismatch for ${day}`,
			)
		}
		safeLog({
			event: 'full-backup-already-sealed',
			status: 'success',
			day,
			manifestKey,
		})
		return { kind: 'sealed', day, manifestKey, alreadySealed: true }
	}

	const d1Sources: Array<BackupFullD1Source> = []
	const restSources = restExportSourceDatabases(env)
	const primary = primarySourceDatabase(env)
	// Full manifests still require the primary REST D1 identity fields. Turning
	// restExport off on the primary is supported for REST cron/freshness, but
	// full-day seal waits until a paced-backed full-seal path lands (#4306).
	if (!restSources.some((source) => source.id === primary.id)) {
		return {
			kind: 'incomplete',
			day,
			reason: 'primary-rest-export-disabled',
		}
	}
	for (const source of restSources) {
		const sourceEnv = bindSourceDatabase(env, source)
		const sourceResult = await assertSourceDayRestorable(sourceEnv, day)
		if (sourceResult.kind === 'incomplete') {
			return incompleteForSqlStats(day, sourceResult.reason)
		}
		const sourcePayload = backupPayload(
			sourceEnv,
			new Date(`${day}T12:00:00.000Z`),
		)
		const sourceManifestObject = await env.BACKUP_BUCKET.get(
			sourcePayload.manifestKey,
		)
		if (sourceManifestObject === null) {
			return { kind: 'incomplete', day, reason: 'd1-manifest-missing' }
		}
		const sourceManifestBytes = new Uint8Array(
			await sourceManifestObject.arrayBuffer(),
		)
		d1Sources.push({
			databaseId: source.id,
			databaseName: source.name,
			manifestKey: sourcePayload.manifestKey,
			manifestSha256: await sha256Bytes(sourceManifestBytes),
		})
	}

	const d1Payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const primarySource = d1Sources.find(
		(source) => source.manifestKey === d1Payload.manifestKey,
	)
	if (primarySource === undefined) {
		return { kind: 'incomplete', day, reason: 'd1-manifest-missing' }
	}
	const d1ManifestSha256 = primarySource.manifestSha256
	const d1ManifestKey = d1Payload.manifestKey

	let summary: StagingSummary
	try {
		summary = await loadVerifiedStagingSummary(env, day)
	} catch (error) {
		if (
			error instanceof BackupError &&
			(error.code === 'staging-summary-missing' ||
				error.code === 'staging-summary-corrupt')
		) {
			return { kind: 'incomplete', day, reason: error.code }
		}
		throw error
	}

	// Storage index is small: always re-read staging to discover dump entries.
	const storageIndexBytes = await verifyStagingFile(
		env.BACKUP_BUCKET,
		summary.storageIndex,
	)
	const storageIndex = parseStorageIndex(
		JSON.parse(new TextDecoder().decode(storageIndexBytes)),
		day,
	)
	for (const entry of storageIndex.entries) {
		await copyStagingObjectIfNeeded(
			env.BACKUP_BUCKET,
			day,
			{
				objectKey: entry.objectKey,
				bytes: entry.bytes,
				sha256: entry.sha256,
			},
			'application/x-ndjson',
		)
	}
	await putImmutableBytes(
		env.BACKUP_BUCKET,
		toSealedRef(day, summary.storageIndex).objectKey,
		storageIndexBytes,
		'application/json',
	)

	const sealedMailboxIndex = await sealOwnerDumps({
		bucket: env.BACKUP_BUCKET,
		day,
		summary: summary.mailboxIndex,
		kind: 'mailbox',
	})
	const sealedRunLogIndex = await sealOwnerDumps({
		bucket: env.BACKUP_BUCKET,
		day,
		summary: summary.runLogIndex,
		kind: 'run-log',
	})

	const sealedR2Indexes: BackupFullManifest['payload']['r2Indexes'] = {}
	const r2IndexBodies: Array<string> = []
	for (const label of backupR2BucketLabels) {
		const fileSummary = summary.r2Indexes[label]
		if (fileSummary === undefined) continue
		const bytes = await verifyStagingFile(env.BACKUP_BUCKET, fileSummary)
		r2IndexBodies.push(new TextDecoder().decode(bytes))
		const sealed = toSealedRef(day, fileSummary)
		await putImmutableBytes(
			env.BACKUP_BUCKET,
			sealed.objectKey,
			bytes,
			'application/x-ndjson',
		)
		sealedR2Indexes[label] = sealed
	}

	const artifactsBytes = await verifyStagingFile(
		env.BACKUP_BUCKET,
		summary.artifactsIndex,
	)
	const sealedArtifacts = toSealedRef(day, summary.artifactsIndex)
	await putImmutableBytes(
		env.BACKUP_BUCKET,
		sealedArtifacts.objectKey,
		artifactsBytes,
		'application/json',
	)

	let blobHashes: Array<string>
	try {
		blobHashes = collectReferencedBlobHashes({
			r2IndexBodies,
			artifactsBody: new TextDecoder().decode(artifactsBytes),
		})
	} catch (error) {
		if (
			error instanceof BackupError &&
			(error.code === 'r2-index-corrupt' ||
				error.code === 'artifacts-index-corrupt')
		) {
			return { kind: 'incomplete', day, reason: error.code }
		}
		throw error
	}
	const blobCheck = await verifyReferencedBlobs(env.BACKUP_BUCKET, blobHashes)
	switch (blobCheck.kind) {
		case 'missing':
			safeLog({
				event: 'full-backup-seal-skipped',
				status: 'failure',
				day,
				errorCode: blobCheck.reason,
			})
			return { kind: 'incomplete', day, reason: blobCheck.reason }
		case 'ok':
			break
		default: {
			const exhaustive: never = blobCheck
			throw exhaustive
		}
	}

	const fullManifest = await signBackupFullManifest(env, {
		day,
		d1ManifestKey,
		d1ManifestSha256,
		d1Sources,
		mailboxIndex: sealedMailboxIndex,
		runLogIndex: sealedRunLogIndex,
		storageIndex: toSealedRef(day, summary.storageIndex),
		r2Indexes: sealedR2Indexes,
		artifactsIndex: sealedArtifacts,
		sealedAt: now.toISOString(),
		buildCommit: summary.buildCommit,
	})
	try {
		await putImmutableFullManifest(env.BACKUP_BUCKET, manifestKey, fullManifest)
	} catch (error) {
		if (
			!(error instanceof BackupError) ||
			error.code !== 'full-manifest-conflict'
		) {
			throw error
		}
		// A concurrent seal (hourly cron and the operator workflow) can sign a
		// different sealedAt for the same bytes. Keep the manifest that landed.
		const winner = await readFullManifest(env.BACKUP_BUCKET, manifestKey)
		if (
			winner !== null &&
			winner.payload.day === day &&
			(await verifyBackupFullManifestSignature(env, winner))
		) {
			safeLog({
				event: 'full-backup-already-sealed',
				status: 'success',
				day,
				manifestKey,
			})
			return { kind: 'sealed', day, manifestKey, alreadySealed: true }
		}
		throw error
	}
	safeLog({
		event: 'full-backup-sealed',
		status: 'success',
		day,
		manifestKey,
		blobsVerified: blobCheck.blobsVerified,
	})
	return { kind: 'sealed', day, manifestKey, alreadySealed: false }
}

/**
 * How many UTC days (including today) the hourly seal scan covers. Must be
 * ≥ `drExportCatchUpLookbackDays + 2` so the oldest catch-up day remains
 * eligible after midnight when a summary lands after the final `:45` scan
 * of the previous UTC day (lookback 14 → today+14 = 15 calendar days;
 * +1 more day covers that overnight gap).
 */
const sealRecentCompleteDayCount = 16

export async function sealRecentCompleteDays(
	env: BackupEnvironment,
	scheduledAt: Date,
	dayCount = sealRecentCompleteDayCount,
): Promise<void> {
	const errors: Array<unknown> = []
	for (let offset = 0; offset < dayCount; offset += 1) {
		const date = new Date(scheduledAt)
		date.setUTCDate(date.getUTCDate() - offset)
		const day = utcDay(date)
		try {
			const result = await sealFullBackupDay(env, day, scheduledAt)
			switch (result.kind) {
				case 'sealed':
					break
				case 'incomplete':
					safeLog({
						event: 'full-backup-seal-skipped',
						status: 'success',
						day,
						errorCode: result.reason,
					})
					break
				default: {
					const exhaustive: never = result
					throw exhaustive
				}
			}
		} catch (error) {
			safeLog({
				event: 'full-backup-seal-failure',
				status: 'failure',
				day,
				errorCode: errorCode(error),
			})
			errors.push(error)
		}
	}
	if (errors.length === 1) throw errors[0]
	if (errors.length > 1) {
		throw new AggregateError(
			errors,
			'One or more full-backup seal attempts failed.',
		)
	}
}

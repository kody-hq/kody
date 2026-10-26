import { isRecord } from './is-record.ts'

/**
 * Contract between the production-side disaster-recovery exporter (runs inside
 * the primary worker's account) and the backup control plane (runs in the
 * separate DR account).
 *
 * Layout of the destination backup bucket:
 *
 * - `daily/d1/...` / `weekly/d1/...` — existing signed D1 REST exports (locked).
 * - `daily/d1-paced/...` / `weekly/d1-paced/...` — sealed paced delta/base
 *   nights from the non-disruptive worker lane (see backup-d1-paced.ts).
 * - `staging/{day}/...` — mutable per-day staging area the production
 *   exporter writes into (including `staging/{day}/d1-paced/...`). The control
 *   plane seals a day by copying the staged index and dump files into
 *   `daily/full/{day}/...` (locked) and signing a full-backup manifest over
 *   their checksums.
 * - `blobs/sha256/{hash}` — content-addressed immutable blob store shared by
 *   all days (raw email MIME, community assets, avatars, artifact source
 *   snapshots). Written once, never overwritten; long-retention lock rule.
 * - `escrow/...` — sealed secret escrow blobs (see backup-escrow.ts users).
 */

export const backupStagingSchemaVersion = 2 as const
export const backupStagingLegacySchemaVersion = 1 as const

export const backupBlobPrefix = 'blobs/sha256/'
export const backupEscrowSecretStoreKeyKey = 'escrow/secret-store-key.v1.json'

export type BackupR2BucketLabel = 'email-blobs' | 'community-assets'

export const backupR2BucketLabels: ReadonlyArray<BackupR2BucketLabel> = [
	'email-blobs',
	'community-assets',
]

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const sha256Pattern = /^[0-9a-f]{64}$/

export function assertBackupDay(day: string): void {
	if (!dayPattern.test(day)) {
		throw new Error(`invalid backup day: ${day}`)
	}
}

export function backupBlobKey(sha256: string): string {
	if (!sha256Pattern.test(sha256)) {
		throw new Error('backup blob keys require a lowercase hex sha-256')
	}
	return `${backupBlobPrefix}${sha256}`
}

export function stagingPrefix(day: string): string {
	assertBackupDay(day)
	return `staging/${day}/`
}

export function stagingSummaryKey(day: string): string {
	return `${stagingPrefix(day)}exporter/summary.json`
}

export function stagingStorageDumpKey(day: string, storageId: string): string {
	return `${stagingPrefix(day)}storage/${encodeURIComponent(storageId)}.ndjson`
}

export function stagingStorageIndexKey(day: string): string {
	return `${stagingPrefix(day)}storage-index.json`
}

export function stagingMailboxDumpKey(day: string, ownerId: string): string {
	return `${stagingPrefix(day)}mailbox/${encodeURIComponent(ownerId)}.ndjson`
}

export function stagingMailboxIndexKey(day: string): string {
	return `${stagingPrefix(day)}mailbox-index.json`
}

export function stagingRunLogDumpKey(day: string, ownerId: string): string {
	return `${stagingPrefix(day)}run-log/${encodeURIComponent(ownerId)}.ndjson`
}

export function stagingRunLogIndexKey(day: string): string {
	return `${stagingPrefix(day)}run-log-index.json`
}

export function stagingR2IndexKey(
	day: string,
	bucket: BackupR2BucketLabel,
): string {
	return `${stagingPrefix(day)}r2-index/${bucket}.ndjson`
}

export function stagingArtifactsIndexKey(day: string): string {
	return `${stagingPrefix(day)}artifacts-index.json`
}

export function sealedFullPrefix(day: string): string {
	assertBackupDay(day)
	return `daily/full/${day}/`
}

export function sealedFullManifestKey(day: string): string {
	return `${sealedFullPrefix(day)}manifest.json`
}

/** One line of a `staging/{day}/storage/{id}.ndjson` dump. */
export type StorageDumpEntry = {
	key: string
	/** JSON-serialized stored value, exactly as returned by exportStorage. */
	valueJson: string
}

export type StorageIndexEntry = {
	storageId: string
	objectKey: string
	entryCount: number
	bytes: number
	sha256: string
}

export type StorageIndex = {
	schemaVersion: typeof backupStagingSchemaVersion
	day: string
	entries: Array<StorageIndexEntry>
}

export type OwnerIndexEntry = {
	ownerId: string
	objectKey: string
	entryCount: number
	bytes: number
	sha256: string
}

export type MailboxIndexEntry = OwnerIndexEntry
export type RunLogIndexEntry = OwnerIndexEntry

export type MailboxIndex = {
	schemaVersion: typeof backupStagingSchemaVersion
	day: string
	entries: Array<OwnerIndexEntry>
}

export type RunLogIndex = {
	schemaVersion: typeof backupStagingSchemaVersion
	day: string
	entries: Array<OwnerIndexEntry>
}

export type RunLogDumpEntry =
	| { kind: 'jobRunObservability'; row: unknown }
	| { kind: 'packageRunSuccess'; row: unknown }
	| { kind: 'activationMilestone'; row: unknown }

/** One line of a `staging/{day}/r2-index/{bucket}.ndjson` index. */
export type R2IndexEntry = {
	key: string
	size: number
	/** sha-256 of the object bytes; also addresses the copy under blobs/. */
	sha256: string
}

export type ArtifactsIndexEntry = {
	sourceId: string
	entityKind: string
	entityId: string
	userId: string
	publishedCommit: string
	/** sha-256 of the published source snapshot JSON stored under blobs/. */
	snapshotSha256: string
}

export type ArtifactsIndex = {
	schemaVersion: typeof backupStagingSchemaVersion
	day: string
	entries: Array<ArtifactsIndexEntry>
}

export type StagingFileSummary = {
	objectKey: string
	bytes: number
	sha256: string
}

/**
 * Written last by the production exporter; its presence marks the staged day
 * as complete and ready for the control plane to verify and seal.
 */
export type StagingSummary = {
	schemaVersion: typeof backupStagingSchemaVersion
	day: string
	startedAt: string
	completedAt: string
	buildCommit: string
	mailboxIndex: StagingFileSummary
	runLogIndex: StagingFileSummary
	storageIndex: StagingFileSummary
	r2Indexes: Partial<Record<BackupR2BucketLabel, StagingFileSummary>>
	artifactsIndex: StagingFileSummary
	blobsWritten: number
	blobsReused: number
	warnings: Array<string>
}

export type LegacyStagingSummary = Omit<
	StagingSummary,
	'schemaVersion' | 'mailboxIndex' | 'runLogIndex'
> & {
	schemaVersion: typeof backupStagingLegacySchemaVersion
}

function isFileSummary(value: unknown): value is StagingFileSummary {
	return (
		isRecord(value) &&
		typeof value.objectKey === 'string' &&
		value.objectKey.length > 0 &&
		Number.isSafeInteger(value.bytes) &&
		Number(value.bytes) >= 0 &&
		typeof value.sha256 === 'string' &&
		sha256Pattern.test(value.sha256)
	)
}

function hasValidStagingSummaryBase(value: Record<string, unknown>): boolean {
	if (typeof value.day !== 'string' || !dayPattern.test(value.day)) {
		return false
	}
	return (
		typeof value.startedAt === 'string' &&
		Number.isFinite(Date.parse(value.startedAt)) &&
		typeof value.completedAt === 'string' &&
		Number.isFinite(Date.parse(value.completedAt)) &&
		typeof value.buildCommit === 'string' &&
		isFileSummary(value.storageIndex) &&
		isRecord(value.r2Indexes) &&
		Object.keys(value.r2Indexes).every((key) =>
			(backupR2BucketLabels as ReadonlyArray<string>).includes(key),
		) &&
		Object.values(value.r2Indexes).every(isFileSummary) &&
		isFileSummary(value.artifactsIndex) &&
		Number.isSafeInteger(value.blobsWritten) &&
		Number.isSafeInteger(value.blobsReused) &&
		Array.isArray(value.warnings) &&
		value.warnings.every((warning) => typeof warning === 'string')
	)
}

export function parseStagingSummary(value: unknown): StagingSummary {
	if (
		!isRecord(value) ||
		value.schemaVersion !== backupStagingSchemaVersion ||
		!hasValidStagingSummaryBase(value) ||
		!isFileSummary(value.mailboxIndex) ||
		!isFileSummary(value.runLogIndex)
	) {
		throw new Error('staging summary has an invalid versioned shape')
	}
	return value as StagingSummary
}

export function parseLegacyStagingSummary(
	value: unknown,
): LegacyStagingSummary {
	if (
		!isRecord(value) ||
		value.schemaVersion !== backupStagingLegacySchemaVersion ||
		!hasValidStagingSummaryBase(value) ||
		'mailboxIndex' in value ||
		'runLogIndex' in value
	) {
		throw new Error('legacy staging summary has an invalid versioned shape')
	}
	return value as LegacyStagingSummary
}

/**
 * Sealed secret escrow blob: the value is encrypted with AES-256-GCM under a
 * key derived from an operator passphrase with PBKDF2-SHA-256. Plaintext never
 * leaves the sealing process.
 */
export type SealedEscrowBlob = {
	schemaVersion: 1
	kdf: 'pbkdf2-sha256'
	iterations: number
	saltBase64: string
	ivBase64: string
	ciphertextBase64: string
	sealedAt: string
	label: string
}

export function parseSealedEscrowBlob(value: unknown): SealedEscrowBlob {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.kdf !== 'pbkdf2-sha256' ||
		!Number.isSafeInteger(value.iterations) ||
		Number(value.iterations) < 100_000 ||
		typeof value.saltBase64 !== 'string' ||
		typeof value.ivBase64 !== 'string' ||
		typeof value.ciphertextBase64 !== 'string' ||
		[value.saltBase64, value.ivBase64, value.ciphertextBase64].some(
			(field) => typeof field !== 'string' || field.length === 0,
		) ||
		typeof value.sealedAt !== 'string' ||
		!Number.isFinite(Date.parse(value.sealedAt)) ||
		typeof value.label !== 'string' ||
		value.label.length === 0
	) {
		throw new Error('sealed escrow blob has an invalid versioned shape')
	}
	return value as SealedEscrowBlob
}

import type { BackupR2BucketLabel } from './backup-staging.ts'
import { canonicalJsonStringify } from './canonical-json.ts'
import { isRecord } from './is-record.ts'

export const backupFullManifestSchemaVersion = 2 as const
export const backupFullManifestLegacySchemaVersion = 1 as const
export const backupFullManifestSignatureAlgorithm = 'Ed25519' as const

export type BackupFullFileRef = {
	objectKey: string
	bytes: number
	sha256: string
}

export type BackupFullD1Source = {
	databaseId: string
	databaseName: string
	manifestKey: string
	manifestSha256: string
}

type BackupFullManifestPayloadBase = {
	day: string
	d1ManifestKey: string
	d1ManifestSha256: string
	d1Sources?: Array<BackupFullD1Source>
	storageIndex: BackupFullFileRef
	r2Indexes: Partial<Record<BackupR2BucketLabel, BackupFullFileRef>>
	artifactsIndex: BackupFullFileRef
	sealedAt: string
	buildCommit: string
	signing: {
		algorithm: typeof backupFullManifestSignatureAlgorithm
		keyId: string
	}
}

export type BackupFullManifestPayloadV1 = BackupFullManifestPayloadBase & {
	schemaVersion: typeof backupFullManifestLegacySchemaVersion
}

export type BackupFullManifestPayload = BackupFullManifestPayloadBase & {
	schemaVersion: typeof backupFullManifestSchemaVersion
	mailboxIndex: BackupFullFileRef
	runLogIndex: BackupFullFileRef
}

type BackupFullManifestEnvelope<
	TPayload extends BackupFullManifestPayloadBase & { schemaVersion: 1 | 2 },
> = {
	schemaVersion: TPayload['schemaVersion']
	payload: TPayload
	signature: {
		algorithm: typeof backupFullManifestSignatureAlgorithm
		keyId: string
		value: string
	}
}

export type BackupFullManifest =
	| BackupFullManifestEnvelope<BackupFullManifestPayloadV1>
	| BackupFullManifestEnvelope<BackupFullManifestPayload>

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const keyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const databaseIdPattern =
	/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const knownR2Labels = new Set<string>(['email-blobs', 'community-assets'])
const optionalPayloadKeys = ['d1Sources'] as const
const d1SourceKeys = [
	'databaseId',
	'databaseName',
	'manifestKey',
	'manifestSha256',
] as const

function hasExactKeys(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): boolean {
	const actual = Object.keys(value).sort()
	const sortedExpected = [...expected].sort()
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	)
}

function hasRequiredKeys(
	value: Record<string, unknown>,
	required: ReadonlyArray<string>,
	optional: ReadonlyArray<string> = [],
): boolean {
	const allowed = new Set([...required, ...optional])
	if (!required.every((key) => Object.hasOwn(value, key))) {
		return false
	}
	return Object.keys(value).every((key) => allowed.has(key))
}

function isNonemptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function isFileRef(value: unknown): value is BackupFullFileRef {
	return (
		isRecord(value) &&
		hasExactKeys(value, ['bytes', 'objectKey', 'sha256']) &&
		isNonemptyString(value.objectKey) &&
		Number.isSafeInteger(value.bytes) &&
		Number(value.bytes) >= 0 &&
		typeof value.sha256 === 'string' &&
		sha256Pattern.test(value.sha256)
	)
}

function isR2Indexes(
	value: unknown,
): value is Partial<Record<BackupR2BucketLabel, BackupFullFileRef>> {
	if (!isRecord(value)) return false
	for (const [key, entry] of Object.entries(value)) {
		if (!knownR2Labels.has(key) || !isFileRef(entry)) return false
	}
	return true
}

function parseBackupFullD1Sources(
	value: unknown,
	d1ManifestKey: string,
): Array<BackupFullD1Source> {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('full backup manifest has an invalid versioned shape')
	}
	const sources: Array<BackupFullD1Source> = []
	const ids = new Set<string>()
	const names = new Set<string>()
	const manifestKeys = new Set<string>()
	for (const entry of value) {
		if (
			!isRecord(entry) ||
			!hasExactKeys(entry, d1SourceKeys) ||
			typeof entry.databaseId !== 'string' ||
			!databaseIdPattern.test(entry.databaseId) ||
			!isNonemptyString(entry.databaseName) ||
			!isNonemptyString(entry.manifestKey) ||
			typeof entry.manifestSha256 !== 'string' ||
			!sha256Pattern.test(entry.manifestSha256)
		) {
			throw new Error('full backup manifest contains invalid signed values')
		}
		const id = entry.databaseId.toLowerCase()
		if (
			ids.has(id) ||
			names.has(entry.databaseName) ||
			manifestKeys.has(entry.manifestKey)
		) {
			throw new Error('full backup manifest contains invalid signed values')
		}
		ids.add(id)
		names.add(entry.databaseName)
		manifestKeys.add(entry.manifestKey)
		sources.push({
			databaseId: entry.databaseId,
			databaseName: entry.databaseName,
			manifestKey: entry.manifestKey,
			manifestSha256: entry.manifestSha256,
		})
	}
	if (!sources.some((source) => source.manifestKey === d1ManifestKey)) {
		throw new Error('full backup manifest contains invalid signed values')
	}
	return sources
}

export function parseBackupFullManifest(value: unknown): BackupFullManifest {
	const schemaVersion = isRecord(value) ? value.schemaVersion : null
	const payloadKeys =
		schemaVersion === backupFullManifestLegacySchemaVersion
			? [
					'artifactsIndex',
					'buildCommit',
					'd1ManifestKey',
					'd1ManifestSha256',
					'day',
					'r2Indexes',
					'schemaVersion',
					'sealedAt',
					'signing',
					'storageIndex',
				]
			: [
					'artifactsIndex',
					'buildCommit',
					'd1ManifestKey',
					'd1ManifestSha256',
					'day',
					'mailboxIndex',
					'r2Indexes',
					'runLogIndex',
					'schemaVersion',
					'sealedAt',
					'signing',
					'storageIndex',
				]
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['payload', 'schemaVersion', 'signature']) ||
		(value.schemaVersion !== backupFullManifestLegacySchemaVersion &&
			value.schemaVersion !== backupFullManifestSchemaVersion) ||
		!isRecord(value.payload) ||
		!hasRequiredKeys(value.payload, payloadKeys, optionalPayloadKeys) ||
		value.payload.schemaVersion !== value.schemaVersion ||
		!isRecord(value.payload.signing) ||
		!hasExactKeys(value.payload.signing, ['algorithm', 'keyId']) ||
		!isRecord(value.signature) ||
		!hasExactKeys(value.signature, ['algorithm', 'keyId', 'value'])
	) {
		throw new Error('full backup manifest has an invalid versioned shape')
	}
	if (
		typeof value.payload.day !== 'string' ||
		!dayPattern.test(value.payload.day) ||
		!isNonemptyString(value.payload.d1ManifestKey) ||
		typeof value.payload.d1ManifestSha256 !== 'string' ||
		!sha256Pattern.test(value.payload.d1ManifestSha256) ||
		!isFileRef(value.payload.storageIndex) ||
		!isR2Indexes(value.payload.r2Indexes) ||
		!isFileRef(value.payload.artifactsIndex) ||
		(value.schemaVersion === backupFullManifestSchemaVersion &&
			(!isFileRef(value.payload.mailboxIndex) ||
				!isFileRef(value.payload.runLogIndex))) ||
		typeof value.payload.sealedAt !== 'string' ||
		!Number.isFinite(Date.parse(value.payload.sealedAt)) ||
		!isNonemptyString(value.payload.buildCommit) ||
		value.payload.signing.algorithm !== backupFullManifestSignatureAlgorithm ||
		value.signature.algorithm !== backupFullManifestSignatureAlgorithm ||
		typeof value.payload.signing.keyId !== 'string' ||
		!keyIdPattern.test(value.payload.signing.keyId) ||
		value.signature.keyId !== value.payload.signing.keyId ||
		typeof value.signature.value !== 'string' ||
		value.signature.value.length === 0
	) {
		throw new Error('full backup manifest contains invalid signed values')
	}
	if (Object.hasOwn(value.payload, 'd1Sources')) {
		parseBackupFullD1Sources(
			value.payload.d1Sources,
			value.payload.d1ManifestKey,
		)
	}
	return value as BackupFullManifest
}

export function canonicalBackupFullManifestPayload(
	payload: BackupFullManifestPayload | BackupFullManifestPayloadV1,
): string {
	return canonicalJsonStringify(payload)
}

export function serializeBackupFullManifest(
	manifest: BackupFullManifest,
): string {
	return `${canonicalJsonStringify(manifest)}\n`
}

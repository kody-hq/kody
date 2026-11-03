import {
	backupFullManifestSchemaVersion,
	backupFullManifestSignatureAlgorithm,
	canonicalBackupFullManifestPayload,
	parseBackupFullManifest,
	type BackupFullManifest,
	type BackupFullManifestPayload,
} from '@kody-internal/shared/backup-full-manifest.ts'
import {
	backupStagingSchemaVersion,
	sealedFullManifestKey,
	sealedFullPrefix,
	stagingMailboxDumpKey,
	type MailboxIndex,
	type OwnerIndexEntry,
} from '@kody-internal/shared/backup-staging.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { MaintenanceFailureError } from '#worker/maintenance-handler.ts'
import type { DrBackupS3Client } from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'

const sha256Pattern = /^[0-9a-f]{64}$/
const base64Pattern =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function failure(message: string): MaintenanceFailureError {
	return new MaintenanceFailureError(message, {
		progress: null,
		warnings: [],
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readSignatureConfiguration(env: Env) {
	const values = env as unknown as {
		BACKUP_MANIFEST_SIGNING_KEY_ID?: string
		BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64?: string
	}
	const keyId = values.BACKUP_MANIFEST_SIGNING_KEY_ID?.trim()
	const publicKeySpkiBase64 =
		values.BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64?.trim()
	if (!keyId || !publicKeySpkiBase64) {
		throw failure('Mailbox import manifest verification is not configured')
	}
	return { keyId, publicKeySpkiBase64 }
}

function decodeBase64(value: string, field: string): ArrayBuffer {
	if (!base64Pattern.test(value)) {
		throw failure(`${field} must be canonical base64`)
	}
	const binary = atob(value)
	return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer
}

async function verifyFullManifestSignature(
	manifest: BackupFullManifest,
	configuration: ReturnType<typeof readSignatureConfiguration>,
): Promise<boolean> {
	if (
		manifest.schemaVersion !== backupFullManifestSchemaVersion ||
		manifest.payload.schemaVersion !== backupFullManifestSchemaVersion ||
		manifest.payload.signing.keyId !== configuration.keyId ||
		manifest.signature.keyId !== configuration.keyId ||
		manifest.payload.signing.algorithm !==
			backupFullManifestSignatureAlgorithm ||
		manifest.signature.algorithm !== backupFullManifestSignatureAlgorithm
	) {
		return false
	}
	try {
		const publicKey = await crypto.subtle.importKey(
			'spki',
			decodeBase64(
				configuration.publicKeySpkiBase64,
				'manifest verifying public key',
			),
			backupFullManifestSignatureAlgorithm,
			false,
			['verify'],
		)
		return await crypto.subtle.verify(
			backupFullManifestSignatureAlgorithm,
			publicKey,
			decodeBase64(manifest.signature.value, 'full manifest signature'),
			new TextEncoder().encode(
				canonicalBackupFullManifestPayload(manifest.payload),
			),
		)
	} catch {
		return false
	}
}

function decodeUtf8(bytes: Uint8Array, field: string): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw failure(`${field} is not valid UTF-8`)
	}
}

async function getRequiredBytes(
	s3: DrBackupS3Client,
	key: string,
	description: string,
): Promise<Uint8Array> {
	const bytes = await s3.getBytes(key)
	if (!bytes) throw failure(`${description} missing at ${key}`)
	return bytes
}

async function verifyFileBytes(
	bytes: Uint8Array,
	expected: { bytes: number; sha256: string },
	description: string,
): Promise<void> {
	if (bytes.byteLength !== expected.bytes) {
		throw failure(
			`${description} byte count mismatch: expected ${expected.bytes}, got ${bytes.byteLength}`,
		)
	}
	const actualSha256 = await sha256Hex(bytes)
	if (actualSha256 !== expected.sha256) {
		throw failure(
			`${description} sha256 mismatch: expected ${expected.sha256}, got ${actualSha256}`,
		)
	}
}

function parseMailboxIndex(value: unknown, day: string): MailboxIndex {
	if (
		!isRecord(value) ||
		value.schemaVersion !== backupStagingSchemaVersion ||
		value.day !== day ||
		!Array.isArray(value.entries)
	) {
		throw failure('sealed mailbox index has an invalid versioned shape')
	}
	const ownerIds = new Set<string>()
	for (const entry of value.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.ownerId !== 'string' ||
			entry.ownerId.length === 0 ||
			entry.ownerId !== entry.ownerId.trim() ||
			typeof entry.objectKey !== 'string' ||
			entry.objectKey !== stagingMailboxDumpKey(day, entry.ownerId) ||
			!Number.isSafeInteger(entry.entryCount) ||
			Number(entry.entryCount) < 0 ||
			!Number.isSafeInteger(entry.bytes) ||
			Number(entry.bytes) < 0 ||
			typeof entry.sha256 !== 'string' ||
			!sha256Pattern.test(entry.sha256) ||
			ownerIds.has(entry.ownerId)
		) {
			throw failure('sealed mailbox index contains an invalid owner entry')
		}
		ownerIds.add(entry.ownerId)
	}
	return value as MailboxIndex
}

function sealedDumpKey(day: string, ownerId: string): string {
	return `${sealedFullPrefix(day)}mailbox/${encodeURIComponent(ownerId)}.ndjson`
}

export async function loadVerifiedMailboxIndex(input: {
	s3: DrBackupS3Client
	env: Env
	day: string
}): Promise<{ index: MailboxIndex; mediaIdentity: string }> {
	const manifestBytes = await getRequiredBytes(
		input.s3,
		sealedFullManifestKey(input.day),
		'sealed full manifest',
	)
	let manifest: BackupFullManifest
	try {
		manifest = parseBackupFullManifest(
			JSON.parse(decodeUtf8(manifestBytes, 'sealed full manifest')) as unknown,
		)
	} catch (error) {
		if (error instanceof MaintenanceFailureError) throw error
		throw failure(`sealed full manifest is invalid: ${getErrorMessage(error)}`)
	}
	if (
		manifest.schemaVersion !== backupFullManifestSchemaVersion ||
		manifest.payload.day !== input.day
	) {
		throw failure('sealed full manifest does not cover the requested day')
	}
	if (
		!(await verifyFullManifestSignature(
			manifest,
			readSignatureConfiguration(input.env),
		))
	) {
		throw failure('sealed full manifest signature is invalid')
	}
	const payload = manifest.payload as BackupFullManifestPayload
	if (
		payload.mailboxIndex.objectKey !==
		`${sealedFullPrefix(input.day)}mailbox-index.json`
	) {
		throw failure('sealed mailbox index key is not canonical for the day')
	}
	const indexBytes = await getRequiredBytes(
		input.s3,
		payload.mailboxIndex.objectKey,
		'sealed mailbox index',
	)
	await verifyFileBytes(
		indexBytes,
		payload.mailboxIndex,
		'sealed mailbox index',
	)
	try {
		const index = parseMailboxIndex(
			JSON.parse(decodeUtf8(indexBytes, 'sealed mailbox index')) as unknown,
			input.day,
		)
		return {
			index,
			mediaIdentity: await sha256Hex(manifestBytes),
		}
	} catch (error) {
		if (error instanceof MaintenanceFailureError) throw error
		throw failure(`sealed mailbox index is invalid: ${getErrorMessage(error)}`)
	}
}

export async function loadVerifiedMailboxDumpText(input: {
	s3: DrBackupS3Client
	day: string
	entry: OwnerIndexEntry
}): Promise<string> {
	if (
		input.entry.objectKey !==
		stagingMailboxDumpKey(input.day, input.entry.ownerId)
	) {
		throw failure(
			`mailbox dump key does not match owner ${input.entry.ownerId}`,
		)
	}
	const key = sealedDumpKey(input.day, input.entry.ownerId)
	const bytes = await getRequiredBytes(input.s3, key, 'sealed mailbox dump')
	await verifyFileBytes(
		bytes,
		input.entry,
		`sealed mailbox dump for ${input.entry.ownerId}`,
	)
	return decodeUtf8(bytes, `sealed mailbox dump for ${input.entry.ownerId}`)
}

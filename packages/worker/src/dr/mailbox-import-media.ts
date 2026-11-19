import {
	backupFullManifestLegacySchemaVersion,
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
	stagingMailboxDumpPartKey,
	stagingPrefix,
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
		manifest.schemaVersion === backupFullManifestLegacySchemaVersion ||
		manifest.payload.schemaVersion !== manifest.schemaVersion ||
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
	let previous: { ownerId: string; part: unknown } | null = null
	for (const entry of value.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.ownerId !== 'string' ||
			entry.ownerId.length === 0 ||
			entry.ownerId !== entry.ownerId.trim() ||
			typeof entry.objectKey !== 'string' ||
			!Number.isSafeInteger(entry.entryCount) ||
			Number(entry.entryCount) < 0 ||
			!Number.isSafeInteger(entry.bytes) ||
			Number(entry.bytes) < 0 ||
			typeof entry.sha256 !== 'string' ||
			!sha256Pattern.test(entry.sha256) ||
			!isExpectedDumpEntry({
				day,
				ownerId: entry.ownerId,
				objectKey: entry.objectKey,
				sha256: entry.sha256,
				part: entry.part,
				previous,
				ownerIds,
			})
		) {
			throw failure('sealed mailbox index contains an invalid owner entry')
		}
		ownerIds.add(entry.ownerId)
		previous = { ownerId: entry.ownerId, part: entry.part }
	}
	return value as MailboxIndex
}

/**
 * An unsplit dump is one entry without `part`. A split dump lists parts
 * 0..n-1 consecutively, each keyed by its content hash.
 */
function isExpectedDumpEntry(input: {
	day: string
	ownerId: string
	objectKey: string
	sha256: string
	part: unknown
	previous: { ownerId: string; part: unknown } | null
	ownerIds: Set<string>
}): boolean {
	if (input.part === undefined) {
		return (
			!input.ownerIds.has(input.ownerId) &&
			input.objectKey === stagingMailboxDumpKey(input.day, input.ownerId)
		)
	}
	if (
		input.objectKey !==
		stagingMailboxDumpPartKey(input.day, input.ownerId, input.sha256)
	) {
		return false
	}
	const previous = input.previous
	if (
		previous?.ownerId === input.ownerId &&
		typeof previous.part === 'number'
	) {
		return input.part === previous.part + 1
	}
	return input.part === 0 && !input.ownerIds.has(input.ownerId)
}

function sealedDumpKey(day: string, stagingKey: string): string {
	return `${sealedFullPrefix(day)}${stagingKey.slice(stagingPrefix(day).length)}`
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
		manifest.schemaVersion === backupFullManifestLegacySchemaVersion ||
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
	ownerId: string
	/** The owner's index entries: one unsplit dump or parts 0..n-1. */
	parts: Array<OwnerIndexEntry>
}): Promise<string> {
	let text = ''
	for (const entry of input.parts) {
		const expectedKey =
			entry.part === undefined
				? stagingMailboxDumpKey(input.day, input.ownerId)
				: stagingMailboxDumpPartKey(input.day, input.ownerId, entry.sha256)
		if (entry.ownerId !== input.ownerId || entry.objectKey !== expectedKey) {
			throw failure(`mailbox dump key does not match owner ${input.ownerId}`)
		}
		const key = sealedDumpKey(input.day, entry.objectKey)
		const bytes = await getRequiredBytes(input.s3, key, 'sealed mailbox dump')
		await verifyFileBytes(
			bytes,
			entry,
			`sealed mailbox dump for ${input.ownerId}`,
		)
		text += decodeUtf8(bytes, `sealed mailbox dump for ${input.ownerId}`)
	}
	return text
}

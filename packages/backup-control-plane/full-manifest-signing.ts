import {
	backupFullManifestLegacySchemaVersion,
	backupFullManifestSchemaVersion,
	backupFullManifestSignatureAlgorithm,
	canonicalBackupFullManifestPayload,
	type BackupFullManifest,
	type BackupFullManifestPayload,
} from '@kody-internal/shared/backup-full-manifest.ts'

import { BackupError } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'

const keyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const base64Pattern =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function decodeBase64(value: string, description: string): ArrayBuffer {
	if (!base64Pattern.test(value)) {
		throw new BackupError(
			'invalid-manifest-signing-key',
			`${description} must be canonical base64`,
		)
	}
	const binary = atob(value)
	return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer
}

function encodeBase64(value: ArrayBuffer): string {
	const bytes = new Uint8Array(value)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

export async function verifyBackupFullManifestSignature(
	env: BackupEnvironment,
	manifest: BackupFullManifest,
): Promise<boolean> {
	if (
		(manifest.schemaVersion !== backupFullManifestLegacySchemaVersion &&
			manifest.schemaVersion !== backupFullManifestSchemaVersion) ||
		manifest.payload.schemaVersion !== manifest.schemaVersion ||
		manifest.payload.signing.algorithm !==
			backupFullManifestSignatureAlgorithm ||
		manifest.signature.algorithm !== backupFullManifestSignatureAlgorithm ||
		!keyIdPattern.test(env.BACKUP_MANIFEST_SIGNING_KEY_ID) ||
		manifest.payload.signing.keyId !== env.BACKUP_MANIFEST_SIGNING_KEY_ID ||
		manifest.signature.keyId !== env.BACKUP_MANIFEST_SIGNING_KEY_ID
	) {
		return false
	}
	try {
		const publicKey = await crypto.subtle.importKey(
			'spki',
			decodeBase64(
				env.BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64,
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

export async function signBackupFullManifest(
	env: BackupEnvironment,
	unsigned: Omit<BackupFullManifestPayload, 'schemaVersion' | 'signing'>,
): Promise<BackupFullManifest> {
	if (!keyIdPattern.test(env.BACKUP_MANIFEST_SIGNING_KEY_ID)) {
		throw new BackupError(
			'invalid-manifest-signing-key-id',
			'BACKUP_MANIFEST_SIGNING_KEY_ID must be lower-kebab-case',
		)
	}
	const keyId = env.BACKUP_MANIFEST_SIGNING_KEY_ID
	const payload: BackupFullManifestPayload = {
		schemaVersion: backupFullManifestSchemaVersion,
		...unsigned,
		signing: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
		},
	}
	let signature: ArrayBuffer
	try {
		const key = await crypto.subtle.importKey(
			'pkcs8',
			decodeBase64(
				env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64,
				'manifest signing private key',
			),
			backupFullManifestSignatureAlgorithm,
			false,
			['sign'],
		)
		signature = await crypto.subtle.sign(
			backupFullManifestSignatureAlgorithm,
			key,
			new TextEncoder().encode(canonicalBackupFullManifestPayload(payload)),
		)
	} catch {
		throw new BackupError(
			'full-manifest-signing-failed',
			'full backup manifest signing failed',
			true,
		)
	}
	return {
		schemaVersion: backupFullManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
			value: encodeBase64(signature),
		},
	}
}

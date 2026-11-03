import {
	backupManifestSchemaVersion,
	backupManifestSignatureAlgorithm,
	canonicalBackupManifestPayload,
	type BackupManifest,
	type BackupManifestPayload,
} from '@kody-internal/shared/backup-manifest.ts'

import { BackupError } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'

const sha256Pattern = /^[0-9a-f]{64}$/
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

function signingConfiguration(env: BackupEnvironment): {
	keyId: string
	privateKeyPkcs8: ArrayBuffer
	baselineId: string
	baselineSha256: string
} {
	if (!keyIdPattern.test(env.BACKUP_MANIFEST_SIGNING_KEY_ID)) {
		throw new BackupError(
			'invalid-manifest-signing-key-id',
			'BACKUP_MANIFEST_SIGNING_KEY_ID must be lower-kebab-case',
		)
	}
	if (!keyIdPattern.test(env.TRUSTED_RESTORE_BASELINE_ID)) {
		throw new BackupError(
			'invalid-restore-baseline-id',
			'TRUSTED_RESTORE_BASELINE_ID must be lower-kebab-case',
		)
	}
	if (!sha256Pattern.test(env.TRUSTED_RESTORE_BASELINE_SHA256)) {
		throw new BackupError(
			'invalid-restore-baseline-digest',
			'TRUSTED_RESTORE_BASELINE_SHA256 must be a lowercase SHA-256 digest',
		)
	}
	return {
		keyId: env.BACKUP_MANIFEST_SIGNING_KEY_ID,
		privateKeyPkcs8: decodeBase64(
			env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64,
			'manifest signing private key',
		),
		baselineId: env.TRUSTED_RESTORE_BASELINE_ID,
		baselineSha256: env.TRUSTED_RESTORE_BASELINE_SHA256,
	}
}

export async function verifyBackupManifestSignature(
	env: BackupEnvironment,
	manifest: BackupManifest,
): Promise<boolean> {
	if (
		manifest.schemaVersion !== backupManifestSchemaVersion ||
		manifest.payload.schemaVersion !== backupManifestSchemaVersion ||
		manifest.payload.signing.algorithm !== backupManifestSignatureAlgorithm ||
		manifest.signature.algorithm !== backupManifestSignatureAlgorithm ||
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
			backupManifestSignatureAlgorithm,
			false,
			['verify'],
		)
		return await crypto.subtle.verify(
			backupManifestSignatureAlgorithm,
			publicKey,
			decodeBase64(manifest.signature.value, 'manifest signature'),
			new TextEncoder().encode(
				canonicalBackupManifestPayload(manifest.payload),
			),
		)
	} catch {
		return false
	}
}

export async function signBackupManifest(
	env: BackupEnvironment,
	unsigned: Omit<
		BackupManifestPayload,
		'schemaVersion' | 'restoreBaseline' | 'signing'
	>,
): Promise<BackupManifest> {
	const configuration = signingConfiguration(env)
	const payload: BackupManifestPayload = {
		schemaVersion: backupManifestSchemaVersion,
		...unsigned,
		restoreBaseline: {
			id: configuration.baselineId,
			sha256: configuration.baselineSha256,
		},
		signing: {
			algorithm: backupManifestSignatureAlgorithm,
			keyId: configuration.keyId,
		},
	}
	let key: CryptoKey
	let signature: ArrayBuffer
	try {
		key = await crypto.subtle.importKey(
			'pkcs8',
			configuration.privateKeyPkcs8,
			backupManifestSignatureAlgorithm,
			false,
			['sign'],
		)
		signature = await crypto.subtle.sign(
			backupManifestSignatureAlgorithm,
			key,
			new TextEncoder().encode(canonicalBackupManifestPayload(payload)),
		)
	} catch {
		throw new BackupError(
			'manifest-signing-failed',
			'backup manifest signing failed',
			true,
		)
	}
	return {
		schemaVersion: backupManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupManifestSignatureAlgorithm,
			keyId: configuration.keyId,
			value: encodeBase64(signature),
		},
	}
}

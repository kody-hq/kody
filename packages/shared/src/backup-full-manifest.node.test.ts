import { generateKeyPairSync, sign as signBytes } from 'node:crypto'

import { expect, test } from 'vitest'

import {
	backupFullManifestLegacySchemaVersion,
	backupFullManifestSchemaVersion,
	backupFullManifestSignatureAlgorithm,
	canonicalBackupFullManifestPayload,
	parseBackupFullManifest,
	type BackupFullManifest,
	type BackupFullManifestPayload,
} from './backup-full-manifest.ts'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')

function indexRef(name: string, bytes: number, hashChar: string) {
	return {
		objectKey: `daily/full/2026-07-22/${name}`,
		bytes,
		sha256: hashChar.repeat(64),
	}
}

function samplePayload(): BackupFullManifestPayload {
	return {
		schemaVersion: backupFullManifestSchemaVersion,
		day: '2026-07-22',
		d1ManifestKey: 'daily/d1/db/2026-07-22/manifest.json',
		d1ManifestSha256: 'a'.repeat(64),
		storageIndex: indexRef('storage-index.json', 12, 'b'),
		mailboxIndex: indexRef('mailbox-index.json', 10, 'e'),
		runLogIndex: indexRef('run-log-index.json', 11, 'f'),
		r2Indexes: {
			'email-blobs': indexRef('r2-index/email-blobs.ndjson', 8, 'c'),
		},
		artifactsIndex: indexRef('artifacts-index.json', 4, 'd'),
		sealedAt: '2026-07-22T12:00:00.000Z',
		buildCommit: 'abc123',
		signing: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId: 'backup-manifest-2026',
		},
	}
}

function signedManifest(
	payload: BackupFullManifestPayload,
): BackupFullManifest {
	return {
		schemaVersion: backupFullManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId: payload.signing.keyId,
			value: signBytes(
				null,
				Buffer.from(canonicalBackupFullManifestPayload(payload)),
				privateKey,
			).toString('base64'),
		},
	}
}

test('parseBackupFullManifest accepts a signed envelope and rejects shape drift', () => {
	const payload = samplePayload()
	const manifest = signedManifest(payload)
	expect(parseBackupFullManifest(manifest)).toEqual(manifest)

	for (const [input, error] of [
		[{ ...manifest, extra: true }, /invalid versioned shape/],
		[
			{ ...manifest, payload: { ...manifest.payload, day: '22-07-2026' } },
			/invalid signed values/,
		],
		[
			{
				...manifest,
				payload: {
					...manifest.payload,
					r2Indexes: { 'not-a-bucket': manifest.payload.storageIndex },
				},
			},
			/invalid signed values/,
		],
	] as const) {
		expect(() => parseBackupFullManifest(input)).toThrow(error)
	}

	const {
		mailboxIndex: _mailboxIndex,
		runLogIndex: _runLogIndex,
		...legacy
	} = payload
	expect(
		parseBackupFullManifest({
			...manifest,
			schemaVersion: backupFullManifestLegacySchemaVersion,
			payload: {
				...legacy,
				schemaVersion: backupFullManifestLegacySchemaVersion,
			},
		}).payload.schemaVersion,
	).toBe(backupFullManifestLegacySchemaVersion)
})

test('parseBackupFullManifest accepts declared d1Sources and keeps historical payloads valid', () => {
	const payload = samplePayload()
	expect(
		parseBackupFullManifest(signedManifest(payload)).payload.d1Sources,
	).toBe(undefined)
	const d1Sources = [
		{
			databaseId: '22222222-2222-4222-8222-222222222222',
			databaseName: 'kody',
			manifestKey: payload.d1ManifestKey,
			manifestSha256: 'a'.repeat(64),
		},
		{
			databaseId: '44444444-4444-4444-8444-444444444444',
			databaseName: 'kody-jobs',
			manifestKey:
				'daily/d1/44444444-4444-4444-8444-444444444444/2026-07-22/manifest.json',
			manifestSha256: 'b'.repeat(64),
		},
	]
	const withSources = signedManifest({ ...payload, d1Sources })
	expect(parseBackupFullManifest(withSources).payload.d1Sources).toEqual(
		d1Sources,
	)

	const wrongPrimaryKey = {
		...d1Sources[0]!,
		manifestKey: 'daily/d1/other/2026-07-22/manifest.json',
	}
	for (const [input, error] of [
		[signedManifest({ ...payload, d1Sources: [] }), /invalid versioned shape/],
		[
			signedManifest({ ...payload, d1Sources: [wrongPrimaryKey] }),
			/invalid signed values/,
		],
		[
			{ ...withSources, payload: { ...withSources.payload, extra: true } },
			/invalid versioned shape/,
		],
	] as const) {
		expect(() => parseBackupFullManifest(input)).toThrow(error)
	}
})

test('full-manifest parse/sign/verify round-trip with Ed25519', async () => {
	const manifest = parseBackupFullManifest(signedManifest(samplePayload()))
	const signature = Buffer.from(manifest.signature.value, 'base64')
	const verifyingKey = await crypto.subtle.importKey(
		'spki',
		publicKey.export({ format: 'der', type: 'spki' }),
		backupFullManifestSignatureAlgorithm,
		false,
		['verify'],
	)
	const verify = (
		payload: Parameters<typeof canonicalBackupFullManifestPayload>[0],
	) =>
		crypto.subtle.verify(
			backupFullManifestSignatureAlgorithm,
			verifyingKey,
			signature,
			new TextEncoder().encode(canonicalBackupFullManifestPayload(payload)),
		)
	await expect(verify(manifest.payload)).resolves.toBe(true)
	await expect(
		verify({ ...manifest.payload, buildCommit: 'tampered' }),
	).resolves.toBe(false)
})

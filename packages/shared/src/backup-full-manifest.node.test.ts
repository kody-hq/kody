import { generateKeyPairSync, sign as signBytes } from 'node:crypto'

import { expect, test } from 'vitest'

import {
	backupFullManifestSchemaVersion,
	backupFullManifestSignatureAlgorithm,
	canonicalBackupFullManifestPayload,
	parseBackupFullManifest,
	RestEraBackupFullManifestError,
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
		d1Paced: [
			{
				databaseId: '22222222-2222-4222-8222-222222222222',
				databaseName: 'kody',
				manifestKey:
					'daily/d1-paced/22222222-2222-4222-8222-222222222222/2026-07-22/manifest.json',
				manifestSha256: '1'.repeat(64),
			},
		],
		sealedAt: '2026-07-22T12:00:00.000Z',
		buildCommit: 'abc123',
		signing: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId: 'backup-manifest-2026',
		},
	}
}

function signedManifest(
	payload: BackupFullManifest['payload'],
): BackupFullManifest {
	return {
		schemaVersion: payload.schemaVersion,
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
	} as BackupFullManifest
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
})

test('parseBackupFullManifest rejects REST-era schema v1 and v2 manifests', () => {
	const manifest = signedManifest(samplePayload())
	for (const schemaVersion of [1, 2]) {
		expect(() =>
			parseBackupFullManifest({
				...manifest,
				schemaVersion,
				payload: { ...manifest.payload, schemaVersion },
			}),
		).toThrow(RestEraBackupFullManifestError)
	}
	expect(() =>
		parseBackupFullManifest({ ...manifest, schemaVersion: 2 }),
	).toThrow(/REST-era backups are no longer restorable/)
	expect(() =>
		parseBackupFullManifest({ ...manifest, schemaVersion: 4 }),
	).toThrow(/invalid versioned shape/)
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
			manifestKey: 'daily/d1/db/2026-07-22/manifest.json',
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

test('schema 3 makes paced D1 required and REST D1 evidence optional as a group', () => {
	const payload = samplePayload()
	const {
		d1ManifestKey: _d1ManifestKey,
		d1ManifestSha256: _d1ManifestSha256,
		...pacedOnly
	} = payload
	const manifest = signedManifest(pacedOnly)
	expect(parseBackupFullManifest(manifest).payload).toEqual(pacedOnly)

	const { d1Paced: _d1Paced, ...withoutPaced } = payload
	for (const [input, error] of [
		[signedManifest(withoutPaced as typeof payload), /invalid versioned shape/],
		[signedManifest({ ...payload, d1Paced: [] }), /invalid versioned shape/],
		[
			signedManifest({ ...pacedOnly, d1ManifestKey: payload.d1ManifestKey }),
			/invalid signed values/,
		],
		[
			signedManifest({
				...pacedOnly,
				d1Sources: [
					{
						databaseId: '22222222-2222-4222-8222-222222222222',
						databaseName: 'kody',
						manifestKey: 'daily/d1/db/2026-07-22/manifest.json',
						manifestSha256: 'a'.repeat(64),
					},
				],
			}),
			/invalid signed values/,
		],
	] as const) {
		expect(() => parseBackupFullManifest(input)).toThrow(error)
	}
})

import { generateKeyPairSync, sign as signBytes } from 'node:crypto'

import {
	backupManifestSchemaVersion,
	backupManifestSignatureAlgorithm,
	canonicalBackupManifestPayload,
	type BackupManifestPayload,
} from '@kody-internal/shared/backup-manifest.ts'
import { vi } from 'vitest'

import type {
	BackupManifest,
	DrillAdapters,
	QueryRow,
	RestoreBaseline,
	RestoreTrustRegistry,
	VerificationQuery,
} from './d1-restore-drill.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'
import type {
	TrustedManifestPublicKeyRegistry,
	TrustedRestoreBaselineRegistry,
} from './restore-trust.ts'

export const productionUuid = '11111111-1111-4111-8111-111111111111'
export const targetUuid = '22222222-2222-4222-8222-222222222222'
export const productionAccountId = 'a'.repeat(32)
export const targetAccountId = 'b'.repeat(32)
export const backupBytes = new TextEncoder().encode('backup')
const schemaRows: Array<Record<string, string>> = []
export const now = new Date('2026-07-22T12:00:00.000Z')
const manifestKeys = generateKeyPairSync('ed25519')
export const manifestKeyRegistry: TrustedManifestPublicKeyRegistry = {
	schemaVersion: 1,
	keys: [
		{
			algorithm: 'Ed25519',
			keyId: 'backup-manifest-2026',
			publicKeyPem: manifestKeys.publicKey.export({
				format: 'pem',
				type: 'spki',
			}) as string,
		},
	],
}

export function signManifestPayload(payload: BackupManifestPayload): string {
	return signBytes(
		null,
		Buffer.from(canonicalBackupManifestPayload(payload)),
		manifestKeys.privateKey,
	).toString('base64')
}

export function createManifest(
	overrides: {
		bytes?: number
		source?: BackupManifestPayload['source']
	} = {},
): BackupManifest {
	const payload: BackupManifestPayload = {
		schemaVersion: backupManifestSchemaVersion,
		source: overrides.source ?? {
			accountId: productionAccountId,
			databaseId: productionUuid,
			databaseName: 'kody-production',
		},
		export: {
			bookmark: 'bookmark-1',
			scheduledAt: '2026-07-20T00:00:00.000Z',
			startedAt: '2026-07-20T00:01:00.000Z',
			completedAt: '2026-07-20T00:02:00.000Z',
		},
		sql: {
			objectKey: `daily/${productionUuid}/2026-07-20/backup.sql`,
			bytes: overrides.bytes ?? backupBytes.byteLength,
			sha256: sha256(backupBytes),
			r2Etag: 'etag-1',
		},
		buildCommit: 'abc123',
		retentionTier: 'daily',
		restoreBaseline: {
			id: 'production-baseline-2026',
			sha256: sha256(canonicalJson(createBaseline())),
		},
		signing: {
			algorithm: backupManifestSignatureAlgorithm,
			keyId: 'backup-manifest-2026',
		},
	}
	return {
		schemaVersion: backupManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupManifestSignatureAlgorithm,
			keyId: 'backup-manifest-2026',
			value: signManifestPayload(payload),
		},
	}
}

export function manifestFixture(
	overrides: Parameters<typeof createManifest>[0] = {},
) {
	const manifest = createManifest(overrides)
	const bytes = new TextEncoder().encode(JSON.stringify(manifest))
	return { manifest, bytes, checksum: sha256(bytes) }
}

export function createBaseline(
	overrides: Partial<RestoreBaseline> = {},
): RestoreBaseline {
	return {
		schemaVersion: 1,
		sourceDatabaseId: productionUuid,
		migrationNames: ['0001-initial.sql'],
		schemaSha256: sha256(canonicalJson(schemaRows)),
		sequenceTables: ['messages'],
		isolationChecks: [
			{
				table: 'messages',
				userColumn: 'user_id',
				primaryKeyColumn: 'id',
				users: [
					{
						userId: 'user-a',
						rowCount: 1,
						primaryKeySha256: sha256(canonicalJson(['message-a'])),
					},
					{
						userId: 'user-b',
						rowCount: 1,
						primaryKeySha256: sha256(canonicalJson(['message-b'])),
					},
				],
			},
		],
		...overrides,
	}
}

function createBaselineRegistry(
	baseline = createBaseline(),
): TrustedRestoreBaselineRegistry {
	return {
		schemaVersion: 1,
		baselines: [
			{
				id: 'production-baseline-2026',
				canonicalSha256: sha256(canonicalJson(baseline)),
				source: {
					accountId: productionAccountId,
					databaseId: productionUuid,
					databaseName: 'kody-production',
				},
				baseline,
			},
			{
				id: 'post-forward-baseline-2026',
				canonicalSha256: sha256(canonicalJson(baseline)),
				source: {
					accountId: productionAccountId,
					databaseId: productionUuid,
					databaseName: 'kody-production',
				},
				baseline,
			},
		],
	}
}

export function createTrustRegistry(
	overrides: Partial<RestoreTrustRegistry> = {},
): RestoreTrustRegistry {
	return {
		schemaVersion: 1,
		productionSources: [
			{
				accountId: productionAccountId,
				databaseId: productionUuid,
				databaseName: 'kody-production',
			},
		],
		drillTargets: [
			{
				accountId: targetAccountId,
				databaseName: 'kody-drill',
			},
		],
		...overrides,
	}
}

export function queryRows(query: VerificationQuery): Array<QueryRow> {
	switch (query.id) {
		case 'integrity':
			return [{ quick_check: 'ok' }]
		case 'foreign-keys':
			return []
		case 'migrations':
			return [{ name: '0001-initial.sql' }]
		case 'schema':
			return schemaRows
		case 'sequences':
			return [{ table_name: 'messages', sequence_value: 2, max_rowid: 2 }]
		case 'isolation':
			return [
				{
					table_name: 'messages',
					user_id: 'user-a',
					primary_key: 'message-a',
				},
				{
					table_name: 'messages',
					user_id: 'user-b',
					primary_key: 'message-b',
				},
			]
		default: {
			const exhaustive: never = query.id
			throw new Error(String(exhaustive))
		}
	}
}

export function createAdapters(): DrillAdapters {
	return {
		createTarget: vi.fn(async () => ({
			uuid: targetUuid,
			name: 'kody-drill',
			createdAt: now.toISOString(),
		})),
		now: vi.fn(() => now),
		writeTemporaryConfig: vi.fn(async () => ({
			path: '/tmp/kody-d1-restore/wrangler.json',
			cleanup: vi.fn(async () => undefined),
		})),
		run: vi.fn(async () => undefined),
		query: vi.fn(async (_command, query: VerificationQuery) =>
			queryRows(query),
		),
	}
}

export function drillInput(overrides: Record<string, unknown> = {}) {
	const fixture = manifestFixture()
	return {
		manifestBytes: fixture.bytes,
		expectedManifestSha256: fixture.checksum,
		manifestPublicKeyRegistry: manifestKeyRegistry,
		backupFileEvidence: {
			sizeBytes: backupBytes.byteLength,
			sha256: sha256(backupBytes),
		},
		backupFile: '/operator/downloads/backup.sql',
		baselineId: 'production-baseline-2026',
		baselineRegistry: createBaselineRegistry(),
		targetAccountId,
		targetName: 'kody-drill',
		trustRegistry: createTrustRegistry(),
		...overrides,
	}
}

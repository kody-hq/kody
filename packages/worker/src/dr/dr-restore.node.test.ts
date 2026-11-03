import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	backupBlobKey,
	backupStagingSchemaVersion,
	stagingArtifactsIndexKey,
	stagingR2IndexKey,
	stagingStorageDumpKey,
	stagingStorageIndexKey,
	type ArtifactsIndex,
	type StorageIndex,
} from '@kody-internal/shared/backup-staging.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import {
	__testOnlySealedObjectKey,
	handleDrRestoreRequest,
	runDrRestoreTick,
} from '#worker/dr/dr-restore.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'
import type {
	DrBackupS3Client,
	DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import { MaintenanceFailureError } from '#worker/maintenance-handler.ts'

const storageMocks = vi.hoisted(() => ({
	importStorage: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: () => ({
		importStorage: storageMocks.importStorage,
	}),
}))

function createMemoryS3(seed: Record<string, string | Uint8Array> = {}) {
	const objects = new Map<string, Uint8Array>()
	for (const [key, value] of Object.entries(seed)) {
		objects.set(
			key,
			typeof value === 'string' ? new TextEncoder().encode(value) : value,
		)
	}
	const client: DrBackupS3Client = {
		async head(key) {
			return {
				exists: objects.has(key),
				status: objects.has(key) ? 200 : 404,
				etag: objects.has(key) ? '"etag"' : null,
			}
		},
		async getText(key) {
			const bytes = objects.get(key)
			return bytes
				? { text: new TextDecoder().decode(bytes), etag: '"etag"' }
				: null
		},
		async getBytes(key) {
			return objects.get(key) ?? null
		},
		async put(key, body, _options?: DrBackupS3PutOptions) {
			objects.set(
				key,
				typeof body === 'string' ? new TextEncoder().encode(body) : body,
			)
			return { etag: '"etag"' }
		},
	}
	return { client, objects }
}

const day = '2026-07-23'
const identity = encodeStorageIdentity('user-a', 'job:1')
const dumpBody = `${JSON.stringify({ key: 'alpha', valueJson: '{"n":1}' })}\n`

function storageEntry(input: { bytes: number; sha256: string }) {
	return {
		storageId: identity,
		objectKey: stagingStorageDumpKey(day, identity),
		entryCount: 1,
		...input,
	}
}

function artifactEntry(snapshotSha256: string) {
	return {
		sourceId: 'src-1',
		entityKind: 'package',
		entityId: 'pkg-1',
		userId: ownerIdFromStored('user-a'),
		publishedCommit: 'commit-1',
		snapshotSha256,
	} satisfies ArtifactsIndex['entries'][number]
}

function createSealedS3(input: {
	storage?: StorageIndex['entries']
	dump?: string
	emailBlobsIndex?: string
	artifacts?: ArtifactsIndex['entries']
	blobs?: Record<string, string | Uint8Array>
}) {
	const sealed = (stagingKey: string) =>
		__testOnlySealedObjectKey(day, stagingKey)
	const seed: Record<string, string | Uint8Array> = {
		[sealed(stagingStorageIndexKey(day))]: JSON.stringify({
			schemaVersion: backupStagingSchemaVersion,
			day,
			entries: input.storage ?? [],
		} satisfies StorageIndex),
	}
	if (input.dump !== undefined) {
		seed[sealed(stagingStorageDumpKey(day, identity))] = input.dump
	}
	if (input.emailBlobsIndex !== undefined) {
		seed[sealed(stagingR2IndexKey(day, 'email-blobs'))] = input.emailBlobsIndex
		seed[sealed(stagingR2IndexKey(day, 'community-assets'))] = ''
	}
	if (input.artifacts) {
		seed[sealed(stagingArtifactsIndexKey(day))] = JSON.stringify({
			schemaVersion: backupStagingSchemaVersion,
			day,
			entries: input.artifacts,
		} satisfies ArtifactsIndex)
	}
	for (const [digest, body] of Object.entries(input.blobs ?? {})) {
		seed[backupBlobKey(digest)] = body
	}
	return createMemoryS3(seed).client
}

function baseEnv() {
	return {
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		EMAIL_BLOBS: { put: async () => {} },
		COMMUNITY_ASSETS: { put: async () => {} },
		BUNDLE_ARTIFACTS_KV: { put: async () => {} },
		STORAGE_RUNNER: {},
	} as unknown as Env
}

test('dr-restore auth fails closed when secret is missing and rejects wrong bearer', async () => {
	const request = (headers: Record<string, string>) =>
		new Request('https://example.com/__maintenance/dr-restore', {
			method: 'POST',
			headers,
			body: JSON.stringify({ day }),
		})
	expect((await handleDrRestoreRequest(request({}), {} as Env)).status).toBe(
		503,
	)
	expect(
		(
			await handleDrRestoreRequest(request({ Authorization: 'Bearer wrong' }), {
				DR_RESTORE_SECRET: 'correct',
			} as Env)
		).status,
	).toBe(401)
})

test('dr-restore restores storage, R2, and artifacts in chunked ticks', async () => {
	storageMocks.importStorage.mockResolvedValue({
		ok: true,
		written: 1,
		cleared: true,
	})
	const r2Bytes = new TextEncoder().encode('mime')
	const r2Digest = await sha256Hex(r2Bytes)
	const snapshot = JSON.stringify({ version: 1, files: { a: 'b' } })
	const snapshotDigest = await sha256Hex(snapshot)
	const s3 = createSealedS3({
		storage: [
			storageEntry({
				bytes: dumpBody.length,
				sha256: await sha256Hex(dumpBody),
			}),
		],
		dump: dumpBody,
		emailBlobsIndex: `${JSON.stringify({ key: 'raw/1', size: r2Bytes.byteLength, sha256: r2Digest })}\n`,
		artifacts: [artifactEntry(snapshotDigest)],
		blobs: { [r2Digest]: r2Bytes, [snapshotDigest]: snapshot },
	})

	const r2PutKeys: Array<string> = []
	const kvPutKeys: Array<string> = []
	const env = {
		...baseEnv(),
		EMAIL_BLOBS: { put: async (key: string) => void r2PutKeys.push(key) },
		BUNDLE_ARTIFACTS_KV: {
			put: async (key: string) => void kvPutKeys.push(key),
		},
	} as unknown as Env

	const first = await runDrRestoreTick({ env, day, timeBudgetMs: 0, s3 })
	expect(first.done).toBe(false)
	expect(first.nextCursor).toBeTruthy()

	const second = await runDrRestoreTick({
		env,
		day,
		cursor: first.nextCursor,
		timeBudgetMs: 60_000,
		s3,
	})
	expect(second.done).toBe(true)
	expect(storageMocks.importStorage).toHaveBeenCalledTimes(1)
	expect(r2PutKeys).toEqual(['raw/1'])
	expect(kvPutKeys).toEqual(['source-snapshot:v1:src-1:commit-1'])
})

test('dr-restore hard-fails closed on missing dumps, sha mismatches, and missing blobs', async () => {
	const badDigest = 'a'.repeat(64)
	const cases: Array<[string, Parameters<typeof createSealedS3>[0]]> = [
		[
			'Missing sealed storage dump',
			{ storage: [storageEntry({ bytes: 1, sha256: badDigest })] },
		],
		[
			'backup blob sha256 mismatch',
			{
				emailBlobsIndex: `${JSON.stringify({ key: 'raw/bad', size: 4, sha256: badDigest })}\n`,
				artifacts: [],
				blobs: { [badDigest]: new TextEncoder().encode('nope') },
			},
		],
		[
			'backup blob missing',
			{ emailBlobsIndex: '', artifacts: [artifactEntry('b'.repeat(64))] },
		],
		[
			'storage dump sha256 mismatch',
			{
				storage: [
					storageEntry({ bytes: dumpBody.length, sha256: 'c'.repeat(64) }),
				],
				dump: dumpBody,
			},
		],
	]
	storageMocks.importStorage.mockResolvedValue({
		ok: true,
		written: 0,
		cleared: true,
	})
	for (const [message, sealed] of cases) {
		await expect(
			runDrRestoreTick({
				env: baseEnv(),
				day,
				timeBudgetMs: 60_000,
				s3: createSealedS3(sealed),
			}),
		).rejects.toMatchObject({
			name: MaintenanceFailureError.name,
			message: expect.stringContaining(message),
		})
	}
	expect(storageMocks.importStorage).not.toHaveBeenCalled()
})

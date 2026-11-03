import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'

import { test, vi } from 'vitest'

import { DEFAULT_BACKUP_MAX_SOURCE_BYTES } from './d1-export-api.ts'
import { checkFreshness } from './freshness-check.ts'
import {
	MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES,
	putImmutableManifest,
	storeSignedDownload,
} from './immutable-storage.ts'
import { objectKeyForBookmark } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import {
	MemoryBucket,
	badSqlStatsFixture,
	encodeNodeBytesAsBase64,
	environment,
	identityApi,
	identityEnvelope,
	manifest,
	backupError,
	signedManifest,
} from './backup-control-plane-test-support.ts'

const at = (iso: string) => new Date(iso)
const check = (
	env: BackupEnvironment,
	when = '2026-07-22T03:45:00Z',
	api: Parameters<typeof checkFreshness>[2] = identityApi(),
) => checkFreshness(env, at(when), api)

/** Stores a 5-byte SQL object and its signed day manifest for `day`. */
async function seedDay(
	bucket: MemoryBucket,
	env: BackupEnvironment,
	day = '2026-07-22',
	source?: { accountId: string; databaseId: string; databaseName: string },
) {
	const prefix = `daily/d1/${env.SOURCE_DATABASE_ID}/${day}`
	const key = objectKeyForBookmark(prefix, 'bookmark-1')
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		key,
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	const template = manifest(stored)
	const dayManifest = signedManifest({
		...template.payload,
		...(source ? { source } : {}),
		export: {
			...template.payload.export,
			scheduledAt: `${day}T02:15:00.000Z`,
			startedAt: `${day}T02:15:01.000Z`,
			completedAt: `${day}T02:16:00.000Z`,
		},
		sql: { ...template.payload.sql, objectKey: key },
	})
	const manifestKey = `${prefix}/manifest.json`
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		manifestKey,
		dayManifest,
	)
	return { key, stored, manifestKey, dayManifest }
}

test('freshness accepts matching metadata and flags size/ETag drift, missing objects, or malformed manifests', async () => {
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const { key, stored, manifestKey } = await seedDay(bucket, env)
	assert.equal(await check(env), true)
	const events = consoleLog.mock.calls.map(
		([record]) => JSON.parse(String(record)).event,
	)
	assert.ok(events.includes('backup-stats-legacy-missing'))
	bucket.setReportedSize(key, MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES)
	assert.equal(await check(env), false)
	bucket.setReportedSize(key, stored.bytes)
	bucket.corrupt(key, 'drift')
	assert.equal(await check(env), false)
	bucket.corrupt(key, 'longer')
	assert.equal(await check(env), false)
	const emptyBucket = new MemoryBucket()
	const emptyEnv = environment(emptyBucket)
	assert.equal(await check(emptyEnv), false)
	await emptyBucket.put(manifestKey, JSON.stringify({ schemaVersion: 1 }))
	assert.equal(await check(emptyEnv), false)
})

test('freshness switches from yesterday to today at the 02:15 backup boundary', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	await seedDay(bucket, env, '2026-07-21')
	assert.equal(await check(env, '2026-07-22T01:45:00Z'), true)
	assert.equal(await check(env, '2026-07-22T02:45:00Z'), false)
})

test('freshness reports oversized SQL with a distinct unrestorable event', async () => {
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const day = '2026-07-31'
	const { key } = await seedDay(bucket, env, day)
	await bucket.put(
		`${key}.stats.json`,
		JSON.stringify(badSqlStatsFixture(day, key)),
	)

	assert.equal(await check(env, `${day}T03:45:00Z`), false)
	const record = JSON.parse(
		String(consoleLog.mock.calls.at(-1)?.[0]),
	) as Record<string, unknown>
	assert.equal(record.event, 'freshness-unrestorable')
	assert.equal(record.oversizedStatementCount, 1)
})

test('freshness requires a valid Ed25519 signature from the configured key', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const { manifestKey, dayManifest: valid } = await seedDay(bucket, env)
	const checkManifest = async (candidate = valid, candidateEnv = env) => {
		await bucket.put(manifestKey, JSON.stringify(candidate))
		return await check(candidateEnv)
	}
	const withPublicKey = (key: string) => ({
		...env,
		BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64: key,
	})
	const firstCharacter = valid.signature.value[0]

	assert.equal(await checkManifest(), true)
	const rejected: Array<[typeof valid, BackupEnvironment]> = [
		[{ ...valid, payload: { ...valid.payload, buildCommit: 'tampered' } }, env],
		[
			{
				...valid,
				signature: {
					...valid.signature,
					value: `${firstCharacter === 'A' ? 'B' : 'A'}${valid.signature.value.slice(1)}`,
				},
			},
			env,
		],
		[
			valid,
			withPublicKey(
				encodeNodeBytesAsBase64(
					generateKeyPairSync('ed25519').publicKey.export({
						format: 'der',
						type: 'spki',
					}),
				),
			),
		],
		[
			signedManifest({
				...valid.payload,
				signing: { ...valid.payload.signing, keyId: 'backup-manifest-other' },
			}),
			env,
		],
		[valid, withPublicKey('not-base64!')],
	]
	for (const [candidate, candidateEnv] of rejected) {
		assert.equal(await checkManifest(candidate, candidateEnv), false)
	}
})

test('freshness compares Cloudflare account and D1 IDs case-insensitively', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	env.SOURCE_ACCOUNT_ID = 'abcdefabcdefabcdefabcdefabcdefab'
	env.ALLOWED_SOURCE_ACCOUNT_IDS = env.SOURCE_ACCOUNT_ID.toUpperCase()
	env.SOURCE_DATABASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
	env.ALLOWED_SOURCE_DATABASE_IDS = env.SOURCE_DATABASE_ID.toUpperCase()
	await seedDay(bucket, env, '2026-07-22', {
		accountId: env.SOURCE_ACCOUNT_ID.toUpperCase(),
		databaseId: env.SOURCE_DATABASE_ID.toUpperCase(),
		databaseName: env.SOURCE_DATABASE_NAME,
	})
	assert.equal(
		await check(env, undefined, {
			fetcher: async () =>
				Response.json({
					success: true,
					result: {
						uuid: env.SOURCE_DATABASE_ID.toUpperCase(),
						name: env.SOURCE_DATABASE_NAME,
						file_size: 1_000,
					},
				}),
			sleep: async () => undefined,
		}),
		true,
	)
})

test('hourly freshness queries live D1 size and fails at the ceiling', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	let metadataRequests = 0
	await assert.rejects(
		check(environment(), undefined, {
			fetcher: async () => {
				metadataRequests += 1
				return identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES)
			},
		}),
		backupError('source-size-limit-exceeded'),
	)
	assert.equal(metadataRequests, 1)
	assert.equal(consoleError.mock.calls.length, 1)
})

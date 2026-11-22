import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { serializeBackupFullManifest } from '@kody-internal/shared/backup-full-manifest.ts'
import {
	buildSealedPacedChain,
	pacedTestSource,
	pacedTestTable,
	pacedTestTipDay,
} from '@kody-internal/shared/backup-d1-paced-test-support.ts'
import {
	pacedD1RetentionTierForDay,
	pacedD1SealedManifestKey,
} from '@kody-internal/shared/backup-d1-paced.ts'
import { sealedFullManifestKey } from '@kody-internal/shared/backup-staging.ts'
import { expect, test, vi } from 'vitest'

import {
	MemoryBucket,
	environment,
	exportEnvelope,
} from './backup-control-plane-test-support.ts'
import type { BackupEnvironment } from './backup-types.ts'
import { signBackupFullManifest } from './full-manifest-signing.ts'
import {
	runProductionRestore,
	restoreProgressFailsWorkflow,
} from './production-restore.ts'

const safetySql = 'CREATE TABLE safety(id INTEGER);\n'

async function putSealedFullManifest(
	bucket: MemoryBucket,
	env: BackupEnvironment,
	day: string,
	d1Paced?: Parameters<typeof signBackupFullManifest>[1]['d1Paced'],
) {
	const index = (name: string, char: string) => ({
		objectKey: `daily/full/${day}/${name}.json`,
		bytes: 2,
		sha256: char.repeat(64),
	})
	const full = await signBackupFullManifest(env, {
		day,
		d1Paced: d1Paced ?? [
			{
				databaseId: env.SOURCE_DATABASE_ID,
				databaseName: env.SOURCE_DATABASE_NAME,
				manifestKey: `daily/d1-paced/${env.SOURCE_DATABASE_ID}/${day}/manifest.json`,
				manifestSha256: 'f'.repeat(64),
			},
		],
		mailboxIndex: index('mailbox-index', 'd'),
		runLogIndex: index('run-log-index', 'e'),
		storageIndex: index('storage-index', 'b'),
		r2Indexes: {},
		artifactsIndex: index('artifacts-index', 'c'),
		sealedAt: `${day}T04:00:00.000Z`,
		buildCommit: 'abc123',
	})
	await bucket.put(
		sealedFullManifestKey(day),
		serializeBackupFullManifest(full),
	)
}

const restoreOptions = (day: string, fetcher: typeof fetch) => ({
	now: new Date(`${day}T12:00:00.000Z`),
	sleep: async () => undefined,
	maxPollAttempts: 3,
	pollDelayMs: 1,
	fetcher,
})

function pacedProductionFetcher(
	input: { dropRowAfterImport?: boolean; warnings?: Array<string> } = {},
) {
	const db = new DatabaseSync(':memory:')
	const state = { exportCalls: 0, imports: 0, restoreCalls: 0 }
	let upload = ''
	let dropped = false
	const ok = (result: unknown) => Response.json({ success: true, result })
	const fetcher = async (request: RequestInfo | URL, init?: RequestInit) => {
		const url = String(request)
		if (url.includes('api.cloudflare.com') && url.includes('/export')) {
			state.exportCalls += 1
			return exportEnvelope(state.exportCalls === 1 ? 'active' : 'complete')
		}
		if (url.includes('download.example')) {
			return new Response(safetySql, {
				headers: { 'content-length': String(safetySql.length) },
			})
		}
		if (url.includes('upload.example')) {
			upload = await new Response(init?.body).text()
			const md5 = createHash('md5').update(upload).digest('hex')
			return new Response(null, { headers: { etag: `"${md5}"` } })
		}
		if (url.includes('/__maintenance/dr-restore')) {
			state.restoreCalls += 1
			return Response.json({
				done: true,
				progress: { step: 'done' },
				warnings: input.warnings ?? [],
			})
		}
		const body = JSON.parse(String(init?.body ?? '{}')) as {
			sql?: string
			action?: string
		}
		if (url.endsWith('/query')) {
			if (input.dropRowAfterImport && !dropped) {
				dropped = true
				db.exec(
					`DELETE FROM "${pacedTestTable}" WHERE rowid = (SELECT max(rowid) FROM "${pacedTestTable}")`,
				)
			}
			return ok([{ results: db.prepare(body.sql ?? '').all() }])
		}
		switch (body.action) {
			case 'init':
				return ok({
					upload_url: 'https://upload.example/sql',
					filename: 'import.sql',
				})
			case 'ingest':
				state.imports += 1
				db.exec(upload)
				return ok({ at_bookmark: 'bookmark', type: 'import' })
			case 'poll':
				return ok({ status: 'complete', success: true, type: 'import' })
			default:
				throw new Error(`unexpected fetch ${url}`)
		}
	}
	return { db, state, fetcher }
}

type PacedRef = NonNullable<Parameters<typeof putSealedFullManifest>[3]>[number]

async function seedPacedOnlyDay(
	input: {
		tamper?: (objects: Map<string, string>) => void
		refs?: (ref: PacedRef) => Array<PacedRef>
	} = {},
) {
	const { objects } = await buildSealedPacedChain()
	const manifestKey = pacedD1SealedManifestKey(
		pacedD1RetentionTierForDay(pacedTestTipDay),
		pacedTestSource.id,
		pacedTestTipDay,
	)
	const ref: PacedRef = {
		databaseId: pacedTestSource.id,
		databaseName: pacedTestSource.name,
		manifestKey,
		manifestSha256: createHash('sha256')
			.update(objects.get(manifestKey)!)
			.digest('hex'),
	}
	input.tamper?.(objects)
	const bucket = new MemoryBucket()
	for (const [key, text] of objects) await bucket.put(key, text)
	const env = environment(bucket)
	env.D1_PACED_SOURCES = JSON.stringify([pacedTestSource])
	env.SOURCE_DATABASE_ID = pacedTestSource.id
	env.SOURCE_DATABASE_NAME = pacedTestSource.name
	env.ALLOWED_SOURCE_DATABASE_IDS = pacedTestSource.id
	await putSealedFullManifest(
		bucket,
		env,
		pacedTestTipDay,
		input.refs?.(ref) ?? [ref],
	)
	return env
}

test('production restore replays a paced-only day into the source database and verifies it', async () => {
	const env = await seedPacedOnlyDay()
	const d1 = pacedProductionFetcher()
	const progress = await runProductionRestore(
		env,
		{ day: pacedTestTipDay, requestedAt: `${pacedTestTipDay}T12:00:00.000Z` },
		restoreOptions(pacedTestTipDay, d1.fetcher as typeof fetch),
	)
	expect(progress.phase).toBe('complete')
	expect(d1.state.imports).toBeGreaterThan(0)
	expect(d1.state.restoreCalls).toBeGreaterThan(0)
	expect(
		d1.db.prepare(`SELECT count(*) AS n FROM "${pacedTestTable}"`).get(),
	).toEqual({ n: expect.any(Number) })
})

test('production restore fails a paced-only day when the restored rows do not match the sealed manifest', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	const env = await seedPacedOnlyDay()
	const d1 = pacedProductionFetcher({ dropRowAfterImport: true })
	await expect(
		runProductionRestore(
			env,
			{ day: pacedTestTipDay, requestedAt: `${pacedTestTipDay}T12:00:00.000Z` },
			restoreOptions(pacedTestTipDay, d1.fetcher as typeof fetch),
		),
	).rejects.toMatchObject({ code: 'restore-paced-verify-mismatch' })
	expect(d1.state.restoreCalls).toBe(0)
})

async function expectPacedRestoreRefusedUntouched(
	env: BackupEnvironment,
	code?: string,
) {
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	const d1 = pacedProductionFetcher()
	const restore = runProductionRestore(
		env,
		{ day: pacedTestTipDay, requestedAt: `${pacedTestTipDay}T12:00:00.000Z` },
		restoreOptions(pacedTestTipDay, d1.fetcher as typeof fetch),
	)
	await (code === undefined
		? expect(restore).rejects.toThrow()
		: expect(restore).rejects.toMatchObject({ code }))
	expect(d1.state).toEqual({ exportCalls: 0, imports: 0, restoreCalls: 0 })
}

test('a missing paced base part refuses the restore before production is touched', async () => {
	await expectPacedRestoreRefusedUntouched(
		await seedPacedOnlyDay({
			tamper: (objects) => {
				const part = [...objects.keys()].find((key) =>
					key.includes(`/data/${pacedTestTable}.parts/0000.tsv`),
				)
				objects.delete(part!)
			},
		}),
	)
})

test('a sealed paced source missing from configuration refuses the restore', async () => {
	await expectPacedRestoreRefusedUntouched(
		await seedPacedOnlyDay({
			refs: (ref) => [
				ref,
				{
					...ref,
					databaseId: '44444444-4444-4444-8444-444444444444',
					databaseName: 'kody-audit',
					manifestKey: pacedD1SealedManifestKey(
						pacedD1RetentionTierForDay(pacedTestTipDay),
						'44444444-4444-4444-8444-444444444444',
						pacedTestTipDay,
					),
				},
			],
		}),
		'restore-d1-source-not-configured',
	)
})

test('a paced manifest that differs from the signed digest refuses the restore', async () => {
	await expectPacedRestoreRefusedUntouched(
		await seedPacedOnlyDay({
			refs: (ref) => [{ ...ref, manifestSha256: 'a'.repeat(64) }],
		}),
		'restore-paced-manifest-digest-mismatch',
	)
})

test('production restore of a paced day with no sealed chain refuses before production is touched', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const day = '2026-11-17'
	await putSealedFullManifest(bucket, env, day)
	await expect(
		runProductionRestore(
			env,
			{ day, requestedAt: `${day}T12:00:00.000Z` },
			{
				fetcher: async () => {
					throw new Error('restore should not start')
				},
			},
		),
	).rejects.toMatchObject({ code: 'restore-paced-seal-missing' })
})

test('runProductionRestore returns failed progress when dr-restore emits warnings', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	const env = await seedPacedOnlyDay()
	const d1 = pacedProductionFetcher({
		warnings: ['storage-partial', 'blob-skipped'],
	})
	const progress = await runProductionRestore(
		env,
		{ day: pacedTestTipDay, requestedAt: `${pacedTestTipDay}T12:00:00.000Z` },
		restoreOptions(pacedTestTipDay, d1.fetcher as typeof fetch),
	)
	expect(progress).toMatchObject({
		phase: 'failed',
		errorCode: 'dr-restore-warnings',
		warnings: ['storage-partial', 'blob-skipped'],
		storeRestoreComplete: true,
		d1ImportComplete: true,
		safetyExportBytes: safetySql.length,
	})
	expect(restoreProgressFailsWorkflow(progress)).toBe(true)
	expect(await env.BACKUP_BUCKET.head(progress.safetyExportKey!)).not.toBeNull()
})

test('a REST-era schema v1/v2 day is rejected by name before production is touched', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined)
	for (const [day, schemaVersion] of [
		['2026-11-16', 2],
		['2026-08-01', 1],
	] as const) {
		const bucket = new MemoryBucket()
		const env = environment(bucket)
		await putSealedFullManifest(bucket, env, day)
		const stored = JSON.parse(
			await (await bucket.get(sealedFullManifestKey(day)))!.text(),
		) as { schemaVersion: number; payload: { schemaVersion: number } }
		stored.schemaVersion = schemaVersion
		stored.payload.schemaVersion = schemaVersion
		await bucket.put(sealedFullManifestKey(day), JSON.stringify(stored))
		let fetchCalls = 0
		const restore = runProductionRestore(
			env,
			{ day, requestedAt: `${day}T12:00:00.000Z` },
			{
				fetcher: async () => {
					fetchCalls += 1
					throw new Error('restore should not start')
				},
			},
		)
		await expect(restore).rejects.toMatchObject({
			code: 'restore-rest-era-day',
		})
		await expect(restore).rejects.toThrow(
			new RegExp(
				`^${day} is a REST-era backup day .*REST-era backups are no longer restorable`,
			),
		)
		expect(fetchCalls).toBe(0)
	}
})

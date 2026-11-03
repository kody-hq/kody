import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import {
	backupFullManifestSchemaVersion,
	backupFullManifestSignatureAlgorithm,
	canonicalBackupFullManifestPayload,
	serializeBackupFullManifest,
	type BackupFullManifest,
	type BackupFullManifestPayload,
} from '@kody-internal/shared/backup-full-manifest.ts'
import {
	backupStagingSchemaVersion,
	sealedFullManifestKey,
	sealedFullPrefix,
	stagingMailboxDumpKey,
	type MailboxIndex,
} from '@kody-internal/shared/backup-staging.ts'
import {
	mailboxImportReplaceConfirmation,
	runMailboxImportTick,
} from '#worker/dr/mailbox-importer.ts'
import { handleMailboxImportRequest } from '#worker/dr/mailbox-import-maintenance.ts'
import type {
	DrBackupS3Client,
	DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'

const mailboxMocks = vi.hoisted(() => ({
	countMailbox: vi.fn(),
	inspectRestoreState: vi.fn(),
	beginRestore: vi.fn(),
	finalizeRestore: vi.fn(),
	readDrillResult: vi.fn(),
	completeDrill: vi.fn(),
	purge: vi.fn(),
	upsertMessageGraph: vi.fn(),
	upsertDeliveryEvents: vi.fn(),
}))

vi.mock('#worker/email/mailbox-client.ts', () => ({
	mailboxRpc: () => mailboxMocks,
}))

const emptyCounts = {
	threads: 0,
	messages: 0,
	attachments: 0,
	deliveryEvents: 0,
}
const threadCounts = { ...emptyCounts, threads: 2 }
const replace = {
	conflictPolicy: 'replace' as const,
	replaceConfirmation: mailboxImportReplaceConfirmation,
}

function restoreStatus(counts: typeof emptyCounts) {
	return {
		counts,
		hiddenRows: 0,
		restorePending: false,
		empty: Object.values(counts).every((count) => count === 0),
	}
}

function createMemoryS3(seed: Record<string, string>) {
	const objects = new Map<string, Uint8Array>()
	const put = (key: string, body: string | Uint8Array) =>
		objects.set(
			key,
			typeof body === 'string' ? new TextEncoder().encode(body) : body,
		)
	for (const [key, value] of Object.entries(seed)) put(key, value)
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
			put(key, body)
			return { etag: '"etag"' }
		},
	}
	return { client, objects }
}

async function createBackup(
	options: {
		indexDumpOwnerId?: string
		sealedAt?: string
		threadRowExtra?: Record<string, unknown>
	} = {},
) {
	const day = '2026-08-01'
	const ownerId = ownerIdFromStored('owner-a')
	const dump = ['thread-a', 'thread-b']
		.map((id) =>
			JSON.stringify({
				kind: 'thread',
				row: {
					id,
					inboxId: null,
					subjectNormalized: 'subject',
					rootMessageIdHeader: null,
					lastMessageAt: '2026-08-01T00:00:00.000Z',
					createdAt: '2026-08-01T00:00:00.000Z',
					updatedAt: '2026-08-01T00:00:00.000Z',
					...options.threadRowExtra,
				},
			}),
		)
		.map((line) => `${line}\n`)
		.join('')
	const index: MailboxIndex = {
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: [
			{
				ownerId,
				objectKey: stagingMailboxDumpKey(
					day,
					options.indexDumpOwnerId ?? ownerId,
				),
				entryCount: 2,
				bytes: new TextEncoder().encode(dump).byteLength,
				sha256: await sha256Hex(dump),
			},
		],
	}
	const indexBody = JSON.stringify(index)
	const prefix = sealedFullPrefix(day)
	const file = (name: string, sha: string) => ({
		objectKey: `${prefix}${name}`,
		bytes: 0,
		sha256: sha.repeat(64),
	})
	const mailboxIndex = {
		objectKey: `${prefix}mailbox-index.json`,
		bytes: new TextEncoder().encode(indexBody).byteLength,
		sha256: await sha256Hex(indexBody),
	}
	const keys = generateKeyPairSync('ed25519')
	const keyId = 'node-test-key'
	const payload: BackupFullManifestPayload = {
		schemaVersion: backupFullManifestSchemaVersion,
		day,
		d1ManifestKey: `daily/d1/${day}/manifest.json`,
		d1ManifestSha256: 'a'.repeat(64),
		mailboxIndex,
		runLogIndex: file('run-log-index.json', 'b'),
		storageIndex: file('storage-index.json', 'c'),
		r2Indexes: {},
		artifactsIndex: file('artifacts-index.json', 'd'),
		sealedAt: options.sealedAt ?? '2026-08-02T06:00:00.000Z',
		buildCommit: 'node-test',
		signing: { algorithm: backupFullManifestSignatureAlgorithm, keyId },
	}
	const manifest: BackupFullManifest = {
		schemaVersion: backupFullManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
			value: signBytes(
				null,
				Buffer.from(canonicalBackupFullManifestPayload(payload)),
				keys.privateKey,
			).toString('base64'),
		},
	}
	const s3 = createMemoryS3({
		[sealedFullManifestKey(day)]: serializeBackupFullManifest(manifest),
		[mailboxIndex.objectKey]: indexBody,
		[`${prefix}mailbox/${encodeURIComponent(ownerId)}.ndjson`]: dump,
	})
	const env = {
		DR_RESTORE_SECRET: 'node-test-restore-secret',
		DR_BACKUP_ACCOUNT_ID: 'account',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'access',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		BACKUP_MANIFEST_SIGNING_KEY_ID: keyId,
		BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64: keys.publicKey
			.export({ format: 'der', type: 'spki' })
			.toString('base64'),
	} as unknown as Env
	return {
		day,
		ownerId,
		manifest,
		s3,
		env,
		tick(input: Partial<Parameters<typeof runMailboxImportTick>[0]> = {}) {
			return runMailboxImportTick({
				env,
				day,
				owners: [ownerId],
				s3: s3.client,
				...input,
			})
		},
	}
}

function resetMailboxMocks() {
	for (const mock of Object.values(mailboxMocks)) mock.mockReset()
	mailboxMocks.purge.mockResolvedValue({ ok: true })
	mailboxMocks.inspectRestoreState.mockResolvedValue(restoreStatus(emptyCounts))
	mailboxMocks.finalizeRestore.mockResolvedValue({ ok: true })
	mailboxMocks.beginRestore.mockResolvedValue({ ok: true })
	mailboxMocks.readDrillResult.mockResolvedValue(null)
	mailboxMocks.completeDrill.mockResolvedValue({ ok: true })
	mailboxMocks.upsertMessageGraph.mockResolvedValue({
		ok: true,
		accepted: true,
	})
	mailboxMocks.upsertDeliveryEvents.mockResolvedValue({ results: [] })
}

/** Lets the first `freeTicks` Date.now reads see t=0, then jumps past a 1ms budget. */
function exhaustBudgetAfter(freeTicks: number) {
	const now = vi.spyOn(Date, 'now')
	for (let index = 0; index < freeTicks; index += 1) now.mockReturnValueOnce(0)
	now.mockReturnValue(2)
	return { [Symbol.dispose]: () => now.mockRestore() }
}

test('mailbox import endpoint is secret-gated and replace needs exact confirmation', async () => {
	const request = (headers: Record<string, string>, body: object) =>
		new Request('https://example.com/__maintenance/dr-mailbox-import', {
			method: 'POST',
			headers,
			body: JSON.stringify({ day: '2026-08-01', owners: ['owner-a'], ...body }),
		})
	const configured = { DR_RESTORE_SECRET: 'correct' } as Env

	expect(
		(await handleMailboxImportRequest(request({}, {}), {} as Env)).status,
	).toBe(503)
	expect(
		(
			await handleMailboxImportRequest(
				request({ Authorization: 'Bearer wrong' }, {}),
				configured,
			)
		).status,
	).toBe(401)

	const unconfirmed = await handleMailboxImportRequest(
		request(
			{ Authorization: 'Bearer correct', 'Content-Type': 'application/json' },
			{ conflictPolicy: 'replace', replaceConfirmation: 'almost' },
		),
		configured,
	)
	expect(unconfirmed.status).toBe(500)
	expect(await unconfirmed.json()).toMatchObject({
		ok: false,
		error: expect.stringContaining(mailboxImportReplaceConfirmation),
	})
})

test('mailbox importer verifies sealed media before writes', async () => {
	// Occupied-target and tampered-dump fail-closed paths are covered by the
	// workers DO workflow; keep node-only signature/schema guards here.
	const invalidSignature = await createBackup()
	invalidSignature.s3.objects.set(
		sealedFullManifestKey(invalidSignature.day),
		new TextEncoder().encode(
			serializeBackupFullManifest({
				...invalidSignature.manifest,
				signature: {
					...invalidSignature.manifest.signature,
					value: Buffer.alloc(64).toString('base64'),
				},
			}),
		),
	)
	await expect(invalidSignature.tick()).rejects.toThrow(/signature is invalid/)
	expect(mailboxMocks.countMailbox).not.toHaveBeenCalled()

	const swappedOwnerKey = await createBackup({ indexDumpOwnerId: 'owner-b' })
	await expect(swappedOwnerKey.tick()).rejects.toThrow(/invalid owner entry/)
	expect(mailboxMocks.countMailbox).not.toHaveBeenCalled()

	resetMailboxMocks()
	const unknownField = await createBackup({
		threadRowExtra: { unexpected: true },
	})
	await expect(unknownField.tick()).rejects.toThrow(/missing or unknown fields/)
	expect(mailboxMocks.inspectRestoreState).not.toHaveBeenCalled()
})

test('mailbox importer rejects a cursor from a different sealed generation', async () => {
	resetMailboxMocks()
	const original = await createBackup()
	const first = await original.tick({ timeBudgetMs: 0 })
	expect(first.nextCursor).toBeTruthy()

	const replacement = await createBackup({
		sealedAt: '2026-08-02T07:00:00.000Z',
	})
	await expect(
		replacement.tick({ cursor: first.nextCursor, timeBudgetMs: 60_000 }),
	).rejects.toThrow(/cursor does not match this import request/)
})

test('drill cleanup stays idempotent across lost responses for success and mismatch', async () => {
	for (const [counts, verified] of [
		[threadCounts, true],
		[emptyCounts, false],
	] as const) {
		resetMailboxMocks()
		const backup = await createBackup()
		let beforeVerify
		{
			using _clock = exhaustBudgetAfter(3)
			beforeVerify = await backup.tick({ drill: true, timeBudgetMs: 1 })
		}
		expect(beforeVerify.progress.phase).toBe('verify')
		const resume = () =>
			backup.tick({
				drill: true,
				cursor: beforeVerify.nextCursor,
				timeBudgetMs: 60_000,
			})

		mailboxMocks.countMailbox.mockResolvedValueOnce(counts)
		expect((await resume()).verified).toBe(verified)
		const cleanupCalls = mailboxMocks.completeDrill.mock.calls.length

		mailboxMocks.readDrillResult.mockResolvedValueOnce(counts)
		expect((await resume()).verified).toBe(verified)
		expect(mailboxMocks.completeDrill).toHaveBeenCalledTimes(cleanupCalls)
	}
})

test('mailbox importer resumes replacement idempotently and reports count mismatch', async () => {
	resetMailboxMocks()
	const backup = await createBackup()
	mailboxMocks.inspectRestoreState
		.mockResolvedValueOnce(restoreStatus(threadCounts))
		.mockResolvedValueOnce(restoreStatus(emptyCounts))
		.mockResolvedValue(restoreStatus(threadCounts))
	mailboxMocks.countMailbox.mockResolvedValue(threadCounts)
	let first
	{
		using _clock = exhaustBudgetAfter(2)
		first = await backup.tick({ ...replace, timeBudgetMs: 1 })
	}
	expect(first.done).toBe(false)
	expect(first.progress.phase).toBe('preflight-threads')
	expect(mailboxMocks.purge).not.toHaveBeenCalled()
	expect(mailboxMocks.upsertMessageGraph).toHaveBeenCalledTimes(1)

	const [payload, signature] = first.nextCursor!.split('.')
	const forgedPayload = btoa(
		JSON.stringify({
			...(JSON.parse(atob(payload!)) as Record<string, unknown>),
			phase: 'done',
			ownerIndex: 1,
			rowIndex: 0,
			ownersPassed: 1,
		}),
	)
	await expect(
		backup.tick({
			...replace,
			cursor: `${forgedPayload}.${signature}`,
			timeBudgetMs: 60_000,
		}),
	).rejects.toThrow(/cursor signature is invalid/)

	const resume = () =>
		backup.tick({ ...replace, cursor: first.nextCursor, timeBudgetMs: 60_000 })
	expect(await resume()).toMatchObject({
		done: true,
		verified: true,
		progress: { ownersPassed: 1, ownersMismatched: 0, ownersReplaced: 1 },
	})
	expect(mailboxMocks.purge).toHaveBeenCalledWith({ ownerId: backup.ownerId })
	expect(mailboxMocks.upsertMessageGraph).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: backup.ownerId,
			thread: expect.objectContaining({ id: 'thread-b' }),
			message: null,
		}),
	)
	expect((await resume()).verified).toBe(true)

	resetMailboxMocks()
	mailboxMocks.upsertMessageGraph.mockResolvedValue({
		ok: true,
		accepted: false,
	})
	await expect(
		(await createBackup()).tick({ timeBudgetMs: 60_000 }),
	).rejects.toThrow(/rejected restored thread/)
	expect(mailboxMocks.countMailbox).not.toHaveBeenCalled()

	resetMailboxMocks()
	mailboxMocks.countMailbox.mockResolvedValue(emptyCounts)
	const mismatch = await (
		await createBackup()
	).tick({ owners: 'all-from-index', timeBudgetMs: 60_000 })
	expect(mismatch).toMatchObject({
		done: true,
		verified: false,
		progress: { ownersPassed: 0, ownersMismatched: 1 },
		ownerResults: [
			{
				sourceOwnerId: backup.ownerId,
				expected: threadCounts,
				actual: emptyCounts,
				matches: false,
				drill: false,
			},
		],
		warnings: [expect.stringContaining('count mismatch')],
	})
})

import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
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
	emailAttachmentBlobKey,
	emailRawMimeKey,
} from '#worker/email/blob-keys.ts'
import { mailboxRpc } from '#worker/email/mailbox-client.ts'
import {
	type MailboxDeliveryEventRecord,
	type MailboxExportRow,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxThreadRecord,
} from '#worker/email/mailbox-types.ts'
import {
	mailboxImportDrillOwnerPrefix,
	mailboxImportReplaceConfirmation,
	runMailboxImportTick,
} from '#worker/dr/mailbox-importer.ts'
import {
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
function createMemoryS3(seed: Record<string, string | Uint8Array>) {
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

function message(ownerId: string): MailboxMessageRecord & MailboxMessageInput {
	return {
		id: 'restore-message',
		direction: 'inbound',
		inboxId: 'inbox-1',
		threadId: 'restore-thread',
		senderIdentityId: null,
		fromAddress: 'sender@example.com',
		envelopeFrom: 'sender@example.com',
		toAddresses: ['inbox@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: 'Restored message',
		messageIdHeader: '<restore@example.com>',
		inReplyToHeader: null,
		references: [],
		headers: { from: 'sender@example.com' },
		authResults: null,
		textBody: 'restored',
		htmlBody: null,
		rawMimeKey: emailRawMimeKey(ownerIdFromStored(ownerId), 'restore-message'),
		rawSize: 8,
		processingStatus: 'stored',
		classification: 'accepted',
		classificationReason: null,
		archivedAt: '2026-08-01T01:02:04.000Z',
		providerMessageId: null,
		deliveryStatus: 'delivered',
		deliveryStatusAt: '2026-08-01T01:02:03.000Z',
		error: null,
		receivedAt: '2026-08-01T01:02:03.000Z',
		sentAt: null,
		createdAt: '2026-08-01T01:02:03.000Z',
		updatedAt: '2026-08-01T01:02:04.000Z',
	}
}

function deliveryEvent(): MailboxDeliveryEventRecord {
	return {
		id: 'restore-event',
		messageId: 'restore-message',
		inboxId: 'inbox-1',
		eventType: 'delivered',
		provider: 'kody',
		providerMessageId: null,
		providerEventId: 'restore-provider-event',
		detailJson: '{}',
		needsEffectReconcile: false,
		state: null,
		fingerprint: null,
		storageLease: null,
		storageLeaseAt: null,
		cleanupLease: null,
		cleanupLeaseAt: null,
		cleanupRetryAt: null,
		expectedAttachmentCount: null,
		finalizationToken: null,
		reconcileAfter: null,
		dedupeExpiresAt: null,
		usageEffectRecordedAt: null,
		usageEffectSuppressedAt: null,
		usageStartedAt: null,
		usageMonth: null,
		usageBytes: null,
		usageDurationMs: null,
		usageEffectRetryAt: null,
		usageEffectLease: null,
		usageEffectLeaseAt: null,
		subscriptionEffectState: null,
		subscriptionEffectLease: null,
		subscriptionEffectLeaseAt: null,
		subscriptionEffectRetryAt: null,
		subscriptionEffectAttemptCount: null,
		subscriptionEffectDeadLetterAt: null,
		subscriptionEffectLastError: null,
		createdAt: '2026-08-01T01:02:05.000Z',
		updatedAt: '2026-08-01T01:02:05.000Z',
	}
}

async function createBackup(
	ownerId: string,
	day: string,
	options: { duplicateProviderEvent?: boolean } = {},
) {
	const thread: MailboxThreadRecord = {
		id: 'restore-thread',
		inboxId: 'inbox-1',
		subjectNormalized: 'restored message',
		rootMessageIdHeader: '<restore@example.com>',
		lastMessageAt: '2026-08-01T01:02:03.000Z',
		createdAt: '2026-08-01T01:02:03.000Z',
		updatedAt: '2026-08-01T01:02:04.000Z',
	}
	const rows: Array<MailboxExportRow> = [
		{ kind: 'thread', row: thread },
		{ kind: 'message', row: message(ownerId) },
		{
			kind: 'attachment',
			row: {
				id: 'restore-attachment',
				messageId: 'restore-message',
				filename: 'restore.txt',
				contentType: 'text/plain',
				contentId: null,
				disposition: 'attachment',
				size: 8,
				storageKind: 'external',
				storageKey: emailAttachmentBlobKey(
					ownerIdFromStored(ownerId),
					'restore-message',
					'restore-attachment',
				),
				createdAt: '2026-08-01T01:02:03.000Z',
			},
		},
		{ kind: 'delivery_event', row: deliveryEvent() },
	]
	if (options.duplicateProviderEvent) {
		rows.push({
			kind: 'delivery_event',
			row: { ...deliveryEvent(), id: 'restore-event-duplicate' },
		})
	}
	const dump = rows.map((row) => `${JSON.stringify(row)}\n`).join('')
	const stagingDumpKey = stagingMailboxDumpKey(day, ownerId)
	const index: MailboxIndex = {
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: [
			{
				ownerId,
				objectKey: stagingDumpKey,
				entryCount: rows.length,
				bytes: new TextEncoder().encode(dump).byteLength,
				sha256: await sha256Hex(dump),
			},
		],
	}
	const indexBody = JSON.stringify(index)
	const mailboxIndex = {
		objectKey: `${sealedFullPrefix(day)}mailbox-index.json`,
		bytes: new TextEncoder().encode(indexBody).byteLength,
		sha256: await sha256Hex(indexBody),
	}
	const keyPair = await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify',
	])
	const keyId = 'workers-test-key'
	const payload: BackupFullManifestPayload = {
		schemaVersion: backupFullManifestSchemaVersion,
		day,
		d1ManifestKey: `daily/d1/${day}/manifest.json`,
		d1ManifestSha256: 'a'.repeat(64),
		mailboxIndex,
		runLogIndex: {
			objectKey: `${sealedFullPrefix(day)}run-log-index.json`,
			bytes: 0,
			sha256: 'b'.repeat(64),
		},
		storageIndex: {
			objectKey: `${sealedFullPrefix(day)}storage-index.json`,
			bytes: 0,
			sha256: 'c'.repeat(64),
		},
		r2Indexes: {},
		artifactsIndex: {
			objectKey: `${sealedFullPrefix(day)}artifacts-index.json`,
			bytes: 0,
			sha256: 'd'.repeat(64),
		},
		sealedAt: '2026-08-02T06:00:00.000Z',
		buildCommit: 'workers-test',
		signing: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
		},
	}
	const signature = await crypto.subtle.sign(
		backupFullManifestSignatureAlgorithm,
		keyPair.privateKey,
		new TextEncoder().encode(canonicalBackupFullManifestPayload(payload)),
	)
	const manifest: BackupFullManifest = {
		schemaVersion: backupFullManifestSchemaVersion,
		payload,
		signature: {
			algorithm: backupFullManifestSignatureAlgorithm,
			keyId,
			value: btoa(String.fromCharCode(...new Uint8Array(signature))),
		},
	}
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey('spki', keyPair.publicKey),
	)
	const dumpKey = `${sealedFullPrefix(day)}mailbox/${encodeURIComponent(ownerId)}.ndjson`
	const s3 = createMemoryS3({
		[sealedFullManifestKey(day)]: serializeBackupFullManifest(manifest),
		[mailboxIndex.objectKey]: indexBody,
		[dumpKey]: dump,
	})
	const backupEnv = Object.assign(Object.create(env), {
		DR_RESTORE_SECRET: 'workers-test-restore-secret',
		BACKUP_MANIFEST_SIGNING_KEY_ID: keyId,
		BACKUP_MANIFEST_VERIFYING_PUBLIC_KEY_SPKI_BASE64: btoa(
			String.fromCharCode(...publicKey),
		),
	}) as Env
	return {
		s3,
		dumpKey,
		tick(input: Partial<Parameters<typeof runMailboxImportTick>[0]> = {}) {
			return runMailboxImportTick({
				env: backupEnv,
				day,
				owners: [ownerId],
				s3: s3.client,
				...input,
			})
		},
		mailbox(userId = ownerId) {
			return mailboxRpc({ env: backupEnv, userId: ownerIdFromStored(userId) })
		},
		readAlarm(userId: string) {
			const stub = backupEnv.MAILBOX.get(backupEnv.MAILBOX.idFromName(userId))
			return runInDurableObject(stub, (_instance, state) =>
				state.storage.getAlarm(),
			)
		},
		seedExistingMessage(messageId: string) {
			return mailboxRpc({
				env: backupEnv,
				userId: ownerIdFromStored(ownerId),
			}).upsertMessageGraph({
				ownerId: ownerIdFromStored(ownerId),
				message: {
					...message(ownerId),
					id: messageId,
					threadId: null,
					rawMimeKey: emailRawMimeKey(ownerIdFromStored(ownerId), messageId),
				},
			})
		},
	}
}

const emptyCounts = {
	threads: 0,
	messages: 0,
	attachments: 0,
	deliveryEvents: 0,
}
const replace = {
	conflictPolicy: 'replace',
	replaceConfirmation: mailboxImportReplaceConfirmation,
} as const

test('Mailbox importer drills into scratch objects, resumes, and fails closed', async () => {
	silenceIncidentalRuntimeWarnings()
	const day = '2026-08-01'
	const ownerId = `workers-import-source-${crypto.randomUUID()}`
	const backup = await createBackup(ownerId, day)

	const first = await backup.tick({ drill: true, timeBudgetMs: 0 })
	expect(first.done).toBe(false)
	expect(first.nextCursor).toBeTruthy()
	expect(first.progress.phase).toBe('threads')

	const completed = await backup.tick({
		drill: true,
		cursor: first.nextCursor,
		timeBudgetMs: 60_000,
	})
	expect(completed.done).toBe(true)
	expect(completed.verified).toBe(true)
	expect(completed.ownerResults).toEqual([
		expect.objectContaining({
			sourceOwnerId: ownerId,
			matches: true,
			drill: true,
		}),
	])

	const drillOwnerId = ownerIdFromStored(
		`${mailboxImportDrillOwnerPrefix}${day}:${encodeURIComponent(ownerId)}`,
	)
	const scratch = backup.mailbox(drillOwnerId)
	expect(await scratch.countMailbox()).toEqual(emptyCounts)
	expect(await scratch.getMessage({ messageId: 'restore-message' })).toBeNull()
	expect(await scratch.readDrillResult({ ownerId: drillOwnerId })).toEqual({
		threads: 1,
		messages: 1,
		attachments: 1,
		deliveryEvents: 1,
	})
	expect(await backup.mailbox().countMailbox()).toEqual(emptyCounts)
	expect(await backup.readAlarm(drillOwnerId)).toBeNull()

	const occupiedOwner = `workers-import-occupied-${crypto.randomUUID()}`
	const occupied = await createBackup(occupiedOwner, day)
	await occupied.seedExistingMessage('existing-message')
	await expect(occupied.tick()).rejects.toThrow(/non-empty/)
	expect(
		await occupied.mailbox().getMessage({ messageId: 'existing-message' }),
	).not.toBeNull()

	const replacementStarted = await occupied.tick({
		...replace,
		timeBudgetMs: 0,
	})
	expect(replacementStarted.progress.phase).toBe('preflight-threads')
	expect(
		await occupied.mailbox().getMessage({ messageId: 'existing-message' }),
	).not.toBeNull()
	expect(
		await occupied.readAlarm(
			`__mailbox-import-preflight__:${day}:${encodeURIComponent(occupiedOwner)}`,
		),
	).toBeNull()
	const replacementCompleted = await occupied.tick({
		...replace,
		cursor: replacementStarted.nextCursor,
		timeBudgetMs: 60_000,
	})
	expect(replacementCompleted.verified).toBe(true)
	const replacedMailbox = occupied.mailbox()
	expect(
		await replacedMailbox.getMessage({ messageId: 'existing-message' }),
	).toBeNull()
	expect(
		await replacedMailbox.getMessage({ messageId: 'restore-message' }),
	).toMatchObject({ archivedAt: '2026-08-01T01:02:04.000Z' })
	expect(await occupied.readAlarm(occupiedOwner)).not.toBeNull()

	const invalidOwner = `workers-import-invalid-${crypto.randomUUID()}`
	const invalid = await createBackup(invalidOwner, day, {
		duplicateProviderEvent: true,
	})
	await invalid.seedExistingMessage('surviving-message')
	await expect(
		invalid.tick({ ...replace, timeBudgetMs: 60_000 }),
	).rejects.toThrow(/rejected restored delivery event/)
	expect(
		await invalid.mailbox().getMessage({ messageId: 'surviving-message' }),
	).not.toBeNull()

	const corruptOwner = `workers-import-corrupt-${crypto.randomUUID()}`
	const corrupt = await createBackup(corruptOwner, day)
	corrupt.s3.objects.set(
		corrupt.dumpKey,
		new TextEncoder().encode('tampered\n'),
	)
	await expect(corrupt.tick({ drill: true })).rejects.toThrow(
		/byte count mismatch|sha256 mismatch/,
	)
	expect(
		await corrupt
			.mailbox(
				`${mailboxImportDrillOwnerPrefix}${day}:${encodeURIComponent(corruptOwner)}`,
			)
			.countMailbox(),
	).toEqual(emptyCounts)

	const tombstoneOwner = ownerIdFromStored(
		`workers-import-tombstone-${crypto.randomUUID()}`,
	)
	const tombstone = await createBackup(tombstoneOwner, day)
	await tombstone.mailbox().tombstoneMissingMessage({
		ownerId: tombstoneOwner,
		messageId: 'restore-message',
		deletedAt: '2026-08-03T00:00:00.000Z',
	})
	expect(await tombstone.mailbox().countMailbox()).toEqual(emptyCounts)
	await expect(tombstone.tick()).rejects.toThrow(/non-empty/)
})

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	assertBackupDay,
	type MailboxIndex,
	type OwnerIndexEntry,
} from '@kody-internal/shared/backup-staging.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import {
	emailAttachmentBlobKey,
	emailRawMimeKey,
} from '#worker/email/blob-keys.ts'
import { mailboxRpc } from '#worker/email/mailbox-client.ts'
import {
	mailboxUpsertDeliveryEventsMax,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxCountResult,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxRpc,
	type MailboxThreadInput,
	type MailboxThreadRecord,
} from '#worker/email/mailbox-types.ts'
import { MaintenanceFailureError } from '#worker/maintenance-handler.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import {
	loadVerifiedMailboxDumpText,
	loadVerifiedMailboxIndex,
} from '#worker/dr/mailbox-import-media.ts'
import {
	parseMailboxDump,
	type ParsedMailboxDump,
} from '#worker/dr/mailbox-import-snapshot.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'

export const mailboxImportRunTimeBudgetMs = 20_000
export const mailboxImportReplaceConfirmation =
	'PURGE NON-EMPTY TARGET MAILBOXES'
export const mailboxImportDrillOwnerPrefix = '__mailbox-drill__:'
const mailboxImportPreflightOwnerPrefix = '__mailbox-import-preflight__:'

const mailboxImportCursorVersion = 1 as const

type MailboxImportPhase =
	| 'prepare'
	| 'preflight-threads'
	| 'preflight-messages'
	| 'preflight-delivery-events'
	| 'preflight-verify'
	| 'threads'
	| 'messages'
	| 'delivery-events'
	| 'verify'
	| 'done'

export type MailboxImportOwnerSelection = 'all-from-index' | Array<string>
export type MailboxImportConflictPolicy = 'refuse' | 'replace'

type MailboxImportCursor = {
	version: typeof mailboxImportCursorVersion
	day: string
	requestFingerprint: string
	ownerIndex: number
	phase: MailboxImportPhase
	rowIndex: number
	ownersPassed: number
	ownersMismatched: number
	ownersReplaced: number
}

export type MailboxImportOwnerResult = {
	sourceOwnerId: string
	targetOwnerId: string
	expected: MailboxCountResult
	actual: MailboxCountResult
	matches: boolean
	drill: boolean
}

export type MailboxImportTickResult = {
	done: boolean
	verified: boolean
	nextCursor?: string
	progress: {
		day: string
		phase: MailboxImportPhase
		ownerIndex: number
		totalOwners: number
		ownersPassed: number
		ownersMismatched: number
		ownersReplaced: number
		rowsProcessed: number
	}
	ownerResults: Array<MailboxImportOwnerResult>
	warnings: Array<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function failure(
	message: string,
	progress: MailboxImportTickResult['progress'] | null = null,
): MaintenanceFailureError {
	return new MaintenanceFailureError(message, { progress, warnings: [] })
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw failure(`invalid cursor field ${field}`)
	}
	return value
}

async function loadVerifiedMailboxDump(
	s3: DrBackupS3Client,
	day: string,
	entry: OwnerIndexEntry,
): Promise<ParsedMailboxDump> {
	const text = await loadVerifiedMailboxDumpText({ s3, day, entry })
	return parseMailboxDump(text, entry.entryCount)
}

function selectOwners(
	index: MailboxIndex,
	selection: MailboxImportOwnerSelection,
): Array<OwnerIndexEntry> {
	if (selection === 'all-from-index') return index.entries
	const byOwner = new Map(index.entries.map((entry) => [entry.ownerId, entry]))
	return selection.map((ownerId) => {
		const entry = byOwner.get(ownerId)
		if (!entry) {
			throw failure(
				`requested owner ${ownerId} is absent from the mailbox index`,
			)
		}
		return entry
	})
}

function targetOwnerId(
	sourceOwnerId: OwnerId,
	day: string,
	drill: boolean,
): OwnerId {
	// Drill names are a prefix plus the source id. Non-drill restores use the
	// source id bytes. Neither path trims.
	const name = drill
		? `${mailboxImportDrillOwnerPrefix}${day}:${encodeURIComponent(sourceOwnerId)}`
		: sourceOwnerId
	return name as OwnerId
}

function preflightOwnerId(sourceOwnerId: string, day: string): OwnerId {
	return `${mailboxImportPreflightOwnerPrefix}${day}:${encodeURIComponent(sourceOwnerId)}` as OwnerId
}

function mailboxThreadInput(thread: MailboxThreadRecord): MailboxThreadInput {
	return {
		...thread,
		subjectNormalized: thread.subjectNormalized ?? '',
	}
}

function mailboxMessageInput(
	message: MailboxMessageRecord,
	drillTarget: OwnerId | null,
): MailboxMessageInput {
	return {
		...message,
		fromAddress: message.fromAddress ?? '',
		subject: message.subject ?? '',
		headers: message.headers ?? {},
		rawSize: message.rawSize ?? 0,
		rawMimeKey:
			drillTarget !== null && message.rawMimeKey !== null
				? emailRawMimeKey(drillTarget, message.id)
				: message.rawMimeKey,
	}
}

function mailboxAttachmentInput(
	attachment: MailboxAttachmentRecord,
	drillTarget: OwnerId | null,
): MailboxAttachmentInput {
	return {
		...attachment,
		contentType: attachment.contentType ?? 'application/octet-stream',
		storageKey:
			drillTarget !== null && attachment.storageKind === 'external'
				? emailAttachmentBlobKey(
						drillTarget,
						attachment.messageId,
						attachment.id,
					)
				: attachment.storageKey,
	}
}

function mailboxDeliveryEventInput(
	event: MailboxDeliveryEventRecord,
): MailboxDeliveryEventInput {
	return {
		...event,
		provider: event.provider ?? 'kody',
	}
}

async function restoreThread(input: {
	mailbox: MailboxRpc
	ownerId: OwnerId
	thread: MailboxThreadRecord
	progress: MailboxImportTickResult['progress']
}): Promise<void> {
	const result = await input.mailbox.upsertMessageGraph({
		ownerId: input.ownerId,
		thread: mailboxThreadInput(input.thread),
		message: null,
		restore: true,
	})
	if (!result.accepted) {
		throw failure(
			`Mailbox rejected restored thread ${input.thread.id}`,
			input.progress,
		)
	}
}

async function restoreMessage(input: {
	mailbox: MailboxRpc
	ownerId: OwnerId
	message: MailboxMessageRecord
	attachments: Array<MailboxAttachmentRecord>
	blobOwnerId: OwnerId | null
	progress: MailboxImportTickResult['progress']
}): Promise<number> {
	const message = mailboxMessageInput(input.message, input.blobOwnerId)
	const attachments = input.attachments.map((attachment) =>
		mailboxAttachmentInput(attachment, input.blobOwnerId),
	)
	const result = await input.mailbox.upsertMessageGraph({
		ownerId: input.ownerId,
		message,
		attachments,
		restore: true,
	})
	if (!result.accepted) {
		throw failure(
			`Mailbox rejected restored message ${message.id}`,
			input.progress,
		)
	}
	return 1 + attachments.length
}

async function restoreDeliveryEvents(input: {
	mailbox: MailboxRpc
	ownerId: OwnerId
	events: Array<MailboxDeliveryEventRecord>
	progress: MailboxImportTickResult['progress']
}): Promise<number> {
	const events = input.events.map(mailboxDeliveryEventInput)
	const result = await input.mailbox.upsertDeliveryEvents({
		ownerId: input.ownerId,
		events,
		restore: true,
	})
	const rejected = result.results.find((item) => !item.accepted)
	if (result.results.length !== events.length || rejected) {
		throw failure(
			`Mailbox rejected restored delivery event ${rejected?.eventId ?? 'unknown'}`,
			input.progress,
		)
	}
	return events.length
}

function mailboxCountsEqual(
	left: MailboxCountResult,
	right: MailboxCountResult,
): boolean {
	return (
		left.threads === right.threads &&
		left.messages === right.messages &&
		left.attachments === right.attachments &&
		left.deliveryEvents === right.deliveryEvents
	)
}

function assertCanonicalDumpBlobKeys(
	dump: ParsedMailboxDump,
	sourceOwnerId: OwnerId,
): void {
	for (const message of dump.messages) {
		const expectedRawMimeKey = emailRawMimeKey(sourceOwnerId, message.id)
		if (
			(message.direction === 'inbound' &&
				message.rawMimeKey !== expectedRawMimeKey) ||
			(message.direction === 'outbound' &&
				message.rawMimeKey !== null &&
				message.rawMimeKey !== expectedRawMimeKey)
		) {
			throw failure(`mailbox dump has a non-canonical raw MIME key`)
		}
		for (const attachment of dump.attachmentsByMessage.get(message.id) ?? []) {
			const expectedAttachmentKey = emailAttachmentBlobKey(
				sourceOwnerId,
				message.id,
				attachment.id,
			)
			if (
				(attachment.storageKind === 'external' &&
					attachment.storageKey !== expectedAttachmentKey) ||
				(attachment.storageKind !== 'external' &&
					attachment.storageKey !== null)
			) {
				throw failure(`mailbox dump has a non-canonical attachment key`)
			}
		}
	}
}

function cursorSecret(env: Env): string {
	const secret = env.DR_RESTORE_SECRET?.trim()
	if (!secret) throw failure('Mailbox import cursor signing is not configured')
	return secret
}

async function cursorSignature(
	payload: string,
	secret: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
	)
	return btoa(String.fromCharCode(...signature))
}

async function encodeCursor(
	cursor: MailboxImportCursor,
	secret: string,
): Promise<string> {
	const payload = btoa(JSON.stringify(cursor))
	return `${payload}.${await cursorSignature(payload, secret)}`
}

async function decodeCursor(
	raw: string | undefined,
	day: string,
	requestFingerprint: string,
	secret: string,
): Promise<MailboxImportCursor> {
	if (!raw) {
		return {
			version: mailboxImportCursorVersion,
			day,
			requestFingerprint,
			ownerIndex: 0,
			phase: 'prepare',
			rowIndex: 0,
			ownersPassed: 0,
			ownersMismatched: 0,
			ownersReplaced: 0,
		}
	}
	try {
		const parts = raw.split('.')
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			throw new Error('cursor signature is missing')
		}
		const [payload, signature] = parts as [string, string]
		const expectedSignature = await cursorSignature(payload, secret)
		if (!(await timingSafeEqualString(signature, expectedSignature))) {
			throw new Error('cursor signature is invalid')
		}
		const value = JSON.parse(atob(payload)) as unknown
		if (
			!isRecord(value) ||
			value.version !== mailboxImportCursorVersion ||
			value.day !== day ||
			value.requestFingerprint !== requestFingerprint ||
			(value.phase !== 'prepare' &&
				value.phase !== 'preflight-threads' &&
				value.phase !== 'preflight-messages' &&
				value.phase !== 'preflight-delivery-events' &&
				value.phase !== 'preflight-verify' &&
				value.phase !== 'threads' &&
				value.phase !== 'messages' &&
				value.phase !== 'delivery-events' &&
				value.phase !== 'verify' &&
				value.phase !== 'done')
		) {
			throw new Error('cursor does not match this import request')
		}
		return {
			version: mailboxImportCursorVersion,
			day,
			requestFingerprint,
			ownerIndex: requireNonNegativeInteger(value.ownerIndex, 'ownerIndex'),
			phase: value.phase,
			rowIndex: requireNonNegativeInteger(value.rowIndex, 'rowIndex'),
			ownersPassed: requireNonNegativeInteger(
				value.ownersPassed,
				'ownersPassed',
			),
			ownersMismatched: requireNonNegativeInteger(
				value.ownersMismatched,
				'ownersMismatched',
			),
			ownersReplaced: requireNonNegativeInteger(
				value.ownersReplaced,
				'ownersReplaced',
			),
		}
	} catch (error) {
		if (error instanceof MaintenanceFailureError) throw error
		throw failure(`Invalid mailbox import cursor: ${getErrorMessage(error)}`)
	}
}

function validateCursorProgress(
	cursor: MailboxImportCursor,
	totalOwners: number,
): void {
	if (cursor.ownersPassed + cursor.ownersMismatched !== cursor.ownerIndex) {
		throw failure('mailbox import cursor owner counters are inconsistent')
	}
	if (
		cursor.ownersReplaced >
		cursor.ownerIndex +
			(cursor.phase === 'prepare' || cursor.phase === 'done' ? 0 : 1)
	) {
		throw failure('mailbox import cursor replacement counter is inconsistent')
	}
	if (cursor.phase === 'done') {
		if (cursor.ownerIndex !== totalOwners || cursor.rowIndex !== 0) {
			throw failure('mailbox import cursor reached done before all owners')
		}
		return
	}
	if (cursor.ownerIndex >= totalOwners && totalOwners > 0) {
		throw failure('mailbox import cursor ownerIndex exceeds selected owners')
	}
	if (
		(cursor.phase === 'prepare' ||
			cursor.phase === 'preflight-verify' ||
			cursor.phase === 'verify') &&
		cursor.rowIndex !== 0
	) {
		throw failure(`${cursor.phase} cursor cannot have a row offset`)
	}
}

function validateCursorRowIndex(
	cursor: MailboxImportCursor,
	dump: ParsedMailboxDump,
): void {
	let maximum = 0
	switch (cursor.phase) {
		case 'prepare':
		case 'preflight-verify':
		case 'verify':
		case 'done':
			maximum = 0
			break
		case 'preflight-threads':
		case 'threads':
			maximum = dump.threads.length
			break
		case 'preflight-messages':
		case 'messages':
			maximum = dump.messages.length
			break
		case 'preflight-delivery-events':
		case 'delivery-events':
			maximum = dump.deliveryEvents.length
			break
		default: {
			const exhaustive: never = cursor.phase
			throw failure(`Unhandled mailbox import phase: ${String(exhaustive)}`)
		}
	}
	if (cursor.rowIndex > maximum) {
		throw failure(`mailbox import cursor rowIndex exceeds ${cursor.phase} rows`)
	}
}

async function requestFingerprint(input: {
	day: string
	mediaIdentity: string
	owners: MailboxImportOwnerSelection
	conflictPolicy: MailboxImportConflictPolicy
	replaceConfirmation: string | null
	drill: boolean
}): Promise<string> {
	return await sha256Hex(JSON.stringify(input))
}

function progressFor(
	cursor: MailboxImportCursor,
	totalOwners: number,
	rowsProcessed: number,
): MailboxImportTickResult['progress'] {
	return {
		day: cursor.day,
		phase: cursor.phase,
		ownerIndex: cursor.ownerIndex,
		totalOwners,
		ownersPassed: cursor.ownersPassed,
		ownersMismatched: cursor.ownersMismatched,
		ownersReplaced: cursor.ownersReplaced,
		rowsProcessed,
	}
}

export async function runMailboxImportTick(input: {
	env: Env
	day: string
	owners: MailboxImportOwnerSelection
	conflictPolicy?: MailboxImportConflictPolicy
	replaceConfirmation?: string
	drill?: boolean
	cursor?: string
	timeBudgetMs?: number
	s3?: DrBackupS3Client
}): Promise<MailboxImportTickResult> {
	assertBackupDay(input.day)
	const conflictPolicy = input.conflictPolicy ?? 'refuse'
	if (conflictPolicy !== 'refuse' && conflictPolicy !== 'replace') {
		throw failure('conflictPolicy must be "refuse" or "replace"')
	}
	const replaceConfirmation = input.replaceConfirmation ?? null
	if (
		conflictPolicy === 'replace' &&
		replaceConfirmation !== mailboxImportReplaceConfirmation
	) {
		throw failure(
			`replace requires replaceConfirmation: "${mailboxImportReplaceConfirmation}"`,
		)
	}
	if (conflictPolicy === 'refuse' && replaceConfirmation !== null) {
		throw failure(
			'replaceConfirmation is only valid with conflictPolicy "replace"',
		)
	}
	const drill = input.drill ?? false
	const signingSecret = cursorSecret(input.env)
	const config = readDrBackupS3Config(input.env)
	if (!input.s3 && !config) {
		throw failure('DR backup credentials are not configured')
	}
	const s3 = input.s3 ?? createDrBackupS3Client(config!)
	const { index, mediaIdentity } = await loadVerifiedMailboxIndex({
		s3,
		env: input.env,
		day: input.day,
	})
	const fingerprint = await requestFingerprint({
		day: input.day,
		mediaIdentity,
		owners: input.owners,
		conflictPolicy,
		replaceConfirmation,
		drill,
	})
	const cursor = await decodeCursor(
		input.cursor,
		input.day,
		fingerprint,
		signingSecret,
	)
	const owners = selectOwners(index, input.owners)
	validateCursorProgress(cursor, owners.length)

	const startedAtMs = Date.now()
	const timeBudgetMs = input.timeBudgetMs ?? mailboxImportRunTimeBudgetMs
	const ownerResults: Array<MailboxImportOwnerResult> = []
	const warnings: Array<string> = []
	let rowsProcessed = 0
	const budgetExhausted = () => Date.now() - startedAtMs >= timeBudgetMs

	while (cursor.ownerIndex < owners.length && cursor.phase !== 'done') {
		const owner = owners[cursor.ownerIndex]!
		const dump = await loadVerifiedMailboxDump(s3, input.day, owner)
		const sourceOwnerId = owner.ownerId as OwnerId
		assertCanonicalDumpBlobKeys(dump, sourceOwnerId)
		validateCursorRowIndex(cursor, dump)
		const target = targetOwnerId(sourceOwnerId, input.day, drill)
		const preflightId = preflightOwnerId(sourceOwnerId, input.day)
		const mailbox = mailboxRpc({ env: input.env, userId: target })
		const preflightMailbox = mailboxRpc({
			env: input.env,
			userId: preflightId,
		})

		if (cursor.phase === 'prepare') {
			const current = await mailbox.inspectRestoreState({ ownerId: target })
			const nonEmpty = !current.empty
			if (nonEmpty && conflictPolicy === 'refuse') {
				throw failure(
					`target Mailbox for ${target} is non-empty; refusing import`,
					progressFor(cursor, owners.length, rowsProcessed),
				)
			}
			if (nonEmpty) {
				const preflightState = await preflightMailbox.inspectRestoreState({
					ownerId: preflightId,
				})
				if (!preflightState.empty) {
					await preflightMailbox.purge({ ownerId: preflightId })
				}
				cursor.phase = 'preflight-threads'
			} else {
				await mailbox.beginRestore({ ownerId: target })
				cursor.phase = 'threads'
			}
			cursor.rowIndex = 0
		}

		while (
			(cursor.phase === 'preflight-threads' || cursor.phase === 'threads') &&
			cursor.rowIndex < dump.threads.length
		) {
			if (budgetExhausted()) break
			await restoreThread({
				mailbox:
					cursor.phase === 'preflight-threads' ? preflightMailbox : mailbox,
				ownerId: cursor.phase === 'preflight-threads' ? preflightId : target,
				thread: dump.threads[cursor.rowIndex]!,
				progress: progressFor(cursor, owners.length, rowsProcessed),
			})
			cursor.rowIndex += 1
			rowsProcessed += 1
		}
		if (
			cursor.phase === 'preflight-threads' &&
			cursor.rowIndex >= dump.threads.length
		) {
			cursor.phase = 'preflight-messages'
			cursor.rowIndex = 0
		}
		if (cursor.phase === 'threads' && cursor.rowIndex >= dump.threads.length) {
			cursor.phase = 'messages'
			cursor.rowIndex = 0
		}

		while (
			(cursor.phase === 'preflight-messages' || cursor.phase === 'messages') &&
			cursor.rowIndex < dump.messages.length
		) {
			if (budgetExhausted()) break
			const sourceMessage = dump.messages[cursor.rowIndex]!
			const sourceAttachments =
				dump.attachmentsByMessage.get(sourceMessage.id) ?? []
			rowsProcessed += await restoreMessage({
				mailbox:
					cursor.phase === 'preflight-messages' ? preflightMailbox : mailbox,
				ownerId: cursor.phase === 'preflight-messages' ? preflightId : target,
				message: sourceMessage,
				attachments: sourceAttachments,
				blobOwnerId:
					cursor.phase === 'preflight-messages'
						? preflightId
						: drill
							? target
							: null,
				progress: progressFor(cursor, owners.length, rowsProcessed),
			})
			cursor.rowIndex += 1
		}
		if (
			cursor.phase === 'preflight-messages' &&
			cursor.rowIndex >= dump.messages.length
		) {
			cursor.phase = 'preflight-delivery-events'
			cursor.rowIndex = 0
		}
		if (
			cursor.phase === 'messages' &&
			cursor.rowIndex >= dump.messages.length
		) {
			cursor.phase = 'delivery-events'
			cursor.rowIndex = 0
		}

		while (
			(cursor.phase === 'preflight-delivery-events' ||
				cursor.phase === 'delivery-events') &&
			cursor.rowIndex < dump.deliveryEvents.length
		) {
			if (budgetExhausted()) break
			const events = dump.deliveryEvents.slice(
				cursor.rowIndex,
				cursor.rowIndex + mailboxUpsertDeliveryEventsMax,
			)
			rowsProcessed += await restoreDeliveryEvents({
				mailbox:
					cursor.phase === 'preflight-delivery-events'
						? preflightMailbox
						: mailbox,
				ownerId:
					cursor.phase === 'preflight-delivery-events' ? preflightId : target,
				events,
				progress: progressFor(cursor, owners.length, rowsProcessed),
			})
			cursor.rowIndex += events.length
		}
		if (
			cursor.phase === 'preflight-delivery-events' &&
			cursor.rowIndex >= dump.deliveryEvents.length
		) {
			cursor.phase = 'preflight-verify'
			cursor.rowIndex = 0
		}
		if (
			cursor.phase === 'delivery-events' &&
			cursor.rowIndex >= dump.deliveryEvents.length
		) {
			cursor.phase = 'verify'
			cursor.rowIndex = 0
		}

		if (cursor.phase === 'preflight-verify' && !budgetExhausted()) {
			const preflightCounts = await preflightMailbox.countMailbox({
				restore: true,
			})
			if (!mailboxCountsEqual(preflightCounts, dump.counts)) {
				throw failure(
					`Mailbox restore preflight count mismatch for ${owner.ownerId}`,
					progressFor(cursor, owners.length, rowsProcessed),
				)
			}
			const current = await mailbox.inspectRestoreState({ ownerId: target })
			if (!current.empty) {
				await mailbox.purge({ ownerId: target })
			}
			await mailbox.beginRestore({ ownerId: target })
			cursor.ownersReplaced += 1
			cursor.phase = 'threads'
			cursor.rowIndex = 0
		}

		if (cursor.phase === 'verify' && !budgetExhausted()) {
			const priorDrillResult = drill
				? await mailbox.readDrillResult({ ownerId: target })
				: null
			const actual =
				priorDrillResult ?? (await mailbox.countMailbox({ restore: true }))
			const matches = mailboxCountsEqual(actual, dump.counts)
			ownerResults.push({
				sourceOwnerId: owner.ownerId,
				targetOwnerId: target,
				expected: dump.counts,
				actual,
				matches,
				drill,
			})
			if (drill && priorDrillResult === null) {
				await mailbox.completeDrill({ ownerId: target, result: actual })
			}
			if (matches) {
				cursor.ownersPassed += 1
				if (!drill) await mailbox.finalizeRestore({ ownerId: target })
			} else {
				cursor.ownersMismatched += 1
				warnings.push(`Mailbox count mismatch for ${owner.ownerId}`)
			}
			if (conflictPolicy === 'replace') {
				const preflightState = await preflightMailbox.inspectRestoreState({
					ownerId: preflightId,
				})
				if (!preflightState.empty) {
					await preflightMailbox.purge({ ownerId: preflightId })
				}
			}
			cursor.ownerIndex += 1
			cursor.phase = cursor.ownerIndex >= owners.length ? 'done' : 'prepare'
			cursor.rowIndex = 0
		}

		if (budgetExhausted()) break
	}

	if (owners.length === 0) cursor.phase = 'done'
	const done = cursor.phase === 'done'
	return {
		done,
		verified: done && cursor.ownersMismatched === 0,
		...(done ? {} : { nextCursor: await encodeCursor(cursor, signingSecret) }),
		progress: progressFor(cursor, owners.length, rowsProcessed),
		ownerResults,
		warnings,
	}
}

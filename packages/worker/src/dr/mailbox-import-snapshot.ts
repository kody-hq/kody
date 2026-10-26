import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxClassification,
	assertMailboxDeliveryEventType,
	assertMailboxDeliveryStatus,
	assertMailboxDirection,
	assertMailboxInboundDeliveryState,
	assertMailboxNonEmptyString,
	assertMailboxProcessingStatus,
	assertMailboxStorageKind,
	assertMailboxSubscriptionEffectState,
	type MailboxAttachmentRecord,
	type MailboxCountResult,
	type MailboxDeliveryEventRecord,
	type MailboxExportRow,
	type MailboxMessageRecord,
	type MailboxThreadRecord,
} from '#worker/email/mailbox-types.ts'
import { MaintenanceFailureError } from '#worker/maintenance-handler.ts'

export type ParsedMailboxDump = {
	threads: Array<MailboxThreadRecord>
	messages: Array<MailboxMessageRecord>
	attachmentsByMessage: Map<string, Array<MailboxAttachmentRecord>>
	deliveryEvents: Array<MailboxDeliveryEventRecord>
	counts: MailboxCountResult
}

function failure(message: string): MaintenanceFailureError {
	return new MaintenanceFailureError(message, {
		progress: null,
		warnings: [],
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(
	value: Record<string, unknown>,
	keys: ReadonlyArray<string>,
	label: string,
): void {
	const expected = new Set(keys)
	if (
		Object.keys(value).length !== expected.size ||
		Object.keys(value).some((key) => !expected.has(key))
	) {
		throw new Error(`${label} contains missing or unknown fields`)
	}
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== 'string') throw new Error(`${label} must be a string`)
	return value
}

function nullableString(value: unknown, label: string): string | null {
	if (value !== null && typeof value !== 'string') {
		throw new Error(`${label} must be a string or null`)
	}
	return value
}

function arrayValue(value: unknown, label: string): Array<unknown> {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
	return value
}

function nullableRecord(
	value: unknown,
	label: string,
): Record<string, unknown> | null {
	if (value !== null && !isRecord(value)) {
		throw new Error(`${label} must be an object or null`)
	}
	return value
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean') {
		throw new Error(`${label} must be a boolean`)
	}
	return value
}

function nullableNumber(value: unknown, label: string): number | null {
	if (
		value !== null &&
		(typeof value !== 'number' || !Number.isFinite(value))
	) {
		throw new Error(`${label} must be a finite number or null`)
	}
	return value
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer`)
	}
	return value
}

function nullableNonNegativeInteger(
	value: unknown,
	label: string,
): number | null {
	if (value === null) return null
	return nonNegativeInteger(value, label)
}

function canonicalTimestamp(value: unknown, label: string): string {
	return assertMailboxCanonicalIsoTimestamp(stringValue(value, label), label)
}

function nullableTimestamp(value: unknown, label: string): string | null {
	if (value === null) return null
	return canonicalTimestamp(value, label)
}

const threadKeys = [
	'id',
	'inboxId',
	'subjectNormalized',
	'rootMessageIdHeader',
	'lastMessageAt',
	'createdAt',
	'updatedAt',
] as const

function parseThread(row: Record<string, unknown>): MailboxThreadRecord {
	assertExactKeys(row, threadKeys, 'thread')
	return {
		id: assertMailboxNonEmptyString(row['id'], 'thread.id'),
		inboxId: nullableString(row['inboxId'], 'thread.inboxId'),
		subjectNormalized: nullableString(
			row['subjectNormalized'],
			'thread.subjectNormalized',
		),
		rootMessageIdHeader: nullableString(
			row['rootMessageIdHeader'],
			'thread.rootMessageIdHeader',
		),
		lastMessageAt: canonicalTimestamp(
			row['lastMessageAt'],
			'thread.lastMessageAt',
		),
		createdAt: canonicalTimestamp(row['createdAt'], 'thread.createdAt'),
		updatedAt: canonicalTimestamp(row['updatedAt'], 'thread.updatedAt'),
	}
}

const messageKeys = [
	'id',
	'direction',
	'inboxId',
	'threadId',
	'senderIdentityId',
	'fromAddress',
	'envelopeFrom',
	'toAddresses',
	'ccAddresses',
	'bccAddresses',
	'replyToAddresses',
	'subject',
	'messageIdHeader',
	'inReplyToHeader',
	'references',
	'headers',
	'authResults',
	'textBody',
	'htmlBody',
	'rawMimeKey',
	'rawSize',
	'processingStatus',
	'classification',
	'classificationReason',
	'providerMessageId',
	'deliveryStatus',
	'deliveryStatusAt',
	'error',
	'receivedAt',
	'sentAt',
	'createdAt',
	'updatedAt',
] as const

/** Snapshots exported before Mailbox schema v6 have no `archivedAt`. */
const messageKeysWithArchivedAt = [...messageKeys, 'archivedAt'] as const

function parseMessage(row: Record<string, unknown>): MailboxMessageRecord {
	assertExactKeys(
		row,
		'archivedAt' in row ? messageKeysWithArchivedAt : messageKeys,
		'message',
	)
	const direction = stringValue(row['direction'], 'message.direction')
	const processingStatus = stringValue(
		row['processingStatus'],
		'message.processingStatus',
	)
	const classification = stringValue(
		row['classification'],
		'message.classification',
	)
	const deliveryStatus = nullableString(
		row['deliveryStatus'],
		'message.deliveryStatus',
	)
	const rawSize =
		row['rawSize'] === null
			? null
			: nonNegativeInteger(row['rawSize'], 'message.rawSize')
	return {
		id: assertMailboxNonEmptyString(row['id'], 'message.id'),
		direction: assertMailboxDirection(direction),
		inboxId: nullableString(row['inboxId'], 'message.inboxId'),
		threadId: nullableString(row['threadId'], 'message.threadId'),
		senderIdentityId: nullableString(
			row['senderIdentityId'],
			'message.senderIdentityId',
		),
		fromAddress: nullableString(row['fromAddress'], 'message.fromAddress'),
		envelopeFrom: nullableString(row['envelopeFrom'], 'message.envelopeFrom'),
		toAddresses: arrayValue(row['toAddresses'], 'message.toAddresses'),
		ccAddresses: arrayValue(row['ccAddresses'], 'message.ccAddresses'),
		bccAddresses: arrayValue(row['bccAddresses'], 'message.bccAddresses'),
		replyToAddresses: arrayValue(
			row['replyToAddresses'],
			'message.replyToAddresses',
		),
		subject: nullableString(row['subject'], 'message.subject'),
		messageIdHeader: nullableString(
			row['messageIdHeader'],
			'message.messageIdHeader',
		),
		inReplyToHeader: nullableString(
			row['inReplyToHeader'],
			'message.inReplyToHeader',
		),
		references: arrayValue(row['references'], 'message.references'),
		headers: nullableRecord(row['headers'], 'message.headers'),
		authResults: nullableString(row['authResults'], 'message.authResults'),
		textBody: nullableString(row['textBody'], 'message.textBody'),
		htmlBody: nullableString(row['htmlBody'], 'message.htmlBody'),
		rawMimeKey: nullableString(row['rawMimeKey'], 'message.rawMimeKey'),
		rawSize,
		processingStatus: assertMailboxProcessingStatus(processingStatus),
		classification: assertMailboxClassification(classification),
		classificationReason: nullableString(
			row['classificationReason'],
			'message.classificationReason',
		),
		archivedAt:
			row['archivedAt'] === undefined
				? null
				: nullableTimestamp(row['archivedAt'], 'message.archivedAt'),
		providerMessageId: nullableString(
			row['providerMessageId'],
			'message.providerMessageId',
		),
		deliveryStatus:
			deliveryStatus === null
				? null
				: assertMailboxDeliveryStatus(deliveryStatus),
		deliveryStatusAt: nullableTimestamp(
			row['deliveryStatusAt'],
			'message.deliveryStatusAt',
		),
		error: nullableString(row['error'], 'message.error'),
		receivedAt: nullableTimestamp(row['receivedAt'], 'message.receivedAt'),
		sentAt: nullableTimestamp(row['sentAt'], 'message.sentAt'),
		createdAt: canonicalTimestamp(row['createdAt'], 'message.createdAt'),
		updatedAt: canonicalTimestamp(row['updatedAt'], 'message.updatedAt'),
	}
}

const attachmentKeys = [
	'id',
	'messageId',
	'filename',
	'contentType',
	'contentId',
	'disposition',
	'size',
	'storageKind',
	'storageKey',
	'createdAt',
] as const

function parseAttachment(
	row: Record<string, unknown>,
): MailboxAttachmentRecord {
	assertExactKeys(row, attachmentKeys, 'attachment')
	const storageKind = stringValue(row['storageKind'], 'attachment.storageKind')
	return {
		id: assertMailboxNonEmptyString(row['id'], 'attachment.id'),
		messageId: assertMailboxNonEmptyString(
			row['messageId'],
			'attachment.messageId',
		),
		filename: nullableString(row['filename'], 'attachment.filename'),
		contentType: nullableString(row['contentType'], 'attachment.contentType'),
		contentId: nullableString(row['contentId'], 'attachment.contentId'),
		disposition: nullableString(row['disposition'], 'attachment.disposition'),
		size: nonNegativeInteger(row['size'], 'attachment.size'),
		storageKind: assertMailboxStorageKind(storageKind),
		storageKey: nullableString(row['storageKey'], 'attachment.storageKey'),
		createdAt: canonicalTimestamp(row['createdAt'], 'attachment.createdAt'),
	}
}

const deliveryEventKeys = [
	'id',
	'messageId',
	'inboxId',
	'eventType',
	'provider',
	'providerMessageId',
	'providerEventId',
	'detailJson',
	'needsEffectReconcile',
	'state',
	'fingerprint',
	'storageLease',
	'storageLeaseAt',
	'cleanupLease',
	'cleanupLeaseAt',
	'cleanupRetryAt',
	'expectedAttachmentCount',
	'finalizationToken',
	'reconcileAfter',
	'dedupeExpiresAt',
	'usageEffectRecordedAt',
	'usageEffectSuppressedAt',
	'usageStartedAt',
	'usageMonth',
	'usageBytes',
	'usageDurationMs',
	'usageEffectRetryAt',
	'usageEffectLease',
	'usageEffectLeaseAt',
	'subscriptionEffectState',
	'subscriptionEffectLease',
	'subscriptionEffectLeaseAt',
	'subscriptionEffectRetryAt',
	'subscriptionEffectAttemptCount',
	'subscriptionEffectDeadLetterAt',
	'subscriptionEffectLastError',
	'createdAt',
	'updatedAt',
] as const

function parseDeliveryEvent(
	row: Record<string, unknown>,
): MailboxDeliveryEventRecord {
	assertExactKeys(row, deliveryEventKeys, 'delivery event')
	const eventType = stringValue(row['eventType'], 'event.eventType')
	const state = nullableString(row['state'], 'event.state')
	const subscriptionEffectState = nullableString(
		row['subscriptionEffectState'],
		'event.subscriptionEffectState',
	)
	return {
		id: assertMailboxNonEmptyString(row['id'], 'event.id'),
		messageId: nullableString(row['messageId'], 'event.messageId'),
		inboxId: nullableString(row['inboxId'], 'event.inboxId'),
		eventType: assertMailboxDeliveryEventType(eventType),
		provider: nullableString(row['provider'], 'event.provider'),
		providerMessageId: nullableString(
			row['providerMessageId'],
			'event.providerMessageId',
		),
		providerEventId: nullableString(
			row['providerEventId'],
			'event.providerEventId',
		),
		detailJson: stringValue(row['detailJson'], 'event.detailJson'),
		needsEffectReconcile: booleanValue(
			row['needsEffectReconcile'],
			'event.needsEffectReconcile',
		),
		state: state === null ? null : assertMailboxInboundDeliveryState(state),
		fingerprint: nullableString(row['fingerprint'], 'event.fingerprint'),
		storageLease: nullableString(row['storageLease'], 'event.storageLease'),
		storageLeaseAt: nullableTimestamp(
			row['storageLeaseAt'],
			'event.storageLeaseAt',
		),
		cleanupLease: nullableString(row['cleanupLease'], 'event.cleanupLease'),
		cleanupLeaseAt: nullableTimestamp(
			row['cleanupLeaseAt'],
			'event.cleanupLeaseAt',
		),
		cleanupRetryAt: nullableTimestamp(
			row['cleanupRetryAt'],
			'event.cleanupRetryAt',
		),
		expectedAttachmentCount: nullableNonNegativeInteger(
			row['expectedAttachmentCount'],
			'event.expectedAttachmentCount',
		),
		finalizationToken: nullableString(
			row['finalizationToken'],
			'event.finalizationToken',
		),
		reconcileAfter: nullableTimestamp(
			row['reconcileAfter'],
			'event.reconcileAfter',
		),
		dedupeExpiresAt: nullableTimestamp(
			row['dedupeExpiresAt'],
			'event.dedupeExpiresAt',
		),
		usageEffectRecordedAt: nullableTimestamp(
			row['usageEffectRecordedAt'],
			'event.usageEffectRecordedAt',
		),
		usageEffectSuppressedAt: nullableTimestamp(
			row['usageEffectSuppressedAt'],
			'event.usageEffectSuppressedAt',
		),
		usageStartedAt: nullableTimestamp(
			row['usageStartedAt'],
			'event.usageStartedAt',
		),
		usageMonth: nullableString(row['usageMonth'], 'event.usageMonth'),
		usageBytes: nullableNumber(row['usageBytes'], 'event.usageBytes'),
		usageDurationMs: nullableNumber(
			row['usageDurationMs'],
			'event.usageDurationMs',
		),
		usageEffectRetryAt: nullableTimestamp(
			row['usageEffectRetryAt'],
			'event.usageEffectRetryAt',
		),
		usageEffectLease: nullableString(
			row['usageEffectLease'],
			'event.usageEffectLease',
		),
		usageEffectLeaseAt: nullableTimestamp(
			row['usageEffectLeaseAt'],
			'event.usageEffectLeaseAt',
		),
		subscriptionEffectState:
			subscriptionEffectState === null
				? null
				: assertMailboxSubscriptionEffectState(subscriptionEffectState),
		subscriptionEffectLease: nullableString(
			row['subscriptionEffectLease'],
			'event.subscriptionEffectLease',
		),
		subscriptionEffectLeaseAt: nullableTimestamp(
			row['subscriptionEffectLeaseAt'],
			'event.subscriptionEffectLeaseAt',
		),
		subscriptionEffectRetryAt: nullableTimestamp(
			row['subscriptionEffectRetryAt'],
			'event.subscriptionEffectRetryAt',
		),
		subscriptionEffectAttemptCount: nullableNonNegativeInteger(
			row['subscriptionEffectAttemptCount'],
			'event.subscriptionEffectAttemptCount',
		),
		subscriptionEffectDeadLetterAt: nullableTimestamp(
			row['subscriptionEffectDeadLetterAt'],
			'event.subscriptionEffectDeadLetterAt',
		),
		subscriptionEffectLastError: nullableString(
			row['subscriptionEffectLastError'],
			'event.subscriptionEffectLastError',
		),
		createdAt: canonicalTimestamp(row['createdAt'], 'event.createdAt'),
		updatedAt: canonicalTimestamp(row['updatedAt'], 'event.updatedAt'),
	}
}

function parseDumpRow(value: unknown): MailboxExportRow {
	if (!isRecord(value) || !isRecord(value['row'])) {
		throw new Error('mailbox dump contains an invalid row')
	}
	assertExactKeys(value, ['kind', 'row'], 'mailbox dump row')
	switch (value['kind']) {
		case 'thread':
			return { kind: 'thread', row: parseThread(value['row']) }
		case 'message':
			return { kind: 'message', row: parseMessage(value['row']) }
		case 'attachment':
			return { kind: 'attachment', row: parseAttachment(value['row']) }
		case 'delivery_event':
			return {
				kind: 'delivery_event',
				row: parseDeliveryEvent(value['row']),
			}
		default:
			throw new Error('mailbox dump contains an unknown row kind')
	}
}

export function parseMailboxDump(
	text: string,
	entryCount: number,
): ParsedMailboxDump {
	const lines = text.length === 0 ? [] : text.split('\n')
	if (lines.at(-1) === '') lines.pop()
	const rows = lines.map((line) => {
		try {
			return parseDumpRow(JSON.parse(line) as unknown)
		} catch (error) {
			throw failure(
				`mailbox dump contains invalid row: ${getErrorMessage(error)}`,
			)
		}
	})
	if (rows.length !== entryCount) {
		throw failure(
			`mailbox dump entry count mismatch: expected ${entryCount}, got ${rows.length}`,
		)
	}
	const threads: Array<MailboxThreadRecord> = []
	const messages: Array<MailboxMessageRecord> = []
	const attachments: Array<MailboxAttachmentRecord> = []
	const deliveryEvents: Array<MailboxDeliveryEventRecord> = []
	const idsByKind = {
		thread: new Set<string>(),
		message: new Set<string>(),
		attachment: new Set<string>(),
		delivery_event: new Set<string>(),
	}
	for (const row of rows) {
		if (idsByKind[row.kind].has(row.row.id)) {
			throw failure(`mailbox dump contains a duplicate ${row.kind} id`)
		}
		idsByKind[row.kind].add(row.row.id)
		switch (row.kind) {
			case 'thread':
				threads.push(row.row)
				break
			case 'message':
				messages.push(row.row)
				break
			case 'attachment':
				attachments.push(row.row)
				break
			case 'delivery_event':
				deliveryEvents.push(row.row)
				break
			default: {
				const exhaustive: never = row
				throw failure(`unhandled mailbox dump row: ${String(exhaustive)}`)
			}
		}
	}
	const threadIds = new Set(threads.map((thread) => thread.id))
	const messageIds = new Set(messages.map((message) => message.id))
	for (const message of messages) {
		if (message.threadId !== null && !threadIds.has(message.threadId)) {
			throw failure(`mailbox message ${message.id} references a missing thread`)
		}
	}
	const attachmentsByMessage = new Map<string, Array<MailboxAttachmentRecord>>()
	for (const attachment of attachments) {
		if (!messageIds.has(attachment.messageId)) {
			throw failure(
				`mailbox attachment ${attachment.id} references a missing message`,
			)
		}
		const grouped = attachmentsByMessage.get(attachment.messageId) ?? []
		grouped.push(attachment)
		attachmentsByMessage.set(attachment.messageId, grouped)
	}
	for (const event of deliveryEvents) {
		if (event.messageId !== null && !messageIds.has(event.messageId)) {
			throw failure(
				`mailbox delivery event ${event.id} references a missing message`,
			)
		}
	}
	return {
		threads,
		messages,
		attachmentsByMessage,
		deliveryEvents,
		counts: {
			threads: threads.length,
			messages: messages.length,
			attachments: attachments.length,
			deliveryEvents: deliveryEvents.length,
		},
	}
}

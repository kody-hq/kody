import {
	emailClassificationValues,
	emailDeliveryEventTypeValues,
	emailDeliveryStatusValues,
	emailDirectionValues,
	emailProcessingStatusValues,
	isEmailMessageView,
	type EmailClassification,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailMessageView,
	type EmailProcessingStatus,
} from './types.ts'

export const mailboxDefaultPageSize = 100
export const mailboxMaxPageSize = 500

export const mailboxExportThreadCursorPrefix = 'thread:'
export const mailboxExportMessageCursorPrefix = 'message:'
export const mailboxExportAttachmentCursorPrefix = 'attachment:'
export const mailboxExportDeliveryEventCursorPrefix = 'delivery_event:'

export const mailboxBlobRefRawMimeCursorPrefix = 'raw_mime:'
export const mailboxBlobRefAttachmentCursorPrefix = 'attachment:'

export const mailboxStorageKindValues = [
	'raw-mime',
	'external',
	'unavailable',
] as const
export type MailboxStorageKind = (typeof mailboxStorageKindValues)[number]

export const mailboxInboundDeliveryStateValues = [
	'pending',
	'storing',
	'cleaning',
	'received',
	'rejected',
	'orphan-cleaned',
] as const
export type MailboxInboundDeliveryState =
	(typeof mailboxInboundDeliveryStateValues)[number]

export const mailboxSubscriptionEffectStateValues = [
	'pending',
	'processing',
	'complete',
	'dead-letter',
] as const
export type MailboxSubscriptionEffectState =
	(typeof mailboxSubscriptionEffectStateValues)[number]

/** Canonical UTC ISO-8601 with milliseconds — lexical order matches time order. */
export const mailboxCanonicalIsoTimestampPattern =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type MailboxListCursorPayload = {
	createdAt: string
	id: string
}

export type MailboxExportPhase =
	| 'thread'
	| 'message'
	| 'attachment'
	| 'delivery_event'

export function mailboxNowIso() {
	return new Date().toISOString()
}

export function normalizeMailboxPageSize(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: mailboxDefaultPageSize
	return Math.min(Math.max(requested, 1), mailboxMaxPageSize)
}

/** Non-negative offset; invalid/omitted values become 0. */
export function normalizeMailboxOffset(offset: number | null | undefined) {
	if (typeof offset !== 'number' || !Number.isFinite(offset)) return 0
	return Math.max(0, Math.trunc(offset))
}

export function assertMailboxNonEmptyString<T extends string>(
	value: T,
	label: string,
): T
export function assertMailboxNonEmptyString(
	value: unknown,
	label: string,
): string
export function assertMailboxNonEmptyString(
	value: unknown,
	label: string,
): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Mailbox ${label} must be a non-empty string.`)
	}
	return value
}

export function assertMailboxCanonicalIsoTimestamp(
	value: string,
	label: string,
): string {
	if (!mailboxCanonicalIsoTimestampPattern.test(value)) {
		throw new Error(
			`Mailbox ${label} must be a canonical ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).`,
		)
	}
	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`Mailbox ${label} is not a valid timestamp.`)
	}
	return value
}

export function assertOptionalMailboxCanonicalIsoTimestamp(
	value: string | null | undefined,
	label: string,
): string | null {
	if (value == null) return null
	return assertMailboxCanonicalIsoTimestamp(value, label)
}

export function assertMailboxDirection(value: string): EmailDirection {
	if (!(emailDirectionValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox direction must be inbound or outbound; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailDirection
}

export function assertMailboxProcessingStatus(
	value: string,
): EmailProcessingStatus {
	if (!(emailProcessingStatusValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox processingStatus is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailProcessingStatus
}

export function assertMailboxClassification(
	value: string,
): EmailClassification {
	if (!(emailClassificationValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox classification is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailClassification
}

export function assertMailboxView(value: string): EmailMessageView {
	if (!isEmailMessageView(value)) {
		throw new Error(
			`Mailbox message view is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value
}

export function assertMailboxDeliveryStatus(
	value: string,
): EmailDeliveryStatus {
	if (!(emailDeliveryStatusValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox deliveryStatus is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailDeliveryStatus
}

export function assertMailboxDeliveryEventType(
	value: string,
): EmailDeliveryEventType {
	if (
		!(emailDeliveryEventTypeValues as ReadonlyArray<string>).includes(value)
	) {
		throw new Error(
			`Mailbox eventType is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as EmailDeliveryEventType
}

export function assertMailboxStorageKind(value: string): MailboxStorageKind {
	if (!(mailboxStorageKindValues as ReadonlyArray<string>).includes(value)) {
		throw new Error(
			`Mailbox storageKind is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as MailboxStorageKind
}

export function assertMailboxInboundDeliveryState(
	value: string,
): MailboxInboundDeliveryState {
	if (
		!(mailboxInboundDeliveryStateValues as ReadonlyArray<string>).includes(
			value,
		)
	) {
		throw new Error(
			`Mailbox delivery event state is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as MailboxInboundDeliveryState
}

export function assertMailboxSubscriptionEffectState(
	value: string,
): MailboxSubscriptionEffectState {
	if (
		!(mailboxSubscriptionEffectStateValues as ReadonlyArray<string>).includes(
			value,
		)
	) {
		throw new Error(
			`Mailbox subscriptionEffectState is invalid; got ${JSON.stringify(value)}.`,
		)
	}
	return value as MailboxSubscriptionEffectState
}

export function encodeMailboxListCursor(payload: MailboxListCursorPayload) {
	return btoa(JSON.stringify(payload))
}

export function decodeMailboxListCursor(
	cursor: string,
): MailboxListCursorPayload {
	let parsed: unknown
	try {
		parsed = JSON.parse(atob(cursor)) as unknown
	} catch {
		throw new Error('Mailbox list cursor is invalid.')
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Mailbox list cursor is invalid.')
	}
	const record = parsed as Record<string, unknown>
	const createdAt = record['createdAt']
	const id = record['id']
	if (typeof createdAt !== 'string' || typeof id !== 'string') {
		throw new Error('Mailbox list cursor is invalid.')
	}
	assertMailboxCanonicalIsoTimestamp(createdAt, 'list cursor createdAt')
	assertMailboxNonEmptyString(id, 'list cursor id')
	return { createdAt, id }
}

export function parseMailboxExportCursor(cursor: string | null): {
	phase: MailboxExportPhase
	startAfterId: string
} {
	if (cursor == null || cursor.length === 0) {
		return { phase: 'thread', startAfterId: '' }
	}
	if (cursor.startsWith(mailboxExportThreadCursorPrefix)) {
		return {
			phase: 'thread',
			startAfterId: cursor.slice(mailboxExportThreadCursorPrefix.length),
		}
	}
	if (cursor.startsWith(mailboxExportMessageCursorPrefix)) {
		return {
			phase: 'message',
			startAfterId: cursor.slice(mailboxExportMessageCursorPrefix.length),
		}
	}
	if (cursor.startsWith(mailboxExportAttachmentCursorPrefix)) {
		return {
			phase: 'attachment',
			startAfterId: cursor.slice(mailboxExportAttachmentCursorPrefix.length),
		}
	}
	if (cursor.startsWith(mailboxExportDeliveryEventCursorPrefix)) {
		return {
			phase: 'delivery_event',
			startAfterId: cursor.slice(mailboxExportDeliveryEventCursorPrefix.length),
		}
	}
	throw new Error(
		`Mailbox export cursor is invalid; got ${JSON.stringify(cursor)}.`,
	)
}

export function mailboxExportCursorPrefixForPhase(
	phase: MailboxExportPhase,
): string {
	switch (phase) {
		case 'thread':
			return mailboxExportThreadCursorPrefix
		case 'message':
			return mailboxExportMessageCursorPrefix
		case 'attachment':
			return mailboxExportAttachmentCursorPrefix
		case 'delivery_event':
			return mailboxExportDeliveryEventCursorPrefix
		default: {
			const exhaustive: never = phase
			throw new Error(`Unhandled export phase: ${String(exhaustive)}`)
		}
	}
}

export function parseMailboxBlobRefCursor(cursor: string | null): {
	phase: 'raw_mime' | 'attachment'
	startAfterId: string
} {
	if (cursor == null || cursor.length === 0) {
		return { phase: 'raw_mime', startAfterId: '' }
	}
	if (cursor.startsWith(mailboxBlobRefAttachmentCursorPrefix)) {
		return {
			phase: 'attachment',
			startAfterId: cursor.slice(mailboxBlobRefAttachmentCursorPrefix.length),
		}
	}
	if (cursor.startsWith(mailboxBlobRefRawMimeCursorPrefix)) {
		return {
			phase: 'raw_mime',
			startAfterId: cursor.slice(mailboxBlobRefRawMimeCursorPrefix.length),
		}
	}
	throw new Error(
		`Mailbox blob-reference cursor is invalid; got ${JSON.stringify(cursor)}.`,
	)
}

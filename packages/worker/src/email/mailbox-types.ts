import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type EmailClassification,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailMessageView,
	type EmailProcessingStatus,
} from './types.ts'
import { type DurableObjectPitrRpc } from '#worker/dr/do-pitr.ts'
import { type MailboxInboundDeliveryLedgerRpc } from './mailbox-inbound-ledger.ts'
import { type MailboxInboundEffectLedgerRpc } from './mailbox-inbound-effect-ledger.ts'
import { type MailboxProviderIndexRepairStatus } from './mailbox-provider-index-repair.ts'
import {
	type MailboxInboundDeliveryState,
	type MailboxStorageKind,
	type MailboxSubscriptionEffectState,
} from './mailbox-type-helpers.ts'

export * from './mailbox-type-helpers.ts'

/**
 * Mailbox Durable Object wire types, constants, and boundary validators.
 * Object identity is ownership — records have no `user_id`.
 */

export const mailboxMessageRetentionDays = 365
export const mailboxDeliveryEventRetentionDays = 90
/** Max complete delivery-event snapshots per `upsertDeliveryEvents` RPC. */
export const mailboxUpsertDeliveryEventsMax = 100
/** At most one R2-backed message is processed in each DO event/invocation. */
export const mailboxRetentionMessageCandidatesPerTurn = 1
/** SQLite-only delivery-event/thread retention batch size. */
export const mailboxRetentionMetadataBatchSize = 100
export const mailboxRetentionAlarmSkewMs = 60_000
/** Bound retry delay when overdue retention work cannot finish (e.g. R2 errors). */
export const mailboxRetentionRetryDelayMs = 60 * 60 * 1000
/** Near-immediate continuation when a retention pass succeeds but expired rows remain. */
export const mailboxRetentionContinuationDelayMs = 1_000
export const mailboxBlobDeleteMaxKeys = 1000

/**
 * Bump when initializeSchema's DDL set changes. Warm objects run the
 * version-gated migrations in `initializeMailboxSchema` until they match.
 */
export const mailboxSchemaVersion = 6
export const mailboxMetaSchemaVersionKey = 'schema_version'

export type MailboxThreadRecord = {
	id: string
	inboxId: string | null
	subjectNormalized: string | null
	rootMessageIdHeader: string | null
	lastMessageAt: string
	createdAt: string
	updatedAt: string
}

export type MailboxMessageRecord = {
	id: string
	direction: EmailDirection
	inboxId: string | null
	threadId: string | null
	senderIdentityId: string | null
	fromAddress: string | null
	envelopeFrom: string | null
	toAddresses: Array<unknown>
	ccAddresses: Array<unknown>
	bccAddresses: Array<unknown>
	replyToAddresses: Array<unknown>
	subject: string | null
	messageIdHeader: string | null
	inReplyToHeader: string | null
	references: Array<unknown>
	headers: Record<string, unknown> | null
	authResults: string | null
	textBody: string | null
	htmlBody: string | null
	rawMimeKey: string | null
	rawSize: number | null
	processingStatus: EmailProcessingStatus
	classification: EmailClassification
	classificationReason: string | null
	archivedAt: string | null
	providerMessageId: string | null
	deliveryStatus: EmailDeliveryStatus | null
	deliveryStatusAt: string | null
	error: string | null
	receivedAt: string | null
	sentAt: string | null
	createdAt: string
	updatedAt: string
}

export type MailboxAttachmentRecord = {
	id: string
	messageId: string
	filename: string | null
	contentType: string | null
	contentId: string | null
	disposition: string | null
	size: number
	storageKind: MailboxStorageKind
	storageKey: string | null
	createdAt: string
}

/**
 * Delivery-event row including promoted inbound idempotency / effect columns.
 * `detailJson` holds fields that have not been promoted to columns.
 */
export type MailboxDeliveryEventRecord = {
	id: string
	messageId: string | null
	inboxId: string | null
	eventType: EmailDeliveryEventType
	provider: string | null
	providerMessageId: string | null
	providerEventId: string | null
	detailJson: string
	needsEffectReconcile: boolean
	state: MailboxInboundDeliveryState | null
	fingerprint: string | null
	storageLease: string | null
	storageLeaseAt: string | null
	cleanupLease: string | null
	cleanupLeaseAt: string | null
	cleanupRetryAt: string | null
	expectedAttachmentCount: number | null
	finalizationToken: string | null
	reconcileAfter: string | null
	dedupeExpiresAt: string | null
	usageEffectRecordedAt: string | null
	usageEffectSuppressedAt: string | null
	usageStartedAt: string | null
	usageMonth: string | null
	usageBytes: number | null
	usageDurationMs: number | null
	usageEffectRetryAt: string | null
	usageEffectLease: string | null
	usageEffectLeaseAt: string | null
	subscriptionEffectState: MailboxSubscriptionEffectState | null
	subscriptionEffectLease: string | null
	subscriptionEffectLeaseAt: string | null
	subscriptionEffectRetryAt: string | null
	subscriptionEffectAttemptCount: number | null
	subscriptionEffectDeadLetterAt: string | null
	subscriptionEffectLastError: string | null
	createdAt: string
	updatedAt: string
}

/**
 * Full thread snapshot for mirror writes — every persisted field is required.
 * Nullable columns use `T | null` (no omitted/defaulted fields).
 */
export type MailboxThreadInput = {
	id: string
	inboxId: string | null
	subjectNormalized: string
	rootMessageIdHeader: string | null
	lastMessageAt: string
	createdAt: string
	/** Stale-snapshot rejection: equal/newer only. */
	updatedAt: string
}

/**
 * Full message snapshot for mirror writes — every persisted field is required.
 * Nullable columns use `T | null` (no omitted/defaulted fields).
 */
export type MailboxMessageInput = {
	id: string
	direction: EmailDirection
	inboxId: string | null
	threadId: string | null
	senderIdentityId: string | null
	fromAddress: string
	envelopeFrom: string | null
	toAddresses: Array<unknown>
	ccAddresses: Array<unknown>
	bccAddresses: Array<unknown>
	replyToAddresses: Array<unknown>
	subject: string
	messageIdHeader: string | null
	inReplyToHeader: string | null
	references: Array<unknown>
	headers: Record<string, unknown>
	authResults: string | null
	textBody: string | null
	htmlBody: string | null
	rawMimeKey: string | null
	rawSize: number
	processingStatus: EmailProcessingStatus
	classification: EmailClassification
	classificationReason: string | null
	archivedAt: string | null
	providerMessageId: string | null
	deliveryStatus: EmailDeliveryStatus | null
	deliveryStatusAt: string | null
	error: string | null
	receivedAt: string | null
	sentAt: string | null
	createdAt: string
	/** Stale-snapshot rejection: equal/newer only. */
	updatedAt: string
}

/**
 * Full attachment snapshot — every persisted field is required.
 * The RPC `attachments` array itself may still be omitted (preserve) or `[]` (clear).
 */
export type MailboxAttachmentInput = {
	id: string
	messageId: string
	filename: string | null
	contentType: string
	contentId: string | null
	disposition: string | null
	size: number
	storageKind: MailboxStorageKind
	storageKey: string | null
	createdAt: string
}

/**
 * Full delivery-event snapshot — every persisted field is required.
 * `updatedAt` is the monotonic mirror timestamp (equal/newer accepted).
 */
export type MailboxDeliveryEventInput = {
	id: string
	messageId: string | null
	inboxId: string | null
	eventType: EmailDeliveryEventType
	provider: string
	providerMessageId: string | null
	providerEventId: string | null
	detailJson: string
	needsEffectReconcile: boolean
	state: MailboxInboundDeliveryState | null
	fingerprint: string | null
	storageLease: string | null
	storageLeaseAt: string | null
	cleanupLease: string | null
	cleanupLeaseAt: string | null
	cleanupRetryAt: string | null
	expectedAttachmentCount: number | null
	finalizationToken: string | null
	reconcileAfter: string | null
	dedupeExpiresAt: string | null
	usageEffectRecordedAt: string | null
	usageEffectSuppressedAt: string | null
	usageStartedAt: string | null
	usageMonth: string | null
	usageBytes: number | null
	usageDurationMs: number | null
	usageEffectRetryAt: string | null
	usageEffectLease: string | null
	usageEffectLeaseAt: string | null
	subscriptionEffectState: MailboxSubscriptionEffectState | null
	subscriptionEffectLease: string | null
	subscriptionEffectLeaseAt: string | null
	subscriptionEffectRetryAt: string | null
	subscriptionEffectAttemptCount: number | null
	subscriptionEffectDeadLetterAt: string | null
	subscriptionEffectLastError: string | null
	createdAt: string
	updatedAt: string
}

export type MailboxExportRow =
	| { kind: 'thread'; row: MailboxThreadRecord }
	| { kind: 'message'; row: MailboxMessageRecord }
	| { kind: 'attachment'; row: MailboxAttachmentRecord }
	| { kind: 'delivery_event'; row: MailboxDeliveryEventRecord }

export type MailboxExportResult = {
	rows: Array<MailboxExportRow>
	nextStartAfter: string | null
	truncated: boolean
}

export type MailboxBlobReference = {
	kind: 'raw_mime' | 'attachment'
	key: string
	messageId: string
	attachmentId: string | null
}

export type MailboxBlobReferencePage = {
	references: Array<MailboxBlobReference>
	nextStartAfter: string | null
	truncated: boolean
}

/**
 * Owner-bound single-message delete result. Blob references are returned only
 * to trusted internal callers for exact post-delete verification.
 */
export type MailboxDeleteMessageWithBlobsResult =
	| { status: 'missing'; tombstoned: boolean }
	| {
			status: 'deleted'
			providerMessageId: string | null
			attachmentsSeen: number
			externalAttachmentsSeen: number
			blobReferences: Array<MailboxBlobReference>
	  }

export type MailboxCommitInboundMessageGraphResult =
	| { status: 'committed'; message: MailboxMessageRecord }
	| { status: 'already-committed'; message: MailboxMessageRecord }
	| { status: 'lease-lost' }

export type MailboxCommitOutboundTerminalInput = {
	ownerId: OwnerId
	messageId: string
	processingStatus: 'sent' | 'failed'
	providerMessageId: string | null
	error: string | null
	sentAt: string | null
	event: MailboxDeliveryEventInput
	providerIndexRepair?: {
		provider: string
		providerMessageId: string
		messageId: string
		inboxId: string | null
		createdAt: string
	}
}

export type MailboxTombstoneMissingMessageResult =
	| { status: 'message-present' }
	| { status: 'tombstoned'; created: boolean }

export type MailboxCountResult = {
	threads: number
	messages: number
	attachments: number
	deliveryEvents: number
}

export type MailboxRestoreStatus = {
	counts: MailboxCountResult
	hiddenRows: number
	restorePending: boolean
	empty: boolean
}

/**
 * Aggregate result from {@link MailboxRpc.runRetentionNow} (and the shared
 * private retention turn used by `alarm`). Each invocation processes at most
 * one R2-backed message; counts only — no row ids or content.
 */
export type MailboxRunRetentionNowResult = {
	before: MailboxCountResult
	after: MailboxCountResult
	blobDeleteFailures: boolean
	expiredRemaining: boolean
}

export type MailboxListMessagesInput = {
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
	/** List view; omitted means every message (internal callers). */
	view?: EmailMessageView | null
	limit?: number
	/** Keyset cursor; when set, `offset` is ignored. */
	cursor?: string | null
	/** Offset page (account inbox). Ignored when `cursor` is set. */
	offset?: number | null
}

export type MailboxSearchMessagesInput = {
	query: string
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
	/** List view; omitted means every message (internal callers). */
	view?: EmailMessageView | null
	limit?: number
	offset?: number | null
}

export type MailboxCountMessagesInput = {
	inboxId?: string | null
	direction?: EmailDirection | null
	processingStatus?: EmailProcessingStatus | null
	deliveryStatus?: EmailDeliveryStatus | null
	classification?: EmailClassification | null
	/** List view; omitted means every message (internal callers). */
	view?: EmailMessageView | null
	/** When set, applies the same subject/from/envelope substring match as search. */
	query?: string | null
}

/** Partial thread touch — equal/newer `updatedAt` only; never regresses `lastMessageAt`. */
export type MailboxTouchThreadInput = {
	ownerId: OwnerId
	threadId: string
	lastMessageAt: string
	updatedAt: string
}

/** Partial delivery/processing update — equal/newer `updatedAt` only. */
export type MailboxUpdateMessageDeliveryInput = {
	ownerId: OwnerId
	messageId: string
	processingStatus: EmailProcessingStatus
	providerMessageId: string | null
	error: string | null
	sentAt: string | null
	updatedAt: string
}

/**
 * Partial triage update, applied only for an equal or newer `updatedAt`. At least one of
 * `classification` / `archivedAt` must be present; omitted fields are kept.
 * `classificationReason` is written only alongside `classification`.
 */
export type MailboxSetMessageClassificationInput = {
	ownerId: OwnerId
	messageId: string
	classification?: EmailClassification
	classificationReason?: string | null
	/** ISO timestamp archives, `null` unarchives, omitted leaves it. */
	archivedAt?: string | null
	updatedAt: string
}

/**
 * Metadata-only message delete. Never touches R2. Nulls matching delivery
 * event `message_id` first; does not delete empty threads (use
 * `deleteThreadIfEmpty`). Stale when `updated_at` is newer than `deletedAt`.
 */
export type MailboxDeleteMessageMetadataInput = {
	ownerId: OwnerId
	messageId: string
	deletedAt: string
}

/**
 * Metadata-only delivery-event delete. Stale when the row's `updated_at` is
 * newer than `deletedAt`. Idempotent when already absent.
 */
export type MailboxDeleteDeliveryEventInput = {
	ownerId: OwnerId
	eventId: string
	deletedAt: string
}

/**
 * Deferred empty-thread cleanup (D1 `deleteEmptyEmailThreads` parity).
 * Stale-safe by `thread.updated_at`; no-op when messages remain.
 */
export type MailboxDeleteThreadIfEmptyInput = {
	ownerId: OwnerId
	threadId: string
	deletedAt: string
}

/**
 * Partial touch/update/classify outcome.
 * - `accepted` — mutation applied
 * - `missing` — target row absent (idempotent success for best-effort callers)
 * - `stale` — newer `updated_at` retained
 */
export type MailboxPartialMutationResult =
	| { status: 'accepted' }
	| { status: 'missing' }
	| { status: 'stale' }

/**
 * Metadata delete outcome (message, delivery event, or empty thread).
 * - `deleted` — row removed
 * - `missing` — already absent or nothing to delete (idempotent success)
 * - `stale` — newer `updated_at` retained
 */
export type MailboxDeleteResult =
	| { status: 'deleted' }
	| { status: 'missing' }
	| { status: 'stale' }

/** Per-event outcome from {@link MailboxRpc.upsertDeliveryEvents}. */
export type MailboxUpsertDeliveryEventBatchItemResult = {
	eventId: string
	inserted: boolean
	accepted: boolean
}

export type MailboxUpsertDeliveryEventsResult = {
	results: Array<MailboxUpsertDeliveryEventBatchItemResult>
}

export type MailboxUpsertMessageGraphInput =
	| {
			ownerId: OwnerId
			thread?: MailboxThreadInput | null
			message: MailboxMessageInput
			attachments?: Array<MailboxAttachmentInput>
			/** DR restore writes stay inert until finalizeRestore. */
			restore?: true
	  }
	| {
			ownerId: OwnerId
			/** DR import affordance for a parent thread with no surviving message. */
			thread: MailboxThreadInput
			message: null
			attachments?: never
			restore: true
	  }

/**
 * Mirror / read / retention / purge surface. Authoritative USER inbound ledger
 * CAS RPCs are intersected below; `system:email` remains D1-only.
 */
type MailboxCoreRpc = {
	/**
	 * Authoritative USER graph write. The entire thread/message/attachment
	 * graph commits in one owner-local SQLite transaction.
	 */
	upsertMessageGraph: (
		input: MailboxUpsertMessageGraphInput,
	) => Promise<{ ok: true; accepted: boolean }>
	/**
	 * Authoritative USER inbound graph commit. The active `storing` lease and
	 * graph identity are checked in the same SQLite transaction as all graph
	 * writes, so an expired/replaced lease cannot commit metadata.
	 */
	commitInboundMessageGraph: (input: {
		ownerId: OwnerId
		deliveryId: string
		storageLease: string
		thread: MailboxThreadInput
		message: MailboxMessageInput
		attachments: Array<MailboxAttachmentInput>
	}) => Promise<MailboxCommitInboundMessageGraphResult>
	commitOutboundTerminal: (
		input: MailboxCommitOutboundTerminalInput,
	) => Promise<{ message: MailboxMessageRecord; eventInserted: boolean }>
	completeOutboundProviderIndexRepair: (input: {
		ownerId: OwnerId
		provider: string
		providerMessageId: string
	}) => Promise<{ cleared: boolean }>
	getOutboundProviderIndexRepairStatus: (input: {
		ownerId: OwnerId
	}) => Promise<MailboxProviderIndexRepairStatus>
	recordBoundedRejection: (input: {
		ownerId: OwnerId
		inboxId: string
		recipient: string
		reason: string
		phase: string
		day: string
		now: string
		detailLimit: number
		detailEventId: string
	}) => Promise<{ count: number; detailed: boolean }>
	/**
	 * Complete delivery-event snapshot upsert. Bounded pre-claim audits cannot
	 * replace authoritative Mailbox rows.
	 */
	upsertDeliveryEvent: (input: {
		ownerId: OwnerId
		event: MailboxDeliveryEventInput
		latestDeliveryStatus?: {
			messageId: string
			deliveryStatus: EmailDeliveryStatus
			deliveryStatusAt: string
		} | null
	}) => Promise<{
		inserted: boolean
		accepted: boolean
		updatedLatestStatus: boolean
	}>
	/**
	 * Upsert a bounded batch of complete immutable delivery-event snapshots in
	 * one transaction. Does not patch message latest delivery status — that
	 * remains from the prior full message snapshot.
	 */
	upsertDeliveryEvents: (input: {
		ownerId: OwnerId
		events: Array<MailboxDeliveryEventInput>
		/** DR restore only: admit authoritative inbound ledger snapshots. */
		restore?: true
	}) => Promise<MailboxUpsertDeliveryEventsResult>
	touchThread: (
		input: MailboxTouchThreadInput,
	) => Promise<MailboxPartialMutationResult>
	updateMessageDelivery: (
		input: MailboxUpdateMessageDeliveryInput,
	) => Promise<MailboxPartialMutationResult>
	setMessageClassification: (
		input: MailboxSetMessageClassificationInput,
	) => Promise<MailboxPartialMutationResult>
	deleteMessageMetadata: (
		input: MailboxDeleteMessageMetadataInput,
	) => Promise<MailboxDeleteResult>
	/**
	 * Authoritative USER delete. Canonical owner-safe R2 objects are deleted
	 * before message metadata in one owner-bound DO orchestration.
	 */
	deleteMessageWithBlobs: (input: {
		ownerId: OwnerId
		messageId: string
	}) => Promise<MailboxDeleteMessageWithBlobsResult>
	/**
	 * Fence an already-missing USER message before compatibility R2/D1 cleanup.
	 * Refuses to tombstone when Mailbox metadata became present concurrently.
	 */
	tombstoneMissingMessage: (input: {
		ownerId: OwnerId
		messageId: string
		deletedAt: string
	}) => Promise<MailboxTombstoneMissingMessageResult>
	deleteDeliveryEvent: (
		input: MailboxDeleteDeliveryEventInput,
	) => Promise<MailboxDeleteResult>
	deleteThreadIfEmpty: (
		input: MailboxDeleteThreadIfEmptyInput,
	) => Promise<MailboxDeleteResult>
	getThread: (input: {
		threadId: string
	}) => Promise<MailboxThreadRecord | null>
	findThreadForInboundMessage: (input: {
		inboxId?: string | null
		references: Array<string>
		inReplyToHeader?: string | null
	}) => Promise<MailboxThreadRecord | null>
	getMessage: (input: {
		messageId: string
	}) => Promise<MailboxMessageRecord | null>
	getMessageByMessageIdHeader: (input: {
		messageIdHeader: string
	}) => Promise<MailboxMessageRecord | null>
	getOutboundMessageByProviderMessageId: (input: {
		providerMessageId: string
	}) => Promise<MailboxMessageRecord | null>
	listMessages: (input: MailboxListMessagesInput) => Promise<{
		messages: Array<MailboxMessageRecord>
		nextCursor: string | null
	}>
	searchMessages: (input: MailboxSearchMessagesInput) => Promise<{
		messages: Array<MailboxMessageRecord>
	}>
	countMessages: (
		input: MailboxCountMessagesInput,
	) => Promise<{ total: number }>
	getAttachment: (input: {
		attachmentId: string
	}) => Promise<MailboxAttachmentRecord | null>
	listAttachmentsForMessage: (input: {
		messageId: string
	}) => Promise<Array<MailboxAttachmentRecord>>
	listDeliveryEvents: (input: {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit?: number
	}) => Promise<Array<MailboxDeliveryEventRecord>>
	countDeliveryEvents: (input: {
		ownerId: OwnerId
		eventType: EmailDeliveryEventType
		provider: string
		createdAtGte: string
	}) => Promise<{ count: number }>
	getDeliveryEventByProviderEventId: (input: {
		providerEventId: string
	}) => Promise<MailboxDeliveryEventRecord | null>
	countMailbox: (input?: { restore?: true }) => Promise<MailboxCountResult>
	inspectRestoreState: (input: {
		ownerId: OwnerId
	}) => Promise<MailboxRestoreStatus>
	beginRestore: (input: { ownerId: OwnerId }) => Promise<{ ok: true }>
	finalizeRestore: (input: { ownerId: OwnerId }) => Promise<{ ok: true }>
	readDrillResult: (input: {
		ownerId: OwnerId
	}) => Promise<MailboxCountResult | null>
	completeDrill: (input: {
		ownerId: OwnerId
		result: MailboxCountResult
	}) => Promise<{ ok: true }>
	exportMailbox: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<MailboxExportResult>
	listBlobReferences: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<MailboxBlobReferencePage>
	/**
	 * Owner-bound retention pass using natural production cutoffs only (no
	 * cutoff override). Reuses the same pass + alarm reschedule as `alarm`.
	 */
	runRetentionNow: (input: {
		ownerId: OwnerId
	}) => Promise<MailboxRunRetentionNowResult>
	getInboundDueWorkHint: (input: {
		ownerId: OwnerId
		/** Optional clock for due-at clamping; defaults to wall clock. */
		now?: string
	}) => Promise<{ dueAt: string | null }>
	purge: (input: { ownerId: OwnerId }) => Promise<{ ok: true }>
}

export type MailboxInboundLedgerRpc = MailboxInboundDeliveryLedgerRpc &
	MailboxInboundEffectLedgerRpc

export type MailboxRpc = MailboxCoreRpc &
	MailboxInboundLedgerRpc &
	DurableObjectPitrRpc

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { emailAttachmentBlobKey, emailRawMimeKey } from './blob-keys.ts'
import {
	mailboxBlobDeleteMaxKeys,
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionAlarmSkewMs,
	mailboxRetentionContinuationDelayMs,
	mailboxRetentionMessageCandidatesPerTurn,
	mailboxRetentionMetadataBatchSize,
	mailboxRetentionRetryDelayMs,
	type MailboxBlobReference,
} from './mailbox-types.ts'
import type { MailboxStore } from './mailbox-store.ts'

const messageRetentionMs = mailboxMessageRetentionDays * 24 * 60 * 60 * 1000
const deliveryEventRetentionMs =
	mailboxDeliveryEventRetentionDays * 24 * 60 * 60 * 1000

export type MailboxRetentionPassResult = {
	/** True when this turn's single message blob delete failed (row retained). */
	hadBlobDeleteFailures: boolean
	/** True when expired rows remain for a later alarm/invocation. */
	expiredWorkRemaining: boolean
	/** True when another expired message/event can run immediately. */
	eligibleExpiredWorkRemaining: boolean
	/** Earliest deferred message retry, or null when no retry is pending. */
	earliestRetryAtMs: number | null
}

export type MailboxRetentionMessageCandidate = {
	id: string
	direction: 'inbound' | 'outbound'
	created_at: string
	updated_at: string
}

export type MailboxRetentionMessageDeleteResult =
	| 'deleted'
	| 'skipped'
	| 'blob-delete-failed'

export type MailboxRetentionRescheduleKind =
	| 'idle'
	| 'backoff'
	| 'continue'
	| 'next-due'

export type MailboxRetentionReschedule = {
	kind: MailboxRetentionRescheduleKind
	atMs: number | null
}

/**
 * Deterministic next-alarm choice after a retention pass.
 * Select the earliest of an eligible-work continuation, a durable per-message
 * retry, and ordinary future retention work.
 */
export function computeMailboxRetentionReschedule(input: {
	nowMs: number
	eligibleExpiredWorkRemaining: boolean
	earliestRetryAtMs: number | null
	nextDueAtMs: number | null
	continuationDelayMs?: number
}): MailboxRetentionReschedule {
	const continuationDelayMs =
		input.continuationDelayMs ?? mailboxRetentionContinuationDelayMs
	const choices: Array<MailboxRetentionReschedule> = []
	if (input.eligibleExpiredWorkRemaining) {
		choices.push({ kind: 'continue', atMs: input.nowMs + continuationDelayMs })
	}
	if (
		input.earliestRetryAtMs != null &&
		input.earliestRetryAtMs > input.nowMs
	) {
		choices.push({ kind: 'backoff', atMs: input.earliestRetryAtMs })
	}
	if (input.nextDueAtMs != null && input.nextDueAtMs > input.nowMs) {
		choices.push({ kind: 'next-due', atMs: input.nextDueAtMs })
	}
	return (
		choices.sort(
			(left, right) =>
				(left.atMs ?? Number.POSITIVE_INFINITY) -
				(right.atMs ?? Number.POSITIVE_INFINITY),
		)[0] ?? { kind: 'idle', atMs: null }
	)
}

/**
 * Soonest retention due-time from stored rows, or null when empty.
 * Overdue rows yield timestamps in the past — callers must apply retry backoff
 * or continuation instead of scheduling at now+1s blindly.
 */
export function nextMailboxRetentionDueAtMs(
	store: MailboxStore,
	nowMs = Date.now(),
): number | null {
	let next: number | null = null
	const consider = (at: number) => {
		if (!Number.isFinite(at)) return
		if (next == null || at < next) next = at
	}

	const oldestMessage = store.oldestMessageCreatedAt(
		new Date(nowMs).toISOString(),
	)
	if (oldestMessage) {
		consider(Date.parse(oldestMessage) + messageRetentionMs)
	}
	const oldestEvent = store.oldestDeliveryEventCreatedAt()
	if (oldestEvent) {
		consider(Date.parse(oldestEvent) + deliveryEventRetentionMs)
	}
	const earliestRetryAt = store.earliestMessageRetentionRetryAt()
	if (earliestRetryAt) {
		consider(Date.parse(earliestRetryAt))
	}
	return next
}

/**
 * Schedule time for the next retention alarm on a write path.
 * - Future due-time → schedule at due-time
 * - Overdue work → bounded hourly backoff (avoids 1s storms on persistent R2 failure)
 */
export function mailboxRetentionAlarmAtMs(input: {
	dueAtMs: number | null
	nowMs?: number
}): number | null {
	if (input.dueAtMs == null) return null
	const nowMs = input.nowMs ?? Date.now()
	if (input.dueAtMs <= nowMs) {
		return nowMs + mailboxRetentionRetryDelayMs
	}
	return input.dueAtMs
}

export type MailboxRetentionWriteAlarmSelection =
	| { action: 'idle' }
	| { action: 'keep-existing' }
	| { action: 'set'; atMs: number }

/**
 * Choose whether a write-path ensure should set, keep, or clear interest in
 * an alarm. Sustained writes must never postpone an earlier existing alarm;
 * near-equal times within skew keep the existing alarm to avoid churn.
 */
export function selectMailboxRetentionWriteAlarm(input: {
	proposedAtMs: number | null
	existingAtMs: number | null
	skewMs?: number
}): MailboxRetentionWriteAlarmSelection {
	if (input.proposedAtMs == null) {
		return { action: 'idle' }
	}
	const existingAtMs = input.existingAtMs
	if (existingAtMs == null) {
		return { action: 'set', atMs: input.proposedAtMs }
	}
	const skewMs = input.skewMs ?? mailboxRetentionAlarmSkewMs
	if (Math.abs(existingAtMs - input.proposedAtMs) < skewMs) {
		return { action: 'keep-existing' }
	}
	// Existing fires sooner — never postpone retention for a later proposal.
	if (existingAtMs < input.proposedAtMs) {
		return { action: 'keep-existing' }
	}
	return { action: 'set', atMs: input.proposedAtMs }
}

export async function deleteMailboxBlobKeys(
	blobs: Pick<R2Bucket, 'delete'>,
	keys: Array<string>,
): Promise<void> {
	if (keys.length === 0) return
	for (let index = 0; index < keys.length; index += mailboxBlobDeleteMaxKeys) {
		const chunk = keys.slice(index, index + mailboxBlobDeleteMaxKeys)
		await blobs.delete(chunk)
	}
}

/**
 * Build owner-safe R2 keys for an expired message. Never deletes arbitrary
 * stored key strings — only canonical inbound raw MIME keys and matching
 * external attachment keys.
 */
export function canonicalMailboxMessageBlobReferences(input: {
	ownerId: OwnerId
	messageId: string
	direction: 'inbound' | 'outbound'
	attachments: Array<{ id: string; storage_key: string | null }>
}): Array<MailboxBlobReference> {
	const references: Array<MailboxBlobReference> = []
	if (input.direction === 'inbound') {
		references.push({
			kind: 'raw_mime',
			key: emailRawMimeKey(input.ownerId, input.messageId),
			messageId: input.messageId,
			attachmentId: null,
		})
	}
	for (const attachment of input.attachments) {
		if (attachment.storage_key == null) continue
		const expected = emailAttachmentBlobKey(
			input.ownerId,
			input.messageId,
			attachment.id,
		)
		if (attachment.storage_key === expected) {
			references.push({
				kind: 'attachment',
				key: expected,
				messageId: input.messageId,
				attachmentId: attachment.id,
			})
		}
	}
	return references
}

export function canonicalRetentionBlobKeys(
	input: Parameters<typeof canonicalMailboxMessageBlobReferences>[0],
): Array<string> {
	return canonicalMailboxMessageBlobReferences(input).map(
		(reference) => reference.key,
	)
}

/**
 * Revalidate one previously selected message, delete its canonical blobs in
 * bounded R2 chunks, then tombstone/delete metadata. The DO caller must place
 * exactly this operation inside one safe input gate.
 */
export async function deleteMailboxRetentionCandidate(input: {
	store: MailboxStore
	blobs: Pick<R2Bucket, 'delete'>
	ownerId: OwnerId
	candidate: MailboxRetentionMessageCandidate
	cutoff: string
}): Promise<MailboxRetentionMessageDeleteResult> {
	const current = input.store.getMessageForRetention(input.candidate.id)
	if (
		current == null ||
		current.created_at >= input.cutoff ||
		current.created_at !== input.candidate.created_at ||
		current.updated_at !== input.candidate.updated_at ||
		current.direction !== input.candidate.direction
	) {
		return 'skipped'
	}

	const keys = canonicalRetentionBlobKeys({
		ownerId: input.ownerId,
		messageId: current.id,
		direction: current.direction,
		attachments: input.store.listAttachmentsForRetention([current.id]),
	})
	try {
		await deleteMailboxBlobKeys(input.blobs, keys)
	} catch (error) {
		console.warn('mailbox-retention-blob-delete-failed', { error })
		const failedAtMs = Date.now()
		input.store.recordMessageRetentionFailure({
			messageId: current.id,
			retryAt: new Date(
				failedAtMs + mailboxRetentionRetryDelayMs,
			).toISOString(),
			error: String(error).slice(0, 1_000),
			updatedAt: new Date(failedAtMs).toISOString(),
		})
		return 'blob-delete-failed'
	}
	input.store.tombstoneAndDeleteMessage({
		messageId: current.id,
		deletedAt: new Date().toISOString(),
	})
	return 'deleted'
}

export function selectMailboxRetentionCandidate(
	store: MailboxStore,
	cutoff: string,
	now = new Date().toISOString(),
): MailboxRetentionMessageCandidate | null {
	return (
		store.listExpiredMessagesForRetention({
			cutoff,
			now,
			limit: mailboxRetentionMessageCandidatesPerTurn,
		})[0] ?? null
	)
}

async function pruneExpiredMessage(input: {
	cutoff: string
	deleteMessage: (
		cutoff: string,
	) => Promise<MailboxRetentionMessageDeleteResult | null>
}): Promise<boolean> {
	const result = await input.deleteMessage(input.cutoff)
	return result === 'blob-delete-failed'
}

export async function enforceMailboxRetention(input: {
	store: MailboxStore
	deleteMessage: (
		cutoff: string,
	) => Promise<MailboxRetentionMessageDeleteResult | null>
}): Promise<MailboxRetentionPassResult> {
	const messageCutoff = new Date(Date.now() - messageRetentionMs).toISOString()
	const eventCutoff = new Date(
		Date.now() - deliveryEventRetentionMs,
	).toISOString()

	const hadBlobDeleteFailures = await pruneExpiredMessage({
		cutoff: messageCutoff,
		deleteMessage: input.deleteMessage,
	})

	input.store.pruneExpiredDeliveryEvents({
		cutoff: eventCutoff,
		limit: mailboxRetentionMetadataBatchSize,
	})
	input.store.pruneOrphanThreads(mailboxRetentionMetadataBatchSize)

	const expiredWorkRemaining =
		input.store.hasExpiredMessages(messageCutoff) ||
		input.store.hasExpiredDeliveryEvents(eventCutoff)
	const now = new Date().toISOString()
	const eligibleExpiredWorkRemaining =
		input.store.hasEligibleExpiredMessages({ cutoff: messageCutoff, now }) ||
		input.store.hasExpiredDeliveryEvents(eventCutoff)
	const retryAt = input.store.earliestMessageRetentionRetryAt()
	const earliestRetryAtMs = retryAt == null ? null : Date.parse(retryAt)

	return {
		hadBlobDeleteFailures,
		expiredWorkRemaining,
		eligibleExpiredWorkRemaining,
		earliestRetryAtMs:
			earliestRetryAtMs != null && Number.isFinite(earliestRetryAtMs)
				? earliestRetryAtMs
				: null,
	}
}

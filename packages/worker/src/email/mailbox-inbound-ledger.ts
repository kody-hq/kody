import { sqlSourcesOf, nextState } from '@kody-internal/shared/state-machine.ts'
import { inboundDedupePointerState } from './inbound-dedupe-pointer-state.ts'
import { inboundDeliveryState } from './inbound-delivery-state.ts'
import { inboundSubscriptionEffectState } from './inbound-subscription-effect-state.ts'
/**
 * Mailbox USER inbound ledger authority CAS primitives.
 *
 * Owner-bound SQLite helpers implementing authoritative USER transitions.
 * D1 remains authoritative only for `system:email`. Effect lease CAS lives in
 * `mailbox-inbound-effect-ledger.ts`. No external usage/subscription side
 * effects.
 */

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { mapMailboxDeliveryEventRow } from './mailbox-mappers.ts'
import { isMailboxMessageTombstoned } from './mailbox-message-deletion-tombstones.ts'
import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxNonEmptyString,
	type MailboxInboundDeliveryState,
} from './mailbox-types.ts'
import {
	assertMailboxInboundNonNegativeFiniteNumber,
	detailJsonFromMailboxInboundSnapshot,
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
	mailboxInboundReconciliationRetryMs,
	mailboxInboundStorageLeaseMs,
	mailboxMaxSubscriptionEffectAttempts,
	mailboxMessageExists,
	mailboxStaleInboundDeliveryAgeMs,
	needsMailboxEffectReconcile,
	normalizeMailboxInboundLimit,
	normalizeMailboxInboundNow,
	readMailboxDeliveryEventRow,
	readMailboxInboundDeliveryById,
	snapshotFromMailboxDeliveryEventRow,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger-shared.ts'

export {
	assertMailboxInboundNonNegativeFiniteNumber,
	detailJsonFromMailboxInboundSnapshot,
	mailboxEffectRetryMs,
	mailboxInboundDedupeProvider,
	mailboxInboundDeliveryDedupeWindowMs,
	mailboxInboundDueWorkDefaultLimit,
	mailboxInboundProvider,
	mailboxInboundReconciliationRetryMs,
	mailboxInboundStorageLeaseMs,
	mailboxMaxSubscriptionEffectAttempts,
	mailboxMessageExists,
	mailboxStaleInboundDeliveryAgeMs,
	mailboxSubscriptionEffectLeaseMs,
	mailboxUsageEffectLeaseMs,
	needsMailboxEffectReconcile,
	normalizeMailboxInboundLimit,
	normalizeMailboxInboundNow,
	readMailboxDeliveryEventRow,
	readMailboxInboundDeliveryById,
	snapshotFromMailboxDeliveryEventRow,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger-shared.ts'

/** Charged pending insert input (quota already accepted via UserMeter). */
export type MailboxInboundDeliveryInsertInput = {
	fingerprint: string
	deliveryId: string
	messageId: string
	threadId: string
	rawMimeKey: string
	inboxId: string
	recipient: string
	envelopeFrom: string
	provider?: string
	quotaDay: string
	dedupeExpiresAt: string
	usageStartedAt?: string | null
}

export type MailboxInsertChargedPendingInboundDeliveryResult =
	| { status: 'inserted'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'existed'; delivery: MailboxInboundDeliverySnapshot }

export type MailboxClaimInboundDeliveryStorageResult =
	| { status: 'claimed'; delivery: MailboxInboundDeliverySnapshot }
	| {
			status: 'not-claimed'
			delivery: MailboxInboundDeliverySnapshot | null
	  }

export type MailboxReleaseInboundDeliveryStorageResult =
	| { status: 'released'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'not-held' }

export type MailboxMarkInboundDeliveryRejectedResult =
	| { status: 'rejected'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'already-rejected'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'already-received'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'lease-lost' }

export type MailboxMarkInboundDeliveryReceivedResult =
	| { status: 'received'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'already-received'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'lease-lost' }

export type MailboxDeferInboundDeliveryReconcileResult =
	| { status: 'deferred'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'missing' }
	| { status: 'not-applicable' }

export type MailboxClaimInboundDeliveryCleanupResult =
	| { status: 'claimed'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'not-claimed'; delivery: MailboxInboundDeliverySnapshot | null }

export type MailboxReleaseInboundDeliveryCleanupResult =
	| { status: 'released'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'not-held' }

export type MailboxMarkInboundDeliveryOrphanCleanedResult =
	| { status: 'orphan-cleaned'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'lease-lost' }

export type MailboxPruneExpiredInboundDedupeResult = {
	pruned: number
	prunedEventIds: Array<string>
}

export type MailboxListDueStaleInboundDeliveriesResult = {
	deliveries: Array<MailboxInboundDeliverySnapshot>
}

export type MailboxInboundDeliveryLedgerRpc = {
	getInboundDelivery: (input: {
		ownerId: OwnerId
		deliveryId: string
	}) => Promise<MailboxInboundDeliverySnapshot | null>
	getInboundDeliveryWindow: (input: {
		ownerId: OwnerId
		fingerprint: string
		now?: string
	}) => Promise<MailboxInboundDeliverySnapshot | null>
	claimInboundDeliveryWindow: (input: {
		ownerId: OwnerId
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}) => Promise<MailboxInboundDeliverySnapshot>
	insertChargedPendingInboundDelivery: (input: {
		ownerId: OwnerId
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}) => Promise<MailboxInsertChargedPendingInboundDeliveryResult>
	claimInboundDeliveryStorage: (input: {
		ownerId: OwnerId
		deliveryId: string
		expectedAttachmentCount: number
		usageStartedAt?: string | null
		now?: string
	}) => Promise<MailboxClaimInboundDeliveryStorageResult>
	releaseInboundDeliveryStorage: (input: {
		ownerId: OwnerId
		deliveryId: string
		storageLease: string
		now?: string
	}) => Promise<MailboxReleaseInboundDeliveryStorageResult>
	markInboundDeliveryRejected: (input: {
		ownerId: OwnerId
		deliveryId: string
		reason: string
		expectedStorageLease?: string | null
		expectedState?: MailboxInboundDeliveryState
		now?: string
	}) => Promise<MailboxMarkInboundDeliveryRejectedResult>
	markInboundDeliveryReceived: (input: {
		ownerId: OwnerId
		deliveryId: string
		storageLease: string
		usageDurationMs: number
		usageMonth: string
		usageBytes: number
		now?: string
	}) => Promise<MailboxMarkInboundDeliveryReceivedResult>
	pruneExpiredInboundDedupePointers: (input: {
		ownerId: OwnerId
		now?: string
		limit?: number
	}) => Promise<MailboxPruneExpiredInboundDedupeResult>
	deferInboundDeliveryReconciliation: (input: {
		ownerId: OwnerId
		deliveryId: string
		now?: string
	}) => Promise<MailboxDeferInboundDeliveryReconcileResult>
	claimInboundDeliveryCleanup: (input: {
		ownerId: OwnerId
		deliveryId: string
		expectedState: MailboxInboundDeliveryState
		expectedUpdatedAt: string
		staleBefore: string
		now?: string
	}) => Promise<MailboxClaimInboundDeliveryCleanupResult>
	releaseInboundDeliveryCleanup: (input: {
		ownerId: OwnerId
		deliveryId: string
		cleanupLease: string
		now?: string
	}) => Promise<MailboxReleaseInboundDeliveryCleanupResult>
	markInboundDeliveryOrphanCleaned: (input: {
		ownerId: OwnerId
		deliveryId: string
		cleanupLease: string
		outcome: 'deleted' | 'delete-failed'
		now?: string
	}) => Promise<MailboxMarkInboundDeliveryOrphanCleanedResult>
	listDueStaleInboundDeliveries: (input: {
		ownerId: OwnerId
		now?: string
		limit?: number
	}) => Promise<MailboxListDueStaleInboundDeliveriesResult>
}

const deliveryStoringToPendingGuard = sqlSourcesOf(
	inboundDeliveryState,
	'RELEASE_LEASE',
	['storing'],
)
const deliveryPendingToStoringGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_STORAGE',
	['pending'],
)
const deliveryStoringToStoringGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_STORAGE',
	['storing'],
)
const deliveryReceivedToStoringGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_STORAGE',
	['received'],
)
const deliveryStoringToReceivedGuard = sqlSourcesOf(
	inboundDeliveryState,
	'RECEIVE',
	['storing'],
)

export function mailboxInboundDedupePointerId(fingerprint: string) {
	return `email-inbound-dedupe:${assertMailboxNonEmptyString(fingerprint, 'fingerprint')}`
}

export function resolveMailboxSubscriptionEffectFailure(attemptCount: number) {
	const nextAttempt = Math.max(0, Math.floor(attemptCount)) + 1
	return {
		attemptCount: nextAttempt,
		deadLettered: nextAttempt >= mailboxMaxSubscriptionEffectAttempts,
	}
}

function assertInsertInput(
	ownerId: OwnerId,
	delivery: MailboxInboundDeliveryInsertInput,
) {
	const deliveryId = assertMailboxNonEmptyString(
		delivery.deliveryId,
		'delivery.deliveryId',
	)
	const messageId = assertMailboxNonEmptyString(
		delivery.messageId,
		'delivery.messageId',
	)
	const fingerprint = assertMailboxNonEmptyString(
		delivery.fingerprint,
		'delivery.fingerprint',
	)
	const threadId = assertMailboxNonEmptyString(
		delivery.threadId,
		'delivery.threadId',
	)
	const rawMimeKey = assertMailboxNonEmptyString(
		delivery.rawMimeKey,
		'delivery.rawMimeKey',
	)
	if (rawMimeKey !== emailRawMimeKey(ownerId, messageId)) {
		throw new Error(
			'Mailbox inbound rawMimeKey must equal emailRawMimeKey(ownerId, messageId).',
		)
	}
	assertMailboxCanonicalIsoTimestamp(
		delivery.dedupeExpiresAt,
		'delivery.dedupeExpiresAt',
	)
	assertMailboxNonEmptyString(delivery.inboxId, 'delivery.inboxId')
	assertMailboxNonEmptyString(delivery.recipient, 'delivery.recipient')
	if (typeof delivery.envelopeFrom !== 'string') {
		throw new Error('Mailbox delivery.envelopeFrom must be a string.')
	}
	assertMailboxNonEmptyString(delivery.quotaDay, 'delivery.quotaDay')
	return { deliveryId, messageId, fingerprint, threadId, rawMimeKey }
}

function pendingSnapshotFromInsert(
	delivery: MailboxInboundDeliveryInsertInput,
	validated: ReturnType<typeof assertInsertInput>,
	provider: string,
): Omit<MailboxInboundDeliverySnapshot, 'createdAt' | 'updatedAt'> {
	return {
		fingerprint: validated.fingerprint,
		deliveryId: validated.deliveryId,
		messageId: validated.messageId,
		threadId: validated.threadId,
		rawMimeKey: validated.rawMimeKey,
		inboxId: delivery.inboxId,
		recipient: delivery.recipient,
		envelopeFrom: delivery.envelopeFrom,
		provider,
		quotaDay: delivery.quotaDay,
		dedupeExpiresAt: delivery.dedupeExpiresAt,
		state: 'pending',
		...(delivery.usageStartedAt
			? { usageStartedAt: delivery.usageStartedAt }
			: {}),
	}
}

export function getMailboxInboundDelivery(
	sql: SqlStorage,
	deliveryId: string,
): MailboxInboundDeliverySnapshot | null {
	return readMailboxInboundDeliveryById(
		sql,
		assertMailboxNonEmptyString(deliveryId, 'deliveryId'),
	)
}

export function getMailboxInboundDeliveryWindow(
	sql: SqlStorage,
	input: { fingerprint: string; now?: string },
): MailboxInboundDeliverySnapshot | null {
	const now = normalizeMailboxInboundNow(input.now)
	const pointerId = mailboxInboundDedupePointerId(input.fingerprint)
	const row = sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM email_delivery_events
			WHERE id = ? AND provider = ? AND dedupe_expires_at > ?
			LIMIT 1`,
			pointerId,
			mailboxInboundDedupeProvider,
			now,
		)
		.toArray()[0]
	return row
		? snapshotFromMailboxDeliveryEventRow(mapMailboxDeliveryEventRow(row))
		: null
}

export function claimMailboxInboundDeliveryWindow(
	sql: SqlStorage,
	input: {
		ownerId: OwnerId
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	},
): MailboxInboundDeliverySnapshot {
	const now = normalizeMailboxInboundNow(input.now)
	const ownerId = assertMailboxNonEmptyString(input.ownerId, 'ownerId')
	const validated = assertInsertInput(ownerId, input.delivery)
	const pointerId = mailboxInboundDedupePointerId(validated.fingerprint)
	nextState(inboundDedupePointerState, 'pending', { type: 'RESET_WINDOW' })
	nextState(inboundDedupePointerState, 'rejected', { type: 'RESET_WINDOW' })
	const base = pendingSnapshotFromInsert(
		input.delivery,
		validated,
		input.delivery.provider ?? mailboxInboundProvider,
	)
	// Pointer rows use the dedupe provider; deliveryId in detail still points
	// at the charged delivery identity for window resolution.
	const detail = detailJsonFromMailboxInboundSnapshot({
		...base,
		createdAt: now,
		updatedAt: now,
	})
	sql.exec(
		`INSERT INTO email_delivery_events (
			id, message_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, needs_effect_reconcile, state, fingerprint,
			dedupe_expires_at, usage_started_at, created_at, updated_at
		) VALUES (?, NULL, ?, 'receive_started', ?, ?, ?, 0, 'pending', ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			inbox_id = excluded.inbox_id,
			detail_json = excluded.detail_json,
			state = excluded.state,
			fingerprint = excluded.fingerprint,
			dedupe_expires_at = excluded.dedupe_expires_at,
			usage_started_at = excluded.usage_started_at,
			provider_event_id = excluded.provider_event_id,
			created_at = excluded.created_at,
			updated_at = excluded.updated_at
		WHERE email_delivery_events.provider = ?
			AND email_delivery_events.dedupe_expires_at <= ?`,
		pointerId,
		input.delivery.inboxId,
		mailboxInboundDedupeProvider,
		pointerId,
		detail,
		validated.fingerprint,
		input.delivery.dedupeExpiresAt,
		input.delivery.usageStartedAt ?? null,
		now,
		now,
		mailboxInboundDedupeProvider,
		now,
	)
	const row = readMailboxDeliveryEventRow(sql, pointerId)
	if (row?.provider !== mailboxInboundDedupeProvider) {
		throw new Error('Mailbox inbound dedupe pointer failed its provider fence.')
	}
	const snapshot = row ? snapshotFromMailboxDeliveryEventRow(row) : null
	if (!snapshot) {
		throw new Error('Failed to resolve the inbound delivery dedupe window.')
	}
	return snapshot
}

/**
 * Persist a UserMeter-accepted pending delivery. Explicit inserted/existed
 * matches the UserMeter consume replay shape.
 */
export function insertMailboxChargedPendingInboundDelivery(
	sql: SqlStorage,
	input: {
		ownerId: OwnerId
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	},
): MailboxInsertChargedPendingInboundDeliveryResult {
	const now = normalizeMailboxInboundNow(input.now)
	const ownerId = assertMailboxNonEmptyString(input.ownerId, 'ownerId')
	const validated = assertInsertInput(ownerId, input.delivery)
	const existing = readMailboxInboundDeliveryById(sql, validated.deliveryId)
	if (existing) return { status: 'existed', delivery: existing }

	const base = pendingSnapshotFromInsert(
		input.delivery,
		validated,
		mailboxInboundProvider,
	)
	const cursor = sql.exec(
		`INSERT OR IGNORE INTO email_delivery_events (
			id, message_id, inbox_id, event_type, provider, provider_event_id,
			detail_json, needs_effect_reconcile, state, fingerprint,
			dedupe_expires_at, usage_started_at, created_at, updated_at
		) VALUES (?, NULL, ?, 'receive_started', ?, ?, ?, 0, 'pending', ?, ?, ?, ?, ?)`,
		validated.deliveryId,
		input.delivery.inboxId,
		mailboxInboundProvider,
		validated.deliveryId,
		detailJsonFromMailboxInboundSnapshot({
			...base,
			createdAt: now,
			updatedAt: now,
		}),
		validated.fingerprint,
		input.delivery.dedupeExpiresAt,
		input.delivery.usageStartedAt ?? null,
		now,
		now,
	)
	const after = readMailboxInboundDeliveryById(sql, validated.deliveryId)
	if (!after) {
		throw new Error(
			'Inbound delivery charge was accepted but the delivery event was not persisted.',
		)
	}
	return {
		status: cursor.rowsWritten > 0 ? 'inserted' : 'existed',
		delivery: after,
	}
}

export function claimMailboxInboundDeliveryStorage(
	sql: SqlStorage,
	input: {
		deliveryId: string
		expectedAttachmentCount: number
		usageStartedAt?: string | null
		now?: string
	},
): MailboxClaimInboundDeliveryStorageResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const storageLease = crypto.randomUUID()
	const expiredBefore = new Date(
		Date.parse(now) - mailboxInboundStorageLeaseMs,
	).toISOString()
	const expectedAttachmentCount = Math.floor(
		assertMailboxInboundNonNegativeFiniteNumber(
			input.expectedAttachmentCount,
			'expectedAttachmentCount',
		),
	)
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current) return { status: 'not-claimed', delivery: null }

	const canClaim =
		current.state === 'pending' ||
		(current.state === 'storing' &&
			current.storageLeaseAt != null &&
			current.storageLeaseAt < expiredBefore) ||
		(current.state === 'received' &&
			!mailboxMessageExists(sql, current.messageId))
	if (!canClaim) return { status: 'not-claimed', delivery: current }

	const usageStartedAt = current.usageStartedAt ?? input.usageStartedAt ?? null
	/**
	 * Storage reclaim invalidates prior finalization + in-flight effect leases.
	 * SQLite `json_set` only patches storage fields (stale lease keys can linger in
	 * `detail_json`); promoted Mailbox columns must clear explicitly so a stale
	 * effect worker cannot complete against a later re-finalization.
	 */
	nextState(inboundDeliveryState, current.state, { type: 'CLAIM_STORAGE' })
	if (current.subscriptionEffectState === 'processing')
		nextState(inboundSubscriptionEffectState, 'processing', { type: 'RESET' })
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		state: 'storing',
		storageLease,
		storageLeaseAt: now,
		expectedAttachmentCount,
		...(usageStartedAt ? { usageStartedAt } : {}),
		updatedAt: now,
		...(current.subscriptionEffectState === 'processing'
			? { subscriptionEffectState: 'pending' as const }
			: {}),
	}
	delete next.finalizationToken
	delete next.usageEffectLease
	delete next.usageEffectLeaseAt
	delete next.usageEffectRetryAt
	delete next.subscriptionEffectLease
	delete next.subscriptionEffectLeaseAt
	delete next.subscriptionEffectRetryAt
	sql.exec(
		`UPDATE email_delivery_events
		SET event_type = 'receive_started',
			message_id = NULL,
			detail_json = ?,
			state = 'storing',
			storage_lease = ?,
			storage_lease_at = ?,
			expected_attachment_count = ?,
			usage_started_at = COALESCE(usage_started_at, ?),
			finalization_token = NULL,
			usage_effect_lease = NULL,
			usage_effect_lease_at = NULL,
			usage_effect_retry_at = NULL,
			subscription_effect_lease = NULL,
			subscription_effect_lease_at = NULL,
			subscription_effect_retry_at = NULL,
			subscription_effect_state = CASE
				WHEN subscription_effect_state = 'processing' THEN 'pending'
				ELSE subscription_effect_state
			END,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND (
				state IN ${deliveryPendingToStoringGuard}
				OR (state IN ${deliveryStoringToStoringGuard} AND storage_lease_at < ?)
				OR (
					state IN ${deliveryReceivedToStoringGuard}
					AND NOT EXISTS (SELECT 1 FROM email_messages WHERE id = ?)
				)
			)`,
		detailJsonFromMailboxInboundSnapshot(next),
		storageLease,
		now,
		expectedAttachmentCount,
		usageStartedAt,
		now,
		deliveryId,
		mailboxInboundProvider,
		expiredBefore,
		current.messageId,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (after?.storageLease === storageLease && after.state === 'storing') {
		return { status: 'claimed', delivery: after }
	}
	return { status: 'not-claimed', delivery: after }
}

export function releaseMailboxInboundDeliveryStorage(
	sql: SqlStorage,
	input: {
		deliveryId: string
		storageLease: string
		now?: string
	},
): MailboxReleaseInboundDeliveryStorageResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const storageLease = assertMailboxNonEmptyString(
		input.storageLease,
		'storageLease',
	)
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (
		!current ||
		current.state !== 'storing' ||
		current.storageLease !== storageLease
	) {
		return { status: 'not-held' }
	}
	nextState(inboundDeliveryState, current.state, { type: 'RELEASE_LEASE' })
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		state: 'pending',
		updatedAt: now,
	}
	delete next.storageLease
	delete next.storageLeaseAt
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			state = 'pending',
			storage_lease = NULL,
			storage_lease_at = NULL,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND state IN ${deliveryStoringToPendingGuard}
			AND storage_lease = ?`,
		detailJsonFromMailboxInboundSnapshot(next),
		now,
		deliveryId,
		mailboxInboundProvider,
		storageLease,
	)
	if (cursor.rowsWritten < 1) return { status: 'not-held' }
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!after) return { status: 'not-held' }
	return { status: 'released', delivery: after }
}

export function markMailboxInboundDeliveryRejected(
	sql: SqlStorage,
	input: {
		deliveryId: string
		reason: string
		expectedStorageLease?: string | null
		expectedState?: MailboxInboundDeliveryState
		now?: string
	},
): MailboxMarkInboundDeliveryRejectedResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const reason = assertMailboxNonEmptyString(input.reason, 'reason')
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current) return { status: 'lease-lost' }
	if (current.state === 'rejected') {
		return { status: 'already-rejected', delivery: current }
	}
	if (current.state === 'received') {
		return mailboxMessageExists(sql, current.messageId)
			? { status: 'already-received', delivery: current }
			: { status: 'lease-lost' }
	}
	const expectedLease = input.expectedStorageLease ?? null
	const expectedState = input.expectedState ?? current.state
	if (
		current.state !== expectedState ||
		(current.storageLease ?? null) !== expectedLease
	) {
		return { status: 'lease-lost' }
	}
	nextState(inboundDeliveryState, current.state, { type: 'REJECT' })
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		state: 'rejected',
		rejectionReason: reason,
		updatedAt: now,
	}
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET event_type = 'rejected',
			detail_json = ?,
			state = 'rejected',
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND event_type = 'receive_started'
			AND state = ?
			AND (
				(? IS NULL AND storage_lease IS NULL)
				OR storage_lease = ?
			)`,
		detailJsonFromMailboxInboundSnapshot(next),
		now,
		deliveryId,
		mailboxInboundProvider,
		expectedState,
		expectedLease,
		expectedLease,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (cursor.rowsWritten > 0 && after?.state === 'rejected') {
		return { status: 'rejected', delivery: after }
	}
	if (after?.state === 'rejected') {
		return { status: 'already-rejected', delivery: after }
	}
	if (
		after?.state === 'received' &&
		mailboxMessageExists(sql, after.messageId)
	) {
		return { status: 'already-received', delivery: after }
	}
	return { status: 'lease-lost' }
}

export function markMailboxInboundDeliveryReceived(
	sql: SqlStorage,
	input: {
		deliveryId: string
		storageLease: string
		usageDurationMs: number
		usageMonth: string
		usageBytes: number
		now?: string
	},
): MailboxMarkInboundDeliveryReceivedResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const storageLease = assertMailboxNonEmptyString(
		input.storageLease,
		'storageLease',
	)
	const usageMonth = assertMailboxNonEmptyString(input.usageMonth, 'usageMonth')
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current) return { status: 'lease-lost' }
	if (current.state === 'received') {
		return { status: 'already-received', delivery: current }
	}
	if (current.state !== 'storing' || current.storageLease !== storageLease) {
		return { status: 'lease-lost' }
	}
	const usageDurationMs = Math.round(
		assertMailboxInboundNonNegativeFiniteNumber(
			input.usageDurationMs,
			'usageDurationMs',
		),
	)
	const usageBytes = Math.round(
		assertMailboxInboundNonNegativeFiniteNumber(input.usageBytes, 'usageBytes'),
	)
	nextState(inboundDeliveryState, current.state, { type: 'RECEIVE' })
	if (current.subscriptionEffectState)
		nextState(inboundSubscriptionEffectState, current.subscriptionEffectState, {
			type: 'RESET',
		})
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		state: 'received',
		finalizationToken: storageLease,
		subscriptionEffectState: 'pending',
		usageDurationMs: current.usageDurationMs ?? usageDurationMs,
		usageMonth: current.usageMonth ?? usageMonth,
		usageBytes: current.usageBytes ?? usageBytes,
		updatedAt: now,
	}
	delete next.storageLease
	delete next.storageLeaseAt
	const attachedMessageId = isMailboxMessageTombstoned(sql, current.messageId)
		? null
		: current.messageId
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET message_id = ?,
			event_type = 'received',
			detail_json = ?,
			state = 'received',
			storage_lease = NULL,
			storage_lease_at = NULL,
			finalization_token = ?,
			subscription_effect_state = ?,
			usage_duration_ms = ?,
			usage_month = ?,
			usage_bytes = ?,
			usage_effect_recorded_at = ?,
			needs_effect_reconcile = ?,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND state IN ${deliveryStoringToReceivedGuard}
			AND storage_lease = ?`,
		attachedMessageId,
		detailJsonFromMailboxInboundSnapshot(next),
		storageLease,
		next.subscriptionEffectState ?? 'pending',
		next.usageDurationMs ?? usageDurationMs,
		next.usageMonth ?? usageMonth,
		next.usageBytes ?? usageBytes,
		next.usageEffectRecordedAt ?? null,
		needsMailboxEffectReconcile(next) ? 1 : 0,
		now,
		deliveryId,
		mailboxInboundProvider,
		storageLease,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (cursor.rowsWritten > 0 && after?.state === 'received') {
		return { status: 'received', delivery: after }
	}
	if (after?.state === 'received') {
		return { status: 'already-received', delivery: after }
	}
	return { status: 'lease-lost' }
}

export function pruneMailboxExpiredInboundDedupePointers(
	sql: SqlStorage,
	input: { now?: string; limit?: number },
): MailboxPruneExpiredInboundDedupeResult {
	const now = normalizeMailboxInboundNow(input.now)
	const limit = normalizeMailboxInboundLimit(input.limit)
	const ids = sql
		.exec<{ id: string }>(
			`SELECT id FROM email_delivery_events
			WHERE provider = ? AND dedupe_expires_at <= ?
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
			mailboxInboundDedupeProvider,
			now,
			limit,
		)
		.toArray()
		.map((row) => String(row.id))
	const prunedEventIds: Array<string> = []
	for (const id of ids) {
		const cursor = sql.exec(
			`DELETE FROM email_delivery_events
			WHERE id = ? AND provider = ? AND dedupe_expires_at <= ?`,
			id,
			mailboxInboundDedupeProvider,
			now,
		)
		if (cursor.rowsWritten > 0) prunedEventIds.push(id)
	}
	return { pruned: prunedEventIds.length, prunedEventIds }
}

export function deferMailboxInboundDeliveryReconciliation(
	sql: SqlStorage,
	input: { deliveryId: string; now?: string },
): MailboxDeferInboundDeliveryReconcileResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current) return { status: 'missing' }
	if (current.state === 'received' || current.state === 'rejected') {
		return { status: 'not-applicable' }
	}
	const reconcileAfter = new Date(
		Date.parse(now) + mailboxInboundReconciliationRetryMs,
	).toISOString()
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		reconcileAfter,
		updatedAt: now,
	}
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?, reconcile_after = ?, updated_at = ?
		WHERE id = ? AND provider = ? AND event_type = 'receive_started'`,
		detailJsonFromMailboxInboundSnapshot(next),
		reconcileAfter,
		now,
		deliveryId,
		mailboxInboundProvider,
	)
	if (cursor.rowsWritten < 1) return { status: 'not-applicable' }
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!after) return { status: 'missing' }
	return { status: 'deferred', delivery: after }
}

export function listMailboxDueStaleInboundDeliveries(
	sql: SqlStorage,
	input: { now?: string; limit?: number },
): MailboxListDueStaleInboundDeliveriesResult {
	const now = normalizeMailboxInboundNow(input.now)
	const limit = normalizeMailboxInboundLimit(input.limit)
	const cutoff = new Date(
		Date.parse(now) - mailboxStaleInboundDeliveryAgeMs,
	).toISOString()
	const leaseExpiredBefore = new Date(
		Date.parse(now) - mailboxInboundStorageLeaseMs,
	).toISOString()
	const deliveries: Array<MailboxInboundDeliverySnapshot> = []
	for (const row of sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM email_delivery_events
			WHERE provider = ?
				AND event_type = 'receive_started'
				AND created_at < ?
				AND (reconcile_after IS NULL OR reconcile_after <= ?)
				AND (
					state = 'pending'
					OR (state = 'storing' AND storage_lease_at < ?)
					OR (state = 'cleaning' AND cleanup_lease_at < ?)
					OR (state = 'orphan-cleaned' AND cleanup_retry_at <= ?)
				)
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
			mailboxInboundProvider,
			cutoff,
			now,
			leaseExpiredBefore,
			leaseExpiredBefore,
			now,
			limit,
		)
		.toArray()) {
		const snapshot = snapshotFromMailboxDeliveryEventRow(
			mapMailboxDeliveryEventRow(row),
		)
		if (snapshot) deliveries.push(snapshot)
	}
	return { deliveries }
}

import { inboundSubscriptionEffectState } from './inbound-subscription-effect-state.ts'
/**
 * Mailbox USER inbound effect authority CAS primitives.
 *
 * Lease claim / complete / fail for usage and subscription effects. Does not
 * perform external usage recording or subscription dispatch — callers do that
 * after a successful claim. Part of the inbound ledger surface; see
 * `mailbox-inbound-ledger.ts`.
 */

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { assertMailboxNonEmptyString } from './mailbox-types.ts'
import { mapMailboxDeliveryEventRow } from './mailbox-mappers.ts'
import {
	assertMailboxInboundNonNegativeFiniteNumber,
	detailJsonFromMailboxInboundSnapshot,
	mailboxEffectRetryMs,
	mailboxInboundProvider,
	mailboxSubscriptionEffectLeaseMs,
	mailboxUsageEffectLeaseMs,
	needsMailboxEffectReconcile,
	normalizeMailboxInboundLimit,
	normalizeMailboxInboundNow,
	readMailboxInboundDeliveryById,
	resolveMailboxSubscriptionEffectFailure,
	snapshotFromMailboxDeliveryEventRow,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger.ts'

export type MailboxClaimInboundUsageEffectResult =
	| { status: 'claimed'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'already-complete'; delivery: MailboxInboundDeliverySnapshot }
	| {
			status: 'not-claimable'
			delivery: MailboxInboundDeliverySnapshot | null
	  }

export type MailboxCompleteInboundUsageEffectResult =
	| { status: 'recorded'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'suppressed'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'already-complete'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'lease-lost' }

export type MailboxClaimInboundSubscriptionEffectResult =
	| { status: 'claimed'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'already-complete'; delivery: MailboxInboundDeliverySnapshot }
	| {
			status: 'not-claimable'
			delivery: MailboxInboundDeliverySnapshot | null
	  }

export type MailboxCompleteInboundSubscriptionEffectResult =
	| { status: 'complete'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'suppressed'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'already-complete'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'lease-lost' }

export type MailboxFailInboundSubscriptionEffectResult =
	| { status: 'retry'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'dead-letter'; delivery: MailboxInboundDeliverySnapshot }
	| { status: 'lease-lost' }

export type MailboxListDueInboundEffectWorkResult = {
	deliveries: Array<MailboxInboundDeliverySnapshot>
}

export type MailboxInboundEffectLedgerRpc = {
	claimInboundUsageEffect: (input: {
		ownerId: OwnerId
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) => Promise<MailboxClaimInboundUsageEffectResult>
	completeInboundUsageEffect: (input: {
		ownerId: OwnerId
		deliveryId: string
		usageEffectLease: string
		/** Must match the delivery's current finalization token. */
		expectedFinalizationToken: string
		mode: 'recorded' | 'suppressed'
		usageMonth: string
		usageBytes: number
		usageDurationMs: number
		now?: string
	}) => Promise<MailboxCompleteInboundUsageEffectResult>
	claimInboundSubscriptionEffect: (input: {
		ownerId: OwnerId
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) => Promise<MailboxClaimInboundSubscriptionEffectResult>
	completeInboundSubscriptionEffect: (input: {
		ownerId: OwnerId
		deliveryId: string
		subscriptionEffectLease: string
		/** Must match the delivery's current finalization token. */
		expectedFinalizationToken: string
		mode: 'complete' | 'suppressed'
		suppressionReason?: string | null
		now?: string
	}) => Promise<MailboxCompleteInboundSubscriptionEffectResult>
	failInboundSubscriptionEffect: (input: {
		ownerId: OwnerId
		deliveryId: string
		subscriptionEffectLease: string
		/** Must match the delivery's current finalization token. */
		expectedFinalizationToken: string
		error: string
		now?: string
	}) => Promise<MailboxFailInboundSubscriptionEffectResult>
	listDueInboundEffectWork: (input: {
		ownerId: OwnerId
		now?: string
		limit?: number
	}) => Promise<MailboxListDueInboundEffectWorkResult>
}

const claimPendingEffectGuard = inboundSubscriptionEffectState.guard({
	from: 'pending',
	to: 'processing',
})
const reclaimProcessingEffectGuard = inboundSubscriptionEffectState.guard({
	from: 'processing',
	to: 'processing',
})

export function claimMailboxInboundUsageEffect(
	sql: SqlStorage,
	input: {
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	},
): MailboxClaimInboundUsageEffectResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current || current.state !== 'received') {
		return { status: 'not-claimable', delivery: current }
	}
	if (
		input.expectedFinalizationToken != null &&
		current.finalizationToken !== input.expectedFinalizationToken
	) {
		return { status: 'not-claimable', delivery: current }
	}
	if (
		current.usageEffectRecordedAt != null ||
		current.usageEffectSuppressedAt
	) {
		return { status: 'already-complete', delivery: current }
	}
	if (current.usageEffectRetryAt != null && current.usageEffectRetryAt > now) {
		return { status: 'not-claimable', delivery: current }
	}
	const expiredBefore = new Date(
		Date.parse(now) - mailboxUsageEffectLeaseMs,
	).toISOString()
	// Fresh lease only when lease+timestamp are both present and unexpired.
	// NULL lease_at (legacy/imported) is treated as expired/claimable.
	if (
		current.usageEffectLease != null &&
		current.usageEffectLeaseAt != null &&
		current.usageEffectLeaseAt >= expiredBefore
	) {
		return { status: 'not-claimable', delivery: current }
	}
	const usageEffectLease = crypto.randomUUID()
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		usageEffectLease,
		usageEffectLeaseAt: now,
		updatedAt: now,
	}
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			usage_effect_lease = ?,
			usage_effect_lease_at = ?,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND event_type = 'received'
			AND state = 'received'
			AND usage_effect_recorded_at IS NULL
			AND usage_effect_suppressed_at IS NULL
			AND (usage_effect_retry_at IS NULL OR usage_effect_retry_at <= ?)
			AND (
				usage_effect_lease IS NULL
				OR usage_effect_lease_at IS NULL
				OR usage_effect_lease_at < ?
			)
			AND (? IS NULL OR finalization_token = ?)`,
		detailJsonFromMailboxInboundSnapshot(next),
		usageEffectLease,
		now,
		now,
		deliveryId,
		mailboxInboundProvider,
		now,
		expiredBefore,
		input.expectedFinalizationToken ?? null,
		input.expectedFinalizationToken ?? null,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (cursor.rowsWritten > 0 && after?.usageEffectLease === usageEffectLease) {
		return { status: 'claimed', delivery: after }
	}
	if (after?.usageEffectRecordedAt || after?.usageEffectSuppressedAt) {
		return { status: 'already-complete', delivery: after }
	}
	return { status: 'not-claimable', delivery: after }
}

export function completeMailboxInboundUsageEffect(
	sql: SqlStorage,
	input: {
		deliveryId: string
		usageEffectLease: string
		expectedFinalizationToken: string
		mode: 'recorded' | 'suppressed'
		usageMonth: string
		usageBytes: number
		usageDurationMs: number
		now?: string
	},
): MailboxCompleteInboundUsageEffectResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const usageEffectLease = assertMailboxNonEmptyString(
		input.usageEffectLease,
		'usageEffectLease',
	)
	const expectedFinalizationToken = assertMailboxNonEmptyString(
		input.expectedFinalizationToken,
		'expectedFinalizationToken',
	)
	const usageMonth = assertMailboxNonEmptyString(input.usageMonth, 'usageMonth')
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current) return { status: 'lease-lost' }
	if (
		current.state !== 'received' ||
		current.finalizationToken !== expectedFinalizationToken
	) {
		return { status: 'lease-lost' }
	}
	if (current.usageEffectRecordedAt || current.usageEffectSuppressedAt) {
		return { status: 'already-complete', delivery: current }
	}
	if (current.usageEffectLease !== usageEffectLease) {
		return { status: 'lease-lost' }
	}
	const usageBytes = Math.round(
		assertMailboxInboundNonNegativeFiniteNumber(input.usageBytes, 'usageBytes'),
	)
	const usageDurationMs = Math.round(
		assertMailboxInboundNonNegativeFiniteNumber(
			input.usageDurationMs,
			'usageDurationMs',
		),
	)
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		usageMonth,
		usageBytes,
		usageDurationMs,
		updatedAt: now,
		...(input.mode === 'recorded'
			? { usageEffectRecordedAt: now }
			: { usageEffectSuppressedAt: now }),
	}
	delete next.usageEffectLease
	delete next.usageEffectLeaseAt
	delete next.usageEffectRetryAt
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			usage_effect_recorded_at = ?,
			usage_effect_suppressed_at = ?,
			usage_month = ?,
			usage_bytes = ?,
			usage_duration_ms = ?,
			usage_effect_lease = NULL,
			usage_effect_lease_at = NULL,
			usage_effect_retry_at = NULL,
			needs_effect_reconcile = ?,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND event_type = 'received'
			AND state = 'received'
			AND finalization_token = ?
			AND usage_effect_lease = ?
			AND usage_effect_recorded_at IS NULL
			AND usage_effect_suppressed_at IS NULL`,
		detailJsonFromMailboxInboundSnapshot(next),
		input.mode === 'recorded' ? now : null,
		input.mode === 'suppressed' ? now : null,
		usageMonth,
		usageBytes,
		usageDurationMs,
		needsMailboxEffectReconcile(next) ? 1 : 0,
		now,
		deliveryId,
		mailboxInboundProvider,
		expectedFinalizationToken,
		usageEffectLease,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!after) return { status: 'lease-lost' }
	if (
		cursor.rowsWritten > 0 &&
		input.mode === 'recorded' &&
		after.usageEffectRecordedAt
	) {
		return { status: 'recorded', delivery: after }
	}
	if (
		cursor.rowsWritten > 0 &&
		input.mode === 'suppressed' &&
		after.usageEffectSuppressedAt
	) {
		return { status: 'suppressed', delivery: after }
	}
	if (after.usageEffectRecordedAt || after.usageEffectSuppressedAt) {
		return { status: 'already-complete', delivery: after }
	}
	return { status: 'lease-lost' }
}

export function claimMailboxInboundSubscriptionEffect(
	sql: SqlStorage,
	input: {
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	},
): MailboxClaimInboundSubscriptionEffectResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current || current.state !== 'received') {
		return { status: 'not-claimable', delivery: current }
	}
	if (
		input.expectedFinalizationToken != null &&
		current.finalizationToken !== input.expectedFinalizationToken
	) {
		return { status: 'not-claimable', delivery: current }
	}
	if (
		current.subscriptionEffectState === 'complete' ||
		current.subscriptionEffectState === 'dead-letter'
	) {
		return { status: 'already-complete', delivery: current }
	}
	if (
		current.subscriptionEffectRetryAt != null &&
		current.subscriptionEffectRetryAt > now
	) {
		return { status: 'not-claimable', delivery: current }
	}
	const expiredBefore = new Date(
		Date.parse(now) - mailboxSubscriptionEffectLeaseMs,
	).toISOString()
	// processing + NULL lease_at (legacy/imported) is claimable/takeover.
	if (
		current.subscriptionEffectState === 'processing' &&
		current.subscriptionEffectLeaseAt != null &&
		current.subscriptionEffectLeaseAt >= expiredBefore
	) {
		return { status: 'not-claimable', delivery: current }
	}
	inboundSubscriptionEffectState.assert(
		current.subscriptionEffectState ?? 'pending',
		'processing',
	)
	const subscriptionEffectLease = crypto.randomUUID()
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		subscriptionEffectState: 'processing',
		subscriptionEffectLease,
		subscriptionEffectLeaseAt: now,
		updatedAt: now,
	}
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			subscription_effect_state = 'processing',
			subscription_effect_lease = ?,
			subscription_effect_lease_at = ?,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND event_type = 'received'
			AND state = 'received'
			AND (? IS NULL OR finalization_token = ?)
			AND (
				subscription_effect_retry_at IS NULL
				OR subscription_effect_retry_at <= ?
			)
			AND (
				subscription_effect_state IS NULL
				OR subscription_effect_state IN ${claimPendingEffectGuard}
				OR (
					subscription_effect_state IN ${reclaimProcessingEffectGuard}
					AND (
						subscription_effect_lease_at IS NULL
						OR subscription_effect_lease_at < ?
					)
				)
			)`,
		detailJsonFromMailboxInboundSnapshot(next),
		subscriptionEffectLease,
		now,
		now,
		deliveryId,
		mailboxInboundProvider,
		input.expectedFinalizationToken ?? null,
		input.expectedFinalizationToken ?? null,
		now,
		expiredBefore,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (
		cursor.rowsWritten > 0 &&
		after?.subscriptionEffectLease === subscriptionEffectLease
	) {
		return { status: 'claimed', delivery: after }
	}
	if (
		after?.subscriptionEffectState === 'complete' ||
		after?.subscriptionEffectState === 'dead-letter'
	) {
		return { status: 'already-complete', delivery: after }
	}
	return { status: 'not-claimable', delivery: after }
}

export function completeMailboxInboundSubscriptionEffect(
	sql: SqlStorage,
	input: {
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		mode: 'complete' | 'suppressed'
		suppressionReason?: string | null
		now?: string
	},
): MailboxCompleteInboundSubscriptionEffectResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const subscriptionEffectLease = assertMailboxNonEmptyString(
		input.subscriptionEffectLease,
		'subscriptionEffectLease',
	)
	const expectedFinalizationToken = assertMailboxNonEmptyString(
		input.expectedFinalizationToken,
		'expectedFinalizationToken',
	)
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current) return { status: 'lease-lost' }
	if (
		current.state !== 'received' ||
		current.finalizationToken !== expectedFinalizationToken
	) {
		return { status: 'lease-lost' }
	}
	if (
		current.subscriptionEffectState === 'complete' ||
		current.subscriptionEffectState === 'dead-letter'
	) {
		return { status: 'already-complete', delivery: current }
	}
	if (current.subscriptionEffectLease !== subscriptionEffectLease) {
		return { status: 'lease-lost' }
	}
	const extra =
		input.mode === 'suppressed'
			? {
					subscriptionEffectSuppressedAt: now,
					...(input.suppressionReason
						? { suppressionReason: input.suppressionReason }
						: {}),
				}
			: undefined
	inboundSubscriptionEffectState.assert(
		current.subscriptionEffectState ?? 'pending',
		'complete',
	)
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		subscriptionEffectState: 'complete',
		updatedAt: now,
	}
	delete next.subscriptionEffectLease
	delete next.subscriptionEffectLeaseAt
	delete next.subscriptionEffectRetryAt
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			subscription_effect_state = 'complete',
			subscription_effect_lease = NULL,
			subscription_effect_lease_at = NULL,
			subscription_effect_retry_at = NULL,
			needs_effect_reconcile = ?,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND event_type = 'received'
			AND state = 'received'
			AND finalization_token = ?
			AND subscription_effect_lease = ?`,
		detailJsonFromMailboxInboundSnapshot(next, extra),
		needsMailboxEffectReconcile(next) ? 1 : 0,
		now,
		deliveryId,
		mailboxInboundProvider,
		expectedFinalizationToken,
		subscriptionEffectLease,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (cursor.rowsWritten > 0 && after?.subscriptionEffectState === 'complete') {
		return {
			status: input.mode === 'suppressed' ? 'suppressed' : 'complete',
			delivery: after,
		}
	}
	if (
		after?.subscriptionEffectState === 'complete' ||
		after?.subscriptionEffectState === 'dead-letter'
	) {
		return { status: 'already-complete', delivery: after }
	}
	return { status: 'lease-lost' }
}

export function failMailboxInboundSubscriptionEffect(
	sql: SqlStorage,
	input: {
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		error: string
		now?: string
	},
): MailboxFailInboundSubscriptionEffectResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const subscriptionEffectLease = assertMailboxNonEmptyString(
		input.subscriptionEffectLease,
		'subscriptionEffectLease',
	)
	const expectedFinalizationToken = assertMailboxNonEmptyString(
		input.expectedFinalizationToken,
		'expectedFinalizationToken',
	)
	const error = assertMailboxNonEmptyString(input.error, 'error')
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (
		!current ||
		current.state !== 'received' ||
		current.finalizationToken !== expectedFinalizationToken ||
		current.subscriptionEffectLease !== subscriptionEffectLease
	) {
		return { status: 'lease-lost' }
	}
	const failure = resolveMailboxSubscriptionEffectFailure(
		current.subscriptionEffectAttemptCount ?? 0,
	)
	inboundSubscriptionEffectState.assert(
		current.subscriptionEffectState ?? 'pending',
		failure.deadLettered ? 'dead-letter' : 'pending',
	)
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		subscriptionEffectState: failure.deadLettered ? 'dead-letter' : 'pending',
		subscriptionEffectAttemptCount: failure.attemptCount,
		subscriptionEffectLastError: error,
		...(failure.deadLettered
			? { subscriptionEffectDeadLetterAt: now }
			: {
					subscriptionEffectRetryAt: new Date(
						Date.parse(now) + mailboxEffectRetryMs,
					).toISOString(),
				}),
		updatedAt: now,
	}
	delete next.subscriptionEffectLease
	delete next.subscriptionEffectLeaseAt
	if (failure.deadLettered) delete next.subscriptionEffectRetryAt
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			subscription_effect_state = ?,
			subscription_effect_lease = NULL,
			subscription_effect_lease_at = NULL,
			subscription_effect_retry_at = ?,
			subscription_effect_attempt_count = ?,
			subscription_effect_dead_letter_at = ?,
			subscription_effect_last_error = ?,
			needs_effect_reconcile = ?,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND event_type = 'received'
			AND state = 'received'
			AND finalization_token = ?
			AND subscription_effect_lease = ?`,
		detailJsonFromMailboxInboundSnapshot(next),
		next.subscriptionEffectState ?? 'pending',
		next.subscriptionEffectRetryAt ?? null,
		failure.attemptCount,
		next.subscriptionEffectDeadLetterAt ?? null,
		error,
		needsMailboxEffectReconcile(next) ? 1 : 0,
		now,
		deliveryId,
		mailboxInboundProvider,
		expectedFinalizationToken,
		subscriptionEffectLease,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (cursor.rowsWritten < 1 || !after) return { status: 'lease-lost' }
	if (after.subscriptionEffectState === 'dead-letter') {
		return { status: 'dead-letter', delivery: after }
	}
	if (after.subscriptionEffectState === 'pending') {
		return { status: 'retry', delivery: after }
	}
	return { status: 'lease-lost' }
}

export function listMailboxDueInboundEffectWork(
	sql: SqlStorage,
	input: { now?: string; limit?: number },
): MailboxListDueInboundEffectWorkResult {
	const now = normalizeMailboxInboundNow(input.now)
	const limit = normalizeMailboxInboundLimit(input.limit)
	const usageLeaseExpiredBefore = new Date(
		Date.parse(now) - mailboxUsageEffectLeaseMs,
	).toISOString()
	const subscriptionLeaseExpiredBefore = new Date(
		Date.parse(now) - mailboxSubscriptionEffectLeaseMs,
	).toISOString()
	const deliveries: Array<MailboxInboundDeliverySnapshot> = []
	for (const row of sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM email_delivery_events
			WHERE provider = ?
				AND event_type = 'received'
				AND needs_effect_reconcile = 1
				AND fingerprint IS NOT NULL
				AND (
					(
						usage_effect_recorded_at IS NULL
						AND usage_effect_suppressed_at IS NULL
						AND (
							usage_effect_retry_at IS NULL
							OR usage_effect_retry_at <= ?
						)
						AND (
							usage_effect_lease IS NULL
							OR usage_effect_lease_at IS NULL
							OR usage_effect_lease_at < ?
						)
					)
					OR (
						(
							subscription_effect_state IS NULL
							OR subscription_effect_state NOT IN ('complete', 'dead-letter')
						)
						AND (
							subscription_effect_retry_at IS NULL
							OR subscription_effect_retry_at <= ?
						)
						AND (
							subscription_effect_state IS NULL
							OR subscription_effect_state != 'processing'
							OR subscription_effect_lease_at IS NULL
							OR subscription_effect_lease_at < ?
						)
					)
				)
			ORDER BY COALESCE(
				usage_effect_retry_at,
				subscription_effect_retry_at,
				created_at
			) ASC, id ASC
			LIMIT ?`,
			mailboxInboundProvider,
			now,
			usageLeaseExpiredBefore,
			now,
			subscriptionLeaseExpiredBefore,
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

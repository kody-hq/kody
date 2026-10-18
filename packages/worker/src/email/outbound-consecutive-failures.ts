/**
 * Auto-pause user/agent outbound mail after N consecutive terminal delivery
 * failures. Distinct from the abuse pause (spam complaints / bounce burst):
 * owners can resume this pause from account email settings.
 *
 * Counting is keyed by Cloudflare `provider_event_id` in
 * `email_outbound_failure_tracking`, separate from provider-event insert
 * idempotency. A queue retry after a mid-flight crash can still apply the
 * count exactly once.
 */

import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { type EmailDeliveryStatus } from './types.ts'

export const outboundConsecutiveFailurePauseThreshold = 5

export const emailOutboundDeliveryPausedMessage =
	'Outbound email is paused after repeated delivery failures. Resume sending from Account → Email once the destination can receive mail from kody.codes again.'

const terminalFailureStatuses = new Set<EmailDeliveryStatus>([
	'bounced',
	'failed',
	'rejected',
	'complained',
])

async function ensurePendingFailureTracking(input: {
	db: D1Database
	providerEventId: string
	ownerId: OwnerId
	deliveryStatus: EmailDeliveryStatus
	nowIso: string
}): Promise<'pending' | 'applied'> {
	await input.db
		.prepare(
			`INSERT OR IGNORE INTO email_outbound_failure_tracking (
				provider_event_id, user_id, delivery_status, created_at, applied_at
			) VALUES (?, ?, ?, ?, NULL)`,
		)
		.bind(
			input.providerEventId,
			input.ownerId,
			input.deliveryStatus,
			input.nowIso,
		)
		.run()
	const row = await input.db
		.prepare(
			`SELECT applied_at AS appliedAt
			 FROM email_outbound_failure_tracking
			 WHERE provider_event_id = ?`,
		)
		.bind(input.providerEventId)
		.first<{ appliedAt: string | null }>()
	return row?.appliedAt == null ? 'pending' : 'applied'
}

/**
 * Idempotent pause write. Safe on retries: only transitions NULL → set when
 * the consecutive-failure count is still at the threshold.
 */
async function maybePauseOutboundDelivery(input: {
	db: D1Database
	ownerId: OwnerId
	deliveryStatus: EmailDeliveryStatus
	nowIso: string
	consecutiveFailures: number
}): Promise<boolean> {
	if (input.consecutiveFailures < outboundConsecutiveFailurePauseThreshold) {
		return false
	}
	const pause = await input.db
		.prepare(
			`UPDATE orgs
			 SET email_outbound_delivery_paused_at = ?,
			     updated_at = ?
			 WHERE id = ?
			   AND email_outbound_delivery_paused_at IS NULL
			   AND email_outbound_consecutive_failures >= ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.nowIso,
			input.nowIso,
			input.ownerId,
			outboundConsecutiveFailurePauseThreshold,
		)
		.run()
	const paused = Number(pause.meta.changes ?? 0) > 0
	if (paused) {
		console.warn('email-outbound-delivery-paused', {
			consecutiveFailures: input.consecutiveFailures,
			deliveryStatus: input.deliveryStatus,
		})
	}
	return paused
}

function pauseStatement(input: {
	db: D1Database
	ownerId: OwnerId
	nowIso: string
}) {
	return input.db
		.prepare(
			`UPDATE orgs
			 SET email_outbound_delivery_paused_at = ?,
			     updated_at = ?
			 WHERE id = ?
			   AND email_outbound_delivery_paused_at IS NULL
			   AND email_outbound_consecutive_failures >= ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.nowIso,
			input.nowIso,
			input.ownerId,
			outboundConsecutiveFailurePauseThreshold,
		)
}

function isSupersededDeliveryEvent(input: {
	eventTimestamp: string
	messageDeliveryStatusAt: string | null | undefined
}) {
	const messageAt = input.messageDeliveryStatusAt
	if (messageAt == null || messageAt === '') return false
	// ISO-8601 UTC strings compare lexicographically. A message status
	// strictly newer than this provider event means a later lifecycle
	// event already won; do not mutate the consecutive-failure counter.
	return messageAt > input.eventTimestamp
}

async function markFailureTrackingApplied(input: {
	db: D1Database
	providerEventId: string
	nowIso: string
}) {
	await input.db
		.prepare(
			`UPDATE email_outbound_failure_tracking
			 SET applied_at = ?
			 WHERE provider_event_id = ? AND applied_at IS NULL`,
		)
		.bind(input.nowIso, input.providerEventId)
		.run()
}

export async function applyOutboundConsecutiveFailureTracking(input: {
	db: D1Database
	/** Personal-org / mailbox owner id (orgs.id). */
	ownerId: OwnerId
	deliveryStatus: EmailDeliveryStatus
	/**
	 * Cloudflare provider event id. Dedupes consecutive-failure counting
	 * separately from provider-event insert idempotency so a queue retry
	 * after a mid-flight tracking crash still counts the failure once.
	 */
	providerEventId: string
	/** Provider event timestamp (Cloudflare metadata.eventTimestamp). */
	eventTimestamp: string
	/**
	 * Latest delivery status timestamp already on the outbound message.
	 * When this is strictly newer than `eventTimestamp`, drain a pending
	 * ledger row without changing the consecutive-failure counter.
	 */
	messageDeliveryStatusAt?: string | null
	now?: Date
}): Promise<{ paused: boolean; consecutiveFailures: number }> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()

	const pending = await ensurePendingFailureTracking({
		db: input.db,
		providerEventId: input.providerEventId,
		ownerId: input.ownerId,
		deliveryStatus: input.deliveryStatus,
		nowIso,
	})
	if (
		pending === 'pending' &&
		isSupersededDeliveryEvent({
			eventTimestamp: input.eventTimestamp,
			messageDeliveryStatusAt: input.messageDeliveryStatusAt,
		})
	) {
		await markFailureTrackingApplied({
			db: input.db,
			providerEventId: input.providerEventId,
			nowIso,
		})
		const current = await loadOutboundDeliveryPause({
			db: input.db,
			ownerId: input.ownerId,
		})
		return {
			paused: Boolean(current?.pausedAt),
			consecutiveFailures: current?.consecutiveFailures ?? 0,
		}
	}
	if (pending === 'applied') {
		// Count already landed. Still attempt the pause write so a crash
		// between the applied batch and a later pause statement cannot leave
		// the org at threshold without email_outbound_delivery_paused_at.
		const current = await loadOutboundDeliveryPause({
			db: input.db,
			ownerId: input.ownerId,
		})
		const consecutiveFailures = current?.consecutiveFailures ?? 0
		if (current?.pausedAt) {
			return { paused: true, consecutiveFailures }
		}
		if (
			terminalFailureStatuses.has(input.deliveryStatus) &&
			consecutiveFailures >= outboundConsecutiveFailurePauseThreshold
		) {
			const paused = await maybePauseOutboundDelivery({
				db: input.db,
				ownerId: input.ownerId,
				deliveryStatus: input.deliveryStatus,
				nowIso,
				consecutiveFailures,
			})
			return { paused, consecutiveFailures }
		}
		return { paused: false, consecutiveFailures }
	}

	if (input.deliveryStatus === 'delivered') {
		// Reset + mark applied in one D1 batch so a crash leaves the row
		// pending and a retry can still clear the counter.
		await input.db.batch([
			input.db
				.prepare(
					`UPDATE orgs
					 SET email_outbound_consecutive_failures = 0,
					     updated_at = ?
					 WHERE id = ?
					   AND EXISTS (
					     SELECT 1 FROM email_outbound_failure_tracking
					     WHERE provider_event_id = ? AND applied_at IS NULL
					   )${andLiveDeletedAtSql()}`,
				)
				.bind(nowIso, input.ownerId, input.providerEventId),
			input.db
				.prepare(
					`UPDATE email_outbound_failure_tracking
					 SET applied_at = ?
					 WHERE provider_event_id = ? AND applied_at IS NULL`,
				)
				.bind(nowIso, input.providerEventId),
		])
		return { paused: false, consecutiveFailures: 0 }
	}

	if (!terminalFailureStatuses.has(input.deliveryStatus)) {
		await input.db
			.prepare(
				`UPDATE email_outbound_failure_tracking
				 SET applied_at = ?
				 WHERE provider_event_id = ? AND applied_at IS NULL`,
			)
			.bind(nowIso, input.providerEventId)
			.run()
		const current = await loadOutboundDeliveryPause({
			db: input.db,
			ownerId: input.ownerId,
		})
		return {
			paused: Boolean(current?.pausedAt),
			consecutiveFailures: current?.consecutiveFailures ?? 0,
		}
	}

	const before = await loadOutboundDeliveryPause({
		db: input.db,
		ownerId: input.ownerId,
	})

	// Increment, mark applied, and pause (when at threshold) in one batch so
	// a crash cannot leave applied_at set while skipping the pause write.
	await input.db.batch([
		input.db
			.prepare(
				`UPDATE orgs
				 SET email_outbound_consecutive_failures =
				       email_outbound_consecutive_failures + 1,
				     updated_at = ?
				 WHERE id = ?
				   AND EXISTS (
				     SELECT 1 FROM email_outbound_failure_tracking
				     WHERE provider_event_id = ? AND applied_at IS NULL
				   )${andLiveDeletedAtSql()}`,
			)
			.bind(nowIso, input.ownerId, input.providerEventId),
		input.db
			.prepare(
				`UPDATE email_outbound_failure_tracking
				 SET applied_at = ?
				 WHERE provider_event_id = ? AND applied_at IS NULL`,
			)
			.bind(nowIso, input.providerEventId),
		pauseStatement({ db: input.db, ownerId: input.ownerId, nowIso }),
	])

	const after = await loadOutboundDeliveryPause({
		db: input.db,
		ownerId: input.ownerId,
	})
	const nextCount = after?.consecutiveFailures ?? 0
	const paused = Boolean(after?.pausedAt)
	if (paused && !before?.pausedAt) {
		console.warn('email-outbound-delivery-paused', {
			consecutiveFailures: nextCount,
			deliveryStatus: input.deliveryStatus,
		})
	}
	return { paused, consecutiveFailures: nextCount }
}

export async function clearOutboundDeliveryPause(input: {
	db: D1Database
	ownerId: OwnerId
	now?: Date
}): Promise<boolean> {
	const nowIso = (input.now ?? new Date()).toISOString()
	const result = await input.db
		.prepare(
			`UPDATE orgs
			 SET email_outbound_delivery_paused_at = NULL,
			     email_outbound_consecutive_failures = 0,
			     updated_at = ?
			 WHERE id = ? AND email_outbound_delivery_paused_at IS NOT NULL${andLiveDeletedAtSql()}`,
		)
		.bind(nowIso, input.ownerId)
		.run()
	return Number(result.meta.changes ?? 0) > 0
}

export async function loadOutboundDeliveryPause(input: {
	db: D1Database
	ownerId: OwnerId
}): Promise<{
	pausedAt: string | null
	consecutiveFailures: number
} | null> {
	const row = await input.db
		.prepare(
			`SELECT email_outbound_delivery_paused_at, email_outbound_consecutive_failures
			 FROM orgs
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.ownerId)
		.first<{
			email_outbound_delivery_paused_at: string | null
			email_outbound_consecutive_failures: number
		}>()
	if (!row) return null
	return {
		pausedAt: row.email_outbound_delivery_paused_at,
		consecutiveFailures: Number(row.email_outbound_consecutive_failures ?? 0),
	}
}

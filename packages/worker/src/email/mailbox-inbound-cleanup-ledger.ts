import { sqlSourcesOf, nextState } from '@kody-internal/shared/state-machine.ts'
import { inboundDeliveryState } from './inbound-delivery-state.ts'
import {
	assertMailboxCanonicalIsoTimestamp,
	assertMailboxInboundDeliveryState,
	assertMailboxNonEmptyString,
	type MailboxInboundDeliveryState,
} from './mailbox-types.ts'
import {
	detailJsonFromMailboxInboundSnapshot,
	mailboxInboundProvider,
	mailboxInboundReconciliationRetryMs,
	mailboxInboundStorageLeaseMs,
	normalizeMailboxInboundNow,
	readMailboxInboundDeliveryById,
	type MailboxClaimInboundDeliveryCleanupResult,
	type MailboxInboundDeliverySnapshot,
	type MailboxMarkInboundDeliveryOrphanCleanedResult,
	type MailboxReleaseInboundDeliveryCleanupResult,
} from './mailbox-inbound-ledger.ts'
import { mailboxInboundOrphanVerificationMs } from './mailbox-inbound-ledger-shared.ts'

const deliveryCleaningToPendingGuard = sqlSourcesOf(
	inboundDeliveryState,
	'RELEASE_LEASE',
	['cleaning'],
)
const deliveryPendingToCleaningGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_CLEANUP',
	['pending'],
)
const deliveryStoringToCleaningGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_CLEANUP',
	['storing'],
)
const deliveryCleaningToCleaningGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_CLEANUP',
	['cleaning'],
)
const deliveryOrphanCleanedToCleaningGuard = sqlSourcesOf(
	inboundDeliveryState,
	'CLAIM_CLEANUP',
	['orphan-cleaned'],
)
const deliveryCleaningToOrphanCleanedGuard = sqlSourcesOf(
	inboundDeliveryState,
	'COMPLETE_CLEANUP',
	['cleaning'],
)

export function claimMailboxInboundDeliveryCleanup(
	sql: SqlStorage,
	input: {
		deliveryId: string
		expectedState: MailboxInboundDeliveryState
		expectedUpdatedAt: string
		staleBefore: string
		now?: string
	},
): MailboxClaimInboundDeliveryCleanupResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const expectedState = assertMailboxInboundDeliveryState(input.expectedState)
	const expectedUpdatedAt = assertMailboxCanonicalIsoTimestamp(
		input.expectedUpdatedAt,
		'expectedUpdatedAt',
	)
	const staleBefore = assertMailboxCanonicalIsoTimestamp(
		input.staleBefore,
		'staleBefore',
	)
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (!current) return { status: 'not-claimed', delivery: null }
	const leaseExpiredBefore = new Date(
		Date.parse(now) - mailboxInboundStorageLeaseMs,
	).toISOString()
	const claimable =
		current.state === expectedState &&
		current.updatedAt === expectedUpdatedAt &&
		current.createdAt < staleBefore &&
		(current.reconcileAfter == null || current.reconcileAfter <= now) &&
		(current.state === 'pending' ||
			(current.state === 'storing' &&
				current.storageLeaseAt != null &&
				current.storageLeaseAt < leaseExpiredBefore) ||
			(current.state === 'cleaning' &&
				current.cleanupLeaseAt != null &&
				current.cleanupLeaseAt < leaseExpiredBefore) ||
			(current.state === 'orphan-cleaned' &&
				current.cleanupRetryAt != null &&
				current.cleanupRetryAt <= now))
	if (!claimable) return { status: 'not-claimed', delivery: current }

	const cleanupLease = crypto.randomUUID()
	nextState(inboundDeliveryState, current.state, { type: 'CLAIM_CLEANUP' })
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		state: 'cleaning',
		cleanupLease,
		cleanupLeaseAt: now,
		updatedAt: now,
	}
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			state = 'cleaning',
			cleanup_lease = ?,
			cleanup_lease_at = ?,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND state = ?
			AND updated_at = ?
			AND created_at < ?
			AND (reconcile_after IS NULL OR reconcile_after <= ?)
			AND (
				state IN ${deliveryPendingToCleaningGuard}
				OR (state IN ${deliveryStoringToCleaningGuard} AND storage_lease_at < ?)
				OR (state IN ${deliveryCleaningToCleaningGuard} AND cleanup_lease_at < ?)
				OR (state IN ${deliveryOrphanCleanedToCleaningGuard} AND cleanup_retry_at <= ?)
			)`,
		detailJsonFromMailboxInboundSnapshot(next),
		cleanupLease,
		now,
		now,
		deliveryId,
		mailboxInboundProvider,
		expectedState,
		expectedUpdatedAt,
		staleBefore,
		now,
		leaseExpiredBefore,
		leaseExpiredBefore,
		now,
	)
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	if (
		cursor.rowsWritten > 0 &&
		after?.state === 'cleaning' &&
		after.cleanupLease === cleanupLease
	) {
		return { status: 'claimed', delivery: after }
	}
	return { status: 'not-claimed', delivery: after }
}

export function releaseMailboxInboundDeliveryCleanup(
	sql: SqlStorage,
	input: {
		deliveryId: string
		cleanupLease: string
		now?: string
	},
): MailboxReleaseInboundDeliveryCleanupResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const cleanupLease = assertMailboxNonEmptyString(
		input.cleanupLease,
		'cleanupLease',
	)
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (
		!current ||
		current.state !== 'cleaning' ||
		current.cleanupLease !== cleanupLease
	) {
		return { status: 'not-held' }
	}
	nextState(inboundDeliveryState, current.state, { type: 'RELEASE_LEASE' })
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		state: 'pending',
		updatedAt: now,
	}
	delete next.cleanupLease
	delete next.cleanupLeaseAt
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			state = 'pending',
			cleanup_lease = NULL,
			cleanup_lease_at = NULL,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND state IN ${deliveryCleaningToPendingGuard}
			AND cleanup_lease = ?`,
		detailJsonFromMailboxInboundSnapshot(next),
		now,
		deliveryId,
		mailboxInboundProvider,
		cleanupLease,
	)
	if (cursor.rowsWritten < 1) return { status: 'not-held' }
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	return after
		? { status: 'released', delivery: after }
		: { status: 'not-held' }
}

export function markMailboxInboundDeliveryOrphanCleaned(
	sql: SqlStorage,
	input: {
		deliveryId: string
		cleanupLease: string
		outcome: 'deleted' | 'delete-failed'
		now?: string
	},
): MailboxMarkInboundDeliveryOrphanCleanedResult {
	const now = normalizeMailboxInboundNow(input.now)
	const deliveryId = assertMailboxNonEmptyString(input.deliveryId, 'deliveryId')
	const cleanupLease = assertMailboxNonEmptyString(
		input.cleanupLease,
		'cleanupLease',
	)
	const current = readMailboxInboundDeliveryById(sql, deliveryId)
	if (
		!current ||
		current.state !== 'cleaning' ||
		current.cleanupLease !== cleanupLease
	) {
		return { status: 'lease-lost' }
	}
	const retryDelayMs =
		input.outcome === 'deleted'
			? mailboxInboundOrphanVerificationMs
			: mailboxInboundReconciliationRetryMs
	nextState(inboundDeliveryState, current.state, { type: 'COMPLETE_CLEANUP' })
	const next: MailboxInboundDeliverySnapshot = {
		...current,
		state: 'orphan-cleaned',
		cleanupRetryAt: new Date(Date.parse(now) + retryDelayMs).toISOString(),
		updatedAt: now,
	}
	delete next.cleanupLease
	delete next.cleanupLeaseAt
	const cursor = sql.exec(
		`UPDATE email_delivery_events
		SET detail_json = ?,
			state = 'orphan-cleaned',
			cleanup_lease = NULL,
			cleanup_lease_at = NULL,
			cleanup_retry_at = ?,
			updated_at = ?
		WHERE id = ?
			AND provider = ?
			AND state IN ${deliveryCleaningToOrphanCleanedGuard}
			AND cleanup_lease = ?`,
		detailJsonFromMailboxInboundSnapshot(next),
		next.cleanupRetryAt,
		now,
		deliveryId,
		mailboxInboundProvider,
		cleanupLease,
	)
	if (cursor.rowsWritten < 1) return { status: 'lease-lost' }
	const after = readMailboxInboundDeliveryById(sql, deliveryId)
	return after
		? { status: 'orphan-cleaned', delivery: after }
		: { status: 'lease-lost' }
}

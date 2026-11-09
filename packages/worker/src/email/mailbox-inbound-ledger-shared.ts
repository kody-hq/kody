import { isState } from '@kody-internal/shared/state-machine.ts'
/**
 * Shared snapshot / detail helpers and constants for Mailbox inbound authority.
 */

import { inboundDeliveryState } from './inbound-delivery-state.ts'
import { inboundSubscriptionEffectState } from './inbound-subscription-effect-state.ts'
import { mapMailboxDeliveryEventRow } from './mailbox-mappers.ts'
import {
	assertMailboxCanonicalIsoTimestamp,
	mailboxNowIso,
	type MailboxDeliveryEventRecord,
	type MailboxInboundDeliveryState,
	type MailboxSubscriptionEffectState,
} from './mailbox-types.ts'

export const mailboxInboundProvider = 'cloudflare-email-routing'
export const mailboxInboundDedupeProvider = 'cloudflare-email-routing-dedupe'
export const mailboxInboundStorageLeaseMs = 5 * 60 * 1000
export const mailboxInboundReconciliationRetryMs = 15 * 60 * 1000
export const mailboxInboundOrphanVerificationMs = 60 * 60 * 1000
export const mailboxInboundDeliveryDedupeWindowMs = 48 * 60 * 60 * 1000
export const mailboxStaleInboundDeliveryAgeMs = 48 * 60 * 60 * 1000
export const mailboxUsageEffectLeaseMs = 5 * 60 * 1000
export const mailboxSubscriptionEffectLeaseMs = 5 * 60 * 1000
export const mailboxEffectRetryMs = 15 * 60 * 1000
export const mailboxMaxSubscriptionEffectAttempts = 3
export const mailboxInboundDueWorkDefaultLimit = 20

/** Inbound delivery identity and Mailbox CAS fields. */
export type MailboxInboundDeliverySnapshot = {
	fingerprint: string
	deliveryId: string
	messageId: string
	threadId: string
	rawMimeKey: string
	inboxId: string
	recipient: string
	envelopeFrom: string
	provider: string
	quotaDay: string
	dedupeExpiresAt: string
	state: MailboxInboundDeliveryState
	rejectionReason?: string
	storageLease?: string
	storageLeaseAt?: string
	expectedAttachmentCount?: number
	cleanupLease?: string
	cleanupLeaseAt?: string
	cleanupRetryAt?: string
	finalizationToken?: string
	reconcileAfter?: string
	usageEffectRecordedAt?: string
	usageEffectSuppressedAt?: string
	usageStartedAt?: string
	usageDurationMs?: number
	usageMonth?: string
	usageBytes?: number
	usageEffectRetryAt?: string
	usageEffectLease?: string
	usageEffectLeaseAt?: string
	subscriptionEffectState?: MailboxSubscriptionEffectState
	subscriptionEffectLease?: string
	subscriptionEffectLeaseAt?: string
	subscriptionEffectRetryAt?: string
	subscriptionEffectAttemptCount?: number
	subscriptionEffectDeadLetterAt?: string
	subscriptionEffectLastError?: string
	createdAt: string
	updatedAt: string
}

export function optionalDetailString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function optionalDetailNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseMailboxInboundDetail(
	detailJson: string,
): Record<string, unknown> {
	try {
		const parsed = JSON.parse(detailJson) as unknown
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>
		}
	} catch {
		// Fall through.
	}
	return {}
}

function assignOpt<T extends object>(
	target: T,
	key: keyof MailboxInboundDeliverySnapshot,
	value: string | number | undefined,
): void {
	if (value !== undefined) {
		;(target as Record<string, unknown>)[key as string] = value
	}
}

export function snapshotFromMailboxDeliveryEventRow(
	row: MailboxDeliveryEventRecord,
): MailboxInboundDeliverySnapshot | null {
	const detail = parseMailboxInboundDetail(row.detailJson)
	const fingerprint =
		row.fingerprint ?? optionalDetailString(detail['fingerprint'])
	const messageId =
		optionalDetailString(detail['messageId']) ?? row.messageId ?? undefined
	const threadId = optionalDetailString(detail['threadId'])
	const rawMimeKey = optionalDetailString(detail['rawMimeKey'])
	const inboxId =
		optionalDetailString(detail['inboxId']) ?? row.inboxId ?? undefined
	const recipient = optionalDetailString(detail['recipient'])
	const envelopeFrom =
		typeof detail['envelopeFrom'] === 'string'
			? detail['envelopeFrom']
			: undefined
	const quotaDay = optionalDetailString(detail['quotaDay'])
	const dedupeExpiresAt =
		row.dedupeExpiresAt ?? optionalDetailString(detail['dedupeExpiresAt'])
	if (
		!fingerprint ||
		!messageId ||
		!threadId ||
		!rawMimeKey ||
		!inboxId ||
		!recipient ||
		envelopeFrom === undefined ||
		!quotaDay ||
		!dedupeExpiresAt
	) {
		return null
	}
	const detailState = detail['state']
	const state: MailboxInboundDeliveryState =
		row.state ??
		(isState(inboundDeliveryState, detailState) ? detailState : 'pending')
	const detailSub = detail['subscriptionEffectState']
	const subscriptionEffectState =
		row.subscriptionEffectState ??
		(isState(inboundSubscriptionEffectState, detailSub) ? detailSub : undefined)
	const snapshot: MailboxInboundDeliverySnapshot = {
		fingerprint,
		deliveryId: optionalDetailString(detail['deliveryId']) ?? row.id,
		messageId,
		threadId,
		rawMimeKey,
		inboxId,
		recipient,
		envelopeFrom,
		provider:
			optionalDetailString(detail['provider']) ??
			row.provider ??
			mailboxInboundProvider,
		quotaDay,
		dedupeExpiresAt,
		state,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
	assignOpt(
		snapshot,
		'rejectionReason',
		optionalDetailString(detail['rejectionReason']),
	)
	assignOpt(
		snapshot,
		'storageLease',
		row.storageLease ?? optionalDetailString(detail['storageLease']),
	)
	assignOpt(
		snapshot,
		'storageLeaseAt',
		row.storageLeaseAt ?? optionalDetailString(detail['storageLeaseAt']),
	)
	assignOpt(
		snapshot,
		'expectedAttachmentCount',
		row.expectedAttachmentCount ??
			optionalDetailNumber(detail['expectedAttachmentCount']),
	)
	assignOpt(
		snapshot,
		'cleanupLease',
		row.cleanupLease ?? optionalDetailString(detail['cleanupLease']),
	)
	assignOpt(
		snapshot,
		'cleanupLeaseAt',
		row.cleanupLeaseAt ?? optionalDetailString(detail['cleanupLeaseAt']),
	)
	assignOpt(
		snapshot,
		'cleanupRetryAt',
		row.cleanupRetryAt ?? optionalDetailString(detail['cleanupRetryAt']),
	)
	assignOpt(
		snapshot,
		'finalizationToken',
		row.finalizationToken ?? optionalDetailString(detail['finalizationToken']),
	)
	assignOpt(
		snapshot,
		'reconcileAfter',
		row.reconcileAfter ?? optionalDetailString(detail['reconcileAfter']),
	)
	assignOpt(
		snapshot,
		'usageEffectRecordedAt',
		row.usageEffectRecordedAt ??
			optionalDetailString(detail['usageEffectRecordedAt']),
	)
	assignOpt(
		snapshot,
		'usageEffectSuppressedAt',
		row.usageEffectSuppressedAt ??
			optionalDetailString(detail['usageEffectSuppressedAt']),
	)
	assignOpt(
		snapshot,
		'usageStartedAt',
		row.usageStartedAt ?? optionalDetailString(detail['usageStartedAt']),
	)
	assignOpt(
		snapshot,
		'usageDurationMs',
		row.usageDurationMs ?? optionalDetailNumber(detail['usageDurationMs']),
	)
	assignOpt(
		snapshot,
		'usageMonth',
		row.usageMonth ?? optionalDetailString(detail['usageMonth']),
	)
	assignOpt(
		snapshot,
		'usageBytes',
		row.usageBytes ?? optionalDetailNumber(detail['usageBytes']),
	)
	assignOpt(
		snapshot,
		'usageEffectRetryAt',
		row.usageEffectRetryAt ??
			optionalDetailString(detail['usageEffectRetryAt']),
	)
	assignOpt(
		snapshot,
		'usageEffectLease',
		row.usageEffectLease ?? optionalDetailString(detail['usageEffectLease']),
	)
	assignOpt(
		snapshot,
		'usageEffectLeaseAt',
		row.usageEffectLeaseAt ??
			optionalDetailString(detail['usageEffectLeaseAt']),
	)
	if (subscriptionEffectState) {
		snapshot.subscriptionEffectState = subscriptionEffectState
	}
	assignOpt(
		snapshot,
		'subscriptionEffectLease',
		row.subscriptionEffectLease ??
			optionalDetailString(detail['subscriptionEffectLease']),
	)
	assignOpt(
		snapshot,
		'subscriptionEffectLeaseAt',
		row.subscriptionEffectLeaseAt ??
			optionalDetailString(detail['subscriptionEffectLeaseAt']),
	)
	assignOpt(
		snapshot,
		'subscriptionEffectRetryAt',
		row.subscriptionEffectRetryAt ??
			optionalDetailString(detail['subscriptionEffectRetryAt']),
	)
	assignOpt(
		snapshot,
		'subscriptionEffectAttemptCount',
		row.subscriptionEffectAttemptCount ??
			optionalDetailNumber(detail['subscriptionEffectAttemptCount']),
	)
	assignOpt(
		snapshot,
		'subscriptionEffectDeadLetterAt',
		row.subscriptionEffectDeadLetterAt ??
			optionalDetailString(detail['subscriptionEffectDeadLetterAt']),
	)
	assignOpt(
		snapshot,
		'subscriptionEffectLastError',
		row.subscriptionEffectLastError ??
			optionalDetailString(detail['subscriptionEffectLastError']),
	)
	return snapshot
}

export function detailJsonFromMailboxInboundSnapshot(
	snapshot: MailboxInboundDeliverySnapshot,
	extra?: Record<string, unknown>,
): string {
	const { createdAt: _c, updatedAt: _u, ...rest } = snapshot
	return JSON.stringify({ ...rest, ...extra })
}

export function readMailboxDeliveryEventRow(
	sql: SqlStorage,
	id: string,
): MailboxDeliveryEventRecord | null {
	const row = sql
		.exec<Record<string, SqlStorageValue>>(
			`SELECT * FROM email_delivery_events WHERE id = ? LIMIT 1`,
			id,
		)
		.toArray()[0]
	return row ? mapMailboxDeliveryEventRow(row) : null
}

export function readMailboxInboundDeliveryById(
	sql: SqlStorage,
	deliveryId: string,
): MailboxInboundDeliverySnapshot | null {
	const row = readMailboxDeliveryEventRow(sql, deliveryId)
	if (!row || row.provider !== mailboxInboundProvider) return null
	return snapshotFromMailboxDeliveryEventRow(row)
}

export function mailboxMessageExists(sql: SqlStorage, messageId: string) {
	return (
		sql
			.exec<{ ok: number }>(
				`SELECT 1 AS ok FROM email_messages WHERE id = ? LIMIT 1`,
				messageId,
			)
			.toArray()[0] != null
	)
}

export function needsMailboxEffectReconcile(
	snapshot: Pick<
		MailboxInboundDeliverySnapshot,
		| 'usageEffectRecordedAt'
		| 'usageEffectSuppressedAt'
		| 'subscriptionEffectState'
	>,
) {
	const usageDone =
		snapshot.usageEffectRecordedAt != null ||
		snapshot.usageEffectSuppressedAt != null
	const subscriptionDone =
		snapshot.subscriptionEffectState === 'complete' ||
		snapshot.subscriptionEffectState === 'dead-letter'
	return !(usageDone && subscriptionDone)
}

export function normalizeMailboxInboundNow(now?: string) {
	if (now == null) return mailboxNowIso()
	return assertMailboxCanonicalIsoTimestamp(now, 'now')
}

export function normalizeMailboxInboundLimit(limit: number | undefined) {
	if (typeof limit !== 'number' || !Number.isFinite(limit)) {
		return mailboxInboundDueWorkDefaultLimit
	}
	return Math.min(Math.max(Math.trunc(limit), 1), 100)
}

/** Non-negative finite number; rejects invalid values before floor/round. */
export function assertMailboxInboundNonNegativeFiniteNumber(
	value: unknown,
	label: string,
): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`Mailbox ${label} must be a non-negative finite number.`)
	}
	return value
}

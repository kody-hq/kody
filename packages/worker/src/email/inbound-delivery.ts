import {
	inboundSubscriptionEffectState,
	type InboundSubscriptionEffectState,
} from './inbound-subscription-effect-state.ts'
import {
	inboundDeliveryState,
	type InboundDeliveryState,
} from './inbound-delivery-state.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import { normalizeEmailAddress } from './address.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import { systemEmailDayKey, type SystemEmailLocal } from './system-email.ts'

const inboundProvider = 'cloudflare-email-routing'
export const staleInboundDeliveryAgeMs = 48 * 60 * 60 * 1000
export const inboundDeliveryDedupeWindowMs = 48 * 60 * 60 * 1000

export type InboundDelivery = {
	fingerprint: string
	deliveryId: string
	messageId: string
	threadId: string
	rawMimeKey: string
	userId: OwnerId
	inboxId: string
	recipient: string
	envelopeFrom: string
	provider: string
	quotaDay: string
	dedupeExpiresAt: string
	state: InboundDeliveryState
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
	subscriptionEffectState?: InboundSubscriptionEffectState
	subscriptionEffectLease?: string
	subscriptionEffectLeaseAt?: string
	subscriptionEffectRetryAt?: string
	subscriptionEffectAttemptCount?: number
	subscriptionEffectDeadLetterAt?: string
	subscriptionEffectLastError?: string
}

export class InboundDeliveryLeaseLostError extends Error {
	override name = 'InboundDeliveryLeaseLostError'
}

function bytesToHex(bytes: Uint8Array) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

export async function buildInboundDelivery(input: {
	userId: OwnerId
	inboxId: string
	recipient: string
	envelopeFrom?: string
	provider?: string
	rawMime: string
	quotaDay: string
	now?: Date
}): Promise<InboundDelivery> {
	const now = input.now ?? new Date()
	const envelopeFrom =
		normalizeEmailAddress(input.envelopeFrom ?? '') ??
		(input.envelopeFrom ?? '').trim().toLowerCase()
	const provider = input.provider ?? inboundProvider
	const fingerprintInput = new TextEncoder().encode(
		`${input.userId}\u0000${input.recipient}\u0000${envelopeFrom}\u0000${provider}\u0000${input.rawMime}`,
	)
	const fingerprint = bytesToHex(
		new Uint8Array(await crypto.subtle.digest('SHA-256', fingerprintInput)),
	)
	const window = Math.floor(
		now.getTime() / inboundDeliveryDedupeWindowMs,
	).toString(36)
	const digestInput = new TextEncoder().encode(`${fingerprint}\u0000${window}`)
	const deliveryDigest = bytesToHex(
		new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput)),
	)
	const deliveryId = `email-inbound-delivery:${deliveryDigest}`
	const messageId = `email-inbound-message:${deliveryDigest}`
	return {
		fingerprint,
		deliveryId,
		messageId,
		threadId: `email-inbound-thread:${deliveryDigest}`,
		rawMimeKey: emailRawMimeKey(input.userId, messageId),
		userId: input.userId,
		inboxId: input.inboxId,
		recipient: input.recipient,
		envelopeFrom,
		provider,
		quotaDay: input.quotaDay,
		dedupeExpiresAt: new Date(
			now.getTime() + inboundDeliveryDedupeWindowMs,
		).toISOString(),
		state: 'pending',
	}
}

export function parseInboundDeliveryDetailJson(
	detailJson: unknown,
): InboundDelivery | null {
	if (typeof detailJson !== 'string') return null
	try {
		const detail = JSON.parse(detailJson) as Partial<InboundDelivery>
		if (
			typeof detail.deliveryId !== 'string' ||
			typeof detail.fingerprint !== 'string' ||
			typeof detail.messageId !== 'string' ||
			typeof detail.threadId !== 'string' ||
			typeof detail.rawMimeKey !== 'string' ||
			typeof detail.userId !== 'string' ||
			typeof detail.inboxId !== 'string' ||
			typeof detail.recipient !== 'string' ||
			typeof detail.envelopeFrom !== 'string' ||
			typeof detail.provider !== 'string' ||
			typeof detail.quotaDay !== 'string' ||
			typeof detail.dedupeExpiresAt !== 'string'
		) {
			return null
		}
		if (
			detail.rawMimeKey !== emailRawMimeKey(detail.userId, detail.messageId)
		) {
			return null
		}
		const state = inboundDeliveryState.is(detail.state)
			? detail.state
			: 'pending'
		return {
			fingerprint: detail.fingerprint,
			deliveryId: detail.deliveryId,
			messageId: detail.messageId,
			threadId: detail.threadId,
			rawMimeKey: detail.rawMimeKey,
			userId: detail.userId,
			inboxId: detail.inboxId,
			recipient: detail.recipient,
			envelopeFrom: detail.envelopeFrom,
			provider: detail.provider,
			quotaDay: detail.quotaDay,
			dedupeExpiresAt: detail.dedupeExpiresAt,
			state,
			...(typeof detail.rejectionReason === 'string'
				? { rejectionReason: detail.rejectionReason }
				: {}),
			...(typeof detail.storageLease === 'string'
				? { storageLease: detail.storageLease }
				: {}),
			...(typeof detail.storageLeaseAt === 'string'
				? { storageLeaseAt: detail.storageLeaseAt }
				: {}),
			...(typeof detail.expectedAttachmentCount === 'number'
				? { expectedAttachmentCount: detail.expectedAttachmentCount }
				: {}),
			...(typeof detail.cleanupLease === 'string'
				? { cleanupLease: detail.cleanupLease }
				: {}),
			...(typeof detail.cleanupLeaseAt === 'string'
				? { cleanupLeaseAt: detail.cleanupLeaseAt }
				: {}),
			...(typeof detail.cleanupRetryAt === 'string'
				? { cleanupRetryAt: detail.cleanupRetryAt }
				: {}),
			...(typeof detail.finalizationToken === 'string'
				? { finalizationToken: detail.finalizationToken }
				: {}),
			...(typeof detail.reconcileAfter === 'string'
				? { reconcileAfter: detail.reconcileAfter }
				: {}),
			...(typeof detail.usageEffectRecordedAt === 'string'
				? { usageEffectRecordedAt: detail.usageEffectRecordedAt }
				: {}),
			...(typeof detail.usageEffectSuppressedAt === 'string'
				? { usageEffectSuppressedAt: detail.usageEffectSuppressedAt }
				: {}),
			...(typeof detail.usageStartedAt === 'string'
				? { usageStartedAt: detail.usageStartedAt }
				: {}),
			...(typeof detail.usageDurationMs === 'number'
				? { usageDurationMs: detail.usageDurationMs }
				: {}),
			...(typeof detail.usageMonth === 'string'
				? { usageMonth: detail.usageMonth }
				: {}),
			...(typeof detail.usageBytes === 'number'
				? { usageBytes: detail.usageBytes }
				: {}),
			...(typeof detail.usageEffectRetryAt === 'string'
				? { usageEffectRetryAt: detail.usageEffectRetryAt }
				: {}),
			...(typeof detail.usageEffectLease === 'string'
				? { usageEffectLease: detail.usageEffectLease }
				: {}),
			...(typeof detail.usageEffectLeaseAt === 'string'
				? { usageEffectLeaseAt: detail.usageEffectLeaseAt }
				: {}),
			...(inboundSubscriptionEffectState.is(detail.subscriptionEffectState)
				? { subscriptionEffectState: detail.subscriptionEffectState }
				: {}),
			...(typeof detail.subscriptionEffectLease === 'string'
				? { subscriptionEffectLease: detail.subscriptionEffectLease }
				: {}),
			...(typeof detail.subscriptionEffectLeaseAt === 'string'
				? { subscriptionEffectLeaseAt: detail.subscriptionEffectLeaseAt }
				: {}),
			...(typeof detail.subscriptionEffectRetryAt === 'string'
				? { subscriptionEffectRetryAt: detail.subscriptionEffectRetryAt }
				: {}),
			...(typeof detail.subscriptionEffectAttemptCount === 'number'
				? {
						subscriptionEffectAttemptCount:
							detail.subscriptionEffectAttemptCount,
					}
				: {}),
			...(typeof detail.subscriptionEffectDeadLetterAt === 'string'
				? {
						subscriptionEffectDeadLetterAt:
							detail.subscriptionEffectDeadLetterAt,
					}
				: {}),
			...(typeof detail.subscriptionEffectLastError === 'string'
				? { subscriptionEffectLastError: detail.subscriptionEffectLastError }
				: {}),
		}
	} catch {
		return null
	}
}

export function parseStrictInboundDeliveryDetailJson(
	detailJson: unknown,
): InboundDelivery | null {
	const delivery = parseInboundDeliveryDetailJson(detailJson)
	if (!delivery || typeof detailJson !== 'string') return null
	try {
		const raw = JSON.parse(detailJson) as unknown
		if (
			typeof raw !== 'object' ||
			raw == null ||
			!('state' in raw) ||
			raw.state !== delivery.state
		) {
			return null
		}
		const record = raw as Record<string, unknown>
		for (const field of ['cleanupRetryAt', 'reconcileAfter'] as const) {
			const value = record[field]
			if (
				field in record &&
				(typeof value !== 'string' ||
					!Number.isFinite(Date.parse(value)) ||
					new Date(value).toISOString() !== value)
			) {
				return null
			}
		}
		return delivery
	} catch {
		return null
	}
}

async function readSystemEmailDailyCounter(input: {
	db: D1Database
	localPart: SystemEmailLocal
	day: string
}) {
	const row = await input.db
		.prepare(
			`SELECT count FROM system_email_daily_counters
			WHERE local_part = ? AND day = ?`,
		)
		.bind(input.localPart, input.day)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

/**
 * Point-read today's user inbound receive count from UserMeter. Cold meters
 * initialize at zero. Daily counters live only in UserMeter (no D1
 * daily-counter table).
 *
 * `db` remains for call-site stability.
 */
export async function readUserInboundReceiveCount(input: {
	db: D1Database
	env: UserMeterEnv
	userId: OwnerId
	day: string
	now?: Date
}) {
	void input.db
	const now = input.now ?? new Date()
	const updatedAt = now.toISOString()
	const meter = userMeterRpc({ env: input.env, userId: input.userId })
	let result = await meter.read({
		resource: 'email_receives_per_day',
		day: input.day,
		now: updatedAt,
	})
	if (result.outcome === 'needs_bootstrap') {
		await meter.initialize({
			resource: 'email_receives_per_day',
			day: input.day,
			count: 0,
			updatedAt,
		})
		result = await meter.read({
			resource: 'email_receives_per_day',
			day: input.day,
			now: updatedAt,
		})
		if (result.outcome === 'needs_bootstrap') {
			throw new Error(
				'UserMeter inbound receive read still needs bootstrap after initialize.',
			)
		}
	}
	return result.count
}

export async function readSystemInboundReceiveCount(input: {
	db: D1Database
	localPart: SystemEmailLocal
	day: string
}) {
	return await readSystemEmailDailyCounter({
		db: input.db,
		localPart: input.localPart,
		day: input.day,
	})
}

export function userInboundQuotaDay(now: Date) {
	return utcDayKey(now)
}

export function systemInboundQuotaDay(now: Date) {
	return systemEmailDayKey(now)
}

import { systemEmailOwnerId } from './email-owner.ts'
import { type InboundDelivery } from './inbound-delivery.ts'
import {
	inboundEffectLeaseMs,
	inboundEffectRetryMs,
} from './inbound-delivery-transitions.ts'
import { assertSystemEmailGraphAuthority } from './system-email-authority.ts'
import { commitSystemInboundEventMutation } from './system-inbound-delivery-transaction.ts'

const systemInboundProvider = 'cloudflare-email-routing'

export async function listDueSystemInboundEffects(input: {
	db: D1Database
	now: Date
	limit: number
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const expiredBefore = new Date(
		input.now.getTime() - inboundEffectLeaseMs,
	).toISOString()
	const rows = await input.db
		.prepare(
			`SELECT id FROM system_email_delivery_events
			WHERE provider = ? AND event_type = 'received'
				AND needs_effect_reconcile = 1 AND fingerprint IS NOT NULL
				AND (
					(
						usage_effect_recorded_at IS NULL
						AND usage_effect_suppressed_at IS NULL
						AND (usage_effect_retry_at IS NULL OR usage_effect_retry_at <= ?)
						AND (
							usage_effect_lease IS NULL
							OR usage_effect_lease_at IS NULL
							OR usage_effect_lease_at < ?
						)
					)
					OR (
						COALESCE(subscription_effect_state, 'pending')
							NOT IN ('complete', 'dead-letter')
						AND (
							subscription_effect_retry_at IS NULL
							OR subscription_effect_retry_at <= ?
						)
						AND (
							COALESCE(subscription_effect_state, 'pending') != 'processing'
							OR subscription_effect_lease_at IS NULL
							OR subscription_effect_lease_at < ?
						)
					)
				)
			ORDER BY COALESCE(
				usage_effect_retry_at, subscription_effect_retry_at, created_at
			), id LIMIT ?`,
		)
		.bind(
			systemInboundProvider,
			input.now.toISOString(),
			expiredBefore,
			input.now.toISOString(),
			expiredBefore,
			input.limit,
		)
		.all<{ id: string }>()
	return rows.results ?? []
}

export async function claimSystemInboundSubscriptionEffect(input: {
	db: D1Database
	deliveryId: string
	finalizationToken: string | undefined
	now: Date
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const lease = crypto.randomUUID()
	const expiredBefore = new Date(
		input.now.getTime() - inboundEffectLeaseMs,
	).toISOString()
	const { dedicatedResult } = await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.deliveryId,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET subscription_effect_state = 'processing',
					subscription_effect_lease = ?, subscription_effect_lease_at = ?,
					detail_json = json_set(
						detail_json, '$.subscriptionEffectState', 'processing',
						'$.subscriptionEffectLease', ?,
						'$.subscriptionEffectLeaseAt', ?
					), updated_at = ?
				WHERE id = ? AND event_type = 'received'
					AND (? IS NULL OR finalization_token = ?)
					AND (
						subscription_effect_retry_at IS NULL
						OR subscription_effect_retry_at <= ?
					)
					AND (
						subscription_effect_state IS NULL
						OR subscription_effect_state = 'pending'
						OR (
							subscription_effect_state = 'processing'
							AND (
								subscription_effect_lease_at IS NULL
								OR subscription_effect_lease_at < ?
							)
						)
					)`,
			)
			.bind(
				lease,
				input.now.toISOString(),
				lease,
				input.now.toISOString(),
				input.now.toISOString(),
				input.deliveryId,
				input.finalizationToken ?? null,
				input.finalizationToken ?? null,
				input.now.toISOString(),
				expiredBefore,
			),
	})
	return Number(dedicatedResult?.meta.changes ?? 0) > 0 ? lease : null
}

export async function completeSystemInboundSubscriptionEffect(input: {
	db: D1Database
	deliveryId: string
	lease: string
	now: Date
	detailField?: string
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const path = input.detailField ?? '$.subscriptionEffectCompletedAt'
	const { dedicatedResult } = await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.deliveryId,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET subscription_effect_state = 'complete',
					subscription_effect_lease = NULL,
					subscription_effect_lease_at = NULL,
					subscription_effect_retry_at = NULL,
					detail_json = json_remove(
						json_remove(
							json_remove(
								json_set(
									detail_json, '$.subscriptionEffectState', 'complete',
									?, ?
								), '$.subscriptionEffectLease'
							), '$.subscriptionEffectLeaseAt'
						), '$.subscriptionEffectRetryAt'
					),
					needs_effect_reconcile = CASE
						WHEN usage_effect_recorded_at IS NOT NULL
							OR usage_effect_suppressed_at IS NOT NULL THEN 0
						ELSE 1
					END,
					updated_at = ?
				WHERE id = ? AND subscription_effect_lease = ?`,
			)
			.bind(
				path,
				input.now.toISOString(),
				input.now.toISOString(),
				input.deliveryId,
				input.lease,
			),
	})
	return Number(dedicatedResult?.meta.changes ?? 0) > 0
}

export async function failSystemInboundSubscriptionEffect(input: {
	db: D1Database
	deliveryId: string
	lease: string
	error: string
	attemptCount: number
	deadLettered: boolean
	now: Date
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const retryAt = input.deadLettered
		? null
		: new Date(input.now.getTime() + inboundEffectRetryMs).toISOString()
	const { dedicatedResult } = await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.deliveryId,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET subscription_effect_state = ?,
					subscription_effect_lease = NULL,
					subscription_effect_lease_at = NULL,
					subscription_effect_retry_at = ?,
					subscription_effect_attempt_count = ?,
					subscription_effect_dead_letter_at = ?,
					subscription_effect_last_error = ?,
					detail_json = json_remove(
						json_remove(
							json_set(
								detail_json, '$.subscriptionEffectState', ?,
								'$.subscriptionEffectRetryAt', ?,
								'$.subscriptionEffectAttemptCount', ?,
								'$.subscriptionEffectDeadLetterAt', ?,
								'$.subscriptionEffectLastError', ?
							), '$.subscriptionEffectLease'
						), '$.subscriptionEffectLeaseAt'
					),
					needs_effect_reconcile = CASE
						WHEN ? AND (
							usage_effect_recorded_at IS NOT NULL
							OR usage_effect_suppressed_at IS NOT NULL
						) THEN 0 ELSE 1 END,
					updated_at = ?
				WHERE id = ? AND subscription_effect_lease = ?`,
			)
			.bind(
				input.deadLettered ? 'dead-letter' : 'pending',
				retryAt,
				input.attemptCount,
				input.deadLettered ? input.now.toISOString() : null,
				input.error,
				input.deadLettered ? 'dead-letter' : 'pending',
				retryAt,
				input.attemptCount,
				input.deadLettered ? input.now.toISOString() : null,
				input.error,
				input.deadLettered,
				input.now.toISOString(),
				input.deliveryId,
				input.lease,
			),
	})
	return Number(dedicatedResult?.meta.changes ?? 0) > 0
}

export async function recordSystemInboundUsageEffect(input: {
	db: D1Database
	delivery: InboundDelivery
	usageMonth: string
	usageBytes: number
	usageDurationMs: number
	now: Date
	includeRollup: boolean
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const before: Array<D1PreparedStatement> = []
	if (input.includeRollup) {
		before.push(
			input.db
				.prepare(
					`INSERT INTO usage_rollups (
						user_id, metric, month, event_count, error_count,
						total_duration_ms, total_cpu_ms, total_bytes, updated_at
					)
					SELECT ?, 'email_received', ?, 1, 0, ?, 0, ?, ?
					WHERE EXISTS (
						SELECT 1 FROM system_email_delivery_events
						WHERE id = ? AND event_type = 'received'
							AND usage_effect_recorded_at IS NULL
							AND usage_effect_suppressed_at IS NULL
							AND (? IS NULL OR finalization_token = ?)
					)
					ON CONFLICT(user_id, metric, month) DO UPDATE SET
						event_count = event_count + 1,
						total_duration_ms =
							total_duration_ms + excluded.total_duration_ms,
						total_bytes = total_bytes + excluded.total_bytes,
						updated_at = excluded.updated_at`,
				)
				.bind(
					systemEmailOwnerId,
					input.usageMonth,
					Math.round(input.usageDurationMs),
					Math.round(input.usageBytes),
					input.now.toISOString(),
					input.delivery.deliveryId,
					input.delivery.finalizationToken ?? null,
					input.delivery.finalizationToken ?? null,
				),
		)
	}
	await commitSystemInboundEventMutation({
		db: input.db,
		eventId: input.delivery.deliveryId,
		before,
		dedicated: input.db
			.prepare(
				`UPDATE system_email_delivery_events
				SET usage_effect_recorded_at = ?, usage_month = ?, usage_bytes = ?,
					usage_duration_ms = ?, usage_effect_retry_at = NULL,
					detail_json = json_remove(
						json_set(
							detail_json, '$.usageEffectRecordedAt', ?,
							'$.usageMonth', ?, '$.usageBytes', ?,
							'$.usageDurationMs', ?
						), '$.usageEffectRetryAt'
					),
					needs_effect_reconcile = CASE
						WHEN subscription_effect_state IN ('complete', 'dead-letter')
						THEN 0 ELSE 1 END,
					updated_at = ?
				WHERE id = ? AND event_type = 'received'
					AND usage_effect_recorded_at IS NULL
					AND usage_effect_suppressed_at IS NULL
					AND (? IS NULL OR finalization_token = ?)`,
			)
			.bind(
				input.now.toISOString(),
				input.usageMonth,
				Math.round(input.usageBytes),
				Math.round(input.usageDurationMs),
				input.now.toISOString(),
				input.usageMonth,
				Math.round(input.usageBytes),
				Math.round(input.usageDurationMs),
				input.now.toISOString(),
				input.delivery.deliveryId,
				input.delivery.finalizationToken ?? null,
				input.delivery.finalizationToken ?? null,
			),
	})
}

export async function listSystemInboundUsageRows(input: {
	db: D1Database
	months: [string, string]
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const result = await input.db
		.prepare(
			`SELECT
				? AS user_id,
				'email_received' AS metric,
				usage_month AS month,
				COUNT(*) AS event_count,
				0 AS error_count,
				0 AS caught_count,
				SUM(COALESCE(usage_duration_ms, 0)) AS total_duration_ms,
				0 AS total_cpu_ms,
				SUM(COALESCE(usage_bytes, 0)) AS total_bytes
			FROM system_email_delivery_events
			WHERE provider = ? AND event_type = 'received'
				AND usage_effect_recorded_at IS NOT NULL
				AND usage_month IN (?, ?)
			GROUP BY usage_month`,
		)
		.bind(systemEmailOwnerId, systemInboundProvider, ...input.months)
		.all<{
			user_id: string
			metric: string
			month: string
			event_count: number
			error_count: number
			caught_count: number
			total_duration_ms: number
			total_cpu_ms: number
			total_bytes: number
		}>()
	return result.results ?? []
}

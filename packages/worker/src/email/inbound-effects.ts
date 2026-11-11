import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { maxConcurrentDynamicWorkerEvaluationsPerRequest } from '#worker/dynamic-worker-evaluation-budget.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import {
	dispatchInboundEmailSubscriptionEvents,
	dispatchSystemInboundEmailSubscriptionEvents,
} from './package-subscriptions.ts'
import { getInternalEmailMessageById } from './mailbox-internal-read.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	claimSystemInboundSubscriptionEffect,
	completeSystemInboundSubscriptionEffect,
	failSystemInboundSubscriptionEffect,
	getSystemInboundDelivery,
	listDueSystemInboundEffects,
	recordSystemInboundUsageEffect,
} from './system-inbound-delivery-store.ts'

const maxSubscriptionEffectAttempts = 3

const reconciliationEffectConcurrency =
	maxConcurrentDynamicWorkerEvaluationsPerRequest

async function forEachWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	run: (item: T) => Promise<void>,
) {
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (next < items.length) {
				await run(items[next++]!)
			}
		}),
	)
}

export function resolveSubscriptionEffectFailure(attemptCount: number) {
	const nextAttempt = Math.max(0, Math.floor(attemptCount)) + 1
	return {
		attemptCount: nextAttempt,
		deadLettered: nextAttempt >= maxSubscriptionEffectAttempts,
	}
}

type InboundEffectsEnv = Pick<
	Env,
	| 'APP_DB'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'APP_BASE_URL'
	| 'USAGE_EVENTS'
	| 'MAILBOX'
	| 'USER_METER'
>

async function recordUserInboundUsageRollup(input: {
	env: InboundEffectsEnv
	userId: OwnerId
	deliveryId: string
	usageBytes: number
	usageDurationMs: number
	now: Date
}) {
	// Keep this aggregate in Analytics Engine; D1 has no USER delivery graph.
	if (!input.env.USAGE_EVENTS) return 'suppressed' as const
	await recordUsage(input.env, {
		userId: input.userId,
		eventType: 'email_received',
		entityId: input.deliveryId,
		bytes: input.usageBytes,
		durationMs: input.usageDurationMs,
		outcome: 'success',
		timestamp: input.now.toISOString(),
		actorUserId: '',
		automationSource: 'email',
	})
	return 'recorded' as const
}

async function processUserInboundDeliveryEffectsWithLeaseHeld(input: {
	env: InboundEffectsEnv
	userId: OwnerId
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const now = input.now ?? new Date()
	const authority = createUserInboundDeliveryAuthority({
		env: input.env,
		userId: input.userId,
	})
	const delivery = await authority.get(input.deliveryId)
	if (
		delivery?.state !== 'received' ||
		!delivery.finalizationToken ||
		(input.expectedFinalizationToken != null &&
			delivery.finalizationToken !== input.expectedFinalizationToken)
	) {
		return { outcome: 'stale' as const }
	}
	const message = await getInternalEmailMessageById({
		env: input.env,
		ownerId: input.userId,
		messageId: delivery.messageId,
	})
	const usageMonth =
		delivery.usageMonth ??
		(message
			? (message.receivedAt ?? message.createdAt).slice(0, 7)
			: now.toISOString().slice(0, 7))
	const usageBytes = delivery.usageBytes ?? message?.rawSize ?? 0
	const usageDurationMs = delivery.usageDurationMs ?? input.durationMs ?? 0
	const usageClaim = await authority.claimUsageEffect({
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: delivery.finalizationToken,
		now,
	})
	if (usageClaim.status === 'claimed') {
		const usageMode = await recordUserInboundUsageRollup({
			env: input.env,
			userId: input.userId,
			deliveryId: delivery.deliveryId,
			usageBytes,
			usageDurationMs,
			now,
		})
		const completed = await authority.completeUsageEffect({
			deliveryId: delivery.deliveryId,
			usageEffectLease: usageClaim.delivery.usageEffectLease!,
			expectedFinalizationToken: delivery.finalizationToken,
			mode: usageMode,
			usageMonth,
			usageBytes,
			usageDurationMs,
			now,
		})
		if (completed.status === 'lease-lost') {
			return { outcome: 'stale' as const }
		}
	}

	const subscriptionClaim = await authority.claimSubscriptionEffect({
		deliveryId: delivery.deliveryId,
		expectedFinalizationToken: delivery.finalizationToken,
		now,
	})
	if (subscriptionClaim.status !== 'claimed') {
		return { outcome: 'usage-only' as const }
	}
	const effectLease = subscriptionClaim.delivery.subscriptionEffectLease!
	try {
		if (!message) {
			await authority.completeSubscriptionEffect({
				deliveryId: delivery.deliveryId,
				subscriptionEffectLease: effectLease,
				expectedFinalizationToken: delivery.finalizationToken,
				mode: 'suppressed',
				suppressionReason: 'missing-message',
				now,
			})
			return { outcome: 'missing-message' as const }
		}
		await dispatchInboundEmailSubscriptionEvents({
			env: input.env,
			userId: input.userId,
			message,
			waitUntil: input.waitUntil,
		})
		const completed = await authority.completeSubscriptionEffect({
			deliveryId: delivery.deliveryId,
			subscriptionEffectLease: effectLease,
			expectedFinalizationToken: delivery.finalizationToken,
			mode: 'complete',
			now,
		})
		if (completed.status === 'lease-lost') {
			return { outcome: 'stale' as const }
		}
		return { outcome: 'complete' as const }
	} catch (error) {
		const failure = await authority.failSubscriptionEffect({
			deliveryId: delivery.deliveryId,
			subscriptionEffectLease: effectLease,
			expectedFinalizationToken: delivery.finalizationToken,
			error: error instanceof Error ? error.message : String(error),
			now,
		})
		if (failure.status === 'lease-lost') {
			return { outcome: 'stale' as const }
		}
		if (failure.status === 'dead-letter') {
			console.error('inbound-email-subscription-effect-dead-lettered', {
				userId: input.userId,
				deliveryId: delivery.deliveryId,
				attemptCount: failure.delivery.subscriptionEffectAttemptCount,
				error,
			})
			return { outcome: 'dead-letter' as const }
		}
		throw error
	}
}

export type ProcessInboundDeliveryEffectsInput = {
	env: InboundEffectsEnv
	userId: OwnerId
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}

async function processDedicatedSystemInboundDeliveryEffects(
	input: ProcessInboundDeliveryEffectsInput,
) {
	const now = input.now ?? new Date()
	const delivery = await getSystemInboundDelivery({
		db: input.env.APP_DB,
		deliveryId: input.deliveryId,
	})
	if (
		delivery?.state !== 'received' ||
		(input.expectedFinalizationToken != null &&
			delivery.finalizationToken !== input.expectedFinalizationToken)
	) {
		return { outcome: 'stale' as const }
	}
	const message = await getInternalEmailMessageById({
		env: input.env,
		ownerId: systemEmailOwnerId,
		messageId: delivery.messageId,
	})
	const usageMonth =
		delivery.usageMonth ??
		(message
			? (message.receivedAt ?? message.createdAt).slice(0, 7)
			: now.toISOString().slice(0, 7))
	const usageBytes = delivery.usageBytes ?? message?.rawSize ?? 0
	const usageDurationMs = delivery.usageDurationMs ?? input.durationMs ?? 0
	const includeRollup = !input.env.USAGE_EVENTS
	await recordSystemInboundUsageEffect({
		db: input.env.APP_DB,
		delivery,
		usageMonth,
		usageBytes,
		usageDurationMs,
		now,
		includeRollup,
	})
	const lease = await claimSystemInboundSubscriptionEffect({
		db: input.env.APP_DB,
		deliveryId: delivery.deliveryId,
		finalizationToken: delivery.finalizationToken,
		now,
	})
	if (!lease) return { outcome: 'usage-only' as const }
	try {
		if (!message) {
			const completed = await completeSystemInboundSubscriptionEffect({
				db: input.env.APP_DB,
				deliveryId: delivery.deliveryId,
				lease,
				now,
				detailField: '$.subscriptionEffectMissingMessageAt',
			})
			if (!completed) return { outcome: 'stale' as const }
			return { outcome: 'missing-message' as const }
		}
		if (message.classification !== 'quarantined') {
			await dispatchSystemInboundEmailSubscriptionEvents({
				env: input.env,
				message,
				waitUntil: input.waitUntil,
			})
		}
		const completed = await completeSystemInboundSubscriptionEffect({
			db: input.env.APP_DB,
			deliveryId: delivery.deliveryId,
			lease,
			now,
			detailField:
				message.classification === 'quarantined'
					? '$.subscriptionEffectSuppressedQuarantineAt'
					: undefined,
		})
		if (!completed) return { outcome: 'stale' as const }
		return { outcome: 'complete' as const }
	} catch (error) {
		const failure = resolveSubscriptionEffectFailure(
			delivery.subscriptionEffectAttemptCount ?? 0,
		)
		const failed = await failSystemInboundSubscriptionEffect({
			db: input.env.APP_DB,
			deliveryId: delivery.deliveryId,
			lease,
			error: error instanceof Error ? error.message : String(error),
			attemptCount: failure.attemptCount,
			deadLettered: failure.deadLettered,
			now,
		})
		if (!failed) return { outcome: 'stale' as const }
		if (failure.deadLettered) {
			console.error('inbound-email-subscription-effect-dead-lettered', {
				userId: systemEmailOwnerId,
				deliveryId: delivery.deliveryId,
				attemptCount: failure.attemptCount,
				error,
			})
			return { outcome: 'dead-letter' as const }
		}
		throw error
	}
}

export async function processInboundDeliveryEffects(
	input: ProcessInboundDeliveryEffectsInput,
) {
	if (input.userId === systemEmailOwnerId) {
		return await processDedicatedSystemInboundDeliveryEffects(input)
	}
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		env: input.env,
		write: async () =>
			await processUserInboundDeliveryEffectsWithLeaseHeld(input),
	})
}

export async function reconcileInboundDeliveryEffectsForUser(input: {
	env: InboundEffectsEnv
	userId: OwnerId
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	if (input.userId !== systemEmailOwnerId) {
		const authority = createUserInboundDeliveryAuthority({
			env: input.env,
			userId: input.userId,
		})
		let processed = 0
		let errors = 0
		const due = await authority.listDueEffects(now, input.limit)
		// Due deliveries are independent; process a few at once so one slow
		// subscription handler does not serialize the whole backlog.
		await forEachWithConcurrency(
			due.deliveries,
			reconciliationEffectConcurrency,
			async (delivery) => {
				try {
					await processInboundDeliveryEffects({
						env: input.env,
						userId: input.userId,
						deliveryId: delivery.deliveryId,
						now: input.now,
					})
					processed += 1
				} catch (error) {
					errors += 1
					console.warn(
						'inbound-email-effect-reconciliation-failed',
						input.userId,
						delivery.deliveryId,
						error,
					)
				}
			},
		)
		return { processed, errors }
	}
	const rows = await listDueSystemInboundEffects({
		db: input.env.APP_DB,
		now,
		limit: input.limit ?? 20,
	})
	let processed = 0
	let errors = 0
	for (const row of rows) {
		try {
			await processInboundDeliveryEffects({
				env: input.env,
				userId: input.userId,
				deliveryId: row.id,
				now: input.now,
			})
			processed += 1
		} catch (error) {
			errors += 1
			console.warn(
				'inbound-email-effect-reconciliation-failed',
				input.userId,
				row.id,
				error,
			)
		}
	}
	return { processed, errors }
}

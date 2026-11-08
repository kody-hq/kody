import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	buildEntitlementUpgradeHint,
	EntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { entitlementOrgPaths } from '#worker/entitlements/service.ts'
import type { PlanName } from '#universal/plans.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import {
	InboundDeliveryLeaseLostError,
	type InboundDelivery,
} from './inbound-delivery.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import type {
	MailboxClaimInboundSubscriptionEffectResult,
	MailboxClaimInboundUsageEffectResult,
	MailboxCompleteInboundSubscriptionEffectResult,
	MailboxCompleteInboundUsageEffectResult,
	MailboxFailInboundSubscriptionEffectResult,
	MailboxListDueInboundEffectWorkResult,
} from './mailbox-inbound-effect-ledger.ts'
import type {
	MailboxClaimInboundDeliveryCleanupResult,
	MailboxDeferInboundDeliveryReconcileResult,
	MailboxInboundDeliveryInsertInput,
	MailboxInboundDeliverySnapshot,
	MailboxListDueStaleInboundDeliveriesResult,
	MailboxMarkInboundDeliveryOrphanCleanedResult,
	MailboxReleaseInboundDeliveryCleanupResult,
} from './mailbox-inbound-ledger.ts'
import type {
	MailboxAttachmentInput,
	MailboxCommitInboundMessageGraphResult,
	MailboxMessageInput,
	MailboxThreadInput,
} from './mailbox-types.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { replaceInboundDueOwnerHint } from './inbound-due-owners.ts'

export type UserInboundDeliveryAuthorityEnv = {
	APP_DB: D1Database
} & MailboxEnv &
	UserMeterEnv

export type CreateUserInboundDeliveryAuthorityInput = {
	env: UserInboundDeliveryAuthorityEnv
	userId: OwnerId
}

export type UserInboundDeliveryChargeInput = {
	delivery: InboundDelivery
	plan: PlanName
	limit: number
	now: Date
}

export type UserInboundDeliveryChargeResult = {
	delivery: InboundDelivery
	charged: boolean
}

export type UserInboundDeliveryReceiveInput = {
	delivery: InboundDelivery
	usageDurationMs: number
	usageMonth: string
	usageBytes: number
	now?: Date
}

export type UserInboundDeliveryStorageClaimResult =
	| { claimed: true; delivery: InboundDelivery }
	| { claimed: false; delivery: InboundDelivery | null }

export type UserInboundDeliveryOrphanCleanedInput = {
	deliveryId: string
	cleanupLease: string
	outcome: 'deleted' | 'delete-failed'
	now?: Date
}

export type UserInboundDeliveryCleanupClaimInput = {
	deliveryId: string
	expectedState: InboundDelivery['state']
	expectedUpdatedAt: string
	staleBefore: Date
	now?: Date
}

export type UserInboundUsageEffectClaimInput = {
	deliveryId: string
	expectedFinalizationToken?: string
	now?: Date
}

export type UserInboundUsageEffectCompleteInput = {
	deliveryId: string
	usageEffectLease: string
	expectedFinalizationToken: string
	mode: 'recorded' | 'suppressed'
	usageMonth: string
	usageBytes: number
	usageDurationMs: number
	now?: Date
}

export type UserInboundSubscriptionEffectClaimInput = {
	deliveryId: string
	expectedFinalizationToken?: string
	now?: Date
}

export type UserInboundSubscriptionEffectCompleteInput = {
	deliveryId: string
	subscriptionEffectLease: string
	expectedFinalizationToken: string
	mode: 'complete' | 'suppressed'
	suppressionReason?: string
	now?: Date
}

export type UserInboundSubscriptionEffectFailInput = {
	deliveryId: string
	subscriptionEffectLease: string
	expectedFinalizationToken: string
	error: string
	now?: Date
}

export type UserInboundDeliveryAuthority = {
	get: (deliveryId: string) => Promise<InboundDelivery | null>
	getWindow: (fingerprint: string, now: Date) => Promise<InboundDelivery | null>
	claimWindow: (
		delivery: InboundDelivery,
		now: Date,
	) => Promise<InboundDelivery>
	charge: (
		input: UserInboundDeliveryChargeInput,
	) => Promise<UserInboundDeliveryChargeResult>
	claimStorage: (
		delivery: InboundDelivery,
		expectedAttachmentCount: number,
		usageStartedAt?: string,
		now?: Date,
	) => Promise<UserInboundDeliveryStorageClaimResult>
	releaseStorage: (delivery: InboundDelivery, now?: Date) => Promise<void>
	reject: (
		delivery: InboundDelivery,
		reason: string,
		now?: Date,
	) => Promise<InboundDelivery | null>
	receive: (input: UserInboundDeliveryReceiveInput) => Promise<InboundDelivery>
	commitInboundMessageGraph: (input: {
		delivery: InboundDelivery
		thread: MailboxThreadInput
		message: MailboxMessageInput
		attachments: Array<MailboxAttachmentInput>
	}) => Promise<MailboxCommitInboundMessageGraphResult>
	findThreadForInboundMessage: (input: {
		inboxId?: string | null
		references: Array<string>
		inReplyToHeader?: string | null
	}) => Promise<MailboxThreadInput | null>
	deferReconciliation: (
		deliveryId: string,
		now?: Date,
	) => Promise<MailboxDeferInboundDeliveryReconcileResult>
	listDueStale: (
		now?: Date,
		limit?: number,
	) => Promise<MailboxListDueStaleInboundDeliveriesResult>
	claimCleanup: (
		input: UserInboundDeliveryCleanupClaimInput,
	) => Promise<MailboxClaimInboundDeliveryCleanupResult>
	releaseCleanup: (
		deliveryId: string,
		cleanupLease: string,
		now?: Date,
	) => Promise<MailboxReleaseInboundDeliveryCleanupResult>
	markOrphanCleaned: (
		input: UserInboundDeliveryOrphanCleanedInput,
	) => Promise<MailboxMarkInboundDeliveryOrphanCleanedResult>
	pruneExpiredDedupe: (now?: Date, limit?: number) => Promise<number>
	claimUsageEffect: (
		input: UserInboundUsageEffectClaimInput,
	) => Promise<MailboxClaimInboundUsageEffectResult>
	completeUsageEffect: (
		input: UserInboundUsageEffectCompleteInput,
	) => Promise<MailboxCompleteInboundUsageEffectResult>
	claimSubscriptionEffect: (
		input: UserInboundSubscriptionEffectClaimInput,
	) => Promise<MailboxClaimInboundSubscriptionEffectResult>
	completeSubscriptionEffect: (
		input: UserInboundSubscriptionEffectCompleteInput,
	) => Promise<MailboxCompleteInboundSubscriptionEffectResult>
	failSubscriptionEffect: (
		input: UserInboundSubscriptionEffectFailInput,
	) => Promise<MailboxFailInboundSubscriptionEffectResult>
	listDueEffects: (
		now?: Date,
		limit?: number,
	) => Promise<MailboxListDueInboundEffectWorkResult>
}

function toInsertInput(
	delivery: InboundDelivery,
): MailboxInboundDeliveryInsertInput {
	return {
		fingerprint: delivery.fingerprint,
		deliveryId: delivery.deliveryId,
		messageId: delivery.messageId,
		threadId: delivery.threadId,
		rawMimeKey: delivery.rawMimeKey,
		inboxId: delivery.inboxId,
		recipient: delivery.recipient,
		envelopeFrom: delivery.envelopeFrom,
		provider: delivery.provider,
		quotaDay: delivery.quotaDay,
		dedupeExpiresAt: delivery.dedupeExpiresAt,
		usageStartedAt: delivery.usageStartedAt,
	}
}

export function createUserInboundDeliveryAuthority(
	input: CreateUserInboundDeliveryAuthorityInput,
): UserInboundDeliveryAuthority {
	const { env, userId } = input
	if (userId === systemEmailOwnerId) {
		throw new Error(
			'system:email inbound delivery authority must remain in D1.',
		)
	}
	const mailbox = mailboxRpc({ env, userId })
	const refreshDueHint = async (reason: string, now = new Date()) => {
		try {
			const hint = await mailbox.getInboundDueWorkHint({ ownerId: userId })
			await replaceInboundDueOwnerHint({
				db: env.APP_DB,
				userId,
				dueAt: hint.dueAt,
				reason,
				now,
			})
		} catch (error) {
			console.warn('inbound-due-owner-hint-write-failed', error)
		}
	}
	const toDelivery = (snapshot: MailboxInboundDeliverySnapshot) => {
		const {
			createdAt: _createdAt,
			updatedAt: _updatedAt,
			...delivery
		} = snapshot
		return { ...delivery, userId }
	}
	const get = async (deliveryId: string) => {
		const current = await mailbox.getInboundDelivery({
			ownerId: userId,
			deliveryId,
		})
		return current ? toDelivery(current) : null
	}
	const getWindow = async (fingerprint: string, now: Date) => {
		const current = await mailbox.getInboundDeliveryWindow({
			ownerId: userId,
			fingerprint,
			now: now.toISOString(),
		})
		return current ? toDelivery(current) : null
	}
	const claimWindow = async (delivery: InboundDelivery, now: Date) => {
		const snapshot = await mailbox.claimInboundDeliveryWindow({
			ownerId: userId,
			delivery: toInsertInput(delivery),
			now: now.toISOString(),
		})
		return toDelivery(snapshot)
	}
	const charge = async (chargeInput: UserInboundDeliveryChargeInput) => {
		// Resolve the canonical dedupe winner before charging. Concurrent
		// boundary candidates therefore consume quota only under the winner id.
		const claimedDelivery = await claimWindow(
			chargeInput.delivery,
			chargeInput.now,
		)
		const existing = await get(claimedDelivery.deliveryId)
		if (existing) return { delivery: existing, charged: false }
		const chargedDelivery = {
			...claimedDelivery,
			quotaDay: chargeInput.delivery.quotaDay,
		}
		const updatedAt = chargeInput.now.toISOString()
		const meter = userMeterRpc({ env, userId })
		// Accepted non-atomic cross-DO window: if Email Routing exhausts retries
		// after UserMeter consume but before Mailbox insert, one daily receive unit
		// may burn until reset. Replays self-heal while retries continue and cannot
		// duplicate a message because both operations use the dedupe winner id.
		let meterResult = await meter.consumeInboundDelivery({
			deliveryId: chargedDelivery.deliveryId,
			resource: 'email_receives_per_day',
			day: chargedDelivery.quotaDay,
			limit: chargeInput.limit,
			updatedAt,
		})
		if (meterResult.outcome === 'needs_bootstrap') {
			await meter.initialize({
				resource: 'email_receives_per_day',
				day: chargedDelivery.quotaDay,
				count: 0,
				updatedAt,
			})
			meterResult = await meter.consumeInboundDelivery({
				deliveryId: chargedDelivery.deliveryId,
				resource: 'email_receives_per_day',
				day: chargedDelivery.quotaDay,
				limit: chargeInput.limit,
				updatedAt,
			})
			if (meterResult.outcome === 'needs_bootstrap') {
				throw new Error(
					'UserMeter inbound delivery consume still needs bootstrap after initialize.',
				)
			}
		}
		if (!meterResult.consumed && !meterResult.replayed) {
			const paths = await entitlementOrgPaths(env.APP_DB, userId)
			throw new EntitlementLimitError({
				resource: 'email_receives_per_day',
				plan: chargeInput.plan,
				limit: chargeInput.limit,
				current: meterResult.count,
				...(paths.orgSlug ? { orgSlug: paths.orgSlug } : {}),
				upgradeHint: buildEntitlementUpgradeHint({
					resource: 'email_receives_per_day',
					plan: chargeInput.plan,
					billingPath: paths.billingPath,
					...(paths.usagePath ? { usagePath: paths.usagePath } : {}),
					now: chargeInput.now,
				}),
			})
		}
		const result = await mailbox.insertChargedPendingInboundDelivery({
			ownerId: userId,
			delivery: toInsertInput(chargedDelivery),
			now: updatedAt,
		})
		await refreshDueHint('inbound-charge', chargeInput.now)
		const delivery = toDelivery(result.delivery)
		return {
			delivery,
			charged:
				result.status === 'inserted' &&
				claimedDelivery.deliveryId === chargeInput.delivery.deliveryId,
		}
	}
	return {
		get,
		getWindow,
		claimWindow,
		charge,
		async claimStorage(
			delivery: InboundDelivery,
			expectedAttachmentCount: number,
			usageStartedAt?: string,
			now = new Date(),
		) {
			const result = await mailbox.claimInboundDeliveryStorage({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				expectedAttachmentCount,
				usageStartedAt,
				now: now.toISOString(),
			})
			if (result.status === 'claimed') {
				const storageLease = result.delivery.storageLease
				if (!storageLease) {
					throw new Error(
						'Mailbox returned a claimed inbound storage delivery without a lease.',
					)
				}
				return {
					claimed: true as const,
					delivery: toDelivery(result.delivery),
				}
			}
			return {
				claimed: false as const,
				delivery: result.delivery ? toDelivery(result.delivery) : null,
			}
		},
		async releaseStorage(delivery: InboundDelivery, now = new Date()) {
			if (!delivery.storageLease) return
			await mailbox.releaseInboundDeliveryStorage({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				storageLease: delivery.storageLease,
				now: now.toISOString(),
			})
		},
		async reject(delivery: InboundDelivery, reason: string, now = new Date()) {
			const result = await mailbox.markInboundDeliveryRejected({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				reason,
				expectedStorageLease: delivery.storageLease,
				expectedState: delivery.state,
				now: now.toISOString(),
			})
			await refreshDueHint('inbound-rejected', now)
			if (
				result.status === 'rejected' ||
				result.status === 'already-rejected'
			) {
				return toDelivery(result.delivery)
			}
			if (result.status === 'already-received') {
				return null
			}
			throw new InboundDeliveryLeaseLostError(
				'Inbound rejection lost a state race; delivery should be retried.',
			)
		},
		async receive(input: UserInboundDeliveryReceiveInput) {
			if (!input.delivery.storageLease) {
				throw new InboundDeliveryLeaseLostError(
					'Inbound delivery finalization requires a storage lease.',
				)
			}
			const result = await mailbox.markInboundDeliveryReceived({
				ownerId: userId,
				deliveryId: input.delivery.deliveryId,
				storageLease: input.delivery.storageLease,
				usageDurationMs: input.usageDurationMs,
				usageMonth: input.usageMonth,
				usageBytes: input.usageBytes,
				now: (input.now ?? new Date()).toISOString(),
			})
			await refreshDueHint('inbound-received', input.now)
			if (
				result.status === 'received' ||
				result.status === 'already-received'
			) {
				return toDelivery(result.delivery)
			}
			throw new InboundDeliveryLeaseLostError(
				'Inbound delivery storage lease was lost before finalization.',
			)
		},
		async commitInboundMessageGraph(input) {
			const storageLease = input.delivery.storageLease
			if (!storageLease) {
				throw new InboundDeliveryLeaseLostError(
					'Inbound graph commit requires an active storage lease.',
				)
			}
			return await mailbox.commitInboundMessageGraph({
				ownerId: userId,
				deliveryId: input.delivery.deliveryId,
				storageLease,
				thread: input.thread,
				message: input.message,
				attachments: input.attachments,
			})
		},
		async findThreadForInboundMessage(input) {
			const thread = await mailbox.findThreadForInboundMessage(input)
			return thread
				? {
						...thread,
						subjectNormalized: thread.subjectNormalized ?? '',
					}
				: null
		},
		async deferReconciliation(deliveryId: string, now = new Date()) {
			const result = await mailbox.deferInboundDeliveryReconciliation({
				ownerId: userId,
				deliveryId,
				now: now.toISOString(),
			})
			await refreshDueHint('inbound-reconcile-deferred', now)
			return result
		},
		async listDueStale(now = new Date(), limit?: number) {
			return await mailbox.listDueStaleInboundDeliveries({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
		},
		async claimCleanup(input: UserInboundDeliveryCleanupClaimInput) {
			const now = input.now ?? new Date()
			const result = await mailbox.claimInboundDeliveryCleanup({
				ownerId: userId,
				deliveryId: input.deliveryId,
				expectedState: input.expectedState,
				expectedUpdatedAt: input.expectedUpdatedAt,
				staleBefore: input.staleBefore.toISOString(),
				now: now.toISOString(),
			})
			if (result.status === 'claimed') {
				const cleanupLease = result.delivery.cleanupLease
				if (!cleanupLease) {
					throw new Error(
						'Mailbox returned a claimed inbound cleanup delivery without a lease.',
					)
				}
			}
			return result
		},
		async releaseCleanup(
			deliveryId: string,
			cleanupLease: string,
			now = new Date(),
		) {
			const result = await mailbox.releaseInboundDeliveryCleanup({
				ownerId: userId,
				deliveryId,
				cleanupLease,
				now: now.toISOString(),
			})
			await refreshDueHint('inbound-cleanup-released', now)
			return result
		},
		async markOrphanCleaned(input: UserInboundDeliveryOrphanCleanedInput) {
			const result = await mailbox.markInboundDeliveryOrphanCleaned({
				ownerId: userId,
				deliveryId: input.deliveryId,
				cleanupLease: input.cleanupLease,
				outcome: input.outcome,
				now: (input.now ?? new Date()).toISOString(),
			})
			await refreshDueHint('inbound-orphan-cleaned', input.now)
			return result
		},
		async pruneExpiredDedupe(now = new Date(), limit?: number) {
			const result = await mailbox.pruneExpiredInboundDedupePointers({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
			await refreshDueHint('inbound-dedupe-pruned', now)
			return result.pruned
		},
		async claimUsageEffect(input: UserInboundUsageEffectClaimInput) {
			const result = await mailbox.claimInboundUsageEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				expectedFinalizationToken: input.expectedFinalizationToken,
				now: (input.now ?? new Date()).toISOString(),
			})
			return result
		},
		async completeUsageEffect(input: UserInboundUsageEffectCompleteInput) {
			const result = await mailbox.completeInboundUsageEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				usageEffectLease: input.usageEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				mode: input.mode,
				usageMonth: input.usageMonth,
				usageBytes: input.usageBytes,
				usageDurationMs: input.usageDurationMs,
				now: (input.now ?? new Date()).toISOString(),
			})
			await refreshDueHint('inbound-usage-effect-complete', input.now)
			return result
		},
		async claimSubscriptionEffect(
			input: UserInboundSubscriptionEffectClaimInput,
		) {
			const result = await mailbox.claimInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				expectedFinalizationToken: input.expectedFinalizationToken,
				now: (input.now ?? new Date()).toISOString(),
			})
			return result
		},
		async completeSubscriptionEffect(
			input: UserInboundSubscriptionEffectCompleteInput,
		) {
			const result = await mailbox.completeInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				subscriptionEffectLease: input.subscriptionEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				mode: input.mode,
				suppressionReason: input.suppressionReason,
				now: (input.now ?? new Date()).toISOString(),
			})
			await refreshDueHint('inbound-subscription-effect-complete', input.now)
			return result
		},
		async failSubscriptionEffect(
			input: UserInboundSubscriptionEffectFailInput,
		) {
			const result = await mailbox.failInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				subscriptionEffectLease: input.subscriptionEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				error: input.error,
				now: (input.now ?? new Date()).toISOString(),
			})
			await refreshDueHint('inbound-subscription-effect-failed', input.now)
			return result
		},
		async listDueEffects(now = new Date(), limit?: number) {
			return await mailbox.listDueInboundEffectWork({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
		},
	} satisfies UserInboundDeliveryAuthority
}

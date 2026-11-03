import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import {
	createUserInboundDeliveryAuthority,
	type UserInboundDeliveryAuthorityEnv,
} from './inbound-delivery-authority.ts'
import { InboundDeliveryLeaseLostError } from './inbound-delivery.ts'
import { mailboxStaleInboundDeliveryAgeMs } from './mailbox-inbound-ledger.ts'
import { getInternalEmailMessageById } from './mailbox-internal-read.ts'

const staleBatchSize = 20

async function recoverCommittedDelivery(input: {
	env: UserInboundDeliveryAuthorityEnv & { EMAIL_BLOBS: R2Bucket }
	userId: OwnerId
	deliveryId: string
	now: Date
}) {
	const authority = createUserInboundDeliveryAuthority(input)
	const delivery = await authority.get(input.deliveryId)
	if (!delivery) return false
	const message = await getInternalEmailMessageById({
		env: input.env,
		ownerId: input.userId,
		messageId: delivery.messageId,
	})
	if (!message?.rawMimeKey) return false
	if (
		message.rawMimeKey !== emailRawMimeKey(input.userId, delivery.messageId)
	) {
		throw new Error(
			'Inbound message raw MIME key is outside its user namespace.',
		)
	}
	const object = await input.env.EMAIL_BLOBS.get(message.rawMimeKey)
	if (!object) return false
	const claim = await authority.claimStorage(
		delivery,
		delivery.expectedAttachmentCount ?? 0,
		delivery.usageStartedAt,
		input.now,
	)
	if (!claim.claimed) return claim.delivery?.state === 'received'
	const storageLease = claim.delivery.storageLease
	if (!storageLease) {
		throw new InboundDeliveryLeaseLostError(
			'Recovered inbound delivery has no storage lease.',
		)
	}
	try {
		await authority.receive({
			delivery: claim.delivery,
			usageDurationMs: claim.delivery.usageStartedAt
				? input.now.getTime() - Date.parse(claim.delivery.usageStartedAt)
				: 0,
			usageMonth: (message.receivedAt ?? message.createdAt).slice(0, 7),
			usageBytes: message.rawSize ?? 0,
			now: input.now,
		})
		return true
	} catch (error) {
		await authority
			.releaseStorage(claim.delivery, input.now)
			.catch(() => undefined)
		throw error
	}
}

export async function reconcileUserStaleInboundDeliveries(input: {
	env: UserInboundDeliveryAuthorityEnv & { EMAIL_BLOBS: R2Bucket }
	userId: OwnerId
	now?: Date
	deadlineMs?: number
}) {
	const now = input.now ?? new Date()
	const authority = createUserInboundDeliveryAuthority(input)
	const due = await authority.listDueStale(now, staleBatchSize)
	const staleBefore = new Date(now.getTime() - mailboxStaleInboundDeliveryAgeMs)
	let recovered = 0
	let cleaned = 0
	let budgetExhausted = false
	for (const snapshot of due.deliveries) {
		if (input.deadlineMs != null && Date.now() >= input.deadlineMs) {
			budgetExhausted = true
			break
		}
		const message = await getInternalEmailMessageById({
			env: input.env,
			ownerId: input.userId,
			messageId: snapshot.messageId,
		})
		if (message) {
			try {
				if (
					await recoverCommittedDelivery({
						env: input.env,
						userId: input.userId,
						deliveryId: snapshot.deliveryId,
						now,
					})
				) {
					recovered += 1
				} else {
					await authority.deferReconciliation(snapshot.deliveryId, now)
				}
			} catch (error) {
				console.warn(
					'inbound-email-partial-delivery-recovery-failed',
					snapshot.deliveryId,
					error,
				)
				await authority
					.deferReconciliation(snapshot.deliveryId, now)
					.catch(() => undefined)
			}
			continue
		}

		const claim = await authority.claimCleanup({
			deliveryId: snapshot.deliveryId,
			expectedState: snapshot.state,
			expectedUpdatedAt: snapshot.updatedAt,
			staleBefore,
			now,
		})
		if (claim.status !== 'claimed') continue
		const racedMessage = await getInternalEmailMessageById({
			env: input.env,
			ownerId: input.userId,
			messageId: snapshot.messageId,
		})
		if (racedMessage) {
			await authority.releaseCleanup(
				snapshot.deliveryId,
				claim.delivery.cleanupLease!,
				now,
			)
			continue
		}
		let outcome: 'deleted' | 'delete-failed' = 'deleted'
		try {
			await input.env.EMAIL_BLOBS.delete(snapshot.rawMimeKey)
		} catch (error) {
			outcome = 'delete-failed'
			console.warn(
				'inbound-email-orphan-blob-delete-failed',
				snapshot.rawMimeKey,
				error,
			)
		}
		const finalized = await authority.markOrphanCleaned({
			deliveryId: snapshot.deliveryId,
			cleanupLease: claim.delivery.cleanupLease!,
			outcome,
			now,
		})
		if (finalized.status === 'orphan-cleaned') {
			if (outcome === 'deleted') cleaned += 1
		}
	}
	return {
		recovered,
		cleaned,
		...(budgetExhausted ? { budgetExhausted: true as const } : {}),
	}
}

export async function pruneUserExpiredInboundDedupePointers(input: {
	env: UserInboundDeliveryAuthorityEnv
	userId: OwnerId
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	const authority = createUserInboundDeliveryAuthority(input)
	return await authority.pruneExpiredDedupe(now, input.limit)
}

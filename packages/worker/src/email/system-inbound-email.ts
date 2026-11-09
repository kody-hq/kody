import { recordUsage } from '#worker/usage/record-usage.ts'
import { normalizeEmailAddress, normalizeSubject } from './address.ts'
import { RetryableInboundStorageError } from './email-raw-mime-store.ts'
import { assertSystemEmailGraphAuthority } from './system-email-authority.ts'
import {
	buildInboundDelivery,
	readSystemInboundReceiveCount,
	systemInboundQuotaDay,
} from './inbound-delivery.ts'
import { scheduleInboundDeliveryEffects } from './inbound-effect-scheduler.ts'
import { evaluateEmailSenderRules } from './sender-rules.ts'
import {
	InboundRawMimeTooLargeError,
	maxSurvivableInboundRawBytes,
	mergePreparedInboundParse,
	parseForwardableEmailRawMime,
	readAndPrepareForwardableEmailRawMime,
} from './parser.ts'
import {
	deleteEmptySystemEmailThreads,
	getSystemEmailMessageById,
} from './system-email-graph-store.ts'
import {
	chargeSystemInboundDeliveryOnce,
	claimSystemInboundDeliveryStorage,
	claimSystemInboundDeliveryWindow,
	getSystemInboundDelivery,
	getSystemInboundDeliveryWindow,
	markSystemInboundDeliveryRejected,
	pruneSystemExpiredInboundDedupePointers,
	reconcileSystemStaleInboundDeliveries,
	releaseSystemInboundDeliveryStorage,
} from './system-inbound-delivery-store.ts'
import { systemInboundDeletedRejectionReason } from './system-inbound-dedupe.ts'
import { storeIdempotentSystemInboundEmail } from './system-email-service.ts'
import { recordBoundedEmailRejectionEvent } from './service.ts'
import {
	countStoredSystemEmailMessages,
	ensureSystemEmailInbox,
	systemEmailLimits,
	systemEmailOwnerId,
	type SystemEmailLocal,
} from './system-email.ts'

function warnRejectionAuditWriteFailed(error: unknown) {
	console.warn('email-rejection-audit-write-failed', error)
}

async function cleanupSystemInboundDurability(input: {
	env: Pick<Env, 'APP_DB' | 'EMAIL_BLOBS'>
}) {
	try {
		await reconcileSystemStaleInboundDeliveries({
			db: input.env.APP_DB,
			blobs: input.env.EMAIL_BLOBS,
		})
		await pruneSystemExpiredInboundDedupePointers({
			db: input.env.APP_DB,
		})
		await deleteEmptySystemEmailThreads({
			db: input.env.APP_DB,
			before: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
			limit: 20,
		})
	} catch (error) {
		console.warn(
			'inbound-email-durability-cleanup-failed',
			systemEmailOwnerId,
			error,
		)
	}
}

export async function handleSystemInboundEmail(input: {
	message: ForwardableEmailMessage
	env: Pick<
		Env,
		| 'APP_DB'
		| 'EMAIL_BLOBS'
		| 'BUNDLE_ARTIFACTS_KV'
		| 'APP_BASE_URL'
		| 'USAGE_EVENTS'
		| 'MAILBOX'
		| 'USER_METER'
	>
	recipient: string
	localPart: SystemEmailLocal
	systemDomain: string
	ctx?: ExecutionContext
}) {
	await assertSystemEmailGraphAuthority(input.env.APP_DB)
	const provisioned = await ensureSystemEmailInbox({
		db: input.env.APP_DB,
		localPart: input.localPart,
		domain: input.systemDomain,
	})
	if (!provisioned) {
		input.message.setReject('Email inbox is unavailable.')
		return
	}
	const { inbox } = provisioned
	const receiveStartedAtMs = Date.now()
	const recordReceiveUsage = async (recordInput: {
		entityId?: string | null
		outcome: 'success' | 'error'
	}) => {
		await recordUsage(input.env, {
			userId: systemEmailOwnerId,
			eventType: 'email_received',
			entityId: recordInput.entityId ?? null,
			bytes: input.message.rawSize,
			durationMs: Date.now() - receiveStartedAtMs,
			outcome: recordInput.outcome,
			actorUserId: '',
			automationSource: 'email',
		})
	}

	const systemSenderAddress = normalizeEmailAddress(input.message.from)
	if (systemSenderAddress) {
		const senderRule = await evaluateEmailSenderRules({
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			senderAddress: systemSenderAddress,
		})
		if (senderRule?.effect === 'block') {
			const reason = 'Message rejected by recipient policy.'
			input.message.setReject(reason)
			await recordBoundedEmailRejectionEvent({
				env: input.env,
				db: input.env.APP_DB,
				userId: systemEmailOwnerId,
				inboxId: inbox.id,
				recipient: input.recipient,
				reason,
				phase: 'sender-policy',
			}).catch(warnRejectionAuditWriteFailed)
			await recordReceiveUsage({ outcome: 'error' })
			return
		}
	}

	if (input.message.rawSize > maxSurvivableInboundRawBytes) {
		input.message.setReject('Recipient mailbox is over quota.')
		await recordBoundedEmailRejectionEvent({
			env: input.env,
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			inboxId: inbox.id,
			recipient: input.recipient,
			reason: `Inbound email raw MIME is too large (${input.message.rawSize} bytes, max ${maxSurvivableInboundRawBytes}).`,
			phase: 'size',
		}).catch(warnRejectionAuditWriteFailed)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}

	await cleanupSystemInboundDurability({ env: input.env })
	let prepared
	try {
		prepared = await readAndPrepareForwardableEmailRawMime(input.message, {
			maxKeptBytes: systemEmailLimits.maxMessageBytes,
		})
	} catch (error) {
		if (error instanceof InboundRawMimeTooLargeError) {
			input.message.setReject('Recipient mailbox is over quota.')
			await recordBoundedEmailRejectionEvent({
				env: input.env,
				db: input.env.APP_DB,
				userId: systemEmailOwnerId,
				inboxId: inbox.id,
				recipient: input.recipient,
				reason: error.message,
				phase: 'size',
			}).catch(warnRejectionAuditWriteFailed)
			await recordReceiveUsage({ outcome: 'error' })
			return
		}
		throw new RetryableInboundStorageError(
			'Failed to read inbound raw MIME; delivery should be retried.',
			error,
		)
	}
	const quotaNow = new Date()
	const candidateDelivery = await buildInboundDelivery({
		userId: systemEmailOwnerId,
		inboxId: inbox.id,
		recipient: input.recipient,
		envelopeFrom: input.message.from,
		rawMime: prepared.rawMime,
		quotaDay: systemInboundQuotaDay(quotaNow),
		now: quotaNow,
	})
	const activeWindow = await getSystemInboundDeliveryWindow({
		db: input.env.APP_DB,
		fingerprint: candidateDelivery.fingerprint,
		now: quotaNow,
	})
	if (activeWindow?.state === 'rejected') {
		input.message.setReject(
			activeWindow.rejectionReason ?? systemInboundDeletedRejectionReason,
		)
		return
	}
	let delivery = activeWindow ?? candidateDelivery
	let existingDelivery = await getSystemInboundDelivery({
		db: input.env.APP_DB,
		deliveryId: delivery.deliveryId,
	})
	if (!existingDelivery) {
		const storedMessages = await countStoredSystemEmailMessages({
			db: input.env.APP_DB,
		})
		if (storedMessages >= systemEmailLimits.maxStoredMessages) {
			input.message.setReject('Recipient mailbox is over quota.')
			await recordBoundedEmailRejectionEvent({
				env: input.env,
				db: input.env.APP_DB,
				userId: systemEmailOwnerId,
				inboxId: inbox.id,
				recipient: input.recipient,
				reason: `System inbox stored-message cap ${systemEmailLimits.maxStoredMessages} reached.`,
				phase: 'system-limit',
			}).catch(warnRejectionAuditWriteFailed)
			await recordReceiveUsage({ outcome: 'error' })
			return
		}
		const receivesToday = await readSystemInboundReceiveCount({
			db: input.env.APP_DB,
			localPart: input.localPart,
			day: systemInboundQuotaDay(quotaNow),
		})
		if (receivesToday >= systemEmailLimits.maxReceivesPerDay) {
			input.message.setReject('Recipient mailbox is over quota.')
			await recordBoundedEmailRejectionEvent({
				env: input.env,
				db: input.env.APP_DB,
				userId: systemEmailOwnerId,
				inboxId: inbox.id,
				recipient: input.recipient,
				reason: `System inbox daily receive cap ${systemEmailLimits.maxReceivesPerDay} reached for ${input.localPart}.`,
				phase: 'system-limit',
			}).catch(warnRejectionAuditWriteFailed)
			await recordReceiveUsage({ outcome: 'error' })
			return
		}
	}
	if (!activeWindow) {
		delivery = await claimSystemInboundDeliveryWindow({
			db: input.env.APP_DB,
			delivery: candidateDelivery,
			now: quotaNow,
		})
		if (delivery.state === 'rejected') {
			input.message.setReject(
				delivery.rejectionReason ?? systemInboundDeletedRejectionReason,
			)
			return
		}
		if (
			!existingDelivery ||
			existingDelivery.deliveryId !== delivery.deliveryId
		) {
			existingDelivery = await getSystemInboundDelivery({
				db: input.env.APP_DB,
				deliveryId: delivery.deliveryId,
			})
		}
	}
	const claim = existingDelivery
		? { delivery: existingDelivery, overLimit: false as const }
		: await chargeSystemInboundDeliveryOnce({
				db: input.env.APP_DB,
				delivery: {
					...delivery,
					quotaDay: systemInboundQuotaDay(quotaNow),
				},
				localPart: input.localPart,
				limit: systemEmailLimits.maxReceivesPerDay,
				now: quotaNow,
			})
	if (claim.overLimit || !claim.delivery) {
		input.message.setReject('Recipient mailbox is over quota.')
		await recordBoundedEmailRejectionEvent({
			env: input.env,
			db: input.env.APP_DB,
			userId: systemEmailOwnerId,
			inboxId: inbox.id,
			recipient: input.recipient,
			reason: `System inbox daily receive cap ${systemEmailLimits.maxReceivesPerDay} reached for ${input.localPart}.`,
			phase: 'system-limit',
		}).catch(warnRejectionAuditWriteFailed)
		await recordReceiveUsage({ outcome: 'error' })
		return
	}
	const claimedDelivery = claim.delivery
	if (claimedDelivery.state === 'rejected') {
		input.message.setReject(
			claimedDelivery.rejectionReason ?? 'Failed to parse inbound email.',
		)
		return
	}
	if (claimedDelivery.state === 'received') {
		const existing = await getSystemEmailMessageById({
			db: input.env.APP_DB,
			messageId: claimedDelivery.messageId,
		})
		if (existing) {
			await scheduleInboundDeliveryEffects({
				env: input.env,
				userId: systemEmailOwnerId,
				deliveryId: claimedDelivery.deliveryId,
				durationMs: Date.now() - receiveStartedAtMs,
				ctx: input.ctx,
				logLabel: 'System inbound email effect reconciliation failed',
			})
			return
		}
	}
	let parsed
	try {
		parsed = mergePreparedInboundParse(
			await parseForwardableEmailRawMime(input.message, prepared.rawMime),
			prepared,
		)
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : 'Failed to parse inbound email.'
		const transitioned = await markSystemInboundDeliveryRejected({
			db: input.env.APP_DB,
			delivery: claimedDelivery,
			reason,
		}).catch((transitionError: unknown) => {
			warnRejectionAuditWriteFailed(transitionError)
			throw transitionError
		})
		if (transitioned) input.message.setReject(reason)
		if (!transitioned) return
		await recordReceiveUsage({ outcome: 'error' })
		return
	}
	const storageClaim = await claimSystemInboundDeliveryStorage({
		db: input.env.APP_DB,
		delivery: claimedDelivery,
		expectedAttachmentCount: parsed.attachments.length,
		usageStartedAt: new Date(receiveStartedAtMs).toISOString(),
	})
	if (!storageClaim.claimed) {
		if (storageClaim.delivery?.state === 'received') return
		throw new RetryableInboundStorageError(
			'Inbound delivery is already being stored; retry the stable delivery.',
		)
	}
	if (!storageClaim.delivery) {
		throw new RetryableInboundStorageError(
			'Inbound delivery storage lease disappeared after it was claimed.',
		)
	}
	const storageDelivery = storageClaim.delivery
	let storedResult
	try {
		storedResult = await storeIdempotentSystemInboundEmail({
			db: input.env.APP_DB,
			blobs: input.env.EMAIL_BLOBS,
			delivery: storageDelivery,
			parsed,
			subjectNormalized: normalizeSubject(parsed.subject),
			now: new Date().toISOString(),
		})
	} catch (error) {
		await releaseSystemInboundDeliveryStorage({
			db: input.env.APP_DB,
			delivery: storageDelivery,
		}).catch((releaseError) => {
			console.error(
				'inbound-email-storage-lease-release-failed',
				storageDelivery.deliveryId,
				releaseError,
			)
		})
		throw error
	}
	if (!storedResult.wonFinalization) return
	await scheduleInboundDeliveryEffects({
		env: input.env,
		userId: systemEmailOwnerId,
		deliveryId: storedResult.finalizedDelivery.deliveryId,
		expectedFinalizationToken: storedResult.finalizedDelivery.finalizationToken,
		durationMs: Date.now() - receiveStartedAtMs,
		ctx: input.ctx,
		logLabel: 'System inbound email effect dispatch failed',
	})
}

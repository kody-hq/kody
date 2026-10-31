import {
	deliverabilityEffectsClaimMs,
	DeliverabilityEffectsClaimHeldError,
} from './deliverability-side-effects.ts'
import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { getSystemEmailDomain } from './platform-address.ts'
import { isSystemEmailLocal } from './system-email.ts'
import { applyOutboundEmailAbusePause } from './outbound-abuse.ts'
import { applyOutboundConsecutiveFailureTracking } from './outbound-consecutive-failures.ts'
import { dispatchEmailDeliverySubscriptionEvents } from './package-subscriptions.ts'
import { type EmailReportingEnv } from './reporting-events.ts'
import { notifyAdminsOfVerificationDeliveryFailure } from './verification-delivery-notify.ts'
import { transactionalEmailVerificationKind } from './verification-delivery.ts'

export { emailDeliveryQueueName } from './delivery-queue-names.ts'

const unmatchedRetryDelaySeconds = 30
// The consumer allows 3 retries; together they must outlast a crashed
// delivery's ledger claim, or the event lands in the DLQ unapplied.
const claimHeldRetryDelaySeconds = Math.ceil(
	deliverabilityEffectsClaimMs / 2000,
)

export async function handleEmailDeliveryQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise)
	for (const queueMessage of batch.messages) {
		try {
			const result = await processCloudflareEmailDeliveryEvent({
				env,
				reportingEnv: env as Env & EmailReportingEnv,
				body: queueMessage.body,
			})
			switch (result.outcome) {
				case 'invalid':
					queueMessage.ack()
					break
				case 'stale_transactional':
					// Older than the status already on the user row — ack so
					// the queue does not retry as unmatched.
					queueMessage.ack()
					break
				case 'recorded_transactional': {
					const status = result.event.status
					const isTerminalFailure =
						!result.event.alreadyTerminal &&
						(status === 'bounced' ||
							status === 'failed' ||
							status === 'rejected' ||
							status === 'complained')
					if (isTerminalFailure) {
						if (result.event.kind === transactionalEmailVerificationKind) {
							console.warn('email-verification-delivery-failed', {
								status,
								class: result.event.class,
							})
							await notifyAdminsOfVerificationDeliveryFailure({
								env,
								event: result.event,
								waitUntil,
							})
						} else {
							console.warn('email-destination-verification-delivery', {
								status,
								class: result.event.class,
								kind: result.event.kind,
							})
						}
					}
					queueMessage.ack()
					break
				}
				case 'unmatched':
					// System mail (`kody@`, `support@`, ...) has no mailbox or
					// transactional record, so its delivery reports can never
					// match. Allow one retry for a transactional send whose row
					// lands after the report, then ack instead of parking it.
					if (
						queueMessage.attempts > 1 &&
						isSystemSenderAddress(env, result.providerEvent?.payload.sender)
					) {
						console.info('email-delivery-event-system-sender', {
							queueMessageId: queueMessage.id,
							status: result.providerEvent?.payload.delivery.status ?? null,
						})
						queueMessage.ack()
						break
					}
					console.warn('email-delivery-event-unmatched', {
						queueMessageId: queueMessage.id,
						providerMessageId: result.providerEvent?.payload.messageId ?? null,
					})
					queueMessage.retry({ delaySeconds: unmatchedRetryDelaySeconds })
					break
				case 'stale':
					// Out-of-order events still count toward the abuse
					// thresholds when they persisted: the bounce/complaint
					// happened even when a newer status already superseded
					// it. Conflicting duplicates that were not inserted only
					// pause when persisted events back them.
					await applyOutboundEmailAbusePause({
						env,
						userId: result.message.userId,
						deliveryStatus: result.providerEvent.payload.delivery.status,
						eventRecorded: false,
						waitUntil,
					})
					queueMessage.ack()
					break
				case 'duplicate':
				case 'recorded': {
					// Abuse evaluation runs before subscription dispatch (and
					// also for replayed duplicates) so a crash or dispatch
					// failure can never skip the pause; the pause write itself
					// is idempotent.
					await applyOutboundEmailAbusePause({
						env,
						userId: result.message.userId,
						deliveryStatus: result.providerEvent.payload.delivery.status,
						eventRecorded: result.outcome === 'recorded',
						waitUntil,
					})
					// Consecutive-failure counting uses a durable per-provider-
					// event ledger separate from provider-event insert
					// idempotency. Run on recorded and duplicate so a retry
					// after a mid-flight crash still applies a pending count
					// exactly once.
					await applyOutboundConsecutiveFailureTracking({
						db: env.APP_DB,
						ownerId: result.message.userId,
						deliveryStatus: result.providerEvent.payload.delivery.status,
						providerEventId: result.providerEvent.payload.eventId,
						eventTimestamp: result.providerEvent.metadata.eventTimestamp,
						messageDeliveryStatusAt: result.message.deliveryStatusAt,
					})
					await dispatchEmailDeliverySubscriptionEvents({
						env,
						message: result.message,
						providerEvent: result.providerEvent,
						waitUntil,
					})
					queueMessage.ack()
					break
				}
				default: {
					const exhaustive: never = result
					throw new Error(
						`Unsupported email delivery queue outcome: ${JSON.stringify(exhaustive)}`,
					)
				}
			}
		} catch (error) {
			console.error('email-delivery-event-processing-failed', error)
			queueMessage.retry({
				delaySeconds:
					error instanceof DeliverabilityEffectsClaimHeldError
						? claimHeldRetryDelaySeconds
						: unmatchedRetryDelaySeconds,
			})
		}
	}
}

function isSystemSenderAddress(env: Env, sender: string | null | undefined) {
	const domain = getSystemEmailDomain(env)
	const address = sender?.trim().toLowerCase() ?? ''
	const at = address.lastIndexOf('@')
	if (!domain || at <= 0) return false
	return (
		address.slice(at + 1) === domain && isSystemEmailLocal(address.slice(0, at))
	)
}

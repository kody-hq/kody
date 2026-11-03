import { z } from 'zod'
import { recordDeliveryAlertEvent } from './delivery-alert-events.ts'
import {
	applyDeliverabilitySideEffects,
	applyDeliverabilitySideEffectsOnce,
} from './deliverability-side-effects.ts'
import type { MailboxEnv } from './mailbox-client.ts'
import type { EmailReportingEnv } from './reporting-events.ts'
import { recordProviderEmailDeliveryEvent } from './service.ts'
import {
	recordSystemEmailSendDeliveryEvent,
	systemEmailSendCursorGuard,
	type SystemEmailSendDeliveryResult,
} from './system-email-sends.ts'
import { emailDeliveryStatusValues, type EmailDeliveryStatus } from './types.ts'
import {
	recordTransactionalEmailDeliveryEvent,
	transactionalKindRecordsHardBounce,
	transactionalKindUsesDeliveryCursor,
} from './verification-delivery.ts'

const cloudflareEmailDeliveryTypeValues = [
	'cf.email.sending.message.delivered',
	'cf.email.sending.message.deferred',
	'cf.email.sending.message.bounced',
	'cf.email.sending.message.failed',
	'cf.email.sending.message.rejected',
	'cf.email.sending.message.complained',
] as const

const optionalDetailSchema = z.record(z.string(), z.unknown()).optional()

const cloudflareEmailDeliveryEventSchema = z.object({
	type: z.enum(cloudflareEmailDeliveryTypeValues),
	source: z.object({
		type: z.literal('email.sending'),
		zoneId: z.string().min(1),
		domain: z.string().min(1),
	}),
	payload: z.object({
		eventId: z.string().min(1),
		messageId: z.string().min(1),
		sender: z.string().min(1),
		recipient: z.string().min(1),
		subject: z.string().optional(),
		terminal: z.boolean(),
		delivery: z
			.object({
				status: z.enum(emailDeliveryStatusValues),
				provider: z.string().optional(),
				deliveryTimeMs: z.number().optional(),
				smtpStatusCode: z.string().optional(),
				smtpEnhancedStatusCode: z.string().optional(),
				smtpResponse: z.string().optional(),
			})
			.passthrough(),
		bounce: optionalDetailSchema,
		failure: optionalDetailSchema,
		rejection: optionalDetailSchema,
		complaint: optionalDetailSchema,
	}),
	metadata: z.object({
		accountId: z.string().min(1),
		eventSubscriptionId: z.string().min(1),
		eventSchemaVersion: z.number().int().positive(),
		eventTimestamp: z.iso.datetime(),
	}),
})

export type CloudflareEmailDeliveryEvent = z.infer<
	typeof cloudflareEmailDeliveryEventSchema
>

function statusForEventType(
	type: CloudflareEmailDeliveryEvent['type'],
): EmailDeliveryStatus {
	switch (type) {
		case 'cf.email.sending.message.delivered':
			return 'delivered'
		case 'cf.email.sending.message.deferred':
			return 'deferred'
		case 'cf.email.sending.message.bounced':
			return 'bounced'
		case 'cf.email.sending.message.failed':
			return 'failed'
		case 'cf.email.sending.message.rejected':
			return 'rejected'
		case 'cf.email.sending.message.complained':
			return 'complained'
		default: {
			const exhaustive: never = type
			throw new Error(`Unsupported email delivery event type: ${exhaustive}`)
		}
	}
}

export function parseCloudflareEmailDeliveryEvent(input: unknown) {
	const result = cloudflareEmailDeliveryEventSchema.safeParse(input)
	if (!result.success) return null
	if (
		statusForEventType(result.data.type) !== result.data.payload.delivery.status
	) {
		return null
	}
	return result.data
}

function eventHoldsLatestStatus(input: {
	message: { deliveryStatus: string | null; deliveryStatusAt: string | null }
	deliveryStatus: string
	eventTimestamp: string
}) {
	if (input.message.deliveryStatus !== input.deliveryStatus) return false
	if (!input.message.deliveryStatusAt) return false
	return (
		Date.parse(input.message.deliveryStatusAt) ===
		Date.parse(input.eventTimestamp)
	)
}

export async function processCloudflareEmailDeliveryEvent(input: {
	env: MailboxEnv & { APP_DB: D1Database }
	reportingEnv?: EmailReportingEnv
	body: unknown
	fetchImpl?: typeof fetch
}) {
	const providerEvent = parseCloudflareEmailDeliveryEvent(input.body)
	if (!providerEvent) {
		return {
			outcome: 'invalid' as const,
			providerEvent: null,
			event: null,
			message: null,
		}
	}
	const result = await recordProviderEmailDeliveryEvent({
		env: input.env,
		reportingEnv: input.reportingEnv,
		providerMessageId: providerEvent.payload.messageId,
		providerEventId: providerEvent.payload.eventId,
		deliveryStatus: providerEvent.payload.delivery.status,
		eventTimestamp: providerEvent.metadata.eventTimestamp,
		detail: {
			source: providerEvent.source,
			sender: providerEvent.payload.sender,
			recipient: providerEvent.payload.recipient,
			subject: providerEvent.payload.subject ?? null,
			terminal: providerEvent.payload.terminal,
			delivery: providerEvent.payload.delivery,
			bounce: providerEvent.payload.bounce ?? null,
			failure: providerEvent.payload.failure ?? null,
			rejection: providerEvent.payload.rejection ?? null,
			complaint: providerEvent.payload.complaint ?? null,
			metadata: providerEvent.metadata,
		},
	})
	if (result.outcome !== 'unmatched') {
		// Only the status that actually won latest-delivery writes should
		// mutate cooldowns / rejecting providers. Stale and duplicate
		// payloads can arrive after a newer `delivered` and must not
		// re-arm a 24h hold.
		// A duplicate whose status still holds the message's latest status is
		// a retry of the recorded event (maybe after a crash before these
		// ran); the ledger applies them once either way.
		if (
			result.outcome === 'recorded' ||
			(result.outcome === 'duplicate' &&
				eventHoldsLatestStatus({
					message: result.message,
					deliveryStatus: providerEvent.payload.delivery.status,
					eventTimestamp: providerEvent.metadata.eventTimestamp,
				}))
		) {
			await applyDeliverabilitySideEffectsOnce({
				db: input.env.APP_DB,
				providerEventId: providerEvent.payload.eventId,
				userId: result.message.userId,
				recipient: providerEvent.payload.recipient,
				deliveryStatus: providerEvent.payload.delivery.status,
				smtpResponse: providerEvent.payload.delivery.smtpResponse,
				smtpEnhancedStatusCode:
					providerEvent.payload.delivery.smtpEnhancedStatusCode,
				deliveryCursor: {
					providerMessageId: providerEvent.payload.messageId,
					at: providerEvent.metadata.eventTimestamp,
				},
				fetchImpl: input.fetchImpl,
			})
		}
		return { ...result, providerEvent }
	}

	// System sends (kody@ and the other reserved senders) are recorded per
	// recipient. Verification and password-reset mail is also in the
	// transactional index, which keeps owning its side effects; the system
	// record still counts the hard bounce toward full suppression.
	const systemSend = await recordSystemEmailSendDeliveryEvent({
		db: input.env.APP_DB,
		providerMessageId: providerEvent.payload.messageId,
		recipient: providerEvent.payload.recipient,
		deliveryStatus: providerEvent.payload.delivery.status,
		eventTimestamp: providerEvent.metadata.eventTimestamp,
		smtpResponse: providerEvent.payload.delivery.smtpResponse,
		smtpEnhancedStatusCode:
			providerEvent.payload.delivery.smtpEnhancedStatusCode,
		smtpStatusCode: providerEvent.payload.delivery.smtpStatusCode,
	})
	if (systemSend.outcome === 'recorded' && systemSend.suppressed) {
		console.warn('system-email-recipient-suppressed', {
			kind: systemSend.send.kind,
			status: providerEvent.payload.delivery.status,
		})
	}

	const transactional = await recordTransactionalEmailDeliveryEvent({
		db: input.env.APP_DB,
		providerMessageId: providerEvent.payload.messageId,
		deliveryStatus: providerEvent.payload.delivery.status,
		eventTimestamp: providerEvent.metadata.eventTimestamp,
		smtpResponse: providerEvent.payload.delivery.smtpResponse,
		smtpEnhancedStatusCode:
			providerEvent.payload.delivery.smtpEnhancedStatusCode,
	})
	if (transactional.outcome === 'stale') {
		// Ackable: out-of-order against an already-written verification
		// status. Must not fall through as mailbox `unmatched` (queue retry).
		return {
			outcome: 'stale_transactional' as const,
			providerEvent,
			event: null,
			message: null,
		}
	}
	if (transactional.outcome !== 'recorded') {
		return await applySystemSendDeliveryEvent({
			env: input.env,
			providerEvent,
			systemSend,
			unmatched: result,
			fetchImpl: input.fetchImpl,
		})
	}

	await applyDeliverabilitySideEffects({
		db: input.env.APP_DB,
		recipient: transactional.event.recipient || providerEvent.payload.recipient,
		deliveryStatus: providerEvent.payload.delivery.status,
		smtpResponse: providerEvent.payload.delivery.smtpResponse,
		smtpEnhancedStatusCode:
			providerEvent.payload.delivery.smtpEnhancedStatusCode,
		smtpStatusCode: providerEvent.payload.delivery.smtpStatusCode,
		fetchImpl: input.fetchImpl,
		recordVerificationSuppression: transactionalKindRecordsHardBounce(
			transactional.event.kind,
		),
		// Signup verification uses users.email_verification_delivery_* and
		// never claims the index cursor — only pass confirmCursor for kinds
		// that do, or side effects would no-op.
		confirmCursor: transactionalKindUsesDeliveryCursor(transactional.event.kind)
			? {
					providerMessageId: providerEvent.payload.messageId,
					status: providerEvent.payload.delivery.status,
					at: providerEvent.metadata.eventTimestamp,
				}
			: undefined,
	})

	await recordAlertEventForSystemMail({ db: input.env.APP_DB, providerEvent })

	return {
		outcome: 'recorded_transactional' as const,
		providerEvent,
		event: transactional.event,
		message: null,
	}
}

async function recordAlertEventForSystemMail(input: {
	db: D1Database
	providerEvent: CloudflareEmailDeliveryEvent
}) {
	const status = input.providerEvent.payload.delivery.status
	if (status !== 'bounced' && status !== 'complained') return
	await recordDeliveryAlertEvent({
		db: input.db,
		providerEventId: input.providerEvent.payload.eventId,
		provider: 'cloudflare-email',
		eventType: status,
		occurredAt: input.providerEvent.metadata.eventTimestamp,
	})
}

async function applySystemSendDeliveryEvent<Unmatched extends object>(input: {
	env: { APP_DB: D1Database }
	providerEvent: CloudflareEmailDeliveryEvent
	systemSend: SystemEmailSendDeliveryResult
	unmatched: Unmatched
	fetchImpl?: typeof fetch
}) {
	const { providerEvent, systemSend } = input
	if (systemSend.outcome === 'unmatched') {
		return { ...input.unmatched, providerEvent }
	}
	if (systemSend.outcome === 'stale') {
		return {
			outcome: 'stale_system' as const,
			providerEvent,
			event: null,
			message: null,
		}
	}
	await applyDeliverabilitySideEffects({
		db: input.env.APP_DB,
		recipient: systemSend.send.recipient,
		deliveryStatus: providerEvent.payload.delivery.status,
		smtpResponse: providerEvent.payload.delivery.smtpResponse,
		smtpEnhancedStatusCode:
			providerEvent.payload.delivery.smtpEnhancedStatusCode,
		smtpStatusCode: providerEvent.payload.delivery.smtpStatusCode,
		fetchImpl: input.fetchImpl,
		cursorGuard: systemEmailSendCursorGuard({
			db: input.env.APP_DB,
			providerMessageId: systemSend.send.providerMessageId,
			recipient: systemSend.send.recipient,
			status: providerEvent.payload.delivery.status,
			at: providerEvent.metadata.eventTimestamp,
		}),
	})
	await recordAlertEventForSystemMail({ db: input.env.APP_DB, providerEvent })
	return {
		outcome: 'recorded_system' as const,
		providerEvent,
		send: systemSend.send,
		suppressed: systemSend.suppressed,
		event: null,
		message: null,
	}
}

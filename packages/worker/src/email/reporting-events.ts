import type { EmailDeliveryStatus } from './types.ts'

export type EmailReportingEnv = {
	EMAIL_EVENTS?: AnalyticsEngineDataset
}

export type EmailReportingEvent =
	| {
			userId: string
			eventType: 'email_send' | 'email_receive'
			timestamp?: string
	  }
	| {
			userId: string
			eventType: 'email_delivery'
			outcome: EmailDeliveryStatus
			timestamp?: string
	  }

/**
 * Additive Analytics Engine schema:
 *
 * - index1: stable user id (per-user isolation)
 * - blob1: event type
 * - blob2: provider delivery outcome, or empty for send/receive
 * - blob3: source event timestamp (ISO 8601)
 * - double1: event count (always 1)
 *
 * The explicit source timestamp keeps daily provider outcomes aligned with the
 * provider event day even when a queue retry delays ingestion.
 */
export function recordEmailReportingEvent(
	env: EmailReportingEnv,
	event: EmailReportingEvent,
): void {
	try {
		if (!env.EMAIL_EVENTS || !event.userId) return
		env.EMAIL_EVENTS.writeDataPoint({
			indexes: [event.userId],
			blobs: [
				event.eventType,
				event.eventType === 'email_delivery' ? event.outcome : '',
				event.timestamp ?? new Date().toISOString(),
			],
			doubles: [1],
		})
	} catch (error) {
		console.warn('email-reporting-event-write-failed', error)
	}
}

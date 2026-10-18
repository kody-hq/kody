/**
 * Shared side effects after a Cloudflare Email Sending lifecycle event:
 * recipient cooldowns, rejecting-provider observations, and clearing both on
 * successful delivery.
 */

import {
	clearEmailRecipientCooldown,
	recordEmailRecipientCooldown,
} from './recipient-cooldown.ts'
import {
	clearRejectingProvidersForRecipient,
	recordRejectingProvidersForRecipient,
} from './rejecting-providers.ts'
import { type EmailDeliveryStatus } from './types.ts'
import {
	clearVerificationRecipientHardBounce,
	recordVerificationRecipientHardBounce,
} from './verification-recipient-suppression.ts'

export async function applyDeliverabilitySideEffects(input: {
	db: D1Database
	recipient: string
	deliveryStatus: EmailDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
	smtpStatusCode?: string | null
	/**
	 * Verification mail and password-reset mail (`password_reset`,
	 * `password_reset_confirmed`) set this. Mailbox and forwarding events
	 * must not.
	 */
	recordVerificationSuppression?: boolean
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<void> {
	const now = input.now ?? new Date()
	try {
		if (input.deliveryStatus === 'delivered') {
			await clearEmailRecipientCooldown({
				db: input.db,
				recipient: input.recipient,
			})
			await clearRejectingProvidersForRecipient({
				db: input.db,
				recipient: input.recipient,
				now,
				fetchImpl: input.fetchImpl,
			})
			await clearVerificationRecipientHardBounce({
				db: input.db,
				recipient: input.recipient,
			})
			return
		}

		await recordEmailRecipientCooldown({
			db: input.db,
			recipient: input.recipient,
			status: input.deliveryStatus,
			smtpResponse: input.smtpResponse,
			smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
			now,
		})
		await recordRejectingProvidersForRecipient({
			db: input.db,
			recipient: input.recipient,
			status: input.deliveryStatus,
			smtpResponse: input.smtpResponse,
			smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
			now,
			fetchImpl: input.fetchImpl,
		})
		if (input.recordVerificationSuppression) {
			await recordVerificationRecipientHardBounce({
				db: input.db,
				recipient: input.recipient,
				status: input.deliveryStatus,
				smtpResponse: input.smtpResponse,
				smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
				smtpStatusCode: input.smtpStatusCode,
				now,
			})
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		// Pre-migration / stripped workers fixtures omit policy tables. Fail
		// open quietly so delivery-event processing still acks.
		if (
			error instanceof TypeError ||
			/no such table/i.test(message) ||
			/SQLITE_ERROR/i.test(message)
		) {
			return
		}
		console.warn('email-deliverability-side-effects-failed', error)
	}
}

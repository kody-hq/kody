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
	transactionalDeliveryCursorIsDelivered,
	transactionalDeliveryCursorMatches,
} from './verification-delivery.ts'
import {
	clearVerificationRecipientHardBounce,
	recordVerificationRecipientHardBounce,
} from './verification-recipient-suppression.ts'

const deliverabilityEffectsClaimMs = 2 * 60 * 1000

/**
 * Runs `apply` once per provider event across queue retries. A crash after
 * the event row is saved leaves the ledger row unapplied, so the retry (seen
 * as a duplicate event) applies it. A short claim keeps two concurrent
 * deliveries of the same event from both applying; the loser throws so the
 * queue retries it after the winner marks the row applied.
 */
export async function applyDeliverabilitySideEffectsOnce(input: {
	db: D1Database
	providerEventId: string
	userId: string
	apply: () => Promise<void>
	now?: Date
}): Promise<void> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const claimExpiredBefore = new Date(
		now.getTime() - deliverabilityEffectsClaimMs,
	).toISOString()
	await input.db
		.prepare(
			`INSERT OR IGNORE INTO email_deliverability_effects (
				provider_event_id, user_id, created_at, claimed_at, applied_at
			) VALUES (?, ?, ?, NULL, NULL)`,
		)
		.bind(input.providerEventId, input.userId, nowIso)
		.run()
	const claim = await input.db
		.prepare(
			`UPDATE email_deliverability_effects SET claimed_at = ?
			WHERE provider_event_id = ? AND applied_at IS NULL
				AND (claimed_at IS NULL OR claimed_at <= ?)`,
		)
		.bind(nowIso, input.providerEventId, claimExpiredBefore)
		.run()
	if ((claim.meta.changes ?? 0) === 0) {
		const row = await input.db
			.prepare(
				`SELECT applied_at FROM email_deliverability_effects
				WHERE provider_event_id = ?`,
			)
			.bind(input.providerEventId)
			.first<{ applied_at: string | null }>()
		if (row?.applied_at != null) return
		throw new Error(
			`Deliverability side effects for provider event ${input.providerEventId} are being applied by another delivery`,
		)
	}
	try {
		await input.apply()
	} catch (error) {
		await input.db
			.prepare(
				`UPDATE email_deliverability_effects SET claimed_at = NULL
				WHERE provider_event_id = ? AND claimed_at = ? AND applied_at IS NULL`,
			)
			.bind(input.providerEventId, nowIso)
			.run()
		throw error
	}
	await input.db
		.prepare(
			`UPDATE email_deliverability_effects SET applied_at = ?
			WHERE provider_event_id = ? AND applied_at IS NULL`,
		)
		.bind(nowIso, input.providerEventId)
		.run()
}

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
	/**
	 * When set, skip (and undo) mutations unless the transactional delivery
	 * cursor still names this exact event. Prevents an older bounce from
	 * re-arming holds after a newer delivered event claimed the cursor.
	 */
	confirmCursor?: {
		providerMessageId: string
		status: string
		at: string
	}
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<void> {
	const now = input.now ?? new Date()
	const cursorStillOwnsEvent = async () => {
		if (!input.confirmCursor) return true
		return await transactionalDeliveryCursorMatches({
			db: input.db,
			providerMessageId: input.confirmCursor.providerMessageId,
			status: input.confirmCursor.status,
			at: input.confirmCursor.at,
		})
	}
	try {
		if (!(await cursorStillOwnsEvent())) return

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

		// A newer delivered event may have claimed the cursor while we were
		// writing failure holds. Only undo when delivered won — a newer
		// bounce/failed claim must keep its own holds.
		if (
			input.confirmCursor &&
			!(await cursorStillOwnsEvent()) &&
			(await transactionalDeliveryCursorIsDelivered({
				db: input.db,
				providerMessageId: input.confirmCursor.providerMessageId,
			}))
		) {
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

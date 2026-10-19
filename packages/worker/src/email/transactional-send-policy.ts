/**
 * Gate for platform transactional mail (kody@ / system domain).
 *
 * - Essential mail always attempts the send, subject only to per-recipient
 *   cooldown after a final (or deferred blocklist) failure.
 * - Holdable mail is also skipped when the recipient's MX provider is
 *   currently rejecting kody.codes (observed from delivery events, with a
 *   static MX seed as fallback).
 */

import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { type OutboundEmail } from '@kody-internal/shared/outbound-email.ts'
import {
	assertEmailRecipientSendable,
	emailRecipientCooldownBlockedMessage,
} from './recipient-cooldown.ts'
import {
	emailProviderHoldMessage,
	findActiveRejectingProviderForRecipient,
} from './rejecting-providers.ts'
import { loadVerificationRecipientHardBounce } from './verification-recipient-suppression.ts'
import {
	transactionalPasswordResetConfirmedKind,
	transactionalPasswordResetKind,
} from './verification-delivery.ts'

export const transactionalEmailCategories = ['essential', 'holdable'] as const
export type TransactionalEmailCategory =
	(typeof transactionalEmailCategories)[number]

export const essentialTransactionalEmailKinds = [
	'email_verification',
	'email_change',
	'email_destination_verification',
	'email_claim_release',
	'password_reset',
	'password_reset_confirmed',
	'billing_success',
	'payment_failed',
	'past_due',
	'credits_auto_refilled',
	'credits_monthly_cap',
	'credits_low_balance',
	'org_billing',
	'org_budget_hit',
	'platform_feedback_acknowledgement',
	'platform_feedback_outcome',
] as const

export const holdableTransactionalEmailKinds = [
	'connect_agent',
	'advocate_referral',
	'keep_package',
	'second_agent',
	'cooling_home',
	'entitlement_warning',
	'error_rate',
] as const

export type EssentialTransactionalEmailKind =
	(typeof essentialTransactionalEmailKinds)[number]
export type HoldableTransactionalEmailKind =
	(typeof holdableTransactionalEmailKinds)[number]
export type TransactionalEmailKind =
	| EssentialTransactionalEmailKind
	| HoldableTransactionalEmailKind

const essentialKindSet = new Set<string>(essentialTransactionalEmailKinds)
const holdableKindSet = new Set<string>(holdableTransactionalEmailKinds)

export function categoryForTransactionalEmailKind(
	kind: string,
): TransactionalEmailCategory {
	if (essentialKindSet.has(kind)) return 'essential'
	if (holdableKindSet.has(kind)) return 'holdable'
	// Unknown kinds fail closed as holdable so a new campaign cannot bypass
	// the provider hold by accident.
	return 'holdable'
}

export type TransactionalSendGateResult =
	| { allowed: true }
	| {
			allowed: false
			code: 'recipient_cooldown' | 'provider_hold' | 'recipient_hard_bounce'
			message: string
			providerKey?: string
			cooldownUntil?: string
	  }

function isPasswordResetKind(kind: string | undefined) {
	return (
		kind === transactionalPasswordResetKind ||
		kind === transactionalPasswordResetConfirmedKind
	)
}

export async function gateTransactionalSend(input: {
	db: D1Database
	recipient: string
	category: TransactionalEmailCategory
	kind?: string
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<TransactionalSendGateResult> {
	// Fail open when policy tables are missing or the lookup errors: a broken
	// gate must not take down essential or holdable transactional mail.
	try {
		if (isPasswordResetKind(input.kind)) {
			const hardBounce = await loadVerificationRecipientHardBounce({
				db: input.db,
				recipient: input.recipient,
			})
			if (hardBounce) {
				return {
					allowed: false,
					code: 'recipient_hard_bounce',
					message:
						'Password reset email was not sent because this address previously hard-bounced.',
				}
			}
		}

		const cooldown = await assertEmailRecipientSendable({
			db: input.db,
			recipient: input.recipient,
			now: input.now,
		})
		if (!cooldown.ok) {
			return {
				allowed: false,
				code: 'recipient_cooldown',
				message: cooldown.message,
				cooldownUntil: cooldown.cooldownUntil,
			}
		}

		if (input.category === 'essential') {
			return { allowed: true }
		}

		const rejectingProvider = await findActiveRejectingProviderForRecipient({
			db: input.db,
			recipient: input.recipient,
			now: input.now,
			fetchImpl: input.fetchImpl,
		})
		if (rejectingProvider) {
			return {
				allowed: false,
				code: 'provider_hold',
				message: emailProviderHoldMessage,
				providerKey: rejectingProvider,
			}
		}
		return { allowed: true }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		// Pre-migration schemas, stripped test doubles, and missing `.first`
		// stubs must not take down mail. Unexpected errors still warn.
		if (
			error instanceof TypeError ||
			/no such table/i.test(message) ||
			/\.first is not a function/i.test(message)
		) {
			return { allowed: true }
		}
		console.warn('transactional-send-gate-failed', error)
		return { allowed: true }
	}
}

type CloudflareConfig = {
	accountId?: string
	apiBaseUrl?: string
	apiToken?: string
}

export type GatedTransactionalSendResult =
	| Awaited<ReturnType<typeof sendCloudflareEmail>>
	| {
			ok: false
			skipped: true
			hold: true
			error: string
			code: 'recipient_cooldown' | 'provider_hold' | 'recipient_hard_bounce'
			providerKey?: string
			cooldownUntil?: string
	  }

/**
 * Run the transactional send gate, then Cloudflare Email Sending. Hold and
 * cooldown outcomes look like a skipped send so callers that already treat
 * `ok: false` as non-throwing keep working.
 */
export async function sendGatedTransactionalEmail(input: {
	db: D1Database
	config: CloudflareConfig
	category: TransactionalEmailCategory
	kind: string
	message: Omit<OutboundEmail, 'replyTo' | 'headers' | 'attachments'> &
		Partial<Pick<OutboundEmail, 'replyTo' | 'headers' | 'attachments'>>
	now?: Date
	fetchImpl?: typeof fetch
}): Promise<GatedTransactionalSendResult> {
	const recipient = Array.isArray(input.message.to)
		? input.message.to[0]
		: input.message.to
	if (!recipient) {
		return {
			ok: false,
			error: 'Transactional email requires a recipient.',
		}
	}

	const gate = await gateTransactionalSend({
		db: input.db,
		recipient,
		category: input.category,
		kind: input.kind,
		now: input.now,
		fetchImpl: input.fetchImpl,
	})
	if (!gate.allowed) {
		console.info('transactional-email-held', {
			kind: input.kind,
			code: gate.code,
			providerKey: gate.providerKey ?? null,
		})
		return {
			ok: false,
			skipped: true,
			hold: true,
			error: gate.message,
			code: gate.code,
			providerKey: gate.providerKey,
			cooldownUntil: gate.cooldownUntil,
		}
	}

	return await sendCloudflareEmail(input.config, input.message)
}

export { emailProviderHoldMessage, emailRecipientCooldownBlockedMessage }

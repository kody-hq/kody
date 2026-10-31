/**
 * Per-recipient send cooldowns after terminal delivery failures.
 *
 * Blocklist / DBL / "blacklisted" rejections (including deferred 4xx that end
 * in a final failure) use class `sender_block` with a longer cooldown so we
 * stop hammering providers that are rejecting kody.codes. Other terminal
 * failures get a shorter cooldown.
 */

import { normalizeEmailAddress } from './address.ts'
import { classifyVerificationDeliveryFailure } from './verification-delivery.ts'
import { type EmailDeliveryStatus } from './types.ts'
import {
	isEmailVerificationDeliveryStatus,
	type EmailVerificationDeliveryClass,
	type EmailVerificationDeliveryStatus,
} from '#universal/email-verification-delivery.ts'

export const emailRecipientSenderBlockCooldownMs = 24 * 60 * 60 * 1000
export const emailRecipientOtherFailureCooldownMs = 60 * 60 * 1000

export const emailRecipientCooldownBlockedMessage =
	'Your mail provider is blocking our domain right now, try another address.'

export type EmailRecipientCooldown = {
	recipient: string
	class: EmailVerificationDeliveryClass
	reason: string | null
	cooldownUntil: string
	lastFailureAt: string
	failureCount: number
}

function cooldownMsForClass(deliveryClass: EmailVerificationDeliveryClass) {
	return deliveryClass === 'sender_block'
		? emailRecipientSenderBlockCooldownMs
		: emailRecipientOtherFailureCooldownMs
}

export function isTerminalDeliveryFailureStatus(
	status: string,
): status is EmailVerificationDeliveryStatus {
	return (
		isEmailVerificationDeliveryStatus(status) &&
		(status === 'bounced' ||
			status === 'failed' ||
			status === 'rejected' ||
			status === 'complained')
	)
}

/**
 * Classify a provider lifecycle update for recipient cooldown. Deferred
 * events with a blocklist SMTP response count as `sender_block` so we stop
 * resending while Cloudflare is still retrying the same 4xx.
 */
export function classifyRecipientDeliveryFailure(input: {
	status: EmailDeliveryStatus | EmailVerificationDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
}): EmailVerificationDeliveryClass | null {
	if (input.status === 'deferred') {
		const deferredClass = classifyVerificationDeliveryFailure({
			status: 'failed',
			smtpResponse: input.smtpResponse,
			smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
		})
		return deferredClass === 'sender_block' ? 'sender_block' : null
	}
	return classifyVerificationDeliveryFailure(input)
}

export async function loadEmailRecipientCooldown(input: {
	db: D1Database
	recipient: string
	now?: Date
}): Promise<EmailRecipientCooldown | null> {
	const recipient = normalizeEmailAddress(input.recipient)
	if (!recipient) return null
	const now = input.now ?? new Date()
	const row = await input.db
		.prepare(
			`SELECT recipient, class, reason, cooldown_until, last_failure_at, failure_count
			 FROM email_recipient_cooldowns
			 WHERE recipient = ?`,
		)
		.bind(recipient)
		.first<{
			recipient: string
			class: string
			reason: string | null
			cooldown_until: string
			last_failure_at: string
			failure_count: number
		}>()
	if (!row) return null
	const untilMs = Date.parse(row.cooldown_until)
	if (!Number.isFinite(untilMs) || untilMs <= now.getTime()) {
		return null
	}
	if (row.class !== 'sender_block' && row.class !== 'other') return null
	return {
		recipient: row.recipient,
		class: row.class,
		reason: row.reason,
		cooldownUntil: row.cooldown_until,
		lastFailureAt: row.last_failure_at,
		failureCount: row.failure_count,
	}
}

export async function assertEmailRecipientSendable(input: {
	db: D1Database
	recipient: string
	now?: Date
}): Promise<
	| { ok: true }
	| {
			ok: false
			code: 'recipient_cooldown'
			class: EmailVerificationDeliveryClass
			message: string
			cooldownUntil: string
	  }
> {
	const active = await loadEmailRecipientCooldown(input)
	if (!active) return { ok: true }
	return {
		ok: false,
		code: 'recipient_cooldown',
		class: active.class,
		message:
			active.class === 'sender_block'
				? emailRecipientCooldownBlockedMessage
				: 'Delivery to this address recently failed. Wait before sending again, or try another address.',
		cooldownUntil: active.cooldownUntil,
	}
}

/** Extra SQL condition (and its binds) a guarded write must satisfy. */
export type EmailPolicyWriteGuard = { sql: string; binds: Array<unknown> }

type EmailRecipientCooldownInput = {
	db: D1Database
	recipient: string
	status: EmailDeliveryStatus | EmailVerificationDeliveryStatus
	smtpResponse?: string | null
	smtpEnhancedStatusCode?: string | null
	now?: Date
}

/**
 * Builds the cooldown upsert without running it, so a caller can commit it
 * in one batch with its own bookkeeping. With `onlyIf`, the row is written
 * only when that condition holds at commit time.
 */
export function prepareEmailRecipientCooldownUpsert(
	input: EmailRecipientCooldownInput & { onlyIf?: EmailPolicyWriteGuard },
): { statement: D1PreparedStatement; cooldown: EmailRecipientCooldown } | null {
	const recipient = normalizeEmailAddress(input.recipient)
	if (!recipient) return null
	const deliveryClass = classifyRecipientDeliveryFailure({
		status: input.status,
		smtpResponse: input.smtpResponse,
		smtpEnhancedStatusCode: input.smtpEnhancedStatusCode,
	})
	if (!deliveryClass) return null
	if (
		input.status !== 'deferred' &&
		!isTerminalDeliveryFailureStatus(input.status)
	) {
		return null
	}
	// Deferred only records when it is a sender block; other deferrals retry.
	if (input.status === 'deferred' && deliveryClass !== 'sender_block') {
		return null
	}

	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const cooldownUntil = new Date(
		now.getTime() + cooldownMsForClass(deliveryClass),
	).toISOString()
	const reason = truncateReason(
		input.smtpResponse ?? input.smtpEnhancedStatusCode ?? null,
	)

	const statement = input.db
		.prepare(
			`INSERT INTO email_recipient_cooldowns (
				recipient, class, reason, cooldown_until, last_failure_at,
				failure_count, created_at, updated_at
			 ) SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE ${input.onlyIf?.sql ?? '1'}
			 ON CONFLICT(recipient) DO UPDATE SET
				class = excluded.class,
				reason = excluded.reason,
				cooldown_until = CASE
					WHEN excluded.cooldown_until > email_recipient_cooldowns.cooldown_until
					THEN excluded.cooldown_until
					ELSE email_recipient_cooldowns.cooldown_until
				END,
				last_failure_at = excluded.last_failure_at,
				failure_count = email_recipient_cooldowns.failure_count + 1,
				updated_at = excluded.updated_at`,
		)
		.bind(
			recipient,
			deliveryClass,
			reason,
			cooldownUntil,
			nowIso,
			nowIso,
			nowIso,
			...(input.onlyIf?.binds ?? []),
		)

	return {
		statement,
		cooldown: {
			recipient,
			class: deliveryClass,
			reason,
			cooldownUntil,
			lastFailureAt: nowIso,
			failureCount: 1,
		},
	}
}

export async function recordEmailRecipientCooldown(
	input: EmailRecipientCooldownInput,
): Promise<EmailRecipientCooldown | null> {
	const prepared = prepareEmailRecipientCooldownUpsert(input)
	if (!prepared) return null
	await prepared.statement.run()
	return prepared.cooldown
}

export async function clearEmailRecipientCooldown(input: {
	db: D1Database
	recipient: string
}) {
	const recipient = normalizeEmailAddress(input.recipient)
	if (!recipient) return
	await input.db
		.prepare(`DELETE FROM email_recipient_cooldowns WHERE recipient = ?`)
		.bind(recipient)
		.run()
}

function truncateReason(value: string | null) {
	if (!value) return null
	const trimmed = value.trim()
	if (!trimmed) return null
	return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed
}

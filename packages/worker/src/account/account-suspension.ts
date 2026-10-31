/**
 * Platform account suspension and outbound-email pause reads.
 *
 * `users.suspended_at` is an operator-set kill switch checked at the
 * browser-session, MCP, package-app, webhook-ingress, background-identity
 * (`resolveBackgroundMcpUser`), and email chokepoints (unlike a community
 * ban, which only blocks community-surface actions). `orgs.email_outbound_paused_at`
 * is the automatic outbound-email pause set by the delivery-event abuse
 * monitor (see `#worker/email/outbound-abuse.ts`); cleared by an admin from
 * the admin users page. `orgs.email_outbound_delivery_paused_at` is set after
 * consecutive terminal delivery failures on that mailbox owner org and can be
 * cleared by an owner from Account → Email while that org is selected.
 * Outbound send gates the mailbox owner (`input.userId`), not only the
 * actor's personal org.
 */

import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const accountSuspendedMessage =
	'This account is suspended. Email support@kody.codes to appeal.'

export const accountSuspendedErrorCode = 'account_suspended' as const

/**
 * Thrown when background work (jobs, package invocations, workflows, and
 * realtime hooks) resolves the identity of a suspended account.
 * Not transient: callers must not retry it as an infrastructure blip.
 */
export class AccountSuspendedError extends Error {
	readonly code = accountSuspendedErrorCode

	constructor() {
		super(accountSuspendedMessage)
		this.name = 'AccountSuspendedError'
	}
}

export function isAccountSuspendedError(
	error: unknown,
): error is AccountSuspendedError {
	return error instanceof AccountSuspendedError
}

export type AccountRestrictions = {
	suspendedAt: string | null
	emailOutboundPausedAt: string | null
	emailOutboundDeliveryPausedAt: string | null
}

/**
 * Read the restriction flags for the account behind a stable MCP userId.
 * Returns null when no account matches (callers already fail closed on
 * unknown accounts through their own identity gates).
 */
export async function getAccountRestrictionsByStableUserId(input: {
	db: D1Database
	stableUserId: string
}): Promise<AccountRestrictions | null> {
	const stableUserId = input.stableUserId.trim()
	if (!stableUserId) return null
	const row = await input.db
		.prepare(
			`SELECT u.suspended_at, o.email_outbound_paused_at,
			        o.email_outbound_delivery_paused_at
			 FROM users u
			 LEFT JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)${andLiveDeletedAtSql('o')}
			 WHERE u.stable_user_id = ?${andLiveDeletedAtSql('u')}`,
		)
		.bind(stableUserId)
		.first<{
			suspended_at: string | null
			email_outbound_paused_at: string | null
			email_outbound_delivery_paused_at: string | null
		}>()
	if (!row) return null
	return {
		suspendedAt: row.suspended_at,
		emailOutboundPausedAt: row.email_outbound_paused_at,
		emailOutboundDeliveryPausedAt: row.email_outbound_delivery_paused_at,
	}
}

/**
 * Whether the account is suspended, resolved the same way as
 * `isAccountEmailVerified`: when both the email and the stable id are
 * present (typical MCP grant props) the pair must match one row, so a
 * stale grant email owned by another account can never be consulted.
 */
export async function isAccountSuspended(input: {
	db: D1Database
	email?: string | null
	stableUserId?: string | null
}): Promise<boolean> {
	const normalizedEmail =
		typeof input.email === 'string' ? normalizeEmail(input.email) : ''
	const stableUserId = input.stableUserId?.trim() ?? ''

	if (normalizedEmail && stableUserId) {
		const row = await input.db
			.prepare(
				`SELECT suspended_at FROM users
				 WHERE email = ? AND stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(normalizedEmail, stableUserId)
			.first<{ suspended_at: string | null }>()
		return Boolean(row?.suspended_at)
	}

	if (normalizedEmail) {
		const row = await input.db
			.prepare(
				`SELECT suspended_at FROM users WHERE email = ?${andLiveDeletedAtSql()}`,
			)
			.bind(normalizedEmail)
			.first<{ suspended_at: string | null }>()
		return Boolean(row?.suspended_at)
	}

	if (!stableUserId) return false
	const row = await input.db
		.prepare(
			`SELECT suspended_at FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{ suspended_at: string | null }>()
	return Boolean(row?.suspended_at)
}

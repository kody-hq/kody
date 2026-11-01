import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type PlatformFeedbackSubmitterMailTarget = {
	email: string
	emailVerifiedAt?: string | null
	suspendedAt: string | null
	emailOutboundPausedAt: string | null
}

export const platformFeedbackSubmitterUnreachableReasons = [
	'account_not_found',
	'no_email',
	'account_suspended',
	'email_outbound_paused',
] as const

export type PlatformFeedbackSubmitterUnreachableReason =
	(typeof platformFeedbackSubmitterUnreachableReasons)[number]

/** Whether Kody can mail the submitter, without the address itself. */
export type PlatformFeedbackSubmitterContact = {
	reachable: boolean
	emailVerified: boolean
	unreachableReason: PlatformFeedbackSubmitterUnreachableReason | null
}

export async function readPlatformFeedbackSubmitterMailTarget(input: {
	db: D1Database
	stableUserId: string
}): Promise<PlatformFeedbackSubmitterMailTarget | null> {
	const stableUserId = input.stableUserId.trim()
	if (!stableUserId) return null
	const row = await input.db
		.prepare(
			`SELECT u.email, u.suspended_at, o.email_outbound_paused_at
			 FROM users u
			 LEFT JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)${andLiveDeletedAtSql('o')}
			 WHERE u.stable_user_id = ?${andLiveDeletedAtSql('u')}`,
		)
		.bind(stableUserId)
		.first<{
			email: string | null
			suspended_at: string | null
			email_outbound_paused_at: string | null
		}>()
	if (!row) return null
	return {
		email: row.email?.trim() ?? '',
		suspendedAt: row.suspended_at,
		emailOutboundPausedAt: row.email_outbound_paused_at,
	}
}

export function isPlatformFeedbackSubmitterMailable(
	submitter: PlatformFeedbackSubmitterMailTarget | null,
): submitter is PlatformFeedbackSubmitterMailTarget & { email: string } {
	return Boolean(
		submitter?.email &&
		!submitter.suspendedAt &&
		!submitter.emailOutboundPausedAt,
	)
}

export function describePlatformFeedbackSubmitterContact(
	submitter: PlatformFeedbackSubmitterMailTarget | null,
): PlatformFeedbackSubmitterContact {
	const unreachableReason: PlatformFeedbackSubmitterUnreachableReason | null =
		!submitter
			? 'account_not_found'
			: !submitter.email
				? 'no_email'
				: submitter.suspendedAt
					? 'account_suspended'
					: submitter.emailOutboundPausedAt
						? 'email_outbound_paused'
						: null
	return {
		reachable: unreachableReason === null,
		emailVerified: Boolean(submitter?.email && submitter.emailVerifiedAt),
		unreachableReason,
	}
}

export async function readPlatformFeedbackSubmitterContact(input: {
	db: D1Database
	stableUserId: string
}): Promise<PlatformFeedbackSubmitterContact> {
	const target = await readPlatformFeedbackSubmitterMailTarget(input)
	if (!target?.email) return describePlatformFeedbackSubmitterContact(target)
	const verified = await input.db
		.prepare(
			`SELECT email_verified_at FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.stableUserId.trim())
		.first<{ email_verified_at: string | null }>()
	return describePlatformFeedbackSubmitterContact({
		...target,
		emailVerifiedAt: verified?.email_verified_at ?? null,
	})
}

export async function releasePlatformFeedbackEmailClaim(
	kv: KVNamespace,
	key: string,
	logTag: string,
) {
	try {
		await kv.delete(key)
	} catch (error) {
		console.warn(logTag, {
			key,
			error,
		})
	}
}

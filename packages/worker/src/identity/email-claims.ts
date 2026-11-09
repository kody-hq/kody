import { emailClaimState, type EmailClaimStatus } from './email-claim-state.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import {
	mintPersonId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type { EmailClaimStatus } from './email-claim-state.ts'

export type ActiveEmailClaim = {
	userId: number
	email: string
	status: EmailClaimStatus
	claimedAt: string
	releasedAt: string | null
}

export type FormerEmailClaim = {
	email: string
	claimedAt: string
}

export type AllocateSignupIdentityResult =
	| { ok: true; stableUserId: PersonId }
	| { ok: false; reason: 'current_email' | 'former_email_claimed' }

export type ReleasableEmailClaimResult =
	| { ok: true; email: string }
	| {
			ok: false
			reason: 'current_email' | 'not_claimed' | 'already_released'
	  }

export async function findActiveEmailClaim(
	db: D1Database,
	email: string,
): Promise<ActiveEmailClaim | null> {
	const normalized = normalizeEmail(email)
	if (!normalized) return null
	const row = await db
		.prepare(
			`SELECT user_id, email, status, claimed_at, released_at
			 FROM user_email_claims
			 WHERE email = ? AND status = 'claimed'`,
		)
		.bind(normalized)
		.first<{
			user_id: number
			email: string
			status: EmailClaimStatus
			claimed_at: string
			released_at: string | null
		}>()
	if (!row) return null
	return {
		userId: row.user_id,
		email: row.email,
		status: row.status,
		claimedAt: row.claimed_at,
		releasedAt: row.released_at,
	}
}

export async function listFormerEmailClaims(
	db: D1Database,
	input: { userId: number; currentEmail: string },
): Promise<Array<FormerEmailClaim>> {
	const currentEmail = normalizeEmail(input.currentEmail)
	const rows = await db
		.prepare(
			`SELECT email, claimed_at
			 FROM user_email_claims
			 WHERE user_id = ? AND status = 'claimed' AND email != ?
			 ORDER BY claimed_at ASC, email ASC`,
		)
		.bind(input.userId, currentEmail)
		.all<{ email: string; claimed_at: string }>()
	return (rows.results ?? []).map((row) => ({
		email: row.email,
		claimedAt: row.claimed_at,
	}))
}

/**
 * True when another account currently uses this address as login or holds an
 * active former-email claim.
 */
export async function isEmailReservedForOtherAccount(
	db: D1Database,
	email: string,
	exceptUserId?: number,
) {
	const normalized = normalizeEmail(email)
	if (!normalized) return false

	const currentOwner = await db
		.prepare(`SELECT id FROM users WHERE email = ?${andLiveDeletedAtSql()}`)
		.bind(normalized)
		.first<{ id: number }>()
	if (currentOwner && currentOwner.id !== exceptUserId) return true

	const active = await findActiveEmailClaim(db, normalized)
	return Boolean(active && active.userId !== exceptUserId)
}

export async function resolveReleasableEmailClaim(input: {
	db: D1Database
	userId: number
	currentEmail: string
	email: string
}): Promise<ReleasableEmailClaimResult> {
	const email = normalizeEmail(input.email)
	if (!email) return { ok: false, reason: 'not_claimed' }
	if (email === normalizeEmail(input.currentEmail)) {
		return { ok: false, reason: 'current_email' }
	}

	const active = await findActiveEmailClaim(input.db, email)
	if (active) {
		if (active.userId !== input.userId) {
			return { ok: false, reason: 'not_claimed' }
		}
		return { ok: true, email }
	}

	const ownReleased = await input.db
		.prepare(
			`SELECT 1 AS present
			 FROM user_email_claims
			 WHERE user_id = ? AND email = ? AND status = 'released'`,
		)
		.bind(input.userId, email)
		.first<{ present: number }>()
	if (ownReleased) return { ok: false, reason: 'already_released' }
	return { ok: false, reason: 'not_claimed' }
}

export async function claimAccountEmail(
	db: D1Database,
	input: { userId: number; email: string; now?: Date },
) {
	const email = normalizeEmail(input.email)
	if (!email) {
		throw new Error('Email is required to claim.')
	}
	const now = (input.now ?? new Date()).toISOString()
	const existing = await db
		.prepare(
			`SELECT id, user_id, status
			 FROM user_email_claims
			 WHERE user_id = ? AND email = ?`,
		)
		.bind(input.userId, email)
		.first<{ id: number; user_id: number; status: EmailClaimStatus }>()

	if (existing) {
		if (existing.status === 'claimed') return
		emailClaimState.assert(existing.status, 'claimed')
		await db
			.prepare(
				`UPDATE user_email_claims
				 SET status = 'claimed',
				     claimed_at = ?,
				     released_at = NULL,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.bind(now, now, existing.id)
			.run()
		return
	}

	try {
		await db
			.prepare(
				`INSERT INTO user_email_claims (user_id, email, status, claimed_at, updated_at)
				 VALUES (?, ?, 'claimed', ?, ?)`,
			)
			.bind(input.userId, email, now, now)
			.run()
	} catch (error) {
		if (getUniqueConstraintField(error) === 'email') {
			throw new EmailClaimConflictError(email)
		}
		throw error
	}
}

export async function releaseAccountEmailClaim(
	db: D1Database,
	input: { userId: number; email: string; now?: Date },
) {
	const email = normalizeEmail(input.email)
	if (!email) {
		throw new Error('Email is required to release.')
	}
	const now = (input.now ?? new Date()).toISOString()
	const existing = await db
		.prepare(
			`SELECT id, status
			 FROM user_email_claims
			 WHERE user_id = ? AND email = ?`,
		)
		.bind(input.userId, email)
		.first<{ id: number; status: EmailClaimStatus }>()

	if (existing) {
		if (existing.status === 'released') return
		emailClaimState.assert(existing.status, 'released')
		await db
			.prepare(
				`UPDATE user_email_claims
				 SET status = 'released',
				     released_at = ?,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.bind(now, now, existing.id)
			.run()
		return
	}

	await db
		.prepare(
			`INSERT INTO user_email_claims (
				user_id, email, status, claimed_at, released_at, updated_at
			 ) VALUES (?, ?, 'released', ?, ?, ?)`,
		)
		.bind(input.userId, email, now, now, now)
		.run()
}

export async function countRecentEmailClaimReleases(
	db: D1Database,
	input: { userId: number; windowSeconds: number; now?: Date },
) {
	const now = input.now ?? new Date()
	const since = new Date(
		now.getTime() - input.windowSeconds * 1000,
	).toISOString()
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM user_email_claims
			 WHERE user_id = ? AND status = 'released' AND released_at >= ?`,
		)
		.bind(input.userId, since)
		.first<{ count: number }>()
	return row?.count ?? 0
}

export async function allocateSignupIdentity(
	db: D1Database,
	email: string,
): Promise<AllocateSignupIdentityResult> {
	const normalized = normalizeEmail(email)
	if (!normalized) return { ok: false, reason: 'current_email' }

	const currentOwner = await db
		.prepare(`SELECT id FROM users WHERE email = ?${andLiveDeletedAtSql()}`)
		.bind(normalized)
		.first<{ id: number }>()
	if (currentOwner) return { ok: false, reason: 'current_email' }

	if (await isEmailReservedForOtherAccount(db, normalized)) {
		return { ok: false, reason: 'former_email_claimed' }
	}
	return { ok: true, stableUserId: mintPersonId() }
}

export class EmailClaimConflictError extends Error {
	readonly email: string

	constructor(email: string) {
		super('Email claim is already held by another account.')
		this.name = 'EmailClaimConflictError'
		this.email = email
	}
}

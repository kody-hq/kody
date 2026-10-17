/**
 * Durable one-gift-per-user Standard overlay. Triggered when known connected
 * agent ecosystems first reach 2. Callers pass that count; this module does
 * not recount grants.
 */

import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { hasSecondAgentEcosystem } from '#universal/onboarding-agent-ecosystems.ts'
import { parseStoredPlanName } from '#universal/plans.ts'
import {
	describeSecondAgentStandardGift,
	resolveSecondAgentStandardGiftWrite,
	type SecondAgentStandardGiftState,
} from '#universal/second-agent-standard-gift.ts'
import { updateOrgBillingColumns } from '#worker/orgs/org-billing-columns.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { personalOrgIdSql } from '#worker/orgs/personal-org-sql.ts'

/**
 * Resolve the personal org id for a gift caller that may pass either the
 * person id or the personal org id (legacy equal-id and distinct signup).
 */
async function resolvePersonalOrgIdForGift(
	db: D1Database,
	stableUserId: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT ${personalOrgIdSql} AS org_id
			 FROM users u
			 WHERE (u.stable_user_id = ? OR u.personal_org_id = ?)
			   ${andLiveDeletedAtSql('u')}`,
		)
		.bind(stableUserId, stableUserId)
		.first<{ org_id: string }>()
	return row?.org_id?.trim() || null
}

export type SecondAgentStandardGiftEvaluation =
	| { outcome: 'below_threshold' }
	| { outcome: 'no_user' }
	| {
			outcome: 'already_granted'
			gift: SecondAgentStandardGiftState
	  }
	| {
			outcome: 'granted'
			gift: SecondAgentStandardGiftState
	  }

type GiftUserRow = {
	plan: string
	stripe_plan: string | null
	second_agent_standard_gift_granted_at: string | null
	second_agent_standard_gift_expires_at: string | null
}

/**
 * Safe evaluator for authorize completion. Website reads load the persisted ledger.
 * Missing `prepare` skips both write and read. A failed listing or an ecosystem
 * count below 2 skips the write but still returns the persisted ledger so
 * `/onboarding.json` does not hide an already-granted gift.
 */
export async function maybeEvaluateSecondAgentStandardGift(input: {
	db?: D1Database
	stableUserId: string
	ecosystemCount: number
	listingFailed?: boolean
	now?: Date
}): Promise<SecondAgentStandardGiftState> {
	if (typeof input.db?.prepare !== 'function') {
		return describeSecondAgentStandardGift({})
	}
	try {
		if (!input.listingFailed && hasSecondAgentEcosystem(input.ecosystemCount)) {
			await evaluateSecondAgentStandardGift({
				db: input.db,
				stableUserId: input.stableUserId,
				ecosystemCount: input.ecosystemCount,
				now: input.now,
			})
		}
		return await loadSecondAgentStandardGift(
			input.db,
			input.stableUserId,
			input.now,
		)
	} catch (error) {
		console.warn('second-agent-standard-gift-evaluate-failed', error)
		return describeSecondAgentStandardGift({})
	}
}

export async function loadSecondAgentStandardGift(
	db: D1Database,
	stableUserId: string,
	now: Date = new Date(),
): Promise<SecondAgentStandardGiftState> {
	const orgId = await resolvePersonalOrgIdForGift(db, stableUserId)
	if (!orgId) return describeSecondAgentStandardGift({ now })
	const row = await db
		.prepare(
			`SELECT second_agent_standard_gift_granted_at,
			        second_agent_standard_gift_expires_at
			 FROM orgs
			 WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<{
			second_agent_standard_gift_granted_at: string | null
			second_agent_standard_gift_expires_at: string | null
		}>()
	return describeSecondAgentStandardGift({
		grantedAt: row?.second_agent_standard_gift_granted_at,
		expiresAt: row?.second_agent_standard_gift_expires_at,
		now,
	})
}

/**
 * Record the one gift when known ecosystems first reach 2.
 * Idempotent: a second event returns the existing row and does not rewrite
 * expires_at or Stripe.
 */
export async function evaluateSecondAgentStandardGift(input: {
	db: D1Database
	stableUserId: string
	ecosystemCount: number
	now?: Date
}): Promise<SecondAgentStandardGiftEvaluation> {
	if (!hasSecondAgentEcosystem(input.ecosystemCount)) {
		return { outcome: 'below_threshold' }
	}
	const now = input.now ?? new Date()
	const orgId = await resolvePersonalOrgIdForGift(input.db, input.stableUserId)
	if (!orgId) return { outcome: 'no_user' }
	const row = await input.db
		.prepare(
			`SELECT plan, stripe_plan,
			        second_agent_standard_gift_granted_at,
			        second_agent_standard_gift_expires_at
			 FROM orgs
			 WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<GiftUserRow>()
	if (!row) return { outcome: 'no_user' }

	if (row.second_agent_standard_gift_granted_at) {
		return {
			outcome: 'already_granted',
			gift: describeSecondAgentStandardGift({
				grantedAt: row.second_agent_standard_gift_granted_at,
				expiresAt: row.second_agent_standard_gift_expires_at,
				now,
			}),
		}
	}

	const write = resolveSecondAgentStandardGiftWrite({
		manualPlan: parseStoredPlanName(row.plan),
		stripePlan: row.stripe_plan,
		now,
	})
	const grantedAt = now.toISOString()
	const updatedAt = utcSqliteTimestamp(now)
	const updated = await updateOrgBillingColumns({
		db: input.db,
		orgId,
		setClause: `second_agent_standard_gift_granted_at = ?,
				     second_agent_standard_gift_expires_at = ?,
				     updated_at = ?`,
		values: [grantedAt, write.expiresAt, updatedAt],
		orgWhereSuffix: ` AND second_agent_standard_gift_granted_at IS NULL
			AND deleting_at IS NULL
			AND EXISTS (
				SELECT 1 FROM users u
				WHERE (u.stable_user_id = ? OR u.personal_org_id = ?)
				AND ${personalOrgIdSql} = orgs.id
				${andLiveDeletedAtSql('u')} AND u.deleting_at IS NULL
			)`,
		orgWhereValues: [input.stableUserId, input.stableUserId],
	})

	if ((updated?.meta.changes ?? 0) === 0) {
		const gift = await loadSecondAgentStandardGift(
			input.db,
			input.stableUserId,
			now,
		)
		return gift.received
			? { outcome: 'already_granted', gift }
			: { outcome: 'no_user' }
	}

	return {
		outcome: 'granted',
		gift: describeSecondAgentStandardGift({
			grantedAt,
			expiresAt: write.expiresAt,
			now,
		}),
	}
}

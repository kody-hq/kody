import {
	isLimitOverrideActive,
	parseLimitOverrideKey,
	type LimitOverride,
	type LimitOverrideKey,
	type LimitOverrideValue,
} from '#universal/plans.ts'

/**
 * `org_limit_overrides` (APP_DB) is the single source of truth for admin
 * per-org limit overrides. Entitlement resolution reads active rows and
 * applies them with `applyLimitOverrides`; admin writes go through
 * `#worker/admin/org-limit-overrides.ts` so every change is audited.
 */

type OrgLimitOverrideRow = {
	limit_key: string
	limit_value: number | null
	reason: string
	expires_at: string | null
	set_by_user_id: string
	created_at: string
	updated_at: string
}

export type OrgLimitOverrideRecord = LimitOverride & {
	reason: string
	setByUserId: string
	createdAt: string
	updatedAt: string
	active: boolean
}

function toLimitOverrideValue(value: number | null): LimitOverrideValue {
	return value === null ? 'unlimited' : Number(value)
}

function toRecord(
	row: OrgLimitOverrideRow,
	now: Date,
): OrgLimitOverrideRecord | null {
	const key = parseLimitOverrideKey(row.limit_key)
	if (!key) return null
	const override: LimitOverride = {
		key,
		value: toLimitOverrideValue(row.limit_value),
		expiresAt: row.expires_at,
	}
	return {
		...override,
		reason: row.reason,
		setByUserId: row.set_by_user_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		active: isLimitOverrideActive(override, now),
	}
}

/** Override rows with this reason cap the plan limit (guest accounts). */
export const ceilingLimitOverrideReason = 'guest_account'

/**
 * Unexpired overrides for one org. Keys this build does not know (rolled
 * back after a newer build added one) are ignored.
 */
export async function readActiveOrgLimitOverrides(
	db: D1Database,
	orgId: string,
	now: Date = new Date(),
): Promise<Array<LimitOverride>> {
	const rows = await db
		.prepare(
			`SELECT limit_key, limit_value, reason, expires_at FROM org_limit_overrides
			 WHERE org_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
		)
		.bind(orgId, now.toISOString())
		.all<
			Pick<
				OrgLimitOverrideRow,
				'limit_key' | 'limit_value' | 'reason' | 'expires_at'
			>
		>()
	return (rows.results ?? []).flatMap((row) => {
		const key = parseLimitOverrideKey(row.limit_key)
		return key
			? [
					{
						key,
						value: toLimitOverrideValue(row.limit_value),
						expiresAt: row.expires_at,
						...(row.reason === ceilingLimitOverrideReason
							? { ceiling: true }
							: {}),
					},
				]
			: []
	})
}

/** Every override row for an org (expired included), for admin views. */
export async function listOrgLimitOverrides(
	db: D1Database,
	orgId: string,
	now: Date = new Date(),
): Promise<Array<OrgLimitOverrideRecord>> {
	const rows = await db
		.prepare(
			`SELECT limit_key, limit_value, reason, expires_at, set_by_user_id,
				created_at, updated_at
			 FROM org_limit_overrides WHERE org_id = ? ORDER BY limit_key`,
		)
		.bind(orgId)
		.all<OrgLimitOverrideRow>()
	return (rows.results ?? []).flatMap((row) => {
		const record = toRecord(row, now)
		return record ? [record] : []
	})
}

export async function upsertOrgLimitOverride(
	db: D1Database,
	input: {
		orgId: string
		key: LimitOverrideKey
		value: LimitOverrideValue
		expiresAt: string | null
		reason: string
		setByUserId: string
		now: Date
	},
): Promise<void> {
	const nowIso = input.now.toISOString()
	await db
		.prepare(
			`INSERT INTO org_limit_overrides (
				org_id, limit_key, limit_value, reason, expires_at, set_by_user_id,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (org_id, limit_key) DO UPDATE SET
				limit_value = excluded.limit_value,
				reason = excluded.reason,
				expires_at = excluded.expires_at,
				set_by_user_id = excluded.set_by_user_id,
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.orgId,
			input.key,
			input.value === 'unlimited' ? null : input.value,
			input.reason,
			input.expiresAt,
			input.setByUserId,
			nowIso,
			nowIso,
		)
		.run()
}

export async function deleteOrgLimitOverride(
	db: D1Database,
	input: { orgId: string; key: LimitOverrideKey },
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM org_limit_overrides WHERE org_id = ? AND limit_key = ?`,
		)
		.bind(input.orgId, input.key)
		.run()
	return Number(result.meta?.changes ?? 0) > 0
}

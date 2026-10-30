/**
 * Admin per-org limit overrides. Shared by the admin users page and the
 * `adminOrgLimitOverrides*` capabilities so both validate, write
 * `org_limit_overrides`, invalidate the entitlement cache, and record the
 * same org audit event (admin, old and new values, reason).
 */
import { parseOwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	limitForOverrideKey,
	limitOverrideKeyLabels,
	limitOverrideKeys,
	resolveEntitlementLimits,
	resolvePlanLimits,
	type LimitOverrideKey,
	type LimitOverrideValue,
} from '#universal/plans.ts'
import { type AdminOrgLimits } from '#universal/loader-data.ts'
import {
	listOrgLimitOverrides,
	type OrgLimitOverrideRecord,
} from '#worker/entitlements/limit-overrides.ts'
import {
	getUserEntitlement,
	invalidateCachedUserEntitlement,
} from '#worker/entitlements/service.ts'
import {
	runAppDbBatchWithOrgAudit,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
import { getOrgById, getOrgBySlug, type OrgRecord } from '#worker/orgs/repo.ts'

export const orgLimitOverrideReasonMaxLength = 500

export const orgLimitOverrideAuditActions = {
	set: 'limit_override.set',
	changed: 'limit_override.changed',
	removed: 'limit_override.removed',
} as const

export class AdminOrgLimitOverrideError extends Error {
	readonly status: 400 | 404
	constructor(status: 400 | 404, message: string) {
		super(message)
		this.name = 'AdminOrgLimitOverrideError'
		this.status = status
	}
}

/** Exactly one of an org id or an org slug (handle, with or without `@`). */
export type AdminOrgTarget = { orgId?: string; org?: string }

export async function resolveAdminOrgTarget(
	db: D1Database,
	target: AdminOrgTarget,
): Promise<OrgRecord> {
	const org =
		target.orgId !== undefined
			? await loadOrgById(db, target.orgId)
			: target.org !== undefined
				? await getOrgBySlug(db, target.org.trim().replace(/^@/, ''))
				: null
	if (!org) throw new AdminOrgLimitOverrideError(404, 'Org not found.')
	return org
}

async function loadOrgById(db: D1Database, orgId: string) {
	const id = parseOwnerId(orgId)
	return id ? await getOrgById(db, id) : null
}

function withoutKey({
	key: _key,
	...override
}: OrgLimitOverrideRecord): Omit<OrgLimitOverrideRecord, 'key'> {
	return override
}

export async function loadAdminOrgLimits(input: {
	db: D1Database
	target: AdminOrgTarget
	now?: Date
}): Promise<AdminOrgLimits> {
	const now = input.now ?? new Date()
	const org = await resolveAdminOrgTarget(input.db, input.target)
	const [entitlement, records] = await Promise.all([
		getUserEntitlement(input.db, { userId: org.id, email: null }),
		listOrgLimitOverrides(input.db, org.id, now),
	])
	const planLimits = resolvePlanLimits(
		entitlement.plan,
		entitlement.ladder,
		entitlement.creditWallet,
		entitlement.seats,
	)
	const effectiveLimits = resolveEntitlementLimits(entitlement, now)
	const recordsByKey = new Map(records.map((record) => [record.key, record]))
	return {
		org: { id: org.id, slug: org.slug, displayName: org.display_name },
		plan: entitlement.plan,
		creditWallet: entitlement.creditWallet,
		seats: entitlement.seats ?? 1,
		limits: limitOverrideKeys.map((key) => {
			const record = recordsByKey.get(key)
			return {
				key,
				label: limitOverrideKeyLabels[key],
				planLimit: limitForOverrideKey(planLimits, key),
				effectiveLimit: limitForOverrideKey(effectiveLimits, key),
				override: record ? withoutKey(record) : null,
			}
		}),
	}
}

/** `null` removes the override for that key. */
export type AdminOrgLimitOverrideChange = {
	key: LimitOverrideKey
	value: LimitOverrideValue | null
	expiresAt?: string | null
}

export function normalizeOrgLimitOverrideReason(
	reason: unknown,
	maxLength = orgLimitOverrideReasonMaxLength,
): string {
	const trimmed = typeof reason === 'string' ? reason.trim() : ''
	if (!trimmed) {
		throw new AdminOrgLimitOverrideError(400, 'A reason is required.')
	}
	if (trimmed.length > maxLength) {
		throw new AdminOrgLimitOverrideError(
			400,
			`Keep the reason under ${maxLength} characters.`,
		)
	}
	return trimmed
}

function normalizeValue(
	key: LimitOverrideKey,
	value: LimitOverrideValue,
): LimitOverrideValue {
	if (value === 'unlimited') return value
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new AdminOrgLimitOverrideError(
			400,
			`${key} must be a non-negative whole number or "unlimited".`,
		)
	}
	return value
}

function normalizeExpiresAt(
	expiresAt: string | null | undefined,
	now: Date,
): string | null {
	if (expiresAt === undefined || expiresAt === null || expiresAt === '') {
		return null
	}
	const ms = Date.parse(expiresAt)
	if (!Number.isFinite(ms)) {
		throw new AdminOrgLimitOverrideError(400, 'expiresAt must be ISO 8601.')
	}
	if (ms <= now.getTime()) {
		throw new AdminOrgLimitOverrideError(
			400,
			'expiresAt must be in the future.',
		)
	}
	return new Date(ms).toISOString()
}

function auditSnapshot(record: OrgLimitOverrideRecord | null | undefined) {
	return record
		? {
				value: record.value,
				expiresAt: record.expiresAt,
				reason: record.reason,
				setByUserId: record.setByUserId,
			}
		: null
}

/**
 * Apply a batch of override changes to one org with one reason. Each key
 * that actually changes writes D1 and one org audit event; unchanged keys
 * are skipped. The writer isolate's entitlement cache is dropped after the
 * writes; counted checks in every isolate read overrides live.
 */
export async function applyAdminOrgLimitOverrideChanges(input: {
	db: D1Database
	audit: OrgAuditWriter
	target: AdminOrgTarget
	changes: ReadonlyArray<AdminOrgLimitOverrideChange>
	reason: unknown
	now?: Date
}): Promise<AdminOrgLimits & { changedKeys: Array<LimitOverrideKey> }> {
	const now = input.now ?? new Date()
	const adminUserId = input.audit.actorUserId
	if (!adminUserId) {
		throw new AdminOrgLimitOverrideError(400, 'An acting admin is required.')
	}
	if (input.changes.length === 0) {
		throw new AdminOrgLimitOverrideError(400, 'Provide at least one change.')
	}
	const seen = new Set<LimitOverrideKey>()
	for (const change of input.changes) {
		if (seen.has(change.key)) {
			throw new AdminOrgLimitOverrideError(
				400,
				`${change.key} appears more than once.`,
			)
		}
		seen.add(change.key)
	}
	const reason = normalizeOrgLimitOverrideReason(input.reason)
	const normalized = input.changes.map((change) => ({
		key: change.key,
		value:
			change.value === null ? null : normalizeValue(change.key, change.value),
		expiresAt:
			change.value === null ? null : normalizeExpiresAt(change.expiresAt, now),
	}))

	const org = await resolveAdminOrgTarget(input.db, input.target)
	const existing = new Map(
		(await listOrgLimitOverrides(input.db, org.id, now)).map((record) => [
			record.key,
			record,
		]),
	)
	const changedKeys: Array<LimitOverrideKey> = []
	for (const change of normalized) {
		const previous = existing.get(change.key) ?? null
		if (change.value === null) {
			if (!previous) continue
			await runAppDbBatchWithOrgAudit({
				appDb: input.db,
				audit: input.audit,
				statements: [
					input.db
						.prepare(
							`DELETE FROM org_limit_overrides WHERE org_id = ? AND limit_key = ?`,
						)
						.bind(org.id, change.key),
				],
				event: {
					orgId: org.id,
					action: orgLimitOverrideAuditActions.removed,
					resourceType: 'limit_override',
					resourceId: change.key,
					details: {
						limitKey: change.key,
						previous: auditSnapshot(previous),
						next: null,
						reason,
					},
				},
			})
			changedKeys.push(change.key)
			continue
		}
		if (
			previous &&
			previous.value === change.value &&
			previous.expiresAt === change.expiresAt &&
			previous.reason === reason
		) {
			continue
		}
		const nowIso = now.toISOString()
		await runAppDbBatchWithOrgAudit({
			appDb: input.db,
			audit: input.audit,
			statements: [
				input.db
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
						org.id,
						change.key,
						change.value === 'unlimited' ? null : change.value,
						reason,
						change.expiresAt,
						adminUserId,
						nowIso,
						nowIso,
					),
			],
			event: {
				orgId: org.id,
				action: previous
					? orgLimitOverrideAuditActions.changed
					: orgLimitOverrideAuditActions.set,
				resourceType: 'limit_override',
				resourceId: change.key,
				details: {
					limitKey: change.key,
					previous: auditSnapshot(previous),
					next: {
						value: change.value,
						expiresAt: change.expiresAt,
						reason,
						setByUserId: adminUserId,
					},
					reason,
				},
			},
		})
		changedKeys.push(change.key)
	}
	if (changedKeys.length > 0) invalidateCachedUserEntitlement(input.db, org.id)
	const limits = await loadAdminOrgLimits({
		db: input.db,
		target: { orgId: org.id },
		now,
	})
	return { ...limits, changedKeys }
}

/**
 * soft-delete-read-filter: opt-out
 *
 * The personal-org exclusion must also match soft-deleted people: their
 * personal org purges with them, not through this cleanup.
 */
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { hardPurgeOrgIfPresent } from './hard-purge.ts'
import { softDeleteOrg } from './soft-delete.ts'

export const memberlessTeamOrgCleanupDefaultLimit = 25
export const memberlessTeamOrgCleanupMaxLimit = 100

export type MemberlessTeamOrg = {
	orgId: OwnerId
	slug: string
	createdAt: string
	/** True when the creating person's account was hard-deleted. */
	creatorDeleted: boolean
	packageCount: number
}

export type MemberlessTeamOrgCleanupResult = {
	dryRun: boolean
	/** Every memberless team org, not only the ones on this page. */
	total: number
	orgs: Array<MemberlessTeamOrg>
	purgedOrgIds: Array<OwnerId>
	failures: Array<{ orgId: OwnerId; error: string }>
}

/**
 * A memberless team org: live, no live membership, and not the personal org
 * of any person (live or soft-deleted). Organizations with no creator are
 * platform accounts and are never matched.
 */
const memberlessTeamOrgWhereSql = `
	o.deleted_at IS NULL
	AND o.created_by_user_id IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM org_memberships m
		WHERE m.org_id = o.id AND m.deleted_at IS NULL
	)
	AND NOT EXISTS (
		SELECT 1 FROM users u
		WHERE COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) = o.id
	)`

async function listMemberlessTeamOrgs(input: {
	db: D1Database
	limit: number
	orgIds?: ReadonlyArray<string>
}) {
	const orgIds = input.orgIds ?? []
	const idFilter =
		orgIds.length > 0 ? `AND o.id IN (${orgIds.map(() => '?').join(', ')})` : ''
	const total = await input.db
		.prepare(
			`SELECT COUNT(*) AS count FROM orgs o
			 WHERE ${memberlessTeamOrgWhereSql} ${idFilter}`,
		)
		.bind(...orgIds)
		.first<{ count: number }>()
	const rows = await input.db
		.prepare(
			`SELECT o.id AS id, o.slug AS slug, o.created_at AS created_at,
			        o.created_by_user_id AS created_by_user_id,
			        (
			          SELECT COUNT(*) FROM saved_packages p
			          WHERE p.user_id = o.id AND p.deleted_at IS NULL
			        ) AS package_count
			 FROM orgs o
			 WHERE ${memberlessTeamOrgWhereSql} ${idFilter}
			 ORDER BY o.created_at ASC, o.id ASC
			 LIMIT ?`,
		)
		.bind(...orgIds, input.limit)
		.all<{
			id: OwnerId
			slug: string
			created_at: string
			created_by_user_id: string
			package_count: number
		}>()
	return {
		total: Number(total?.count ?? 0),
		orgs: (rows.results ?? []).map((row): MemberlessTeamOrg => ({
			orgId: row.id,
			slug: row.slug,
			createdAt: row.created_at,
			creatorDeleted: row.created_by_user_id === 'deleted-user',
			packageCount: Number(row.package_count ?? 0),
		})),
	}
}

/**
 * List team orgs that were left without members, and with `dryRun: false`
 * tombstone then hard-purge them (packages included). Account deletion is
 * meant to delete a team org with its last member, so a memberless team org
 * is a leftover with nobody able to manage or restore it.
 */
export async function cleanupMemberlessTeamOrgs(input: {
	env: Env
	dryRun?: boolean
	limit?: number
	orgIds?: ReadonlyArray<string>
	actorUserId?: string | null
	actorUsername?: string | null
}): Promise<MemberlessTeamOrgCleanupResult> {
	const dryRun = input.dryRun !== false
	const page = await listMemberlessTeamOrgs({
		db: input.env.APP_DB,
		limit: Math.min(
			input.limit ?? memberlessTeamOrgCleanupDefaultLimit,
			memberlessTeamOrgCleanupMaxLimit,
		),
		orgIds: input.orgIds,
	})
	const result: MemberlessTeamOrgCleanupResult = {
		dryRun,
		total: page.total,
		orgs: page.orgs,
		purgedOrgIds: [],
		failures: [],
	}
	if (dryRun) return result
	for (const org of page.orgs) {
		try {
			await softDeleteOrg({
				env: input.env,
				orgId: org.orgId,
				actorUserId: input.actorUserId,
				actorUsername: input.actorUsername,
			})
			await hardPurgeOrgIfPresent(input.env, org.orgId)
			result.purgedOrgIds.push(org.orgId)
		} catch (error) {
			result.failures.push({ orgId: org.orgId, error: getErrorMessage(error) })
		}
	}
	return result
}

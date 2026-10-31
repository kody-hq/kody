import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	type OrgRole,
	type RequestOrg,
} from '@kody-internal/shared/request-context.ts'
import {
	type GrantSubjectChoices,
	grantSubjectMatchSql,
} from '#worker/authorization/grant-subjects.ts'
import { memoizePerRequest } from '#worker/request-context.ts'
import { personalOrgIdSql } from '#worker/orgs/personal-org-sql.ts'
import {
	andActiveOrgSql,
	andLiveDeletedAtSql,
} from '#worker/soft-delete/live-sql.ts'

export type OrgRecord = {
	id: string
	slug: string
	display_name: string | null
	avatar_key: string | null
	plan: string
	entitlement_ladder: string
}

export type OrgBinding = {
	org: RequestOrg
	/** Null for outside collaborators who hold a live grant but no membership. */
	role: OrgRole | null
}

/**
 * Thrown when a person has no live personal-org membership row. Session auth
 * catches this and treats the request as unauthenticated (defense in depth for
 * soft-deleted people whose cookie still resolved before the live users filter).
 */
export class PersonalOrgBindingMissingError extends Error {
	constructor(personId: string) {
		super(
			`No live personal-org membership for person ${personIdFromStored(personId)}. Every person must have users.personal_org_id (or legacy org_id = user_id) with a live membership.`,
		)
		this.name = 'PersonalOrgBindingMissingError'
	}
}

export type PersonOrg = OrgRecord & {
	role: OrgRole | null
}

const orgSelect = `id, slug, display_name, avatar_key, plan, entitlement_ladder`

export async function getOrgById(db: D1Database, orgId: string) {
	return await db
		.prepare(
			`SELECT ${orgSelect}
			 FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<OrgRecord>()
}

export async function getOrgBySlug(db: D1Database, slug: string) {
	const normalized = slug.trim().toLowerCase()
	if (!normalized) return null
	return await db
		.prepare(
			`SELECT ${orgSelect}
			 FROM orgs WHERE slug = ?${andLiveDeletedAtSql()}`,
		)
		.bind(normalized)
		.first<OrgRecord>()
}

export async function getLiveOwnerMembership(
	db: D1Database,
	orgId: string,
	userId: string,
) {
	return await db
		.prepare(
			`SELECT org_id, user_id, role
			 FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ org_id: string; user_id: string; role: OrgRole }>()
}

function toBinding(row: {
	org_id: string
	org_slug: string | null
	role: OrgRole | null
}): OrgBinding {
	return {
		org: {
			id: ownerIdFromStored(row.org_id),
			slug: row.org_slug?.trim() || null,
		},
		role: row.role,
	}
}

/**
 * The person's personal org (id = stable user id). Throws when the owner
 * membership is missing — P4 does not invent a binding.
 */
type OrgAccessRow = {
	org_id: string
	org_slug: string
	role: OrgRole | null
	suspended_at: string | null
	deleted_at: string | null
}

/**
 * Grant-only binding answers "is this non-member a guest through a grant".
 * Every caller ORs it with live membership, and an `org` subject grant only
 * reaches live members, so it can never bind a guest.
 */
export const grantOnlyBindingSubjects = {
	user: 'include',
	team: 'include',
	org: {
		exclude:
			'An org subject grant only reaches live members, and every caller already ORs this with live membership.',
	},
	profile: {
		exclude:
			'Profile grants narrow a profile; they never grant the person behind it.',
	},
} as const satisfies GrantSubjectChoices

/**
 * A `SELECT 1` over grants that `personId` holds, directly or through a live
 * team seat, in the org named by `orgIdSql`. Bind the binds after any
 * placeholders in `orgIdSql`.
 */
export function liveGrantForPersonSql(
	orgIdSql: string,
	personId: string,
): { sql: string; binds: Array<string> } {
	const subjectMatch = grantSubjectMatchSql({
		subjects: grantOnlyBindingSubjects,
		personId,
	})
	return {
		sql: `SELECT 1 FROM grants g
	        WHERE g.org_id = ${orgIdSql}
	          AND g.deleted_at IS NULL
	          AND ${subjectMatch.sql}`,
		binds: subjectMatch.binds,
	}
}

function bindingFromAccessRow(row: OrgAccessRow | null): OrgBinding | null {
	if (!row?.org_slug?.trim()) return null
	if (row.deleted_at || row.suspended_at) return null
	return {
		org: {
			id: ownerIdFromStored(row.org_id),
			slug: row.org_slug.trim(),
		},
		role: row.role,
	}
}

/**
 * Organization named by `slug` when `personId` is a live member or holds a
 * grant there (directly, or through a team). Missing, suspended, and
 * deleted organizations are denied the same way.
 */
export async function loadOrgBindingForSlug(
	db: D1Database,
	personId: string,
	slug: string,
): Promise<OrgBinding | null> {
	const normalized = slug.trim().toLowerCase()
	if (!normalized) return null
	const row = await db
		.prepare(
			`SELECT o.id AS org_id,
			        o.slug AS org_slug,
			        o.suspended_at AS suspended_at,
			        o.deleted_at AS deleted_at,
			        m.role AS role
			 FROM orgs o
			 LEFT JOIN org_memberships m
			   ON m.org_id = o.id
			  AND m.user_id = ?
			  AND m.deleted_at IS NULL
			 WHERE o.slug = ?`,
		)
		.bind(personId, normalized)
		.first<OrgAccessRow>()
	if (!row || row.deleted_at || row.suspended_at) return null
	if (row.role) return bindingFromAccessRow(row)
	const liveGrant = liveGrantForPersonSql('?', personId)
	const grant = await db
		.prepare(`SELECT 1 AS ok WHERE EXISTS (${liveGrant.sql})`)
		.bind(row.org_id, ...liveGrant.binds)
		.first<{ ok: number }>()
	if (!grant) return null
	return bindingFromAccessRow({ ...row, role: null })
}

export type ListedOrganization = {
	slug: string
	displayName: string | null
	role: OrgRole | null
	personal: boolean
	avatarKey: string | null
}

export async function listOrganizationsForPerson(
	db: D1Database,
	personId: string,
): Promise<Array<ListedOrganization>> {
	const now = new Date().toISOString()
	const memberships = await db
		.prepare(
			`SELECT o.slug AS slug,
			        o.display_name AS display_name,
			        o.avatar_key AS avatar_key,
			        m.role AS role,
			        CASE WHEN o.id = COALESCE(
			          (SELECT ${personalOrgIdSql}
			           FROM users u
			           WHERE u.stable_user_id = ?
			             AND u.deleted_at IS NULL
			           LIMIT 1),
			          ?
			        ) THEN 1 ELSE 0 END AS personal
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND m.deleted_at IS NULL${andActiveOrgSql('o')}`,
		)
		.bind(personId, personId, personId)
		.all<{
			slug: string
			display_name: string | null
			avatar_key: string | null
			role: OrgRole
			personal: number
		}>()
	const grants = await db
		.prepare(
			`SELECT DISTINCT o.slug AS slug, o.display_name AS display_name,
			        o.avatar_key AS avatar_key
			 FROM grants g
			 INNER JOIN orgs o ON o.id = g.org_id
			 WHERE g.deleted_at IS NULL
			   AND (g.expires_at IS NULL OR g.expires_at > ?)
			   AND g.subject_type = 'user'
			   AND g.subject_id = ?${andActiveOrgSql('o')}
			   AND NOT EXISTS (
			     SELECT 1 FROM org_memberships m
			     WHERE m.org_id = o.id
			       AND m.user_id = ?
			       AND m.deleted_at IS NULL
			   )
			 UNION
			 SELECT DISTINCT o.slug AS slug, o.display_name AS display_name,
			        o.avatar_key AS avatar_key
			 FROM team_members tm
			 INNER JOIN teams t
			   ON t.id = tm.team_id
			  AND t.deleted_at IS NULL
			 INNER JOIN grants g
			   ON g.subject_type = 'team'
			  AND g.subject_id = t.id
			  AND g.org_id = t.org_id
			  AND g.deleted_at IS NULL
			  AND (g.expires_at IS NULL OR g.expires_at > ?)
			 INNER JOIN orgs o ON o.id = t.org_id
			 WHERE tm.user_id = ?
			   AND tm.deleted_at IS NULL${andActiveOrgSql('o')}
			   AND NOT EXISTS (
			     SELECT 1 FROM org_memberships m
			     WHERE m.org_id = o.id
			       AND m.user_id = ?
			       AND m.deleted_at IS NULL
			   )`,
		)
		.bind(now, personId, personId, now, personId, personId)
		.all<{
			slug: string
			display_name: string | null
			avatar_key: string | null
		}>()
	const listed = [
		...(memberships.results ?? []).map((row) => ({
			slug: row.slug,
			displayName: row.display_name,
			role: row.role,
			personal: row.personal === 1,
			avatarKey: row.avatar_key,
		})),
		...(grants.results ?? []).map((row) => ({
			slug: row.slug,
			displayName: row.display_name,
			role: null as OrgRole | null,
			personal: false,
			avatarKey: row.avatar_key,
		})),
	]
	listed.sort((left, right) => {
		if (left.personal !== right.personal) return left.personal ? -1 : 1
		return left.slug.localeCompare(right.slug)
	})
	return listed
}

export async function countPendingInvitesForPerson(
	db: D1Database,
	input: { email: string; username: string; now: string },
) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM invites i
			 INNER JOIN orgs o ON o.id = i.org_id
			 WHERE i.status = 'pending'
			   AND i.expires_at > ?${andActiveOrgSql('o')}
			   AND (
			     lower(COALESCE(i.invitee_email, '')) = lower(?)
			     OR lower(COALESCE(i.invitee_username, '')) = lower(?)
			   )`,
		)
		.bind(input.now, input.email, input.username)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export type PendingInviteSummary = {
	id: string
	orgSlug: string
	orgDisplayName: string | null
	orgPersonal: boolean
	kind: string
	role: string | null
	resourceType: string | null
	preset: string | null
	/** Set for a grant invite on a live package in the inviting org. */
	packageName: string | null
	expiresAt: string
}

export async function listPendingInvitesForPerson(
	db: D1Database,
	input: { email: string; username: string; now: string },
): Promise<Array<PendingInviteSummary>> {
	const rows = await db
		.prepare(
			`SELECT i.id AS id, o.slug AS org_slug, o.display_name AS org_display_name,
			        i.kind AS kind, i.role AS role, i.resource_type AS resource_type,
			        i.preset AS preset, i.expires_at AS expires_at,
			        sp.name AS package_name,
			        EXISTS (
			          SELECT 1 FROM users owner
			          WHERE COALESCE(NULLIF(TRIM(owner.personal_org_id), ''), owner.stable_user_id) = o.id
			            AND owner.deleted_at IS NULL
			        ) AS org_personal
			 FROM invites i
			 INNER JOIN orgs o ON o.id = i.org_id
			 LEFT JOIN saved_packages sp
			   ON i.kind = 'grant' AND i.resource_type = 'package'
			  AND sp.id = i.resource_id AND sp.user_id = i.org_id
			  AND sp.deleted_at IS NULL
			 WHERE i.status = 'pending'
			   AND i.expires_at > ?${andActiveOrgSql('o')}
			   AND (
			     lower(COALESCE(i.invitee_email, '')) = lower(?)
			     OR lower(COALESCE(i.invitee_username, '')) = lower(?)
			   )${andLiveDeletedAtSql('o')}
			 ORDER BY i.created_at DESC`,
		)
		.bind(input.now, input.email, input.username)
		.all<{
			id: string
			org_slug: string
			org_display_name: string | null
			kind: string
			role: string | null
			resource_type: string | null
			preset: string | null
			expires_at: string
			package_name: string | null
			org_personal: number | null
		}>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		orgSlug: row.org_slug,
		orgDisplayName: row.org_display_name,
		orgPersonal: row.org_personal === 1,
		kind: row.kind,
		role: row.role,
		resourceType: row.resource_type,
		preset: row.preset,
		packageName: row.package_name,
		expiresAt: row.expires_at,
	}))
}

type OrgBindingRow = { org_id: string; org_slug: string; role: OrgRole }

/**
 * Live personal-org membership for a person via `users.personal_org_id`
 * (fallback: founding `org_id = user_id` when the column is blank).
 */
export function orgBindingForPersonStatement(
	db: D1Database,
	personId: string,
): D1PreparedStatement {
	return db
		.prepare(
			`SELECT o.id AS org_id, o.slug AS org_slug, m.role AS role
			 FROM users u
			 INNER JOIN org_memberships m
			   ON m.user_id = u.stable_user_id
			  AND m.org_id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
			  AND m.deleted_at IS NULL
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE u.stable_user_id = ?
			   AND u.deleted_at IS NULL${andLiveDeletedAtSql('o')}
			 LIMIT 1`,
		)
		.bind(personId)
}

export function orgBindingForPersonFromRow(
	personId: string,
	row: OrgBindingRow | null,
): OrgBinding {
	if (!row) {
		throw new PersonalOrgBindingMissingError(personId)
	}
	return toBinding(row)
}

export async function loadOrgBindingForPerson(
	db: D1Database,
	personId: string,
): Promise<OrgBinding> {
	const row = await orgBindingForPersonStatement(
		db,
		personId,
	).first<OrgBindingRow>()
	return orgBindingForPersonFromRow(personId, row)
}

/**
 * Bind a person to a specific org: live membership, or any live grant in that
 * org held directly or through a team (outside collaborator, role null).
 * Returns null when neither applies, or when the org is soft-deleted or
 * suspended. Same access rule as {@link loadOrgBindingForSlug}.
 */
export function orgBindingForOrgStatements(
	db: D1Database,
	personId: string,
	orgId: string,
): { membership: D1PreparedStatement; grant: D1PreparedStatement } {
	const liveGrant = liveGrantForPersonSql('o.id', personId)
	return {
		membership: db
			.prepare(
				`SELECT o.id AS org_id, o.slug AS org_slug, m.role AS role
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND m.org_id = ?
			   AND m.deleted_at IS NULL${andActiveOrgSql('o')}
			 LIMIT 1`,
			)
			.bind(personId, orgId),
		grant: db
			.prepare(
				`SELECT o.id AS org_id, o.slug AS org_slug
			 FROM orgs o
			 WHERE o.id = ?${andActiveOrgSql('o')}
			   AND EXISTS (${liveGrant.sql})
			 LIMIT 1`,
			)
			.bind(orgId, ...liveGrant.binds),
	}
}

export function orgBindingForOrgFromRows(rows: {
	membership: OrgBindingRow | null
	grant: { org_id: string; org_slug: string } | null
}): OrgBinding | null {
	if (rows.membership) return toBinding(rows.membership)
	if (!rows.grant) return null
	return toBinding({ ...rows.grant, role: null })
}

/**
 * Live membership or grant binding for `(personId, orgId)`. Memoized once per
 * HTTP request (same key) so package-page / viewer-access fans that call this
 * from several permission helpers do not re-query D1 for the same pair
 * (KODY-98). Outside a request context every call hits D1.
 */
export async function loadOrgBindingForOrg(
	db: D1Database,
	personId: string,
	orgId: string,
): Promise<OrgBinding | null> {
	return memoizePerRequest({
		key: `org-binding:${personId}:${orgId}`,
		load: () => loadLiveOrgBindingForOrg(db, personId, orgId),
	})
}

/** Uncached binding, for a write that must see current membership. */
export async function loadLiveOrgBindingForOrg(
	db: D1Database,
	personId: string,
	orgId: string,
): Promise<OrgBinding | null> {
	const statements = orgBindingForOrgStatements(db, personId, orgId)
	const membership = await statements.membership.first<OrgBindingRow>()
	if (membership) return toBinding(membership)
	const grant = await statements.grant.first<{
		org_id: string
		org_slug: string
	}>()
	return orgBindingForOrgFromRows({ membership: null, grant })
}

/** True when the org exists and is neither soft-deleted nor suspended. */
export async function isOrgActive(
	db: D1Database,
	orgId: string,
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 AS ok FROM orgs o WHERE o.id = ?${andActiveOrgSql('o')}`)
		.bind(orgId)
		.first<{ ok: number }>()
	return row != null
}

/**
 * Orgs the person can pick: live memberships union orgs where they hold a
 * live grant directly or through a team. Soft-deleted and suspended orgs are
 * excluded. Grant-only rows have `role: null`.
 */
export async function listOrgsForPerson(
	db: D1Database,
	personId: string,
): Promise<Array<PersonOrg>> {
	const liveGrant = liveGrantForPersonSql('o.id', personId)
	const rows = await db
		.prepare(
			`SELECT o.id, o.slug, o.display_name, o.avatar_key, o.plan, o.entitlement_ladder,
			        m.role AS role
			 FROM orgs o
			 LEFT JOIN org_memberships m
			   ON m.org_id = o.id
			  AND m.user_id = ?
			  AND m.deleted_at IS NULL
			 WHERE (
			     m.user_id IS NOT NULL
			     OR EXISTS (${liveGrant.sql})
			   )${andActiveOrgSql('o')}
			 ORDER BY o.slug ASC, o.id ASC`,
		)
		.bind(personId, ...liveGrant.binds)
		.all<OrgRecord & { role: OrgRole | null }>()
	return (rows.results ?? []).map((row) => ({
		...row,
		role: row.role ?? null,
	}))
}

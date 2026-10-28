/**
 * Writes that change org access (memberships, teams, grants, invites) and bump
 * access_epoch in the same D1 batch so the next request recompiles.
 */
import {
	grantPresets,
	resolveGrantPermissions,
	type GrantPreset,
} from '@kody-internal/shared/grant-presets.ts'
import {
	isOrgPermission,
	type OrgGrantResourceType,
	type OrgPermission,
	type OrgResourceType,
} from '@kody-internal/shared/org-permissions.ts'
import { mintPersonId } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import {
	FREE_ORG_LIMIT_MESSAGE,
	FreeOrgLimitError,
	MAX_FREE_ORGS_PER_USER,
	liveFreeOwnedOrgCountSql,
} from '#worker/orgs/billing.ts'
import { getOrgHandleClaimError } from '#worker/orgs/org-handle-claim.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	recordOrgAuditEvent,
	runAppDbBatchWithOrgAudit,
	type OrgAuditOutboxEvent,
	type OrgAuditWriter,
} from './org-audit.ts'

async function runAccessBatchWithAudit(input: {
	db: D1Database
	audit: OrgAuditWriter
	statements: Array<{ run(): Promise<unknown> }>
	event: OrgAuditOutboxEvent
}) {
	await runAppDbBatchWithOrgAudit({
		appDb: input.db,
		audit: input.audit,
		statements: input.statements,
		event: input.event,
	})
}

export type GrantSubject =
	| { type: 'user'; id: string }
	| { type: 'team'; id: string }

async function runBatch(
	db: D1Database,
	statements: Array<{ run(): Promise<unknown> }>,
) {
	if (typeof db.batch === 'function') {
		return await db.batch(statements as Array<D1PreparedStatement>)
	}
	const results: Array<unknown> = []
	for (const statement of statements) {
		results.push(await statement.run())
	}
	return results
}

function changesOf(result: unknown) {
	if (
		typeof result === 'object' &&
		result &&
		'meta' in result &&
		typeof result.meta === 'object' &&
		result.meta &&
		'changes' in result.meta
	) {
		return Number(result.meta.changes)
	}
	return 1
}

/**
 * Resource types a grant may target. `org` is organization-level permissions.
 * `credential` grants are keyed by stable credential id.
 */
export const grantResourceTypes = [
	'package',
	'app',
	'job',
	'credential',
	'memory',
	'email',
	'execution_context',
	'org',
] as const

export type GrantResourceType = (typeof grantResourceTypes)[number]

type MissingGrantResource = Exclude<
	OrgGrantResourceType,
	Exclude<GrantResourceType, 'org'>
>
const grantResourceTypesCoverOrgResources: MissingGrantResource extends never
	? true
	: never = true
void grantResourceTypesCoverOrgResources

export function isGrantResourceType(value: string): value is GrantResourceType {
	return (grantResourceTypes as ReadonlyArray<string>).includes(value)
}

const orgRoleValues = ['owner', 'member', 'billing'] as const

function isOrgRole(value: string): value is OrgRole {
	return (orgRoleValues as ReadonlyArray<string>).includes(value)
}

function isGrantPreset(value: string): value is GrantPreset {
	return (grantPresets as ReadonlyArray<string>).includes(value)
}

export async function createTeam(input: {
	db: D1Database
	orgId: string
	slug: string
	name: string
	description?: string | null
	createdByUserId: string
	audit: OrgAuditWriter
}) {
	const slug = normalizeUsername(input.slug)?.toLowerCase()
	if (!slug) throw new Error('Team slug is required.')
	const id = crypto.randomUUID()
	const now = new Date().toISOString()
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements: [
			input.db
				.prepare(
					`INSERT INTO teams (
					id, org_id, slug, name, description, parent_team_id,
					created_by_user_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
				)
				.bind(
					id,
					input.orgId,
					slug,
					input.name.trim() || slug,
					input.description?.trim() || null,
					input.createdByUserId,
					now,
					now,
				),
			bumpAccessEpochStatement(input.db, input.orgId),
		],
		event: {
			orgId: input.orgId,
			action: 'team.created',
			resourceType: 'team',
			resourceId: id,
			details: { slug },
		},
	})
	return { id, slug }
}

export async function addTeamMember(input: {
	db: D1Database
	orgId: string
	teamId: string
	userId: string
	addedByUserId: string
	audit: OrgAuditWriter
}) {
	const membership = await input.db
		.prepare(
			`SELECT user_id FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.orgId, input.userId)
		.first<{ user_id: string }>()
	if (!membership) {
		throw new Error('Team members must be live members of the org.')
	}
	const team = await input.db
		.prepare(
			`SELECT id FROM teams
			 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.teamId, input.orgId)
		.first<{ id: string }>()
	if (!team) throw new Error('Team was not found in this org.')
	const alreadyLive = await input.db
		.prepare(
			`SELECT 1 AS ok FROM team_members
			 WHERE team_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.teamId, input.userId)
		.first<{ ok: number }>()
	const now = new Date().toISOString()
	const memberStatements = [
		input.db
			.prepare(
				`INSERT INTO team_members (team_id, user_id, added_by_user_id, created_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(team_id, user_id) DO UPDATE SET
				   deleted_at = NULL,
				   added_by_user_id = excluded.added_by_user_id,
				   created_at = excluded.created_at`,
			)
			.bind(input.teamId, input.userId, input.addedByUserId, now),
		bumpAccessEpochStatement(input.db, input.orgId),
	]
	if (alreadyLive) {
		await runBatch(input.db, memberStatements)
		return
	}
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements: memberStatements,
		event: {
			orgId: input.orgId,
			action: 'team.member_added',
			resourceType: 'team',
			resourceId: input.teamId,
			targetUserId: input.userId,
		},
	})
}

export async function removeTeamMember(input: {
	db: D1Database
	orgId: string
	teamId: string
	userId: string
	audit: OrgAuditWriter
}) {
	const team = await input.db
		.prepare(
			`SELECT id FROM teams
			 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.teamId, input.orgId)
		.first<{ id: string }>()
	if (!team) throw new Error('Team was not found in this org.')
	const liveMember = await input.db
		.prepare(
			`SELECT 1 AS ok FROM team_members
			 WHERE team_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.teamId, input.userId)
		.first<{ ok: number }>()
	if (!liveMember) return
	const now = new Date().toISOString()
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements: [
			input.db
				.prepare(
					`UPDATE team_members
					 SET deleted_at = ?
					 WHERE team_id = ? AND user_id = ? AND deleted_at IS NULL`,
				)
				.bind(now, input.teamId, input.userId),
			bumpAccessEpochStatement(input.db, input.orgId),
		],
		event: {
			orgId: input.orgId,
			action: 'team.member_removed',
			resourceType: 'team',
			resourceId: input.teamId,
			targetUserId: input.userId,
		},
	})
}

function grantFamilyOf(
	resourceType: GrantResourceType,
): OrgResourceType | 'org' {
	if (resourceType === 'credential') {
		throw new Error('A credential grant needs its permission family.')
	}
	return resourceType
}

export async function upsertGrant(input: {
	db: D1Database
	orgId: string
	resourceType: GrantResourceType
	resourceId: string
	/**
	 * The permission family presets and checklists resolve against. Required
	 * for a credential (its kind decides `secret` or `integration`); every
	 * other resource type is its own family.
	 */
	family?: OrgResourceType | 'org'
	subject: GrantSubject
	preset: GrantPreset | null
	permissions: ReadonlyArray<OrgPermission> | null
	createdByUserId: string
	audit: OrgAuditWriter
}) {
	const family = input.family ?? grantFamilyOf(input.resourceType)
	const permissions = resolveGrantPermissions({
		family,
		preset: input.preset,
		permissions: input.permissions,
	})
	if (permissions.length === 0) {
		throw new Error('A grant needs at least one permission.')
	}
	const now = new Date().toISOString()
	const existing = await input.db
		.prepare(
			`SELECT id FROM grants
			 WHERE org_id = ?
			   AND resource_type = ?
			   AND resource_id = ?
			   AND subject_type = ?
			   AND subject_id = ?
			   AND deleted_at IS NULL`,
		)
		.bind(
			input.orgId,
			input.resourceType,
			input.resourceId,
			input.subject.type,
			input.subject.id,
		)
		.first<{ id: string }>()
	const grantId = existing?.id ?? crypto.randomUUID()
	const statements: Array<{ run(): Promise<unknown> }> = []
	if (existing) {
		statements.push(
			input.db
				.prepare(
					`UPDATE grants
					 SET preset = ?, updated_at = ?, created_by_user_id = ?
					 WHERE id = ? AND org_id = ?${andLiveDeletedAtSql()}`,
				)
				.bind(input.preset, now, input.createdByUserId, grantId, input.orgId),
			input.db
				.prepare(`DELETE FROM grant_permissions WHERE grant_id = ?`)
				.bind(grantId),
		)
	} else {
		statements.push(
			input.db
				.prepare(
					`INSERT INTO grants (
						id, org_id, resource_type, resource_id, subject_type, subject_id,
						preset, created_by_user_id, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					grantId,
					input.orgId,
					input.resourceType,
					input.resourceId,
					input.subject.type,
					input.subject.id,
					input.preset,
					input.createdByUserId,
					now,
					now,
				),
		)
	}
	for (const permission of permissions) {
		statements.push(
			input.db
				.prepare(
					`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
				)
				.bind(grantId, permission),
		)
	}
	statements.push(bumpAccessEpochStatement(input.db, input.orgId))
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements,
		event: {
			orgId: input.orgId,
			action: existing ? 'grant.updated' : 'grant.created',
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			targetUserId: input.subject.type === 'user' ? input.subject.id : null,
			details: {
				grantId,
				subjectType: input.subject.type,
				subjectId: input.subject.id,
				preset: input.preset,
				permissions,
			},
		},
	})
	return { id: grantId, permissions }
}

export async function softDeleteGrant(input: {
	db: D1Database
	orgId: string
	grantId: string
	audit: OrgAuditWriter
}) {
	const now = new Date().toISOString()
	const existing = await input.db
		.prepare(
			`SELECT id, resource_type, resource_id, subject_type, subject_id
			 FROM grants
			 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.grantId, input.orgId)
		.first<{
			id: string
			resource_type: string
			resource_id: string
			subject_type: string
			subject_id: string
		}>()
	if (!existing) throw new Error('Grant was not found in this org.')
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements: [
			input.db
				.prepare(
					`UPDATE grants
				 SET deleted_at = ?, updated_at = ?
				 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
				)
				.bind(now, now, input.grantId, input.orgId),
			bumpAccessEpochStatement(input.db, input.orgId),
		],
		event: {
			orgId: input.orgId,
			action: 'grant.revoked',
			resourceType: existing.resource_type,
			resourceId: existing.resource_id,
			targetUserId:
				existing.subject_type === 'user' ? existing.subject_id : null,
			details: {
				grantId: input.grantId,
				subjectType: existing.subject_type,
				subjectId: existing.subject_id,
			},
		},
	})
}

export async function updateOrgMemberRole(input: {
	db: D1Database
	orgId: string
	userId: string
	role: OrgRole
	/**
	 * When demoting an Owner, fold the last-Owner guard into the UPDATE so two
	 * concurrent demotions cannot both succeed and leave zero Owners.
	 */
	protectLastOwner?: boolean
	audit: OrgAuditWriter
}) {
	const before = await input.db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.orgId, input.userId)
		.first<{ role: OrgRole }>()
	const statement = input.protectLastOwner
		? input.db
				.prepare(
					`UPDATE org_memberships
					 SET role = ?
					 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
					   AND role = 'owner'
					   AND (
					     SELECT COUNT(*) FROM org_memberships
					     WHERE org_id = ? AND role = 'owner' AND deleted_at IS NULL
					   ) > 1`,
				)
				.bind(input.role, input.orgId, input.userId, input.orgId)
		: input.db
				.prepare(
					`UPDATE org_memberships
					 SET role = ?
					 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
				)
				.bind(input.role, input.orgId, input.userId)
	const results = await runBatch(input.db, [
		statement,
		bumpAccessEpochStatement(input.db, input.orgId),
	])
	if (!changesOf(results[0])) {
		throw new Error(
			input.protectLastOwner
				? 'The last Owner cannot be demoted.'
				: 'That person is not a member of this organization.',
		)
	}
	if (before?.role === input.role) return
	await recordOrgAuditEvent(input.audit, {
		orgId: input.orgId,
		action: 'member.role_changed',
		targetUserId: input.userId,
		details: { role: input.role, previousRole: before?.role ?? null },
	})
}

/**
 * The slug failed format, reserved-name, or shared-namespace claim validation;
 * message is user-facing (same reserved copy as username signup).
 */
export class OrgSlugValidationError extends Error {}

export async function createOrg(input: {
	db: D1Database
	env: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>
	slug: string
	displayName?: string | null
	createdByUserId: string
	audit: OrgAuditWriter
}) {
	const slug = normalizeUsername(input.slug)
	const slugError = await getOrgHandleClaimError(slug, input.db, input.env)
	if (slugError) throw new OrgSlugValidationError(slugError)
	const orgId = mintPersonId()
	const now = new Date().toISOString()
	// New orgs start free. The two-free-org cap is checked inside the insert
	// itself so two concurrent creates cannot both pass a separate precheck;
	// the dependent rows only insert when the org row did.
	const results = await runBatch(input.db, [
		input.db
			.prepare(
				`INSERT INTO orgs (
					id, slug, display_name, profile_visibility, plan, entitlement_ladder,
					stripe_credits_eligible, admin_credits_eligible,
					signup_welcome_credits_pending, access_epoch,
					created_by_user_id, created_at, updated_at
				)
				SELECT ?, ?, ?, 'public', 'free', 'public', 0, 0, 0, 0, ?, ?, ?
				WHERE (${liveFreeOwnedOrgCountSql}) < ?`,
			)
			.bind(
				orgId,
				slug,
				input.displayName?.trim() || slug,
				input.createdByUserId,
				now,
				now,
				input.createdByUserId,
				MAX_FREE_ORGS_PER_USER,
			),
		input.db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 SELECT ?, ?, 'owner', ?
				 WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ?)`,
			)
			.bind(orgId, input.createdByUserId, now, orgId),
		input.db
			.prepare(
				`INSERT INTO handles (handle, user_id, org_id, created_at)
				 SELECT ?, NULL, ?, ?
				 WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ?)`,
			)
			.bind(slug, orgId, now, orgId),
	])
	if (changesOf(results[0]) === 0) {
		throw new FreeOrgLimitError(FREE_ORG_LIMIT_MESSAGE)
	}
	await recordOrgAuditEvent(input.audit, {
		orgId,
		action: 'org.created',
		details: { slug },
	})
	return { id: orgId, slug }
}

export type InviteKind = 'membership' | 'grant'

export async function createInvite(input: {
	db: D1Database
	orgId: string
	kind: InviteKind
	role?: OrgRole | null
	teamIds?: ReadonlyArray<string> | null
	resourceType?: GrantResourceType | null
	resourceId?: string | null
	preset?: GrantPreset | null
	permissions?: ReadonlyArray<OrgPermission> | null
	inviteeEmail?: string | null
	inviteeUsername?: string | null
	invitedByUserId: string
	expiresAt?: string
	tokenHash: string
	audit: OrgAuditWriter
}) {
	if (!input.inviteeEmail && !input.inviteeUsername) {
		throw new Error('An invite needs an invitee email or username.')
	}
	const id = crypto.randomUUID()
	const now = new Date().toISOString()
	const expiresAt =
		input.expiresAt ??
		new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements: [
			input.db
				.prepare(
					`INSERT INTO invites (
					id, org_id, kind, role, team_ids_json,
					resource_type, resource_id, permissions_json, preset,
					invitee_email, invitee_username, token_hash, status,
					invited_by_user_id, expires_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
				)
				.bind(
					id,
					input.orgId,
					input.kind,
					input.role ?? null,
					input.teamIds ? JSON.stringify(input.teamIds) : null,
					input.resourceType ?? null,
					input.resourceId ?? null,
					input.permissions ? JSON.stringify(input.permissions) : null,
					input.preset ?? null,
					input.inviteeEmail?.trim().toLowerCase() || null,
					input.inviteeUsername
						? normalizeUsername(input.inviteeUsername)?.toLowerCase() || null
						: null,
					input.tokenHash,
					input.invitedByUserId,
					expiresAt,
					now,
				),
		],
		event: {
			orgId: input.orgId,
			action: 'invite.created',
			resourceType: 'invite',
			resourceId: id,
			details: {
				kind: input.kind,
				role: input.role ?? null,
				resourceType: input.resourceType ?? null,
				resourceId: input.resourceId ?? null,
				expiresAt,
			},
		},
	})
	return { id, expiresAt }
}

export type GrantView = {
	id: string
	orgId: string
	resourceType: string
	resourceId: string
	subjectType: 'user' | 'team'
	subjectId: string
	preset: string | null
	permissions: Array<string>
	createdByUserId: string
	createdAt: string
	updatedAt: string
}

type GrantJoinRow = {
	id: string
	org_id: string
	resource_type: string
	resource_id: string
	subject_type: string
	subject_id: string
	preset: string | null
	created_by_user_id: string
	created_at: string
	updated_at: string
	permission: string | null
}

function groupGrantRows(rows: ReadonlyArray<GrantJoinRow>): Array<GrantView> {
	const byId = new Map<string, GrantView>()
	for (const row of rows) {
		let grant = byId.get(row.id)
		if (!grant) {
			const subjectType =
				row.subject_type === 'user' || row.subject_type === 'team'
					? row.subject_type
					: null
			if (!subjectType) {
				throw new Error(`Grant ${row.id} has subject type ${row.subject_type}.`)
			}
			grant = {
				id: row.id,
				orgId: row.org_id,
				resourceType: row.resource_type,
				resourceId: row.resource_id,
				subjectType,
				subjectId: row.subject_id,
				preset: row.preset,
				permissions: [],
				createdByUserId: row.created_by_user_id,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}
			byId.set(row.id, grant)
		}
		if (row.permission) grant.permissions.push(row.permission)
	}
	for (const grant of byId.values()) {
		grant.permissions.sort()
	}
	return [...byId.values()]
}

export async function listGrants(input: {
	db: D1Database
	orgId: string
	grantId?: string | null
	resourceType?: string | null
	resourceId?: string | null
	subjectType?: 'user' | 'team' | null
	subjectId?: string | null
}): Promise<Array<GrantView>> {
	const where = ['g.org_id = ?']
	const params: Array<string> = [input.orgId]
	if (input.grantId) {
		where.push('g.id = ?')
		params.push(input.grantId)
	}
	if (input.resourceType) {
		where.push('g.resource_type = ?')
		params.push(input.resourceType)
	}
	if (input.resourceId) {
		where.push('g.resource_id = ?')
		params.push(input.resourceId)
	}
	if (input.subjectType) {
		where.push('g.subject_type = ?')
		params.push(input.subjectType)
	}
	if (input.subjectId) {
		where.push('g.subject_id = ?')
		params.push(input.subjectId)
	}
	const result = await input.db
		.prepare(
			`SELECT g.id AS id,
			        g.org_id AS org_id,
			        g.resource_type AS resource_type,
			        g.resource_id AS resource_id,
			        g.subject_type AS subject_type,
			        g.subject_id AS subject_id,
			        g.preset AS preset,
			        g.created_by_user_id AS created_by_user_id,
			        g.created_at AS created_at,
			        g.updated_at AS updated_at,
			        gp.permission AS permission
			 FROM grants g
			 LEFT JOIN grant_permissions gp ON gp.grant_id = g.id
			 WHERE ${where.join(' AND ')}${andLiveDeletedAtSql('g')}
			 ORDER BY g.created_at ASC, g.id ASC, gp.permission ASC`,
		)
		.bind(...params)
		.all<GrantJoinRow>()
	return groupGrantRows(result.results ?? [])
}

export async function getGrantById(input: {
	db: D1Database
	orgId: string
	grantId: string
}) {
	const grants = await listGrants({
		db: input.db,
		orgId: input.orgId,
		grantId: input.grantId,
	})
	return grants[0] ?? null
}

export async function addOrgMember(input: {
	db: D1Database
	orgId: string
	userId: string
	role: OrgRole
	invitedByUserId: string
	audit: OrgAuditWriter
}) {
	const alreadyLive = await input.db
		.prepare(
			`SELECT 1 AS ok FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.orgId, input.userId)
		.first<{ ok: number }>()
	const now = new Date().toISOString()
	const membershipStatements = [
		input.db
			.prepare(
				`INSERT INTO org_memberships (
					org_id, user_id, role, invited_by_user_id, created_at
				) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(org_id, user_id) DO UPDATE SET
					deleted_at = NULL,
					invited_by_user_id = excluded.invited_by_user_id,
					role = CASE
						WHEN org_memberships.deleted_at IS NULL THEN org_memberships.role
						ELSE excluded.role
					END`,
			)
			.bind(input.orgId, input.userId, input.role, input.invitedByUserId, now),
		bumpAccessEpochStatement(input.db, input.orgId),
	]
	if (alreadyLive) {
		await runBatch(input.db, membershipStatements)
		return
	}
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements: membershipStatements,
		event: {
			orgId: input.orgId,
			action: 'member.added',
			targetUserId: input.userId,
			details: { role: input.role },
		},
	})
}

const inviteStatuses = ['pending', 'accepted', 'revoked', 'expired'] as const

export type InviteStatus = (typeof inviteStatuses)[number]

export type StoredInvite = {
	id: string
	orgId: string
	kind: InviteKind
	role: OrgRole | null
	teamIds: Array<string>
	resourceType: GrantResourceType | null
	resourceId: string | null
	permissions: Array<OrgPermission> | null
	preset: GrantPreset | null
	inviteeEmail: string | null
	inviteeUsername: string | null
	tokenHash: string
	status: InviteStatus
	invitedByUserId: string
	expiresAt: string
	createdAt: string
}

type InviteRow = {
	id: string
	org_id: string
	kind: string
	role: string | null
	team_ids_json: string | null
	resource_type: string | null
	resource_id: string | null
	permissions_json: string | null
	preset: string | null
	invitee_email: string | null
	invitee_username: string | null
	token_hash: string
	status: string
	invited_by_user_id: string
	expires_at: string
	created_at: string
}

function parseJsonStringList(value: string | null, label: string) {
	if (!value) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch (error) {
		throw new Error(`${label} is not valid JSON.`, { cause: error })
	}
	if (
		!Array.isArray(parsed) ||
		parsed.some((entry) => typeof entry !== 'string')
	) {
		throw new Error(`${label} must be a list of strings.`)
	}
	return parsed as Array<string>
}

function parseStoredInvite(row: InviteRow): StoredInvite {
	if (row.kind !== 'membership' && row.kind !== 'grant') {
		throw new Error(`Invite ${row.id} has kind ${row.kind}.`)
	}
	if (!(inviteStatuses as ReadonlyArray<string>).includes(row.status)) {
		throw new Error(`Invite ${row.id} has status ${row.status}.`)
	}
	const role = row.role
	if (role !== null && !isOrgRole(role)) {
		throw new Error(`Invite ${row.id} has role ${role}.`)
	}
	const preset = row.preset
	if (preset !== null && !isGrantPreset(preset)) {
		throw new Error(`Invite ${row.id} has preset ${preset}.`)
	}
	const resourceType = row.resource_type
	if (resourceType !== null && !isGrantResourceType(resourceType)) {
		throw new Error(`Invite ${row.id} has resource type ${resourceType}.`)
	}
	const permissionValues = row.permissions_json
		? parseJsonStringList(row.permissions_json, `Invite ${row.id} permissions`)
		: null
	const permissions = permissionValues
		? permissionValues.map((permission) => {
				if (!isOrgPermission(permission)) {
					throw new Error(`Invite ${row.id} has permission ${permission}.`)
				}
				return permission
			})
		: null
	return {
		id: row.id,
		orgId: row.org_id,
		kind: row.kind,
		role,
		teamIds: parseJsonStringList(row.team_ids_json, `Invite ${row.id} teams`),
		resourceType,
		resourceId: row.resource_id,
		permissions,
		preset,
		inviteeEmail: row.invitee_email,
		inviteeUsername: row.invitee_username,
		tokenHash: row.token_hash,
		status: row.status as InviteStatus,
		invitedByUserId: row.invited_by_user_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	}
}

const inviteSelect = `SELECT id, org_id, kind, role, team_ids_json, resource_type,
	resource_id, permissions_json, preset, invitee_email, invitee_username,
	token_hash, status, invited_by_user_id, expires_at, created_at
	FROM invites`

export async function getInviteByTokenHash(db: D1Database, tokenHash: string) {
	const row = await db
		.prepare(`${inviteSelect} WHERE token_hash = ?`)
		.bind(tokenHash)
		.first<InviteRow>()
	return row ? parseStoredInvite(row) : null
}

export async function getInviteById(input: {
	db: D1Database
	orgId: string
	inviteId: string
}) {
	const row = await input.db
		.prepare(`${inviteSelect} WHERE id = ? AND org_id = ?`)
		.bind(input.inviteId, input.orgId)
		.first<InviteRow>()
	return row ? parseStoredInvite(row) : null
}

/** Any org's invite by id, for the recipient's own accept or decline. */
export async function getInviteByIdAnyOrg(db: D1Database, inviteId: string) {
	const row = await db
		.prepare(`${inviteSelect} WHERE id = ?`)
		.bind(inviteId)
		.first<InviteRow>()
	return row ? parseStoredInvite(row) : null
}

async function setInviteStatus(input: {
	db: D1Database
	inviteId: string
	from: InviteStatus
	to: InviteStatus
	acceptedByUserId?: string | null
}) {
	const now = new Date().toISOString()
	const result =
		input.to === 'accepted'
			? await input.db
					.prepare(
						`UPDATE invites
						 SET status = 'accepted', accepted_by_user_id = ?, accepted_at = ?
						 WHERE id = ? AND status = ?`,
					)
					.bind(input.acceptedByUserId ?? null, now, input.inviteId, input.from)
					.run()
			: await input.db
					.prepare(
						`UPDATE invites
						 SET status = ?
						 WHERE id = ? AND status = ?`,
					)
					.bind(input.to, input.inviteId, input.from)
					.run()
	return changesOf(result)
}

/**
 * Claims the pending invite. The `invite.accepted` audit event is recorded by
 * the caller once the membership, teams, or grant have been applied.
 */
export async function markInviteAccepted(input: {
	db: D1Database
	inviteId: string
	acceptedByUserId: string
}) {
	const changes = await setInviteStatus({
		db: input.db,
		inviteId: input.inviteId,
		from: 'pending',
		to: 'accepted',
		acceptedByUserId: input.acceptedByUserId,
	})
	if (!changes) throw new Error('Invite could not be accepted.')
}

export async function markInviteRevoked(input: {
	db: D1Database
	orgId: string
	inviteId: string
	audit: OrgAuditWriter
}) {
	const pending = await input.db
		.prepare(`SELECT 1 AS ok FROM invites WHERE id = ? AND status = 'pending'`)
		.bind(input.inviteId)
		.first<{ ok: number }>()
	if (!pending) throw new Error('Only a pending invite can be revoked.')
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements: [
			input.db
				.prepare(
					`UPDATE invites
					 SET status = 'revoked'
					 WHERE id = ? AND status = 'pending'`,
				)
				.bind(input.inviteId),
		],
		event: {
			orgId: input.orgId,
			action: 'invite.revoked',
			resourceType: 'invite',
			resourceId: input.inviteId,
		},
	})
}

/**
 * The recipient declined. An invite has exactly one recipient, so it closes
 * like a revoke; the audit event says who turned it down.
 */
export async function markInviteDeclined(input: {
	db: D1Database
	orgId: string
	inviteId: string
	declinedByUserId: string
	audit: OrgAuditWriter
}) {
	const pending = await input.db
		.prepare(`SELECT 1 AS ok FROM invites WHERE id = ? AND status = 'pending'`)
		.bind(input.inviteId)
		.first<{ ok: number }>()
	if (!pending) throw new Error('Only a pending invite can be declined.')
	await runAccessBatchWithAudit({
		db: input.db,
		audit: input.audit,
		statements: [
			input.db
				.prepare(
					`UPDATE invites
					 SET status = 'revoked'
					 WHERE id = ? AND status = 'pending'`,
				)
				.bind(input.inviteId),
		],
		event: {
			orgId: input.orgId,
			action: 'invite.declined',
			resourceType: 'invite',
			resourceId: input.inviteId,
			targetUserId: input.declinedByUserId,
		},
	})
}

export async function markInviteExpired(input: {
	db: D1Database
	inviteId: string
}) {
	await setInviteStatus({
		db: input.db,
		inviteId: input.inviteId,
		from: 'pending',
		to: 'expired',
	})
}

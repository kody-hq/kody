import { McpCallerError } from '#mcp/caller-error.ts'
import {
	type GrantPreset,
	permissionsForGrantPreset,
} from '@kody-internal/shared/grant-presets.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { experimentOffMessage } from '#universal/feature-flags/experiments.ts'
import { isProfilesEnabledFor } from './flag.ts'
import { maxGrantsPerProfile, profileStatus } from './rules.ts'
import { loadProfileChain, loadProfileGrants } from './store.ts'

/**
 * Package grants to a profile (ADR 0092), made from the package's
 * Collaborators tab or `packageCollaboratorSet` with `profile_id`. The writer
 * caps the grant by every ancestor's snapshot; at run time the chain and the
 * acting person still intersect, so a grant here never widens the person.
 */
export type PackageProfileGrant = {
	grantId: string
	profileId: string
	profileName: string
	depth: number
	actingUserId: string
	permissions: Array<OrgPermission>
	createdAt: string
	active: boolean
}

export async function grantPackageToProfile(input: {
	env: Pick<Env, 'APP_DB'>
	request: RequestContext
	packageId: string
	profileId: string
	preset: GrantPreset
}): Promise<{ grantId: string }> {
	const { env, request } = input
	const db = env.APP_DB
	const orgId = request.org.id
	if (
		!request.actor ||
		!(await isProfilesEnabledFor(db, request.actor.userId, orgId))
	) {
		throw new McpCallerError(experimentOffMessage('profiles'))
	}
	const chain = await loadProfileChain(db, {
		orgId,
		profileId: input.profileId,
	})
	const self = chain.at(-1)
	if (!self || self.id !== input.profileId) {
		throw new McpCallerError('No profile with that id in this organization.')
	}
	if (self.acting_user_id !== request.actor.userId) {
		throw new McpCallerError(
			'You can only give access to your own profiles. Ask the person who owns this profile to add it.',
		)
	}
	const now = new Date().toISOString()
	if (profileStatus(chain, now) !== 'active') {
		throw new McpCallerError(
			`Profile "${self.name}" is no longer active, so it cannot be given access.`,
		)
	}
	const permissions = [...permissionsForGrantPreset('package', input.preset)]
	const key = `package:${input.packageId}`
	const ancestors = chain.slice(0, -1)
	const grants = await loadProfileGrants(db, {
		orgId,
		profileIds: chain.map((row) => row.id),
	})
	for (const ancestor of ancestors.toReversed()) {
		const held = new Set(
			(grants.get(ancestor.id) ?? [])
				.filter((grant) => `${grant.resourceType}:${grant.resourceId}` === key)
				.flatMap((grant) => grant.permissions),
		)
		const missing = permissions.find((permission) => !held.has(permission))
		if (missing) {
			throw new McpCallerError(
				`Parent profile "${ancestor.name}" does not hold ${missing} on this package, so "${self.name}" cannot get it. Give the parent access first, or pick a smaller preset.`,
			)
		}
	}
	const others = (grants.get(self.id) ?? []).filter(
		(grant) => `${grant.resourceType}:${grant.resourceId}` !== key,
	)
	if (others.length >= maxGrantsPerProfile) {
		throw new McpCallerError(
			`Profile "${self.name}" already has ${maxGrantsPerProfile} grants, the most a profile can hold.`,
		)
	}
	const grantId = `grant_${crypto.randomUUID()}`
	const statements: Array<D1PreparedStatement> = [
		db
			.prepare(
				`UPDATE grants SET deleted_at = ?, updated_at = ?
				 WHERE org_id = ? AND subject_type = 'profile' AND subject_id = ?
				   AND resource_type = 'package' AND resource_id = ?
				   AND deleted_at IS NULL`,
			)
			.bind(now, now, orgId, self.id, input.packageId),
		db
			.prepare(
				`INSERT INTO grants (
					id, org_id, resource_type, resource_id, subject_type, subject_id,
					preset, created_by_user_id, created_at, updated_at, origin, expires_at
				) VALUES (?, ?, 'package', ?, 'profile', ?, ?, ?, ?, ?, 'manual', NULL)`,
			)
			.bind(
				grantId,
				orgId,
				input.packageId,
				self.id,
				input.preset,
				request.actor.userId,
				now,
				now,
			),
		...permissions.map((permission) =>
			db
				.prepare(
					`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
				)
				.bind(grantId, permission),
		),
	]
	await db.batch(statements)
	return { grantId }
}

/** Soft-deletes one profile grant on the package; false when none matched. */
export async function removePackageProfileGrant(input: {
	db: D1Database
	orgId: string
	packageId: string
	grantId: string
}): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE grants SET deleted_at = ?, updated_at = ?
			 WHERE id = ? AND org_id = ? AND subject_type = 'profile'
			   AND resource_type = 'package' AND resource_id = ?
			   AND deleted_at IS NULL`,
		)
		.bind(now, now, input.grantId, input.orgId, input.packageId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listPackageProfileGrants(input: {
	db: D1Database
	orgId: string
	packageId: string
}): Promise<Array<PackageProfileGrant>> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`SELECT g.id AS grant_id, g.created_at, p.id AS profile_id, p.name,
				p.depth, p.acting_user_id, p.revoked_at, p.expires_at, gp.permission
			 FROM grants g
			 JOIN profiles p ON p.id = g.subject_id AND p.org_id = g.org_id
			 JOIN grant_permissions gp ON gp.grant_id = g.id
			 WHERE g.org_id = ? AND g.subject_type = 'profile'
			   AND g.resource_type = 'package' AND g.resource_id = ?
			   AND g.deleted_at IS NULL
			 ORDER BY p.name ASC, g.id ASC, gp.permission ASC`,
		)
		.bind(input.orgId, input.packageId)
		.all<{
			grant_id: string
			created_at: string
			profile_id: string
			name: string
			depth: number
			acting_user_id: string
			revoked_at: string | null
			expires_at: string | null
			permission: OrgPermission
		}>()
	const byGrant = new Map<string, PackageProfileGrant>()
	for (const row of result.results) {
		let grant = byGrant.get(row.grant_id)
		if (!grant) {
			grant = {
				grantId: row.grant_id,
				profileId: row.profile_id,
				profileName: row.name,
				depth: row.depth,
				actingUserId: row.acting_user_id,
				permissions: [],
				createdAt: row.created_at,
				active:
					row.revoked_at === null &&
					(row.expires_at === null || row.expires_at > now),
			}
			byGrant.set(row.grant_id, grant)
		}
		grant.permissions.push(row.permission)
	}
	const grants = [...byGrant.values()]
	const inactive = await inactiveProfileChains(input.db, {
		orgId: input.orgId,
		profileIds: grants.filter((g) => g.active).map((g) => g.profileId),
		now,
	})
	for (const grant of grants) {
		if (inactive.has(grant.profileId)) grant.active = false
	}
	return grants
}

/**
 * The given profiles whose chain holds a revoked or expired row, in one
 * recursive query however many profiles are passed.
 */
async function inactiveProfileChains(
	db: D1Database,
	input: { orgId: string; profileIds: Array<string>; now: string },
): Promise<Set<string>> {
	if (input.profileIds.length === 0) return new Set()
	const result = await db
		.prepare(
			`WITH RECURSIVE walk(start_id, parent_profile_id, revoked_at, expires_at) AS (
			   SELECT id, parent_profile_id, revoked_at, expires_at FROM profiles
			   WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))
			   UNION ALL
			   SELECT w.start_id, p.parent_profile_id, p.revoked_at, p.expires_at
			   FROM profiles p JOIN walk w ON p.id = w.parent_profile_id
			   WHERE p.org_id = ?
			 )
			 SELECT DISTINCT start_id FROM walk
			 WHERE revoked_at IS NOT NULL
			    OR (expires_at IS NOT NULL AND expires_at <= ?)`,
		)
		.bind(input.orgId, JSON.stringify(input.profileIds), input.orgId, input.now)
		.all<{ start_id: string }>()
	return new Set(result.results.map((row) => row.start_id))
}

/** The viewer's own active profiles in the org, for the "Add a profile" picker. */
export async function listGrantableProfiles(input: {
	db: D1Database
	orgId: string
	actingUserId: string
}): Promise<Array<{ id: string; name: string; depth: number }>> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`SELECT id, name, depth FROM profiles
			 WHERE org_id = ? AND acting_user_id = ? AND revoked_at IS NULL
			   AND (expires_at IS NULL OR expires_at > ?)
			 ORDER BY depth ASC, name ASC`,
		)
		.bind(input.orgId, input.actingUserId, now)
		.all<{ id: string; name: string; depth: number }>()
	const inactive = await inactiveProfileChains(input.db, {
		orgId: input.orgId,
		profileIds: result.results.map((row) => row.id),
		now,
	})
	return result.results.filter((row) => !inactive.has(row.id))
}

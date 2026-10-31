/**
 * Pure profile rules (ADR 0092), kept apart from storage so every refusal is
 * unit-testable.
 */
import {
	type OrgGrantResourceType,
	type OrgPermission,
	type OrgResourceType,
} from '@kody-internal/shared/org-permissions.ts'
import { isGrantablePermission } from '@kody-internal/shared/grant-presets.ts'

export const maxProfileDepth = 5
/** Live (not revoked, not expired) profiles one person may hold in one org. */
export const maxActiveProfilesPerPerson = 100
/** Grants a profile may snapshot at creation. */
export const maxGrantsPerProfile = 50
/** Days a revoked or expired profile row is kept before purge. */
export const profilePurgeAfterDays = 30

export const profileNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Org-level permissions a profile may hold on the `org` resource. Resource
 * family reads (`package:read` org-wide and the like) are never allowed: a
 * profile reaches only the resources it was granted one by one.
 */
export const profileOrgLevelAllowlist: ReadonlyArray<OrgPermission> = [
	'org:read',
	'org:execute',
	'search:read',
	'member:read',
	'team:read',
	'audit:read',
	// Lets a profile manage its own sub-profiles; canActOnProfile still limits
	// it to strict descendants.
	'profile:manage',
]

export function isProfileOrgLevelPermission(permission: OrgPermission) {
	return (
		profileOrgLevelAllowlist.includes(permission) ||
		permission.endsWith(':create')
	)
}

/**
 * What a profile grant may name: one resource, or the org itself for the
 * org-level allowlist only.
 */
export const profileGrantResourceTypes = [
	'org',
	'package',
	'app',
	'job',
	'credential',
	'memory',
	'email',
	'execution_context',
] as const satisfies ReadonlyArray<OrgGrantResourceType | 'org'>

export type ProfileGrantResourceType =
	(typeof profileGrantResourceTypes)[number]

export type ProfileRow = {
	id: string
	org_id: string
	owner_kind: 'person'
	acting_user_id: string
	parent_profile_id: string | null
	name: string
	depth: number
	expires_at: string | null
	revoked_at: string | null
	revoked_by_user_id: string | null
	created_by_user_id: string
	created_by_profile_id: string | null
	created_at: string
	updated_at: string
}

export type ProfileStatus = 'active' | 'expired' | 'revoked' | 'parent_inactive'

/** Status of one profile from its chain, root first and the profile last. */
export function profileStatus(
	chain: ReadonlyArray<Pick<ProfileRow, 'revoked_at' | 'expires_at'>>,
	now: string,
): ProfileStatus {
	const self = chain.at(-1)
	if (!self) throw new Error('empty profile chain')
	if (self.revoked_at) return 'revoked'
	if (self.expires_at && self.expires_at <= now) return 'expired'
	const ancestorInactive = chain
		.slice(0, -1)
		.some((row) => row.revoked_at || (row.expires_at && row.expires_at <= now))
	return ancestorInactive ? 'parent_inactive' : 'active'
}

/** Earliest expiry across a chain, or null when nothing in it expires. */
export function chainExpiry(
	chain: ReadonlyArray<Pick<ProfileRow, 'expires_at'>>,
): string | null {
	let earliest: string | null = null
	for (const row of chain) {
		if (row.expires_at && (earliest === null || row.expires_at < earliest)) {
			earliest = row.expires_at
		}
	}
	return earliest
}

/**
 * Who is asking. `profileId` is the profile the credential acts as, or null
 * for the person themselves (the live mirror). `isOwner` is the person's org
 * role, which lets them list and revoke any profile but never edit one.
 */
export type ProfileActor = {
	userId: string
	profileId: string | null
	isOwner: boolean
}

export type ProfileAction = 'read' | 'edit' | 'revoke' | 'create_child'

/**
 * Decision B2: the person controls their own profiles; a profile controls only
 * its strict descendants, never itself, an ancestor, or a sibling; an Owner
 * may read and revoke any profile in the org but not edit one.
 */
export function canActOnProfile(input: {
	actor: ProfileActor
	/** Target chain, root first and the target last. */
	targetChain: ReadonlyArray<Pick<ProfileRow, 'id' | 'acting_user_id'>>
	action: ProfileAction
}): boolean {
	const target = input.targetChain.at(-1)
	if (!target) return false
	const { actor } = input
	if (target.acting_user_id === actor.userId) {
		if (actor.profileId === null) return true
		const ancestors = input.targetChain.slice(0, -1).map((row) => row.id)
		if (ancestors.includes(actor.profileId)) return true
		// A profile may create a child of itself, which is a strict descendant.
		return input.action === 'create_child' && target.id === actor.profileId
	}
	if (actor.isOwner && actor.profileId === null) {
		return input.action === 'read' || input.action === 'revoke'
	}
	return false
}

/** Expiry only shortens: a later time or clearing it is an extension. */
export function isExpiryExtension(input: {
	current: string | null
	next: string | null
}): boolean {
	if (input.next === null) return input.current !== null
	if (input.current === null) return false
	return input.next > input.current
}

export type RequestedProfileGrant = {
	resourceType: ProfileGrantResourceType
	resourceId: string
	permissions: ReadonlyArray<OrgPermission>
}

export type ProfileGrantRefusal =
	| {
			code: 'profile_grant_not_allowed'
			grant: RequestedProfileGrant
			permission?: OrgPermission
	  }
	| {
			code: 'profile_grant_exceeds_caller'
			grant: RequestedProfileGrant
			permission: OrgPermission
	  }
	| {
			code: 'profile_grant_exceeds_parent'
			grant: RequestedProfileGrant
			permission: OrgPermission
	  }

/** A credential grant uses the family of its permission (`secret` or `integration`). */
function permissionFamily(
	grant: RequestedProfileGrant,
	permission: OrgPermission,
): OrgResourceType {
	if (grant.resourceType === 'org') {
		throw new Error('org grants carry org-level permissions, not a family')
	}
	if (grant.resourceType !== 'credential') return grant.resourceType
	return permission.startsWith('integration:') ? 'integration' : 'secret'
}

/**
 * A new profile's grants must be a subset of what the creator holds now and,
 * for a child, of its parent's snapshot. Returns the first refusal.
 */
export function checkProfileGrants(input: {
	grants: ReadonlyArray<RequestedProfileGrant>
	callerHolds: (
		resourceType: ProfileGrantResourceType,
		resourceId: string,
		permission: OrgPermission,
	) => boolean
	/** Parent snapshot keyed by `${type}:${id}`, or null for a top-level profile. */
	parentGrants: ReadonlyMap<string, ReadonlySet<OrgPermission>> | null
	/** The org the profile lives in; an `org` grant must name it. */
	orgId?: string
}): ProfileGrantRefusal | null {
	for (const grant of input.grants) {
		if (grant.resourceType === 'org') {
			if (
				(input.orgId !== undefined && grant.resourceId !== input.orgId) ||
				grant.permissions.length === 0
			) {
				return { code: 'profile_grant_not_allowed', grant }
			}
			for (const permission of grant.permissions) {
				if (!isProfileOrgLevelPermission(permission)) {
					return { code: 'profile_grant_not_allowed', grant, permission }
				}
				if (
					input.parentGrants &&
					!input.parentGrants.get(`org:${grant.resourceId}`)?.has(permission)
				) {
					return { code: 'profile_grant_exceeds_parent', grant, permission }
				}
				if (!input.callerHolds('org', grant.resourceId, permission)) {
					return { code: 'profile_grant_exceeds_caller', grant, permission }
				}
			}
			continue
		}
		if (
			!(profileGrantResourceTypes as ReadonlyArray<string>).includes(
				grant.resourceType,
			) ||
			grant.permissions.length === 0
		) {
			return { code: 'profile_grant_not_allowed', grant }
		}
		for (const permission of grant.permissions) {
			if (
				!isGrantablePermission(permissionFamily(grant, permission), permission)
			) {
				return { code: 'profile_grant_not_allowed', grant, permission }
			}
			if (input.parentGrants) {
				const held = input.parentGrants.get(
					`${grant.resourceType}:${grant.resourceId}`,
				)
				if (!held?.has(permission)) {
					return { code: 'profile_grant_exceeds_parent', grant, permission }
				}
			}
			if (
				!input.callerHolds(grant.resourceType, grant.resourceId, permission)
			) {
				return { code: 'profile_grant_exceeds_caller', grant, permission }
			}
		}
	}
	return null
}

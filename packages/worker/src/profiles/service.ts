/**
 * Profiles (ADR 0092): scoped identities a person creates for agents. This
 * module is the only writer; capabilities and routes call it.
 */
import { experimentOffMessage } from '#universal/feature-flags/experiments.ts'
import {
	checkPermission,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { ProfileError } from './errors.ts'
import { isProfilesEnabledFor } from './flag.ts'
import {
	canActOnProfile,
	chainExpiry,
	checkProfileGrants,
	isExpiryExtension,
	maxActiveProfilesPerPerson,
	maxGrantsPerProfile,
	maxProfileDepth,
	profileNamePattern,
	profileStatus,
	type ProfileAction,
	type ProfileActor,
	type ProfileRow,
	type ProfileStatus,
	type RequestedProfileGrant,
} from './rules.ts'
import {
	countActiveProfiles,
	insertProfile,
	listProfileRows,
	loadProfileChain,
	loadProfileGrants,
	profileNameTaken,
	revokeProfileRow,
	shortenProfileExpiry,
	type ProfileGrantRow,
} from './store.ts'

export type ProfilesCaller = {
	env: Env
	request: RequestContext
	orgId: string
	actor: ProfileActor
	/** Whether the caller holds `permission` on that one resource right now. */
	holds: (
		resourceType: string,
		resourceId: string,
		permission: OrgPermission,
	) => boolean
}

export async function requireProfilesCaller(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<ProfilesCaller> {
	const request = input.callerContext.request
	if (!request?.actor) {
		throw new ProfileError({
			status: 401,
			code: 'insufficient_scope',
			message: 'Profiles need a signed-in person.',
		})
	}
	if (
		!(await isProfilesEnabledFor(
			input.env.APP_DB,
			request.actor.userId,
			request.org.id,
		))
	) {
		throw new ProfileError({
			status: 403,
			code: 'feature_disabled',
			message: experimentOffMessage('profiles'),
		})
	}
	if (!request.membership) {
		throw new ProfileError({
			status: 403,
			code: 'not_allowed',
			message: 'Only org members can have profiles in this org.',
		})
	}
	const effective = await computeEffectivePermissions({
		env: input.env,
		request,
	})
	const decision = checkPermission(effective, 'profile:manage')
	if (!decision.allowed) {
		throw new ProfileError({
			status: 403,
			code: 'insufficient_scope',
			message: decision.error.message,
		})
	}
	return {
		env: input.env,
		request,
		orgId: request.org.id,
		actor: {
			userId: request.actor.userId,
			profileId: request.credential.profileId ?? null,
			isOwner: effective.isOwner,
		},
		holds: (resourceType, resourceId, permission) =>
			checkPermission(effective, permission, {
				type: resourceType as never,
				id: resourceId,
				orgId: effective.orgId,
			}).allowed,
	}
}

export type ProfileView = {
	id: string
	name: string
	parentProfileId: string | null
	actingUserId: string
	depth: number
	status: ProfileStatus
	expiresAt: string | null
	/** Earliest expiry across the profile and its ancestors. */
	effectiveExpiresAt: string | null
	revokedAt: string | null
	createdAt: string
	createdByProfileId: string | null
	/** Root first, this profile last. */
	chain: Array<{ id: string; name: string }>
	grants: Array<ProfileGrantRow>
}

function view(
	chain: ReadonlyArray<ProfileRow>,
	grants: ReadonlyArray<ProfileGrantRow>,
	now: string,
): ProfileView {
	const row = chain.at(-1)!
	return {
		id: row.id,
		name: row.name,
		parentProfileId: row.parent_profile_id,
		actingUserId: row.acting_user_id,
		depth: row.depth,
		status: profileStatus(chain, now),
		expiresAt: row.expires_at,
		effectiveExpiresAt: chainExpiry(chain),
		revokedAt: row.revoked_at,
		createdAt: row.created_at,
		createdByProfileId: row.created_by_profile_id,
		chain: chain.map((entry) => ({ id: entry.id, name: entry.name })),
		grants: [...grants],
	}
}

function notFound(): never {
	throw new ProfileError({
		status: 404,
		code: 'not_found',
		message: 'No profile with that id in this org.',
	})
}

async function loadAuthorizedChain(
	caller: ProfilesCaller,
	profileId: string,
	action: ProfileAction,
) {
	const chain = await loadProfileChain(caller.env.APP_DB, {
		orgId: caller.orgId,
		profileId,
	})
	if (chain.length === 0) notFound()
	if (!canActOnProfile({ actor: caller.actor, targetChain: chain, action })) {
		// Reading someone else's profile is indistinguishable from a miss.
		if (action === 'read') notFound()
		throw new ProfileError({
			status: 403,
			code: 'not_allowed',
			message:
				action === 'revoke'
					? 'You can revoke your own profiles, profiles below the one you act as, or (as an Owner) any profile in this org.'
					: 'Only the person a profile acts for, or a profile above it, can change it. A profile cannot change itself, its parents, or its siblings, and an Owner can only list and revoke.',
		})
	}
	return chain
}

function parseExpiry(value: string | null | undefined, now: string) {
	if (value === undefined || value === null) return value ?? null
	const parsed = new Date(value)
	if (Number.isNaN(parsed.getTime())) {
		throw new ProfileError({
			status: 400,
			code: 'invalid_request',
			message: 'expires_at must be an ISO 8601 date-time.',
		})
	}
	const iso = parsed.toISOString()
	if (iso <= now) {
		throw new ProfileError({
			status: 400,
			code: 'invalid_request',
			message: 'expires_at must be in the future.',
		})
	}
	return iso
}

function grantMap(grants: ReadonlyArray<ProfileGrantRow>) {
	const map = new Map<string, Set<OrgPermission>>()
	for (const grant of grants) {
		const key = `${grant.resourceType}:${grant.resourceId}`
		const set = map.get(key) ?? new Set<OrgPermission>()
		for (const permission of grant.permissions) set.add(permission)
		map.set(key, set)
	}
	return map
}

/** Intersection of every ancestor's snapshot: what a child may still get. */
function chainGrantCap(
	chain: ReadonlyArray<ProfileRow>,
	grantsByProfile: ReadonlyMap<string, ReadonlyArray<ProfileGrantRow>>,
) {
	let cap: Map<string, Set<OrgPermission>> | null = null
	for (const row of chain) {
		const own = grantMap(grantsByProfile.get(row.id) ?? [])
		if (cap === null) {
			cap = own
			continue
		}
		const next = new Map<string, Set<OrgPermission>>()
		for (const [key, permissions] of cap) {
			const held = own.get(key)
			if (!held) continue
			const both = new Set([...permissions].filter((p) => held.has(p)))
			if (both.size > 0) next.set(key, both)
		}
		cap = next
	}
	return cap ?? new Map<string, Set<OrgPermission>>()
}

export async function createProfile(
	caller: ProfilesCaller,
	input: {
		name: string
		parentProfileId?: string | null
		expiresAt?: string | null
		grants?: ReadonlyArray<RequestedProfileGrant>
	},
): Promise<ProfileView> {
	const db = caller.env.APP_DB
	const now = new Date().toISOString()
	const name = input.name.trim().toLowerCase()
	if (!profileNamePattern.test(name)) {
		throw new ProfileError({
			status: 400,
			code: 'invalid_request',
			message:
				'Profile names are 1 to 63 lowercase letters, digits, or dashes, starting with a letter or digit.',
		})
	}
	const grants = input.grants ?? []
	if (grants.length > maxGrantsPerProfile) {
		throw new ProfileError({
			status: 400,
			code: 'invalid_request',
			message: `A profile can start with at most ${maxGrantsPerProfile} grants.`,
		})
	}
	let parentChain: Array<ProfileRow> = []
	const parentProfileId = input.parentProfileId ?? caller.actor.profileId
	if (parentProfileId) {
		parentChain = await loadAuthorizedChain(
			caller,
			parentProfileId,
			'create_child',
		)
		if (profileStatus(parentChain, now) !== 'active') {
			throw new ProfileError({
				status: 409,
				code: 'profile_inactive',
				message:
					'That parent profile, or one above it, is revoked or expired, so it cannot get sub-profiles.',
			})
		}
		if (parentChain.length >= maxProfileDepth) {
			throw new ProfileError({
				status: 400,
				code: 'profile_depth_exceeded',
				message: `Profiles nest at most ${maxProfileDepth} levels deep; this parent is already at level ${parentChain.length}.`,
			})
		}
	}
	let expiresAt = parseExpiry(input.expiresAt, now)
	const parentExpiry = chainExpiry(parentChain)
	if (parentExpiry !== null) {
		if (expiresAt !== null && expiresAt > parentExpiry) {
			throw new ProfileError({
				status: 400,
				code: 'profile_expiry_extension',
				message: `A sub-profile cannot outlive its parents; the earliest parent expiry is ${parentExpiry}.`,
			})
		}
		expiresAt ??= parentExpiry
	}
	const actingUserId = caller.actor.userId
	if (
		(await countActiveProfiles(db, {
			orgId: caller.orgId,
			actingUserId,
			now,
		})) >= maxActiveProfilesPerPerson
	) {
		throw new ProfileError({
			status: 409,
			code: 'profile_limit_reached',
			message: `You can have at most ${maxActiveProfilesPerPerson} live profiles in an org. Revoke one first.`,
		})
	}
	if (
		await profileNameTaken(db, {
			orgId: caller.orgId,
			actingUserId,
			parentProfileId: parentProfileId ?? null,
			name,
		})
	) {
		throw new ProfileError({
			status: 409,
			code: 'profile_name_taken',
			message: `You already have a profile named "${name}" here. Names are unique under the same parent.`,
		})
	}
	const grantsByProfile = parentChain.length
		? await loadProfileGrants(db, {
				orgId: caller.orgId,
				profileIds: parentChain.map((row) => row.id),
			})
		: new Map<string, Array<ProfileGrantRow>>()
	const refusal = checkProfileGrants({
		grants,
		parentGrants: parentChain.length
			? chainGrantCap(parentChain, grantsByProfile)
			: null,
		callerHolds: caller.holds,
		orgId: caller.orgId,
	})
	if (refusal) {
		const target = `${refusal.grant.resourceType} ${refusal.grant.resourceId}`
		throw new ProfileError({
			status: refusal.code === 'profile_grant_not_allowed' ? 400 : 403,
			code: refusal.code,
			message:
				refusal.code === 'profile_grant_exceeds_parent'
					? `The parent profile chain does not hold ${refusal.permission} on ${target}, so a sub-profile cannot get it.`
					: refusal.code === 'profile_grant_exceeds_caller'
						? `You do not hold ${refusal.permission} on ${target}, so a profile you create cannot get it.`
						: `A profile cannot be granted ${refusal.permission ?? 'that'} on ${target}. Profile grants name one resource (never the whole org) with permissions of its kind.`,
			details: { grant: refusal.grant },
		})
	}
	const row: ProfileRow = {
		id: `prf_${crypto.randomUUID().replaceAll('-', '')}`,
		org_id: caller.orgId,
		owner_kind: 'person',
		acting_user_id: actingUserId,
		parent_profile_id: parentProfileId ?? null,
		name,
		depth: parentChain.length + 1,
		expires_at: expiresAt,
		revoked_at: null,
		revoked_by_user_id: null,
		created_by_user_id: actingUserId,
		created_by_profile_id: caller.actor.profileId,
		created_at: now,
		updated_at: now,
	}
	try {
		await insertProfile(db, { row, grants })
	} catch (error) {
		if (String(error).includes('UNIQUE constraint failed')) {
			throw new ProfileError({
				status: 409,
				code: 'profile_name_taken',
				message: `You already have a profile named "${name}" here.`,
			})
		}
		throw error
	}
	return await getProfile(caller, row.id)
}

export async function getProfile(
	caller: ProfilesCaller,
	profileId: string,
): Promise<ProfileView> {
	const chain = await loadAuthorizedChain(caller, profileId, 'read')
	const grants = await loadProfileGrants(caller.env.APP_DB, {
		orgId: caller.orgId,
		profileIds: [profileId],
	})
	return view(chain, grants.get(profileId) ?? [], new Date().toISOString())
}

/**
 * The caller's profiles (or, for an acting profile, its descendants). An Owner
 * may pass `allMembers` to list every profile in the org.
 */
export async function listProfiles(
	caller: ProfilesCaller,
	input: { allMembers?: boolean } = {},
): Promise<Array<ProfileView>> {
	if (input.allMembers && !(caller.actor.isOwner && !caller.actor.profileId)) {
		throw new ProfileError({
			status: 403,
			code: 'not_allowed',
			message: 'Only an org Owner can list every member’s profiles.',
		})
	}
	const rows = await listProfileRows(caller.env.APP_DB, {
		orgId: caller.orgId,
		actingUserId: input.allMembers ? null : caller.actor.userId,
	})
	const byId = new Map(rows.map((row) => [row.id, row]))
	const chainOf = (row: ProfileRow) => {
		const chain = [row]
		let parent = row.parent_profile_id
		while (parent) {
			const next = byId.get(parent)
			if (!next) break
			chain.unshift(next)
			parent = next.parent_profile_id
		}
		return chain
	}
	const visible = rows
		.map((row) => chainOf(row))
		.filter((chain) =>
			input.allMembers
				? true
				: canActOnProfile({
						actor: caller.actor,
						targetChain: chain,
						action: 'read',
					}),
		)
	const grants = await loadProfileGrants(caller.env.APP_DB, {
		orgId: caller.orgId,
		profileIds: visible.map((chain) => chain.at(-1)!.id),
	})
	const now = new Date().toISOString()
	return visible.map((chain) =>
		view(chain, grants.get(chain.at(-1)!.id) ?? [], now),
	)
}

/** Shorten-only expiry (decision: profiles never get more time). */
export async function updateProfile(
	caller: ProfilesCaller,
	input: { profileId: string; expiresAt: string | null },
): Promise<ProfileView> {
	const chain = await loadAuthorizedChain(caller, input.profileId, 'edit')
	const row = chain.at(-1)!
	const now = new Date().toISOString()
	if (row.revoked_at) {
		throw new ProfileError({
			status: 409,
			code: 'profile_inactive',
			message: 'That profile is revoked; revoke is final.',
		})
	}
	const expiresAt = parseExpiry(input.expiresAt, now)
	if (isExpiryExtension({ current: row.expires_at, next: expiresAt })) {
		throw new ProfileError({
			status: 400,
			code: 'profile_expiry_extension',
			message:
				'A profile’s expiry can only move earlier. Create a new profile for more time.',
		})
	}
	if (expiresAt !== null && expiresAt !== row.expires_at) {
		const changed = await shortenProfileExpiry(caller.env.APP_DB, {
			orgId: caller.orgId,
			profileId: row.id,
			expiresAt,
			now,
		})
		if (!changed) {
			throw new ProfileError({
				status: 409,
				code: 'profile_expiry_extension',
				message:
					'The profile changed while you were editing it; read it again and retry.',
			})
		}
	}
	return await getProfile(caller, row.id)
}

/**
 * Terminal revoke. Descendants stop working through the chain lookup; their
 * rows are not rewritten. Revoking twice is a no-op.
 */
export async function revokeProfile(
	caller: ProfilesCaller,
	input: { profileId: string },
): Promise<ProfileView> {
	const chain = await loadAuthorizedChain(caller, input.profileId, 'revoke')
	await revokeProfileRow(caller.env.APP_DB, {
		orgId: caller.orgId,
		profileId: input.profileId,
		revokedByUserId: caller.actor.userId,
		now: new Date().toISOString(),
	})
	const refreshed = await loadProfileChain(caller.env.APP_DB, {
		orgId: caller.orgId,
		profileId: input.profileId,
	})
	const grants = await loadProfileGrants(caller.env.APP_DB, {
		orgId: caller.orgId,
		profileIds: [input.profileId],
	})
	return view(
		refreshed.length ? refreshed : chain,
		grants.get(input.profileId) ?? [],
		new Date().toISOString(),
	)
}

/**
 * Accepting an invite link. Membership links keep their original behavior;
 * team and package links are single use per person and never remove access
 * the person already has.
 */
import {
	resolveGrantPermissions,
	type GrantPreset,
} from '@kody-internal/shared/grant-presets.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	compileAccessForActor,
	resourceGrantKey,
} from '#worker/authorization/access-compile.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { isOrgActive } from '#worker/orgs/repo.ts'
import { addOrgMember, addTeamMember, upsertGrant } from './access-writes.ts'
import {
	emailMatchesInviteLinkDomains,
	getInviteLinkByTokenHash,
	inviteLinkBlockMessage,
	inviteLinkIsRedeemable,
	targetIsLive,
	targetNeedsTeamOrg,
	type InviteLinkRedeemBlockReason,
	type InviteLinkRole,
	type InviteLinkTarget,
	type StoredInviteLink,
} from './invite-links.ts'
import { recordOrgAuditEvent, type OrgAuditWriter } from './org-audit.ts'
import { syncSeatsAfterMembershipChange } from './seat-sync-after-membership.ts'

export async function hasRedeemedInviteLink(
	db: D1Database,
	linkId: string,
	userId: string,
) {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM org_invite_link_redemptions
			 WHERE link_id = ? AND user_id = ?`,
		)
		.bind(linkId, userId)
		.first<{ ok: number }>()
	return Boolean(row)
}

async function claimInviteLinkUse(input: {
	db: D1Database
	linkId: string
	userId: string
	nowIso: string
}): Promise<'claimed' | 'already' | 'unavailable'> {
	if (await hasRedeemedInviteLink(input.db, input.linkId, input.userId)) {
		return 'already'
	}

	const insert = await input.db
		.prepare(
			`INSERT OR IGNORE INTO org_invite_link_redemptions (
				link_id, user_id, created_at
			) VALUES (?, ?, ?)`,
		)
		.bind(input.linkId, input.userId, input.nowIso)
		.run()
	if ((insert.meta?.changes ?? 0) === 0) return 'already'

	const bumped = await input.db
		.prepare(
			`UPDATE org_invite_links
			 SET use_count = use_count + 1,
			     last_used_at = ?
			 WHERE id = ?
			   AND status = 'active'
			   AND expires_at > ?
			   AND (max_uses IS NULL OR use_count < max_uses)`,
		)
		.bind(input.nowIso, input.linkId, input.nowIso)
		.run()
	if ((bumped.meta?.changes ?? 0) === 0) {
		await input.db
			.prepare(
				`DELETE FROM org_invite_link_redemptions
				 WHERE link_id = ? AND user_id = ?`,
			)
			.bind(input.linkId, input.userId)
			.run()
		return 'unavailable'
	}
	return 'claimed'
}

/**
 * A link keeps working only while its creator could still make it. A
 * membership link needs the creator to still be a member (its original rule).
 * A team link needs team:write and member:write. A package link needs Manage
 * on that package, which an outside collaborator can hold through a grant.
 */
export async function inviteLinkCreatorStillValid(
	db: D1Database,
	link: InviteLinkCreatorCheck,
) {
	const role = await liveMembershipRole(db, link.orgId, link.createdByUserId)
	const target = link.target
	switch (target.kind) {
		case 'membership':
			return role != null
		case 'team': {
			if (role == null) return false
			const access = await creatorAccess(db, link, role)
			return (
				access.isOwner ||
				(access.orgPermissions.has('team:write') &&
					access.orgPermissions.has('member:write'))
			)
		}
		case 'resource': {
			const access = await creatorAccess(db, link, role)
			if (access.isOwner) return true
			if (access.orgPermissions.has('package:manage_access')) return true
			return (
				access.resourcePermissions
					.get(resourceGrantKey(target.resourceType, target.resourceId))
					?.has('package:manage_access') ?? false
			)
		}
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

type InviteLinkCreatorCheck = Pick<
	StoredInviteLink,
	'orgId' | 'createdByUserId' | 'target'
>

async function creatorAccess(
	db: D1Database,
	link: InviteLinkCreatorCheck,
	role: OrgRole | null,
) {
	return await compileAccessForActor({
		db,
		orgId: ownerIdFromStored(link.orgId),
		userId: link.createdByUserId,
		role,
	})
}

function seatRole(role: OrgRole) {
	return role === 'owner' || role === 'member'
}

async function liveMembershipRole(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<OrgRole | null> {
	const row = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ role: OrgRole }>()
	return row?.role ?? null
}

async function isLiveTeamMember(
	db: D1Database,
	teamId: string,
	userId: string,
) {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM team_members
			 WHERE team_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(teamId, userId)
		.first<{ ok: number }>()
	return Boolean(row)
}

async function directUserGrant(
	db: D1Database,
	orgId: string,
	target: Extract<InviteLinkTarget, { kind: 'resource' }>,
	userId: string,
): Promise<{ id: string; permissions: Array<OrgPermission> } | null> {
	const grant = await db
		.prepare(
			`SELECT id FROM grants
			 WHERE org_id = ?
			   AND resource_type = ?
			   AND resource_id = ?
			   AND subject_type = 'user'
			   AND subject_id = ?
			   AND deleted_at IS NULL
			   AND (expires_at IS NULL OR expires_at > ?)
			 LIMIT 1`,
		)
		.bind(
			orgId,
			target.resourceType,
			target.resourceId,
			userId,
			new Date().toISOString(),
		)
		.first<{ id: string }>()
	if (!grant) return null
	const permissions = await db
		.prepare(`SELECT permission FROM grant_permissions WHERE grant_id = ?`)
		.bind(grant.id)
		.all<{ permission: OrgPermission }>()
	return {
		id: grant.id,
		permissions: (permissions.results ?? []).map((row) => row.permission),
	}
}

function presetPermissions(preset: GrantPreset) {
	return resolveGrantPermissions({
		family: 'package',
		preset,
		permissions: null,
	})
}

/**
 * The grant a package link should leave in place: the link's preset merged
 * into any direct grant the person already holds. Accepting never removes a
 * permission, so a Manage collaborator who opens a Use link keeps Manage.
 * `null` when nothing would change.
 */
async function plannedResourceGrant(
	db: D1Database,
	orgId: string,
	target: Extract<InviteLinkTarget, { kind: 'resource' }>,
	userId: string,
): Promise<
	| { preset: GrantPreset; permissions: null }
	| { preset: null; permissions: Array<OrgPermission> }
	| null
> {
	const wanted = presetPermissions(target.preset)
	const existing = await directUserGrant(db, orgId, target, userId)
	if (!existing) return { preset: target.preset, permissions: null }
	const held = new Set(existing.permissions)
	if (wanted.every((permission) => held.has(permission))) return null
	const union = new Set<OrgPermission>([...existing.permissions, ...wanted])
	if (union.size === wanted.length) {
		return { preset: target.preset, permissions: null }
	}
	return { preset: null, permissions: [...union].sort() }
}

/**
 * True when accepting would change nothing for this person: they already
 * hold what the link gives (Owners already hold every package permission).
 */
export async function inviteLinkAlreadySatisfied(
	db: D1Database,
	link: StoredInviteLink,
	userId: string,
) {
	const role = await liveMembershipRole(db, link.orgId, userId)
	const target = link.target
	switch (target.kind) {
		case 'membership': {
			if (role == null) return false
			for (const teamId of await liveDefaultTeamIds(
				db,
				link.orgId,
				link.teamIds,
			)) {
				if (!(await isLiveTeamMember(db, teamId, userId))) return false
			}
			return true
		}
		case 'team':
			return role != null && (await isLiveTeamMember(db, target.teamId, userId))
		case 'resource':
			if (role === 'owner') return true
			return (
				(await plannedResourceGrant(db, link.orgId, target, userId)) == null
			)
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

export type RedeemInviteLinkResult =
	| {
			ok: true
			/** The person already had everything the link gives. */
			alreadyMember: boolean
			role: InviteLinkRole | null
			target: InviteLinkTarget
			orgId: string
	  }
	| { ok: false; reason: InviteLinkRedeemBlockReason; error: string }

function blocked(reason: InviteLinkRedeemBlockReason): RedeemInviteLinkResult {
	return { ok: false, reason, error: inviteLinkBlockMessage(reason) }
}

export type InviteLinkTargetBlockReason = Extract<
	InviteLinkRedeemBlockReason,
	| 'revoked'
	| 'expired'
	| 'exhausted'
	| 'personal_org'
	| 'org_inactive'
	| 'target_gone'
>

/**
 * Checks that do not depend on who is accepting. The join page uses the same
 * checks so it never shows an Accept button for a link that cannot work.
 */
export async function inviteLinkTargetBlock(
	db: D1Database,
	link: StoredInviteLink,
	nowIso = new Date().toISOString(),
): Promise<InviteLinkTargetBlockReason | null> {
	const availability = inviteLinkIsRedeemable(link, nowIso)
	if (availability) return availability
	if (
		targetNeedsTeamOrg(link.target) &&
		(await isPersonalOrg(db, link.orgId))
	) {
		return 'personal_org'
	}
	if (!(await isOrgActive(db, link.orgId))) return 'org_inactive'
	if (!(await targetIsLive(db, link.orgId, link.target))) return 'target_gone'
	return null
}

export async function redeemOrgInviteLink(input: {
	db: D1Database
	env: Env
	link: StoredInviteLink
	user: {
		userId: string
		email: string
		emailVerified: boolean
	}
	audit: OrgAuditWriter
}): Promise<RedeemInviteLinkResult> {
	const nowIso = new Date().toISOString()
	const { link } = input
	const linkBlock = await inviteLinkTargetBlock(input.db, link, nowIso)
	if (linkBlock) return blocked(linkBlock)
	if (!(await inviteLinkCreatorStillValid(input.db, link))) {
		return blocked('inviter_gone')
	}
	if (link.allowedEmailDomains.length > 0) {
		if (!input.user.emailVerified) return blocked('unverified_email')
		if (
			!emailMatchesInviteLinkDomains(input.user.email, link.allowedEmailDomains)
		) {
			return blocked('domain')
		}
	}
	const target = link.target
	switch (target.kind) {
		case 'membership':
			return await redeemMembershipLink({ ...input, target, nowIso })
		case 'team':
			return await redeemTeamLink({ ...input, target, nowIso })
		case 'resource':
			return await redeemResourceLink({ ...input, target, nowIso })
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

type RedeemInput<Target extends InviteLinkTarget> = {
	db: D1Database
	env: Env
	link: StoredInviteLink
	target: Target
	user: { userId: string }
	audit: OrgAuditWriter
	nowIso: string
}

async function blockedAfterUnavailableClaim(
	db: D1Database,
	link: StoredInviteLink,
	nowIso: string,
) {
	const refreshed = await getInviteLinkByTokenHash(db, link.tokenHash)
	return blocked(
		refreshed == null
			? 'invalid'
			: (inviteLinkIsRedeemable(refreshed, nowIso) ?? 'exhausted'),
	)
}

async function recordJoined(
	input: RedeemInput<InviteLinkTarget>,
	details: Record<string, unknown>,
) {
	await recordOrgAuditEvent(input.audit, {
		orgId: input.link.orgId,
		action: 'invite_link.joined',
		resourceType: 'invite_link',
		resourceId: input.link.id,
		targetUserId: input.user.userId,
		details: { ...details, linkId: input.link.id },
	})
}

async function liveDefaultTeamIds(
	db: D1Database,
	orgId: string,
	teamIds: ReadonlyArray<string>,
) {
	const liveTeamIds: Array<string> = []
	for (const teamId of teamIds) {
		const team = await db
			.prepare(
				`SELECT id FROM teams
				 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
			)
			.bind(teamId, orgId)
			.first<{ id: string }>()
		if (team) liveTeamIds.push(team.id)
	}
	return liveTeamIds
}

async function addLiveDefaultTeams(
	input: RedeemInput<Extract<InviteLinkTarget, { kind: 'membership' }>>,
	liveTeamIds: ReadonlyArray<string>,
) {
	for (const teamId of liveTeamIds) {
		await addTeamMember({
			db: input.db,
			orgId: input.link.orgId,
			teamId,
			userId: input.user.userId,
			addedByUserId: input.link.createdByUserId,
			audit: input.audit,
		})
	}
}

async function redeemMembershipLink(
	input: RedeemInput<Extract<InviteLinkTarget, { kind: 'membership' }>>,
): Promise<RedeemInviteLinkResult> {
	const { db, link, target, user } = input
	const success = (alreadyMember: boolean): RedeemInviteLinkResult => ({
		ok: true,
		alreadyMember,
		role: target.role,
		target,
		orgId: link.orgId,
	})
	const liveTeamIds = await liveDefaultTeamIds(db, link.orgId, link.teamIds)
	const finishMembershipAccess = async () => {
		await addLiveDefaultTeams(input, liveTeamIds)
		// Seat sync sits after teams. A prior attempt may have added the
		// member and then failed before sync; retries must still catch up.
		if (seatRole(target.role)) {
			await syncSeatsAfterMembershipChange({
				db,
				env: input.env,
				orgId: link.orgId,
			})
		}
	}
	// Already in the org: still apply missing default teams. A prior attempt
	// may have granted membership and then failed mid-team-write; releasing
	// the claim would leave a member with no redemption and no teams.
	if (await liveMembershipRole(db, link.orgId, user.userId)) {
		await finishMembershipAccess()
		return success(true)
	}

	const claimed = await claimInviteLinkUse({
		db,
		linkId: link.id,
		userId: user.userId,
		nowIso: input.nowIso,
	})
	if (claimed === 'unavailable') {
		return await blockedAfterUnavailableClaim(db, link, input.nowIso)
	}

	const alreadyRedeemed = claimed === 'already'
	if (
		alreadyRedeemed &&
		(await liveMembershipRole(db, link.orgId, user.userId))
	) {
		await finishMembershipAccess()
		return success(true)
	}

	const writeMembership = async () => {
		await addOrgMember({
			db,
			orgId: link.orgId,
			userId: user.userId,
			role: target.role,
			invitedByUserId: link.createdByUserId,
			audit: input.audit,
		})
		await finishMembershipAccess()
	}
	if (alreadyRedeemed) {
		await writeMembership()
	} else {
		try {
			await writeMembership()
		} catch (error) {
			// Do not release after a partial grant: membership would remain
			// while the claim disappears, and retries would skip team writes.
			if (!(await liveMembershipRole(db, link.orgId, user.userId))) {
				await releaseClaim({ ...input, target })
			}
			throw error
		}
	}
	if (!alreadyRedeemed) {
		await recordJoined(input, {
			role: target.role,
			teamIds: liveTeamIds,
		})
	}
	return success(false)
}

/**
 * Team and package links are spent per person: someone removed from the team
 * or package after accepting cannot add themselves back with the same link.
 * (Membership links keep their original rejoin behavior.)
 */
async function claimSingleUse(
	input: RedeemInput<InviteLinkTarget>,
): Promise<RedeemInviteLinkResult | null> {
	const claimed = await claimInviteLinkUse({
		db: input.db,
		linkId: input.link.id,
		userId: input.user.userId,
		nowIso: input.nowIso,
	})
	if (claimed === 'already') return blocked('already_used')
	if (claimed === 'unavailable') {
		return await blockedAfterUnavailableClaim(
			input.db,
			input.link,
			input.nowIso,
		)
	}
	return null
}

/**
 * Gives back a claimed use when the access write after it fails, so the
 * person can retry and a one-use link is not spent on nothing.
 */
async function withClaimReleasedOnFailure<T>(
	input: RedeemInput<InviteLinkTarget>,
	write: () => Promise<T>,
): Promise<T> {
	try {
		return await write()
	} catch (error) {
		await releaseClaim(input)
		throw error
	}
}

async function releaseClaim(input: RedeemInput<InviteLinkTarget>) {
	await input.db.batch([
		input.db
			.prepare(
				`DELETE FROM org_invite_link_redemptions
					 WHERE link_id = ? AND user_id = ?`,
			)
			.bind(input.link.id, input.user.userId),
		input.db
			.prepare(
				`UPDATE org_invite_links
					 SET use_count = MAX(use_count - 1, 0)
					 WHERE id = ?`,
			)
			.bind(input.link.id),
	])
}

async function redeemTeamLink(
	input: RedeemInput<Extract<InviteLinkTarget, { kind: 'team' }>>,
): Promise<RedeemInviteLinkResult> {
	const { db, link, target, user } = input
	const success = (alreadyMember: boolean): RedeemInviteLinkResult => ({
		ok: true,
		alreadyMember,
		role: 'member',
		target,
		orgId: link.orgId,
	})
	const role = await liveMembershipRole(db, link.orgId, user.userId)
	if (role && (await isLiveTeamMember(db, target.teamId, user.userId))) {
		return success(true)
	}
	const claimBlock = await claimSingleUse(input)
	if (claimBlock) return claimBlock
	await withClaimReleasedOnFailure(input, async () => {
		if (!role) {
			await addOrgMember({
				db,
				orgId: link.orgId,
				userId: user.userId,
				role: 'member',
				invitedByUserId: link.createdByUserId,
				audit: input.audit,
			})
			await syncSeatsAfterMembershipChange({
				db,
				env: input.env,
				orgId: link.orgId,
			})
		}
		await addTeamMember({
			db,
			orgId: link.orgId,
			teamId: target.teamId,
			userId: user.userId,
			addedByUserId: link.createdByUserId,
			audit: input.audit,
		})
	})
	await recordJoined(input, {
		kind: 'team',
		teamId: target.teamId,
		joinedOrg: !role,
	})
	return success(false)
}

async function redeemResourceLink(
	input: RedeemInput<Extract<InviteLinkTarget, { kind: 'resource' }>>,
): Promise<RedeemInviteLinkResult> {
	const { db, link, target, user } = input
	const success = (alreadyMember: boolean): RedeemInviteLinkResult => ({
		ok: true,
		alreadyMember,
		role: null,
		target,
		orgId: link.orgId,
	})
	const role = await liveMembershipRole(db, link.orgId, user.userId)
	if (role === 'owner') return success(true)
	if (!(await plannedResourceGrant(db, link.orgId, target, user.userId))) {
		return success(true)
	}
	const claimBlock = await claimSingleUse(input)
	if (claimBlock) return claimBlock
	// Plan again after the claim so a grant change that landed meanwhile is
	// merged rather than overwritten by a stale snapshot.
	const planned = await plannedResourceGrant(
		db,
		link.orgId,
		target,
		user.userId,
	)
	if (!planned) {
		await releaseClaim(input)
		return success(true)
	}
	await withClaimReleasedOnFailure(input, () =>
		upsertGrant({
			db,
			orgId: link.orgId,
			resourceType: target.resourceType,
			resourceId: target.resourceId,
			family: 'package',
			subject: { type: 'user', id: user.userId },
			preset: planned.preset,
			permissions: planned.permissions,
			createdByUserId: link.createdByUserId,
			audit: input.audit,
		}),
	)
	await recordJoined(input, {
		kind: 'resource',
		resourceType: target.resourceType,
		resourceId: target.resourceId,
		preset: target.preset,
		outsideCollaborator: role == null,
	})
	return success(false)
}

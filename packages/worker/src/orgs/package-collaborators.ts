import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import { listGrants } from '#worker/orgs/access-writes.ts'
import { listPackageProfileGrants } from '#worker/profiles/package-grants.ts'
import {
	grantPresets,
	permissionsForGrantPreset,
} from '@kody-internal/shared/grant-presets.ts'
import { listOrgMembers } from '#worker/orgs/org-members-list.ts'
import { listTeams } from '#worker/orgs/org-teams-list.ts'
import {
	isPackageCollaboratorPreset,
	type PackageCollaboratorEveryoneOption,
	type PackageCollaboratorInviteView,
	type PackageCollaboratorKind,
	type PackageCollaboratorMemberOption,
	type PackageCollaboratorTeamOption,
	type PackageCollaboratorView,
} from '#universal/package-collaborators.ts'

export type PackageCollaborators = {
	collaborators: Array<PackageCollaboratorView>
	options: {
		everyone: PackageCollaboratorEveryoneOption | null
		teams: Array<PackageCollaboratorTeamOption>
		members: Array<PackageCollaboratorMemberOption>
	}
}

type UserRow = {
	user_id: string
	username: string | null
	display_name: string | null
	avatar_key: string | null
}

function readPresetFromPermissions(permissions: ReadonlyArray<string>) {
	const held = new Set(permissions)
	return (
		grantPresets.find((preset) => {
			const expected = permissionsForGrantPreset('package', preset)
			return (
				expected.length === held.size &&
				expected.every((permission) => held.has(permission))
			)
		}) ?? null
	)
}

function readPreset(value: string | null) {
	return value !== null && isPackageCollaboratorPreset(value) ? value : null
}

const kindOrder: Record<PackageCollaboratorKind, number> = {
	org: 0,
	team: 1,
	member: 2,
	outside: 3,
	profile: 4,
}

export const everyoneInOrgLabel = 'Everyone in this organization'

async function loadUsers(db: D1Database, userIds: ReadonlyArray<string>) {
	if (userIds.length === 0) return new Map<string, UserRow>()
	const rows = await db
		.prepare(
			`SELECT stable_user_id AS user_id, username, display_name, avatar_key
			 FROM users
			 WHERE deleted_at IS NULL
			   AND stable_user_id IN (${userIds.map(() => '?').join(', ')})`,
		)
		.bind(...userIds)
		.all<UserRow>()
	return new Map((rows.results ?? []).map((row) => [row.user_id, row]))
}

/** Pending, unexpired grant invites on one package. Callers authorize first. */
export async function listPendingPackageInvites(input: {
	db: D1Database
	orgId: string
	packageId: string
	now?: string
}): Promise<Array<PackageCollaboratorInviteView>> {
	const rows = await input.db
		.prepare(
			`SELECT id, preset, invitee_email, invitee_username, expires_at, created_at
			 FROM invites
			 WHERE org_id = ?
			   AND kind = 'grant'
			   AND resource_type = 'package'
			   AND resource_id = ?
			   AND status = 'pending'
			   AND expires_at > ?
			 ORDER BY created_at DESC, id ASC`,
		)
		.bind(input.orgId, input.packageId, input.now ?? new Date().toISOString())
		.all<{
			id: string
			preset: string | null
			invitee_email: string | null
			invitee_username: string | null
			expires_at: string
			created_at: string
		}>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		inviteeEmail: row.invitee_email,
		inviteeUsername: row.invitee_username,
		preset: readPreset(row.preset),
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	}))
}

/**
 * Everyone who holds a live grant on one package in its owning org (everyone
 * in the org, teams, members, and outside collaborators) and the subjects a
 * manager can still add. Callers authorize first.
 */
export async function listPackageCollaborators(input: {
	db: D1Database
	orgId: string
	packageId: string
}): Promise<PackageCollaborators> {
	const { db, orgId, packageId } = input
	const [grants, members, teams, profileGrants] = await Promise.all([
		listGrants({ db, orgId, resourceType: 'package', resourceId: packageId }),
		listOrgMembers(db, orgId),
		listTeams(db, orgId),
		listPackageProfileGrants({ db, orgId, packageId }),
	])
	const memberIds = new Set(members.map((member) => member.userId))
	const teamsById = new Map(teams.map((team) => [team.id, team]))
	const users = await loadUsers(db, [
		...new Set(
			grants
				.filter((grant) => grant.subjectType === 'user')
				.map((grant) => grant.subjectId),
		),
	])

	const collaborators = grants.flatMap(
		(grant): Array<PackageCollaboratorView> => {
			const base = {
				grantId: grant.id,
				subjectId: grant.subjectId,
				preset: readPreset(grant.preset),
				permissions: grant.permissions,
				createdAt: grant.createdAt,
				allowUnmappableCredentialChanges:
					grant.allowUnmappableCredentialChanges,
			}
			if (grant.subjectType === 'org') {
				// The subject is only ever this org; anything else grants nobody.
				if (grant.subjectId !== orgId) return []
				return [
					{
						...base,
						subjectType: 'org',
						kind: 'org',
						label: everyoneInOrgLabel,
						username: null,
						displayName: null,
						avatarUrl: null,
						teamSlug: null,
						teamMemberCount: members.length,
					},
				]
			}
			if (grant.subjectType === 'team') {
				const team = teamsById.get(grant.subjectId)
				// A deleted team's leftover grant gives nobody access; leave it out.
				if (!team) return []
				return [
					{
						...base,
						subjectType: 'team',
						kind: 'team',
						label: team.name,
						username: null,
						displayName: null,
						avatarUrl: null,
						teamSlug: team.slug,
						teamMemberCount: team.memberCount,
					},
				]
			}
			const user = users.get(grant.subjectId)
			const username = user?.username ?? null
			return [
				{
					...base,
					subjectType: 'user',
					kind: memberIds.has(grant.subjectId) ? 'member' : 'outside',
					label: username
						? `@${username}`
						: user?.display_name?.trim() || 'Deleted account',
					username,
					displayName: user?.display_name ?? null,
					avatarUrl: username
						? buildUserAvatarUrl({
								username,
								avatarKey: user?.avatar_key ?? null,
							})
						: null,
					teamSlug: null,
					teamMemberCount: null,
				},
			]
		},
	)
	for (const grant of profileGrants) {
		collaborators.push({
			grantId: grant.grantId,
			subjectType: 'profile',
			subjectId: grant.profileId,
			kind: 'profile',
			label: grant.active
				? `Profile ${grant.profileName}`
				: `Profile ${grant.profileName} (inactive)`,
			username: null,
			displayName: null,
			avatarUrl: null,
			teamSlug: null,
			teamMemberCount: null,
			profileName: grant.profileName,
			profileActive: grant.active,
			preset: readPresetFromPermissions(grant.permissions),
			permissions: grant.permissions,
			createdAt: grant.createdAt,
		})
	}
	collaborators.sort(
		(left, right) =>
			kindOrder[left.kind] - kindOrder[right.kind] ||
			left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }),
	)

	const grantedTeams = new Set(
		grants.filter((g) => g.subjectType === 'team').map((g) => g.subjectId),
	)
	const grantedUsers = new Set(
		grants.filter((g) => g.subjectType === 'user').map((g) => g.subjectId),
	)
	const everyoneGranted = grants.some(
		(g) => g.subjectType === 'org' && g.subjectId === orgId,
	)
	return {
		collaborators,
		options: {
			everyone: everyoneGranted ? null : { orgId, memberCount: members.length },
			teams: teams
				.filter((team) => !grantedTeams.has(team.id))
				.map((team) => ({
					id: team.id,
					slug: team.slug,
					name: team.name,
					memberCount: team.memberCount,
				})),
			// Owners already hold every permission on every package.
			members: members
				.filter(
					(member) =>
						member.role !== 'owner' && !grantedUsers.has(member.userId),
				)
				.map((member) => ({
					userId: member.userId,
					username: member.username,
					displayName: member.displayName,
				})),
		},
	}
}

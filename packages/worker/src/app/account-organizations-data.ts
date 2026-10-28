import { grantPresets } from '@kody-internal/shared/grant-presets.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	type AccountOrganizationSummary,
	type AccountPendingInvite,
	type AccountRestorableOrganization,
} from '#universal/loader-data.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
import { packageCollaboratorPresetLabel } from '#universal/package-collaborators.ts'
import {
	listPendingInviteLinksForPerson,
	type PendingInviteLinkSummary,
} from '#worker/orgs/invite-link-pending.ts'
import { buildOrgAvatarUrl } from '#worker/orgs/org-avatar.ts'
import {
	listOrganizationsForPerson,
	listPendingInvitesForPerson,
	type PendingInviteSummary,
} from '#worker/orgs/repo.ts'
import { listRestorableOrganizationsForPerson } from '#worker/orgs/soft-delete.ts'
import { softDeleteRestoreDeadlineIso } from '#worker/soft-delete/window.ts'

export type AccountOrganizationSnapshot = {
	organizations: Array<AccountOrganizationSummary>
	restorableOrganizations: Array<AccountRestorableOrganization>
	inviteCount: number
	pendingInvites: Array<AccountPendingInvite>
}

type PendingInviteViewer = Pick<
	AuthenticatedAppUser,
	'email' | 'username' | 'mcpUser'
>

function inviteLinkLabel(link: PendingInviteLinkSummary) {
	const target = link.target
	switch (target.kind) {
		case 'membership':
			return `Join as ${orgRoleLabel(target.role)}`
		case 'team':
			return `Join the ${link.teamName ?? 'team'} team`
		case 'resource':
			return `${packageCollaboratorPresetLabel(target.preset)} access to ${link.packageName ?? 'a package'}`
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

function storedRoleLabel(role: string | null) {
	switch (role) {
		case 'owner':
		case 'member':
		case 'billing':
			return orgRoleLabel(role)
		default:
			return orgRoleLabel('member')
	}
}

function storedPresetLabel(preset: string | null) {
	const known = grantPresets.find((value) => value === preset)
	return known ? packageCollaboratorPresetLabel(known) : null
}

const grantResourceNouns: Record<string, string> = {
	org: 'the organization',
	credential: 'a credential',
	app: 'an app',
	job: 'a job',
	memory: 'a memory',
	email: 'an email inbox',
}

function addressedInviteLabel(invite: PendingInviteSummary) {
	if (invite.kind === 'membership') {
		return `Join as ${storedRoleLabel(invite.role)}`
	}
	const preset = storedPresetLabel(invite.preset)
	const target =
		invite.resourceType === 'package'
			? (invite.packageName ?? 'a package')
			: (grantResourceNouns[invite.resourceType ?? ''] ?? 'a resource')
	return preset ? `${preset} access to ${target}` : `Access to ${target}`
}

/**
 * Every invite waiting on this person, newest first within each source:
 * invites addressed to their email or username, then links they opened.
 */
export async function listPendingInvitesForViewer(
	env: Env,
	user: PendingInviteViewer,
): Promise<Array<AccountPendingInvite>> {
	const now = new Date().toISOString()
	const [invites, inviteLinks] = await Promise.all([
		listPendingInvitesForPerson(env.APP_DB, {
			email: user.email,
			username: user.username,
			now,
		}),
		listPendingInviteLinksForPerson(env.APP_DB, {
			userId: user.mcpUser.userId,
			now,
		}),
	])
	return [
		...invites.map((invite): AccountPendingInvite => ({
			source: 'invite',
			id: invite.id,
			orgSlug: invite.orgSlug,
			orgDisplayName: invite.orgDisplayName,
			orgPersonal: invite.orgPersonal,
			label: addressedInviteLabel(invite),
			expiresAt: invite.expiresAt,
		})),
		...inviteLinks.map((link): AccountPendingInvite => ({
			source: 'link',
			id: link.linkId,
			orgSlug: link.orgSlug,
			orgDisplayName: link.orgDisplayName,
			orgPersonal: link.orgPersonal,
			label: inviteLinkLabel(link),
			expiresAt: link.expiresAt,
		})),
	]
}

export async function loadAccountOrganizationSnapshot(
	env: Env,
	user: PendingInviteViewer,
	options?: { includeRestorable?: boolean },
): Promise<AccountOrganizationSnapshot> {
	const includeRestorable = options?.includeRestorable === true
	const [organizations, restorableOrganizations, pendingInvites] =
		await Promise.all([
			listOrganizationsForPerson(env.APP_DB, user.mcpUser.userId),
			includeRestorable
				? listRestorableOrganizationsForPerson({
						db: env.APP_DB,
						actorUserId: user.mcpUser.userId,
					})
				: Promise.resolve([]),
			listPendingInvitesForViewer(env, user),
		])
	return {
		organizations: organizations.map((org) => ({
			slug: org.slug,
			displayName: org.displayName,
			role: org.role,
			personal: org.personal,
			avatarUrl: org.personal
				? null
				: buildOrgAvatarUrl({ slug: org.slug, avatarKey: org.avatarKey }),
		})),
		restorableOrganizations: restorableOrganizations.map((org) => ({
			slug: org.slug,
			displayName: org.displayName,
			deletedAt: org.deletedAt,
			restoreUntil: softDeleteRestoreDeadlineIso(org.deletedAt),
			avatarUrl: buildOrgAvatarUrl({
				slug: org.slug,
				avatarKey: org.avatarKey,
			}),
		})),
		inviteCount: pendingInvites.length,
		pendingInvites,
	}
}

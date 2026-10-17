/**
 * The package Collaborators tab (`/@owner/<kody-id>/collaborators`): who holds
 * a grant on one package and which teams and org members a manager can still
 * add. Changes go through `packageCollaboratorSet` / `packageCollaboratorRemove`,
 * which only add teams and members of the owning org. A personal org has no
 * members, so there the tab invites people instead, through `inviteCreate`
 * (`kind: "grant"`) and `inviteRevoke`.
 */
import {
	grantPresets,
	type GrantPreset,
} from '@kody-internal/shared/grant-presets.ts'
import { routes } from '#universal/routes.ts'

export const packageCollaboratorPresets = grantPresets

export type PackageCollaboratorPreset = GrantPreset

export function isPackageCollaboratorPreset(
	value: unknown,
): value is PackageCollaboratorPreset {
	return (packageCollaboratorPresets as ReadonlyArray<unknown>).includes(value)
}

/**
 * `team`: a team in the owning org. `member`: a person with a live
 * membership in the owning org. `outside`: a person who holds this grant but
 * is not a member (granted elsewhere); the tab can remove them but not change
 * their access.
 */
export type PackageCollaboratorKind = 'team' | 'member' | 'outside'

export type PackageCollaboratorView = {
	grantId: string
	subjectType: 'user' | 'team'
	subjectId: string
	kind: PackageCollaboratorKind
	/** `@username` for a person, the team name for a team. */
	label: string
	username: string | null
	displayName: string | null
	avatarUrl: string | null
	teamSlug: string | null
	teamMemberCount: number | null
	/** Null for an advanced grant with an explicit permission list. */
	preset: PackageCollaboratorPreset | null
	permissions: Array<string>
	createdAt: string
}

/** A pending grant invite on the package (personal orgs only). */
export type PackageCollaboratorInviteView = {
	id: string
	inviteeEmail: string | null
	inviteeUsername: string | null
	/** Null for an advanced invite with an explicit permission list. */
	preset: PackageCollaboratorPreset | null
	expiresAt: string
	createdAt: string
}

export type PackageCollaboratorTeamOption = {
	id: string
	slug: string
	name: string
	memberCount: number
}

export type PackageCollaboratorMemberOption = {
	userId: string
	username: string | null
	displayName: string | null
}

export type PackageCollaboratorsView = {
	ok: true
	package: { id: string; kodyId: string; name: string }
	org: { slug: string; personal: boolean }
	collaborators: Array<PackageCollaboratorView>
	/** Pending grant invites on this package; always empty in a team org. */
	invites: Array<PackageCollaboratorInviteView>
	/** Teams and members not already holding a grant on this package. */
	options: {
		teams: Array<PackageCollaboratorTeamOption>
		members: Array<PackageCollaboratorMemberOption>
	}
}

/** Shown once, right after an invite is created. */
export type PackageCollaboratorInviteCreated = {
	id: string
	expiresAt: string
	inviteeLabel: string
	preset: PackageCollaboratorPreset
	prompt: string
}

/** Writes return their outcome independently of a subsequent confirming read. */
export type PackageCollaboratorsWriteResult = {
	ok: true
	invite?: PackageCollaboratorInviteCreated
}

/**
 * Native collaborator mutation input; writes return an acknowledgement and
 * creation returns its one-time invite handoff. `grant` adds a team or org
 * member, or changes the preset of one who already holds a grant. `invite`
 * and `revoke-invite` are personal-org only.
 */
export type PackageCollaboratorsChange =
	| {
			intent: 'grant'
			subjectType: 'user' | 'team'
			subjectId: string
			preset: PackageCollaboratorPreset
	  }
	| { intent: 'revoke'; grantId: string }
	| { intent: 'invite'; invitee: string; preset: PackageCollaboratorPreset }
	| { intent: 'revoke-invite'; inviteId: string }

/** An email address, or a username with or without its leading `@`. */
export function readPackageCollaboratorInvitee(
	value: string,
): { email: string } | { username: string } {
	const trimmed = value.trim()
	if (/^[^@\s]+@[^@\s]+$/.test(trimmed)) return { email: trimmed }
	return { username: trimmed.replace(/^@/, '') }
}

export function packageCollaboratorInviteeLabel(invite: {
	inviteeEmail: string | null
	inviteeUsername: string | null
}) {
	if (invite.inviteeEmail) return invite.inviteeEmail
	return invite.inviteeUsername ? `@${invite.inviteeUsername}` : 'Invite'
}

/**
 * What each preset means for someone invited to a personal package, in the
 * words the invite form shows.
 */
export function packageCollaboratorInvitePresetExplanation(
	preset: PackageCollaboratorPreset,
) {
	switch (preset) {
		case 'use':
			return 'Run it and read the source. They cannot change it.'
		case 'contribute':
			return 'Run it and update it from their own Kody.'
		case 'manage':
			return 'Run it and update it from their own Kody, plus publish, delete, and choose who else has access.'
		default: {
			const exhaustive: never = preset
			return exhaustive
		}
	}
}

export function packageCollaboratorPresetLabel(
	preset: PackageCollaboratorPreset,
) {
	switch (preset) {
		case 'use':
			return 'Use'
		case 'contribute':
			return 'Contribute'
		case 'manage':
			return 'Manage'
		default: {
			const exhaustive: never = preset
			return exhaustive
		}
	}
}

export function packageCollaboratorPresetDescription(
	preset: PackageCollaboratorPreset,
) {
	switch (preset) {
		case 'use':
			return 'Read the source and run it'
		case 'contribute':
			return 'Use, plus change the source'
		case 'manage':
			return 'Contribute, plus publish, delete, and manage access'
		default: {
			const exhaustive: never = preset
			return exhaustive
		}
	}
}

export function packageCollaboratorKindLabel(kind: PackageCollaboratorKind) {
	switch (kind) {
		case 'team':
			return 'Team'
		case 'member':
			return 'Org member'
		case 'outside':
			return 'Outside collaborator'
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

export function packageCollaboratorsHref(input: {
	username: string
	kodyId: string
}) {
	return routes.communityPackageCollaborators.href(input)
}

/** `/@user/kody-id/collaborators` and its params, or null for any other path. */
export function readPackageCollaboratorsPath(pathname: string): {
	username: string
	kodyId: string
} | null {
	const match = /^\/@([^/]+)\/([^/]+)\/collaborators\/?$/.exec(pathname)
	if (!match) return null
	const [, rawUsername, rawKodyId] = match
	if (rawKodyId === '-') return null
	try {
		return {
			username: decodeURIComponent(rawUsername!),
			kodyId: decodeURIComponent(rawKodyId!),
		}
	} catch {
		return null
	}
}

/** The package chrome for the tab, from the package detail API. */
type PackageCollaboratorsPageShell = {
	username: string
	kodyId: string
	name: string
	description: string
	isPrivate: boolean
	isListed: boolean
	listingId: string | null
	defaultBranch: string | null
	publishedCommit: string | null
	ownerProfilePublic: boolean
	viewerCanManage: boolean
}

export type PackageCollaboratorsLoaderData =
	| {
			ok: true
			shell: PackageCollaboratorsPageShell
			view: PackageCollaboratorsView
	  }
	| { ok: false; notFound: true }

/**
 * The package Collaborators tab (`/@owner/<kody-id>/collaborators`): who holds
 * a grant on one package and which teams and org members a manager can still
 * add, plus "Everyone in this organization" (a live org-membership subject). Changes go through `packageCollaboratorSet` / `packageCollaboratorRemove`,
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

/** Package permissions a collaborator grant may carry (the API's list). */
export const packageCollaboratorPermissions = [
	'package:read',
	'package:execute',
	'package:write',
	'package:publish',
	'package:delete',
	'package:manage_access',
] as const

export type PackageCollaboratorPermission =
	(typeof packageCollaboratorPermissions)[number]

/** Plain labels for the advanced checklist; the UI never shows the raw ids. */
export const packageCollaboratorPermissionOptions: ReadonlyArray<{
	permission: PackageCollaboratorPermission
	label: string
	description: string
}> = [
	{
		permission: 'package:read',
		label: 'Read the source',
		description: 'Open, clone, and fork the source.',
	},
	{
		permission: 'package:execute',
		label: 'Run the package',
		description: 'Runs count toward your usage.',
	},
	{
		permission: 'package:write',
		label: 'Change the source',
		description: 'Push changes from their own Kody.',
	},
	{
		permission: 'package:publish',
		label: 'Publish',
		description: 'Make their changes live.',
	},
	{
		permission: 'package:delete',
		label: 'Delete',
		description: 'Delete this package.',
	},
	{
		permission: 'package:manage_access',
		label: 'Manage access',
		description: 'Choose who else has access.',
	},
]

export type PackageCollaboratorPreset = GrantPreset

export function isPackageCollaboratorPreset(
	value: unknown,
): value is PackageCollaboratorPreset {
	return (packageCollaboratorPresets as ReadonlyArray<unknown>).includes(value)
}

/**
 * `org`: everyone in the owning org, resolved live against membership (current
 * and future members; someone who leaves loses it at once). `team`: a team in
 * the owning org. `member`: a person with a live
 * membership in the owning org. `outside`: a person who holds this grant but
 * is not a member (granted elsewhere); the tab can remove them but not change
 * their access.
 */
export type PackageCollaboratorKind =
	| 'org'
	| 'team'
	| 'member'
	| 'outside'
	| 'profile'

export type PackageCollaboratorView = {
	grantId: string
	subjectType: PackageCollaboratorSubjectType
	subjectId: string
	kind: PackageCollaboratorKind
	/**
	 * `@username` for a person, the team name for a team, and "Everyone in this
	 * organization" for the org subject.
	 */
	label: string
	username: string | null
	displayName: string | null
	avatarUrl: string | null
	teamSlug: string | null
	/** Live member count for a team, or for the org subject. */
	teamMemberCount: number | null
	/** Set only for a profile collaborator (ADR 0092). */
	profileName?: string
	/** False once the profile or a parent is revoked or expired. */
	profileActive?: boolean
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

/** Everyone in the owning org, offered until it already holds a grant. */
export type PackageCollaboratorEveryoneOption = {
	orgId: string
	memberCount: number
}

export type PackageCollaboratorSubjectType = 'user' | 'team' | 'org' | 'profile'

/** One of the viewer's own active profiles (ADR 0092; profiles experiment). */
type PackageCollaboratorProfileOption = {
	id: string
	name: string
	depth: number
}

export type PackageCollaboratorMemberOption = {
	userId: string
	username: string | null
	displayName: string | null
}

export type PackageCollaboratorsView = {
	ok: true
	package: {
		id: string
		kodyId: string
		name: string
		/** The package serves an app (drives the who-pays note). */
		hasApp?: boolean
		internetVisible?: boolean
	}
	org: { slug: string; personal: boolean }
	collaborators: Array<PackageCollaboratorView>
	/** Pending grant invites on this package; always empty in a team org. */
	invites: Array<PackageCollaboratorInviteView>
	/** Teams and members not already holding a grant on this package. */
	options: {
		/** Null once everyone in the org already holds a grant here. */
		everyone: PackageCollaboratorEveryoneOption | null
		teams: Array<PackageCollaboratorTeamOption>
		members: Array<PackageCollaboratorMemberOption>
		/** The viewer's profiles; absent unless the profiles experiment is on. */
		profiles?: Array<PackageCollaboratorProfileOption>
	}
}

/** Shown once, right after an invite is created. */
export type PackageCollaboratorInviteCreated = {
	id: string
	expiresAt: string
	inviteeLabel: string
	/** Null for an advanced invite with an explicit permission list. */
	preset: PackageCollaboratorPreset | null
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
			subjectType: PackageCollaboratorSubjectType
			subjectId: string
			/** Null with `permissions` for an advanced grant. */
			preset: PackageCollaboratorPreset | null
			permissions?: Array<PackageCollaboratorPermission>
	  }
	| { intent: 'revoke'; grantId: string }
	| {
			intent: 'invite'
			invitee: string
			preset: PackageCollaboratorPreset | null
			permissions?: Array<PackageCollaboratorPermission>
	  }
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
		case 'read':
			return packageCollaboratorReadDescription
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

const packageCollaboratorReadDescription =
	"Read and fork the source into their own Kody. They can't run your package or open your app."

export function packageCollaboratorPresetLabel(
	preset: PackageCollaboratorPreset,
) {
	switch (preset) {
		case 'read':
			return 'Read'
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
		case 'read':
			// Rendered with a trailing period, like the other descriptions.
			return packageCollaboratorReadDescription.replace(/\.$/, '')
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
		case 'org':
			return 'Everyone in this organization'
		case 'team':
			return 'Team'
		case 'member':
			return 'Org member'
		case 'outside':
			return 'Outside collaborator'
		case 'profile':
			return 'Agent profile'
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
	viewerCanSeeConnectedPeople: boolean
}

export type PackageCollaboratorsLoaderData =
	| {
			ok: true
			shell: PackageCollaboratorsPageShell
			view: PackageCollaboratorsView
	  }
	| { ok: false; notFound: true }

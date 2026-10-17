import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import {
	type OrgInviteLinkView,
	type OrgInviteView,
	type OrgMemberView,
	type OrgMembersLoaderData,
} from '#universal/loader-data.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
import {
	inviteLinkUrl,
	readInviteLinkOptions,
} from '#app/invite-link-options.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import {
	getInviteById,
	createInvite,
	markInviteRevoked,
	updateOrgMemberRole,
} from '#worker/orgs/access-writes.ts'
import { assertCanAcceptFreeOrgOwnership } from '#worker/orgs/billing.ts'
import {
	createOrgInviteLink,
	generateInviteLinkToken,
	hashInviteLinkToken,
	isInviteLinkRole,
	listActiveOrgInviteLinks,
	revokeOrgInviteLink,
	type ListedInviteLink,
} from '#worker/orgs/invite-links.ts'
import { onMemberSoftRemoved } from '#worker/orgs/member-offboarding.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	countLiveOwners,
	getLiveOrgMembership,
	listOrgMembers,
	listPendingOrgInvites,
	type ListedOrgInvite,
	type ListedOrgMember,
} from '#worker/orgs/org-members-list.ts'
import { syncSeatsAfterMembershipChange } from '#worker/orgs/seat-sync-after-membership.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'

const orgRoleValues = ['owner', 'member', 'billing'] as const

function isOrgRole(value: unknown): value is OrgRole {
	return (
		typeof value === 'string' &&
		(orgRoleValues as ReadonlyArray<string>).includes(value)
	)
}

function seatRole(role: string) {
	return role === 'owner' || role === 'member'
}

function generateInviteToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

function inviteAcceptPrompt(input: { orgSlug: string; token: string }) {
	return `You are invited to the ${input.orgSlug} organization. Call inviteAccept with this token: ${input.token}. The token is shown once and cannot be looked up later.`
}

function toMemberView(member: ListedOrgMember): OrgMemberView {
	return {
		userId: member.userId,
		username: member.username,
		displayName: member.displayName,
		avatarUrl: member.username
			? buildUserAvatarUrl({
					username: member.username,
					avatarKey: member.avatarKey,
				})
			: null,
		role: member.role,
		roleLabel: orgRoleLabel(member.role),
	}
}

function toInviteView(invite: ListedOrgInvite): OrgInviteView {
	return {
		id: invite.id,
		kind: invite.kind,
		role: invite.role,
		roleLabel: invite.role ? orgRoleLabel(invite.role) : null,
		inviteeEmail: invite.inviteeEmail,
		inviteeUsername: invite.inviteeUsername,
		expiresAt: invite.expiresAt,
	}
}

function toInviteLinkView(link: ListedInviteLink): Array<OrgInviteLinkView> {
	if (link.target.kind !== 'membership') return []
	return [
		{
			id: link.id,
			role: link.target.role,
			roleLabel: orgRoleLabel(link.target.role),
			allowedEmailDomains: link.allowedEmailDomains,
			maxUses: link.maxUses,
			useCount: link.useCount,
			expiresAt: link.expiresAt,
			createdAt: link.createdAt,
			createdByUsername: link.createdByUsername,
			createdByDisplayName: link.createdByDisplayName,
		},
	]
}

export async function loadOrgMembersData(input: {
	env: Env
	user: Parameters<typeof orgHasPermission>[1]
	org: ManagedOrg
}): Promise<OrgMembersLoaderData> {
	// Signup orgs keep membership management off the web — invite flows there
	// would let a second owner treat the account org like a team org.
	const canManage =
		!input.org.personal &&
		(await orgHasPermission(input.env, input.user, 'member:write'))
	const [members, invites, inviteLinks] = await Promise.all([
		listOrgMembers(input.env.APP_DB, input.org.id),
		canManage
			? listPendingOrgInvites(input.env.APP_DB, input.org.id)
			: Promise.resolve([]),
		canManage
			? listActiveOrgInviteLinks(input.env.APP_DB, input.org.id)
			: Promise.resolve([]),
	])
	return {
		ok: true,
		org: input.org,
		members: members.map(toMemberView),
		invites: invites.map(toInviteView),
		inviteLinks: inviteLinks.flatMap(toInviteLinkView),
		canManage,
	}
}

function personalOrgMembershipWriteResponse() {
	return operationResult(
		{
			ok: false,
			error:
				'Membership for your personal organization is managed with your account. Create a team organization to invite people.',
		},
		400,
	)
}

export async function setOrganizationMemberRole({
	request,
	env,
	user,
	orgSlug,
	...fields
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	userId?: unknown
	role?: unknown
	orgSlug?: string
}) {
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) return personalOrgMembershipWriteResponse()

	const userId = typeof fields.userId === 'string' ? fields.userId.trim() : ''
	const role = fields.role
	if (!userId || !isOrgRole(role)) {
		return operationResult(
			{ ok: false, error: 'A member and role are required.' },
			400,
		)
	}
	const membership = await getLiveOrgMembership(
		env.APP_DB,
		access.org.id,
		userId,
	)
	if (!membership) {
		return operationResult(
			{
				ok: false,
				error: 'That person is not a member of this organization.',
			},
			404,
		)
	}
	if (membership.role === 'owner' || role === 'owner') {
		const permissions = await computeEffectivePermissions({
			env,
			request: user.request,
		})
		if (!permissions.isOwner) {
			return operationResult(
				{ ok: false, error: 'Only an Owner can change the Owner role.' },
				403,
			)
		}
	}
	const demotingOwner = membership.role === 'owner' && role !== 'owner'
	if (demotingOwner) {
		const owners = await countLiveOwners(env.APP_DB, access.org.id)
		if (owners <= 1) {
			return operationResult(
				{ ok: false, error: 'The last Owner cannot be demoted.' },
				400,
			)
		}
	}
	try {
		if (role === 'owner' && membership.role !== 'owner') {
			await assertCanAcceptFreeOrgOwnership({
				db: env.APP_DB,
				orgId: access.org.id,
				userId,
			})
		}
		await updateOrgMemberRole({
			db: env.APP_DB,
			orgId: access.org.id,
			userId,
			audit: orgAuditWriterFromRequest(env, user.request),
			role,
			protectLastOwner: demotingOwner,
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to update that member.'
		return operationResult({ ok: false, error: message }, 400)
	}
	if (seatRole(membership.role) !== seatRole(role)) {
		await syncSeatsAfterMembershipChange({
			db: env.APP_DB,
			env,
			orgId: access.org.id,
		})
	}
	return operationResult({ ok: true as const })
}
export async function removeOrganizationMember({
	request,
	env,
	user,
	orgSlug,
	...fields
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	userId?: unknown
	orgSlug?: string
}) {
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:delete',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) return personalOrgMembershipWriteResponse()

	const userId = typeof fields.userId === 'string' ? fields.userId.trim() : ''
	if (!userId) {
		return operationResult({ ok: false, error: 'A member is required.' }, 400)
	}
	const membership = await getLiveOrgMembership(
		env.APP_DB,
		access.org.id,
		userId,
	)
	if (!membership) {
		return operationResult(
			{
				ok: false,
				error: 'That person is not a member of this organization.',
			},
			404,
		)
	}
	const removingOwner = membership.role === 'owner'
	if (removingOwner) {
		const permissions = await computeEffectivePermissions({
			env,
			request: user.request,
		})
		if (!permissions.isOwner) {
			return operationResult(
				{ ok: false, error: 'Only an Owner can remove an Owner.' },
				403,
			)
		}
		const owners = await countLiveOwners(env.APP_DB, access.org.id)
		if (owners <= 1) {
			return operationResult(
				{ ok: false, error: 'The last Owner cannot be removed.' },
				400,
			)
		}
	}
	try {
		await onMemberSoftRemoved({
			env,
			orgId: access.org.id,
			userId,
			deletedAt: new Date().toISOString(),
			audit: orgAuditWriterFromRequest(env, user.request),
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to remove that member.'
		return operationResult({ ok: false, error: message }, 400)
	}
	if (seatRole(membership.role)) {
		await syncSeatsAfterMembershipChange({
			db: env.APP_DB,
			env,
			orgId: access.org.id,
		})
	}
	return operationResult({ ok: true as const })
}
export async function inviteOrganizationMember({
	request,
	env,
	user,
	orgSlug,
	...fields
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	invitee?: unknown
	email?: unknown
	username?: unknown
	role?: unknown
	orgSlug?: string
}) {
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) return personalOrgMembershipWriteResponse()

	const invitee =
		typeof fields.invitee === 'string' ? fields.invitee.trim() : ''
	const emailInput = typeof fields.email === 'string' ? fields.email.trim() : ''
	const usernameInput =
		typeof fields.username === 'string' ? fields.username.trim() : ''
	if (fields.role !== undefined && !isOrgRole(fields.role)) {
		return operationResult({ ok: false, error: 'Choose a valid role.' }, 400)
	}
	const role = isOrgRole(fields.role) ? fields.role : 'member'
	let inviteeEmail: string | null = null
	let inviteeUsername: string | null = null
	if (emailInput || (invitee.includes('@') && !usernameInput)) {
		const email = normalizeEmailAddress(emailInput || invitee)
		if (!email) {
			return operationResult(
				{ ok: false, error: 'Enter a valid email address.' },
				400,
			)
		}
		inviteeEmail = email
	} else {
		const username = normalizeUsername(usernameInput || invitee)
		const formatError = getUsernameFormatValidationError(username)
		if (formatError) {
			return operationResult(
				{ ok: false, error: 'Enter an email or a valid username.' },
				400,
			)
		}
		inviteeUsername = username
	}
	if (role === 'owner') {
		const permissions = await computeEffectivePermissions({
			env,
			request: user.request,
		})
		if (!permissions.isOwner) {
			return operationResult(
				{ ok: false, error: 'Only an Owner can invite another Owner.' },
				403,
			)
		}
	}
	const token = generateInviteToken()
	const tokenHash = await sha256Hex(token)
	const created = await createInvite({
		db: env.APP_DB,
		orgId: access.org.id,
		kind: 'membership',
		role,
		inviteeEmail,
		inviteeUsername,
		invitedByUserId: user.mcpUser.userId,
		tokenHash,
		audit: orgAuditWriterFromRequest(env, user.request),
	})
	return operationResult({
		ok: true as const,
		invite: {
			id: created.id,
			expiresAt: created.expiresAt,
			token,
			prompt: inviteAcceptPrompt({
				orgSlug: access.org.slug,
				token,
			}),
		},
	})
}
export async function createOrganizationInviteLink({
	request,
	env,
	user,
	orgSlug,
	...fields
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	role?: unknown
	allowedEmailDomains?: unknown
	domains?: unknown
	allowedDomains?: unknown
	maxUses?: unknown
	expiresAt?: unknown
	expiresInDays?: unknown
	orgSlug?: string
}) {
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) return personalOrgMembershipWriteResponse()

	if (fields.role !== undefined && !isInviteLinkRole(fields.role)) {
		if (fields.role === 'owner') {
			return operationResult(
				{
					ok: false,
					error: 'Invite links cannot grant the Owner role.',
				},
				400,
			)
		}
		return operationResult({ ok: false, error: 'Choose a valid role.' }, 400)
	}
	const role = isInviteLinkRole(fields.role) ? fields.role : 'member'
	const parsedOptions = readInviteLinkOptions(fields)
	if (!parsedOptions.ok)
		return operationResult({ ok: false, error: parsedOptions.error }, 400)
	const { allowedEmailDomains, maxUses, expiresAt } = parsedOptions.options
	const token = generateInviteLinkToken()
	const tokenHash = await hashInviteLinkToken(token)
	try {
		const created = await createOrgInviteLink({
			db: env.APP_DB,
			orgId: access.org.id,
			target: { kind: 'membership', role },
			createdByUserId: user.mcpUser.userId,
			tokenHash,
			allowedEmailDomains,
			maxUses,
			expiresAt,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
		return operationResult({
			ok: true as const,
			inviteLink: {
				id: created.id,
				expiresAt: created.expiresAt,
				maxUses: created.maxUses,
				allowedEmailDomains: created.allowedEmailDomains,
				role,
				url: inviteLinkUrl(request, token),
				token,
			},
		})
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unable to create that invite link.'
		return operationResult({ ok: false, error: message }, 400)
	}
}
export async function revokeOrganizationInviteLink({
	request,
	env,
	user,
	orgSlug,
	...fields
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	linkId?: unknown
	id?: unknown
	orgSlug?: string
}) {
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) return personalOrgMembershipWriteResponse()

	const linkId =
		typeof fields.linkId === 'string'
			? fields.linkId.trim()
			: typeof fields.id === 'string'
				? fields.id.trim()
				: ''
	if (!linkId) {
		return operationResult(
			{ ok: false, error: 'An invite link is required.' },
			400,
		)
	}
	try {
		await revokeOrgInviteLink({
			db: env.APP_DB,
			orgId: access.org.id,
			linkId,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Unable to revoke that invite link.'
		return operationResult({ ok: false, error: message }, 400)
	}
	return operationResult({ ok: true as const })
}

export async function revokeOrganizationMemberInvite({
	request,
	env,
	user,
	orgSlug,
	inviteId: inviteIdInput,
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	orgSlug: string
	inviteId: string
}) {
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}
	if (access.org.personal) return personalOrgMembershipWriteResponse()
	const inviteId = typeof inviteIdInput === 'string' ? inviteIdInput.trim() : ''
	const invite = inviteId
		? await getInviteById({
				db: env.APP_DB,
				orgId: access.org.id,
				inviteId,
			})
		: null
	if (!invite || invite.kind !== 'membership') {
		return operationResult(
			{ ok: false, error: 'That invite was not found.' },
			404,
		)
	}
	if (invite.role === 'owner' && access.org.role !== 'owner') {
		return operationResult(
			{ ok: false, error: 'Only an Owner can revoke an Owner invite.' },
			403,
		)
	}
	try {
		await markInviteRevoked({
			db: env.APP_DB,
			orgId: access.org.id,
			inviteId: invite.id,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to revoke that invite.'
		return operationResult({ ok: false, error: message }, 400)
	}
	return operationResult({ ok: true as const })
}

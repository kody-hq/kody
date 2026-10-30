import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { resolveGrantPermissions } from '@kody-internal/shared/grant-presets.ts'
import {
	type OrgPermission,
	type OrgResourceType,
} from '@kody-internal/shared/org-permissions.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { assertMemoryGrantsAllowedOnOrg } from '#mcp/memory/memory-owner.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import {
	type GrantSubjectChoices,
	grantSubjectMatchSql,
} from '#worker/authorization/grant-subjects.ts'
import {
	authorize,
	computeEffectivePermissions,
} from '#worker/authorization/authorize.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	addOrgMember,
	addTeamMember,
	createInvite,
	getInviteById,
	getInviteByTokenHash,
	markInviteAccepted,
	markInviteDeclined,
	markInviteExpired,
	markInviteRevoked,
	upsertGrant,
	type GrantResourceType,
	type StoredInvite,
} from '#worker/orgs/access-writes.ts'
import {
	credentialPermissionFamily,
	getOrgCredential,
} from '#worker/credentials/credential-ids.ts'
import { assertCanAcceptFreeOrgOwnership } from '#worker/orgs/billing.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { isOrgActive } from '#worker/orgs/repo.ts'
import {
	orgAuditWriterFromRequest,
	recordOrgAuditEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
import { syncSeatsAfterMembershipChange } from '#worker/orgs/seat-sync-after-membership.ts'
import {
	authorizeGrantRevoke,
	authorizeGrantTarget,
	generateInviteToken,
	grantPresetSchema,
	grantTargetTypeSchema,
	hashInviteToken,
	inviteAcceptPrompt,
	inviteSchema,
	optionalInviteeEmail,
	optionalInviteeUsername,
	orgRoleSchema,
	readPermissionList,
	requireLiveOrg,
	requireOrgPermission,
	requirePresetOrPermissions,
	resolveAuthorizedGrantPermissions,
	resolveGrantTarget,
	rethrowAccessError,
} from './shared.ts'

function inviteMatchesUser(
	invite: StoredInvite,
	user: { email: string; username?: string },
) {
	if (!invite.inviteeEmail && !invite.inviteeUsername) return false
	if (invite.inviteeEmail) {
		const email = normalizeEmailAddress(user.email)
		if (!email || email !== invite.inviteeEmail) return false
	}
	if (invite.inviteeUsername) {
		const username = normalizeUsername(user.username ?? '')
		if (username !== invite.inviteeUsername) return false
	}
	return true
}

async function assertTeamsInOrg(
	db: D1Database,
	orgId: string,
	teamIds: ReadonlyArray<string>,
) {
	for (const teamId of teamIds) {
		const row = await db
			.prepare(
				`SELECT id FROM teams
				 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
			)
			.bind(teamId, orgId)
			.first<{ id: string }>()
		if (!row) {
			throw new McpCallerError(
				`Team ${teamId} was not found in this organization.`,
			)
		}
	}
}

function toInvitePayload(invite: StoredInvite, orgSlug: string) {
	return {
		id: invite.id,
		org_id: invite.orgId,
		org_slug: orgSlug,
		kind: invite.kind,
		role: invite.role,
		team_ids: invite.teamIds,
		resource_type: invite.resourceType,
		resource_id: invite.resourceId,
		preset: invite.preset,
		permissions: invite.permissions,
		invitee_email: invite.inviteeEmail,
		invitee_username: invite.inviteeUsername,
		status: invite.status,
		expires_at: invite.expiresAt,
	}
}

/**
 * An inviter who is no longer a member keeps grant invites valid only with a
 * direct grant here. Team seats and everyone-in-org grants both need a live
 * membership, and a live member already passed the check above.
 */
export const outsideInviterGrantSubjects = {
	user: 'include',
	team: {
		exclude:
			'Team seats need a live org membership (addTeamMember, offboarding tombstones them), and members pass before this check.',
	},
	org: {
		exclude:
			'An org subject grant only reaches live members, and members pass before this check.',
	},
	profile: {
		exclude:
			'Profile grants narrow a profile; they never grant the person behind it.',
	},
} as const satisfies GrantSubjectChoices

async function assertInviterStillValid(db: D1Database, invite: StoredInvite) {
	const requireOwner = invite.kind === 'membership' && invite.role === 'owner'
	const inviter = await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(invite.orgId, invite.invitedByUserId)
		.first<{ role: string }>()
	if (requireOwner) {
		if (!inviter || inviter.role !== 'owner') {
			throw new McpCallerError(
				'This owner invite is no longer valid because the inviter is not an Owner.',
			)
		}
		return
	}
	if (invite.kind === 'membership') {
		if (!inviter) {
			throw new McpCallerError(
				'This invite is no longer valid because the inviter no longer has access.',
			)
		}
		return
	}
	// Grant invites may come from outside collaborators who still hold a grant.
	if (inviter) return
	const subjectMatch = grantSubjectMatchSql({
		subjects: outsideInviterGrantSubjects,
		personId: invite.invitedByUserId,
	})
	const grant = await db
		.prepare(
			`SELECT g.id AS id FROM grants g
			 WHERE g.org_id = ?
			   AND ${subjectMatch.sql}
			   AND g.deleted_at IS NULL
			 LIMIT 1`,
		)
		.bind(invite.orgId, ...subjectMatch.binds)
		.first<{ id: string }>()
	if (!grant) {
		throw new McpCallerError(
			'This invite is no longer valid because the inviter no longer has access.',
		)
	}
}

/**
 * The permission family a grant invite resolves against. A credential must
 * still exist and be live: an invite never creates a grant on a deleted id.
 */
async function grantInviteFamily(
	db: D1Database,
	orgId: string,
	resourceType: GrantResourceType,
	resourceId: string,
): Promise<OrgResourceType | 'org'> {
	switch (resourceType) {
		case 'credential': {
			const credential = await getOrgCredential(db, orgId, resourceId)
			if (!credential?.live) {
				throw new McpCallerError(
					'This invite is no longer valid because its credential was deleted.',
				)
			}
			return credentialPermissionFamily(credential.kind)
		}
		case 'org':
		case 'package':
		case 'app':
		case 'job':
		case 'memory':
		case 'email':
		case 'execution_context':
			return resourceType
		default: {
			const exhaustive: never = resourceType
			throw new Error(`Unhandled grant resource type: ${String(exhaustive)}`)
		}
	}
}

type GrantInviteTarget = {
	resourceType: GrantResourceType
	resourceId: string
	family: OrgResourceType | 'org'
}

async function assertInviteTargetsStillValid(
	db: D1Database,
	invite: StoredInvite,
): Promise<GrantInviteTarget | null> {
	const kind = invite.kind
	switch (kind) {
		case 'membership':
			await assertTeamsInOrg(db, invite.orgId, invite.teamIds)
			return null
		case 'grant': {
			const { resourceType, resourceId } = invite
			if (!resourceType || !resourceId) {
				throw new McpCallerError('This grant invite is missing a resource.')
			}
			const family = await grantInviteFamily(
				db,
				invite.orgId,
				resourceType,
				resourceId,
			)
			try {
				resolveGrantPermissions({
					family,
					preset: invite.preset,
					permissions: invite.permissions,
				})
			} catch (error) {
				throw new McpCallerError(
					error instanceof Error ? error.message : 'Invalid grant invite.',
				)
			}
			return { resourceType, resourceId, family }
		}
		default: {
			const exhaustive: never = kind
			throw new Error(`Unknown invite kind: ${String(exhaustive)}`)
		}
	}
}

async function acceptStoredInvite(input: {
	db: D1Database
	env: Env
	invite: StoredInvite
	acceptedByUserId: string
	audit: OrgAuditWriter
}) {
	const { invite } = input
	if (!(await isOrgActive(input.db, invite.orgId))) {
		throw new McpCallerError(
			'This invite is no longer valid because the organization is not active.',
		)
	}
	await assertInviterStillValid(input.db, invite)
	const grantTarget = await assertInviteTargetsStillValid(input.db, invite)
	if (invite.kind === 'membership' && (invite.role ?? 'member') === 'owner') {
		await assertCanAcceptFreeOrgOwnership({
			db: input.db,
			orgId: invite.orgId,
			userId: input.acceptedByUserId,
		})
	}
	// Block redeem of pending team-memory grants created before personal-only.
	if (invite.kind === 'grant' && grantTarget?.resourceType === 'memory') {
		await assertMemoryGrantsAllowedOnOrg(
			input.db,
			ownerIdFromStored(invite.orgId),
		)
	}
	// Claim the invite before side effects so a concurrent redeem loses the
	// pending→accepted compare-and-set instead of applying access twice.
	try {
		await markInviteAccepted({
			db: input.db,
			inviteId: invite.id,
			acceptedByUserId: input.acceptedByUserId,
		})
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === 'Invite could not be accepted.'
		) {
			throw new McpCallerError('This invite was already accepted.')
		}
		throw error
	}
	const kind = invite.kind
	switch (kind) {
		case 'membership': {
			const role: OrgRole = invite.role ?? 'member'
			await addOrgMember({
				db: input.db,
				orgId: invite.orgId,
				userId: input.acceptedByUserId,
				role,
				invitedByUserId: invite.invitedByUserId,
				audit: input.audit,
			})
			for (const teamId of invite.teamIds) {
				await addTeamMember({
					db: input.db,
					orgId: invite.orgId,
					teamId,
					userId: input.acceptedByUserId,
					addedByUserId: invite.invitedByUserId,
					audit: input.audit,
				})
			}
			if (role === 'owner' || role === 'member') {
				await syncSeatsAfterMembershipChange({
					db: input.db,
					env: input.env,
					orgId: invite.orgId,
				})
			}
			break
		}
		case 'grant': {
			if (!grantTarget) {
				throw new McpCallerError('This grant invite is missing a resource.')
			}
			await upsertGrant({
				db: input.db,
				orgId: invite.orgId,
				resourceType: grantTarget.resourceType,
				resourceId: grantTarget.resourceId,
				family: grantTarget.family,
				subject: { type: 'user', id: input.acceptedByUserId },
				preset: invite.preset,
				permissions: invite.permissions,
				createdByUserId: invite.invitedByUserId,
				audit: input.audit,
			})
			break
		}
		default: {
			const exhaustive: never = kind
			throw new Error(`Unknown invite kind: ${String(exhaustive)}`)
		}
	}
	await recordOrgAuditEvent(input.audit, {
		orgId: invite.orgId,
		action: 'invite.accepted',
		resourceType: 'invite',
		resourceId: invite.id,
		targetUserId: input.acceptedByUserId,
		details: { kind: invite.kind },
	})
}

/**
 * Rejects a pending invite that can no longer be used, marking a lapsed one
 * expired. Shared by accept and decline.
 */
async function assertInvitePending(db: D1Database, invite: StoredInvite) {
	if (invite.status === 'revoked') {
		throw new McpCallerError('This invite was revoked.')
	}
	if (invite.status === 'accepted') {
		throw new McpCallerError('This invite was already accepted.')
	}
	const expiresAtMs = Date.parse(invite.expiresAt)
	if (Number.isNaN(expiresAtMs)) {
		throw new Error(`Invite ${invite.id} has expires_at ${invite.expiresAt}.`)
	}
	if (invite.status === 'expired' || expiresAtMs <= Date.now()) {
		if (invite.status === 'pending') {
			await markInviteExpired({ db, inviteId: invite.id })
		}
		throw new McpCallerError('This invite has expired.')
	}
}

type InviteRecipient = { userId: string; email: string; username?: string }

function assertInviteForRecipient(invite: StoredInvite, user: InviteRecipient) {
	if (!inviteMatchesUser(invite, user)) {
		throw new McpCallerError(
			'This invite is addressed to a different email or username.',
		)
	}
}

/**
 * Accept an invite already proven to be this person's (by its token, or by
 * the web session for an invite addressed to them). Returns the live org.
 */
export async function acceptAddressedInvite(input: {
	db: D1Database
	env: Env
	invite: StoredInvite
	user: InviteRecipient
	audit: OrgAuditWriter
}) {
	await assertInvitePending(input.db, input.invite)
	assertInviteForRecipient(input.invite, input.user)
	const org = await requireLiveOrg(input.db, input.invite.orgId)
	await acceptStoredInvite({
		db: input.db,
		env: input.env,
		invite: input.invite,
		acceptedByUserId: input.user.userId,
		audit: input.audit,
	})
	return org
}

/** The recipient turns down a pending invite addressed to them. */
export async function declineAddressedInvite(input: {
	db: D1Database
	invite: StoredInvite
	user: InviteRecipient
	audit: OrgAuditWriter
}) {
	await assertInvitePending(input.db, input.invite)
	assertInviteForRecipient(input.invite, input.user)
	await markInviteDeclined({
		db: input.db,
		orgId: input.invite.orgId,
		inviteId: input.invite.id,
		declinedByUserId: input.user.userId,
		audit: input.audit,
	})
}

export const inviteCreateCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteCreate',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: true,
		description:
			'Invite someone to the organization this request is bound to, by email or username. kind membership needs member:write and adds them with a role (and optional teams). kind grant needs manage access on the resource and gives them a preset or permission list. The token is returned once, with a prompt that tells them to call inviteAccept. Invites expire in 7 days.',
		keywords: ['invite', 'member', 'grant', 'email', 'username'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			kind: z.enum(['membership', 'grant']),
			email: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
			role: orgRoleSchema.optional(),
			team_ids: z.array(z.string().min(1)).optional(),
			resource_type: grantTargetTypeSchema.optional(),
			resource_id: z.string().min(1).optional(),
			preset: grantPresetSchema.optional(),
			permissions: z.array(z.string().min(1)).optional(),
		}),
		outputSchema: z.object({
			invite: inviteSchema,
			token: z.string(),
			prompt: z.string(),
		}),
		async handler(args, ctx) {
			try {
				const user = requireMcpUser(ctx.callerContext)
				const request = requireMcpRequest(ctx.callerContext)
				const db = ctx.env.APP_DB
				const email = optionalInviteeEmail(args.email)
				const username = optionalInviteeUsername(args.username)
				const org = await requireLiveOrg(db, request.org.id)
				const kind = args.kind
				let role: OrgRole | null = null
				let teamIds: Array<string> | null = null
				let resourceType: GrantResourceType | null = null
				let resourceId: string | null = null
				let preset: 'use' | 'contribute' | 'manage' | null = null
				let permissions: Array<OrgPermission> | null = null
				switch (kind) {
					case 'membership': {
						await authorize({ env: ctx.env, request }, 'member:write')
						if (await isPersonalOrg(db, request.org.id)) {
							throw new McpCallerError(
								'Membership for your personal organization is managed with your account. Create a team organization to invite people.',
							)
						}
						if (args.resource_type || args.resource_id || args.preset) {
							throw new McpCallerError(
								'Membership invites do not take a resource or preset. Use kind grant for that.',
							)
						}
						if (args.permissions && args.permissions.length > 0) {
							throw new McpCallerError(
								'Membership invites do not take a permission list.',
							)
						}
						role = args.role ?? 'member'
						if (role === 'owner') {
							const access = await computeEffectivePermissions({
								env: ctx.env,
								request,
							})
							if (!access.isOwner) {
								throw new McpCallerError(
									'Only an Owner can invite another Owner.',
								)
							}
						}
						const ids = args.team_ids ?? []
						await assertTeamsInOrg(db, request.org.id, ids)
						teamIds = ids.length > 0 ? ids : null
						break
					}
					case 'grant': {
						if (args.role || (args.team_ids && args.team_ids.length > 0)) {
							throw new McpCallerError(
								'Grant invites do not take a role or teams. Use kind membership for that.',
							)
						}
						if (!args.resource_type || !args.resource_id) {
							throw new McpCallerError(
								'Grant invites need resource_type and resource_id.',
							)
						}
						permissions = readPermissionList(args.permissions)
						requirePresetOrPermissions({
							preset: args.preset,
							permissions,
						})
						const target = await resolveGrantTarget(ctx, {
							type: args.resource_type,
							id: args.resource_id,
						})
						const scoped = await authorizeGrantTarget(
							ctx,
							target.resourceType,
							target.resourceId,
						)
						const resolved = await resolveAuthorizedGrantPermissions(ctx, {
							family: scoped.family,
							preset: args.preset,
							permissions,
						})
						resourceType = target.resourceType
						resourceId = target.resourceId
						preset = args.preset ?? null
						if (preset) {
							permissions = null
						} else {
							permissions = [...resolved]
						}
						break
					}
					default: {
						const exhaustive: never = kind
						throw new Error(`Unknown invite kind: ${String(exhaustive)}`)
					}
				}
				const token = generateInviteToken()
				const tokenHash = await hashInviteToken(token)
				const created = await createInvite({
					db,
					orgId: request.org.id,
					kind,
					role,
					teamIds,
					resourceType,
					resourceId,
					preset,
					permissions,
					inviteeEmail: email,
					inviteeUsername: username,
					invitedByUserId: user.userId,
					tokenHash,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				const invite = await getInviteById({
					db,
					orgId: request.org.id,
					inviteId: created.id,
				})
				if (!invite) throw new Error('Invite was not saved.')
				return {
					invite: toInvitePayload(invite, org.slug),
					token,
					prompt: inviteAcceptPrompt({ orgSlug: org.slug, token }),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const inviteAcceptCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteAccept',
		contextRuns: 'deny',
		orgPermission: 'org:read',
		requiresLivePerson: true,
		description:
			'Accept an invitation addressed to your account email or username. Pass the token from inviteCreate. Membership invites add you to that organization. Grant invites write the grant. The prompt from inviteCreate includes the organization slug and this call.',
		keywords: ['invite', 'accept', 'join', 'token'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			token: z.string().min(1),
		}),
		outputSchema: z.object({
			invite_id: z.string(),
			org_id: z.string(),
			org_slug: z.string(),
			kind: z.enum(['membership', 'grant']),
			status: z.literal('accepted'),
		}),
		async handler(args, ctx) {
			try {
				const { user, request, db } = await requireOrgPermission(
					ctx,
					'org:read',
				)
				const tokenHash = await hashInviteToken(args.token)
				const invite = await getInviteByTokenHash(db, tokenHash)
				if (
					!invite ||
					!(await timingSafeEqualString(invite.tokenHash, tokenHash))
				) {
					throw new McpCallerError('Invite token is not valid.')
				}
				const org = await acceptAddressedInvite({
					db,
					env: ctx.env,
					invite,
					user,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				return {
					invite_id: invite.id,
					org_id: invite.orgId,
					org_slug: org.slug,
					kind: invite.kind,
					status: 'accepted' as const,
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const inviteRevokeCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteRevoke',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: true,
		description:
			'Revoke a pending invite in the organization this request is bound to. Membership invites need member:write. Grant invites need manage access on that resource (or member:write for an org grant). Accepted invites stay in place; remove the member or grant separately.',
		keywords: ['invite', 'revoke', 'cancel'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			invite_id: z.string().min(1),
		}),
		outputSchema: z.object({
			invite_id: z.string(),
			status: z.literal('revoked'),
		}),
		async handler(args, ctx) {
			try {
				const request = requireMcpRequest(ctx.callerContext)
				const db = ctx.env.APP_DB
				const invite = await getInviteById({
					db,
					orgId: request.org.id,
					inviteId: args.invite_id,
				})
				if (!invite) {
					throw new McpCallerError('Invite was not found in this organization.')
				}
				const kind = invite.kind
				switch (kind) {
					case 'membership':
						await authorize({ env: ctx.env, request }, 'member:write')
						break
					case 'grant': {
						if (!invite.resourceType || !invite.resourceId) {
							throw new McpCallerError(
								'This grant invite is missing a resource.',
							)
						}
						await authorizeGrantRevoke(
							ctx,
							invite.resourceType,
							invite.resourceId,
						)
						break
					}
					default: {
						const exhaustive: never = kind
						throw new Error(`Unknown invite kind: ${String(exhaustive)}`)
					}
				}
				await markInviteRevoked({
					db,
					orgId: request.org.id,
					inviteId: invite.id,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				return { invite_id: invite.id, status: 'revoked' as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

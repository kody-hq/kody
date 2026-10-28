import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { computeEffectivePermissions } from '#worker/authorization/authorize.ts'
import { createOrg, updateOrgMemberRole } from '#worker/orgs/access-writes.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	onMemberSoftRemoved,
	readTombstonedOrgMembership,
} from '#worker/orgs/member-offboarding.ts'
import { assertCanAcceptFreeOrgOwnership } from '#worker/orgs/billing.ts'
import { listOrgMembers } from '#worker/orgs/org-members-list.ts'
import { syncSeatsAfterMembershipChange } from '#worker/orgs/seat-sync-after-membership.ts'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import {
	orgRoleSchema,
	requireLiveOrg,
	requireOrgPermission,
	resolvePersonId,
	rethrowAccessError,
} from './shared.ts'

function seatRole(role: string) {
	return role === 'owner' || role === 'member'
}

async function liveMembership(db: D1Database, orgId: string, userId: string) {
	return await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ role: string }>()
}

async function liveOwnerCount(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM org_memberships
			 WHERE org_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export const orgCreateCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'orgCreate',
		contextRuns: 'deny',
		orgPermission: 'org:write',
		description:
			'Create an organization you own. The slug becomes the permanent handle (kody.codes/@<slug>) and cannot be changed later; only the display name can. The id is new and separate from your personal organization. Calls that change the new organization need a request bound to it.',
		keywords: ['org', 'organization', 'create', 'team'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			slug: z
				.string()
				.min(1)
				.describe(
					'Public handle for the organization, lowercased. Permanent: it cannot be changed after creation, so pick it deliberately. The org lives at kody.codes/@<slug>.',
				),
			display_name: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			org: z.object({
				id: z.string(),
				slug: z.string(),
				display_name: z.string(),
			}),
		}),
		async handler(args, ctx) {
			try {
				const { user, request, db } = await requireOrgPermission(
					ctx,
					'org:write',
				)
				const created = await createOrg({
					db,
					env: ctx.env,
					slug: args.slug,
					displayName: args.display_name,
					createdByUserId: user.userId,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				const org = await requireLiveOrg(db, created.id)
				return {
					org: {
						id: org.id,
						slug: org.slug,
						display_name: org.display_name ?? org.slug,
					},
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const orgMemberListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'orgMemberList',
		contextRuns: 'allow',
		orgPermission: 'member:read',
		description:
			'List live members of the organization this request is bound to, with username, display name, and role.',
		keywords: ['member', 'members', 'list', 'role'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			members: z.array(
				z.object({
					user_id: z.string(),
					username: z.string().nullable(),
					display_name: z.string().nullable(),
					avatar_url: z.string().nullable(),
					role: orgRoleSchema,
				}),
			),
		}),
		async handler(_args, ctx) {
			try {
				const { db, request } = await requireOrgPermission(ctx, 'member:read')
				const members = await listOrgMembers(db, request.org.id)
				return {
					members: members.map((member) => ({
						user_id: member.userId,
						username: member.username,
						display_name: member.displayName,
						avatar_url: member.username
							? buildUserAvatarUrl({
									username: member.username,
									avatarKey: member.avatarKey,
								})
							: null,
						role: member.role,
					})),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const orgMemberUpdateCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'orgMemberUpdate',
		contextRuns: 'deny',
		orgPermission: 'member:write',
		requiresLivePerson: true,
		description:
			'Change the role of a live member of the organization this request is bound to. Only an Owner can grant or change the Owner role. The last Owner cannot be demoted.',
		keywords: ['member', 'role', 'owner', 'billing'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			user_id: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
			role: orgRoleSchema,
		}),
		outputSchema: z.object({
			user_id: z.string(),
			role: orgRoleSchema,
		}),
		async handler(args, ctx) {
			try {
				const { request, db } = await requireOrgPermission(ctx, 'member:write')
				const userId = await resolvePersonId(db, {
					userId: args.user_id,
					username: args.username,
				})
				const membership = await liveMembership(db, request.org.id, userId)
				if (!membership) {
					throw new McpCallerError(
						'That person is not a member of this organization.',
					)
				}
				if (membership.role === 'owner' || args.role === 'owner') {
					const access = await computeEffectivePermissions({
						env: ctx.env,
						request,
					})
					if (!access.isOwner) {
						throw new McpCallerError('Only an Owner can change the Owner role.')
					}
				}
				const demotingOwner =
					membership.role === 'owner' && args.role !== 'owner'
				if (demotingOwner) {
					const owners = await liveOwnerCount(db, request.org.id)
					if (owners <= 1) {
						throw new McpCallerError('The last Owner cannot be demoted.')
					}
				}
				if (args.role === 'owner' && membership.role !== 'owner') {
					await assertCanAcceptFreeOrgOwnership({
						db,
						orgId: request.org.id,
						userId,
					})
				}
				await updateOrgMemberRole({
					db,
					orgId: request.org.id,
					userId,
					role: args.role,
					protectLastOwner: demotingOwner,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				if (seatRole(membership.role) !== seatRole(args.role)) {
					await syncSeatsAfterMembershipChange({
						db,
						env: ctx.env,
						orgId: request.org.id,
					})
				}
				return { user_id: userId, role: args.role }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const orgMemberRemoveCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'orgMemberRemove',
		contextRuns: 'deny',
		orgPermission: 'member:delete',
		requiresLivePerson: true,
		description:
			'Remove a member from the organization this request is bound to. Revokes org-bound credentials, disconnects integrations they connected, and keeps their jobs running, the same as when they leave. A retry finishes that cleanup when the membership is already tombstoned. Their team memberships in this organization end too. The last Owner cannot be removed.',
		keywords: ['member', 'remove', 'kick'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			user_id: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			user_id: z.string(),
			removed: z.literal(true),
		}),
		async handler(args, ctx) {
			try {
				const { db, request } = await requireOrgPermission(ctx, 'member:delete')
				const userId = await resolvePersonId(db, {
					userId: args.user_id,
					username: args.username,
				})
				const membership = await liveMembership(db, request.org.id, userId)
				if (!membership) {
					const tombstone = await readTombstonedOrgMembership({
						db,
						orgId: request.org.id,
						userId,
					})
					if (!tombstone) {
						throw new McpCallerError(
							'That person is not a member of this organization.',
						)
					}
					if (tombstone.role === 'owner') {
						const access = await computeEffectivePermissions({
							env: ctx.env,
							request,
						})
						if (!access.isOwner) {
							throw new McpCallerError('Only an Owner can remove an Owner.')
						}
					}
					await onMemberSoftRemoved({
						env: ctx.env,
						orgId: request.org.id,
						userId,
						deletedAt: tombstone.deletedAt,
						resume: true,
						audit: orgAuditWriterFromRequest(ctx.env, request),
					})
					if (seatRole(tombstone.role)) {
						await syncSeatsAfterMembershipChange({
							db,
							env: ctx.env,
							orgId: request.org.id,
						})
					}
					return { user_id: userId, removed: true as const }
				}
				const removingOwner = membership.role === 'owner'
				if (removingOwner) {
					const access = await computeEffectivePermissions({
						env: ctx.env,
						request,
					})
					if (!access.isOwner) {
						throw new McpCallerError('Only an Owner can remove an Owner.')
					}
					const owners = await liveOwnerCount(db, request.org.id)
					if (owners <= 1) {
						throw new McpCallerError('The last Owner cannot be removed.')
					}
				}
				await onMemberSoftRemoved({
					env: ctx.env,
					orgId: request.org.id,
					userId,
					deletedAt: new Date().toISOString(),
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				if (seatRole(membership.role)) {
					await syncSeatsAfterMembershipChange({
						db,
						env: ctx.env,
						orgId: request.org.id,
					})
				}
				return { user_id: userId, removed: true as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

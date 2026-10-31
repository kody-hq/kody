import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	inviteLinkUrl,
	readInviteLinkOptions,
} from '#worker/app/invite-link-options.ts'
import { authorize } from '#worker/authorization/authorize.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { redeemOrgInviteLink } from '#worker/orgs/invite-link-redeem.ts'
import {
	createOrgInviteLink,
	generateInviteLinkToken,
	getInviteLinkById,
	getInviteLinkByTokenHash,
	hashInviteLinkToken,
	isInviteLinkRole,
	listActiveOrgInviteLinks,
	revokeOrgInviteLink,
	type InviteLinkTarget,
} from '#worker/orgs/invite-links.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import {
	authorizeGrantTarget,
	grantPresetSchema,
	inviteLinkAcceptPrompt,
	requireLiveOrg,
	requireOrgPermission,
	rethrowAccessError,
} from './shared.ts'

const inviteLinkKindSchema = z.enum(['membership', 'team', 'resource'])

const inviteLinkRoleSchema = z.enum(['member', 'billing'])

const inviteLinkSchema = z.object({
	id: z.string(),
	kind: inviteLinkKindSchema,
	role: inviteLinkRoleSchema.nullable(),
	team_ids: z.array(z.string()),
	team_id: z.string().nullable(),
	resource_type: z.literal('package').nullable(),
	resource_id: z.string().nullable(),
	preset: grantPresetSchema.nullable(),
	label: z.string().nullable(),
	max_uses: z.number().nullable(),
	use_count: z.number(),
	last_used_at: z.string().nullable(),
	expires_at: z.string(),
})

function toInviteLinkPayload(input: {
	id: string
	target: InviteLinkTarget
	teamIds: Array<string>
	label: string | null
	maxUses: number | null
	useCount: number
	lastUsedAt: string | null
	expiresAt: string
}) {
	const target = input.target
	switch (target.kind) {
		case 'membership':
			return {
				id: input.id,
				kind: 'membership' as const,
				role: target.role,
				team_ids: input.teamIds,
				team_id: null,
				resource_type: null,
				resource_id: null,
				preset: null,
				label: input.label,
				max_uses: input.maxUses,
				use_count: input.useCount,
				last_used_at: input.lastUsedAt,
				expires_at: input.expiresAt,
			}
		case 'team':
			return {
				id: input.id,
				kind: 'team' as const,
				role: 'member' as const,
				team_ids: [],
				team_id: target.teamId,
				resource_type: null,
				resource_id: null,
				preset: null,
				label: input.label,
				max_uses: input.maxUses,
				use_count: input.useCount,
				last_used_at: input.lastUsedAt,
				expires_at: input.expiresAt,
			}
		case 'resource':
			return {
				id: input.id,
				kind: 'resource' as const,
				role: null,
				team_ids: [],
				team_id: null,
				resource_type: target.resourceType,
				resource_id: target.resourceId,
				preset: target.preset,
				label: input.label,
				max_uses: input.maxUses,
				use_count: input.useCount,
				last_used_at: input.lastUsedAt,
				expires_at: input.expiresAt,
			}
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link kind: ${String(exhaustive)}`)
		}
	}
}

function asAccessError(error: unknown, fallback: string): never {
	if (error instanceof McpCallerError) throw error
	if (error instanceof Error) throw new McpCallerError(error.message)
	throw new McpCallerError(fallback)
}

function publicInviteLinkUrl(baseUrl: string, token: string) {
	const origin = baseUrl.trim()
	if (!origin) return undefined
	try {
		return inviteLinkUrl(new Request(origin), token)
	} catch {
		return undefined
	}
}

export const inviteLinkCreateCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteLinkCreate',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: true,
		description:
			'Create a shareable invite link for the organization this request is bound to. kind membership (default) needs member:write and never grants Owner. kind team needs team:write and member:write. kind resource needs Manage on that package. The token and URL are returned once, with a prompt that tells recipients to open /join/{token} or call inviteLinkAccept. Kody stores only a hash.',
		keywords: ['invite', 'link', 'share', 'join', 'member'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			kind: inviteLinkKindSchema.optional(),
			role: inviteLinkRoleSchema.optional(),
			team_ids: z.array(z.string().min(1)).optional(),
			team_id: z.string().min(1).optional(),
			resource_type: z.literal('package').optional(),
			resource_id: z.string().min(1).optional(),
			preset: grantPresetSchema.optional(),
			label: z.string().optional(),
			allowed_email_domains: z.array(z.string().min(1)).optional(),
			max_uses: z.number().int().positive().optional(),
			expires_in_days: z.number().int().min(1).max(365).optional(),
		}),
		outputSchema: z.object({
			invite_link: inviteLinkSchema,
			token: z.string(),
			url: z.string().optional(),
			prompt: z.string(),
		}),
		async handler(args, ctx) {
			try {
				const user = requireMcpUser(ctx.callerContext)
				const request = requireMcpRequest(ctx.callerContext)
				const db = ctx.env.APP_DB
				const org = await requireLiveOrg(db, request.org.id)
				const kind = args.kind ?? 'membership'
				const parsedOptions = readInviteLinkOptions({
					allowedEmailDomains: args.allowed_email_domains,
					maxUses: args.max_uses,
					expiresInDays: args.expires_in_days,
				})
				if (!parsedOptions.ok) {
					throw new McpCallerError(parsedOptions.error)
				}
				const { allowedEmailDomains, maxUses, expiresAt } =
					parsedOptions.options
				let target: InviteLinkTarget
				let teamIds: Array<string> | null = null
				switch (kind) {
					case 'membership': {
						await authorize({ env: ctx.env, request }, 'member:write')
						if (await isPersonalOrg(db, request.org.id)) {
							throw new McpCallerError(
								'Membership for your personal organization is managed with your account. Create a team organization to invite people.',
							)
						}
						if (
							args.team_id ||
							args.resource_type ||
							args.resource_id ||
							args.preset
						) {
							throw new McpCallerError(
								'Membership invite links do not take team_id, resource_type, resource_id, or preset. Use kind team or kind resource for that.',
							)
						}
						const role = args.role ?? 'member'
						if (!isInviteLinkRole(role)) {
							throw new McpCallerError(
								'Invite links cannot grant the Owner role.',
							)
						}
						teamIds = args.team_ids ?? []
						target = { kind: 'membership', role }
						break
					}
					case 'team': {
						await authorize({ env: ctx.env, request }, 'team:write')
						await authorize({ env: ctx.env, request }, 'member:write')
						if (await isPersonalOrg(db, request.org.id)) {
							throw new McpCallerError(
								'Teams are not available in a personal organization.',
							)
						}
						if (
							args.role ||
							(args.team_ids && args.team_ids.length > 0) ||
							args.resource_type ||
							args.resource_id ||
							args.preset
						) {
							throw new McpCallerError(
								'Team invite links take team_id only. Use kind membership for a role and teams, or kind resource for a package.',
							)
						}
						const teamId = args.team_id?.trim() ?? ''
						if (!teamId) {
							throw new McpCallerError('Team invite links need team_id.')
						}
						target = { kind: 'team', teamId }
						break
					}
					case 'resource': {
						if (
							args.role ||
							args.team_id ||
							(args.team_ids && args.team_ids.length > 0)
						) {
							throw new McpCallerError(
								'Resource invite links do not take a role or teams. Use kind membership or kind team for that.',
							)
						}
						if (args.resource_type && args.resource_type !== 'package') {
							throw new McpCallerError(
								'Resource invite links only support resource_type package.',
							)
						}
						if (!args.resource_id) {
							throw new McpCallerError(
								'Resource invite links need resource_id.',
							)
						}
						if (!args.preset) {
							throw new McpCallerError(
								'Resource invite links need a preset (read, use, contribute, or manage).',
							)
						}
						const savedPackage = await resolveSavedPackage({
							db,
							userId: request.org.id,
							packageIdOrKodyId: args.resource_id.trim(),
						})
						if (!savedPackage) {
							throw new McpCallerError(
								'Package was not found in this organization.',
							)
						}
						await authorizeGrantTarget(ctx, 'package', savedPackage.id)
						target = {
							kind: 'resource',
							resourceType: 'package',
							resourceId: savedPackage.id,
							preset: args.preset,
						}
						break
					}
					default: {
						const exhaustive: never = kind
						throw new Error(`Unknown invite link kind: ${String(exhaustive)}`)
					}
				}
				const token = generateInviteLinkToken()
				const tokenHash = await hashInviteLinkToken(token)
				let created: Awaited<ReturnType<typeof createOrgInviteLink>>
				try {
					created = await createOrgInviteLink({
						db,
						orgId: request.org.id,
						target,
						createdByUserId: user.userId,
						tokenHash,
						allowedEmailDomains,
						teamIds,
						label: args.label,
						maxUses,
						expiresAt,
						audit: orgAuditWriterFromRequest(ctx.env, request),
					})
				} catch (error) {
					asAccessError(error, 'Unable to create that invite link.')
				}
				const url = publicInviteLinkUrl(ctx.callerContext.baseUrl, token)
				return {
					invite_link: toInviteLinkPayload({
						id: created.id,
						target,
						teamIds: created.teamIds,
						label: created.label,
						maxUses: created.maxUses,
						useCount: 0,
						lastUsedAt: null,
						expiresAt: created.expiresAt,
					}),
					token,
					...(url ? { url } : {}),
					prompt: inviteLinkAcceptPrompt({
						orgSlug: org.slug,
						token,
						url,
					}),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const inviteLinkListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteLinkList',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'List active membership invite links for the organization this request is bound to. Needs member:write. Does not return tokens; those are shown only when a link is created.',
		keywords: ['invite', 'link', 'list', 'share'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			invite_links: z.array(
				z.object({
					id: z.string(),
					role: inviteLinkRoleSchema,
					team_ids: z.array(z.string()),
					label: z.string().nullable(),
					max_uses: z.number().nullable(),
					use_count: z.number(),
					last_used_at: z.string().nullable(),
					expires_at: z.string(),
					created_at: z.string(),
					created_by_username: z.string().nullable(),
				}),
			),
		}),
		async handler(_args, ctx) {
			try {
				const request = requireMcpRequest(ctx.callerContext)
				await authorize({ env: ctx.env, request }, 'member:write')
				const links = await listActiveOrgInviteLinks(
					ctx.env.APP_DB,
					request.org.id,
					new Date().toISOString(),
					{ kind: 'membership' },
				)
				return {
					invite_links: links.flatMap((link) => {
						if (link.target.kind !== 'membership') return []
						return [
							{
								id: link.id,
								role: link.target.role,
								team_ids: link.teamIds,
								label: link.label,
								max_uses: link.maxUses,
								use_count: link.useCount,
								last_used_at: link.lastUsedAt,
								expires_at: link.expiresAt,
								created_at: link.createdAt,
								created_by_username: link.createdByUsername,
							},
						]
					}),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const inviteLinkRevokeCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteLinkRevoke',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: true,
		description:
			'Revoke an active membership invite link in the organization this request is bound to. Needs member:write. Team and package links are managed from their own surfaces.',
		keywords: ['invite', 'link', 'revoke', 'cancel'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			invite_link_id: z.string().min(1),
		}),
		outputSchema: z.object({
			invite_link_id: z.string(),
			status: z.literal('revoked'),
		}),
		async handler(args, ctx) {
			try {
				const request = requireMcpRequest(ctx.callerContext)
				await authorize({ env: ctx.env, request }, 'member:write')
				const db = ctx.env.APP_DB
				const link = await getInviteLinkById({
					db,
					orgId: request.org.id,
					linkId: args.invite_link_id,
				})
				if (!link || link.target.kind !== 'membership') {
					throw new McpCallerError(
						'Invite link was not found in this organization.',
					)
				}
				try {
					await revokeOrgInviteLink({
						db,
						orgId: request.org.id,
						linkId: link.id,
						scope: { kind: 'membership' },
						audit: orgAuditWriterFromRequest(ctx.env, request),
					})
				} catch (error) {
					asAccessError(error, 'Unable to revoke that invite link.')
				}
				return { invite_link_id: link.id, status: 'revoked' as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const inviteLinkAcceptCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'inviteLinkAccept',
		contextRuns: 'deny',
		orgPermission: 'org:read',
		requiresLivePerson: true,
		description:
			'Accept a shareable invite link with the token from inviteLinkCreate (or from the /join/{token} URL). Membership links add you to that organization. Team links add you to the team. Package links grant the preset. The prompt from inviteLinkCreate includes the organization slug and this call.',
		keywords: ['invite', 'link', 'accept', 'join', 'token'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			token: z.string().min(1),
		}),
		outputSchema: z.object({
			org_slug: z.string(),
			already_member: z.boolean(),
			role: inviteLinkRoleSchema.nullable(),
			kind: inviteLinkKindSchema,
		}),
		async handler(args, ctx) {
			try {
				const { user, request, db } = await requireOrgPermission(
					ctx,
					'org:read',
				)
				const tokenHash = await hashInviteLinkToken(args.token)
				const link = await getInviteLinkByTokenHash(db, tokenHash)
				if (
					!link ||
					!(await timingSafeEqualString(link.tokenHash, tokenHash))
				) {
					throw new McpCallerError('Invite link token is not valid.')
				}
				const emailVerified = await isAccountEmailVerified({
					db,
					email: user.email,
					stableUserId: user.userId,
				})
				const result = await redeemOrgInviteLink({
					db,
					env: ctx.env,
					link,
					user: {
						userId: user.userId,
						email: user.email,
						emailVerified,
					},
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				if (!result.ok) {
					throw new McpCallerError(result.error)
				}
				const org = await requireLiveOrg(db, result.orgId)
				return {
					org_slug: org.slug,
					already_member: result.alreadyMember,
					role: result.role,
					kind: result.target.kind,
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

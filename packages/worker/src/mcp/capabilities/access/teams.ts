import { endMemberExecutionContextLeases } from '#worker/execution-contexts/service.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import {
	addTeamMember,
	createTeam,
	removeTeamMember,
} from '#worker/orgs/access-writes.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { listTeams } from '#worker/orgs/org-teams-list.ts'
import {
	requireOrgPermission,
	resolvePersonId,
	resolveTeamId,
	rethrowAccessError,
} from './shared.ts'

const personalOrgTeamWriteMessage =
	'Teams belong to team organizations. Create a team organization to group people.'

async function assertTeamOrg(db: D1Database, orgId: string) {
	if (await isPersonalOrg(db, orgId)) {
		throw new McpCallerError(personalOrgTeamWriteMessage)
	}
}

const teamSummarySchema = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	member_count: z.number().int().nonnegative(),
})

export const teamListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'teamList',
		contextRuns: 'allow',
		orgPermission: 'team:read',
		description:
			'List live teams in the organization this request is bound to, with live member counts.',
		keywords: ['team', 'list', 'group'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			teams: z.array(teamSummarySchema),
		}),
		async handler(_args, ctx) {
			try {
				const { request, db } = await requireOrgPermission(ctx, 'team:read')
				const teams = await listTeams(db, request.org.id)
				return {
					teams: teams.map((team) => ({
						id: team.id,
						slug: team.slug,
						name: team.name,
						description: team.description,
						member_count: team.memberCount,
					})),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const teamCreateCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'teamCreate',
		contextRuns: 'deny',
		orgPermission: 'team:write',
		description:
			'Create a team in the organization this request is bound to. The slug is a handle unique inside the organization.',
		keywords: ['team', 'create', 'group'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			slug: z.string().min(1),
			name: z.string().min(1),
			description: z.string().optional(),
		}),
		outputSchema: z.object({
			team: z.object({
				id: z.string(),
				slug: z.string(),
				name: z.string(),
			}),
		}),
		async handler(args, ctx) {
			try {
				const { user, request, db } = await requireOrgPermission(
					ctx,
					'team:write',
				)
				await assertTeamOrg(db, request.org.id)
				const slug = normalizeUsername(args.slug)
				const formatError = getUsernameFormatValidationError(slug)
				if (formatError) throw new McpCallerError(formatError)
				const name = args.name.trim()
				if (!name) throw new McpCallerError('Team name is required.')
				const created = await createTeam({
					db,
					orgId: request.org.id,
					slug,
					name,
					description: args.description,
					createdByUserId: user.userId,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				return {
					team: {
						id: created.id,
						slug: created.slug,
						name,
					},
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const teamMemberAddCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'teamMemberAdd',
		contextRuns: 'deny',
		orgPermission: 'team:write',
		requiresLivePerson: true,
		description:
			'Add an organization member to a team in the organization this request is bound to. The person must already be a live member.',
		keywords: ['team', 'member', 'add'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			team_id: z.string().min(1).optional(),
			team_slug: z.string().min(1).optional(),
			user_id: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			team_id: z.string(),
			user_id: z.string(),
		}),
		async handler(args, ctx) {
			try {
				const { user, request, db } = await requireOrgPermission(
					ctx,
					'team:write',
				)
				await assertTeamOrg(db, request.org.id)
				const teamId = await resolveTeamId(db, request.org.id, {
					teamId: args.team_id,
					teamSlug: args.team_slug,
				})
				const userId = await resolvePersonId(db, {
					userId: args.user_id,
					username: args.username,
				})
				await addTeamMember({
					db,
					orgId: request.org.id,
					teamId,
					userId,
					addedByUserId: user.userId,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				return { team_id: teamId, user_id: userId }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const teamMemberRemoveCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'teamMemberRemove',
		contextRuns: 'deny',
		orgPermission: 'team:delete',
		requiresLivePerson: true,
		description:
			'Remove a person from a team in the organization this request is bound to. They stay an organization member.',
		keywords: ['team', 'member', 'remove'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			team_id: z.string().min(1).optional(),
			team_slug: z.string().min(1).optional(),
			user_id: z.string().min(1).optional(),
			username: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			team_id: z.string(),
			user_id: z.string(),
			removed: z.literal(true),
		}),
		async handler(args, ctx) {
			try {
				const { request, db } = await requireOrgPermission(ctx, 'team:delete')
				await assertTeamOrg(db, request.org.id)
				const teamId = await resolveTeamId(db, request.org.id, {
					teamId: args.team_id,
					teamSlug: args.team_slug,
				})
				const userId = await resolvePersonId(db, {
					userId: args.user_id,
					username: args.username,
				})
				await removeTeamMember({
					db,
					orgId: request.org.id,
					teamId,
					userId,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				await endMemberExecutionContextLeases(ctx.env, {
					orgId: request.org.id,
					userId,
				})
				return { team_id: teamId, user_id: userId, removed: true as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

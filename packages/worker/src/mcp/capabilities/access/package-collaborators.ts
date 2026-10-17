import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { getGrantById } from '#worker/orgs/access-writes.ts'
import { getLiveOrgMembership } from '#worker/orgs/org-members-list.ts'
import { listPackageCollaborators } from '#worker/orgs/package-collaborators.ts'
import { type PackageCollaboratorView } from '#universal/package-collaborators.ts'
import {
	accessGrantCapability,
	accessRevokeCapability,
} from './access-grants.ts'
import {
	authorizeGrantTarget,
	grantPresetSchema,
	resolvePersonId,
	resolveTeamId,
	rethrowAccessError,
} from './shared.ts'

const collaboratorSchema = z.object({
	grant_id: z.string(),
	subject_type: z.enum(['user', 'team']),
	subject_id: z.string(),
	kind: z
		.enum(['team', 'member', 'outside'])
		.describe(
			'team: a team in this org. member: an org member. outside: holds this grant without membership (granted elsewhere).',
		),
	username: z.string().nullable(),
	display_name: z.string().nullable(),
	team_slug: z.string().nullable(),
	team_name: z.string().nullable(),
	preset: grantPresetSchema
		.nullable()
		.describe('Null for an advanced grant; see permissions.'),
	permissions: z.array(z.string()),
	created_at: z.string(),
})

const packageSchema = z.object({
	id: z.string(),
	kody_id: z.string(),
	name: z.string(),
})

const packageIdSchema = z.string().min(1).describe('Package id or kody id.')

function toCollaboratorPayload(collaborator: PackageCollaboratorView) {
	return {
		grant_id: collaborator.grantId,
		subject_type: collaborator.subjectType,
		subject_id: collaborator.subjectId,
		kind: collaborator.kind,
		username: collaborator.username,
		display_name: collaborator.displayName,
		team_slug: collaborator.teamSlug,
		team_name: collaborator.subjectType === 'team' ? collaborator.label : null,
		preset: collaborator.preset,
		permissions: collaborator.permissions,
		created_at: collaborator.createdAt,
	}
}

/** The package in the bound org, once the caller may manage access to it. */
async function loadManagedPackage(ctx: CapabilityContext, packageId: string) {
	const request = requireMcpRequest(ctx.callerContext)
	const savedPackage = await resolveSavedPackage({
		db: ctx.env.APP_DB,
		userId: request.org.id,
		packageIdOrKodyId: packageId.trim(),
	})
	if (!savedPackage) {
		throw new McpCallerError('Package was not found in this organization.')
	}
	await authorizeGrantTarget(ctx, 'package', savedPackage.id)
	return {
		orgId: request.org.id,
		package: {
			id: savedPackage.id,
			kody_id: savedPackage.kodyId,
			name: savedPackage.name,
		},
	}
}

function readSelector(value: string | undefined) {
	const trimmed = value?.trim()
	return trimmed ? trimmed : null
}

/**
 * The team or org member to add. Only subjects inside the owning org are
 * accepted; people outside it are refused rather than granted directly.
 */
async function resolveInternalSubject(
	db: D1Database,
	orgId: string,
	input: {
		team_slug?: string
		team_id?: string
		username?: string
		user_id?: string
	},
): Promise<{ type: 'user' | 'team'; id: string }> {
	const teamSlug = readSelector(input.team_slug)
	const teamId = readSelector(input.team_id)
	const username = readSelector(input.username)
	const userIdInput = readSelector(input.user_id)
	if ([teamSlug, teamId, username, userIdInput].filter(Boolean).length !== 1) {
		throw new McpCallerError(
			'Pass exactly one of team_slug, team_id, username, or user_id.',
		)
	}
	if (teamSlug || teamId) {
		return {
			type: 'team',
			id: await resolveTeamId(db, orgId, { teamId, teamSlug }),
		}
	}
	const userId = await resolvePersonId(db, { userId: userIdInput, username })
	const membership = await getLiveOrgMembership(db, orgId, userId)
	if (!membership) {
		throw new McpCallerError(
			'That person is not a member of this organization. Only teams and org members can be added as collaborators.',
		)
	}
	if (membership.role === 'owner') {
		throw new McpCallerError(
			'Owners already have full access to every package in this organization.',
		)
	}
	return { type: 'user', id: userId }
}

/** Shared write operation. MCP enriches its response separately; website writes
 * return an acknowledgement without depending on a subsequent list read. */
export async function setPackageCollaboratorAccess(
	args: Parameters<typeof resolveInternalSubject>[2] & {
		package_id: string
		preset: z.infer<typeof grantPresetSchema>
	},
	ctx: CapabilityContext,
) {
	const managed = await loadManagedPackage(ctx, args.package_id)
	const subject = await resolveInternalSubject(
		ctx.env.APP_DB,
		managed.orgId,
		args,
	)
	await accessGrantCapability.handler(
		{
			resource_type: 'package',
			resource_id: managed.package.id,
			subject_type: subject.type,
			subject_id: subject.id,
			preset: args.preset,
		},
		ctx,
	)
	return { managed, subject }
}

export const packageCollaboratorListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'packageCollaboratorList',
		orgPermission: 'none',
		description:
			'List who can use one package in the organization this request is bound to: teams, org members, and outside collaborators with their preset (Use, Contribute, or Manage) and grant_id. package_id takes the package id or its kody id. You need manage access on the package. Add a team or org member, or change their preset, with packageCollaboratorSet; remove one with packageCollaboratorRemove.',
		keywords: [
			'collaborators',
			'package',
			'access',
			'grant',
			'share',
			'who has access',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: packageIdSchema,
		}),
		outputSchema: z.object({
			package: packageSchema,
			collaborators: z.array(collaboratorSchema),
		}),
		async handler(args, ctx) {
			try {
				const managed = await loadManagedPackage(ctx, args.package_id)
				const listed = await listPackageCollaborators({
					db: ctx.env.APP_DB,
					orgId: managed.orgId,
					packageId: managed.package.id,
				})
				return {
					package: managed.package,
					collaborators: listed.collaborators.map(toCollaboratorPayload),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const packageCollaboratorSetCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'packageCollaboratorSet',
		orgPermission: 'none',
		description:
			'Add a team or org member as a collaborator on one package in the organization this request is bound to, or change the preset of one who already is. Pass exactly one of team_slug, team_id, username, or user_id, and a preset (use, contribute, or manage). Only teams and members of this organization are accepted; Owners already have full access. You need manage access on the package. Audited like accessGrant.',
		keywords: [
			'collaborators',
			'package',
			'access',
			'grant',
			'share',
			'add team',
			'add member',
			'preset',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			package_id: packageIdSchema,
			team_slug: z.string().min(1).optional(),
			team_id: z.string().min(1).optional(),
			username: z
				.string()
				.min(1)
				.optional()
				.describe('Username of an org member, without the leading @.'),
			user_id: z.string().min(1).optional(),
			preset: grantPresetSchema,
		}),
		outputSchema: z.object({
			package: packageSchema,
			collaborator: collaboratorSchema,
		}),
		async handler(args, ctx) {
			try {
				const { managed, subject } = await setPackageCollaboratorAccess(
					args,
					ctx,
				)
				const db = ctx.env.APP_DB
				const listed = await listPackageCollaborators({
					db,
					orgId: managed.orgId,
					packageId: managed.package.id,
				})
				const collaborator = listed.collaborators.find(
					(entry) =>
						entry.subjectType === subject.type &&
						entry.subjectId === subject.id,
				)
				if (!collaborator) throw new Error('Collaborator grant was not saved.')
				return {
					package: managed.package,
					collaborator: toCollaboratorPayload(collaborator),
				}
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const packageCollaboratorRemoveCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'packageCollaboratorRemove',
		orgPermission: 'none',
		description:
			'Remove one collaborator from a package in the organization this request is bound to, by the grant_id from packageCollaboratorList. Works for teams, org members, and outside collaborators. You need manage access on the package. Audited like accessRevoke.',
		keywords: ['collaborators', 'package', 'access', 'revoke', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			package_id: packageIdSchema,
			grant_id: z.string().min(1),
		}),
		outputSchema: z.object({
			grant_id: z.string(),
			removed: z.literal(true),
		}),
		async handler(args, ctx) {
			try {
				const managed = await loadManagedPackage(ctx, args.package_id)
				const grant = await getGrantById({
					db: ctx.env.APP_DB,
					orgId: managed.orgId,
					grantId: args.grant_id.trim(),
				})
				if (
					!grant ||
					grant.resourceType !== 'package' ||
					grant.resourceId !== managed.package.id
				) {
					throw new McpCallerError(
						'That collaborator no longer has access to this package.',
					)
				}
				await accessRevokeCapability.handler({ grant_id: grant.id }, ctx)
				return { grant_id: grant.id, removed: true as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

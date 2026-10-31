import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { getGrantById } from '#worker/orgs/access-writes.ts'
import { getLiveOrgMembership } from '#worker/orgs/org-members-list.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { listPackageCollaborators } from '#worker/orgs/package-collaborators.ts'
import {
	grantPackageToProfile,
	removePackageProfileGrant,
} from '#worker/profiles/package-grants.ts'
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
	subject_type: z.enum(['user', 'team', 'org', 'profile']),
	subject_id: z.string(),
	kind: z
		.enum(['org', 'team', 'member', 'outside', 'profile'])
		.describe(
			'org: everyone in this org, resolved live (current and future members). team: a team in this org. member: an org member. outside: holds this grant without membership (granted elsewhere). profile: an agent profile (ADR 0092), capped at run time by its parents and the person it acts for.',
		),
	username: z.string().nullable(),
	display_name: z.string().nullable(),
	team_slug: z.string().nullable(),
	team_name: z.string().nullable(),
	profile_name: z
		.string()
		.nullable()
		.describe('The profile name, for a profile collaborator.'),
	profile_active: z
		.boolean()
		.nullable()
		.describe(
			'For a profile collaborator: false once it or a parent is revoked or expired, so the grant no longer reaches anything.',
		),
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
		profile_name: collaborator.profileName ?? null,
		profile_active: collaborator.profileActive ?? null,
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
 * The team, person, or everyone in the org to add. A person outside the org
 * becomes an outside collaborator, the same direct grant `accessGrant` writes.
 */
async function resolveCollaboratorSubject(
	db: D1Database,
	orgId: string,
	input: {
		team_slug?: string
		team_id?: string
		username?: string
		user_id?: string
		everyone?: boolean
	},
): Promise<{ type: 'user' | 'team' | 'org'; id: string }> {
	const teamSlug = readSelector(input.team_slug)
	const teamId = readSelector(input.team_id)
	const username = readSelector(input.username)
	const userIdInput = readSelector(input.user_id)
	const everyone = input.everyone === true
	if (
		[teamSlug, teamId, username, userIdInput, everyone].filter(Boolean)
			.length !== 1
	) {
		throw new McpCallerError(
			'Pass exactly one of team_slug, team_id, username, user_id, or everyone: true.',
		)
	}
	if (everyone) return { type: 'org', id: orgId }
	if (teamSlug || teamId) {
		return {
			type: 'team',
			id: await resolveTeamId(db, orgId, { teamId, teamSlug }),
		}
	}
	const userId = await resolvePersonId(db, { userId: userIdInput, username })
	const membership = await getLiveOrgMembership(db, orgId, userId)
	if (membership?.role === 'owner') {
		throw new McpCallerError(
			'Owners already have full access to every package in this organization.',
		)
	}
	if (!membership && userIdInput) {
		const user = await db
			.prepare(
				`SELECT 1 AS found FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(userId)
			.first<{ found: number }>()
		if (!user) throw new McpCallerError('No user with that user_id.')
	}
	return { type: 'user', id: userId }
}

/** Shared write operation. MCP enriches its response separately; website writes
 * return an acknowledgement without depending on a subsequent list read. */
export async function setPackageCollaboratorAccess(
	args: Parameters<typeof resolveCollaboratorSubject>[2] & {
		package_id: string
		preset?: z.infer<typeof grantPresetSchema>
		permissions?: Array<string>
		profile_id?: string
	},
	ctx: CapabilityContext,
) {
	const managed = await loadManagedPackage(ctx, args.package_id)
	const profileId = readSelector(args.profile_id)
	if (profileId) {
		if (
			[args.team_slug, args.team_id, args.username, args.user_id].some(
				(value) => readSelector(value),
			) ||
			args.everyone
		) {
			throw new McpCallerError(
				'Pass exactly one of team_slug, team_id, username, user_id, everyone: true, or profile_id.',
			)
		}
		if (!args.preset) {
			throw new McpCallerError(
				'Profile grants take a preset (read, use, contribute, or manage), not a permissions list.',
			)
		}
		await grantPackageToProfile({
			env: ctx.env,
			request: requireMcpRequest(ctx.callerContext),
			packageId: managed.package.id,
			profileId,
			preset: args.preset,
		})
		return { managed, subject: { type: 'profile' as const, id: profileId } }
	}
	const subject = await resolveCollaboratorSubject(
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
			permissions: args.permissions,
		},
		ctx,
	)
	return { managed, subject }
}

export const packageCollaboratorListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'packageCollaboratorList',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'List who can use one package in the organization this request is bound to: teams, org members, and outside collaborators with their preset (Read, Use, Contribute, or Manage) and grant_id. package_id takes the package id or its kody id. You need manage access on the package. Add a team or org member, or change their preset, with packageCollaboratorSet; remove one with packageCollaboratorRemove.',
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
		contextRuns: 'deny',
		orgPermission: 'none',
		description:
			'Add a team, a person, or everyone in this organization as a collaborator on one package in the organization this request is bound to, or change the preset of one who already is. Pass exactly one of team_slug, team_id, username, user_id, everyone: true, or profile_id (an agent profile, profiles experiment), and a preset (read, use, contribute, or manage). read shares only the source: they can read, clone, and fork it into their own Kody (packageFork) but cannot run the package or open its app. A username outside this organization becomes an outside collaborator. everyone covers current and future members, resolved live, so someone who leaves loses it at once; the package stays private to everyone else. Owners already have full access. You need manage access on the package. Member, team, and org grants are audited like accessGrant; profile grants are not audited yet.',
		keywords: [
			'collaborators',
			'package',
			'access',
			'grant',
			'share',
			'add team',
			'add member',
			'outside collaborator',
			'read only',
			'share source',
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
				.describe(
					'Username of the person, without the leading @. People outside this organization become outside collaborators.',
				),
			user_id: z.string().min(1).optional(),
			profile_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'A profile id from profileList (profiles experiment). Every parent profile must already hold the preset on this package; the profile never gets more than the person it acts for.',
				),
			everyone: z
				.boolean()
				.optional()
				.describe(
					'true: everyone in this organization (current and future members).',
				),
			preset: grantPresetSchema.optional(),
			permissions: z
				.array(z.string().min(1))
				.optional()
				.describe(
					'Advanced grant: package permissions (package:read, package:execute, package:write, package:publish, package:delete, package:manage_access). Do not combine with preset.',
				),
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
		contextRuns: 'deny',
		orgPermission: 'none',
		description:
			'Remove one collaborator from a package in the organization this request is bound to, by the grant_id from packageCollaboratorList. Works for teams, org members, and outside collaborators. You need manage access on the package. Member, team, and org removals are audited like accessRevoke; profile grant removals are not audited yet.',
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
					!grant &&
					(await removePackageProfileGrant({
						db: ctx.env.APP_DB,
						orgId: managed.orgId,
						packageId: managed.package.id,
						grantId: args.grant_id.trim(),
					}))
				) {
					return { grant_id: args.grant_id.trim(), removed: true as const }
				}
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

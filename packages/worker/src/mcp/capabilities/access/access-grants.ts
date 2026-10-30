import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'
import {
	getGrantById,
	grantSubjectTypes,
	isGrantResourceType,
	listGrants,
	softDeleteGrant,
	upsertGrant,
	type GrantResourceType,
	type GrantSubject,
	type GrantSubjectType,
} from '#worker/orgs/access-writes.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	accessGrantSchema,
	authorizeGrantRevoke,
	authorizeGrantTarget,
	grantChangesMemberOrBilling,
	grantPresetSchema,
	grantTargetTypeSchema,
	readPermissionList,
	requireOrgPermission,
	requirePresetOrPermissions,
	resolveAuthorizedGrantPermissions,
	resolveGrantTarget,
	resolvePersonId,
	resolveTeamId,
	rethrowAccessError,
	toAccessGrantPayload,
} from './shared.ts'

async function resolveGrantSubject(
	db: D1Database,
	orgId: string,
	input: {
		subject_type: GrantSubjectType
		subject_id?: string
		username?: string
		team_slug?: string
	},
): Promise<GrantSubject> {
	const subjectType = input.subject_type
	switch (subjectType) {
		case 'user':
			if (input.team_slug) {
				throw new McpCallerError('team_slug is only for a team subject.')
			}
			return {
				type: 'user',
				id: await resolvePersonId(db, {
					userId: input.subject_id,
					username: input.username,
				}),
			}
		case 'team':
			if (input.username) {
				throw new McpCallerError('username is only for a user subject.')
			}
			return {
				type: 'team',
				id: await resolveTeamId(db, orgId, {
					teamId: input.subject_id,
					teamSlug: input.team_slug,
				}),
			}
		case 'org':
			if (input.username || input.team_slug) {
				throw new McpCallerError(
					'An org subject is everyone in this organization; omit username and team_slug.',
				)
			}
			if (input.subject_id && input.subject_id !== orgId) {
				throw new McpCallerError(
					'An org subject can only be the organization this request is bound to. Omit subject_id or pass this organization id.',
				)
			}
			if (await isPersonalOrg(db, orgId)) {
				throw new McpCallerError(
					'A personal organization has no other members. Grant a user instead.',
				)
			}
			return { type: 'org', id: orgId }
		default: {
			const exhaustive: never = subjectType
			throw new Error(`Unknown grant subject: ${String(exhaustive)}`)
		}
	}
}

function readGrantExpiry(value: string | null | undefined) {
	if (value == null) return value
	const expiresAt = new Date(value)
	if (expiresAt.getTime() <= Date.now()) {
		throw new McpCallerError(
			'expires_at must be in the future. Revoke the grant with accessRevoke to end it now.',
		)
	}
	return expiresAt.toISOString()
}

export const accessGrantCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'accessGrant',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: async (args, ctx) => {
			if (args.resource_type !== 'org') return false
			if (
				grantChangesMemberOrBilling({
					resourceType: args.resource_type,
					permissions: args.permissions,
				})
			) {
				return true
			}
			const request = ctx.callerContext.request
			if (!request) return true
			// The write replaces this subject's grant, so dropping member or billing
			// permissions it already holds is a change too. Authorize first so only
			// a caller who could make the write learns what the subject holds.
			await authorizeGrantTarget(ctx, 'org', args.resource_id)
			const subject = await resolveGrantSubject(
				ctx.env.APP_DB,
				request.org.id,
				{
					subject_type: args.subject_type,
					subject_id: args.subject_id,
					username: args.username,
					team_slug: args.team_slug,
				},
			)
			const existing = await listGrants({
				db: ctx.env.APP_DB,
				orgId: request.org.id,
				resourceType: 'org',
				resourceId: args.resource_id,
				subjectType: subject.type,
				subjectId: subject.id,
			})
			return existing.some(grantChangesMemberOrBilling)
		},
		description:
			'Grant a user, a team, or everyone in this organization (subject_type org) Use, Contribute, or Manage on a resource in the organization this request is bound to, or pass an explicit permission list instead of a preset. Secrets, integrations, MCP servers, and vault bindings use resource_type credential with the credential_id from secretList, integrationList, mcpServerList, or secretProviderList; the grant follows the credential, not its name. resource_type secret or integration with a name still works: the name resolves to its credential once, when the grant is made. Organization grants use resource_type org and this organization id; besides org-level permissions they may carry the read-only package:read, app:read, job:read, integration:read, or email:read for org-wide reads (no write, execute, or use). You need manage access on that resource (or member:write for an organization grant). Only an Owner can put org:write, org:delete, member:write, or member:delete on an organization grant.',
		keywords: ['grant', 'access', 'permission', 'share', 'preset'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			resource_type: grantTargetTypeSchema.describe(
				'package, app, job, credential, memory, email, or org. secret or integration take a name instead of a credential id.',
			),
			resource_id: z.string().min(1),
			subject_type: z
				.enum(grantSubjectTypes)
				.describe(
					'user, team, or org. org means everyone in this organization: every current and future member, resolved live, so someone who leaves loses it at once. It covers only this one resource and is not available on resource_type org.',
				),
			subject_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Person id or team id. Omit when passing username or team_slug, and for an org subject.',
				),
			username: z.string().min(1).optional(),
			team_slug: z.string().min(1).optional(),
			preset: grantPresetSchema.optional(),
			permissions: z
				.array(z.string().min(1))
				.optional()
				.describe('Advanced grant. Do not combine with preset.'),
			expires_at: z
				.string()
				.datetime({ offset: true })
				.nullable()
				.optional()
				.describe(
					"When the grant stops counting (ISO 8601, in the future). null never expires. Omit to keep an existing grant's expiry (a new grant never expires).",
				),
		}),
		outputSchema: z.object({ grant: accessGrantSchema }),
		async handler(args, ctx) {
			try {
				const permissions = readPermissionList(args.permissions)
				const expiresAt = readGrantExpiry(args.expires_at)
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
				const subject = await resolveGrantSubject(
					scoped.db,
					scoped.request.org.id,
					{
						subject_type: args.subject_type,
						subject_id: args.subject_id,
						username: args.username,
						team_slug: args.team_slug,
					},
				)
				const written = await upsertGrant({
					db: scoped.db,
					orgId: scoped.request.org.id,
					resourceType: target.resourceType,
					resourceId: target.resourceId,
					family: scoped.family,
					subject,
					preset: args.preset ?? null,
					permissions: args.preset ? null : [...resolved],
					createdByUserId: scoped.user.userId,
					...(expiresAt === undefined ? {} : { expiresAt }),
					audit: orgAuditWriterFromRequest(ctx.env, scoped.request),
				})
				const grant = await getGrantById({
					db: scoped.db,
					orgId: scoped.request.org.id,
					grantId: written.id,
				})
				if (!grant) throw new Error('Grant was not saved.')
				return { grant: toAccessGrantPayload(grant) }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const accessRevokeCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'accessRevoke',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: async (args, ctx) => {
			const request = ctx.callerContext.request
			if (!request) return true
			const grant = await getGrantById({
				db: ctx.env.APP_DB,
				orgId: request.org.id,
				grantId: args.grant_id,
			})
			if (!grant || !grantChangesMemberOrBilling(grant)) return false
			await authorizeGrantTarget(ctx, 'org', grant.resourceId)
			return true
		},
		description:
			'Revoke one live grant in the organization this request is bound to. You need manage access on that grant resource (or member:write for an organization grant).',
		keywords: ['grant', 'revoke', 'access', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			grant_id: z.string().min(1),
		}),
		outputSchema: z.object({
			grant_id: z.string(),
			revoked: z.literal(true),
		}),
		async handler(args, ctx) {
			try {
				requireMcpUser(ctx.callerContext)
				const request = requireMcpRequest(ctx.callerContext)
				const db = ctx.env.APP_DB
				const grant = await getGrantById({
					db,
					orgId: request.org.id,
					grantId: args.grant_id,
				})
				if (!grant || !isGrantResourceType(grant.resourceType)) {
					throw new McpCallerError('Grant was not found in this organization.')
				}
				await authorizeGrantRevoke(ctx, grant.resourceType, grant.resourceId)
				await softDeleteGrant({
					db,
					orgId: request.org.id,
					grantId: grant.id,
					audit: orgAuditWriterFromRequest(ctx.env, request),
				})
				return { grant_id: grant.id, revoked: true as const }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

export const accessListCapability = defineDomainCapability(
	capabilityDomainNames.access,
	{
		name: 'accessList',
		contextRuns: 'allow',
		orgPermission: 'member:read',
		description:
			'List live grants in the organization this request is bound to. Filter by resource or subject when you already know which one you want. A grant whose expires_at has passed is still listed (until it is rewritten or revoked) but grants no access.',
		keywords: ['grant', 'list', 'access', 'who has access'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			resource_type: grantTargetTypeSchema
				.optional()
				.describe(
					'secret or integration with a resource_id filter by that credential name.',
				),
			resource_id: z.string().min(1).optional(),
			subject_type: z.enum(grantSubjectTypes).optional(),
			subject_id: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			grants: z.array(accessGrantSchema),
		}),
		async handler(args, ctx) {
			try {
				const { db, request } = await requireOrgPermission(ctx, 'member:read')
				let legacyFamily: 'secret' | 'integration' | null = null
				let resourceType: GrantResourceType | undefined
				if (
					args.resource_type === 'secret' ||
					args.resource_type === 'integration'
				) {
					legacyFamily = args.resource_type
					resourceType = 'credential'
				} else {
					resourceType = args.resource_type
				}
				const filter = {
					db,
					orgId: request.org.id,
					resourceType,
					subjectType: args.subject_type,
					subjectId: args.subject_id,
				}
				const grants =
					legacyFamily && args.resource_id
						? (
								await Promise.all(
									(
										await findCredentialIdsByLegacyName(db, request.org.id, {
											type: legacyFamily,
											name: args.resource_id,
										})
									).map((resourceId) => listGrants({ ...filter, resourceId })),
								)
							).flat()
						: await listGrants({ ...filter, resourceId: args.resource_id })
				const listed = legacyFamily
					? grants.filter((grant) =>
							grant.permissions.some((permission) =>
								permission.startsWith(`${legacyFamily}:`),
							),
						)
					: grants
				return { grants: listed.map(toAccessGrantPayload) }
			} catch (error) {
				rethrowAccessError(error)
			}
		},
	},
)

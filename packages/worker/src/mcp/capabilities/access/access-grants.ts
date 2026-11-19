import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	allowUnmappableCredentialChangesDescription,
	assertCanSetUnmappableCredentialChanges,
	unmappableCredentialGrantWarnings,
} from '#mcp/capabilities/access/unmappable-credential-warnings.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { findCredentialIdsByLegacyName } from '#worker/credentials/credential-ids.ts'
import {
	getGrantById,
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
	type ProfileView,
	grantToProfile,
	listProfiles,
	requireProfilesCaller,
	revokeProfileGrant,
} from '#worker/profiles/service.ts'
import { findLiveProfileGrant } from '#worker/profiles/store.ts'
import {
	permissionsForGrantPreset,
	type GrantPreset,
} from '@kody-internal/shared/grant-presets.ts'
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	accessGrantSchema,
	accessSubjectTypes,
	authorizeGrantRevoke,
	authorizeGrantTarget,
	grantChangesMemberOrBilling,
	grantPresetSchema,
	grantTargetFamily,
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

function profileGrantPayload(
	profileId: string,
	grant: ProfileView['grants'][number],
) {
	if (!isGrantResourceType(grant.resourceType)) return null
	return {
		id: grant.grantId,
		resource_type: grant.resourceType,
		resource_id: grant.resourceId,
		subject_type: 'profile' as const,
		subject_id: profileId,
		preset: null,
		permissions: grant.permissions,
		expires_at: null,
		allow_changes_despite_unmappable_credentials: false,
	}
}

/**
 * A grant to an existing profile takes the checks `profileCreate` runs on
 * its grants instead of manage access on the resource (ADR 0092).
 */
async function grantResourceToExistingProfile(
	ctx: CapabilityContext,
	input: {
		profileId: string
		resourceType: GrantResourceType
		resourceId: string
		preset: GrantPreset | null
		permissions: Array<OrgPermission> | null
	},
) {
	const family = await grantTargetFamily(
		ctx,
		input.resourceType,
		input.resourceId,
	)
	// grantToProfile checks the permissions against the profile rules, the
	// same ones profileCreate uses, so only a preset needs expanding here.
	let permissions: ReadonlyArray<OrgPermission> = input.permissions ?? []
	if (input.preset) {
		if (family === 'org') {
			throw new McpCallerError(
				'Grant presets do not apply to the org resource. Pass an explicit permission list.',
			)
		}
		permissions = permissionsForGrantPreset(family, input.preset)
	}
	const caller = await requireProfilesCaller(ctx)
	const { grantId, profile } = await grantToProfile(caller, {
		profileId: input.profileId,
		grant: {
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			permissions,
		},
		preset: input.preset,
		label: `${input.resourceType} ${input.resourceId}`,
	})
	const saved = profile.grants.find((grant) => grant.grantId === grantId)
	const payload = saved ? profileGrantPayload(profile.id, saved) : null
	if (!payload) throw new Error('Grant was not saved.')
	return payload
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
			if (args.resource_type !== 'org' || args.subject_type === 'profile')
				return false
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
			'Grant a user, a team, or everyone in this organization (subject_type org) Use, Contribute, or Manage on a resource in the organization this request is bound to, or pass an explicit permission list instead of a preset. Secrets, integrations, MCP servers, and vault bindings use resource_type credential with the credential_id from secretList, integrationList, mcpServerList, or secretProviderList; the grant follows the credential, not its name. resource_type secret or integration with a name still works: the name resolves to its credential once, when the grant is made. Organization grants use resource_type org and this organization id; besides org-level permissions they may carry the read-only package:read, app:read, job:read, integration:read, or email:read for org-wide reads, and for a user or team the package and app manage permissions (package:execute, package:write, package:publish, package:delete, package:manage_access, app:execute, app:manage_access), which cover every current and future package and app. Other families get no write, execute, or use org-wide. Org-wide package:write and package:publish still stop at a package with unmappable credentials unless a grant on that package allows changes. You need manage access on that resource (or member:write for an organization grant). Only an Owner can put org:write, org:delete, member:write, member:delete, or any package or app manage permission on an organization grant.',
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
				.enum(accessSubjectTypes)
				.describe(
					'user, team, org, or profile. org means everyone in this organization: every current and future member, resolved live, so someone who leaves loses it at once. It covers only this one resource and is not available on resource_type org. profile is one of your agent profiles (subject_id from profileList): you must hold each permission, every parent profile must hold it too, and no manage access on the resource is needed.',
				),
			subject_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Person id, team id, or profile id (prf_...). Omit when passing username or team_slug, and for an org subject.',
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
			allow_changes_despite_unmappable_credentials: z
				.boolean()
				.optional()
				.describe(allowUnmappableCredentialChangesDescription),
		}),
		outputSchema: z.object({
			grant: accessGrantSchema,
			warnings: z
				.array(z.string())
				.describe(
					'Share-time warnings, e.g. the package has unmappable credentials this grant could make its code use. The grant was still saved.',
				),
		}),
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
				if (args.subject_type === 'profile') {
					if (!args.subject_id || args.username || args.team_slug) {
						throw new McpCallerError(
							'A profile subject takes subject_id, the profile id (prf_...) from profileList; omit username and team_slug.',
						)
					}
					if (expiresAt) {
						throw new McpCallerError(
							'A profile grant has no expiry of its own. Shorten the profile expiry with profileUpdate, or revoke the grant with accessRevoke.',
						)
					}
					if (args.allow_changes_despite_unmappable_credentials) {
						throw new McpCallerError(
							'allow_changes_despite_unmappable_credentials is not available for a profile subject.',
						)
					}
					const grant = await grantResourceToExistingProfile(ctx, {
						profileId: args.subject_id,
						resourceType: target.resourceType,
						resourceId: target.resourceId,
						preset: args.preset ?? null,
						permissions,
					})
					const warnings = await unmappableCredentialGrantWarnings({
						env: ctx.env,
						orgId: requireMcpRequest(ctx.callerContext).org.id,
						resourceType: grant.resource_type,
						resourceId: grant.resource_id,
						permissions: grant.permissions,
						changesAllowed: false,
						request: requireMcpRequest(ctx.callerContext),
					})
					return { grant, warnings }
				}
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
				await assertCanSetUnmappableCredentialChanges(ctx, {
					resourceType: target.resourceType,
					resourceId: target.resourceId,
					subjectType: subject.type,
					allow: args.allow_changes_despite_unmappable_credentials,
				})
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
					...(args.allow_changes_despite_unmappable_credentials === undefined
						? {}
						: {
								allowUnmappableCredentialChanges:
									args.allow_changes_despite_unmappable_credentials,
							}),
					audit: orgAuditWriterFromRequest(ctx.env, scoped.request),
				})
				const grant = await getGrantById({
					db: scoped.db,
					orgId: scoped.request.org.id,
					grantId: written.id,
				})
				if (!grant) throw new Error('Grant was not saved.')
				const warnings = await unmappableCredentialGrantWarnings({
					env: ctx.env,
					orgId: scoped.request.org.id,
					resourceType: grant.resourceType,
					resourceId: grant.resourceId,
					permissions: grant.permissions,
					changesAllowed: grant.allowUnmappableCredentialChanges,
					request: scoped.request,
				})
				return { grant: toAccessGrantPayload(grant), warnings }
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
			'Revoke one live grant in the organization this request is bound to. You need manage access on that grant resource (or member:write for an organization grant). A profile grant (subject_type profile) is revoked by the person the profile acts for, or a profile above it.',
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
				const profileGrant = grant
					? null
					: await findLiveProfileGrant(db, {
							orgId: request.org.id,
							grantId: args.grant_id,
						})
				if (profileGrant) {
					await revokeProfileGrant(
						await requireProfilesCaller(ctx),
						profileGrant,
					)
					return { grant_id: profileGrant.grantId, revoked: true as const }
				}
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
			'List live grants in the organization this request is bound to. Filter by resource or subject when you already know which one you want. Pass subject_type profile to list the grants on your agent profiles. A grant whose expires_at has passed is still listed (until it is rewritten or revoked) but grants no access.',
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
			subject_type: z
				.enum(accessSubjectTypes)
				.optional()
				.describe(
					'profile lists the grants on your own agent profiles (needs profile:manage). Without it, profile grants are not listed.',
				),
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
				if (args.subject_type === 'profile') {
					const resourceIds = args.resource_id
						? new Set(
								legacyFamily
									? await findCredentialIdsByLegacyName(db, request.org.id, {
											type: legacyFamily,
											name: args.resource_id,
										})
									: [args.resource_id],
							)
						: null
					const profiles = await listProfiles(
						await requireProfilesCaller(ctx),
						{
							allMembers: false,
						},
					)
					return {
						grants: profiles
							.filter(
								(profile) => !args.subject_id || profile.id === args.subject_id,
							)
							.flatMap((profile) =>
								profile.grants.flatMap((grant) => {
									if (resourceType && grant.resourceType !== resourceType)
										return []
									if (resourceIds && !resourceIds.has(grant.resourceId))
										return []
									if (
										legacyFamily &&
										!grant.permissions.some((permission) =>
											permission.startsWith(`${legacyFamily}:`),
										)
									)
										return []
									const payload = profileGrantPayload(profile.id, grant)
									return payload ? [payload] : []
								}),
							),
					}
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

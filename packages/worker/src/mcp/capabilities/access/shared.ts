import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	grantPresets,
	resolveGrantPermissions,
	type GrantPreset,
} from '@kody-internal/shared/grant-presets.ts'
import {
	isOrgPermission,
	type OrgPermission,
	type OrgResourceType,
} from '@kody-internal/shared/org-permissions.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	authorize,
	computeEffectivePermissions,
	type OrgResource,
} from '#worker/authorization/authorize.ts'
import {
	credentialPermissionFamily,
	credentialResource,
	findCredentialIdsByLegacyName,
	getOrgCredential,
	legacyNamedCredentialTargets,
} from '#worker/credentials/credential-ids.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import {
	isGrantResourceType,
	type GrantResourceType,
	type GrantView,
	grantResourceTypes,
	grantSubjectTypes,
	GrantSubjectScopeError,
	OrgSlugValidationError,
} from '#worker/orgs/access-writes.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { assertMemoryGrantsAllowedOnOrg } from '#mcp/memory/memory-owner.ts'

export const grantPresetSchema = z.enum(grantPresets)

export const grantResourceTypeSchema = z.enum(grantResourceTypes)

export const grantTargetTypeSchema = z.enum([
	...grantResourceTypes,
	...legacyNamedCredentialTargets,
])

type GrantTargetType = z.infer<typeof grantTargetTypeSchema>

/**
 * Resolves a by-name credential target to its credential id, so
 * the grant is stored under `credential`. A name that names more than one
 * credential is refused rather than narrowed to one of them.
 */
export async function resolveGrantTarget(
	ctx: CapabilityContext,
	target: { type: GrantTargetType; id: string },
): Promise<{ resourceType: GrantResourceType; resourceId: string }> {
	switch (target.type) {
		case 'secret':
		case 'integration': {
			const request = requireMcpRequest(ctx.callerContext)
			const credentialIds = await findCredentialIdsByLegacyName(
				ctx.env.APP_DB,
				request.org.id,
				{ type: target.type, name: target.id },
			)
			const [credentialId, ...others] = credentialIds
			if (!credentialId) {
				throw new McpCallerError(
					`No ${target.type} named "${target.id}" in this organization. Pass resource_type credential with the credential_id from secretList, integrationList, mcpServerList, or secretProviderList.`,
				)
			}
			if (others.length > 0) {
				throw new McpCallerError(
					`${target.id} names more than one integration; pass resource_type credential with the credential_id from integrationList or mcpServerList.`,
				)
			}
			return { resourceType: 'credential', resourceId: credentialId }
		}
		default:
			return { resourceType: target.type, resourceId: target.id }
	}
}

export const orgRoleSchema = z.enum(['owner', 'member', 'billing'])

export const accessGrantSchema = z.object({
	id: z.string(),
	resource_type: grantResourceTypeSchema,
	resource_id: z.string(),
	subject_type: z.enum(grantSubjectTypes),
	subject_id: z.string(),
	preset: grantPresetSchema.nullable(),
	permissions: z.array(z.string()),
	expires_at: z
		.string()
		.nullable()
		.describe('When the grant stops counting (ISO). Null never expires.'),
	allow_changes_despite_unmappable_credentials: z
		.boolean()
		.describe(
			'True when an org Owner let this subject change or publish the package even while it has unmappable credentials.',
		),
})

export const inviteSchema = z.object({
	id: z.string(),
	org_id: z.string(),
	org_slug: z.string(),
	kind: z.enum(['membership', 'grant']),
	role: orgRoleSchema.nullable(),
	team_ids: z.array(z.string()),
	resource_type: grantResourceTypeSchema.nullable(),
	resource_id: z.string().nullable(),
	preset: grantPresetSchema.nullable(),
	permissions: z.array(z.string()).nullable(),
	invitee_email: z.string().nullable(),
	invitee_username: z.string().nullable(),
	status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
	expires_at: z.string(),
})

function readStoredPreset(
	value: string | null,
	grantId: string,
): GrantPreset | null {
	if (value === null) return null
	if ((grantPresets as ReadonlyArray<string>).includes(value)) {
		return value as GrantPreset
	}
	throw new Error(`Grant ${grantId} has preset ${value}.`)
}

export function toAccessGrantPayload(grant: GrantView) {
	if (!isGrantResourceType(grant.resourceType)) {
		throw new Error(
			`Grant ${grant.id} has resource type ${grant.resourceType}.`,
		)
	}
	const preset = readStoredPreset(grant.preset, grant.id)
	return {
		id: grant.id,
		resource_type: grant.resourceType,
		resource_id: grant.resourceId,
		subject_type: grant.subjectType,
		subject_id: grant.subjectId,
		preset,
		permissions: grant.permissions,
		expires_at: grant.expiresAt,
		allow_changes_despite_unmappable_credentials:
			grant.allowUnmappableCredentialChanges,
	}
}

export function rethrowAccessError(error: unknown): never {
	if (error instanceof McpCallerError) throw error
	if (
		error instanceof OrgSlugValidationError ||
		error instanceof GrantSubjectScopeError ||
		error instanceof FreeOrgLimitError
	) {
		throw new McpCallerError(error.message)
	}
	if (error instanceof Error) {
		if (
			/UNIQUE constraint failed: (handles\.handle|orgs\.slug)/.test(
				error.message,
			)
		) {
			throw new McpCallerError('That organization slug is already taken.')
		}
		if (/UNIQUE constraint failed: teams/.test(error.message)) {
			throw new McpCallerError(
				'That team slug is already taken in this organization.',
			)
		}
		if (error.message === 'cannot_remove_last_owner') {
			throw new McpCallerError('The last Owner cannot be removed.')
		}
		if (error.message === 'member_not_found') {
			throw new McpCallerError(
				'That person is not a member of this organization.',
			)
		}
		console.error('access-change-failed', error)
	}
	throw new McpCallerError('Access change failed.')
}

export async function requireOrgPermission(
	ctx: CapabilityContext,
	permission: OrgPermission,
) {
	const user = requireMcpUser(ctx.callerContext)
	const request = requireMcpRequest(ctx.callerContext)
	await authorize({ env: ctx.env, request }, permission)
	return { user, request, db: ctx.env.APP_DB }
}

function manageAccessPermission(resourceType: OrgResourceType): OrgPermission {
	switch (resourceType) {
		case 'package':
			return 'package:manage_access'
		case 'app':
			return 'app:manage_access'
		case 'job':
			return 'job:manage_access'
		case 'secret':
			return 'secret:manage_access'
		case 'integration':
			return 'integration:manage_access'
		case 'memory':
			return 'memory:manage_access'
		case 'email':
			return 'email:manage_access'
		case 'execution_context':
			return 'execution_context:manage_access'
		default: {
			const exhaustive: never = resourceType
			throw new Error(`Unhandled resource type: ${String(exhaustive)}`)
		}
	}
}

type GrantTargetCheck = {
	family: OrgResourceType | 'org'
	permission: OrgPermission
	resource?: OrgResource
}

/**
 * What `authorizeGrantTarget` / `authorizeGrantRevoke` need. HTTP handlers
 * pass the signed-in app user and request; MCP passes a capability context.
 */
type GrantChangeContext = {
	env: Env
	callerContext: {
		user?: McpCallerContext['user']
		request: McpCallerContext['request']
	}
}

async function grantTargetCheck(
	ctx: GrantChangeContext,
	orgId: OwnerId,
	resourceType: GrantResourceType,
	resourceId: string,
	purpose: 'grant' | 'revoke',
): Promise<GrantTargetCheck> {
	switch (resourceType) {
		case 'org':
			if (resourceId !== orgId) {
				throw new McpCallerError(
					'An org grant uses this organization id as resource_id.',
				)
			}
			return { family: 'org', permission: 'member:write' }
		case 'credential': {
			const credential = await getOrgCredential(
				ctx.env.APP_DB,
				orgId,
				resourceId,
			)
			if (!credential || (purpose === 'grant' && !credential.live)) {
				if (purpose === 'revoke') {
					// The credential is gone, so its family is unknown: revoking a
					// leftover grant needs the organization-level access permission.
					return { family: 'org', permission: 'member:write' }
				}
				throw new McpCallerError(
					'Credential was not found in this organization. Pass the credential_id from secretList, integrationList, mcpServerList, or secretProviderList.',
				)
			}
			const family = credentialPermissionFamily(credential.kind)
			return {
				family,
				permission: manageAccessPermission(family),
				resource: credentialResource(orgId, credential),
			}
		}
		case 'execution_context':
			// Adding run access to someone's machine goes through
			// executionContextShareSet, which only the operator or a Manage
			// holder may call (decision 13b). Removing a share stays here.
			if (purpose === 'grant') {
				throw new McpCallerError(
					'Share an execution context with executionContextShareSet; accessGrant does not add execution context grants.',
				)
			}
			return {
				family: resourceType,
				permission: manageAccessPermission(resourceType),
				resource: { type: resourceType, id: resourceId, orgId },
			}
		case 'package':
		case 'app':
		case 'job':
		case 'memory':
		case 'email':
			return {
				family: resourceType,
				permission: manageAccessPermission(resourceType),
				resource: {
					type: resourceType,
					id: resourceId,
					orgId,
				},
			}
		default: {
			const exhaustive: never = resourceType
			throw new Error(`Unhandled grant resource type: ${String(exhaustive)}`)
		}
	}
}

/**
 * Check the permission that allows changing who can use a resource, and
 * return the permission family its grants resolve against. Organization
 * grants use member:write; every other type uses manage_access on that
 * resource. A credential must exist and be live in the organization.
 */
export async function authorizeGrantTarget(
	ctx: GrantChangeContext,
	resourceType: GrantResourceType,
	resourceId: string,
) {
	return await authorizeGrantChange(ctx, resourceType, resourceId, 'grant')
}

/**
 * Like `authorizeGrantTarget`, for revoking. A grant on a credential that no
 * longer exists can still be revoked with member:write.
 */
export async function authorizeGrantRevoke(
	ctx: GrantChangeContext,
	resourceType: GrantResourceType,
	resourceId: string,
) {
	return await authorizeGrantChange(ctx, resourceType, resourceId, 'revoke')
}

async function authorizeGrantChange(
	ctx: GrantChangeContext,
	resourceType: GrantResourceType,
	resourceId: string,
	purpose: 'grant' | 'revoke',
) {
	const user = requireMcpUser(ctx.callerContext)
	const request = requireMcpRequest(ctx.callerContext)
	if (purpose === 'grant' && resourceType === 'memory') {
		await assertMemoryGrantsAllowedOnOrg(ctx.env.APP_DB, request.org.id)
	}
	const check = await grantTargetCheck(
		ctx,
		request.org.id,
		resourceType,
		resourceId,
		purpose,
	)
	await authorize({ env: ctx.env, request }, check.permission, check.resource)
	return { user, request, db: ctx.env.APP_DB, family: check.family }
}

/**
 * Org-level permissions only an Owner may put on an org grant. org:write and
 * org:delete would let a delegate elevate past Owner; member:write would let a
 * delegate re-delegate; member:delete is an Owner-held control a member:write
 * holder must not hand out (to anyone, including themselves). billing:* never
 * appears here because it is not grantable on an org grant at all.
 */
const ownerOnlyOrgGrantPermissions: ReadonlySet<OrgPermission> =
	new Set<OrgPermission>([
		'org:delete',
		'org:write',
		'member:write',
		'member:delete',
	])

/**
 * Whether a grant hands out or takes away member or billing permissions. Only
 * an organization grant can, and that change needs a live person. Organization
 * grants take only an explicit permission list (presets do not apply to them).
 */
export function grantChangesMemberOrBilling(input: {
	resourceType: string
	permissions: ReadonlyArray<string> | null | undefined
}): boolean {
	if (input.resourceType !== 'org') return false
	return (input.permissions ?? []).some(
		(permission) =>
			permission.startsWith('member:') || permission.startsWith('billing:'),
	)
}

/**
 * Resolve grant permissions for a resource, and require an Owner when an
 * organization grant includes any of `ownerOnlyOrgGrantPermissions`.
 */
export async function resolveAuthorizedGrantPermissions(
	ctx: GrantChangeContext,
	input: {
		family: OrgResourceType | 'org'
		preset?: GrantPreset | null
		permissions: Array<OrgPermission> | null
	},
) {
	let permissions: ReadonlyArray<OrgPermission>
	try {
		permissions = resolveGrantPermissions({
			family: input.family,
			preset: input.preset ?? null,
			permissions: input.permissions,
		})
	} catch (error) {
		throw new McpCallerError(
			error instanceof Error ? error.message : 'Invalid grant permissions.',
		)
	}
	if (input.family !== 'org') return permissions
	const ownerOnly = permissions.filter((permission) =>
		ownerOnlyOrgGrantPermissions.has(permission),
	)
	if (ownerOnly.length === 0) return permissions
	const request = requireMcpRequest(ctx.callerContext)
	const access = await computeEffectivePermissions({
		env: ctx.env,
		request,
	})
	if (!access.isOwner) {
		throw new McpCallerError(
			`Only an Owner can grant ${ownerOnly.join(', ')} on an organization.`,
		)
	}
	return permissions
}

export function readPermissionList(values: Array<string> | undefined) {
	if (!values) return null
	return values.map((value) => {
		if (!isOrgPermission(value)) {
			throw new McpCallerError(`Unknown permission "${value}".`)
		}
		return value
	})
}

export function requirePresetOrPermissions(input: {
	preset?: GrantPreset
	permissions: Array<OrgPermission> | null
}) {
	if (input.preset && input.permissions && input.permissions.length > 0) {
		throw new McpCallerError('Pass a preset or a permission list, not both.')
	}
	if (!input.preset && (!input.permissions || input.permissions.length === 0)) {
		throw new McpCallerError('Pass a preset or a permission list.')
	}
}

export async function requireLiveOrg(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT id, slug, display_name
			 FROM orgs
			 WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<{ id: string; slug: string; display_name: string | null }>()
	if (!row) throw new McpCallerError('Organization was not found.')
	return row
}

export async function resolvePersonId(
	db: D1Database,
	input: { userId?: string | null; username?: string | null },
) {
	const userId = input.userId?.trim() ?? ''
	const username = input.username?.trim() ?? ''
	if (userId && username) {
		throw new McpCallerError('Pass user_id or username, not both.')
	}
	if (userId) return userId
	if (!username) throw new McpCallerError('Pass user_id or username.')
	const normalized = normalizeUsername(username)
	const formatError = getUsernameFormatValidationError(normalized)
	if (formatError) throw new McpCallerError(formatError)
	const row = await db
		.prepare(
			`SELECT stable_user_id FROM users WHERE username = ?${andLiveDeletedAtSql()}`,
		)
		.bind(normalized)
		.first<{ stable_user_id: string }>()
	if (!row?.stable_user_id) {
		throw new McpCallerError(`No user named "${normalized}".`)
	}
	return row.stable_user_id
}

export async function resolveTeamId(
	db: D1Database,
	orgId: string,
	input: { teamId?: string | null; teamSlug?: string | null },
) {
	const teamId = input.teamId?.trim() ?? ''
	const teamSlug = input.teamSlug?.trim() ?? ''
	if (teamId && teamSlug) {
		throw new McpCallerError('Pass team_id or team_slug, not both.')
	}
	if (teamId) {
		const row = await db
			.prepare(
				`SELECT id FROM teams
				 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
			)
			.bind(teamId, orgId)
			.first<{ id: string }>()
		if (!row) {
			throw new McpCallerError('Team was not found in this organization.')
		}
		return row.id
	}
	if (!teamSlug) throw new McpCallerError('Pass team_id or team_slug.')
	const slug = normalizeUsername(teamSlug)
	const formatError = getUsernameFormatValidationError(slug)
	if (formatError) throw new McpCallerError(formatError)
	const row = await db
		.prepare(
			`SELECT id FROM teams
			 WHERE org_id = ? AND slug = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, slug)
		.first<{ id: string }>()
	if (!row) {
		throw new McpCallerError('Team was not found in this organization.')
	}
	return row.id
}

export function generateInviteToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

export async function hashInviteToken(token: string) {
	return await sha256Hex(token.trim())
}

export function inviteAcceptPrompt(input: { orgSlug: string; token: string }) {
	return `You are invited to the ${input.orgSlug} organization. Call inviteAccept with this token: ${input.token}. The token is shown once and cannot be looked up later.`
}

export function inviteLinkAcceptPrompt(input: {
	orgSlug: string
	token: string
	url?: string
}) {
	return `Shareable invite link for the ${input.orgSlug} organization. Recipients open ${input.url ?? `/join/${input.token}`} or call inviteLinkAccept with this token: ${input.token}. The credential is shown once; Kody stores only a hash.`
}

export function optionalInviteeEmail(value: string | undefined) {
	if (!value) return null
	const email = normalizeEmailAddress(value)
	if (!email) throw new McpCallerError('Email must be a valid email address.')
	return email
}

export function optionalInviteeUsername(value: string | undefined) {
	if (!value) return null
	const username = normalizeUsername(value)
	const formatError = getUsernameFormatValidationError(username)
	if (formatError) throw new McpCallerError(formatError)
	return username
}

/**
 * Shared personal-memory owner resolution for metaMemory* capabilities.
 * Surface orgPermission is `none` so team-org connections can invoke; handlers
 * authorize against the personal org and store under that owner id (ADR 0072).
 */
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import type {
	OwnerId,
	PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	authorize,
	loadResourceListScope,
	orgResource,
	type ResourceListScope,
} from '#worker/authorization/authorize.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	personalMemoryOwnerId,
	personalMemoryOwnerRequest,
} from '#mcp/memory/memory-owner.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { requireMcpRequest, requireMcpUser } from './require-user.ts'

export const memoryPersonalOnlyOrgPermission = 'none' as const

export const memoryRequiresPersonActorMessage =
	'Memory is personal-only and needs a person actor. Team-owned background jobs without an enablement actor cannot read or write personal memory.'

export type PersonalMemoryAuth = {
	userId: OwnerId
	request: RequestContext
	email: string
}

/**
 * Prefer the verified request actor (job enabler / OAuth person) over the MCP
 * user id. Team-owned background jobs use a synthetic MCP user whose id is the
 * team org; their actor is the enabling person.
 */
export function resolvePersonalMemoryPersonId(
	ctx: CapabilityContext,
): PersonId {
	const user = requireMcpUser(ctx.callerContext)
	const bound = requireMcpRequest(ctx.callerContext)
	if (bound.actor?.userId) return bound.actor.userId
	// Team synthetic background users reuse the org id and have no email
	// (`resolveBackgroundMcpUser`). Without an actor there is no person to own
	// personal memory.
	if (
		(bound.org.id as string) === (user.userId as string) &&
		user.email === ''
	) {
		throw new McpCallerError(memoryRequiresPersonActorMessage)
	}
	return user.userId
}

export function requirePersonalMemoryAuth(
	ctx: CapabilityContext,
): PersonalMemoryAuth {
	const user = requireMcpUser(ctx.callerContext)
	const bound = requireMcpRequest(ctx.callerContext)
	const personId = resolvePersonalMemoryPersonId(ctx)
	const request = personalMemoryOwnerRequest({
		request: bound,
		userId: personId,
		personalOrgId: user.personalOrgId,
	})
	return {
		userId: personalMemoryOwnerId({
			userId: personId,
			personalOrgId: user.personalOrgId,
		}),
		request,
		// May be empty for team synthetic MCP users; authorizePersonalMemory
		// loads the acting person's email before entitlement checks.
		email: user.email,
	}
}

async function loadPersonEmail(
	db: D1Database | undefined,
	personOwnerId: OwnerId,
): Promise<string | null> {
	if (!db) return null
	try {
		const row = await db
			.prepare(
				`SELECT email FROM users
				 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(personOwnerId)
			.first<{ email: string | null }>()
		return row?.email ?? null
	} catch {
		return null
	}
}

export async function authorizePersonalMemory(
	ctx: CapabilityContext,
	permission: OrgPermission,
	memoryId?: string,
): Promise<PersonalMemoryAuth> {
	const auth = requirePersonalMemoryAuth(ctx)
	const user = requireMcpUser(ctx.callerContext)
	const personId = resolvePersonalMemoryPersonId(ctx)
	const actorDiffersFromMcpUser =
		(personId as string) !== (user.userId as string)
	// When memory is owned by the request actor (team job enabler), never use
	// the synthetic MCP user's email for entitlements.
	const email = actorDiffersFromMcpUser
		? (await loadPersonEmail(ctx.env.APP_DB, auth.userId)) || ''
		: auth.email || (await loadPersonEmail(ctx.env.APP_DB, auth.userId)) || ''
	const resolved: PersonalMemoryAuth = { ...auth, email }
	await authorize(
		{ env: ctx.env, request: resolved.request },
		permission,
		memoryId ? orgResource(resolved.request, 'memory', memoryId) : undefined,
	)
	return resolved
}

export async function personalMemoryReadScope(
	ctx: CapabilityContext,
): Promise<{ auth: PersonalMemoryAuth; scope: ResourceListScope }> {
	const auth = await authorizePersonalMemory(ctx, 'memory:read')
	const scope = await loadResourceListScope(
		{ env: ctx.env, request: auth.request },
		'memory:read',
		'memory',
	)
	return { auth, scope }
}

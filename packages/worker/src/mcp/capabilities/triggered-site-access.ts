import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import type { NonInteractiveTrigger } from '#worker/authorization/authorize.ts'
import { getActiveStableUserRolesAndPermissions } from '#worker/identity/permissions-db.ts'
import { userHasPermission, userHasRole } from '#universal/permissions.ts'
import {
	type McpAuthDenialReason,
	recordMcpAuthDenial,
} from '#mcp/auth-audit.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import type { Capability } from './types.ts'

type SiteAccessRequirement = Pick<
	Capability,
	'name' | 'requiredRole' | 'requiredPermission'
>

/**
 * Who a deferred site-admin check and audit row name. Enablement-backed
 * triggers reuse {@link NonInteractiveTrigger}; background `jobRunNow` (live
 * person credential, org MCP user) is `run-now`.
 */
export type SiteAccessActorTrigger =
	| NonInteractiveTrigger
	| { type: 'run-now'; credentialId: string | null }

/** Site-admin capabilities: a site role or permission gates them. */
export function requiresSiteAccess(capability: SiteAccessRequirement): boolean {
	return Boolean(capability.requiredRole || capability.requiredPermission)
}

/**
 * A site-admin capability called from a run whose MCP user is not the acting
 * person (team-org schedule/webhook/email, or team-org `jobRunNow`) acts for
 * `request.actor`. That person must hold the role or permission in D1 right
 * now: the caller's roles are cached and belong to the org's identity, not
 * the enabler or clicker.
 */
export async function assertTriggeredRunCanAccessSiteCapability(input: {
	env: Env
	callerContext: McpCallerContext
	capability: SiteAccessRequirement
	trigger: SiteAccessActorTrigger
}): Promise<void> {
	const { capability, trigger } = input
	const actor = input.callerContext.request?.actor
	const access = actor
		? await getActiveStableUserRolesAndPermissions(
				input.env.APP_DB,
				String(actor.userId),
			)
		: null
	const denial = describeDenial(access, capability, trigger)
	if (!denial) return
	await recordMcpAuthDenial({
		db: auditDatabaseFromEnv(input.env),
		action: 'mcp_capability_denied',
		reason: denial.reason,
		email: input.callerContext.user?.email,
		path: capability.name,
	})
	throw new Error(denial.message)
}

function describeDenial(
	access: Awaited<ReturnType<typeof getActiveStableUserRolesAndPermissions>>,
	capability: SiteAccessRequirement,
	trigger: SiteAccessActorTrigger,
): { reason: McpAuthDenialReason; message: string } | null {
	const run =
		trigger.type === 'run-now' ? 'This run-now' : `This ${trigger.type} run`
	if (!access) {
		return {
			reason: 'no_user',
			message: `${run} acts for no active person, so it cannot call site-admin capability "${capability.name}".`,
		}
	}
	if (
		capability.requiredRole &&
		!userHasRole(access, capability.requiredRole)
	) {
		return {
			reason: 'role',
			message: `${run} acts for a person who lacks required role "${capability.requiredRole}" for capability "${capability.name}".`,
		}
	}
	if (
		capability.requiredPermission &&
		!userHasPermission(access, capability.requiredPermission)
	) {
		return {
			reason: 'permission',
			message: `${run} acts for a person who lacks required permission "${capability.requiredPermission}" for capability "${capability.name}".`,
		}
	}
	return null
}

/**
 * Email for the deferred site-admin wrapper audit row. Team-org background
 * callers have an empty org email; prefer that when set, otherwise the
 * actor's live users.email so email-hash filters find the clicker/enabler.
 */
async function resolveTriggeredSiteAuditEmail(
	env: Env,
	callerContext: McpCallerContext,
): Promise<string | undefined> {
	const callerEmail = callerContext.user?.email?.trim()
	if (callerEmail) return callerEmail
	const actorId = callerContext.request?.actor?.userId
	if (!actorId || !env.APP_DB) return undefined
	const row = await env.APP_DB.prepare(
		`SELECT email FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(String(actorId))
		.first<{ email: string }>()
	const actorEmail = row?.email?.trim()
	return actorEmail || undefined
}

/**
 * Run a site-admin capability called from a deferred actor-gated run and
 * record one `admin` audit row naming the trigger. `run` covers input
 * validation through output validation; the row's result says whether it
 * returned or threw. A capability that reports a failure in its returned
 * result records that verdict in its own audit row.
 */
export async function auditTriggeredSiteCapabilityCall<TResult>(
	input: {
		env: Env
		callerContext: McpCallerContext
		capabilityName: string
		trigger: SiteAccessActorTrigger
	},
	run: () => Promise<TResult>,
): Promise<TResult> {
	const { callerContext, trigger } = input
	const reason = [
		`trigger=${trigger.type}`,
		`trigger_id=${trigger.credentialId ?? ''}`,
		`actor=${callerContext.request?.actor?.userId ?? ''}`,
		`package_id=${callerContext.storageContext?.packageId ?? ''}`,
	].join(';')
	const email = await resolveTriggeredSiteAuditEmail(input.env, callerContext)
	const audit = (result: 'success' | 'failure', detail?: string) =>
		logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'admin',
			action: input.capabilityName,
			result,
			email,
			path: '/mcp',
			reason: detail ? `${reason};error=${detail}` : reason,
		})
	try {
		const result = await run()
		await audit('success')
		return result
	} catch (error) {
		const message = error instanceof Error ? error.message.trim() : ''
		await audit('failure', message.slice(0, 200) || 'unknown_error')
		throw error
	}
}

import { McpCallerError } from '#mcp/caller-error.ts'
import {
	loadAdminUserByTarget,
	type AdminUserTarget,
} from '#worker/admin/users-data.ts'
import {
	orgAuditWriterForPerson,
	orgAuditWriterFromRequest,
} from '#worker/orgs/org-audit.ts'
import {
	resolveActingAdminPerson,
	type ActingAdminPerson,
} from './admin-shared.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

export function legacyReason(
	capabilityName: string,
	reason?: string,
	note?: string,
) {
	return (
		reason?.trim() ||
		note?.trim() ||
		`No reason given (legacy ${capabilityName})`
	)
}

export async function resolveLegacyPersonalOrg(
	ctx: CapabilityContext,
	target: AdminUserTarget,
) {
	const user = await loadAdminUserByTarget(ctx.env.APP_DB, target)
	if (!user) throw new McpCallerError('User not found.')
	const row = await ctx.env.APP_DB.prepare(
		`SELECT COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) AS org_id
			 FROM users u
			 INNER JOIN orgs o
			   ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
			  AND o.deleted_at IS NULL
			 WHERE u.stable_user_id = ? AND u.deleted_at IS NULL`,
	)
		.bind(user.stableUserId)
		.first<{ org_id: string }>()
	if (!row?.org_id) throw new McpCallerError('Personal organization not found.')
	return { user, orgId: row.org_id }
}

export async function legacyAuditWriter(
	ctx: CapabilityContext,
	admin?: ActingAdminPerson,
) {
	const person = admin ?? (await resolveActingAdminPerson(ctx))
	const audit = ctx.callerContext.request
		? orgAuditWriterFromRequest(ctx.env, ctx.callerContext.request)
		: orgAuditWriterForPerson(ctx.env, {
				userId: person.stableUserId,
				username: person.username,
			})
	return {
		admin: person,
		audit: { ...audit, actorUserId: audit.actorUserId ?? person.stableUserId },
	}
}

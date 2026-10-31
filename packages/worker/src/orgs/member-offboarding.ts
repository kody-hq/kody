/**
 * soft-delete-read-filter: opt-out
 */

import { endMemberExecutionContextLeases } from '#worker/execution-contexts/service.ts'
import { revokeProfilesForMember } from '#worker/profiles/store.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { offboardOrgMember } from '#worker/orgs/offboarding.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import {
	recordOrgAuditEvent,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'

export type MemberSoftRemovedInput = {
	env: Env
	orgId: OwnerId
	userId: string
	deletedAt: string
	/**
	 * When true, a membership already tombstoned at `deletedAt` still revokes
	 * credentials and disconnects own-login integrations.
	 */
	resume?: boolean
	audit: OrgAuditWriter
}

/**
 * Soft-delete membership side effects when a user is removed or leaves:
 * credentials, own-login integrations, and job keep-running (voluntary leave).
 */
/** Membership already tombstoned, if this person was removed from the org. */
export async function readTombstonedOrgMembership(input: {
	db: D1Database
	orgId: OwnerId
	userId: string
}): Promise<{ role: string; deletedAt: string } | null> {
	const row = await input.db
		.prepare(
			`SELECT role, deleted_at FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
		)
		.bind(input.orgId, input.userId)
		.first<{ role: string; deleted_at: string }>()
	if (!row?.deleted_at) return null
	return { role: row.role, deletedAt: row.deleted_at }
}

export async function onMemberSoftRemoved(
	input: MemberSoftRemovedInput,
): Promise<void> {
	const oauthHelpers = (await resolveOAuthHelpers(input.env)) as
		| OAuthGrantHelpers
		| undefined
	await offboardOrgMember({
		appDb: input.env.APP_DB,
		env: input.env,
		orgId: input.orgId,
		memberUserId: input.userId,
		memberLeftVoluntarily: true,
		now: new Date(input.deletedAt),
		oauthHelpers: oauthHelpers ?? null,
		resumeDeletedAt: input.resume ? input.deletedAt : undefined,
	})
	await endMemberExecutionContextLeases(input.env, {
		orgId: input.orgId,
		userId: input.userId,
	})
	// ADR 0092: a member who leaves stops acting through their profiles.
	await revokeProfilesForMember(input.env.APP_DB, {
		orgId: input.orgId,
		userId: input.userId,
		now: input.deletedAt,
	})
	await recordOrgAuditEvent(input.audit, {
		orgId: input.orgId,
		action: 'member.removed',
		targetUserId: input.userId,
		details: { deletedAt: input.deletedAt, resumed: input.resume === true },
	})
}

import {
	memberCreationFromRow,
	type MemberCreationRow,
	type OrgMemberCreation,
} from '#worker/authorization/member-creation-permissions.ts'
import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { runAppDbBatchWithOrgAudit, type OrgAuditWriter } from './org-audit.ts'

export async function loadOrgMemberCreation(
	db: D1Database,
	orgId: string,
): Promise<OrgMemberCreation> {
	const row = await db
		.prepare(
			`SELECT members_can_create_packages, members_can_create_credentials
			 FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<MemberCreationRow>()
	return memberCreationFromRow(row)
}

export type UpdateOrgMemberCreationResult =
	| { ok: true; settings: OrgMemberCreation; changed: boolean }
	| { ok: false; error: string; code: 'not_found' | 'conflict' }

/**
 * Change what Members may create in a team org. The change, the
 * `org.member_creation_changed` audit row, and the access_epoch bump commit
 * together, so every Member's next request sees the new permissions. Applies
 * only over the values it read, so a stale request cannot undo a concurrent
 * change. Callers check `org:write` and that the org is a team org.
 */
export async function updateOrgMemberCreation(
	db: D1Database,
	input: {
		orgId: string
		packages?: boolean
		credentials?: boolean
		audit: OrgAuditWriter
	},
): Promise<UpdateOrgMemberCreationResult> {
	const exists = await db
		.prepare(`SELECT id FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`)
		.bind(input.orgId)
		.first<{ id: string }>()
	if (!exists) {
		return {
			ok: false,
			error: 'Organization was not found.',
			code: 'not_found',
		}
	}
	const previous = await loadOrgMemberCreation(db, input.orgId)
	const next: OrgMemberCreation = {
		packages: input.packages ?? previous.packages,
		credentials: input.credentials ?? previous.credentials,
	}
	if (
		next.packages === previous.packages &&
		next.credentials === previous.credentials
	) {
		return { ok: true, settings: next, changed: false }
	}
	const update = db
		.prepare(
			`UPDATE orgs
			 SET members_can_create_packages = ?,
			     members_can_create_credentials = ?,
			     updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}
			   AND members_can_create_packages = ?
			   AND members_can_create_credentials = ?`,
		)
		.bind(
			next.packages ? 1 : 0,
			next.credentials ? 1 : 0,
			new Date().toISOString(),
			input.orgId,
			previous.packages ? 1 : 0,
			previous.credentials ? 1 : 0,
		)
	const { changed } = await runAppDbBatchWithOrgAudit({
		appDb: db,
		audit: input.audit,
		statements: [
			update,
			bumpAccessEpochStatement(db, input.orgId, {
				onlyIfPreviousChanged: true,
			}),
		],
		onlyIfChanged: true,
		event: {
			orgId: input.orgId,
			action: 'org.member_creation_changed',
			details: {
				members_can_create_packages: next.packages,
				members_can_create_credentials: next.credentials,
				previous_members_can_create_packages: previous.packages,
				previous_members_can_create_credentials: previous.credentials,
			},
		},
	})
	if (!changed) {
		return {
			ok: false,
			error:
				'Member permissions changed while you were editing. Reload and try again.',
			code: 'conflict',
		}
	}
	return { ok: true, settings: next, changed: true }
}

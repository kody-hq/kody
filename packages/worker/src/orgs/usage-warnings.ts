import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { runAppDbBatchWithOrgAudit, type OrgAuditWriter } from './org-audit.ts'

/**
 * Whether the org gets usage warnings: the 80% and 100% usage emails and the
 * once-a-month heads-up on hosted execute responses. Fails open (on) when the
 * row or column is missing so warnings never silently stop.
 */
export async function loadOrgUsageWarningsEnabled(
	db: D1Database,
	orgId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT usage_warnings_enabled FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ usage_warnings_enabled: number | null }>()
	return row?.usage_warnings_enabled !== 0
}

export type UpdateOrgUsageWarningsResult =
	| { ok: true; enabled: boolean; changed: boolean }
	| { ok: false; error: string; code: 'not_found' | 'conflict' }

/**
 * Turn usage warnings on or off for an org (personal or team), audited as
 * `org.usage_warnings_changed`. Applies only over the value it read, so a
 * stale request cannot undo a concurrent change. Callers check `org:write`.
 */
export async function updateOrgUsageWarnings(
	db: D1Database,
	input: { orgId: string; enabled: boolean; audit: OrgAuditWriter },
): Promise<UpdateOrgUsageWarningsResult> {
	const row = await db
		.prepare(
			`SELECT usage_warnings_enabled FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId)
		.first<{ usage_warnings_enabled: number | null }>()
	if (!row) {
		return {
			ok: false,
			error: 'Organization was not found.',
			code: 'not_found',
		}
	}
	const previous = row.usage_warnings_enabled !== 0
	if (previous === input.enabled) {
		return { ok: true, enabled: previous, changed: false }
	}
	const update = db
		.prepare(
			`UPDATE orgs
			 SET usage_warnings_enabled = ?, updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()} AND usage_warnings_enabled = ?`,
		)
		.bind(
			input.enabled ? 1 : 0,
			new Date().toISOString(),
			input.orgId,
			previous ? 1 : 0,
		)
	const { changed } = await runAppDbBatchWithOrgAudit({
		appDb: db,
		audit: input.audit,
		statements: [update],
		onlyIfChanged: true,
		event: {
			orgId: input.orgId,
			action: 'org.usage_warnings_changed',
			details: {
				usage_warnings: input.enabled,
				previous_usage_warnings: previous,
			},
		},
	})
	if (!changed) {
		return {
			ok: false,
			error:
				'Usage warnings changed while you were editing. Reload and try again.',
			code: 'conflict',
		}
	}
	return { ok: true, enabled: input.enabled, changed: true }
}

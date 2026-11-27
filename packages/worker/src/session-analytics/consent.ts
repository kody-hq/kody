import {
	runAppDbBatchWithOrgAudit,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	sessionAnalyticsStates,
	type SessionAnalyticsState,
} from '#universal/session-analytics.ts'
import { deleteOrgSessionAnalyticsStatements } from './store.ts'

function parseState(value: unknown): SessionAnalyticsState {
	return sessionAnalyticsStates.find((state) => state === value) ?? 'unset'
}

/**
 * The org's session analytics choice. Anything but `enabled` means nothing
 * is recorded, so a missing row or column reads as `unset`.
 */
export async function loadOrgSessionAnalyticsState(
	db: D1Database,
	orgId: string,
): Promise<SessionAnalyticsState> {
	const row = await db
		.prepare(
			`SELECT session_analytics FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ session_analytics: string | null }>()
	return parseState(row?.session_analytics)
}

export type UpdateOrgSessionAnalyticsResult =
	| { ok: true; state: SessionAnalyticsState; changed: boolean }
	| { ok: false; error: string; code: 'not_found' | 'conflict' }

/**
 * Turn session analytics on or off for an org, audited as
 * `org.session_analytics_changed`. Turning it off deletes everything session
 * analytics stored for the org in the same batch. Callers check `org:write`.
 */
export async function updateOrgSessionAnalytics(
	db: D1Database,
	input: { orgId: string; enabled: boolean; audit: OrgAuditWriter },
): Promise<UpdateOrgSessionAnalyticsResult> {
	const row = await db
		.prepare(
			`SELECT session_analytics FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId)
		.first<{ session_analytics: string | null }>()
	if (!row) {
		return {
			ok: false,
			error: 'Organization was not found.',
			code: 'not_found',
		}
	}
	const previous = parseState(row.session_analytics)
	const next: SessionAnalyticsState = input.enabled ? 'enabled' : 'declined'
	if (previous === next) {
		// A repeated "off" still deletes, so a retry can never leave rows behind.
		// It deletes only while the org is still off, so it cannot remove rows
		// collected after a concurrent opt-in.
		if (!input.enabled) {
			await db.batch(
				deleteOrgSessionAnalyticsStatements(db, input.orgId, {
					onlyWhenState: previous,
				}),
			)
		}
		return { ok: true, state: previous, changed: false }
	}
	const update = db
		.prepare(
			`UPDATE orgs
			 SET session_analytics = ?, updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()} AND session_analytics = ?`,
		)
		.bind(next, new Date().toISOString(), input.orgId, previous)
	// The deletes run in the same batch as the state change and only when the
	// org still holds the state this change read, so losing a conflict deletes
	// nothing and winning it leaves nothing.
	const deletes = input.enabled
		? []
		: deleteOrgSessionAnalyticsStatements(db, input.orgId, {
				onlyWhenState: previous,
			})
	const { changed } = await runAppDbBatchWithOrgAudit({
		appDb: db,
		audit: input.audit,
		statements: [...deletes, update],
		onlyIfChanged: true,
		event: {
			orgId: input.orgId,
			action: 'org.session_analytics_changed',
			details: {
				session_analytics: next,
				previous_session_analytics: previous,
			},
		},
	})
	if (!changed) {
		return {
			ok: false,
			error:
				'Session analytics changed while you were editing. Reload and try again.',
			code: 'conflict',
		}
	}
	return { ok: true, state: next, changed: true }
}

const callerStates = new WeakMap<object, Promise<boolean>>()

/**
 * Whether the org this caller is bound to opted in. Cached per caller
 * context, so registering several tools for one request reads once.
 */
export function callerOrgSessionAnalyticsEnabled(
	env: Env,
	callerContext: { request: { org: { id: string } } | null },
): Promise<boolean> {
	const orgId = callerContext.request?.org.id
	if (!orgId) return Promise.resolve(false)
	let pending = callerStates.get(callerContext)
	if (!pending) {
		pending = loadOrgSessionAnalyticsState(env.APP_DB, orgId).then(
			(state) => state === 'enabled',
			() => false,
		)
		callerStates.set(callerContext, pending)
	}
	return pending
}

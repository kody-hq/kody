import { requireUserWithRole } from '#app/permissions-server.ts'
import {
	markStuckPatternFixed,
	retireSessionCategory,
} from '#worker/session-analytics/insights.ts'
import type { SessionStuckKind } from '#universal/session-analytics.ts'
import { adminOperationResult } from './operation-result.ts'

/** Record that a stuck pattern was fixed, to compare before and after. */
export async function markAdminSessionPatternFixed(input: {
	env: Env
	request: Request
	fields: { categoryId: string; stuckKind: SessionStuckKind; stuckTool: string }
}) {
	await requireUserWithRole(input.request, input.env, 'admin')
	const now = new Date()
	await markStuckPatternFixed(input.env.APP_DB, {
		...input.fields,
		fixedOn: now.toISOString().slice(0, 10),
		now,
	})
	return adminOperationResult({ ok: true as const })
}

/** Remove a category name and every count stored under it. */
export async function retireAdminSessionCategory(input: {
	env: Env
	request: Request
	fields: { categoryId: string }
}) {
	await requireUserWithRole(input.request, input.env, 'admin')
	await retireSessionCategory(input.env.APP_DB, input.fields.categoryId)
	return adminOperationResult({ ok: true as const })
}

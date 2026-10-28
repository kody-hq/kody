import { isFeatureEnabled } from '#worker/feature-flags/service.ts'

export const executionContextsFlagKey = 'execution-contexts'

/** Fails closed: an unknown person or a flag read error means off. */
export async function isExecutionContextsEnabledFor(
	db: D1Database,
	personId: string,
) {
	try {
		const row = await db
			.prepare(
				`SELECT id FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
			)
			.bind(personId)
			.first<{ id: number }>()
		if (!row) return false
		return await isFeatureEnabled(db, executionContextsFlagKey, row.id)
	} catch {
		return false
	}
}

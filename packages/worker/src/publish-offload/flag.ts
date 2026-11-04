import { publishOffloadFlagKey } from '#universal/feature-flags/registry.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'

/**
 * Fails closed: an unknown person or a flag read error means off.
 */
export async function isPublishOffloadEnabledFor(
	db: D1Database,
	personId: string,
	orgId: string | null,
) {
	try {
		const row = await db
			.prepare(
				`SELECT id FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
			)
			.bind(personId)
			.first<{ id: number }>()
		if (!row) return false
		return await isFeatureEnabled(
			db,
			publishOffloadFlagKey,
			row.id,
			orgId ? { orgId } : null,
		)
	} catch {
		return false
	}
}

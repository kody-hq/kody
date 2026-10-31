import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { profilesFlagKey } from '#universal/feature-flags/registry.ts'

/**
 * Fails closed: an unknown person or a flag read error means off. `orgId` is
 * the request's org context, so a per-org row for that org applies.
 */
export async function isProfilesEnabledFor(
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
			profilesFlagKey,
			row.id,
			orgId ? { orgId } : null,
		)
	} catch {
		return false
	}
}

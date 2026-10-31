import { permissionsForGrantPreset } from '@kody-internal/shared/grant-presets.ts'
import { type CreatedResource } from '#worker/orgs/creator-access.ts'
import { profileStatus } from './rules.ts'
import { loadProfileChain } from './store.ts'

/**
 * A profile that creates something gets `manage` on it (ADR 0092 creator
 * carve-out), alongside the acting person's own creator grant, so nothing is
 * stranded when the profile expires or is revoked. Both are origin `created`,
 * which an org transfer drops. Skips an inactive or foreign profile and any
 * resource the profile already has a live grant on. Idempotent.
 */
export async function grantProfileCreatorAccess(input: {
	db: D1Database
	orgId: string
	profileId: string
	createdByUserId: string
	resources: ReadonlyArray<CreatedResource>
}): Promise<{ granted: number }> {
	const chain = await loadProfileChain(input.db, {
		orgId: input.orgId,
		profileId: input.profileId,
	})
	const self = chain.at(-1)
	if (!self || self.id !== input.profileId) return { granted: 0 }
	if (self.acting_user_id !== input.createdByUserId) return { granted: 0 }
	const now = new Date().toISOString()
	if (profileStatus(chain, now) !== 'active') return { granted: 0 }
	let granted = 0
	for (const resource of input.resources) {
		const live = await input.db
			.prepare(
				`SELECT 1 AS live FROM grants
				 WHERE org_id = ? AND resource_type = ? AND resource_id = ?
				   AND subject_type = 'profile' AND subject_id = ?
				   AND deleted_at IS NULL`,
			)
			.bind(input.orgId, resource.resourceType, resource.resourceId, self.id)
			.first<{ live: number }>()
		if (live) continue
		const family = resource.family ?? resource.resourceType
		if (family === 'credential') continue
		const permissions = permissionsForGrantPreset(family, 'manage')
		const grantId = `grant_${crypto.randomUUID()}`
		try {
			await input.db.batch([
				input.db
					.prepare(
						`INSERT INTO grants (
							id, org_id, resource_type, resource_id, subject_type, subject_id,
							preset, created_by_user_id, created_at, updated_at, origin, expires_at
						) VALUES (?, ?, ?, ?, 'profile', ?, 'manage', ?, ?, ?, 'created', NULL)`,
					)
					.bind(
						grantId,
						input.orgId,
						resource.resourceType,
						resource.resourceId,
						self.id,
						input.createdByUserId,
						now,
						now,
					),
				...permissions.map((permission) =>
					input.db
						.prepare(
							`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
						)
						.bind(grantId, permission),
				),
			])
			granted += 1
		} catch (error) {
			if (String(error).includes('UNIQUE constraint failed')) continue
			throw error
		}
	}
	return { granted }
}

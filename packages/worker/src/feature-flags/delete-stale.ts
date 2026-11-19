import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	deleteStaleFeatureFlag,
	totalStaleFeatureFlagRows,
	type StaleFeatureFlagRowCounts,
} from './service.ts'

/**
 * Deletes every row of a flag key that is no longer in the code registry and
 * records one `feature_flag_delete_stale` audit event. Shared by the admin
 * web Delete button and the `adminFeatureFlagDeleteStale` capability.
 * Returns null when the key had no rows.
 */
export async function deleteStaleFeatureFlagWithAudit(input: {
	env: Env
	key: string
	actorEmail: string
	ip?: string
	path: string
}): Promise<StaleFeatureFlagRowCounts | null> {
	const deleted = await deleteStaleFeatureFlag(input.env.APP_DB, input.key)
	if (totalStaleFeatureFlagRows(deleted) === 0) return null
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'feature_flag_delete_stale',
		result: 'success',
		email: input.actorEmail,
		ip: input.ip,
		path: input.path,
		reason: [
			`key=${input.key}`,
			`global=${deleted.global}`,
			`user_overrides=${deleted.userOverrides}`,
			`org_overrides=${deleted.orgOverrides}`,
			`repo_overrides=${deleted.repoOverrides}`,
		].join(';'),
	})
	return deleted
}

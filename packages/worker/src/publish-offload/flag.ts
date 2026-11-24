import { publishOffloadFlagKey } from '#universal/feature-flags/registry.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { reportHandledError } from '#worker/outbound/typed-failure.ts'
import {
	outboundTimeoutMs,
	withDeadline,
} from '@kody-internal/shared/with-deadline.ts'

/**
 * Fails closed: an unknown person or a flag read error means off.
 */
export async function isPublishOffloadEnabledFor(
	db: D1Database,
	personId: string,
	orgId: string | null,
) {
	try {
		const row = await withDeadline(
			{ label: 'users.publish_offload_flag', timeoutMs: outboundTimeoutMs.d1 },
			() =>
				db
					.prepare(
						`SELECT id FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
					)
					.bind(personId)
					.first<{ id: number }>(),
		)
		if (!row) return false
		return await withDeadline(
			{
				label: 'feature_flags.publish_offload',
				timeoutMs: outboundTimeoutMs.d1,
			},
			() =>
				isFeatureEnabled(
					db,
					publishOffloadFlagKey,
					row.id,
					orgId ? { orgId } : null,
				),
		)
	} catch (error) {
		reportHandledError('publish_offload_flag', error)
		return false
	}
}

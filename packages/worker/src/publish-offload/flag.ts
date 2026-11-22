import { publishOffloadFlagKey } from '#universal/feature-flags/registry.ts'
import { Effect, Option, Schema } from 'effect'
import { D1, fromD1Promise, sql } from '#worker/effect/d1.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'

const UserIdRow = Schema.Struct({ id: Schema.Finite })

/**
 * Fails closed: an unknown person or a flag read error means off.
 */
export const isPublishOffloadEnabledFor = Effect.fn(
	'PublishOffload.flagEnabled',
)(
	function* (personId: string, orgId: string | null) {
		const db = yield* D1
		const row = yield* db.first(
			'users.by_stable_id',
			UserIdRow,
			sql(
				`SELECT id FROM users WHERE stable_user_id = ? AND deleted_at IS NULL`,
				personId,
			),
		)
		if (Option.isNone(row)) return false
		return yield* fromD1Promise('feature_flags.read', () =>
			isFeatureEnabled(
				db.database(),
				publishOffloadFlagKey,
				row.value.id,
				orgId ? { orgId } : null,
			),
		)
	},
	Effect.catchTag('DatabaseError', (error) =>
		Effect.as(
			Effect.logDebug('publish_offload_flag_read_failed', {
				operation: error.operation,
				message: error.message,
			}),
			false,
		),
	),
)

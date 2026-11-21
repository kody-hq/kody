/**
 * soft-delete-read-filter: opt-out
 *
 * The deletion fences (`users.deleting_at`, `orgs.deleting_at`, and the
 * owner's UserMeter tombstone) as Effect functions. `deletion-state.ts` keeps
 * the Promise entry points for callers outside the retention lanes.
 */
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { DateTime, Effect, Option, Schema } from 'effect'
import type { UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import { D1, makeD1, sql } from '#worker/effect/d1.ts'
import { runSlicePromise, type SliceServices } from '#worker/effect/slice.ts'
import { UserMeter } from '#worker/effect/user-meter.ts'

export class DeletionFenceError extends Schema.TaggedError<DeletionFenceError>()(
	'DeletionFenceError',
	{ message: Schema.String },
) {}

export type DeletionFence = {
	readonly leaseCount: number
	readonly blockingLeases: Array<{ holder: string; acquiredAt: string }>
	/** True when this invocation wrote `deleting_at`. */
	readonly created: boolean
	readonly deletingAt: string
}

const StableUserRow = Schema.Struct({
	stable_user_id: Schema.String,
	deleting_at: Schema.NullOr(Schema.String),
})
const StableUserIdRow = Schema.Struct({ stable_user_id: Schema.String })
const UserIdRow = Schema.Struct({ id: Schema.Number })
const DeletingAtRow = Schema.Struct({
	deleting_at: Schema.NullOr(Schema.String),
})

const sqliteNow = (now: Date | undefined) =>
	now
		? Effect.succeed(utcSqliteTimestamp(now))
		: Effect.map(DateTime.now, (current) =>
				utcSqliteTimestamp(DateTime.toDateUtc(current)),
			)

const invalidateOwnerCache = (stableUserId: string) =>
	Effect.sync(() => invalidatePackageAppOwnerCache({ stableUserId }))

/**
 * Sets `users.deleting_at` (the permanent gate, written before any UserMeter
 * call), then the UserMeter tombstone. A fence this call created is rolled
 * back when the tombstone cannot be set, so a concurrent or retrying delete
 * never loses another attempt's fence.
 */
export const markAccountDeleting = Effect.fn(
	'DeletionFence.markAccountDeleting',
)(function* (input: { readonly dbUserId: number; readonly now?: Date }) {
	const db = yield* D1
	const meter = yield* UserMeter
	const now = yield* sqliteNow(input.now)
	yield* Effect.annotateCurrentSpan('kody.db_user_id', input.dbUserId)
	const { changes } = yield* db.run(
		'deletion_fence.mark_account',
		sql(
			`UPDATE users
				SET deleting_at = ?, updated_at = ?
				WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
			now,
			now,
			input.dbUserId,
		),
	)
	const created = changes === 1
	const row = yield* db.first(
		'deletion_fence.read_account',
		StableUserRow,
		sql(
			`SELECT stable_user_id, deleting_at
				FROM users
				WHERE id = ?${andLiveDeletedAtSql()}`,
			input.dbUserId,
		),
	)
	if (
		Option.isNone(row) ||
		!row.value.stable_user_id ||
		!row.value.deleting_at
	) {
		return yield* new DeletionFenceError({
			message: 'Account could not be marked for deletion.',
		})
	}
	const stableUserId = row.value.stable_user_id as OwnerId
	const deletingAt = row.value.deleting_at
	yield* invalidateOwnerCache(stableUserId)
	const marked = yield* meter.markDeleting(stableUserId, deletingAt).pipe(
		Effect.tapError(() =>
			created
				? db
						.run(
							'deletion_fence.rollback_account',
							sql(
								`UPDATE users
									SET deleting_at = NULL, updated_at = ?
									WHERE id = ? AND deleting_at = ?${andLiveDeletedAtSql()}`,
								now,
								input.dbUserId,
								now,
							),
						)
						.pipe(Effect.andThen(invalidateOwnerCache(stableUserId)))
				: Effect.void,
		),
	)
	yield* Effect.logInfo('account deletion fence set', { created, deletingAt })
	return {
		leaseCount: marked.leaseCount,
		blockingLeases: marked.blockingLeases ?? [],
		created,
		deletingAt,
	} satisfies DeletionFence
})

/**
 * Undo {@link markAccountDeleting} when deletion aborts before cleanup. With
 * `expectedDeletingAt` only that exact fence is cleared.
 */
export const abortAccountDeleting = Effect.fn(
	'DeletionFence.abortAccountDeleting',
)(function* (input: {
	readonly dbUserId: number
	readonly now?: Date
	readonly expectedDeletingAt?: string
}) {
	const db = yield* D1
	const meter = yield* UserMeter
	const row = yield* db.first(
		'deletion_fence.read_account_owner',
		StableUserIdRow,
		sql(
			`SELECT stable_user_id
				FROM users
				WHERE id = ?${andLiveDeletedAtSql()}`,
			input.dbUserId,
		),
	)
	const now = yield* sqliteNow(input.now)
	const { changes } = yield* db.run(
		'deletion_fence.clear_account',
		input.expectedDeletingAt
			? sql(
					`UPDATE users
						SET deleting_at = NULL, updated_at = ?
						WHERE id = ? AND deleting_at = ?${andLiveDeletedAtSql()}`,
					now,
					input.dbUserId,
					input.expectedDeletingAt,
				)
			: sql(
					`UPDATE users
						SET deleting_at = NULL, updated_at = ?
						WHERE id = ?${andLiveDeletedAtSql()}`,
					now,
					input.dbUserId,
				),
	)
	if ((!input.expectedDeletingAt && changes !== 1) || Option.isNone(row)) {
		return yield* new DeletionFenceError({
			message: 'Account deletion fence could not be cleared.',
		})
	}
	const stableUserId = row.value.stable_user_id as OwnerId
	yield* meter.clearDeleting(stableUserId, input.expectedDeletingAt)
	yield* invalidateOwnerCache(stableUserId)
	yield* Effect.logInfo('account deletion fence cleared')
})

/** Operator entry: resolves `users.id` from `stable_user_id`. */
export const abortAccountDeletingByStableUserId = Effect.fn(
	'DeletionFence.abortAccountDeletingByStableUserId',
)(function* (input: { readonly stableUserId: OwnerId; readonly now?: Date }) {
	const db = yield* D1
	const row = yield* db.first(
		'deletion_fence.find_user',
		UserIdRow,
		sql(
			`SELECT id
			FROM users
			WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
			input.stableUserId,
		),
	)
	if (Option.isNone(row)) {
		return yield* new DeletionFenceError({ message: 'User not found.' })
	}
	yield* abortAccountDeleting({ dbUserId: row.value.id, now: input.now })
})

/**
 * Drop a UserMeter deletion tombstone without touching D1. Completed account
 * deletion runs this after the user row is gone so the purged object keeps
 * no state.
 */
export const clearUserMeterDeletionTombstone = Effect.fn(
	'DeletionFence.clearUserMeterDeletionTombstone',
)(function* (input: { readonly stableUserId: OwnerId }) {
	const meter = yield* UserMeter
	if (!meter.configured()) return { cleared: false }
	const cleared = yield* meter.clearDeleting(input.stableUserId)
	yield* Effect.logInfo('user meter tombstone cleared', cleared)
	return { cleared: cleared.cleared }
})

/**
 * Fence OwnerId writes under an org before soft-delete sweeps resources: sets
 * `orgs.deleting_at`, then the org-id UserMeter tombstone.
 */
export const markOrgDeleting = Effect.fn('DeletionFence.markOrgDeleting')(
	function* (input: { readonly orgId: OwnerId; readonly now?: Date }) {
		const db = yield* D1
		const meter = yield* UserMeter
		const now = yield* sqliteNow(input.now)
		yield* Effect.annotateCurrentSpan('kody.org_id', input.orgId)
		const { changes } = yield* db.run(
			'deletion_fence.mark_org',
			sql(
				`UPDATE orgs
				SET deleting_at = ?, updated_at = ?
				WHERE id = ? AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
				now,
				now,
				input.orgId,
			),
		)
		const created = changes === 1
		const row = yield* db.first(
			'deletion_fence.read_org',
			DeletingAtRow,
			sql(
				`SELECT deleting_at
				FROM orgs
				WHERE id = ?${andLiveDeletedAtSql()}`,
				input.orgId,
			),
		)
		const deletingAt = Option.getOrUndefined(row)?.deleting_at
		if (!deletingAt) {
			return yield* new DeletionFenceError({
				message: 'Organization could not be marked for deletion.',
			})
		}
		yield* invalidateOwnerCache(input.orgId)
		const marked = yield* meter.markDeleting(input.orgId, deletingAt).pipe(
			Effect.tapError(() =>
				created
					? db
							.run(
								'deletion_fence.rollback_org',
								sql(
									`UPDATE orgs
									SET deleting_at = NULL, updated_at = ?
									WHERE id = ? AND deleting_at = ?${andLiveDeletedAtSql()}`,
									now,
									input.orgId,
									deletingAt,
								),
							)
							.pipe(Effect.andThen(invalidateOwnerCache(input.orgId)))
					: Effect.void,
			),
		)
		yield* Effect.logInfo('org deletion fence set', { created, deletingAt })
		return {
			leaseCount: marked.leaseCount,
			blockingLeases: marked.blockingLeases ?? [],
			created,
			deletingAt,
		} satisfies DeletionFence
	},
)

/** Undo {@link markOrgDeleting} when org soft-delete aborts before cleanup. */
export const abortOrgDeleting = Effect.fn('DeletionFence.abortOrgDeleting')(
	function* (input: {
		readonly orgId: OwnerId
		readonly now?: Date
		readonly expectedDeletingAt?: string
	}) {
		const db = yield* D1
		const meter = yield* UserMeter
		const now = yield* sqliteNow(input.now)
		yield* db.run(
			'deletion_fence.clear_org',
			input.expectedDeletingAt
				? sql(
						`UPDATE orgs
						SET deleting_at = NULL, updated_at = ?
						WHERE id = ? AND deleting_at = ?${andLiveDeletedAtSql()}`,
						now,
						input.orgId,
						input.expectedDeletingAt,
					)
				: sql(
						`UPDATE orgs
						SET deleting_at = NULL, updated_at = ?
						WHERE id = ?${andLiveDeletedAtSql()}`,
						now,
						input.orgId,
					),
		)
		yield* meter.clearDeleting(input.orgId, input.expectedDeletingAt)
		yield* invalidateOwnerCache(input.orgId)
		yield* Effect.logInfo('org deletion fence cleared')
	},
)

type FenceEnv = UserMeterEnv & { readonly APP_DB?: D1Database }

/**
 * Promise entry points for callers outside the retention lanes. Each runs on
 * the env's runtime against the `db` the caller names.
 */
const runFence = <A, E>(
	input: { readonly db: D1Database; readonly env: FenceEnv },
	effect: Effect.Effect<A, E, SliceServices>,
) =>
	runSlicePromise(
		input.env as Env,
		effect.pipe(
			Effect.provideService(
				D1,
				makeD1(() => input.db),
			),
		),
	)

type FenceInput<T> = T & { db: D1Database; env: FenceEnv }

export const deletionFenceEdges = {
	markAccountDeleting: (
		input: FenceInput<{ dbUserId: number; now?: Date }>,
	): Promise<DeletionFence> => runFence(input, markAccountDeleting(input)),
	abortAccountDeleting: (
		input: FenceInput<{
			dbUserId: number
			now?: Date
			expectedDeletingAt?: string
		}>,
	): Promise<void> => runFence(input, abortAccountDeleting(input)),
	abortAccountDeletingByStableUserId: (
		input: FenceInput<{ stableUserId: OwnerId; now?: Date }>,
	): Promise<void> =>
		runFence(input, abortAccountDeletingByStableUserId(input)),
	clearUserMeterDeletionTombstone: (input: {
		env: UserMeterEnv
		stableUserId: OwnerId
	}): Promise<{ cleared: boolean }> =>
		runSlicePromise(input.env as Env, clearUserMeterDeletionTombstone(input)),
	markOrgDeleting: (
		input: FenceInput<{ orgId: OwnerId; now?: Date }>,
	): Promise<DeletionFence> => runFence(input, markOrgDeleting(input)),
	abortOrgDeleting: (
		input: FenceInput<{
			orgId: OwnerId
			now?: Date
			expectedDeletingAt?: string
		}>,
	): Promise<void> => runFence(input, abortOrgDeleting(input)),
}

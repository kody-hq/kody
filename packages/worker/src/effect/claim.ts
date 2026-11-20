import {
	Cause,
	Clock,
	Context,
	Effect,
	Exit,
	Option,
	Ref,
	Schema,
	type Scope,
} from 'effect'
import {
	D1,
	type DatabaseError,
	retryTransientD1,
	sql,
} from '#worker/effect/d1.ts'

/**
 * A row claim (a `deleting_at` stamp) held for the rest of the scope. The
 * `settle` policy runs on every exit, success, failure, or interruption, and
 * decides whether the claim is released or kept; it must not fail.
 */
export const scopedClaim = <A, E, R, R2>(
	acquire: Effect.Effect<Option.Option<A>, E, R>,
	settle: (
		claim: A,
		exit: Exit.Exit<unknown, unknown>,
	) => Effect.Effect<void, never, R2>,
): Effect.Effect<Option.Option<A>, E, R | R2 | Scope.Scope> =>
	Effect.acquireRelease(acquire, (claim, exit) =>
		Option.match(claim, {
			onNone: () => Effect.void,
			onSome: (held) => settle(held, exit),
		}),
	)

/** How long a purge claim holds its row; each completed step renews it. */
export const purgeLeaseMs = 15 * 60 * 1000
/** How long a failed attempt keeps its row before another pass may retry. */
export const purgeFailureFenceMs = 24 * 60 * 60 * 1000
/** The failed attempt that blocks a row: no purge lane claims it again. */
export const purgeMaxAttempts = 5

/**
 * The SQL condition (on `users` or `orgs`) for a row a purge lane may claim:
 * not blocked, and past its lease or failure fence. A row no lane has leased
 * yet falls back to the `deleting_at` stamp, so a deletion in flight right
 * now stays fenced. Binds `fenceCutoff` (for `deleting_at`), then `now`.
 */
export const purgeClaimableSql = `purge_attempts < ${purgeMaxAttempts}
	AND CASE WHEN purge_lease_until IS NULL
		THEN deleting_at IS NULL OR datetime(deleting_at) < datetime(?)
		ELSE datetime(purge_lease_until) < datetime(?)
	END`

/** A held lease on one row; `until` is the token renewals are fenced on. */
export type PurgeLease = {
	readonly table: 'orgs' | 'users'
	readonly key: 'id' | 'stable_user_id'
	readonly id: string | number
	/** The pass time plus the time elapsed since the pass started. */
	readonly clock: Effect.Effect<Date>
	readonly until: Ref.Ref<string>
}

/** Another pass took over the row after this pass's lease expired. */
export class PurgeLeaseLostError extends Schema.TaggedError<PurgeLeaseLostError>()(
	'PurgeLeaseLostError',
	{ message: Schema.String },
) {}

/** The lease of the item being purged, renewed between its steps. */
export class PurgeLeaseRenewal extends Context.Service<
	PurgeLeaseRenewal,
	{
		readonly renew: Effect.Effect<void, PurgeLeaseLostError | DatabaseError>
	}
>()('kody/effect/PurgeLeaseRenewal') {}

/**
 * The lane clock: `now` (the pass's reference time, often the scheduled time)
 * advanced by the `Clock` time elapsed since the pass started.
 */
export const startPurgeLeaseClock = (now: Date) =>
	Effect.map(Clock.currentTimeMillis, (startedAt) =>
		Effect.map(
			Clock.currentTimeMillis,
			(at) => new Date(now.getTime() + at - startedAt),
		),
	)

const isoAfter = (at: Date, ms: number) =>
	new Date(at.getTime() + ms).toISOString()

/** The `purge_lease_until` a claim taken on `clock` stamps. */
export const purgeLeaseUntil = (clock: Effect.Effect<Date>) =>
	Effect.map(clock, (at) => isoAfter(at, purgeLeaseMs))

export const makePurgeLease = (
	row: Pick<PurgeLease, 'table' | 'key' | 'id' | 'clock'>,
	until: string,
) => Effect.map(Ref.make(until), (ref): PurgeLease => ({ ...row, until: ref }))

const AttemptsRow = Schema.Struct({ purge_attempts: Schema.Number })

/**
 * Moves the lease to `next` (with `purge_attempts` from `attempts`) if this
 * pass still holds it. Returns the row's attempt count, or none when the
 * lease was taken over.
 */
const moveLease = Effect.fnUntraced(function* (
	lease: PurgeLease,
	operation: 'renew' | 'fail',
	next: string,
) {
	const db = yield* D1
	const row = yield* retryTransientD1(
		db.first(
			`purge_lease.${operation}_${lease.table}`,
			AttemptsRow,
			sql(
				`UPDATE ${lease.table}
				 SET purge_lease_until = ?,
				   purge_attempts = purge_attempts + ?
				 WHERE ${lease.key} = ? AND purge_lease_until = ?
				 RETURNING purge_attempts`,
				next,
				operation === 'fail' ? 1 : 0,
				lease.id,
				yield* Ref.get(lease.until),
			),
		),
	)
	if (Option.isSome(row)) yield* Ref.set(lease.until, next)
	return Option.map(row, (held) => held.purge_attempts)
})

/**
 * Runs one item's purge with its lease renewable (`renewPurgeLease`). A
 * renewal that finds the lease taken over fails with `PurgeLeaseLostError`.
 */
export const withPurgeLease =
	(lane: string, lease: PurgeLease) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const db = yield* D1
			const renew = Effect.flatMap(lease.clock, (at) =>
				moveLease(lease, 'renew', isoAfter(at, purgeLeaseMs)),
			).pipe(
				Effect.provideService(D1, db),
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(
								new PurgeLeaseLostError({
									message: `purge_lease_lost:${lane}`,
								}),
							),
						onSome: () => Effect.void,
					}),
				),
			)
			return yield* Effect.provideService(effect, PurgeLeaseRenewal, { renew })
		})

/**
 * Marks a completed step of the item being purged: extends its lease to
 * now + 15 minutes. A no-op outside a purge lane (user-initiated deletion).
 */
export const renewPurgeLease = Effect.flatMap(
	Effect.serviceOption(PurgeLeaseRenewal),
	Option.match({
		onNone: () => Effect.void,
		onSome: (renewal) => renewal.renew,
	}),
)

/**
 * Settles a purge lease. Success needs nothing: the row is gone. A failure
 * keeps the claim with a 24 hour fence and counts the attempt; the attempt
 * that reaches the limit blocks the row and runs `onBlocked` once. An
 * interruption keeps the lease to expire on its own. Never fails: a fence
 * that cannot be written is logged and the lease expires instead.
 */
export const settlePurgeLease =
	<R>(
		lane: string,
		onBlocked: (
			attempts: number,
			cause: Cause.Cause<unknown>,
		) => Effect.Effect<void, never, R>,
	) =>
	(lease: PurgeLease, exit: Exit.Exit<unknown, unknown>) => {
		if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
			return Effect.logDebug('purge lease settled', { lane, exit: exit._tag })
		}
		return Effect.flatMap(lease.clock, (at) =>
			moveLease(lease, 'fail', isoAfter(at, purgeFailureFenceMs)),
		).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () =>
						Effect.logWarning('purge_lease_lost_before_fence', { lane }),
					onSome: (attempts) =>
						attempts === purgeMaxAttempts
							? onBlocked(attempts, exit.cause)
							: Effect.logDebug('purge failure fenced', { lane, attempts }),
				}),
			),
			Effect.catchTag('DatabaseError', (error) =>
				Effect.logWarning('purge_failure_fence_failed', {
					lane,
					error: error.message,
				}),
			),
		)
	}

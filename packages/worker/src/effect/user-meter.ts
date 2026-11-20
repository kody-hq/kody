import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	userMeterNamespace,
	userMeterRpc,
	type UserMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import { Context, Effect, Layer, Schema } from 'effect'
import { retryDurableObjectReset } from '#worker/effect/durable-object.ts'
import { outbound, OutboundCallError } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

export class UserMeterUnavailableError extends Schema.TaggedError<UserMeterUnavailableError>()(
	'UserMeterUnavailableError',
	{ message: Schema.String },
) {}

const BlockingLease = Schema.Struct({
	holder: Schema.String,
	acquiredAt: Schema.String,
})

const MarkDeletingResponse = Schema.Struct({
	leaseCount: Schema.Number,
	blockingLeases: Schema.optional(Schema.mutable(Schema.Array(BlockingLease))),
})

const ClearDeletingResponse = Schema.Struct({ cleared: Schema.Boolean })

export type UserMeterFailure = UserMeterUnavailableError | OutboundCallError

const unavailable = new UserMeterUnavailableError({
	message: 'USER_METER Durable Object binding is not configured.',
})

/**
 * The deletion tombstone on an owner's UserMeter Durable Object. Calls retry
 * across platform isolate resets and decode the RPC response.
 */
export class UserMeter extends Context.Service<
	UserMeter,
	{
		configured(): boolean
		markDeleting(
			ownerId: OwnerId,
			deletingAt: string,
		): Effect.Effect<typeof MarkDeletingResponse.Type, UserMeterFailure>
		clearDeleting(
			ownerId: OwnerId,
			expectedDeletingAt?: string,
		): Effect.Effect<{ readonly cleared: boolean }, UserMeterFailure>
		purge(ownerId: OwnerId): Effect.Effect<void, UserMeterFailure>
	}
>()('kody/effect/UserMeter') {
	static readonly layer = Layer.effect(
		UserMeter,
		Effect.gen(function* () {
			const env = yield* WorkerEnv
			const configured = () => userMeterNamespace(env) !== null
			const call = <A>(
				operation: string,
				ownerId: OwnerId,
				schema: Schema.Decoder<A>,
				evaluate: (meter: UserMeterRpc) => Promise<unknown>,
			) =>
				configured()
					? retryDurableObjectReset(
							outbound(operation, () =>
								evaluate(userMeterRpc({ env, userId: ownerId })),
							),
						).pipe(
							Effect.flatMap((response) =>
								Schema.decodeUnknownEffect(schema)(response).pipe(
									Effect.mapError(
										(cause) =>
											new OutboundCallError({
												operation,
												reason: 'failed',
												message: `${operation} returned an unexpected response: ${cause.message}`,
												cause,
											}),
									),
								),
							),
						)
					: Effect.fail(unavailable)
			return UserMeter.of({
				configured,
				markDeleting: Effect.fn('UserMeter.markDeleting')(function* (
					ownerId,
					deletingAt,
				) {
					return yield* call(
						'UserMeter.markDeleting',
						ownerId,
						MarkDeletingResponse,
						(meter) => meter.markDeleting({ deletingAt }),
					)
				}),
				clearDeleting: Effect.fn('UserMeter.clearDeleting')(function* (
					ownerId,
					expectedDeletingAt,
				) {
					return yield* call(
						'UserMeter.clearDeleting',
						ownerId,
						ClearDeletingResponse,
						(meter) =>
							meter.clearDeleting(
								expectedDeletingAt ? { expectedDeletingAt } : undefined,
							),
					)
				}),
				purge: Effect.fn('UserMeter.purge')(function* (ownerId) {
					yield* call('UserMeter.purge', ownerId, Schema.Unknown, (meter) =>
						meter.purge(),
					)
				}),
			})
		}),
	)
}

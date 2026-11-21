import { Effect, Layer } from 'effect'
import { AuditLog } from '#worker/effect/audit.ts'
import { D1, makeD1 } from '#worker/effect/d1.ts'
import { observabilityLayer } from '#worker/effect/observability.ts'
import { ErrorReporter } from '#worker/effect/error-reporter.ts'
import { runtimePerEnv } from '#worker/effect/runtime.ts'
import { Stripe } from '#worker/effect/stripe.ts'
import { UserMeter } from '#worker/effect/user-meter.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

/** Everything the retention lanes and account deletion run against. */
export type SliceServices =
	| WorkerEnv
	| D1
	| AuditLog
	| Stripe
	| UserMeter
	| ErrorReporter

export const sliceLayer = (env: Env): Layer.Layer<SliceServices> =>
	Layer.mergeAll(
		AuditLog.layer,
		Stripe.layer,
		UserMeter.layer,
		D1.fromWorkerEnv,
		ErrorReporter.layer,
	).pipe(Layer.provideMerge(WorkerEnv.layer(env)))

/** One runtime per Worker `env`, so per isolate in production. */
export const sliceRuntime = runtimePerEnv(sliceLayer)

/**
 * The Promise edge for callers outside the slice (and the Worker entry
 * point): runs on the env's runtime and rejects with the typed failure.
 */
export const runSlicePromise = <A, E>(
	env: Env,
	effect: Effect.Effect<A, E, SliceServices>,
): Promise<A> => sliceRuntime(env).runPromise(effect)

/**
 * The Promise edge for helpers that take a bare D1 binding (per-table
 * retention batches called by tests and admin tools).
 */
export const runD1Promise = <A, E>(
	database: D1Database,
	effect: (db: D1['Service']) => Effect.Effect<A, E>,
): Promise<A> =>
	Effect.runPromise(
		effect(makeD1(() => database)).pipe(Effect.provide(observabilityLayer)),
	)

import * as Sentry from '@sentry/cloudflare'
import { Context, Effect, Layer } from 'effect'

export type ErrorReport = {
	readonly level?: 'error' | 'warning'
	readonly tags?: Record<string, string>
	readonly contexts?: Record<string, Record<string, unknown>>
	readonly fingerprint?: ReadonlyArray<string>
	/** Report only when a Sentry client with a DSN is initialized. */
	readonly requireDsn?: boolean
}

/**
 * The Worker's Sentry client as a service. A report never fails the caller:
 * a Sentry SDK error is logged and dropped.
 */
export class ErrorReporter extends Context.Service<
	ErrorReporter,
	{
		capture(error: unknown, report: ErrorReport): Effect.Effect<void>
		message(message: string, report: ErrorReport): Effect.Effect<void>
	}
>()('kody/effect/ErrorReporter') {
	static readonly layer = Layer.succeed(
		ErrorReporter,
		ErrorReporter.of({
			capture: Effect.fn('ErrorReporter.capture')(function* (error, report) {
				yield* send(report, () => Sentry.captureException(error))
			}),
			message: Effect.fn('ErrorReporter.message')(function* (message, report) {
				yield* send(report, () => Sentry.captureMessage(message))
			}),
		}),
	)
}

const send = (report: ErrorReport, capture: () => void) =>
	Effect.try(() => {
		if (report.requireDsn) {
			if (!Sentry.isInitialized()) return
			if (!Sentry.getClient()?.getOptions().dsn) return
		}
		Sentry.withScope((scope) => {
			scope.setLevel(report.level ?? 'error')
			for (const [key, value] of Object.entries(report.tags ?? {})) {
				scope.setTag(key, value)
			}
			for (const [key, value] of Object.entries(report.contexts ?? {})) {
				scope.setContext(key, value)
			}
			if (report.fingerprint) scope.setFingerprint([...report.fingerprint])
			capture()
		})
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning('sentry report failed', { error: error.message }),
		),
	)

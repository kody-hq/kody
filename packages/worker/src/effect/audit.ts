import { Context, Effect, Layer } from 'effect'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { type Background, forkBackground } from '#worker/effect/background.ts'

export type AuditEvent = Omit<Parameters<typeof logAuditEvent>[0], 'db'>

/** Audit writes outlive the response, so recording one needs `Background`. */
export class AuditLog extends Context.Service<
	AuditLog,
	{ record(event: AuditEvent): Effect.Effect<void, never, Background> }
>()('kody/effect/AuditLog') {
	static readonly layer = (env: Parameters<typeof auditDatabaseFromEnv>[0]) =>
		Layer.succeed(
			AuditLog,
			AuditLog.of({
				record: (event) =>
					forkBackground(
						'AuditLog.record',
						Effect.tryPromise(() =>
							logAuditEvent({ db: auditDatabaseFromEnv(env), ...event }),
						).pipe(Effect.timeout('10 seconds')),
					).pipe(
						Effect.withSpan('AuditLog.record', {
							attributes: { action: event.action, result: event.result },
						}),
					),
			}),
		)
}

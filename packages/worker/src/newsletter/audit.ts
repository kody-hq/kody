import { Context, Effect, Layer } from 'effect'
import { Background } from '#worker/effect/background.ts'
import {
	auditDatabaseFromEnv,
	logAuditEvent,
	type AuditEventResult,
} from '#worker/audit-log.ts'

export type NewsletterAuditEvent = {
	readonly action: 'newsletter_signup_request' | 'newsletter_signup_confirm'
	readonly result: AuditEventResult
	readonly path: string
	readonly ip: string | undefined
	readonly reason?: string
	readonly email?: string
}

/** Audit trail writes; they run in the background and never fail a request. */
export class NewsletterAudit extends Context.Service<
	NewsletterAudit,
	{ readonly record: (event: NewsletterAuditEvent) => Effect.Effect<void> }
>()('kody/newsletter/NewsletterAudit') {
	static layer(env: Parameters<typeof auditDatabaseFromEnv>[0]) {
		return Layer.effect(
			NewsletterAudit,
			Effect.gen(function* () {
				const background = yield* Background
				const db = auditDatabaseFromEnv(env)
				return NewsletterAudit.of({
					record: (event) =>
						background.fork(
							'NewsletterAudit.record',
							Effect.promise(() =>
								logAuditEvent({ db, category: 'account', ...event }),
							),
						),
				})
			}),
		)
	}
}

import { Effect, Layer } from 'effect'
import { Background } from '#worker/effect/background.ts'
import { D1 } from '#worker/effect/d1.ts'
import { WorkerObservability } from '#worker/effect/observability.ts'
import {
	consentOutboxProducerLayer,
	recordWhatsNewConsentChange as recordConsentChange,
	recordWhatsNewVerifiedAccount as recordVerifiedAccount,
	type ConsentOutboxEnv,
	type WhatsNewConsentSource,
} from './consent-outbox.ts'

// Promise edges for account, admin, and guest flows outside this slice. The
// change is already stored, and a row that could not be enqueued is swept by
// the next one, so these never reject.

function consentOutboxRecorderLayer(env: ConsentOutboxEnv) {
	return consentOutboxProducerLayer(env).pipe(
		Layer.provideMerge(D1.layer(env.APP_DB)),
		Layer.provide(Background.inline),
		Layer.provideMerge(WorkerObservability),
	)
}

export function recordWhatsNewConsentChange(input: {
	env: ConsentOutboxEnv
	stableUserId: string
	optedIn: boolean | null
	source: WhatsNewConsentSource | null
	occurredAt: string
}) {
	const { env, ...change } = input
	return recordConsentChange(change).pipe(
		Effect.catchCause((cause) =>
			Effect.logError('whats-new-consent-outbox-record-failed', cause),
		),
		Effect.provide(consentOutboxRecorderLayer(env)),
		Effect.runPromise,
	)
}

export function recordWhatsNewVerifiedAccount(input: {
	env: ConsentOutboxEnv
	stableUserId: string
}) {
	return recordVerifiedAccount(input.stableUserId).pipe(
		Effect.catchCause((cause) =>
			Effect.logError('whats-new-consent-outbox-record-failed', cause),
		),
		Effect.provide(consentOutboxRecorderLayer(input.env)),
		Effect.runPromise,
	)
}

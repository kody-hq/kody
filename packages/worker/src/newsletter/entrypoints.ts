import { Effect, Layer } from 'effect'
import { Background } from '#worker/effect/background.ts'
import { D1 } from '#worker/effect/d1.ts'
import { WorkerObservability } from '#worker/effect/observability.ts'
import { NewsletterAudit } from './audit.ts'
import {
	ConsentDispatch,
	ConsentOutboxQueue,
	recordWhatsNewConsentChange as recordConsentChange,
	recordWhatsNewVerifiedAccount as recordVerifiedAccount,
	type WhatsNewConsentSource,
} from './consent-outbox.ts'
import { HumanVerification } from './human-verification.ts'
import { NewsletterMailer } from './mailer.ts'
import { RateLimiter } from './rate-limiter.ts'

// One Layer per entrypoint, each built from only the bindings it reads.

export type ConsentOutboxEnv = Omit<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'> &
	Partial<Pick<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'>>

type WaitUntil = (promise: Promise<unknown>) => void

/** The queue producer, or inline delivery where no Queue is bound. */
function consentOutboxProducerLayer(env: ConsentOutboxEnv) {
	const queue = env.PACKAGE_EVENTS_DISPATCH_QUEUE
	return queue
		? ConsentOutboxQueue.queueLayer(queue)
		: ConsentOutboxQueue.inlineLayer.pipe(
				Layer.provide(ConsentDispatch.layer(env)),
			)
}

/** `POST /newsletter` */
export function newsletterSignupLayer(
	env: Parameters<typeof HumanVerification.layer>[0] &
		Parameters<typeof NewsletterMailer.layer>[0] &
		Parameters<typeof NewsletterAudit.layer>[0] &
		Pick<Env, 'APP_DB'>,
	waitUntil: WaitUntil,
) {
	return Layer.mergeAll(
		RateLimiter.layer,
		HumanVerification.layer(env),
		NewsletterMailer.layer(env),
		NewsletterAudit.layer(env),
	).pipe(
		Layer.provideMerge(D1.layer(env.APP_DB)),
		Layer.provide(Background.layer(waitUntil)),
		Layer.provideMerge(WorkerObservability),
	)
}

/** `POST /newsletter/confirm` */
export function newsletterConfirmLayer(
	env: ConsentOutboxEnv,
	waitUntil: WaitUntil,
) {
	const d1 = D1.layer(env.APP_DB)
	const background = Background.layer(waitUntil)
	return Layer.mergeAll(
		NewsletterAudit.layer(env),
		consentOutboxProducerLayer(env),
	).pipe(
		Layer.provideMerge(d1),
		Layer.provide(background),
		Layer.provideMerge(WorkerObservability),
	)
}

/** The `PACKAGE_EVENTS_DISPATCH_QUEUE` consumer for outbox messages. */
export function consentOutboxConsumerLayer(env: Env, waitUntil: WaitUntil) {
	return Layer.mergeAll(D1.layer(env.APP_DB), ConsentDispatch.layer(env)).pipe(
		Layer.provide(Background.layer(waitUntil)),
		Layer.provideMerge(WorkerObservability),
	)
}

function consentOutboxRecorderLayer(env: ConsentOutboxEnv) {
	return consentOutboxProducerLayer(env).pipe(
		Layer.provideMerge(D1.layer(env.APP_DB)),
		Layer.provide(Background.inline),
		Layer.provideMerge(WorkerObservability),
	)
}

// Promise edges for account, admin, and guest flows outside this slice. The
// change is already stored, and a row that could not be enqueued is swept by
// the next one, so these never reject.

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

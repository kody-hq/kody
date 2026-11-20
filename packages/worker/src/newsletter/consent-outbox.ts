import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect'
import {
	type Background,
	runAwaitingBackground,
} from '#worker/effect/background.ts'
import { D1, type DatabaseError, sql } from '#worker/effect/d1.ts'
import { runtimePerBinding } from '#worker/effect/runtime.ts'
import {
	type PackageDispatchFailed,
	PackageSubscribers,
} from '#worker/newsletter/services.ts'

export const whatsNewConsentChangedTopic = 'whats_new.consent.changed'
export const whatsNewConsentOutboxQueueMessageKind = 'whats-new-consent-outbox'

export const WhatsNewConsentSource = Schema.Literals([
	'signup',
	'settings',
	'email_link',
	'admin',
	'newsletter_page',
])
export type WhatsNewConsentSource = typeof WhatsNewConsentSource.Type

/** The one contract for consent queue messages: encoded by the producer, decoded by the consumer. */
export const WhatsNewConsentOutboxQueueMessage = Schema.Struct({
	kind: Schema.Literal(whatsNewConsentOutboxQueueMessageKind),
	outboxId: Schema.Trimmed.check(Schema.isMinLength(1)),
})
export type WhatsNewConsentOutboxQueueMessage =
	typeof WhatsNewConsentOutboxQueueMessage.Type

/** Routing check for a mixed queue: is this body meant for the consent consumer? */
export const isWhatsNewConsentOutboxQueueBody = Schema.is(
	Schema.Struct({
		kind: Schema.Literal(whatsNewConsentOutboxQueueMessageKind),
	}),
)

type OutboxEnv = Omit<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'> &
	Partial<Pick<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'>>

/** Rows older than this were not delivered by their own queue message. */
const staleOutboxAgeMinutes = 2
const staleOutboxBatchSize = 20
/** A row that keeps failing stops being re-enqueued; it stays for inspection. */
const outboxMaxAttempts = 8
const whatsNewConsentSubscriptionActorTokenId =
	'internal:whats-new-consent-subscriptions'

/**
 * Orgs whose packages hear consent changes besides site admins' own. The
 * payload carries subscriber emails, so this is a fixed list of org ids.
 */
export function whatsNewConsentFirstPartyOrgIds(env: {
	WHATS_NEW_CONSENT_FIRST_PARTY_ORG_IDS?: string
}) {
	return (env.WHATS_NEW_CONSENT_FIRST_PARTY_ORG_IDS ?? '')
		.split(',')
		.map((id) => id.trim())
		.filter((id) => /^[0-9a-f]{64}$/.test(id))
}

export class ConsentOutboxSendFailed extends Schema.TaggedError<ConsentOutboxSendFailed>()(
	'ConsentOutboxSendFailed',
	{ outboxId: Schema.String, cause: Schema.Defect() },
) {}

/** Subscribers did not all handle the change; the queue retries it. */
export class ConsentDeliveryIncomplete extends Schema.TaggedError<ConsentDeliveryIncomplete>()(
	'ConsentDeliveryIncomplete',
	{ outboxId: Schema.String, failed: Schema.Int, total: Schema.Int },
) {}

type ConsentOutboxQueueService = {
	send(
		message: WhatsNewConsentOutboxQueueMessage,
	): Effect.Effect<void, ConsentOutboxSendFailed, Background>
}

/** Producer side. Without a Queue binding (local dev, previews) rows are delivered inline through the consumer's code path. */
export class ConsentOutboxQueue extends Context.Service<
	ConsentOutboxQueue,
	ConsentOutboxQueueService
>()('kody/newsletter/ConsentOutboxQueue') {
	static readonly layer = (
		queue: Queue | undefined,
	): Layer.Layer<ConsentOutboxQueue, never, D1 | PackageSubscribers> =>
		queue ? ConsentOutboxQueue.bound(queue) : ConsentOutboxQueue.inline

	static readonly bound = (queue: Queue) =>
		Layer.succeed(
			ConsentOutboxQueue,
			ConsentOutboxQueue.of({
				send: Effect.fn('ConsentOutboxQueue.send')(function* (message) {
					const body = yield* Schema.encodeEffect(
						WhatsNewConsentOutboxQueueMessage,
					)(message).pipe(Effect.orDie)
					yield* Effect.tryPromise({
						try: () => queue.send(body),
						catch: (cause) =>
							new ConsentOutboxSendFailed({
								outboxId: message.outboxId,
								cause,
							}),
					}).pipe(
						Effect.timeoutOrElse({
							duration: '10 seconds',
							orElse: () =>
								Effect.fail(
									new ConsentOutboxSendFailed({
										outboxId: message.outboxId,
										cause: 'timeout',
									}),
								),
						}),
					)
				}),
			}),
		)

	static readonly inline = Layer.effect(
		ConsentOutboxQueue,
		Effect.gen(function* () {
			const context = yield* Effect.context<D1 | PackageSubscribers>()
			return ConsentOutboxQueue.of({
				send: (message) =>
					deliverConsentOutboxRow(message.outboxId).pipe(
						Effect.provide(context),
						Effect.asVoid,
						Effect.mapError(
							(cause) =>
								new ConsentOutboxSendFailed({
									outboxId: message.outboxId,
									cause,
								}),
						),
					),
			})
		}),
	)
}

export type ConsentChange = {
	readonly stableUserId: string
	/** `null` announces a recipient that has made no choice. */
	readonly optedIn: boolean | null
	readonly source: WhatsNewConsentSource | null
	readonly occurredAt: string
}

const OutboxIdRow = Schema.Struct({ id: Schema.String })

/**
 * Store a What's New consent or subscriber change and hand it, plus any
 * stranded older rows, to the queue. The row is stored first, so a send that
 * fails leaves it for the next change's sweep.
 */
export const recordConsentChange = Effect.fn('ConsentOutbox.recordChange')(
	function* (change: ConsentChange) {
		const d1 = yield* D1
		const queue = yield* ConsentOutboxQueue
		const now = yield* DateTime.now
		const outboxId = yield* Effect.sync(() => crypto.randomUUID())
		yield* Effect.annotateCurrentSpan('outbox.id', outboxId)
		yield* d1.run(
			'consent_outbox.insert',
			sql(
				`INSERT INTO whats_new_consent_outbox (id, recipient_id, opted_in, source, occurred_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				outboxId,
				change.stableUserId,
				change.optedIn === null ? null : change.optedIn ? 1 : 0,
				change.source,
				change.occurredAt,
				DateTime.formatIso(now),
			),
		)
		const stale = yield* d1.all(
			'consent_outbox.stale',
			OutboxIdRow,
			sql(
				`SELECT id FROM whats_new_consent_outbox
				 WHERE id != ? AND created_at < ? AND attempts < ?
				 ORDER BY created_at LIMIT ?`,
				outboxId,
				DateTime.formatIso(
					DateTime.subtract(now, { minutes: staleOutboxAgeMinutes }),
				),
				outboxMaxAttempts,
				staleOutboxBatchSize,
			),
		)
		for (const id of [outboxId, ...stale.map((row) => row.id)]) {
			yield* queue.send({
				kind: whatsNewConsentOutboxQueueMessageKind,
				outboxId: id,
			})
		}
	},
)

const VerifiedAccountRow = Schema.Struct({
	opted_in: Schema.Int,
	updated_at: Schema.NullOr(Schema.String),
	source: Schema.NullOr(WhatsNewConsentSource),
	email_verified_at: Schema.String,
	email: Schema.String,
})
const ConfirmedSignupRow = Schema.Struct({ confirmed_at: Schema.String })

/**
 * Announce a verified account to subscribers with whatever newsletter choice
 * it holds (the sign-up checkbox, or none). Call when an account becomes a
 * possible recipient: its address was just verified.
 */
export const recordVerifiedAccount = Effect.fn(
	'ConsentOutbox.recordVerifiedAccount',
)(function* (stableUserId: string) {
	const d1 = yield* D1
	const account = yield* d1.first(
		'consent_outbox.verified_account',
		VerifiedAccountRow,
		sql(
			`SELECT whats_new_email_opt_in AS opted_in, whats_new_email_opt_in_updated_at AS updated_at,
					whats_new_email_opt_in_source AS source, email_verified_at, email
				 FROM users
				 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
					AND email_verified_at IS NOT NULL`,
			stableUserId,
		),
	)
	if (Option.isNone(account)) return
	const row = account.value
	const madeChoice = row.updated_at !== null
	if (!madeChoice) {
		// The recipient list counts a confirmed public sign-up for the same
		// address as this account's opt-in until the account makes a choice.
		const signup = yield* d1.first(
			'consent_outbox.confirmed_signup',
			ConfirmedSignupRow,
			sql(
				`SELECT confirmed_at FROM newsletter_signups
					 WHERE email = ? AND status = 'confirmed' AND source = 'newsletter_page'`,
				row.email,
			),
		)
		if (Option.isSome(signup)) {
			// Dated when the choice was made, so a later account choice wins.
			return yield* recordConsentChange({
				stableUserId,
				optedIn: true,
				source: 'newsletter_page',
				occurredAt: signup.value.confirmed_at,
			})
		}
	}
	yield* recordConsentChange({
		stableUserId,
		optedIn: madeChoice ? row.opted_in === 1 : null,
		source: madeChoice ? row.source : null,
		occurredAt: row.updated_at ?? row.email_verified_at,
	})
})

const ClaimedOutboxRow = Schema.Struct({
	stable_user_id: Schema.String,
	opted_in: Schema.NullOr(Schema.Literals([0, 1])),
	source: Schema.NullOr(WhatsNewConsentSource),
	occurred_at: Schema.String,
	attempts: Schema.Int,
})
const SubscriberRow = Schema.Struct({
	email: Schema.String,
	username: Schema.String,
})
const FoundRow = Schema.Struct({ found: Schema.Literal(1) })
/** What a subscription that nobody turned on answers (202, nothing ran). */
const SkippedBody = Schema.Struct({
	skipped: Schema.Struct({ reason: Schema.String }),
})
const isSkippedBody = Schema.is(SkippedBody)

/**
 * Queue-consumer side: deliver one outbox row to package subscribers. Deletes
 * the row once every subscriber handled it, keeps it (uncounted) while no
 * package handler runs, drops it when its recipient is gone or a newer choice
 * superseded it, and fails so the queue retries when delivery was incomplete.
 */
export const deliverConsentOutboxRow = Effect.fn('ConsentOutbox.deliverRow')(
	function* (
		outboxId: string,
	): Effect.fn.Return<
		{ readonly delivered: number },
		DatabaseError | ConsentDeliveryIncomplete | PackageDispatchFailed,
		D1 | PackageSubscribers | Background
	> {
		yield* Effect.annotateCurrentSpan('outbox.id', outboxId)
		const d1 = yield* D1
		const subscribers = yield* PackageSubscribers
		const claimed = yield* d1.first(
			'consent_outbox.claim',
			ClaimedOutboxRow,
			sql(
				`UPDATE whats_new_consent_outbox SET attempts = attempts + 1 WHERE id = ?
				 RETURNING recipient_id AS stable_user_id, opted_in, source, occurred_at, attempts`,
				outboxId,
			),
		)
		if (Option.isNone(claimed)) return { delivered: 0 }
		const row = claimed.value
		const remove = d1.run(
			'consent_outbox.delete',
			sql(`DELETE FROM whats_new_consent_outbox WHERE id = ?`, outboxId),
		)

		const account = yield* d1.first(
			'consent_outbox.subscriber_account',
			SubscriberRow,
			sql(
				`SELECT email, username FROM users
				 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
					AND email_verified_at IS NOT NULL`,
				row.stable_user_id,
			),
		)
		const subscriber = Option.isSome(account)
			? account
			: yield* d1.first(
					'consent_outbox.subscriber_signup',
					SubscriberRow,
					sql(
						`SELECT email, '' AS username FROM newsletter_signups
						 WHERE stable_id = ? AND status IN ('confirmed', 'unsubscribed')`,
						row.stable_user_id,
					),
				)
		if (Option.isNone(subscriber)) {
			yield* remove
			return { delivered: 0 }
		}

		// Queue retries and concurrent batches can deliver an older change after
		// a newer one. A change superseded by a later choice for the same
		// recipient is dropped. A no-choice row never supersedes a choice.
		const newer = yield* d1.first(
			'consent_outbox.newer_choice',
			FoundRow,
			sql(
				`SELECT 1 AS found FROM whats_new_consent_outbox
				 WHERE recipient_id = ? AND id != ? AND opted_in IS NOT NULL
					AND (occurred_at > ? OR (occurred_at = ? AND rowid > (
						SELECT rowid FROM whats_new_consent_outbox WHERE id = ?)))
				 LIMIT 1`,
				row.stable_user_id,
				outboxId,
				row.occurred_at,
				row.occurred_at,
				outboxId,
			),
		)
		if (Option.isSome(newer)) {
			yield* remove
			return { delivered: 0 }
		}

		const responses = yield* subscribers.dispatch({
			topic: whatsNewConsentChangedTopic,
			eventId: outboxId,
			params: {
				event: whatsNewConsentChangedTopic,
				event_id: outboxId,
				subscriber: {
					stable_user_id: row.stable_user_id,
					email: subscriber.value.email,
					username: subscriber.value.username,
				},
				consent: {
					opted_in: row.opted_in === null ? null : row.opted_in === 1,
					source: row.source,
					occurred_at: row.occurred_at,
				},
			},
			// A handler failure is stored against its key, so each attempt gets
			// a fresh one; handlers dedupe on `event_id`.
			idempotencyKey: (packageId) =>
				`whats-new-consent:${outboxId}:${row.attempts}:${packageId}`,
			actorTokenId: whatsNewConsentSubscriptionActorTokenId,
		})
		const failed = responses.filter(
			(response) =>
				!response || response.status < 200 || response.status >= 400,
		)
		if (failed.length > 0) {
			return yield* new ConsentDeliveryIncomplete({
				outboxId,
				failed: failed.length,
				total: responses.length,
			})
		}
		// A subscription nobody has turned on answers 202 without running.
		const handled = responses.filter(
			(response) => !isSkippedBody(response?.body),
		)
		if (handled.length === 0) {
			yield* d1.run(
				'consent_outbox.uncount',
				sql(
					`UPDATE whats_new_consent_outbox SET attempts = attempts - 1 WHERE id = ? AND attempts > 0`,
					outboxId,
				),
			)
			return { delivered: 0 }
		}
		yield* remove
		return { delivered: handled.length }
	},
)

/** Services every consent-outbox entrypoint needs, built once per `env`. */
export const consentOutboxLayer = (env: OutboxEnv) => {
	const d1 = D1.layer(env.APP_DB)
	const subscribers = PackageSubscribers.layer(
		env as Env,
		whatsNewConsentFirstPartyOrgIds(env),
	)
	return ConsentOutboxQueue.layer(env.PACKAGE_EVENTS_DISPATCH_QUEUE).pipe(
		Layer.provideMerge(Layer.merge(d1, subscribers)),
	)
}

const outboxRuntime = runtimePerBinding(consentOutboxLayer)

const logRecordFailure = (stableUserId: string) =>
	Effect.catch((error: DatabaseError | ConsentOutboxSendFailed) =>
		Effect.logError('whats-new-consent-outbox-record-failed', {
			stableUserId,
			error,
		}),
	)

/**
 * Promise edge for account, admin, and OAuth callers. Never rejects: the
 * change is either stored or logged, and a stranded row is swept later.
 */
export function recordWhatsNewConsentChange(
	input: ConsentChange & { env: OutboxEnv },
) {
	const { env, ...change } = input
	return runAwaitingBackground((background) =>
		outboxRuntime(env).runPromise(
			recordConsentChange(change).pipe(
				logRecordFailure(change.stableUserId),
				Effect.provide(background),
			),
		),
	)
}

/** Promise edge; see `recordVerifiedAccount`. Never rejects. */
export function recordWhatsNewVerifiedAccount(input: {
	env: OutboxEnv
	stableUserId: string
}) {
	return runAwaitingBackground((background) =>
		outboxRuntime(input.env).runPromise(
			recordVerifiedAccount(input.stableUserId).pipe(
				logRecordFailure(input.stableUserId),
				Effect.provide(background),
			),
		),
	)
}

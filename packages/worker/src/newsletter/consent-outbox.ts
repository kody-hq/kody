import {
	Context,
	DateTime,
	Effect,
	Layer,
	Option,
	Predicate,
	Schedule,
	Schema,
} from 'effect'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { Background } from '#worker/effect/background.ts'
import { D1, type DatabaseError } from '#worker/effect/d1.ts'
import { whatsNewConsentOutboxQueueMessageKind } from './consent-outbox-edge.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'

export const whatsNewConsentChangedTopic = 'whats_new.consent.changed'

export const WhatsNewConsentSource = Schema.Literals([
	'signup',
	'settings',
	'email_link',
	'admin',
	'newsletter_page',
])
export type WhatsNewConsentSource = typeof WhatsNewConsentSource.Type

/** The one queue message shape: the producer encodes it, the consumer decodes it. */
export const WhatsNewConsentOutboxMessage = Schema.Struct({
	kind: Schema.Literal(whatsNewConsentOutboxQueueMessageKind),
	outboxId: Schema.Trim.check(Schema.isNonEmpty()),
})
export type WhatsNewConsentOutboxMessage =
	typeof WhatsNewConsentOutboxMessage.Type

export const decodeWhatsNewConsentOutboxMessage = Schema.decodeUnknownOption(
	WhatsNewConsentOutboxMessage,
)

/** Rows older than this were not delivered by their own queue message. */
const staleOutboxAge = { minutes: 2 } as const
const staleOutboxBatchSize = 20
/** A row that keeps failing stops being re-enqueued; it stays for inspection. */
const outboxMaxAttempts = 8

const whatsNewConsentSubscriptionActorTokenId =
	'internal:whats-new-consent-subscriptions'

export class OutboxEnqueueError extends Schema.TaggedError<OutboxEnqueueError>()(
	'OutboxEnqueueError',
	{ outboxId: Schema.String, cause: Schema.Defect() },
) {}

export class ConsentDispatchError extends Schema.TaggedError<ConsentDispatchError>()(
	'ConsentDispatchError',
	{
		outboxId: Schema.String,
		reason: Schema.Literals(['dispatch_failed', 'handlers_failed']),
		failed: Schema.optional(Schema.Number),
		total: Schema.optional(Schema.Number),
		cause: Schema.optional(Schema.Defect()),
	},
) {}

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

type ConsentEvent = {
	readonly outboxId: string
	readonly attempts: number
	readonly params: Record<string, unknown>
}

type ConsentDispatchEnv = Omit<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'>

type DispatchResponses = Awaited<
	ReturnType<typeof dispatchAdminPackageSubscriptionEvent>
>

/** Admin package subscriptions to `whats_new.consent.changed`. */
export class ConsentDispatch extends Context.Service<
	ConsentDispatch,
	{
		readonly dispatch: (
			event: ConsentEvent,
		) => Effect.Effect<DispatchResponses, ConsentDispatchError>
	}
>()('kody/newsletter/ConsentDispatch') {
	static layer(env: ConsentDispatchEnv) {
		return Layer.effect(
			ConsentDispatch,
			Effect.gen(function* () {
				const background = yield* Background
				const baseUrl = getAppBaseUrl({ env })
				const additionalOwnerIds = whatsNewConsentFirstPartyOrgIds(env)
				return ConsentDispatch.of({
					dispatch: (event) =>
						Effect.tryPromise({
							try: () =>
								dispatchAdminPackageSubscriptionEvent({
									env,
									baseUrl,
									topic: whatsNewConsentChangedTopic,
									getParams: () => event.params,
									source: 'whats-new-consent',
									// A handler failure is stored against its key, so each
									// attempt gets a fresh one; handlers dedupe on `event_id`.
									buildIdempotencyKey: (savedPackage) =>
										`whats-new-consent:${event.outboxId}:${event.attempts}:${savedPackage.id}`,
									actorTokenId: whatsNewConsentSubscriptionActorTokenId,
									additionalOwnerIds,
									retryDiscoveryFailures: true,
									retryInvocationInfrastructureFailures: true,
									waitUntil: background.waitUntil,
								}),
							catch: (cause) =>
								new ConsentDispatchError({
									outboxId: event.outboxId,
									reason: 'dispatch_failed',
									cause,
								}),
						}).pipe(Effect.withSpan('ConsentDispatch.dispatch')),
				})
			}),
		)
	}
}

/** Hands outbox rows to their consumer. */
export class ConsentOutboxQueue extends Context.Service<
	ConsentOutboxQueue,
	{
		readonly send: (
			message: WhatsNewConsentOutboxMessage,
		) => Effect.Effect<void, OutboxEnqueueError>
	}
>()('kody/newsletter/ConsentOutboxQueue') {
	static queueLayer(queue: Queue) {
		const encode = Schema.encodeEffect(WhatsNewConsentOutboxMessage)
		return Layer.succeed(
			ConsentOutboxQueue,
			ConsentOutboxQueue.of({
				send: (message) =>
					encode(message).pipe(
						Effect.flatMap((body) => Effect.tryPromise(() => queue.send(body))),
						Effect.retry({
							schedule: Schedule.exponential('100 millis'),
							times: 2,
						}),
						Effect.mapError(
							(cause) =>
								new OutboxEnqueueError({ outboxId: message.outboxId, cause }),
						),
						Effect.withSpan('ConsentOutboxQueue.send'),
					),
			}),
		)
	}

	/**
	 * No Queue binding (local dev / preview): deliver inline with the
	 * consumer's code path so subscribers still hear about the change.
	 */
	static readonly inlineLayer = Layer.effect(
		ConsentOutboxQueue,
		Effect.gen(function* () {
			const context = yield* Effect.context<D1 | ConsentDispatch>()
			return ConsentOutboxQueue.of({
				send: (message) =>
					deliverWhatsNewConsentOutboxRow(message.outboxId).pipe(
						Effect.asVoid,
						Effect.mapError(
							(cause) =>
								new OutboxEnqueueError({ outboxId: message.outboxId, cause }),
						),
						Effect.provideContext(context),
					),
			})
		}),
	)
}

/**
 * Record a What's New consent or subscriber change for admin package
 * subscribers and hand it to the queue, with any stale rows a lost message
 * left behind. `optedIn: null` announces a recipient that has made no choice.
 */
export const recordWhatsNewConsentChange = Effect.fn(
	'recordWhatsNewConsentChange',
)(function* (change: {
	readonly stableUserId: string
	readonly optedIn: boolean | null
	readonly source: WhatsNewConsentSource | null
	readonly occurredAt: string
}) {
	const d1 = yield* D1
	const queue = yield* ConsentOutboxQueue
	const now = yield* DateTime.now
	const outboxId = crypto.randomUUID()
	yield* d1.run({
		name: 'consentOutbox.insert',
		sql: `INSERT INTO whats_new_consent_outbox (id, recipient_id, opted_in, source, occurred_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
		params: [
			outboxId,
			change.stableUserId,
			change.optedIn === null ? null : change.optedIn ? 1 : 0,
			change.source,
			change.occurredAt,
			DateTime.formatIso(now),
		],
	})
	const stale = yield* d1.all({
		name: 'consentOutbox.listStale',
		sql: `SELECT id FROM whats_new_consent_outbox
			WHERE id != ? AND created_at < ? AND attempts < ?
			ORDER BY created_at LIMIT ?`,
		params: [
			outboxId,
			DateTime.formatIso(DateTime.subtract(now, staleOutboxAge)),
			outboxMaxAttempts,
			staleOutboxBatchSize,
		],
		row: Schema.Struct({ id: Schema.String }),
	})
	for (const id of [outboxId, ...stale.map((row) => row.id)]) {
		yield* queue.send({
			kind: whatsNewConsentOutboxQueueMessageKind,
			outboxId: id,
		})
	}
})

const VerifiedAccountConsentRow = Schema.Struct({
	opted_in: Schema.Number,
	updated_at: Schema.NullOr(Schema.String),
	source: Schema.NullOr(WhatsNewConsentSource),
	email_verified_at: Schema.String,
	email: Schema.String,
})

/**
 * Announce a verified account to subscribers with whatever newsletter choice
 * it holds (the sign-up checkbox, or none). Call when an account becomes a
 * possible recipient: its address was just verified.
 */
export const recordWhatsNewVerifiedAccount = Effect.fn(
	'recordWhatsNewVerifiedAccount',
)(function* (stableUserId: string) {
	const d1 = yield* D1
	const account = yield* d1.first({
		name: 'consentOutbox.findVerifiedAccount',
		sql: `SELECT whats_new_email_opt_in AS opted_in, whats_new_email_opt_in_updated_at AS updated_at,
				whats_new_email_opt_in_source AS source, email_verified_at, email
			FROM users
			WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
				AND email_verified_at IS NOT NULL`,
		params: [stableUserId],
		row: VerifiedAccountConsentRow,
	})
	if (Option.isNone(account)) return
	const row = account.value
	if (row.updated_at === null) {
		// The recipient list counts a confirmed public sign-up for the same
		// address as this account's opt-in until the account makes a choice.
		const signup = yield* d1.first({
			name: 'consentOutbox.findConfirmedSignup',
			sql: `SELECT confirmed_at FROM newsletter_signups
				WHERE email = ? AND status = 'confirmed' AND source = 'newsletter_page'`,
			params: [row.email],
			row: Schema.Struct({ confirmed_at: Schema.String }),
		})
		if (Option.isSome(signup)) {
			// Dated when the choice was made, so any later account choice wins.
			return yield* recordWhatsNewConsentChange({
				stableUserId,
				optedIn: true,
				source: 'newsletter_page',
				occurredAt: signup.value.confirmed_at,
			})
		}
	}
	const madeChoice = row.updated_at !== null
	yield* recordWhatsNewConsentChange({
		stableUserId,
		optedIn: madeChoice ? row.opted_in === 1 : null,
		source: madeChoice ? row.source : null,
		occurredAt: row.updated_at ?? row.email_verified_at,
	})
})

const ClaimedOutboxRow = Schema.Struct({
	stable_user_id: Schema.String,
	opted_in: Schema.NullOr(Schema.Literals([0, 1])),
	source: Schema.NullOr(Schema.String),
	occurred_at: Schema.String,
	attempts: Schema.Number,
})

const SubscriberRow = Schema.Struct({
	email: Schema.String,
	username: Schema.String,
})

/** A skipped body carries why, e.g. `{ skipped: { reason: 'no_enablement_on' } }`. */
const isSkippedResponseBody = (body: unknown) =>
	Predicate.hasProperty(body, 'skipped') && Boolean(body.skipped)

/**
 * Queue-consumer side: deliver one outbox row to admin package subscribers.
 * Deletes the row once every subscriber handled it and keeps it while no
 * package subscribes. Fails to retry when delivery failed; a row with no
 * remaining recipient is dropped.
 */
export const deliverWhatsNewConsentOutboxRow = Effect.fn(
	'deliverWhatsNewConsentOutboxRow',
)(function* (
	outboxId: string,
): Effect.fn.Return<
	{ readonly delivered: number },
	DatabaseError | ConsentDispatchError,
	D1 | ConsentDispatch
> {
	yield* Effect.annotateCurrentSpan('outbox.id', outboxId)
	const d1 = yield* D1
	const consentDispatch = yield* ConsentDispatch
	const claimed = yield* d1.first({
		name: 'consentOutbox.claim',
		sql: `UPDATE whats_new_consent_outbox SET attempts = attempts + 1 WHERE id = ?
			RETURNING recipient_id AS stable_user_id, opted_in, source, occurred_at, attempts`,
		params: [outboxId],
		row: ClaimedOutboxRow,
	})
	if (Option.isNone(claimed)) return { delivered: 0 }
	const row = claimed.value
	const remove = d1.run({
		name: 'consentOutbox.delete',
		sql: `DELETE FROM whats_new_consent_outbox WHERE id = ?`,
		params: [outboxId],
	})
	const subscriber = yield* d1
		.first({
			name: 'consentOutbox.findAccountSubscriber',
			sql: `SELECT email, username FROM users
				WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
					AND email_verified_at IS NOT NULL`,
			params: [row.stable_user_id],
			row: SubscriberRow,
		})
		.pipe(
			Effect.flatMap(
				Option.match({
					onSome: (user) => Effect.succeedSome(user),
					onNone: () =>
						d1.first({
							name: 'consentOutbox.findSignupSubscriber',
							sql: `SELECT email, '' AS username FROM newsletter_signups
								WHERE stable_id = ? AND status IN ('confirmed', 'unsubscribed')`,
							params: [row.stable_user_id],
							row: SubscriberRow,
						}),
				}),
			),
		)
	if (Option.isNone(subscriber)) {
		yield* remove
		return { delivered: 0 }
	}
	// Queue retries and concurrent batches can deliver an older change after a
	// newer one. A change superseded by a later choice for the same recipient
	// is dropped; subscribers also order by `occurred_at`. A no-choice row
	// carries no consent, so it never supersedes a choice.
	const newer = yield* d1.first({
		name: 'consentOutbox.findNewerChoice',
		sql: `SELECT 1 AS newer FROM whats_new_consent_outbox
			WHERE recipient_id = ? AND id != ? AND opted_in IS NOT NULL
				AND (occurred_at > ? OR (occurred_at = ? AND rowid > (
					SELECT rowid FROM whats_new_consent_outbox WHERE id = ?)))
			LIMIT 1`,
		params: [
			row.stable_user_id,
			outboxId,
			row.occurred_at,
			row.occurred_at,
			outboxId,
		],
		row: Schema.Struct({ newer: Schema.Number }),
	})
	if (Option.isSome(newer)) {
		yield* remove
		return { delivered: 0 }
	}
	const responses = yield* consentDispatch.dispatch({
		outboxId,
		attempts: row.attempts,
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
	})
	const failed = responses.filter(
		(response) => !response || response.status < 200 || response.status >= 400,
	).length
	if (failed > 0) {
		return yield* new ConsentDispatchError({
			outboxId,
			reason: 'handlers_failed',
			failed,
			total: responses.length,
		})
	}
	// A subscription nobody has turned on answers 202 without running.
	const handled = responses.filter(
		(response) =>
			!(
				Predicate.isNotNullish(response) && isSkippedResponseBody(response.body)
			),
	).length
	if (handled === 0) {
		// No package handler ran: keep the row, uncounted, for the sweep that
		// runs with the next change.
		yield* d1.run({
			name: 'consentOutbox.release',
			sql: `UPDATE whats_new_consent_outbox SET attempts = attempts - 1 WHERE id = ? AND attempts > 0`,
			params: [outboxId],
		})
		return { delivered: 0 }
	}
	yield* remove
	return { delivered: handled }
})

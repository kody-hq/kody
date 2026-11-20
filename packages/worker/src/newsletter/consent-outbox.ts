import { Cause, Effect } from 'effect'
import {
	type DatabaseError,
	type QueueSendFailed,
	type SubscriberDispatchFailed,
	SubscribersRejected,
} from './errors.ts'
import {
	AdminSubscribers,
	ConsentQueue,
	NewsletterDb,
	newsletterLayer,
	whatsNewConsentFirstPartyOrgIds,
	type NewsletterEnv,
} from './services.ts'

export const whatsNewConsentChangedTopic = 'whats_new.consent.changed'

export const whatsNewConsentOutboxQueueMessageKind = 'whats-new-consent-outbox'

export type WhatsNewConsentSource =
	| 'signup'
	| 'settings'
	| 'email_link'
	| 'admin'
	| 'newsletter_page'

export type WhatsNewConsentOutboxQueueMessage = {
	kind: typeof whatsNewConsentOutboxQueueMessageKind
	outboxId: string
}

type WaitUntil = (promise: Promise<unknown>) => void

/** Rows older than this were not delivered by their own queue message. */
const staleOutboxAgeMs = 2 * 60 * 1000
const staleOutboxBatchSize = 20
/** A row that keeps failing stops being re-enqueued; it stays for inspection. */
const outboxMaxAttempts = 8

const whatsNewConsentSubscriptionActorTokenId =
	'internal:whats-new-consent-subscriptions'

export { whatsNewConsentFirstPartyOrgIds }

export function isWhatsNewConsentOutboxQueueBody(body: unknown) {
	return (
		!!body &&
		typeof body === 'object' &&
		!Array.isArray(body) &&
		(body as Record<string, unknown>)['kind'] ===
			whatsNewConsentOutboxQueueMessageKind
	)
}

export function parseWhatsNewConsentOutboxQueueMessage(
	body: unknown,
): WhatsNewConsentOutboxQueueMessage | null {
	if (!isWhatsNewConsentOutboxQueueBody(body)) return null
	const outboxId = (body as Record<string, unknown>)['outboxId']
	if (typeof outboxId !== 'string' || !outboxId.trim()) return null
	return {
		kind: whatsNewConsentOutboxQueueMessageKind,
		outboxId: outboxId.trim(),
	}
}

type ConsentChange = {
	stableUserId: string
	optedIn: boolean | null
	source: WhatsNewConsentSource | null
	occurredAt: string
	now?: Date
}

type DeliveryError =
	| DatabaseError
	| SubscriberDispatchFailed
	| SubscribersRejected

/** Outbox writes never fail their caller: log and leave it to the sweep. */
const logRecordFailure =
	(stableUserId: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.asVoid,
			Effect.catchCause((cause) =>
				Effect.sync(() => {
					console.error('whats-new-consent-outbox-record-failed', {
						stableUserId,
						error: Cause.squash(cause),
					})
				}),
			),
		)

/**
 * Record a What's New consent or subscriber change for admin package
 * subscribers and hand it to the queue. Never fails (see the error channel):
 * the change is already stored, and a row that could not be enqueued is
 * picked up by the next one. `optedIn: null` announces a recipient that has
 * made no choice.
 */
export const recordConsentChange = Effect.fn('recordConsentChange')(
	function* (change: ConsentChange) {
		const db = yield* NewsletterDb
		const queue = yield* ConsentQueue
		const now = change.now ?? new Date()
		const outboxId = crypto.randomUUID()
		yield* db.run(
			`INSERT INTO whats_new_consent_outbox (id, recipient_id, opted_in, source, occurred_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			outboxId,
			change.stableUserId,
			change.optedIn === null ? null : change.optedIn ? 1 : 0,
			change.source,
			change.occurredAt,
			now.toISOString(),
		)
		const stale = yield* db.all<{ id: string }>(
			`SELECT id FROM whats_new_consent_outbox
			 WHERE id != ? AND created_at < ? AND attempts < ?
			 ORDER BY created_at LIMIT ?`,
			outboxId,
			new Date(now.getTime() - staleOutboxAgeMs).toISOString(),
			outboxMaxAttempts,
			staleOutboxBatchSize,
		)
		yield* Effect.forEach(
			[outboxId, ...stale.map((row) => row.id)],
			(
				id,
			): Effect.Effect<
				unknown,
				QueueSendFailed | DeliveryError,
				NewsletterDb | AdminSubscribers
			> =>
				queue.available
					? queue.send(id)
					: // No Queue binding (local dev / preview): deliver inline with
						// the consumer's code path so subscribers still hear about it.
						deliverConsentOutboxRow(id),
			{ discard: true },
		)
	},
	(effect, change) => logRecordFailure(change.stableUserId)(effect),
)

/**
 * Announce a verified account to subscribers with whatever newsletter choice
 * it holds (the sign-up checkbox, or none). Call when an account becomes a
 * possible recipient: its address was just verified.
 */
export const recordVerifiedAccount = Effect.fn('recordVerifiedAccount')(
	function* (input: { stableUserId: string; now?: Date }) {
		const db = yield* NewsletterDb
		const row = yield* db.first<{
			opted_in: number
			updated_at: string | null
			source: WhatsNewConsentSource | null
			email_verified_at: string
			email: string
		}>(
			`SELECT whats_new_email_opt_in AS opted_in, whats_new_email_opt_in_updated_at AS updated_at,
				whats_new_email_opt_in_source AS source, email_verified_at, email
			 FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
				AND email_verified_at IS NOT NULL`,
			input.stableUserId,
		)
		if (!row) return
		const madeChoice = row.updated_at !== null
		if (!madeChoice) {
			// The recipient list counts a confirmed public sign-up for the same
			// address as this account's opt-in until the account makes a choice.
			const signup = yield* db.first<{ confirmed_at: string }>(
				`SELECT confirmed_at FROM newsletter_signups
				 WHERE email = ? AND status = 'confirmed' AND source = 'newsletter_page'`,
				row.email,
			)
			if (signup) {
				return yield* recordConsentChange({
					stableUserId: input.stableUserId,
					optedIn: true,
					source: 'newsletter_page',
					// Dated when the choice was made, so any later choice on the
					// account still wins.
					occurredAt: signup.confirmed_at,
					now: input.now,
				})
			}
		}
		yield* recordConsentChange({
			stableUserId: input.stableUserId,
			optedIn: madeChoice ? row.opted_in === 1 : null,
			source: madeChoice ? row.source : null,
			occurredAt: row.updated_at ?? row.email_verified_at,
			now: input.now,
		})
	},
	(effect, input) => logRecordFailure(input.stableUserId)(effect),
)

/**
 * Queue-consumer side: deliver one outbox row to admin package subscribers.
 * Deletes the row once every subscriber handled it and keeps it while no
 * package subscribes. Fails to retry when delivery failed; a row with no
 * remaining recipient is dropped.
 */
export const deliverConsentOutboxRow = Effect.fn('deliverConsentOutboxRow')(
	function* (
		outboxId: string,
	): Effect.fn.Return<
		{ delivered: number },
		DeliveryError,
		NewsletterDb | AdminSubscribers
	> {
		const db = yield* NewsletterDb
		const row = yield* db.first<{
			stable_user_id: string
			opted_in: number | null
			source: string | null
			occurred_at: string
			attempts: number
		}>(
			`UPDATE whats_new_consent_outbox SET attempts = attempts + 1 WHERE id = ?
			 RETURNING recipient_id AS stable_user_id, opted_in, source, occurred_at, attempts`,
			outboxId,
		)
		if (!row) return { delivered: 0 }
		const remove = db
			.run(`DELETE FROM whats_new_consent_outbox WHERE id = ?`, outboxId)
			.pipe(Effect.as({ delivered: 0 }))
		// Queue retries and concurrent batches can deliver an older change after
		// a newer one. A change superseded by a later choice for the same
		// recipient is dropped; subscribers also order by `occurred_at`. A
		// no-choice row carries no consent, so it never supersedes a choice.
		const [subscriber, newer] = yield* Effect.all(
			[
				loadSubscriber(row.stable_user_id),
				db.first<{ newer: number }>(
					`SELECT 1 AS newer FROM whats_new_consent_outbox
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
			],
			{ concurrency: 2 },
		)
		if (!subscriber || newer) return yield* remove
		const responses = yield* (yield* AdminSubscribers).dispatch({
			topic: whatsNewConsentChangedTopic,
			getParams: () => ({
				event: whatsNewConsentChangedTopic,
				event_id: outboxId,
				subscriber: {
					stable_user_id: row.stable_user_id,
					email: subscriber.email,
					username: subscriber.username,
				},
				consent: {
					opted_in: row.opted_in === null ? null : row.opted_in === 1,
					source: row.source,
					occurred_at: row.occurred_at,
				},
			}),
			source: 'whats-new-consent',
			// A handler failure is stored against its key, so each attempt gets
			// a fresh one; handlers dedupe on `event_id`.
			buildIdempotencyKey: (savedPackage) =>
				`whats-new-consent:${outboxId}:${row.attempts}:${savedPackage.id}`,
			actorTokenId: whatsNewConsentSubscriptionActorTokenId,
		})
		const failed = responses.filter(
			(response) =>
				!response || response.status < 200 || response.status >= 400,
		)
		if (failed.length > 0) {
			return yield* new SubscribersRejected({
				failed: failed.length,
				total: responses.length,
			})
		}
		// A subscription nobody has turned on answers 202 without running.
		const handled = responses.filter(
			(response) =>
				!(response?.body as { skipped?: unknown } | undefined)?.skipped,
		)
		if (handled.length === 0) {
			// No package handler ran: keep the row, uncounted, for the sweep that
			// runs with the next change.
			yield* db.run(
				`UPDATE whats_new_consent_outbox SET attempts = attempts - 1 WHERE id = ? AND attempts > 0`,
				outboxId,
			)
			return { delivered: 0 }
		}
		yield* remove
		return { delivered: handled.length }
	},
)

const loadSubscriber = Effect.fnUntraced(function* (stableUserId: string) {
	const db = yield* NewsletterDb
	const user = yield* db.first<{ email: string; username: string }>(
		`SELECT email, username FROM users
		 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
			AND email_verified_at IS NOT NULL`,
		stableUserId,
	)
	if (user) return user
	return yield* db.first<{ email: string; username: string }>(
		`SELECT email, '' AS username FROM newsletter_signups
		 WHERE stable_id = ? AND status IN ('confirmed', 'unsubscribed')`,
		stableUserId,
	)
})

// Promise boundaries for the rest of the Worker, which is not Effect code.

export function recordWhatsNewConsentChange(
	input: ConsentChange & { env: NewsletterEnv },
): Promise<void> {
	return recordConsentChange(input).pipe(
		Effect.provide(newsletterLayer(input.env)),
		Effect.runPromise,
	)
}

export function recordWhatsNewVerifiedAccount(input: {
	env: NewsletterEnv
	stableUserId: string
	now?: Date
}): Promise<void> {
	return recordVerifiedAccount(input).pipe(
		Effect.provide(newsletterLayer(input.env)),
		Effect.runPromise,
	)
}

/** Rejects with the tagged error so the queue consumer retries the message. */
export function deliverWhatsNewConsentOutboxRow(input: {
	env: NewsletterEnv
	outboxId: string
	waitUntil?: WaitUntil
}): Promise<{ delivered: number }> {
	return deliverConsentOutboxRow(input.outboxId).pipe(
		Effect.provide(newsletterLayer(input.env, { waitUntil: input.waitUntil })),
		Effect.runPromise,
	)
}

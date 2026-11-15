import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'

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

type OutboxEnv = Omit<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'> &
	Partial<Pick<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'>>

/** Rows older than this were not delivered by their own queue message. */
const staleOutboxAgeMs = 2 * 60 * 1000
const staleOutboxBatchSize = 20
/** A row that keeps failing stops being re-enqueued; it stays for inspection. */
const outboxMaxAttempts = 8

const whatsNewConsentSubscriptionActorTokenId =
	'internal:whats-new-consent-subscriptions'

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

async function enqueueOutboxIds(env: OutboxEnv, outboxIds: Array<string>) {
	const queue = env.PACKAGE_EVENTS_DISPATCH_QUEUE
	for (const outboxId of outboxIds) {
		if (queue) {
			await queue.send({
				kind: whatsNewConsentOutboxQueueMessageKind,
				outboxId,
			} satisfies WhatsNewConsentOutboxQueueMessage)
			continue
		}
		// No Queue binding (local dev / preview): deliver inline with the
		// consumer's code path so subscribers still hear about the change.
		await deliverWhatsNewConsentOutboxRow({ env, outboxId })
	}
}

/**
 * Record a What's New consent or subscriber change for admin package
 * subscribers and hand it to the queue. Never throws: the change is already
 * stored, and a row that could not be enqueued is picked up by the next one.
 * `optedIn: null` announces a recipient that has made no choice.
 */
export async function recordWhatsNewConsentChange(input: {
	env: OutboxEnv
	stableUserId: string
	optedIn: boolean | null
	source: WhatsNewConsentSource | null
	occurredAt: string
	now?: Date
}) {
	try {
		const now = input.now ?? new Date()
		const outboxId = crypto.randomUUID()
		await input.env.APP_DB.prepare(
			`INSERT INTO whats_new_consent_outbox (id, recipient_id, opted_in, source, occurred_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				outboxId,
				input.stableUserId,
				input.optedIn === null ? null : input.optedIn ? 1 : 0,
				input.source,
				input.occurredAt,
				now.toISOString(),
			)
			.run()
		const stale = await input.env.APP_DB.prepare(
			`SELECT id FROM whats_new_consent_outbox
			 WHERE id != ? AND created_at < ? AND attempts < ?
			 ORDER BY created_at LIMIT ?`,
		)
			.bind(
				outboxId,
				new Date(now.getTime() - staleOutboxAgeMs).toISOString(),
				outboxMaxAttempts,
				staleOutboxBatchSize,
			)
			.all<{ id: string }>()
		await enqueueOutboxIds(input.env, [
			outboxId,
			...stale.results.map((row) => row.id),
		])
	} catch (error) {
		console.error('whats-new-consent-outbox-record-failed', {
			stableUserId: input.stableUserId,
			error,
		})
	}
}

/**
 * Announce a verified account to subscribers with whatever newsletter choice
 * it holds (the sign-up checkbox, or none). Call when an account becomes a
 * possible recipient: its address was just verified.
 */
export async function recordWhatsNewVerifiedAccount(input: {
	env: OutboxEnv
	stableUserId: string
	now?: Date
}) {
	try {
		const row = await input.env.APP_DB.prepare(
			`SELECT whats_new_email_opt_in AS opted_in, whats_new_email_opt_in_updated_at AS updated_at,
				whats_new_email_opt_in_source AS source, email_verified_at, email
			 FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
				AND email_verified_at IS NOT NULL`,
		)
			.bind(input.stableUserId)
			.first<{
				opted_in: number
				updated_at: string | null
				source: WhatsNewConsentSource | null
				email_verified_at: string
				email: string
			}>()
		if (!row) return
		const madeChoice = row.updated_at !== null
		if (!madeChoice) {
			// The recipient list counts a confirmed public sign-up for the same
			// address as this account's opt-in until the account makes a choice.
			const signup = await input.env.APP_DB.prepare(
				`SELECT confirmed_at FROM newsletter_signups
				 WHERE email = ? AND status = 'confirmed' AND source = 'newsletter_page'`,
			)
				.bind(row.email)
				.first<{ confirmed_at: string }>()
			if (signup) {
				await recordWhatsNewConsentChange({
					env: input.env,
					stableUserId: input.stableUserId,
					optedIn: true,
					source: 'newsletter_page',
					occurredAt: signup.confirmed_at,
					now: input.now,
				})
				return
			}
		}
		await recordWhatsNewConsentChange({
			env: input.env,
			stableUserId: input.stableUserId,
			optedIn: madeChoice ? row.opted_in === 1 : null,
			source: madeChoice ? row.source : null,
			occurredAt: row.updated_at ?? row.email_verified_at,
			now: input.now,
		})
	} catch (error) {
		console.error('whats-new-consent-outbox-record-failed', {
			stableUserId: input.stableUserId,
			error,
		})
	}
}

async function loadSubscriber(db: D1Database, stableUserId: string) {
	const user = await db
		.prepare(
			`SELECT email, username FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
				AND email_verified_at IS NOT NULL`,
		)
		.bind(stableUserId)
		.first<{ email: string; username: string }>()
	if (user) return user
	return await db
		.prepare(
			`SELECT email, '' AS username FROM newsletter_signups
			 WHERE stable_id = ? AND status IN ('confirmed', 'unsubscribed')`,
		)
		.bind(stableUserId)
		.first<{ email: string; username: string }>()
}

/**
 * Queue-consumer side: deliver one outbox row to admin package subscribers.
 * Deletes the row once every subscriber handled it and keeps it while no
 * package subscribes. Throws to retry when delivery failed; a row with no
 * remaining recipient is dropped.
 */
export async function deliverWhatsNewConsentOutboxRow(input: {
	env: OutboxEnv
	outboxId: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const db = input.env.APP_DB
	const row = await db
		.prepare(
			`UPDATE whats_new_consent_outbox SET attempts = attempts + 1 WHERE id = ?
			 RETURNING recipient_id AS stable_user_id, opted_in, source, occurred_at, attempts`,
		)
		.bind(input.outboxId)
		.first<{
			stable_user_id: string
			opted_in: number | null
			source: string | null
			occurred_at: string
			attempts: number
		}>()
	if (!row) return { delivered: 0 }
	const remove = async () => {
		await db
			.prepare(`DELETE FROM whats_new_consent_outbox WHERE id = ?`)
			.bind(input.outboxId)
			.run()
	}
	const subscriber = await loadSubscriber(db, row.stable_user_id)
	if (!subscriber) {
		await remove()
		return { delivered: 0 }
	}
	const responses = await dispatchAdminPackageSubscriptionEvent({
		env: input.env as Env,
		baseUrl: getAppBaseUrl({ env: input.env as Env }),
		topic: whatsNewConsentChangedTopic,
		getParams: () => ({
			event: whatsNewConsentChangedTopic,
			event_id: input.outboxId,
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
		// A handler failure is stored against its key, so each attempt gets a
		// fresh one; handlers dedupe on `event_id`.
		buildIdempotencyKey: (savedPackage) =>
			`whats-new-consent:${input.outboxId}:${row.attempts}:${savedPackage.id}`,
		actorTokenId: whatsNewConsentSubscriptionActorTokenId,
		retryDiscoveryFailures: true,
		retryInvocationInfrastructureFailures: true,
		waitUntil: input.waitUntil,
	})
	const failed = responses.filter(
		(response) => !response || response.status < 200 || response.status >= 400,
	)
	if (failed.length > 0) {
		throw new Error(
			`whats_new.consent.changed was not handled by ${failed.length} of ${responses.length} subscribers.`,
		)
	}
	if (responses.length === 0) {
		// No admin package subscribes yet: keep the row, uncounted, for the
		// sweep that runs with the next change.
		await db
			.prepare(
				`UPDATE whats_new_consent_outbox SET attempts = attempts - 1 WHERE id = ? AND attempts > 0`,
			)
			.bind(input.outboxId)
			.run()
		return { delivered: 0 }
	}
	await remove()
	return { delivered: responses.length }
}

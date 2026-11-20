import { Context, Effect, Layer, Schedule } from 'effect'
import type { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import type { checkPublicFormProtection } from '#app/public-form-protection.ts'
import type { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import type { sendNewsletterConfirmationEmail } from '#worker/email/system-outbound.ts'
import type { RateLimitConfig } from '#worker/rate-limit.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import {
	type ConfirmationSendFailed,
	DatabaseError,
	type EmailUnconfigured,
	QueueSendFailed,
	SubscriberDispatchFailed,
	type VerificationFailed,
	type VerificationUnavailable,
} from './errors.ts'

export type WaitUntil = (promise: Promise<unknown>) => void

type AuditEvent = Parameters<typeof logAuditEvent>[0]

export type NewsletterEnv = Parameters<
	typeof sendNewsletterConfirmationEmail
>[0]['env'] &
	Parameters<typeof resolveTransactionalEmailConfig>[0]['env'] &
	Parameters<typeof auditDatabaseFromEnv>[0] &
	Parameters<typeof checkPublicFormProtection>[0]['env'] &
	Omit<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'> &
	Partial<Pick<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'>>

export class NewsletterDb extends Context.Service<
	NewsletterDb,
	{
		first<T>(
			sql: string,
			...binds: Array<unknown>
		): Effect.Effect<T | null, DatabaseError>
		all<T>(
			sql: string,
			...binds: Array<unknown>
		): Effect.Effect<Array<T>, DatabaseError>
		run(
			sql: string,
			...binds: Array<unknown>
		): Effect.Effect<void, DatabaseError>
	}
>()('kody/newsletter/NewsletterDb') {}

export class RateLimiter extends Context.Service<
	RateLimiter,
	{
		allow(
			key: string,
			config: RateLimitConfig,
		): Effect.Effect<boolean, DatabaseError>
	}
>()('kody/newsletter/RateLimiter') {}

export class HumanVerification extends Context.Service<
	HumanVerification,
	{
		verify(input: {
			request: Request
			form: Record<string, unknown>
		}): Effect.Effect<void, VerificationFailed | VerificationUnavailable>
	}
>()('kody/newsletter/HumanVerification') {}

export class ConfirmationMailer extends Context.Service<
	ConfirmationMailer,
	{
		appBaseUrl(request: Request): Effect.Effect<string, EmailUnconfigured>
		send(message: {
			to: string
			subject: string
			html: string
			text: string
			now: Date
		}): Effect.Effect<void, ConfirmationSendFailed>
	}
>()('kody/newsletter/ConfirmationMailer') {}

export class AuditLog extends Context.Service<
	AuditLog,
	{ record(event: Omit<AuditEvent, 'db'>): Effect.Effect<void> }
>()('kody/newsletter/AuditLog') {}

export class ConsentQueue extends Context.Service<
	ConsentQueue,
	{
		/** False without a Queue binding (local dev, previews): deliver inline. */
		readonly available: boolean
		send(outboxId: string): Effect.Effect<void, QueueSendFailed>
	}
>()('kody/newsletter/ConsentQueue') {}

export class AdminSubscribers extends Context.Service<
	AdminSubscribers,
	{
		dispatch(
			input: Pick<
				Parameters<typeof dispatchAdminPackageSubscriptionEvent>[0],
				| 'topic'
				| 'getParams'
				| 'source'
				| 'buildIdempotencyKey'
				| 'actorTokenId'
			>,
		): Effect.Effect<
			Awaited<ReturnType<typeof dispatchAdminPackageSubscriptionEvent>>,
			SubscriberDispatchFailed
		>
	}
>()('kody/newsletter/AdminSubscribers') {}

export type NewsletterServices =
	| NewsletterDb
	| RateLimiter
	| HumanVerification
	| ConfirmationMailer
	| AuditLog
	| ConsentQueue
	| AdminSubscribers

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

function d1(db: D1Database) {
	const statement = (sql: string, binds: Array<unknown>) =>
		db.prepare(sql).bind(...binds)
	return NewsletterDb.of({
		first: <T>(sql: string, ...binds: Array<unknown>) =>
			Effect.tryPromise({
				try: () => statement(sql, binds).first<T>(),
				catch: (cause) => new DatabaseError({ operation: 'first', cause }),
			}),
		all: <T>(sql: string, ...binds: Array<unknown>) =>
			Effect.tryPromise({
				try: async () => (await statement(sql, binds).all<T>()).results,
				catch: (cause) => new DatabaseError({ operation: 'all', cause }),
			}),
		run: (sql: string, ...binds: Array<unknown>) =>
			Effect.tryPromise({
				try: () => statement(sql, binds).run(),
				catch: (cause) => new DatabaseError({ operation: 'run', cause }),
			}).pipe(Effect.asVoid),
	})
}

/**
 * Bindings the consent outbox needs. Built per request because bindings
 * arrive with the request (Start context or the queue handler), so there is
 * no process-wide ManagedRuntime. Kept apart from the sign-up layer: the
 * runtime Worker reaches this module and must not pull in Turnstile or mail.
 */
export function outboxLayer(
	env: NewsletterEnv,
	options: { waitUntil?: WaitUntil } = {},
): Layer.Layer<NewsletterDb | ConsentQueue | AdminSubscribers> {
	const { waitUntil } = options
	return Layer.mergeAll(
		Layer.succeed(NewsletterDb, d1(env.APP_DB)),
		Layer.succeed(
			ConsentQueue,
			ConsentQueue.of({
				available: !!env.PACKAGE_EVENTS_DISPATCH_QUEUE,
				send: (outboxId) =>
					Effect.tryPromise({
						try: async () => {
							const queue = env.PACKAGE_EVENTS_DISPATCH_QUEUE
							if (!queue) throw new Error('No consent queue binding.')
							await queue.send({
								kind: 'whats-new-consent-outbox',
								outboxId,
							})
						},
						catch: (cause) => new QueueSendFailed({ outboxId, cause }),
					}).pipe(
						// A blip on send is worth two quick retries; anything longer
						// is left to the stale-row sweep.
						Effect.retry({
							times: 2,
							schedule: Schedule.exponential('50 millis'),
						}),
					),
			}),
		),
		Layer.succeed(
			AdminSubscribers,
			AdminSubscribers.of({
				dispatch: (input) =>
					Effect.tryPromise({
						try: () =>
							dispatchAdminPackageSubscriptionEvent({
								...input,
								env: env as Env,
								baseUrl: getAppBaseUrl({ env: env as Env }),
								additionalOwnerIds: whatsNewConsentFirstPartyOrgIds(env),
								retryDiscoveryFailures: true,
								retryInvocationInfrastructureFailures: true,
								waitUntil,
							}),
						catch: (cause) => new SubscriberDispatchFailed({ cause }),
					}),
			}),
		),
	)
}

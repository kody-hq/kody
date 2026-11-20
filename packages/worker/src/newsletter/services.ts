import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { Background } from '#worker/effect/background.ts'
import { sendNewsletterConfirmationEmail } from '#worker/email/system-outbound.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'

export class ConfirmationEmailFailed extends Schema.TaggedError<ConfirmationEmailFailed>()(
	'ConfirmationEmailFailed',
	{ reason: Schema.Literals(['send', 'timeout']), cause: Schema.Defect() },
) {}

export type ConfirmationEmail = {
	readonly to: string
	readonly subject: string
	readonly html: string
	readonly text: string
}

export type MailerEnv = Parameters<
	typeof sendNewsletterConfirmationEmail
>[0]['env'] &
	Parameters<typeof resolveTransactionalEmailConfig>[0]['env']

/** The reserved `news@` sender. The mail API takes no signal, so a timeout bounds the wait but cannot cancel the send. */
export class NewsletterMailer extends Context.Service<
	NewsletterMailer,
	{
		appBaseUrl(request: Request): Option.Option<string>
		sendConfirmation(
			message: ConfirmationEmail,
		): Effect.Effect<void, ConfirmationEmailFailed, Background>
	}
>()('kody/newsletter/NewsletterMailer') {
	static readonly layer = (env: MailerEnv) =>
		Layer.succeed(
			NewsletterMailer,
			NewsletterMailer.of({
				appBaseUrl: (request) =>
					Option.fromNullishOr(
						resolveTransactionalEmailConfig({
							env,
							requestUrl:
								env.WRANGLER_IS_LOCAL_DEV === 'true' ? request.url : undefined,
						})?.appBaseUrl,
					),
				sendConfirmation: Effect.fn('NewsletterMailer.sendConfirmation')(
					function* (message) {
						const { waitUntil } = yield* Background
						const now = yield* DateTime.now
						yield* Effect.tryPromise({
							try: async () => {
								await sendNewsletterConfirmationEmail({
									env,
									...message,
									now: DateTime.toDate(now),
									waitUntil,
								})
							},
							catch: (cause) =>
								new ConfirmationEmailFailed({ reason: 'send', cause }),
						}).pipe(
							Effect.timeoutOrElse({
								duration: '15 seconds',
								orElse: () =>
									Effect.fail(
										new ConfirmationEmailFailed({
											reason: 'timeout',
											cause: null,
										}),
									),
							}),
						)
					},
				),
			}),
		)
}

export class PackageDispatchFailed extends Schema.TaggedError<PackageDispatchFailed>()(
	'PackageDispatchFailed',
	{ reason: Schema.Literals(['error', 'timeout']), cause: Schema.Defect() },
) {}

export type DispatchResponse = Awaited<
	ReturnType<typeof dispatchAdminPackageSubscriptionEvent>
>[number]

export type SubscriberEvent = {
	readonly topic: string
	readonly eventId: string
	readonly params: Record<string, unknown>
	readonly idempotencyKey: (packageId: string) => string
	readonly actorTokenId: string
}

/** Admin and first-party package subscribers of an event topic. */
export class PackageSubscribers extends Context.Service<
	PackageSubscribers,
	{
		dispatch(
			event: SubscriberEvent,
		): Effect.Effect<
			ReadonlyArray<DispatchResponse>,
			PackageDispatchFailed,
			Background
		>
	}
>()('kody/newsletter/PackageSubscribers') {
	static readonly layer = (
		env: Env,
		additionalOwnerIds: ReadonlyArray<string> = [],
	) =>
		Layer.succeed(
			PackageSubscribers,
			PackageSubscribers.of({
				dispatch: Effect.fn('PackageSubscribers.dispatch')(function* (event) {
					yield* Effect.annotateCurrentSpan('package_event.topic', event.topic)
					const { waitUntil } = yield* Background
					return yield* Effect.tryPromise({
						try: () =>
							dispatchAdminPackageSubscriptionEvent({
								env,
								baseUrl: getAppBaseUrl({ env }),
								topic: event.topic,
								getParams: () => event.params,
								source: 'whats-new-consent',
								buildIdempotencyKey: (savedPackage) =>
									event.idempotencyKey(savedPackage.id),
								actorTokenId: event.actorTokenId,
								additionalOwnerIds,
								retryDiscoveryFailures: true,
								retryInvocationInfrastructureFailures: true,
								waitUntil,
							}),
						catch: (cause) =>
							new PackageDispatchFailed({ reason: 'error', cause }),
					}).pipe(
						Effect.timeoutOrElse({
							duration: '60 seconds',
							orElse: () =>
								Effect.fail(
									new PackageDispatchFailed({ reason: 'timeout', cause: null }),
								),
						}),
					)
				}),
			}),
		)
}

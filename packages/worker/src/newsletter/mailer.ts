import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect'
import { Background } from '#worker/effect/background.ts'
import {
	resolveTransactionalEmailConfig,
	type TransactionalEmailConfig,
} from '#app/email/sender-config.ts'
import { sendNewsletterConfirmationEmail } from '#worker/email/system-outbound.ts'

export class MailDeliveryError extends Schema.TaggedError<MailDeliveryError>()(
	'MailDeliveryError',
	{ cause: Schema.Defect() },
) {}

type MailerEnv = Parameters<typeof sendNewsletterConfirmationEmail>[0]['env'] &
	Parameters<typeof resolveTransactionalEmailConfig>[0]['env']

/** The reserved newsletter sender and its transactional email settings. */
export class NewsletterMailer extends Context.Service<
	NewsletterMailer,
	{
		readonly config: (
			requestUrl: string,
		) => Option.Option<TransactionalEmailConfig>
		readonly sendConfirmation: (message: {
			readonly to: string
			readonly subject: string
			readonly html: string
			readonly text: string
		}) => Effect.Effect<void, MailDeliveryError>
	}
>()('kody/newsletter/NewsletterMailer') {
	static layer(env: MailerEnv) {
		return Layer.effect(
			NewsletterMailer,
			Effect.gen(function* () {
				const background = yield* Background
				return NewsletterMailer.of({
					config: (requestUrl) =>
						Option.fromNullishOr(
							resolveTransactionalEmailConfig({
								env,
								requestUrl:
									env.WRANGLER_IS_LOCAL_DEV === 'true' ? requestUrl : undefined,
							}),
						),
					sendConfirmation: Effect.fn('NewsletterMailer.sendConfirmation')(
						function* (message) {
							const now = yield* DateTime.now
							yield* Effect.tryPromise({
								try: () =>
									sendNewsletterConfirmationEmail({
										env,
										...message,
										now: DateTime.toDate(now),
										waitUntil: background.waitUntil,
									}),
								catch: (cause) => new MailDeliveryError({ cause }),
							})
						},
					),
				})
			}),
		)
	}
}

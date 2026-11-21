import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { DateTime, Effect, Schema } from 'effect'
import { outbound } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'

export type PurgedItem = {
	readonly kind: 'org' | 'user'
	readonly id: OwnerId
}

/**
 * `PURGE_WEBHOOK_URL` did not accept a purge: a non-2xx `status`, or no
 * answer (`status` null, `cause` is the network error or timeout). The item's
 * rows stay and its claim is kept, so a later pass retries it.
 */
export class PurgeWebhookFailed extends Schema.TaggedError<PurgeWebhookFailed>()(
	'PurgeWebhookFailed',
	{
		kind: Schema.Literals(['org', 'user']),
		id: Schema.String,
		status: Schema.NullOr(Schema.Number),
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Tell `PURGE_WEBHOOK_URL` each item is about to be purged, in order, before
 * any of their D1 rows are deleted. Skipped when the URL is unset or empty.
 */
export const notifyPurgeWebhookEffect = Effect.fn('PurgeWebhook.notify')(
	function* (items: ReadonlyArray<PurgedItem>) {
		const url = (yield* WorkerEnv).PURGE_WEBHOOK_URL?.trim()
		if (!url) return
		for (const item of items) {
			const purgedAt = DateTime.formatIso(yield* DateTime.now)
			const response = yield* outbound('purge_webhook.post', async (signal) => {
				const res = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: item.kind, id: item.id, purgedAt }),
					signal,
				})
				await res.body?.cancel()
				return { ok: res.ok, status: res.status }
			}).pipe(
				Effect.mapError(
					(error) =>
						new PurgeWebhookFailed({
							...item,
							status: null,
							message: error.message,
							cause: error,
						}),
				),
			)
			if (!response.ok) {
				return yield* new PurgeWebhookFailed({
					...item,
					status: response.status,
					message: `Purge webhook failed with HTTP ${response.status}.`,
					cause: null,
				})
			}
		}
	},
)

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { retentionOutboundTimeoutMs } from '#app/retention.ts'
import type { RetentionContext } from '#worker/scheduled/retention/d1.ts'
import { RetentionError } from '#worker/scheduled/retention/failures.ts'
import { traced } from '#worker/scheduled/retention/telemetry.ts'
import { withTimeout } from '#worker/scheduled/retention/timeout.ts'

export type PurgeWebhookItem = { kind: 'org' | 'user'; id: OwnerId }

function purgeWebhookUrl(env: Env): string | null {
	const url = (
		env as Env & { PURGE_WEBHOOK_URL?: string }
	).PURGE_WEBHOOK_URL?.trim()
	return url ? url : null
}

/**
 * Tells `PURGE_WEBHOOK_URL` an item is about to lose its D1 rows. Skipped
 * when the URL is unset. A non-2xx response, network error, or timeout
 * throws a `purge_webhook_failed` RetentionError so the caller stops before
 * any row delete; a parent abort stays `aborted`.
 */
export function postPurgeWebhook(
	ctx: RetentionContext,
	input: { env: Env; item: PurgeWebhookItem },
): Promise<void> {
	const url = purgeWebhookUrl(input.env)
	if (url === null) return Promise.resolve()
	const { item } = input
	const operation = `soft_delete_purge.webhook_${item.kind}`
	const failed = (fields: { status: number | null; cause?: unknown }) =>
		new RetentionError({
			kind: 'purge_webhook_failed',
			operation,
			ownerKind: item.kind,
			ownerId: item.id,
			...fields,
		})
	return traced(
		`retention.${operation}`,
		{},
		async (span) => {
			let response: Response
			try {
				response = await withTimeout({
					operation,
					timeoutMs: retentionOutboundTimeoutMs,
					clock: ctx.clock,
					signal: ctx.signal,
					run: (signal) =>
						fetch(url, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								kind: item.kind,
								id: item.id,
								purgedAt: ctx.clock.now().toISOString(),
							}),
							signal,
						}),
				})
			} catch (error) {
				if (
					error instanceof RetentionError &&
					error.failure.kind === 'aborted'
				) {
					throw error
				}
				throw failed({ status: null, cause: error })
			}
			span.setAttribute('http.status_code', response.status)
			if (!response.ok) throw failed({ status: response.status })
		},
		ctx.clock,
	)
}

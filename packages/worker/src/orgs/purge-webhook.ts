import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type DeadlineClock,
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'

/** One org or person whose D1 rows the soft-delete purge is about to delete. */
export type PurgeWebhookItem = { kind: 'org' | 'user'; id: OwnerId }

/**
 * Runs after billing cleanup and before the purge deletes any D1 rows for
 * `items`. A throw leaves every listed item's rows in place.
 */
export type BeforePurgeRowDeletes = (
	items: ReadonlyArray<PurgeWebhookItem>,
) => Promise<void>

/**
 * The purge webhook answered non-2xx (`status`), or the request failed or
 * timed out (`cause`). The item's D1 rows stay and its claim fence is kept,
 * so a later pass retries it.
 */
export class PurgeWebhookFailed extends Error {
	readonly item: PurgeWebhookItem
	readonly status: number | null
	constructor(
		item: PurgeWebhookItem,
		failure: { status: number } | { cause: unknown },
	) {
		const status = 'status' in failure ? failure.status : null
		super(
			status == null
				? `Purge webhook request failed for ${item.kind}.`
				: `Purge webhook returned HTTP ${status} for ${item.kind}.`,
			'cause' in failure ? { cause: failure.cause } : undefined,
		)
		this.name = 'PurgeWebhookFailed'
		this.item = item
		this.status = status
	}
}

export function purgeWebhookUrl(env: Env): string | null {
	return (
		(env as Env & { PURGE_WEBHOOK_URL?: string }).PURGE_WEBHOOK_URL?.trim() ||
		null
	)
}

/**
 * POST each item to `PURGE_WEBHOOK_URL`, in order, and stop at the first
 * failure. Skipped when the URL is unset or empty.
 */
export async function sendPurgeWebhooks(input: {
	env: Env
	items: ReadonlyArray<PurgeWebhookItem>
	clock?: DeadlineClock
}): Promise<void> {
	const url = purgeWebhookUrl(input.env)
	if (!url) return
	const purgedAt = new Date().toISOString()
	for (const item of input.items) {
		let response: Response
		try {
			response = await withDeadline(
				{
					label: 'soft_delete_purge.purgeWebhook',
					timeoutMs: outboundTimeoutMs.http,
					clock: input.clock,
				},
				(signal) =>
					fetch(url, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							kind: item.kind,
							id: item.id,
							purgedAt,
						}),
						signal,
					}),
			)
		} catch (cause) {
			throw new PurgeWebhookFailed(item, { cause })
		}
		if (!response.ok) {
			throw new PurgeWebhookFailed(item, { status: response.status })
		}
	}
}

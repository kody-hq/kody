import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

export const purgeWebhookTimeoutMs = 10_000

export type PurgeWebhookItem = { kind: 'org' | 'user'; id: OwnerId }

/**
 * The purge webhook for one item answered non-2xx, threw, or timed out. The
 * item's D1 rows stay and its claim fence is kept, so a later pass retries it.
 */
export class PurgeWebhookFailed extends Error {
	readonly kind: PurgeWebhookItem['kind']
	readonly id: OwnerId
	readonly status: number | null

	constructor(
		item: PurgeWebhookItem,
		failure: { status: number } | { cause: unknown },
	) {
		const status = 'status' in failure ? failure.status : null
		const reason =
			'cause' in failure
				? failure.cause instanceof Error &&
					failure.cause.name === 'TimeoutError'
					? 'timeout'
					: 'network_error'
				: `status_${status}`
		super(
			`purge_webhook_failed:${item.kind}:${reason}`,
			'cause' in failure ? { cause: failure.cause } : undefined,
		)
		this.name = 'PurgeWebhookFailed'
		this.kind = item.kind
		this.id = item.id
		this.status = status
	}
}

export function purgeWebhookUrl(env: Env): string | null {
	return env.PURGE_WEBHOOK_URL?.trim() || null
}

/**
 * POST each item to `PURGE_WEBHOOK_URL` in order, stopping at the first
 * failure. A personal org plus person pair is posted together so a failure
 * for either half keeps both halves' rows. Skipped when the URL is unset.
 */
export async function postPurgeWebhooks(input: {
	env: Env
	items: ReadonlyArray<PurgeWebhookItem>
	purgedAt: string
}): Promise<void> {
	const url = purgeWebhookUrl(input.env)
	if (!url) return
	for (const item of input.items) {
		let response: Response
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: item.kind,
					id: item.id,
					purgedAt: input.purgedAt,
				}),
				// A hung receiver must not block the sequential purge pass.
				signal: AbortSignal.timeout(purgeWebhookTimeoutMs),
			})
		} catch (cause) {
			throw new PurgeWebhookFailed(item, { cause })
		}
		await response.body?.cancel()
		if (!response.ok)
			throw new PurgeWebhookFailed(item, { status: response.status })
	}
}

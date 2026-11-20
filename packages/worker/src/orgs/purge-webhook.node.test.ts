import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { retentionOutboundTimeoutMs } from '#app/retention.ts'
import { RetentionError } from '#worker/scheduled/retention/failures.ts'
import { createManualClock } from '#worker/test-support/manual-clock.ts'
import { postPurgeWebhook } from './purge-webhook.ts'

const webhookUrl = 'https://hooks.example.com/purge'
const item = { kind: 'org' as const, id: ownerIdFromStored('org-webhook') }

function setup(url: string | undefined) {
	const clock = createManualClock('2026-03-01T00:00:00.000Z')
	const ctx = { db: {} as D1Database, clock }
	const env = { PURGE_WEBHOOK_URL: url } as unknown as Env
	return { clock, ctx, env }
}

function stubFetch(impl: (init: RequestInit) => Promise<Response>) {
	const fetchMock = vi.fn((_url: string, init: RequestInit) => impl(init))
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

async function webhookFailure(promise: Promise<void>) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(RetentionError)
	return (error as RetentionError).failure
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test.each([undefined, '', '  '])(
	'postPurgeWebhook is skipped when PURGE_WEBHOOK_URL is %j',
	async (url) => {
		const fetchMock = stubFetch(async () => new Response(null))
		const { ctx, env } = setup(url)
		await postPurgeWebhook(ctx, { env, item })
		expect(fetchMock).not.toHaveBeenCalled()
	},
)

test('postPurgeWebhook POSTs the item kind, id, and purge time as JSON', async () => {
	const fetchMock = stubFetch(async () => new Response(null, { status: 204 }))
	const { ctx, env } = setup(webhookUrl)
	await postPurgeWebhook(ctx, { env, item })
	expect(fetchMock).toHaveBeenCalledTimes(1)
	const [url, init] = fetchMock.mock.calls[0]!
	expect(url).toBe(webhookUrl)
	expect(init.method).toBe('POST')
	expect(init.headers).toEqual({ 'content-type': 'application/json' })
	expect(init.signal).toBeInstanceOf(AbortSignal)
	expect(JSON.parse(String(init.body))).toEqual({
		kind: 'org',
		id: 'org-webhook',
		purgedAt: '2026-03-01T00:00:00.000Z',
	})
})

test('postPurgeWebhook turns a non-2xx response or network error into PurgeWebhookFailed', async () => {
	const { ctx, env } = setup(webhookUrl)
	stubFetch(async () => new Response('nope', { status: 503 }))
	expect(await webhookFailure(postPurgeWebhook(ctx, { env, item }))).toEqual({
		kind: 'purge_webhook_failed',
		operation: 'soft_delete_purge.webhook_org',
		ownerKind: 'org',
		ownerId: 'org-webhook',
		status: 503,
	})
	const networkError = new TypeError('fetch failed')
	stubFetch(async () => {
		throw networkError
	})
	expect(
		await webhookFailure(postPurgeWebhook(ctx, { env, item })),
	).toMatchObject({ status: null, cause: networkError })
})

test('postPurgeWebhook times out with PurgeWebhookFailed and aborts the request', async () => {
	const { clock, ctx, env } = setup(webhookUrl)
	let requestSignal: AbortSignal | undefined
	stubFetch(
		(init) =>
			new Promise<Response>(() => {
				requestSignal = init.signal ?? undefined
			}),
	)
	const failure = webhookFailure(postPurgeWebhook(ctx, { env, item }))
	await clock.advance(retentionOutboundTimeoutMs)
	const settled = await failure
	expect(settled).toMatchObject({ kind: 'purge_webhook_failed', status: null })
	expect(
		settled.kind === 'purge_webhook_failed' &&
			settled.cause instanceof RetentionError &&
			settled.cause.failure.kind,
	).toBe('timed_out')
	expect(requestSignal?.aborted).toBe(true)
	expect(clock.pendingTimers()).toBe(0)
})

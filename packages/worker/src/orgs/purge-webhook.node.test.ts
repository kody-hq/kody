import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import {
	postPurgeWebhooks,
	PurgeWebhookFailed,
	purgeWebhookTimeoutMs,
} from './purge-webhook.ts'

const purgedAt = '2026-10-01T12:00:00.000Z'
const url = 'https://hooks.example.test/purge'
const orgItem = { kind: 'org' as const, id: 'org-1' as OwnerId }
const userItem = { kind: 'user' as const, id: 'user-1' as OwnerId }

function envWith(webhookUrl: string | undefined) {
	return { PURGE_WEBHOOK_URL: webhookUrl } as unknown as Env
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

test('purge webhook is skipped when PURGE_WEBHOOK_URL is unset or empty', async () => {
	const fetchMock = vi.fn()
	vi.stubGlobal('fetch', fetchMock)
	for (const webhookUrl of [undefined, '', '   ']) {
		await postPurgeWebhooks({
			env: envWith(webhookUrl),
			items: [userItem, orgItem],
			purgedAt,
		})
	}
	expect(fetchMock).not.toHaveBeenCalled()
})

test('purge webhook POSTs each item as JSON with the outbound timeout', async () => {
	const timeout = vi.spyOn(AbortSignal, 'timeout')
	const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetchMock)
	await postPurgeWebhooks({
		env: envWith(url),
		items: [userItem, orgItem],
		purgedAt,
	})
	expect(fetchMock).toHaveBeenCalledTimes(2)
	expect(timeout).toHaveBeenCalledWith(purgeWebhookTimeoutMs)
	expect(purgeWebhookTimeoutMs).toBe(10_000)
	const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
	expect(calls.map(([target, init]) => [target, init.method])).toEqual([
		[url, 'POST'],
		[url, 'POST'],
	])
	expect(calls[0]![1].headers).toEqual({ 'content-type': 'application/json' })
	expect(calls[0]![1].signal).toBeInstanceOf(AbortSignal)
	expect(calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
		{ kind: 'user', id: 'user-1', purgedAt },
		{ kind: 'org', id: 'org-1', purgedAt },
	])
})

test('a non-2xx purge webhook response is PurgeWebhookFailed with the status and stops the pair', async () => {
	const fetchMock = vi.fn(async () => new Response('down', { status: 503 }))
	vi.stubGlobal('fetch', fetchMock)
	const failure = await postPurgeWebhooks({
		env: envWith(url),
		items: [userItem, orgItem],
		purgedAt,
	}).catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(PurgeWebhookFailed)
	expect(failure).toMatchObject({
		name: 'PurgeWebhookFailed',
		kind: 'user',
		id: 'user-1',
		status: 503,
		message: 'purge_webhook_failed:user:status_503',
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('a timed out purge webhook is PurgeWebhookFailed carrying the abort cause', async () => {
	const realTimeout = AbortSignal.timeout.bind(AbortSignal)
	const timeout = vi
		.spyOn(AbortSignal, 'timeout')
		.mockImplementation(() => realTimeout(5))
	vi.stubGlobal(
		'fetch',
		vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal!.addEventListener('abort', () =>
						reject(init.signal!.reason),
					)
				}),
		),
	)
	const failure = await postPurgeWebhooks({
		env: envWith(url),
		items: [orgItem],
		purgedAt,
	}).catch((error: unknown) => error)
	expect(timeout).toHaveBeenCalledWith(purgeWebhookTimeoutMs)
	expect(failure).toBeInstanceOf(PurgeWebhookFailed)
	expect(failure).toMatchObject({
		kind: 'org',
		id: 'org-1',
		status: null,
		message: 'purge_webhook_failed:org:timeout',
	})
	expect((failure as PurgeWebhookFailed).cause).toMatchObject({
		name: 'TimeoutError',
	})
})

test('a purge webhook network error is PurgeWebhookFailed carrying the cause', async () => {
	const cause = new TypeError('fetch failed')
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw cause
		}),
	)
	const failure = await postPurgeWebhooks({
		env: envWith(url),
		items: [orgItem],
		purgedAt,
	}).catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(PurgeWebhookFailed)
	expect(failure).toMatchObject({
		status: null,
		message: 'purge_webhook_failed:org:network_error',
	})
	expect((failure as PurgeWebhookFailed).cause).toBe(cause)
})

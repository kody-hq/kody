import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import {
	type DeadlineClock,
	DeadlineExceededError,
	outboundTimeoutMs,
} from '#worker/outbound/with-deadline.ts'
import { PurgeWebhookFailed, sendPurgeWebhooks } from './purge-webhook.ts'

const hookUrl = 'https://hooks.example.com/purge'
const orgItem = { kind: 'org' as const, id: ownerIdFromStored('org-hook') }
const userItem = { kind: 'user' as const, id: ownerIdFromStored('user-hook') }

function envWithHook(url: string | undefined) {
	return { PURGE_WEBHOOK_URL: url } as unknown as Env
}

function manualClock() {
	const timers: Array<{ ms: number; fire: () => void }> = []
	const clock: DeadlineClock = {
		setTimer: (ms, onExpire) => {
			timers.push({ ms, fire: onExpire })
			return () => {}
		},
	}
	return { clock, timers }
}

afterEach(() => {
	vi.unstubAllGlobals()
})

test('sendPurgeWebhooks skips the request when PURGE_WEBHOOK_URL is unset or empty', async () => {
	const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
	vi.stubGlobal('fetch', fetchMock)

	for (const url of [undefined, '', '   ']) {
		await expect(
			sendPurgeWebhooks({ env: envWithHook(url), items: [orgItem] }),
		).resolves.toBeUndefined()
	}

	expect(fetchMock).not.toHaveBeenCalled()
})

test('sendPurgeWebhooks POSTs kind, id, and an ISO purgedAt as JSON for each item', async () => {
	const fetchMock = vi.fn(
		async (_url: string, _init: RequestInit) =>
			new Response(null, { status: 204 }),
	)
	vi.stubGlobal('fetch', fetchMock)

	await sendPurgeWebhooks({
		env: envWithHook(hookUrl),
		items: [userItem, orgItem],
	})

	expect(fetchMock).toHaveBeenCalledTimes(2)
	const bodies = fetchMock.mock.calls.map(([url, init]) => {
		expect(url).toBe(hookUrl)
		expect(init.method).toBe('POST')
		expect(init.headers).toEqual({ 'content-type': 'application/json' })
		expect(init.signal).toBeInstanceOf(AbortSignal)
		return JSON.parse(String(init.body)) as Record<string, unknown>
	})
	expect(bodies).toEqual([
		{ kind: 'user', id: userItem.id, purgedAt: expect.any(String) },
		{ kind: 'org', id: orgItem.id, purgedAt: expect.any(String) },
	])
	const purgedAt = String(bodies[0]?.purgedAt)
	expect(new Date(purgedAt).toISOString()).toBe(purgedAt)
	expect(bodies[1]?.purgedAt).toBe(purgedAt)
})

test('sendPurgeWebhooks throws PurgeWebhookFailed with the status on a non-2xx response and stops', async () => {
	const fetchMock = vi.fn(async () => new Response('nope', { status: 503 }))
	vi.stubGlobal('fetch', fetchMock)

	const error = await sendPurgeWebhooks({
		env: envWithHook(hookUrl),
		items: [userItem, orgItem],
	}).catch((caught: unknown) => caught)

	expect(error).toBeInstanceOf(PurgeWebhookFailed)
	expect(error).toMatchObject({
		name: 'PurgeWebhookFailed',
		item: userItem,
		status: 503,
	})
	expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('sendPurgeWebhooks throws PurgeWebhookFailed carrying the cause on a network error', async () => {
	const networkError = new TypeError('fetch failed')
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			throw networkError
		}),
	)

	const error = await sendPurgeWebhooks({
		env: envWithHook(hookUrl),
		items: [orgItem],
	}).catch((caught: unknown) => caught)

	expect(error).toBeInstanceOf(PurgeWebhookFailed)
	expect(error).toMatchObject({ item: orgItem, status: null })
	expect((error as PurgeWebhookFailed).cause).toBe(networkError)
})

test('sendPurgeWebhooks aborts on the outbound http deadline and throws PurgeWebhookFailed with the timeout as its cause', async () => {
	const { clock, timers } = manualClock()
	let seenSignal: AbortSignal | undefined
	vi.stubGlobal(
		'fetch',
		vi.fn((_url: string, init: RequestInit) => {
			seenSignal = init.signal ?? undefined
			return new Promise<never>(() => {})
		}),
	)

	const pending = sendPurgeWebhooks({
		env: envWithHook(hookUrl),
		items: [orgItem],
		clock,
	}).catch((caught: unknown) => caught)
	await vi.waitFor(() => expect(timers).toHaveLength(1))
	expect(timers[0]?.ms).toBe(outboundTimeoutMs.http)
	timers[0]?.fire()
	const error = await pending

	expect(error).toBeInstanceOf(PurgeWebhookFailed)
	expect(error).toMatchObject({ item: orgItem, status: null })
	const cause = (error as PurgeWebhookFailed).cause
	expect(cause).toBeInstanceOf(DeadlineExceededError)
	expect(cause).toMatchObject({ label: 'soft_delete_purge.purgeWebhook' })
	expect(seenSignal?.aborted).toBe(true)
})

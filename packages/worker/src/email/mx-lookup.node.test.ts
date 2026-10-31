import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	lookupMxViaDoh,
	providerKeyFromMxHost,
	providerKeysFromMxHosts,
	resolveRecipientMxProviders,
} from './mx-lookup.ts'

test('providerKeyFromMxHost collapses Fastmail and SimpleLogin hosts', () => {
	expect(providerKeyFromMxHost('in1-smtp.messagingengine.com.')).toBe(
		'messagingengine.com',
	)
	expect(providerKeyFromMxHost('mx1.simplelogin.co')).toBe('simplelogin.co')
	expect(providerKeyFromMxHost('aspmx.l.google.com')).toBe('google.com')
	expect(providerKeyFromMxHost('mx.example.co.uk')).toBe('example.co.uk')
	expect(providerKeyFromMxHost('')).toBeNull()
})

test('resolveRecipientMxProviders caches DoH answers in D1', async () => {
	const cache = new Map<string, string>()
	const db = {
		prepare(sql: string) {
			return {
				bind(...binds: Array<unknown>) {
					return {
						async first<T>() {
							if (sql.includes('FROM email_mx_lookup_cache')) {
								const domain = String(binds[0])
								const raw = cache.get(domain)
								return raw ? (JSON.parse(raw) as T) : null
							}
							return null
						},
						async run() {
							if (sql.includes('INSERT INTO email_mx_lookup_cache')) {
								cache.set(
									String(binds[0]),
									JSON.stringify({
										provider_keys_json: binds[1],
										mx_hosts_json: binds[2],
										expires_at: binds[4],
									}),
								)
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	let fetchCount = 0
	const fetchImpl = (async () => {
		fetchCount += 1
		return new Response(
			JSON.stringify({
				Status: 0,
				Answer: [
					{
						type: 15,
						TTL: 300,
						data: '10 in1-smtp.messagingengine.com.',
					},
					{
						type: 15,
						TTL: 300,
						data: '20 in2-smtp.messagingengine.com.',
					},
				],
			}),
			{ status: 200 },
		)
	}) as typeof fetch

	const first = await resolveRecipientMxProviders({
		db,
		recipientOrDomain: 'accounts+kody@coderunr.net',
		now: new Date('2026-10-17T12:00:00.000Z'),
		fetchImpl,
	})
	expect(first).toMatchObject({
		domain: 'coderunr.net',
		fromCache: false,
		providerKeys: ['messagingengine.com'],
	})
	expect(providerKeysFromMxHosts(first.mxHosts)).toEqual([
		'messagingengine.com',
	])
	expect(fetchCount).toBe(1)

	const second = await resolveRecipientMxProviders({
		db,
		recipientOrDomain: 'coderunr.net',
		now: new Date('2026-10-17T12:05:00.000Z'),
		fetchImpl,
	})
	expect(second.fromCache).toBe(true)
	expect(second.providerKeys).toEqual(['messagingengine.com'])
	expect(fetchCount).toBe(1)
})

test('lookupMxViaDoh fails open on a malformed DoH body', async () => {
	consoleWarn.mockImplementation(() => {})
	const result = await lookupMxViaDoh(
		'example.com',
		async () => new Response('not json', { status: 200 }),
	)
	expect(result.mxHosts).toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-mx-doh-parse-failed',
		expect.anything(),
	)
})

import { expect, test } from 'vitest'
import {
	redactConnectTicket,
	redactKodyCredentialsInSentryEvent,
} from './sentry-options.ts'

test('connect tickets never reach Sentry', () => {
	expect(
		redactConnectTicket(
			'https://api.test/v1/execution-contexts/connect?ticket=ec_a.secret&x=1',
		),
	).toBe('https://api.test/v1/execution-contexts/connect?ticket=[redacted]&x=1')
	expect(redactConnectTicket('ticket=ec_a.secret')).toBe('ticket=[redacted]')
	const event = redactKodyCredentialsInSentryEvent({
		type: undefined,
		request: {
			url: 'https://api.test/v1/execution-contexts/connect?ticket=ec_a.s',
			query_string: 'ticket=ec_a.s',
		},
	})
	expect(event.request?.url).not.toContain('ec_a.s')
	expect(event.request?.query_string).toBe('ticket=[redacted]')
})

test('deep redaction covers breadcrumbs, extras, contexts, headers, and URLs', () => {
	const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const bootstrap = `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`
	const event = redactKodyCredentialsInSentryEvent({
		type: undefined,
		message: `failed with ${apiToken}`,
		exception: { values: [{ value: `boom ${bootstrap}` }] },
		breadcrumbs: [
			{
				category: 'fetch',
				data: {
					url: 'https://upstream.test/cb?code=oauth-code&secret=hunter2&state=ok',
					headers: { Authorization: 'Bearer upstream-access-token' },
				},
				message: 'Authorization: Bearer abcdef123456',
			},
		],
		extra: { nested: { deeper: [{ note: `token ${apiToken}` }] } },
		contexts: { upstream: { refresh_token: 'rt-secret', ok: 'kept' } },
		request: {
			url: 'https://kody.test/claim?access_token=at-secret&page=2',
			query_string: 'ticket=ec_a.s&page=2',
			headers: {
				authorization: 'Basic dXNlcjpwYXNz',
				Cookie: 'session=abc',
				'user-agent': 'vitest',
			},
			cookies: { session: 'abc' },
		},
	})
	const serialized = JSON.stringify(event)
	for (const secret of [
		apiToken,
		bootstrap,
		'oauth-code',
		'hunter2',
		'upstream-access-token',
		'abcdef123456',
		'rt-secret',
		'at-secret',
		'ec_a.s',
		'dXNlcjpwYXNz',
		'session=abc',
	]) {
		expect(serialized).not.toContain(secret)
	}
	expect(serialized).toContain('secret=[redacted]')
	expect(serialized).toContain('state=ok')
	expect(serialized).toContain('page=2')
	expect(serialized).toContain('vitest')
	expect(serialized).toContain('kept')
})

test('deep redaction tolerates cycles', () => {
	const extra: Record<string, unknown> = { authorization: 'Bearer zzzzzzzz' }
	extra.self = extra
	const event = redactKodyCredentialsInSentryEvent({
		type: undefined,
		extra,
	})
	expect((event.extra as Record<string, unknown>).authorization).toBe(
		'[redacted]',
	)
})

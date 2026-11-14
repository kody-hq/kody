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

test('query redaction decodes percent-encoded names and object query_string', () => {
	const event = redactKodyCredentialsInSentryEvent({
		type: undefined,
		message: 'redirect=https://app.test/cb?code=nested-code&state=ok',
		request: {
			url: 'https://kody.test/oauth/callback?%63ode=auth-code&password=alpha?omega&state=ok',
			query_string: {
				code: 'object-code',
				'%63ode': 'encoded-object-code',
				state: 'kept-state',
			},
		},
		extra: { code: 'status-kept', nested: { code: 404 } },
	})
	const serialized = JSON.stringify(event)
	for (const secret of [
		'auth-code',
		'object-code',
		'encoded-object-code',
		'nested-code',
		'alpha?omega',
		'omega',
	]) {
		expect(serialized).not.toContain(secret)
	}
	expect(event.message).toBe(
		'redirect=https://app.test/cb?code=[redacted]&state=ok',
	)
	expect(event.request?.url).toContain('password=[redacted]')
	expect(event.request?.url).not.toContain('?omega')
	expect(event.request?.url).toContain('%63ode=[redacted]')
	expect(event.request?.url).toContain('state=ok')
	expect(event.request?.query_string).toEqual({
		code: '[redacted]',
		'%63ode': '[redacted]',
		state: 'kept-state',
	})
	expect(event.extra).toEqual({ code: 'status-kept', nested: { code: 404 } })

	const headerQuery = redactKodyCredentialsInSentryEvent({
		type: undefined,
		request: {
			query_string: {
				'x-api-key': 'upstream-credential',
				authorization: 'Bearer keep-header-shape',
				state: 'kept',
			},
		},
	})
	expect(headerQuery.request?.query_string).toEqual({
		'x-api-key': '[redacted]',
		authorization: '[redacted]',
		state: 'kept',
	})
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

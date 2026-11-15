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
	expect(
		redactKodyCredentialsInSentryEvent({
			type: undefined,
			message: 'path?a;code=semicolon-code&password=alpha;beta',
		}).message,
	).toBe('path?a;code=[redacted]&password=[redacted]')
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
				'%78-api-key': 'encoded-upstream-credential',
				authorization: 'Bearer keep-header-shape',
				state: 'kept',
			},
		},
	})
	expect(headerQuery.request?.query_string).toEqual({
		'x-api-key': '[redacted]',
		'%78-api-key': '[redacted]',
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

test('deep redaction skips getter-only and frozen props without throwing', () => {
	const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const withGetterOnly = {
		authorization: 'Bearer writable-secret',
		nested: { note: `token ${apiToken}` },
	}
	Object.defineProperty(withGetterOnly, '$', {
		enumerable: true,
		configurable: false,
		get() {
			return { kept: 'accessor-child' }
		},
	})
	const freshSensitiveGetter: Record<string, unknown> = {}
	Object.defineProperty(freshSensitiveGetter, '$', {
		enumerable: true,
		configurable: false,
		get() {
			return { authorization: 'Bearer accessor-secret' }
		},
	})
	const getterWithSetter: Record<string, unknown> = {}
	Object.defineProperty(getterWithSetter, '$', {
		enumerable: true,
		configurable: true,
		get() {
			return { authorization: 'Bearer getter-setter-secret' }
		},
		set(_value: unknown) {},
	})
	const frozenSensitive = Object.freeze({
		authorization: 'Bearer frozen-secret',
		ok: 'kept-frozen',
	})
	const sharedFrozen = Object.freeze({
		authorization: 'Bearer shared-secret',
		ok: 'kept-shared',
	})
	const frozenQuery = Object.freeze({
		code: 'frozen-query-code',
		state: 'kept-query-state',
	})
	const frozenArray = Object.freeze([
		`Bearer array-secret-token`,
		{ refresh_token: 'rt-in-frozen-array' },
	])

	const event = redactKodyCredentialsInSentryEvent({
		type: undefined,
		extra: withGetterOnly,
		contexts: {
			frozen: frozenSensitive,
			fresh: freshSensitiveGetter,
			getterSetter: getterWithSetter,
			aliases: { first: sharedFrozen, second: sharedFrozen },
		},
		request: { query_string: frozenQuery },
		breadcrumbs: [{ data: { items: frozenArray } }],
	})
	const serialized = JSON.stringify(event)
	for (const secret of [
		'writable-secret',
		apiToken,
		'frozen-secret',
		'shared-secret',
		'accessor-secret',
		'getter-setter-secret',
		'frozen-query-code',
		'array-secret-token',
		'rt-in-frozen-array',
	]) {
		expect(serialized).not.toContain(secret)
	}
	expect(serialized).toContain('accessor-child')
	expect(serialized).toContain('kept-frozen')
	expect(serialized).toContain('kept-shared')
	expect(serialized).toContain('kept-query-state')
	expect((event.extra as Record<string, unknown>).authorization).toBe(
		'[redacted]',
	)
	expect(
		(event.contexts as { frozen: Record<string, unknown> }).frozen
			.authorization,
	).toBe('[redacted]')
	const aliases = (
		event.contexts as {
			aliases: {
				first: Record<string, unknown>
				second: Record<string, unknown>
			}
		}
	).aliases
	expect(aliases.first.authorization).toBe('[redacted]')
	expect(aliases.second.authorization).toBe('[redacted]')
	expect(aliases.first).toBe(aliases.second)

	const cyclic: Record<string, unknown> = {
		child: {} as Record<string, unknown>,
		authorization: 'Bearer cycle-secret',
	}
	;(cyclic.child as Record<string, unknown>).ref = cyclic
	Object.freeze(cyclic)
	const cyclicEvent = redactKodyCredentialsInSentryEvent({
		type: undefined,
		extra: cyclic,
	})
	const cyclicExtra = cyclicEvent.extra as {
		authorization: string
		child: { ref: { authorization: string } }
	}
	expect(cyclicExtra.authorization).toBe('[redacted]')
	expect(cyclicExtra.child.ref).toBe(cyclicExtra)
	expect(cyclicExtra.child.ref.authorization).toBe('[redacted]')
	expect(cyclicExtra).not.toBe(cyclic)

	// Generic walk keeps status `code`; query_string walk must still redact it
	// when the same frozen object is reused (extra before request key order).
	const sharedCode = Object.freeze({ code: 'oauth-secret', state: 'kept' })
	const sharedOrder = redactKodyCredentialsInSentryEvent({
		type: undefined,
		extra: { cached: sharedCode },
		request: { query_string: sharedCode },
	})
	expect((sharedOrder.extra as { cached: { code: unknown } }).cached.code).toBe(
		'oauth-secret',
	)
	expect(
		(sharedOrder.request as { query_string: { code: string; state: string } })
			.query_string,
	).toEqual({ code: '[redacted]', state: 'kept' })

	const mutableShared: Record<string, unknown> = {
		code: 404,
		state: 'kept-mutable',
	}
	const mutableOrder = redactKodyCredentialsInSentryEvent({
		type: undefined,
		extra: { cached: mutableShared },
		request: { query_string: mutableShared },
	})
	expect(
		(mutableOrder.extra as { cached: Record<string, unknown> }).cached.code,
	).toBe(404)
	expect(
		(mutableOrder.request as { query_string: Record<string, unknown> })
			.query_string,
	).toEqual({ code: '[redacted]', state: 'kept-mutable' })
	expect((mutableOrder.extra as { cached: unknown }).cached).not.toBe(
		(mutableOrder.request as { query_string: unknown }).query_string,
	)

	const cyclicQuery: Record<string, unknown> = {
		code: 'oauth-cycle-secret',
		state: 'kept-cycle',
	}
	cyclicQuery.self = cyclicQuery
	Object.freeze(cyclicQuery)
	const cyclicQueryEvent = redactKodyCredentialsInSentryEvent({
		type: undefined,
		request: { query_string: cyclicQuery },
	})
	const cyclicQueryString = (
		cyclicQueryEvent.request as {
			query_string: {
				code: string
				state: string
				self: { code: string }
			}
		}
	).query_string
	expect(cyclicQueryString.code).toBe('[redacted]')
	expect(cyclicQueryString.state).toBe('kept-cycle')
	expect(cyclicQueryString.self).toBe(cyclicQueryString)
	expect(cyclicQueryString.self.code).toBe('[redacted]')
})

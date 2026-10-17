import { expect, test, vi } from 'vitest'
import {
	defaultParseSearch,
	defaultStringifySearch,
} from '@tanstack/react-router'
vi.mock('#start/server/credentials', () => ({ loadCredentialsPage: vi.fn() }))
import {
	credentialsPageQuery,
	validateCredentialSearch,
} from './credentials-query.ts'

test.each(['123', 'true', 'false', 'null', '"hello"', '[]', '{}', ' 123 '])(
	'credential search preserves Router text %s',
	(q) => {
		const parsed = defaultParseSearch(defaultStringifySearch({ q }))
		expect(validateCredentialSearch(parsed).q).toBe(q)
	},
)

test.each(['123', 'true', 'null'])(
	'credential bookmarks retain text %s',
	(q) => {
		expect(validateCredentialSearch(defaultParseSearch(`?q=${q}`)).q).toBe(q)
	},
)

test('credential resource keys isolate actors, orgs and selections without presentation filters', () => {
	const key = credentialsPageQuery('actor', { orgSlug: 'acme' }).queryKey
	expect(key).toEqual([
		'page',
		'actor',
		'loadCredentialsPage',
		{ orgSlug: 'acme' },
	])
	expect(
		credentialsPageQuery('other', { orgSlug: 'acme' }).queryKey,
	).not.toEqual(key)
	expect(
		credentialsPageQuery('actor', { orgSlug: 'other' }).queryKey,
	).not.toEqual(key)
	expect(
		credentialsPageQuery('actor', { orgSlug: 'acme', credentialId: 'one' })
			.queryKey,
	).not.toEqual(key)
	expect(
		credentialsPageQuery('actor', { orgSlug: 'acme' }).meta?.freshAuthorization,
	).toBe(true)
})

test('filter validation preserves valid values and rejects unsupported kinds and scopes', () => {
	expect(
		validateCredentialSearch({
			kind: 'secret',
			scope: 'org',
			packageScoped: 'false',
			locked: 'package-id',
			q: ' key ',
		}),
	).toEqual({
		kind: 'secret',
		scope: 'org',
		packageScoped: false,
		locked: 'package-id',
		q: ' key ',
	})
	expect(
		validateCredentialSearch({ kind: ['oauth', 'invalid'], scope: 'any' }).kind,
	).toEqual(['oauth'])
	expect(
		validateCredentialSearch({ kind: 'invalid', scope: 'any' }).scope,
	).toBeUndefined()
})

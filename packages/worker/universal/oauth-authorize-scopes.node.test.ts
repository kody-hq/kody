import { expect, test } from 'vitest'
import {
	authorizeHostRequiresScopes,
	buildMissingAuthorizeScopesError,
	defaultScopesForAuthorizeHost,
	pickAuthorizeScopeHost,
	resolveAuthorizeRequestScopes,
} from './oauth-authorize-scopes.ts'

test('Google authorize host requires scopes and supplies openid defaults', () => {
	expect(authorizeHostRequiresScopes('accounts.google.com')).toBe(true)
	expect(defaultScopesForAuthorizeHost('accounts.google.com')).toEqual([
		'openid',
		'email',
		'profile',
	])
	expect(authorizeHostRequiresScopes('github.com')).toBe(false)
	expect(defaultScopesForAuthorizeHost('github.com')).toEqual([])
})

test('resolveAuthorizeRequestScopes keeps explicit scopes and fills Google defaults when empty', () => {
	expect(
		resolveAuthorizeRequestScopes({
			scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
			authorizeHost: 'accounts.google.com',
			fillDefaults: true,
		}),
	).toEqual({
		ok: true,
		scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
		filledFromDefaults: false,
	})

	expect(
		resolveAuthorizeRequestScopes({
			scopes: [],
			authorizeHost: 'accounts.google.com',
			fillDefaults: true,
		}),
	).toEqual({
		ok: true,
		scopes: ['openid', 'email', 'profile'],
		filledFromDefaults: true,
	})
})

test('resolveAuthorizeRequestScopes refuses empty scopes for requiring hosts without defaults', () => {
	const result = resolveAuthorizeRequestScopes({
		scopes: [],
		authorizeHost: 'slack.com',
		fillDefaults: true,
	})
	expect(result).toEqual({
		ok: false,
		error: buildMissingAuthorizeScopesError('slack.com'),
	})
	expect(result.ok).toBe(false)
	if (result.ok) return
	expect(result.error).toContain('requires OAuth scopes')
	expect(result.error).toContain('will not redirect')
})

test('resolveAuthorizeRequestScopes allows empty scopes for hosts that do not require them', () => {
	expect(
		resolveAuthorizeRequestScopes({
			scopes: [],
			authorizeHost: 'github.com',
			fillDefaults: true,
		}),
	).toEqual({ ok: true, scopes: [], filledFromDefaults: false })
})

test('resolveAuthorizeRequestScopes can refuse empty Google scopes when fillDefaults is off', () => {
	const result = resolveAuthorizeRequestScopes({
		scopes: [],
		authorizeHost: 'accounts.google.com',
		fillDefaults: false,
	})
	expect(result.ok).toBe(false)
	if (result.ok) return
	expect(result.error).toContain('accounts.google.com')
})

test('pickAuthorizeScopeHost prefers a host that requires scopes', () => {
	expect(
		pickAuthorizeScopeHost([
			'oauth2.googleapis.com',
			'accounts.google.com',
			'www.googleapis.com',
		]),
	).toBe('oauth2.googleapis.com')
	expect(pickAuthorizeScopeHost(['github.com', 'api.github.com'])).toBe(
		'github.com',
	)
})

test('Google device and token hosts require scopes with the same defaults', () => {
	for (const host of [
		'accounts.google.com',
		'oauth2.googleapis.com',
		'openidconnect.googleapis.com',
	]) {
		expect(authorizeHostRequiresScopes(host)).toBe(true)
		expect(defaultScopesForAuthorizeHost(host)).toEqual([
			'openid',
			'email',
			'profile',
		])
	}
})

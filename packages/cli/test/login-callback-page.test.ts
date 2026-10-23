import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	loginCallbackErrorFromOAuthError,
	renderLoginCallbackPage,
} from '../src/login-callback-page.js'

test('success page shows org and account without echoing secrets', () => {
	const html = renderLoginCallbackPage({
		kind: 'success',
		org: 'acme',
		account: {
			displayName: 'Ada Lovelace',
			email: 'ada@example.com',
		},
	})
	assert.match(html, /You're signed in/)
	assert.match(html, />acme</)
	assert.match(html, /Ada Lovelace \(ada@example\.com\)/)
	assert.doesNotMatch(
		html,
		/access_token|refresh_token|kody_at_|authorization_code/i,
	)
	assert.doesNotMatch(html, /\bcode=[A-Za-z0-9]/)
})

test('success page escapes untrusted org/account text', () => {
	const html = renderLoginCallbackPage({
		kind: 'success',
		org: '<script>alert(1)</script>',
		account: { displayName: 'A <b>bold</b>', email: 'x@"evil"' },
	})
	assert.doesNotMatch(html, /<script>alert/)
	assert.match(html, /&lt;script&gt;/)
	assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/)
})

test('error pages cover denied, state mismatch, and expired', () => {
	for (const error of ['denied', 'state_mismatch', 'expired'] as const) {
		const html = renderLoginCallbackPage({ kind: 'error', error })
		assert.match(html, /kody login/)
		assert.match(html, new RegExp(`data-error="${error}"`))
		assert.doesNotMatch(html, /access_token|refresh_token|code=/i)
	}
})

test('oauth error codes map to designed states', () => {
	assert.equal(loginCallbackErrorFromOAuthError('access_denied'), 'denied')
	assert.equal(loginCallbackErrorFromOAuthError('expired_token'), 'expired')
	assert.equal(
		loginCallbackErrorFromOAuthError('invalid_state'),
		'state_mismatch',
	)
	assert.equal(loginCallbackErrorFromOAuthError('server_error'), 'failed')
})

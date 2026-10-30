const assert = require('node:assert/strict')
const { test } = require('node:test')
const { isAppUrl, isExternalUrl } = require('../navigation.cjs')

test('keeps only the exact production origin inside the app', () => {
	assert.equal(isAppUrl('https://kody.codes/account'), true)
	for (const url of [
		'http://kody.codes',
		'https://kody.codes.evil.test',
		'https://evil.test@kody.codes',
		'file:///etc/passwd',
		'javascript:alert(1)',
		'https://foo.kody.codes',
		'https://kody.codes:8443',
	]) {
		assert.equal(isAppUrl(url), false, url)
	}
})
test('external links cannot launch arbitrary OS protocols', () => {
	assert.equal(isExternalUrl('https://example.com/docs'), true)
	assert.equal(isExternalUrl('mailto:hello@example.com'), true)
	for (const url of [
		'file:///tmp/app',
		'javascript:alert(1)',
		'kody://run',
		'https://a:b@example.com',
		'not a URL',
	]) {
		assert.equal(isExternalUrl(url), false, url)
	}
})

test('social sign-in can return to the same cookie session without allowing arbitrary navigation', () => {
	const { isNavigationUrl } = require('../navigation.cjs')
	assert.equal(
		isNavigationUrl('https://github.com/login/oauth/authorize'),
		true,
	)
	assert.equal(
		isNavigationUrl('https://accounts.google.com/o/oauth2/v2/auth'),
		true,
	)
	for (const url of [
		'https://accounts.google.com.evil.test',
		'http://github.com/login',
		'https://user@github.com/login',
		'https://example.com',
	])
		assert.equal(isNavigationUrl(url), false)
})

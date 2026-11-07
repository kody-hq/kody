const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	approvalNavigation,
	approvalTarget,
	canApproveInApp,
	loginAuthorizationUrl,
} = require('../in-app-approval.cjs')

const origin = 'https://kody.codes'
const authorize = `${origin}/oauth/authorize?response_type=code&client_id=cli&redirect_uri=${encodeURIComponent('http://127.0.0.1:33418/callback')}&state=s&org=jane`

test('finds the CLI authorize URL in kody login output', () => {
	const output = `Open this link in your browser to sign in to Kody:\n\n  ${authorize}\n\nWaiting for you to finish signing in…\n`
	assert.equal(loginAuthorizationUrl(output), authorize)
	assert.equal(loginAuthorizationUrl('Waiting…\nhttps://kody.codes/docs'), null)
	assert.equal(loginAuthorizationUrl('Open this link'), null)
})

test('approval targets only the app consent page and a loopback callback', () => {
	const target = approvalTarget(authorize, origin)
	assert.equal(target.callback, 'http://127.0.0.1:33418/callback')
	assert.equal(approvalTarget(authorize, 'http://localhost:3742'), null)
	for (const redirect of [
		'https://127.0.0.1:33418/callback',
		'http://localhost:33418/callback',
		'http://127.0.0.1/callback',
		'http://127.0.0.1:33418/other',
		'http://user@127.0.0.1:33418/callback',
	]) {
		const url = new URL(authorize)
		url.searchParams.set('redirect_uri', redirect)
		assert.equal(approvalTarget(url.href, origin), null, redirect)
	}
	assert.equal(
		approvalTarget(authorize.replace('/oauth/authorize', '/login'), origin),
		null,
	)
})

test('the approval window stays on consent and leaves for any sign-in page', () => {
	const target = approvalTarget(authorize, origin)
	assert.equal(approvalNavigation(target, authorize), 'consent')
	assert.equal(
		approvalNavigation(target, `${origin}/oauth/authorize?step=2`),
		'consent',
	)
	assert.equal(
		approvalNavigation(
			target,
			'http://127.0.0.1:33418/callback?code=x&state=s',
		),
		'callback',
	)
	for (const url of [
		`${origin}/login?redirectTo=%2Foauth%2Fauthorize`,
		`${origin}/signup`,
		'https://accounts.google.com/o/oauth2/auth',
		'http://127.0.0.1:9999/callback',
		'https://evil.example/oauth/authorize',
		'not a url',
	])
		assert.equal(approvalNavigation(target, url), 'leave', url)
})

test('in-app approval needs the consent page to see a verified session', async () => {
	const target = approvalTarget(authorize, origin)
	const requested = []
	const answer =
		(body, ok = true) =>
		async (url) => {
			requested.push(url)
			return { ok, json: async () => body }
		}
	const signedIn = {
		ok: true,
		requireCredentials: false,
		emailVerified: true,
		orgs: [{ slug: 'jane' }],
	}
	assert.equal(await canApproveInApp(target, answer(signedIn)), true)
	assert.equal(
		new URL(requested[0]).pathname + new URL(requested[0]).search,
		`/oauth/authorize-info${target.url.search}`,
	)
	for (const body of [
		{ ...signedIn, requireCredentials: true },
		{ ...signedIn, emailVerified: null },
		{ ...signedIn, emailVerified: false },
		{ ...signedIn, orgs: [] },
		{ ok: false, error: 'Unknown client' },
	])
		assert.equal(await canApproveInApp(target, answer(body)), false)
	assert.equal(await canApproveInApp(target, answer(signedIn, false)), false)
	assert.equal(
		await canApproveInApp(target, async () => {
			throw new Error('offline')
		}),
		false,
	)
})

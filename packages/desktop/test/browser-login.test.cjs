const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { browserLogin } = require('../browser-login.cjs')
function setup(exchange) {
	let opened
	const ready = new Promise((resolve) => {
		opened = resolve
	})
	const attempt = browserLogin({
		origin: 'https://kody.codes',
		mode: 'signup',
		openExternal: (url) => opened(new URL(url)),
		exchange,
	})
	return { attempt, ready }
}
test('loopback login binds state and PKCE and accepts one callback', async () => {
	let calls = 0
	const { attempt, ready } = setup(async ({ verifier, code }) => {
		calls++
		assert.equal(
			createHash('sha256').update(verifier).digest('base64url'),
			url.searchParams.get('challenge'),
		)
		assert.equal(code, 'c'.repeat(43))
		return 'session'
	})
	const url = await ready
	assert.equal(url.origin, 'https://kody.codes')
	assert.equal(url.searchParams.get('mode'), 'signup')
	const callback = new URL(url.searchParams.get('callback'))
	assert.equal(callback.hostname, '127.0.0.1')
	callback.search = new URLSearchParams({
		state: 'wrong',
		code: 'c'.repeat(43),
	}).toString()
	const mismatch = await fetch(callback)
	assert.equal(mismatch.status, 400)
	const mismatchPage = await mismatch.text()
	assert.match(mismatchPage, /This sign-in link isn’t valid/)
	assert.doesNotMatch(mismatchPage, /wrong|c{43}/)
	callback.searchParams.set('state', url.searchParams.get('state'))
	const success = await fetch(callback)
	assert.equal(success.status, 200)
	assert.match(success.headers.get('content-type'), /^text\/html/)
	assert.equal(success.headers.get('cache-control'), 'no-store')
	const successPage = await success.text()
	assert.match(successPage, /You’re signed in/)
	assert.ok(!successPage.includes(url.searchParams.get('state')))
	assert.ok(!successPage.includes('c'.repeat(43)))
	assert.equal(await attempt.result, 'session')
	assert.equal(calls, 1)
	await assert.rejects(fetch(callback))
})
test('cancel closes the listener and aborts an in-flight exchange', async () => {
	let start
	const started = new Promise((resolve) => (start = resolve))
	const { attempt, ready } = setup(async ({ signal }) => {
		start()
		await new Promise((resolve, reject) =>
			signal.addEventListener('abort', () => reject(signal.reason), {
				once: true,
			}),
		)
	})
	const url = await ready
	const callback = new URL(url.searchParams.get('callback'))
	callback.search = new URLSearchParams({
		state: url.searchParams.get('state'),
		code: 'c'.repeat(43),
	}).toString()
	const response = fetch(callback).catch(() => null)
	const rejected = assert.rejects(attempt.result, /canceled/)
	await started
	attempt.cancel()
	await rejected
	await response
	await assert.rejects(fetch(callback))
})
test('a failed exchange shows the retry page without request values', async () => {
	const { attempt, ready } = setup(async () => {
		throw new Error('exchange failed')
	})
	const url = await ready
	const callback = new URL(url.searchParams.get('callback'))
	const state = url.searchParams.get('state')
	callback.search = new URLSearchParams({
		state,
		code: 'c'.repeat(43),
	}).toString()
	const rejected = assert.rejects(attempt.result, /Could not complete/)
	const response = await fetch(callback)
	assert.equal(response.status, 400)
	const page = await response.text()
	assert.match(page, /Sign-in didn’t finish/)
	assert.match(page, /choose Sign in to try again/)
	assert.ok(!page.includes(state))
	assert.ok(!page.includes('c'.repeat(43)))
	assert.doesNotMatch(page, /exchange failed/)
	await rejected
})
test('a browser denial ends the attempt only when state matches', async () => {
	let calls = 0
	const { attempt, ready } = setup(async () => calls++)
	const url = await ready
	const callback = new URL(url.searchParams.get('callback'))
	callback.search = new URLSearchParams({
		state: 'wrong',
		error: 'access_denied',
	}).toString()
	const mismatch = await fetch(callback)
	assert.equal(mismatch.status, 400)
	assert.match(await mismatch.text(), /This sign-in link isn’t valid/)
	callback.searchParams.set('state', url.searchParams.get('state'))
	const rejected = assert.rejects(attempt.result, /canceled\. Please try again/)
	const denied = await fetch(callback)
	assert.equal(denied.status, 400)
	assert.match(await denied.text(), /Sign-in was canceled/)
	await rejected
	assert.equal(calls, 0)
	await assert.rejects(fetch(callback))
})

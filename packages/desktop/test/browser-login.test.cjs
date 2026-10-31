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
	assert.equal((await fetch(callback)).status, 400)
	callback.searchParams.set('state', url.searchParams.get('state'))
	assert.equal((await fetch(callback)).status, 200)
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

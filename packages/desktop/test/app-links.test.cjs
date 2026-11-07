const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
	appLinkPath,
	createAppLinkRouter,
	openInBrowser,
} = require('../app-links.cjs')

const origin = 'https://kody.codes'

test('app links keep path, query, and hash only for the exact Kody origin', () => {
	assert.equal(
		appLinkPath('https://kody.codes/@kent/pkg?tab=files#readme', origin),
		'/@kent/pkg?tab=files#readme',
	)
	for (const value of [
		'http://kody.codes/account',
		'https://www.kody.codes/account',
		'https://kody.codes.evil.example/account',
		'https://user:pass@kody.codes/account',
		'https://app.kody.run/account',
		'kody://account',
		'not a url',
		undefined,
	])
		assert.equal(appLinkPath(value, origin), null, String(value))
})

test('cold-start links wait for startup and warm links open immediately', () => {
	const opened = []
	const router = createAppLinkRouter({
		origin,
		open: (path) => opened.push(path),
	})
	assert.equal(router.receive('https://kody.codes/account/secrets'), true)
	assert.equal(router.receive('https://example.com/account'), false)
	assert.deepEqual(opened, [])
	assert.deepEqual(router.start(), ['/account/secrets'])
	router.receive('https://kody.codes/@acme/-/jobs')
	assert.deepEqual(opened, ['/@acme/-/jobs'])
})

test('Open in browser targets the default browser on macOS', async () => {
	const runs = []
	const opened = []
	const deps = {
		app: {
			getApplicationInfoForProtocol: async () => ({
				path: '/Applications/Google Chrome.app',
			}),
		},
		shell: { openExternal: async (url) => opened.push(url) },
		platform: 'darwin',
		run: (command, args, done) => {
			runs.push([command, ...args])
			done(null)
		},
	}
	await openInBrowser('https://kody.codes/account', deps)
	assert.deepEqual(runs, [
		[
			'open',
			'-a',
			'/Applications/Google Chrome.app',
			'https://kody.codes/account',
		],
	])
	assert.deepEqual(opened, [])
	deps.app.getApplicationInfoForProtocol = async () => {
		throw new Error('none')
	}
	await openInBrowser('https://kody.codes/account', deps)
	await openInBrowser('https://kody.codes/docs', { ...deps, platform: 'win32' })
	assert.deepEqual(opened, [
		'https://kody.codes/account',
		'https://kody.codes/docs',
	])
	assert.equal(runs.length, 1)
})

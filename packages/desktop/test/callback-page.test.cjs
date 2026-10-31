const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const {
	renderCallbackPage,
	callbackPageKinds,
} = require('../callback-page.cjs')
const mark = require('../kody-mark.cjs')

test('every sign-in page is self-contained and allowed by its CSP', () => {
	for (const kind of callbackPageKinds) {
		const { html, headers } = renderCallbackPage(kind)
		assert.match(headers['Content-Type'], /^text\/html/)
		assert.doesNotMatch(html, /<script|<img|<iframe|<link rel="stylesheet"/i)
		assert.doesNotMatch(html, /\b(?:src|href)="(?!data:)/i)
		assert.doesNotMatch(html, /url\(|@import|@font-face/i)
		assert.doesNotMatch(html, /\sstyle="/i)
		const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
		assert.equal(styles.length, 1)
		const hash = createHash('sha256').update(styles[0][1]).digest('base64')
		const csp = headers['Content-Security-Policy']
		assert.match(csp, /default-src 'none'/)
		assert.ok(csp.includes(`style-src 'sha256-${hash}'`))
		assert.match(html, /prefers-color-scheme: dark/)
	}
})

test('success and error pages say what happened and what to do next', () => {
	const success = renderCallbackPage('success')
	assert.equal(success.status, 200)
	assert.match(success.html, /data-tone="success"/)
	assert.match(success.html, /<h1 id="title">You’re signed in<\/h1>/)
	assert.match(success.html, /Head back to the Kody app/)
	for (const kind of ['failed', 'denied', 'invalid']) {
		const page = renderCallbackPage(kind)
		assert.equal(page.status, 400)
		assert.match(page.html, /data-tone="error"/)
		assert.match(page.html, /Return to the Kody app and (choose Sign in|start)/)
	}
	assert.equal(renderCallbackPage('busy').status, 409)
	assert.throws(() => renderCallbackPage('other'), /Unknown sign-in page/)
})

test('the inlined Kody mark matches the website mark', () => {
	const source = readFileSync(
		join(__dirname, '../../worker/start/brand/kody-mark-path.ts'),
		'utf8',
	)
	const read = (name) =>
		source.match(new RegExp(`export const ${name} =\\s*'([^']+)'`))[1]
	assert.deepEqual(mark, {
		viewBox: read('kodyMarkViewBox'),
		transform: read('kodyMarkPathTransform'),
		solid: read('kodyMarkPathD'),
		ring: read('kodyMarkOutlinedRingPathD'),
		leftEye: read('kodyMarkOutlinedLeftEyePathD'),
		rightEye: read('kodyMarkOutlinedRightEyePathD'),
		nose: read('kodyMarkOutlinedNosePathD'),
	})
})

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { supportsIntegratedTitlebar } = require('../site-capabilities.cjs')
test('integrated chrome requires the website navigation protocol', async () => {
	assert.equal(
		await supportsIntegratedTitlebar(
			'https://kody.codes',
			async (url, options) => {
				assert.equal(url, 'https://kody.codes/login')
				assert.equal(options.method, 'HEAD')
				return new Response(null, {
					headers: { 'X-Kody-Desktop-Navigation': '1' },
				})
			},
		),
		true,
	)
	assert.equal(
		await supportsIntegratedTitlebar(
			'https://kody.codes',
			async () => new Response(null),
		),
		false,
	)
	assert.equal(
		await supportsIntegratedTitlebar('https://kody.codes', async () => {
			throw new Error('offline')
		}),
		false,
	)
	assert.equal(
		await supportsIntegratedTitlebar(
			'https://kody.codes',
			async () =>
				new Response(null, {
					status: 500,
					headers: { 'X-Kody-Desktop-Navigation': '1' },
				}),
		),
		false,
	)
})

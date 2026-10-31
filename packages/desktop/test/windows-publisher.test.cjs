const assert = require('node:assert/strict')
const { test } = require('node:test')
const { publisherMatches } = require('../scripts/verify-windows-publisher.cjs')

test('matches common names and full distinguished names as the installed updater does', () => {
	const subject = 'CN=Kody, O=Kody LLC, L=Denver, C=US'
	assert.equal(publisherMatches('Kody', subject), true)
	assert.equal(publisherMatches('O=Kody LLC, C=US, CN=Kody', subject), true)
})

test('a common name match cannot override a mismatched organization in a configured DN', () => {
	assert.equal(
		publisherMatches('CN=Kody, O=Other LLC', 'CN=Kody, O=Kody LLC'),
		false,
	)
	assert.equal(publisherMatches('Other', 'CN=Kody, O=Kody LLC'), false)
})

test('handles quoted certificate names without shell interpolation', () => {
	const subject = 'CN="Kody, Inc.", O=Kody LLC'
	assert.equal(publisherMatches('Kody, Inc.', subject), true)
	assert.equal(publisherMatches('O=Kody LLC, CN="Kody, Inc."', subject), true)
})

test('missing publisher configuration or certificate subject is rejected', () => {
	assert.equal(publisherMatches(undefined, undefined), false)
	assert.equal(publisherMatches('', 'CN=Kody'), false)
	assert.equal(publisherMatches('Kody', ''), false)
})

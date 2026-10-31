const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	releasePlan,
	assertFeedCoverage,
} = require('../scripts/release-plan.cjs')
const apple = Object.fromEntries(
	[
		'DESKTOP_MAC_CERTIFICATE_BASE64',
		'DESKTOP_MAC_CERTIFICATE_PASSWORD',
		'DESKTOP_APPLE_API_KEY_BASE64',
		'DESKTOP_APPLE_API_KEY_ID',
		'DESKTOP_APPLE_API_ISSUER',
		'DESKTOP_RELEASE_TOKEN',
	].map((name) => [name, 'test-only-placeholder']),
)

test('Mac-first releases require no Windows account and build both Mac architectures', () => {
	const plan = releasePlan('mac', apple)
	assert.deepEqual(plan.missing, [])
	assert.deepEqual(
		plan.matrix.include.map((target) => [target.platform, target.arch]),
		[
			['mac', 'arm64'],
			['mac', 'x64'],
		],
	)
})

test('expanding to all platforms requires a Windows signer before building', () => {
	const plan = releasePlan('all', apple)
	assert.equal(plan.matrix.include.length, 6)
	assert.ok(plan.missing.includes('DESKTOP_WINDOWS_PUBLISHER'))
	assert.ok(plan.missing.includes('DESKTOP_WINDOWS_CERTIFICATE_BASE64'))
})

test('Mac-only publication cannot remove existing Windows or Linux update channels', () => {
	assert.doesNotThrow(() =>
		assertFeedCoverage('mac', ['latest-arm64-mac.yml', 'latest-x64-mac.yml']),
	)
	for (const name of ['latest-x64.yml', 'latest-arm64-linux-arm64.yml']) {
		assert.throws(
			() => assertFeedCoverage('mac', [name]),
			/Choose all platforms/,
		)
		assert.doesNotThrow(() => assertFeedCoverage('all', [name]))
	}
})

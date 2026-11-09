const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	releasePlan,
	assertFeedCoverage,
	releaseNotes,
	assertDraft,
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

test('draft retries require matching source, platforms, and asset names', () => {
	const draft = {
		isDraft: true,
		body: releaseNotes('abc123', 'mac'),
		assets: [{ name: 'Kody-mac.zip' }],
	}
	assert.doesNotThrow(() =>
		assertDraft(draft, 'abc123', 'mac', [
			'Kody-mac.zip',
			'latest-arm64-mac.yml',
		]),
	)
	assert.throws(
		() => assertDraft(draft, 'other', 'mac', ['Kody-mac.zip']),
		/source or platforms differ/,
	)
	assert.throws(
		() => assertDraft(draft, 'abc123', 'all', ['Kody-mac.zip']),
		/source or platforms differ/,
	)
	assert.throws(
		() => assertDraft(draft, 'abc123', 'mac', ['other.zip']),
		/outside this release plan/,
	)
	assert.throws(
		() =>
			assertDraft({ ...draft, isDraft: false }, 'abc123', 'mac', [
				'Kody-mac.zip',
			]),
		/already published/,
	)
})

test('a resumed draft rebuilds only targets that are missing assets', () => {
	const {
		pendingTargets,
		targetAssetNames,
	} = require('../scripts/release-plan.cjs')
	const include = releasePlan('mac', apple).matrix.include
	const asset = (name) => ({ name, size: 10, state: 'uploaded' })
	const draft = {
		tag_name: 'v0.1.41',
		draft: true,
		body: releaseNotes('a'.repeat(40), 'mac'),
		assets: targetAssetNames('0.1.41', include[0]).map(asset),
	}
	const plan = (releases, sha = 'a'.repeat(40)) =>
		pendingTargets({
			include,
			version: '0.1.41',
			sha,
			scope: 'mac',
			releases,
		}).map((target) => target.arch)
	assert.deepEqual(plan([draft]), ['x64'])
	assert.deepEqual(plan([]), ['arm64', 'x64'])
	assert.deepEqual(plan([draft], 'b'.repeat(40)), ['arm64', 'x64'])
	const partial = {
		...draft,
		assets: draft.assets.map((item, index) =>
			index === 0 ? { ...item, state: 'starter' } : item,
		),
	}
	assert.deepEqual(plan([partial]), ['arm64', 'x64'])
	assert.deepEqual(plan([{ ...draft, draft: false }]), ['arm64', 'x64'])
})

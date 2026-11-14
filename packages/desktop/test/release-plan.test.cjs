const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	releasePlan,
	assertFeedCoverage,
	releaseNotes,
	assertDraft,
	releaseAssetNames,
	targetAssetNames,
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

const windows = Object.fromEntries(
	[
		'DESKTOP_WINDOWS_PUBLISHER',
		'DESKTOP_WINDOWS_CERTIFICATE_BASE64',
		'DESKTOP_WINDOWS_CERTIFICATE_PASSWORD',
	].map((name) => [name, 'test-only-placeholder']),
)

test('every release builds Mac and Windows on both architectures', () => {
	const plan = releasePlan('mac-win', { ...apple, ...windows })
	assert.deepEqual(plan.missing, [])
	assert.deepEqual(
		plan.matrix.include.map((target) => [target.platform, target.arch]),
		[
			['mac', 'arm64'],
			['mac', 'x64'],
			['win', 'x64'],
			['win', 'arm64'],
		],
	)
	assert.equal(
		plan.matrix.include.find(
			(target) => target.arch === 'arm64' && target.platform === 'win',
		).runner,
		'windows-11-arm',
	)
	assert.throws(() => releasePlan('mac', apple), /Choose mac-win or all/)
})

test('a release without a Windows signer fails before building', () => {
	for (const scope of ['mac-win', 'all']) {
		const plan = releasePlan(scope, apple)
		assert.ok(plan.missing.includes('DESKTOP_WINDOWS_PUBLISHER'))
		assert.ok(plan.missing.includes('DESKTOP_WINDOWS_CERTIFICATE_BASE64'))
	}
	assert.equal(releasePlan('all', apple).matrix.include.length, 6)
	const azure = releasePlan('mac-win', {
		...apple,
		DESKTOP_WINDOWS_SIGNING_PROVIDER: 'azure',
	})
	assert.ok(azure.missing.includes('DESKTOP_AZURE_PROFILE'))
	assert.ok(!azure.missing.includes('DESKTOP_WINDOWS_CERTIFICATE_BASE64'))
})

test('Windows targets publish an MSIX, a stable App Installer file, and the signer', () => {
	assert.deepEqual(
		targetAssetNames('0.1.74', { platform: 'win', arch: 'arm64' }),
		[
			'SHA256SUMS-win-arm64.txt',
			'build-info-win-arm64.json',
			'Kody-0.1.74-win-arm64.msix',
			'Kody-win-arm64.appinstaller',
			'Kody-win-signer.cer',
		],
	)
	const names = releaseAssetNames('0.1.74', 'mac-win')
	assert.equal(new Set(names).size, names.length)
	assert.equal(names.filter((name) => name === 'Kody-win-signer.cer').length, 1)
	assert.ok(names.includes('latest-arm64-mac.yml'))
	assert.ok(!names.some((name) => name.includes('linux')))
})

test('a Mac and Windows release cannot remove existing Linux update channels', () => {
	assert.doesNotThrow(() =>
		assertFeedCoverage('mac-win', [
			'latest-arm64-mac.yml',
			'latest-x64-mac.yml',
			'Kody-win-x64.appinstaller',
		]),
	)
	for (const name of ['latest-x64-linux.yml', 'latest-arm64-linux-arm64.yml']) {
		assert.throws(
			() => assertFeedCoverage('mac-win', [name]),
			/Choose all platforms/,
		)
		assert.doesNotThrow(() => assertFeedCoverage('all', [name]))
	}
})

test('draft retries require matching source, platforms, and asset names', () => {
	const draft = {
		isDraft: true,
		body: releaseNotes('abc123', 'mac-win'),
		assets: [{ name: 'Kody-mac.zip' }],
	}
	assert.doesNotThrow(() =>
		assertDraft(draft, 'abc123', 'mac-win', [
			'Kody-mac.zip',
			'latest-arm64-mac.yml',
		]),
	)
	assert.throws(
		() => assertDraft(draft, 'other', 'mac-win', ['Kody-mac.zip']),
		/source or platforms differ/,
	)
	assert.throws(
		() => assertDraft(draft, 'abc123', 'all', ['Kody-mac.zip']),
		/source or platforms differ/,
	)
	assert.throws(
		() => assertDraft(draft, 'abc123', 'mac-win', ['other.zip']),
		/outside this release plan/,
	)
	assert.throws(
		() =>
			assertDraft({ ...draft, isDraft: false }, 'abc123', 'mac-win', [
				'Kody-mac.zip',
			]),
		/already published/,
	)
})

test('a resumed draft rebuilds only targets that are missing assets', () => {
	const { pendingTargets } = require('../scripts/release-plan.cjs')
	const include = releasePlan('mac-win', apple).matrix.include
	const asset = (name) => ({ name, size: 10, state: 'uploaded' })
	const draft = {
		tag_name: 'v0.1.41',
		draft: true,
		body: releaseNotes('a'.repeat(40), 'mac-win'),
		assets: targetAssetNames('0.1.41', include[0]).map(asset),
	}
	const plan = (releases, sha = 'a'.repeat(40)) =>
		pendingTargets({
			include,
			version: '0.1.41',
			sha,
			scope: 'mac-win',
			releases,
		}).map((target) => target.arch)
	const all = ['arm64', 'x64', 'x64', 'arm64']
	assert.deepEqual(plan([draft]), ['x64', 'x64', 'arm64'])
	assert.deepEqual(plan([]), all)
	assert.deepEqual(plan([draft], 'b'.repeat(40)), all)
	const partial = {
		...draft,
		assets: draft.assets.map((item, index) =>
			index === 0 ? { ...item, state: 'starter' } : item,
		),
	}
	assert.deepEqual(plan([partial]), all)
	assert.deepEqual(plan([{ ...draft, draft: false }]), all)
})

const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	releasePlan,
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

test('every release builds Mac, Windows, and Linux on both architectures', () => {
	const plan = releasePlan({ ...apple, ...windows })
	assert.deepEqual(plan.missing, [])
	assert.deepEqual(
		plan.matrix.include.map((target) => [
			target.platform,
			target.arch,
			target.runner,
		]),
		[
			['mac', 'arm64', 'macos-15'],
			['mac', 'x64', 'macos-15-intel'],
			['win', 'x64', 'windows-latest'],
			['win', 'arm64', 'windows-11-arm'],
			['linux', 'x64', 'ubuntu-24.04'],
			['linux', 'arm64', 'ubuntu-24.04-arm'],
		],
	)
})

test('a release without a Windows signer fails before building', () => {
	const plan = releasePlan(apple)
	assert.ok(plan.missing.includes('DESKTOP_WINDOWS_PUBLISHER'))
	assert.ok(plan.missing.includes('DESKTOP_WINDOWS_CERTIFICATE_BASE64'))
	const azure = releasePlan({
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
	const names = releaseAssetNames('0.1.74')
	assert.equal(new Set(names).size, names.length)
	assert.equal(names.filter((name) => name === 'Kody-win-signer.cer').length, 1)
	assert.ok(names.includes('latest-arm64-mac.yml'))
})

test('Linux targets publish an AppImage, a .deb, their feed, and checks', () => {
	assert.deepEqual(
		targetAssetNames('0.1.83', { platform: 'linux', arch: 'x64' }),
		[
			'latest-x64-linux.yml',
			'SHA256SUMS-linux-x64.txt',
			'build-info-linux-x64.json',
			'Kody-0.1.83-linux-x86_64.AppImage',
			'Kody-0.1.83-linux-amd64.deb',
		],
	)
	assert.deepEqual(
		targetAssetNames('0.1.83', { platform: 'linux', arch: 'arm64' }),
		[
			'latest-arm64-linux-arm64.yml',
			'SHA256SUMS-linux-arm64.txt',
			'build-info-linux-arm64.json',
			'Kody-0.1.83-linux-arm64.AppImage',
			'Kody-0.1.83-linux-arm64.deb',
		],
	)
	const names = releaseAssetNames('0.1.83')
	for (const name of [
		'latest-x64-linux.yml',
		'Kody-0.1.83-linux-arm64.AppImage',
		'Kody-0.1.83-linux-amd64.deb',
	])
		assert.ok(names.includes(name), name)
})

test('draft retries require matching source, platforms, and asset names', () => {
	const draft = {
		isDraft: true,
		body: releaseNotes('abc123'),
		assets: [{ name: 'Kody-mac.zip' }],
	}
	assert.doesNotThrow(() =>
		assertDraft(draft, 'abc123', ['Kody-mac.zip', 'latest-arm64-mac.yml']),
	)
	assert.throws(
		() => assertDraft(draft, 'other', ['Kody-mac.zip']),
		/source or platforms differ/,
	)
	assert.throws(
		() =>
			assertDraft(
				{
					...draft,
					body: 'Source: https://github.com/kody-hq/kody/commit/abc123\nPlatforms: mac-win',
				},
				'abc123',
				['Kody-mac.zip'],
			),
		/source or platforms differ/,
	)
	assert.throws(
		() => assertDraft(draft, 'abc123', ['other.zip']),
		/outside this release plan/,
	)
	assert.throws(
		() => assertDraft({ ...draft, isDraft: false }, 'abc123', ['Kody-mac.zip']),
		/already published/,
	)
})

test('a resumed draft rebuilds only targets that are missing assets', () => {
	const { pendingTargets } = require('../scripts/release-plan.cjs')
	const include = releasePlan(apple).matrix.include
	const asset = (name) => ({ name, size: 10, state: 'uploaded' })
	const draft = {
		tag_name: 'v0.1.41',
		draft: true,
		body: releaseNotes('a'.repeat(40)),
		assets: targetAssetNames('0.1.41', include[0]).map(asset),
	}
	const plan = (releases, sha = 'a'.repeat(40)) =>
		pendingTargets({
			include,
			version: '0.1.41',
			sha,
			releases,
		}).map((target) => target.arch)
	const all = include.map((target) => target.arch)
	assert.deepEqual(plan([draft]), all.slice(1))
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

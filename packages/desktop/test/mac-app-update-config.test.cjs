const assert = require('node:assert/strict')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { afterPack } = require('../scripts/mac-app-update-config.cjs')

const feed = {
	provider: 'github',
	owner: 'kody-hq',
	repo: 'kody-desktop',
	channel: 'latest-arm64',
	updaterCacheDirName: 'kody-desktop-updater',
}

function context(targets, platform = 'darwin') {
	const resources = mkdtempSync(join(tmpdir(), 'kody-update-config-'))
	return {
		resources,
		value: {
			electronPlatformName: platform,
			targets: targets.map((name) => ({ name })),
			arch: 3,
			appOutDir: '/unused',
			packager: { getResourcesDir: () => resources },
		},
	}
}

test('a signed Mac --dir build keeps the update feed electron-builder would write', async () => {
	const { resources, value } = context(['dir'])
	const calls = []
	await afterPack(value, {
		publishConfig: (packager, arch) => {
			calls.push([packager, arch])
			return feed
		},
	})
	assert.deepEqual(calls, [[value.packager, 3]])
	const text = readFileSync(join(resources, 'app-update.yml'), 'utf8')
	for (const [key, expected] of Object.entries(feed))
		assert.match(text, new RegExp(`^${key}: ${expected}$`, 'm'))
	rmSync(resources, { recursive: true, force: true })
})

test('builds that electron-builder already covers are left alone', async () => {
	for (const [targets, platform] of [
		[['dmg', 'zip'], 'darwin'],
		[['zip'], 'darwin'],
		[['dir'], 'win32'],
		[['dir'], 'linux'],
	]) {
		const { resources, value } = context(targets, platform)
		await afterPack(value, {
			publishConfig: () => assert.fail('no feed lookup expected'),
		})
		assert.equal(existsSync(join(resources, 'app-update.yml')), false)
		rmSync(resources, { recursive: true, force: true })
	}
})

test('a Mac release without an update feed fails before signing', async () => {
	const { resources, value } = context(['dir'])
	await assert.rejects(
		afterPack(value, { publishConfig: () => null }),
		/app-update\.yml/,
	)
	rmSync(resources, { recursive: true, force: true })
})

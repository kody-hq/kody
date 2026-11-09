const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
const { runInNewContext } = require('node:vm')

const configPath = resolve(__dirname, '../electron-builder.release.cjs')
const source = readFileSync(configPath, 'utf8')
const builderLoad = createRequire(require.resolve('electron-builder'))
const { validateConfiguration } = builderLoad(
	'app-builder-lib/out/util/config/config',
)

function configuration(platform, env) {
	const context = {
		require: createRequire(configPath),
		process: { platform, env },
		module: { exports: {} },
	}
	runInNewContext(source, context)
	return JSON.parse(JSON.stringify(context.module.exports))
}

test('release builds reject missing signing credentials before packaging', () => {
	for (const platform of ['darwin', 'win32']) {
		assert.throws(
			() => configuration(platform, {}),
			/Missing release credential:/,
		)
	}
	assert.equal(configuration('linux', {}).forceCodeSigning, false)
})

test('both signing providers and all release platforms match the pinned builder schema', async () => {
	for (const platform of ['darwin', 'win32', 'linux']) {
		for (const provider of ['certificate', 'azure']) {
			const env = new Proxy(
				{ KODY_WINDOWS_SIGNING_PROVIDER: provider },
				{
					get: (values, key) => values[key] ?? 'test-only-placeholder',
				},
			)
			const config = configuration(platform, env)
			await validateConfiguration(config, {
				isEnabled: false,
			})
			assert.equal(config.forceCodeSigning, platform !== 'linux')
			if (platform === 'win32' && provider === 'azure') {
				assert.equal(
					config.win.azureSignOptions.endpoint,
					'test-only-placeholder',
				)
				assert.equal(config.win.signtoolOptions, undefined)
			}
			if (platform === 'win32' && provider === 'certificate') {
				assert.equal(
					config.win.signtoolOptions.publisherName,
					'test-only-placeholder',
				)
				assert.equal(config.win.azureSignOptions, undefined)
			}
			if (platform === 'darwin') {
				assert.equal(config.mac.hardenedRuntime, true)
				assert.equal(config.mac.notarize, false)
				assert.equal(config.win.azureSignOptions, undefined)
			}
		}
	}
})

test('Mac releases do not require unused Windows Azure settings', async () => {
	const env = Object.fromEntries(
		[
			'CSC_LINK',
			'CSC_KEY_PASSWORD',
			'APPLE_API_KEY',
			'APPLE_API_KEY_ID',
			'APPLE_API_ISSUER',
		].map((name) => [name, 'test-only-placeholder']),
	)
	env.KODY_WINDOWS_SIGNING_PROVIDER = 'azure'
	const config = configuration('darwin', env)
	assert.equal(config.forceCodeSigning, true)
	assert.equal(config.win.azureSignOptions, undefined)
	await validateConfiguration(config, {
		isEnabled: false,
	})
})

test('local Mac releases can use a Keychain identity without exporting its private key', async () => {
	const config = configuration('darwin', {
		CSC_NAME: 'Existing Developer ID identity',
		APPLE_API_KEY: 'local-private-key-path.p8',
		APPLE_API_KEY_ID: 'test-key-id',
		APPLE_API_ISSUER: 'test-issuer',
	})
	assert.equal(config.forceCodeSigning, true)
	assert.equal(config.mac.hardenedRuntime, true)
	await validateConfiguration(config, { isEnabled: false })
})

const macCredentials = {
	CSC_NAME: 'Existing Developer ID identity',
	APPLE_API_KEY: 'local-private-key-path.p8',
	APPLE_API_KEY_ID: 'test-key-id',
	APPLE_API_ISSUER: 'test-issuer',
}

test('Mac releases claim associated domains only with a provisioning profile', async () => {
	const plain = configuration('darwin', macCredentials)
	assert.equal(plain.mac.provisioningProfile, undefined)
	assert.equal(plain.mac.entitlements, 'assets/entitlements.mac.plist')
	assert.doesNotMatch(
		readFileSync(
			resolve(__dirname, '../assets/entitlements.mac.plist'),
			'utf8',
		),
		/associated-domains/,
	)
	const linked = configuration('darwin', {
		...macCredentials,
		KODY_MAC_PROVISIONING_PROFILE: '/tmp/kody.provisionprofile',
	})
	assert.equal(linked.mac.provisioningProfile, '/tmp/kody.provisionprofile')
	assert.equal(
		linked.mac.entitlements,
		'assets/entitlements.mac.app-links.plist',
	)
	await validateConfiguration(linked, { isEnabled: false })
	const entitlements = readFileSync(
		resolve(__dirname, '../assets/entitlements.mac.app-links.plist'),
		'utf8',
	)
	assert.match(entitlements, /<string>applinks:kody\.codes<\/string>/)
	assert.match(
		entitlements,
		/<string>7A84LHNSXV\.codes\.kody\.desktop<\/string>/,
	)
	const base = readFileSync(
		resolve(__dirname, '../assets/entitlements.mac.plist'),
		'utf8',
	)
	for (const key of base.matchAll(/<key>([^<]+)<\/key>/g))
		assert.ok(entitlements.includes(key[0]), key[1])
})

test('Mac --dir releases write the update feed into the app before signing', async () => {
	const config = configuration('darwin', macCredentials)
	const hook = require(resolve(__dirname, '..', config.afterPack))
	const dir = await mkdtemp(join(tmpdir(), 'kody-mac-update-'))
	try {
		await hook.afterPack(
			{
				electronPlatformName: 'darwin',
				targets: [{ name: 'dir' }],
				arch: 'arm64',
				appOutDir: dir,
				packager: { getResourcesDir: (out) => out },
			},
			{
				publishConfig: async () => ({
					provider: 'github',
					channel: 'latest-arm64',
				}),
				serialize: (value) => `channel: ${value.channel}\n`,
			},
		)
		assert.match(
			await readFile(join(dir, 'app-update.yml'), 'utf8'),
			/latest-arm64/,
		)
		let skipped = 0
		const skip = {
			publishConfig: async () => {
				skipped += 1
				return { provider: 'github' }
			},
		}
		await hook.afterPack(
			{
				electronPlatformName: 'darwin',
				targets: [{ name: 'dmg' }],
				arch: 'arm64',
				appOutDir: dir,
				packager: { getResourcesDir: (out) => out },
			},
			skip,
		)
		await hook.afterPack(
			{
				electronPlatformName: 'win32',
				targets: [{ name: 'dir' }],
				arch: 'x64',
				appOutDir: dir,
				packager: { getResourcesDir: (out) => out },
			},
			skip,
		)
		assert.equal(skipped, 0)
		await assert.rejects(
			() =>
				hook.afterPack(
					{
						electronPlatformName: 'darwin',
						targets: [{ name: 'dir' }],
						arch: 'arm64',
						appOutDir: dir,
						packager: { getResourcesDir: (out) => out },
					},
					{ publishConfig: async () => null },
				),
			/app-update\.yml/,
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

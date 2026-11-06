const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
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
			await validateConfiguration(configuration(platform, env), {
				isEnabled: false,
			})
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
	await validateConfiguration(configuration('darwin', env), {
		isEnabled: false,
	})
})

test('local Mac releases can use a Keychain identity without exporting its private key', async () => {
	await validateConfiguration(
		configuration('darwin', {
			CSC_NAME: 'Existing Developer ID identity',
			APPLE_API_KEY: 'local-private-key-path.p8',
			APPLE_API_KEY_ID: 'test-key-id',
			APPLE_API_ISSUER: 'test-issuer',
		}),
		{ isEnabled: false },
	)
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

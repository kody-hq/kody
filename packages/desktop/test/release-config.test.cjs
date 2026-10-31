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

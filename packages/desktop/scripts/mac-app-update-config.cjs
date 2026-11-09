const { writeFile } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { join } = require('node:path')

const builderRequire = createRequire(require.resolve('electron-builder'))

function defaultPublishConfig(packager, arch) {
	const { getAppUpdatePublishConfiguration } = builderRequire(
		'app-builder-lib/out/publish/PublishManager',
	)
	return getAppUpdatePublishConfiguration(packager, null, arch, true)
}

function defaultSerialize(value) {
	return builderRequire('builder-util').serializeToYaml(value)
}

// electron-builder writes Resources/app-update.yml only while packing dmg or
// zip targets. Mac releases sign a --dir build and package the stapled app
// later, so write the same file here, before signing seals the bundle.
async function afterPack(
	context,
	{ publishConfig = defaultPublishConfig, serialize = defaultSerialize } = {},
) {
	if (context.electronPlatformName !== 'darwin') return
	if (context.targets.some(({ name }) => name === 'dmg' || name === 'zip'))
		return
	const config = await publishConfig(context.packager, context.arch)
	if (!config)
		throw new Error('Mac release builds need an app-update.yml update feed.')
	await writeFile(
		join(context.packager.getResourcesDir(context.appOutDir), 'app-update.yml'),
		serialize(config),
	)
}

module.exports = { afterPack }

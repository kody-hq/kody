const { build } = require('./package.json')

// Separate architecture channels prevent parallel release jobs from overwriting
// each other's manifests, especially the Windows ARM and x64 installers.
module.exports = {
	...build,
	mac: { ...build.mac, identity: null },
	publish: {
		provider: 'github',
		owner: 'kody-hq',
		repo: 'kody-desktop',
		channel: `latest-${process.arch}`,
		tagNamePrefix: 'v',
		releaseType: 'draft',
	},
}

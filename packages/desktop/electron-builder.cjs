const { build } = require('./package.json')

// Keep unsigned test builds off the production feed, including automatic
// repository detection by electron-builder.
module.exports = {
	...build,
	mac: { ...build.mac, identity: null },
	publish: null,
}

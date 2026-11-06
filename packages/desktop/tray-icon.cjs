const { join } = require('node:path')

/**
 * Tray mark files match browser-tab favicon treatments:
 * light OS chrome → outlined black with white face fill
 * dark OS chrome → solid white evenodd mark
 *
 * macOS template images cannot express the light treatment (white face under
 * black outline), so both platforms swap explicit PNGs when the theme changes.
 */
function trayIconFileName(dark) {
	return dark ? 'tray-dark.png' : 'tray-light.png'
}

function trayIconPath(dark, root = __dirname) {
	return join(root, 'assets', trayIconFileName(dark))
}

function createTrayIcon(nativeImage, nativeTheme, options = {}) {
	const dark = options.dark ?? Boolean(nativeTheme.shouldUseDarkColors)
	return nativeImage.createFromPath(trayIconPath(dark, options.root))
}

module.exports = { trayIconFileName, trayIconPath, createTrayIcon }

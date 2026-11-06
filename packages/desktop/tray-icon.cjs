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

/**
 * Prefer system-integrated UI chrome (Windows taskbar / tray) over app theme.
 * On macOS Electron reports the same value as shouldUseDarkColors; fall back
 * when the property is missing (tests or older Electron).
 */
function trayChromeIsDark(nativeTheme) {
	if (
		typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === 'boolean'
	) {
		return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
	}
	return Boolean(nativeTheme.shouldUseDarkColors)
}

function createTrayIcon(nativeImage, nativeTheme, options = {}) {
	const dark = options.dark ?? trayChromeIsDark(nativeTheme)
	return nativeImage.createFromPath(trayIconPath(dark, options.root))
}

module.exports = {
	trayIconFileName,
	trayIconPath,
	trayChromeIsDark,
	createTrayIcon,
}

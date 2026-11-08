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
 * Choose the tray mark for current OS chrome.
 *
 * On Windows, prefer `shouldUseDarkColors`: Electron #52308 leaves
 * `shouldUseDarkColorsForSystemIntegratedUI` wrong after the first theme
 * `updated` (and it never recovers until restart), while `shouldUseDarkColors`
 * tracks live flips. That means a rare custom Apps≠taskbar mismatch can be
 * wrong until Electron fixes the property, but theme changes stay correct.
 *
 * On macOS the two properties match; prefer system-integrated when present.
 */
function trayChromeIsDark(nativeTheme, options = {}) {
	const platform = options.platform ?? process.platform
	if (platform === 'win32') {
		return Boolean(nativeTheme.shouldUseDarkColors)
	}
	if (
		typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === 'boolean'
	) {
		return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
	}
	return Boolean(nativeTheme.shouldUseDarkColors)
}

function createTrayIcon(nativeImage, nativeTheme, options = {}) {
	const dark = options.dark ?? trayChromeIsDark(nativeTheme, options)
	return nativeImage.createFromPath(trayIconPath(dark, options.root))
}

module.exports = {
	trayChromeIsDark,
	createTrayIcon,
}

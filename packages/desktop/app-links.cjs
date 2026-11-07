const { execFile } = require('node:child_process')

const browsingWebActivity = 'NSUserActivityTypeBrowsingWeb'

// macOS hands universal links for kody.codes to the app; the site's
// apple-app-site-association file decides which paths reach it.
function appLinkPath(value, origin) {
	try {
		const url = new URL(value)
		if (url.origin !== origin || url.username || url.password) return null
		return `${url.pathname}${url.search}${url.hash}`
	} catch {
		return null
	}
}

// Links can arrive before the app is ready on a cold start. Hold them until
// startup takes them, then hand later links straight to `open`.
function createAppLinkRouter({ origin, open }) {
	let pending = []
	return {
		receive(value) {
			const path = appLinkPath(value, origin)
			if (!path) return false
			if (pending) pending.push(path)
			else open(path)
			return true
		},
		start() {
			const paths = pending
			pending = null
			return paths
		},
	}
}

// shell.openExternal goes through Launch Services, which would hand an
// associated kody.codes link straight back to this app. Open the default
// browser by path instead.
async function openInBrowser(
	url,
	{ app, shell, platform = process.platform, run = execFile },
) {
	if (platform === 'darwin') {
		const browser = await app
			.getApplicationInfoForProtocol('https://')
			.catch(() => null)
		if (browser?.path && !browser.path.endsWith('/Kody.app')) {
			await new Promise((resolve, reject) =>
				run('open', ['-a', browser.path, url], (error) =>
					error ? reject(error) : resolve(),
				),
			)
			return
		}
	}
	await shell.openExternal(url)
}

module.exports = {
	browsingWebActivity,
	appLinkPath,
	createAppLinkRouter,
	openInBrowser,
}

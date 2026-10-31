const appOrigin = 'https://kody.codes'
function isAppUrl(value) {
	try {
		const url = new URL(value)
		return url.origin === appOrigin && !url.username && !url.password
	} catch {
		return false
	}
}
function isExternalUrl(value) {
	try {
		const url = new URL(value)
		return (
			['https:', 'mailto:'].includes(url.protocol) &&
			!url.username &&
			!url.password
		)
	} catch {
		return false
	}
}
// Social sign-in must return to this webview so its session cookie stays here.
// These pages receive the same sandbox as the website, with no native bridge.
function isNavigationUrl(value) {
	if (isAppUrl(value)) return true
	try {
		const url = new URL(value)
		return (
			!url.username &&
			!url.password &&
			[
				'https://github.com',
				'https://accounts.google.com',
				'https://x.com',
				'https://twitter.com',
				'https://discord.com',
			].includes(url.origin)
		)
	} catch {
		return false
	}
}
module.exports = { appOrigin, isAppUrl, isExternalUrl, isNavigationUrl }

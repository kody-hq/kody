// `kody login --no-browser` prints its authorize URL. Machine setup approves
// it in an app window that reuses the app's Kody session, and keeps the
// system browser for anything that needs a fresh sign-in.
function loginAuthorizationUrl(text) {
	for (const match of text.matchAll(/https?:\/\/[^\s]+/g)) {
		const target = approvalTarget(match[0])
		if (target) return target.url.href
	}
	return null
}

// The CLI's authorize URL, and the exact loopback callback it may return to.
function approvalTarget(value, appOrigin) {
	let url
	let callback
	try {
		url = new URL(value)
		callback = new URL(url.searchParams.get('redirect_uri') ?? '')
	} catch {
		return null
	}
	if (
		url.pathname !== '/oauth/authorize' ||
		url.username ||
		url.password ||
		(appOrigin !== undefined && url.origin !== appOrigin) ||
		callback.protocol !== 'http:' ||
		callback.hostname !== '127.0.0.1' ||
		!callback.port ||
		callback.pathname !== '/callback' ||
		callback.username ||
		callback.password
	)
		return null
	return { url, callback: `${callback.origin}${callback.pathname}` }
}

// Only the consent page and its loopback callback load in the approval window.
// Any other page (sign-in, signup, a social provider) leaves it.
function approvalNavigation(target, value) {
	let url
	try {
		url = new URL(value)
	} catch {
		return 'leave'
	}
	if (url.username || url.password) return 'leave'
	if (`${url.origin}${url.pathname}` === target.callback) return 'callback'
	if (url.origin === target.url.origin && url.pathname === '/oauth/authorize')
		return 'consent'
	return 'leave'
}

// Approve in the app only when the consent page would show the app's own
// verified session, not a sign-in form.
async function canApproveInApp(target, fetchInfo) {
	try {
		const url = new URL('/oauth/authorize-info', target.url)
		url.search = target.url.search
		const response = await fetchInfo(url.href)
		if (!response.ok) return false
		const info = await response.json()
		return (
			info?.ok === true &&
			info.requireCredentials === false &&
			info.emailVerified === true &&
			Array.isArray(info.orgs) &&
			info.orgs.length > 0
		)
	} catch {
		return false
	}
}

module.exports = {
	approvalNavigation,
	approvalTarget,
	canApproveInApp,
	loginAuthorizationUrl,
}

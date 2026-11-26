const appLinkProtocol = 'kody:'
const handlePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const packagePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function packageAppKey(owner, packageName) {
	return `${owner}/${packageName}`
}

/**
 * Parses `kody://app/<owner>/<package>/<path>`. Owner and package are
 * lowercased handles; the rest is a path inside the installed app.
 */
function parsePackageAppLink(value) {
	let url
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.protocol !== appLinkProtocol || url.hostname !== 'app') return null
	if (url.username || url.password || url.port) return null
	const [rawOwner, rawPackage, ...rest] = url.pathname
		.split('/')
		.filter(Boolean)
	let owner
	let packageName
	try {
		owner = decodeURIComponent(rawOwner ?? '').toLowerCase()
		packageName = decodeURIComponent(rawPackage ?? '').toLowerCase()
	} catch {
		return null
	}
	if (!handlePattern.test(owner) || !packagePattern.test(packageName))
		return null
	const path = `/${rest.join('/')}${rest.length && url.pathname.endsWith('/') ? '/' : ''}`
	return { owner, packageName, path: `${path}${url.search}${url.hash}` }
}

function buildPackageAppLink(owner, packageName, path = '/') {
	const suffix = path === '/' ? '' : path.startsWith('/') ? path : `/${path}`
	return `kody://app/${encodeURIComponent(owner)}/${encodeURIComponent(packageName)}${suffix}`
}

/** The first package app link among process arguments, else null. */
function packageAppLinkFromArgv(argv) {
	for (const arg of argv) {
		const link = parsePackageAppLink(arg)
		if (link) return link
	}
	return null
}

module.exports = {
	buildPackageAppLink,
	packageAppKey,
	packageAppLinkFromArgv,
	parsePackageAppLink,
}

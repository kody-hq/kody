const { join } = require('node:path')
const { packageAppKey } = require('./package-app-links.cjs')

const handlePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const packagePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const loopbackHosts = ['localhost', '127.0.0.1', '[::1]']
// Kody pages an installed window may pass through on its way to the app:
// the Open app handoff and sign-in. Anything else on Kody opens the browser.
const kodyPassThroughPaths = ['/login', '/signup', '/oauth/authorize']

function webOrigin(value, { allowLoopback }) {
	let url
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.username || url.password) return null
	const loopback = loopbackHosts.includes(url.hostname)
	if (
		url.protocol === 'https:' ||
		(allowLoopback && loopback && url.protocol === 'http:')
	)
		return url.origin
	return null
}

/**
 * Validates an install request from the Kody page. The page is trusted (main
 * Kody frame only), but the record decides which origin a window may load,
 * so every field is checked again here.
 */
function parseInstallRequest(value, { kodyOrigin, allowLoopback = false }) {
	if (!value || typeof value !== 'object') throw new Error('Invalid app.')
	const owner = String(value.owner ?? '').toLowerCase()
	const packageName = String(value.packageName ?? '').toLowerCase()
	if (!handlePattern.test(owner) || !packagePattern.test(packageName))
		throw new Error('Invalid app.')
	const appOrigin = webOrigin(value.appOrigin, { allowLoopback })
	if (!appOrigin || appOrigin === kodyOrigin)
		throw new Error('Apps install only from their own hosted origin.')
	const openUrl = new URL(String(value.openUrl ?? ''), kodyOrigin)
	const openOrigin = webOrigin(openUrl.href, { allowLoopback })
	const handoff = `/@${owner}/packages/${packageName}/open`
	if (
		!(
			(openOrigin === kodyOrigin &&
				(openUrl.pathname === handoff ||
					openUrl.pathname.startsWith(`${handoff}/`))) ||
			openOrigin === appOrigin
		)
	)
		throw new Error('The app link does not match this app.')
	let iconUrl = null
	if (value.iconUrl) {
		const icon = new URL(String(value.iconUrl), kodyOrigin)
		if (icon.origin === kodyOrigin) iconUrl = icon.href
	}
	const name =
		String(value.name ?? '')
			.trim()
			.slice(0, 100) || packageName
	return { owner, packageName, name, appOrigin, openUrl: openUrl.href, iconUrl }
}

/**
 * Where a top-level navigation in an installed window may go: stay (app
 * origin, or the Kody handoff and sign-in pages), or leave for the browser.
 */
function installedNavigation(app, value, kodyOrigin) {
	let url
	try {
		url = new URL(value)
	} catch {
		return 'block'
	}
	if (url.origin === app.appOrigin) return 'stay'
	if (url.origin === kodyOrigin) {
		const handoff = `/@${app.owner}/packages/${app.packageName}/open`
		if (
			url.pathname === handoff ||
			url.pathname.startsWith(`${handoff}/`) ||
			kodyPassThroughPaths.includes(url.pathname)
		)
			return 'stay'
	}
	return ['http:', 'https:', 'mailto:'].includes(url.protocol)
		? 'browser'
		: 'block'
}

/** URL to open for a path inside the app, through the handoff when signed in. */
function packageAppUrl(app, path = '/') {
	const suffix = path === '/' ? '' : path
	const open = new URL(app.openUrl)
	if (open.origin === app.appOrigin) return `${app.appOrigin}${suffix || '/'}`
	open.pathname = `/@${app.owner}/packages/${app.packageName}/open${suffix.split(/[?#]/)[0]}`
	const tail = suffix.match(/[?#].*$/)?.[0] ?? ''
	return `${open.origin}${open.pathname}${tail}`
}

function validBounds(value) {
	if (!value || typeof value !== 'object') return null
	const { x, y, width, height } = value
	if (![x, y, width, height].every(Number.isFinite)) return null
	if (width < 320 || height < 240) return null
	return { x, y, width, height }
}

/** Installed apps on this computer, kept in one JSON file. */
class PackageAppStore {
	constructor({ path, fs }) {
		this.path = path
		this.fs = fs
		this.apps = new Map()
		try {
			const saved = JSON.parse(fs.readFileSync(path, 'utf8'))
			for (const app of saved.apps ?? []) {
				if (app?.owner && app?.packageName)
					this.apps.set(packageAppKey(app.owner, app.packageName), app)
			}
		} catch {}
	}
	get(owner, packageName) {
		return this.apps.get(packageAppKey(owner, packageName)) ?? null
	}
	list() {
		return Array.from(this.apps.values())
	}
	put(app) {
		const key = packageAppKey(app.owner, app.packageName)
		const existing = this.apps.get(key)
		this.apps.set(key, {
			...existing,
			...app,
			installedAt: existing?.installedAt ?? new Date().toISOString(),
		})
		this.save()
		return this.apps.get(key)
	}
	setBounds(owner, packageName, bounds) {
		const app = this.get(owner, packageName)
		const valid = validBounds(bounds)
		if (!app || !valid) return
		app.bounds = valid
		this.save()
	}
	remove(owner, packageName) {
		const removed = this.apps.delete(packageAppKey(owner, packageName))
		if (removed) this.save()
		return removed
	}
	save() {
		const { dirname } = require('node:path')
		this.fs.mkdirSync(dirname(this.path), { recursive: true })
		const temporary = `${this.path}.tmp`
		this.fs.writeFileSync(
			temporary,
			`${JSON.stringify({ version: 1, apps: this.list() }, null, '\t')}\n`,
		)
		this.fs.renameSync(temporary, this.path)
	}
}

function packageAppStorePath(userData) {
	return join(userData, 'package-apps.json')
}

module.exports = {
	PackageAppStore,
	installedNavigation,
	packageAppStorePath,
	packageAppUrl,
	parseInstallRequest,
}

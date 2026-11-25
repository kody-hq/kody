const { join } = require('node:path')
const { packageAppKey } = require('./package-app-links.cjs')
const {
	launcherIdentity,
	launcherPlan,
	removeLauncher,
	writeLauncher,
} = require('./package-app-launchers.cjs')
const {
	handoffDestination,
	installedNavigation,
	packageAppUrl,
	parseInstallRequest,
} = require('./package-apps.cjs')

const unavailableStatuses = new Set([401, 403, 404, 410])

/**
 * Installed package apps: one sandboxed window per app on the app's hosted
 * origin, sharing the Kody session so the Open app handoff signs it in.
 * Windows get no preload, so no desktop bridge reaches app pages or frames.
 */
const unavailableDetail = {
	signIn:
		'Sign in to Kody to open this app, then retry. Or uninstall it from this computer.',
	gone: 'The publisher took this app down or you no longer have access. Retry, or uninstall it from this computer.',
	offline:
		'Kody could not reach this app. Check your connection and retry, or uninstall it from this computer.',
}

function createPackageAppWindows(deps) {
	const {
		BrowserWindow,
		dialog,
		store,
		kodyOrigin,
		allowLoopback,
		openBrowser,
		launcherContext,
		fetchIcon,
		installAllowed,
		fs,
		platform = process.platform,
		partition = 'persist:kody',
	} = deps
	const windows = new Map()

	function planFor(app) {
		return launcherPlan({ ...launcherContext, platform, app })
	}

	async function install(request) {
		const app = parseInstallRequest(request, { kodyOrigin, allowLoopback })
		if (!(await installAllowed(app.owner)))
			throw new Error('Installing apps is not available for this account yet.')
		const icon = app.iconUrl
			? await fetchIcon(app.iconUrl).catch((error) => {
					// The launcher still opens the app, with the default icon.
					console.warn(`Kody could not download the app icon: ${error.message}`)
					return null
				})
			: null
		const plan = planFor(app)
		try {
			await writeLauncher(plan, {
				...launcherContext.io,
				fs,
				icon,
				tempPath: join(
					launcherContext.iconDirectory,
					`${app.owner}.${app.packageName}.png`,
				),
			})
		} catch (error) {
			await removeLauncher(plan, { fs }).catch((cleanupError) => {
				console.warn(
					`Kody could not remove a partial launcher: ${cleanupError.message}`,
				)
			})
			throw error
		}
		const saved = store.put(app)
		open(saved, '/')
		return {
			owner: saved.owner,
			packageName: saved.packageName,
			name: saved.name,
		}
	}

	async function uninstall({ owner, packageName }) {
		const app = store.get(String(owner), String(packageName))
		if (!app) return
		windows.get(packageAppKey(app.owner, app.packageName))?.destroy()
		await removeLauncher(planFor(app), { fs })
		store.remove(app.owner, app.packageName)
	}

	function list() {
		return store
			.list()
			.map(({ owner, packageName, name }) => ({ owner, packageName, name }))
	}

	/** Opens an installed app for `kody://app/...`; false when not installed. */
	function openLink(link) {
		const app = store.get(link.owner, link.packageName)
		if (!app) return false
		open(app, link.path)
		return true
	}

	function open(app, path) {
		const key = packageAppKey(app.owner, app.packageName)
		const existing = windows.get(key)
		if (existing && !existing.isDestroyed()) {
			if (existing.isMinimized()) existing.restore()
			existing.show()
			existing.focus()
			if (path && path !== '/') void existing.loadURL(packageAppUrl(app, path))
			return existing
		}
		const window = createWindow(app)
		windows.set(key, window)
		window.on('closed', () => {
			if (windows.get(key) === window) windows.delete(key)
		})
		void window.loadURL(packageAppUrl(app, path)).catch(() => {})
		return window
	}

	function createWindow(app) {
		const window = new BrowserWindow({
			width: 1100,
			height: 760,
			...app.bounds,
			minWidth: 360,
			minHeight: 280,
			title: app.name,
			backgroundColor: '#ffffff',
			show: true,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webviewTag: false,
				partition,
			},
		})
		if (platform === 'win32')
			window.setAppDetails({
				appId: launcherIdentity(app.owner, app.packageName),
			})
		const contents = window.webContents
		const origins = [app.appOrigin]
		let lastHop = null
		function guard(event, url) {
			const kind = installedNavigation(app, url, kodyOrigin, origins)
			if (kind === 'stay') {
				lastHop = url
				return
			}
			event.preventDefault()
			if (kind === 'browser') void openBrowser(url)
			if (kind === 'unavailable') void unavailable('gone')
		}
		contents.on('did-start-navigation', (event) => {
			if (event.isMainFrame) lastHop = event.url
		})
		contents.on('will-navigate', guard)
		contents.on('will-redirect', (event, url) => {
			const destination = handoffDestination(app, lastHop, url, {
				kodyOrigin,
				allowLoopback,
			})
			if (destination && !origins.includes(destination))
				origins.push(destination)
			guard(event, url)
		})
		contents.on('will-attach-webview', (event) => event.preventDefault())
		contents.setWindowOpenHandler(({ url }) => {
			const kind = installedNavigation(app, url, kodyOrigin, origins)
			if (kind === 'stay' || kind === 'browser') void openBrowser(url)
			return { action: 'deny' }
		})
		contents.on('page-title-updated', (event, title) => {
			event.preventDefault()
			window.setTitle(title ? `${title} - ${app.name}` : app.name)
		})
		let prompting = false
		async function unavailable(reason) {
			if (prompting || window.isDestroyed()) return
			prompting = true
			const { response } = await dialog.showMessageBox(window, {
				type: 'warning',
				buttons: ['Retry', 'Uninstall', 'Close'],
				defaultId: 0,
				cancelId: 2,
				message: `${app.name} is unavailable`,
				detail: unavailableDetail[reason],
			})
			prompting = false
			if (window.isDestroyed()) return
			if (response === 0)
				void window.loadURL(packageAppUrl(app, '/')).catch(() => {})
			else if (response === 1) await uninstall(app)
			else window.close()
		}
		contents.on('did-navigate', (_event, url, status) => {
			if (!unavailableStatuses.has(status)) return
			const origin = new URL(url).origin
			if (origins.includes(origin) || origin === kodyOrigin)
				void unavailable(status === 401 ? 'signIn' : 'gone')
		})
		contents.on(
			'did-fail-load',
			(_event, errorCode, _description, _url, isMainFrame) => {
				// -3 is a canceled navigation, not a failure.
				if (isMainFrame && errorCode !== -3) void unavailable('offline')
			},
		)
		window.on('close', () => {
			if (!window.isMinimized() && !window.isFullScreen())
				store.setBounds(app.owner, app.packageName, window.getNormalBounds())
		})
		return window
	}

	return {
		install,
		uninstall,
		list,
		openLink,
		get size() {
			return windows.size
		},
	}
}

module.exports = { createPackageAppWindows }

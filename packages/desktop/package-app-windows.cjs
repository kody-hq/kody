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
const {
	createPermissionGate,
	permissionKinds,
	permissionLabels,
	permissionState,
} = require('./package-app-permissions.cjs')
const {
	maxShortcuts,
	popoverBounds,
	popoverSize,
	validAccelerator,
} = require('./package-app-background.cjs')

const unavailableStatuses = new Set([401, 403, 404, 410])
const maxExtraWindows = 8
const supportedPermissions = new Set(permissionKinds)

/** An in-app path from page input: one leading slash, no scheme or host. */
function appPath(value) {
	if (typeof value !== 'string' || value.length > 2048) return null
	if (!value.startsWith('/') || value.startsWith('//')) return null
	if (/[\\\s]/.test(value)) return null
	return value
}

/**
 * Installed package apps: one sandboxed window per app on the app's hosted
 * origin, sharing the Kody session so the Open app handoff signs it in.
 * The app preload exposes `window.kodyDesktopApp` only to the main frame on
 * the app's origin while the session flag is on, and every call is checked
 * again here against the sending frame.
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
		preload,
		askPermission,
		setBadge = () => {},
		menuChanged = () => {},
		Tray,
		nativeImage,
		globalShortcut,
		screen,
		trayIcon = () => null,
		setStartAtLogin = () => {},
	} = deps
	const windows = new Map()
	const extras = new Map()
	const records = new Map()
	const flags = new Map()
	const badges = new Map()
	const trays = new Map()
	const shortcuts = new Map()
	const gate = createPermissionGate({ store, ask: askPermission })

	function planFor(app) {
		return launcherPlan({ ...launcherContext, platform, app })
	}

	async function install(request) {
		const { declaredMenuBar, ...app } = parseInstallRequest(request, {
			kodyOrigin,
			allowLoopback,
		})
		if (!(await installAllowed(app.owner)))
			throw new Error('Installing apps is not available for this account yet.')
		const icon = await launcherIcon(app)
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
		if (declaredMenuBar)
			void offerMenuBar(saved, declaredMenuBar).catch((error) => {
				console.warn(`Kody could not add the menu-bar item: ${error.message}`)
			})
		return {
			owner: saved.owner,
			packageName: saved.packageName,
			name: saved.name,
		}
	}

	/** The `kody.app.desktop.icon` the app serves, else the package icon. */
	async function launcherIcon(app) {
		for (const url of [app.installIconUrl, app.iconUrl]) {
			if (!url) continue
			try {
				return await fetchIcon(url)
			} catch (error) {
				// The launcher still opens the app, with the default icon.
				console.warn(`Kody could not download the app icon: ${error.message}`)
			}
		}
		return null
	}

	/**
	 * A declared `kody.app.desktop.menuBar` asks for the menu bar permission
	 * once, then adds the item unless the app already set its own.
	 */
	async function offerMenuBar(app, declared) {
		const origin = app.appOrigin
		if ((await gate.request(app, origin, 'menuBar')) !== 'granted') return
		const current = store.get(app.owner, app.packageName)
		if (!current || current.menuBar) return
		const menuBar = { ...declared, origin, appOrigin: current.appOrigin }
		store.put({ ...current, menuBar })
		showTray(store.get(app.owner, app.packageName))
	}

	async function uninstall({ owner, packageName }) {
		const app = store.get(String(owner), String(packageName))
		if (!app) return
		const key = packageAppKey(app.owner, app.packageName)
		windows.get(key)?.destroy()
		for (const extra of extras.get(key) ?? []) extra.destroy()
		if (badges.delete(key)) totalBadge()
		removeTray(app)
		unregisterShortcuts(key)
		await removeLauncher(planFor(app), { fs })
		store.remove(app.owner, app.packageName)
		updateStartAtLogin()
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

	/**
	 * Where a link for an app that is not installed goes: `{ path }` to the
	 * package page that offers to install it, `{ signIn: true }` when the shell
	 * has no session to check the owner's flag, or null when the flag is off.
	 * Checks the session fresh, so an earlier signed-out answer is never reused.
	 */
	async function installPagePath(link) {
		if (store.get(link.owner, link.packageName)) return null
		const allowed = await installAllowed(link.owner)
		if (allowed === null) return { signIn: true }
		flags.set(link.owner, { on: allowed === true, at: Date.now() })
		if (allowed !== true) return null
		return { path: `/@${link.owner}/${link.packageName}?install=desktop` }
	}

	const flagMaxAge = 60_000
	/** The owner's session flag, rechecked once it is a minute old. */
	async function refreshFlag(owner) {
		const on = (await installAllowed(owner).catch(() => false)) === true
		flags.set(owner, { on, at: Date.now() })
		return on
	}
	function flagOn(owner) {
		return flags.get(owner)?.on === true
	}
	async function currentFlag(owner) {
		const cached = flags.get(owner)
		if (cached && Date.now() - cached.at < flagMaxAge) return cached.on
		return refreshFlag(owner)
	}

	function open(app, path, { navigate = false, hidden = false } = {}) {
		const key = packageAppKey(app.owner, app.packageName)
		const existing = windows.get(key)
		if (existing && !existing.isDestroyed()) {
			if (existing.isMinimized()) existing.restore()
			existing.show()
			existing.focus()
			if (path && (navigate || path !== '/'))
				void existing.loadURL(packageAppUrl(app, path))
			return existing
		}
		const window = createWindow(
			app,
			hidden ? { window: { show: false } } : null,
		)
		windows.set(key, window)
		window.on('closed', () => {
			if (windows.get(key) === window) windows.delete(key)
		})
		load(app, window, path)
		return window
	}

	function load(app, window, path) {
		void refreshFlag(app.owner)
			.then(() => {
				if (!window.isDestroyed())
					return window.loadURL(packageAppUrl(app, path))
			})
			.catch(() => {})
	}

	function openExtra(app, path, options) {
		const key = packageAppKey(app.owner, app.packageName)
		const set = extras.get(key) ?? new Set()
		if (set.size >= maxExtraWindows)
			throw new Error(`An app can open up to ${maxExtraWindows} extra windows.`)
		const size = (value, min, max) =>
			Number.isFinite(value) ? Math.min(Math.max(value, min), max) : undefined
		const window = createWindow(app, {
			size: {
				width: size(options?.width, 240, 2400) ?? 640,
				height: size(options?.height, 200, 1600) ?? 480,
			},
		})
		set.add(window)
		extras.set(key, set)
		window.on('closed', () => set.delete(window))
		void window.loadURL(packageAppUrl(app, path)).catch(() => {})
	}

	function createWindow(app, extra) {
		const window = new BrowserWindow({
			width: 1100,
			height: 760,
			...(extra?.size ?? app.bounds),
			minWidth: 360,
			minHeight: 280,
			title: app.name,
			backgroundColor: '#ffffff',
			show: true,
			...extra?.window,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webviewTag: false,
				partition,
				...(preload ? { preload } : {}),
			},
		})
		if (platform === 'win32')
			window.setAppDetails({
				appId: launcherIdentity(app.owner, app.packageName),
			})
		const contents = window.webContents
		const origins = [app.appOrigin]
		let lastHop = null
		const contentsId = contents.id
		records.set(contentsId, { app, window, origins })
		window.on('closed', () => records.delete(contentsId))
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
			if (!event.isMainFrame) return
			lastHop = event.url
			// Signing in through the handoff can turn the owner's flag on.
			if (frameOrigin(event.url) === kodyOrigin) void refreshFlag(app.owner)
		})
		contents.on('did-navigate', () => {
			if (window.isFocused?.()) menuChanged()
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
			if (response === 0) load(app, window, '/')
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
			if (extra?.size) return
			if (!window.isMinimized() && !window.isFullScreen())
				store.setBounds(app.owner, app.packageName, window.getNormalBounds())
		})
		return window
	}

	function recordFor(contents) {
		const record = contents && records.get(contents.id)
		if (!record || record.window.isDestroyed()) return null
		return record
	}

	function frameOrigin(url) {
		try {
			return new URL(url).origin
		} catch {
			return null
		}
	}

	/** Sync check from the app preload: main frame, app origin, flag on. */
	function bridgeAllowed(contents, frame, origin) {
		const record = recordFor(contents)
		return Boolean(
			record &&
			frame &&
			!frame.parent &&
			frame.origin === origin &&
			record.origins.includes(origin) &&
			flagOn(record.app.owner),
		)
	}

	function totalBadge() {
		let total = 0
		for (const count of badges.values()) total += count
		setBadge(total)
	}

	async function call(contents, frame, action, args) {
		const record = recordFor(contents)
		if (!record || !bridgeAllowed(contents, frame, frame?.origin))
			throw new Error('Desktop features are only available in installed apps.')
		const { window } = record
		if (!(await currentFlag(record.app.owner)))
			throw new Error('Desktop features are only available in installed apps.')
		const app = store.get(record.app.owner, record.app.packageName)
		if (!app) throw new Error('This app is not installed.')
		const origin = frame.origin
		const granted = (kind) => permissionState(app, origin, kind) === 'granted'
		const [first, second] = args
		switch (action) {
			case 'permission-query':
				if (!supportedPermissions.has(first)) return 'unavailable'
				return permissionState(app, origin, first)
			case 'permission-request':
				if (!supportedPermissions.has(first)) return 'unavailable'
				return gate.request(app, origin, first)
			case 'badge': {
				if (!granted('notifications')) return
				const count = Number.isInteger(first) && first > 0 ? first : 0
				badges.set(packageAppKey(app.owner, app.packageName), count)
				totalBadge()
				return
			}
			case 'window-show':
				window.show()
				return
			case 'window-hide':
				window.hide()
				return
			case 'window-focus':
				if (window.isMinimized()) window.restore()
				window.show()
				window.focus()
				return
			case 'window-floating':
				if (!granted('floating')) return
				window.setAlwaysOnTop(first === true, 'floating')
				return
			case 'window-open': {
				const path = appPath(first)
				if (!path) throw new Error('Open a path inside this app.')
				openExtra(app, path, second)
				return
			}
			case 'menu-bar-set': {
				if (!granted('menuBar')) return
				const path = appPath(first)
				if (!path) throw new Error('Open a path inside this app.')
				const menuBar = {
					path,
					origin,
					appOrigin: app.appOrigin,
					tooltip: typeof second === 'string' ? second.slice(0, 120) : null,
				}
				store.put({ ...app, menuBar })
				showTray(store.get(app.owner, app.packageName))
				return
			}
			case 'menu-bar-remove':
				if (store.get(app.owner, app.packageName)?.menuBar?.origin === origin)
					removeTray(app)
				return
			case 'menu-bar-size': {
				const popover = trays.get(
					packageAppKey(app.owner, app.packageName),
				)?.popover
				if (popover !== window) return
				const { width, height } = popoverSize(first)
				popover.setSize(width, height)
				if (popover.isVisible())
					placePopover(trays.get(packageAppKey(app.owner, app.packageName)))
				return
			}
			case 'shortcut-register': {
				if (!granted('shortcuts')) return false
				const accelerator = validAccelerator(first)
				if (!accelerator) throw new Error('Use a modifier and one key.')
				const key = packageAppKey(app.owner, app.packageName)
				const set = shortcuts.get(key) ?? new Map()
				if (set.get(accelerator) === origin) return true
				if (set.has(accelerator)) return false
				if (set.size >= maxShortcuts)
					throw new Error(
						`An app can register up to ${maxShortcuts} shortcuts.`,
					)
				const ok = globalShortcut.register(accelerator, () =>
					pressShortcut(app, accelerator),
				)
				if (ok) {
					set.set(accelerator, origin)
					shortcuts.set(key, set)
				}
				return ok
			}
			case 'shortcut-unregister': {
				const set = shortcuts.get(packageAppKey(app.owner, app.packageName))
				if (set?.get(first) === origin) {
					set.delete(first)
					globalShortcut.unregister(first)
				}
				return
			}
			case 'start-at-login': {
				if (!granted('startAtLogin')) return
				store.put({
					...app,
					startAtLogin:
						first === true ? { origin, appOrigin: app.appOrigin } : null,
				})
				updateStartAtLogin()
				return
			}
			case 'open-path': {
				const path = appPath(first)
				if (!path) return
				open(app, path, { navigate: true })
				return
			}
			default:
				throw new Error('Unknown desktop action.')
		}
	}

	function pressShortcut(app, accelerator) {
		const key = packageAppKey(app.owner, app.packageName)
		const existing = windows.get(key)
		const window = existing ?? open(app, '/')
		const send = () => {
			if (!window.isDestroyed())
				window.webContents.send('kody:package-app-shortcut', accelerator)
		}
		// A reopened window starts loading only after the flag check.
		if (!existing || window.webContents.isLoading())
			window.webContents.once('did-finish-load', send)
		else send()
	}

	function unregisterShortcuts(key) {
		for (const accelerator of shortcuts.get(key)?.keys() ?? [])
			globalShortcut.unregister(accelerator)
		shortcuts.delete(key)
	}

	/** A menu-bar icon whose click toggles a popover on the app's menu-bar page. */
	function showTray(app) {
		const key = packageAppKey(app.owner, app.packageName)
		const { menuBar } = app
		if (!stillGranted(app, menuBar, 'menuBar')) return
		let entry = trays.get(key)
		if (!entry) {
			const icon = trayIcon(app)
			const tray = new Tray(icon ?? nativeImage.createEmpty())
			entry = { tray, popover: null }
			trays.set(key, entry)
			tray.on('click', () => togglePopover(key))
		}
		entry.tray.setToolTip(menuBar.tooltip || app.name)
		const moved =
			entry.path !== undefined &&
			(entry.path !== menuBar.path || entry.app.appOrigin !== app.appOrigin)
		entry.path = menuBar.path
		entry.app = app
		if (moved && entry.popover && !entry.popover.isDestroyed())
			void entry.popover
				.loadURL(packageAppUrl(app, menuBar.path))
				.catch(() => {})
	}

	function togglePopover(key) {
		const entry = trays.get(key)
		if (!entry) return
		if (!entry.popover || entry.popover.isDestroyed()) {
			const popover = createWindow(entry.app, {
				size: popoverSize(null),
				window: {
					show: false,
					frame: false,
					resizable: false,
					movable: false,
					minimizable: false,
					maximizable: false,
					fullscreenable: false,
					skipTaskbar: true,
					alwaysOnTop: true,
					minWidth: 200,
					minHeight: 120,
				},
			})
			// Clicking the tray blurs the popover first; that click should close it.
			popover.on('blur', () => {
				entry.hiddenAt = Date.now()
				popover.hide()
			})
			entry.popover = popover
			void popover.loadURL(packageAppUrl(entry.app, entry.path)).catch(() => {})
		}
		const popover = entry.popover
		if (popover.isVisible() || Date.now() - (entry.hiddenAt ?? 0) < 250) {
			popover.hide()
			return
		}
		// Linux trays report empty bounds; the click point is the best anchor.
		// Remove when: Electron reports tray bounds on Linux.
		const reported = entry.tray.getBounds()
		entry.anchor = reported.width
			? reported
			: { ...screen.getCursorScreenPoint(), width: 0, height: 0 }
		placePopover(entry)
		popover.show()
		popover.focus()
	}

	function placePopover(entry) {
		const { anchor } = entry
		const { workArea } = screen.getDisplayMatching(anchor)
		const [width, height] = entry.popover.getSize()
		entry.popover.setBounds(popoverBounds(anchor, { width, height }, workArea))
	}

	function removeTray(app) {
		const key = packageAppKey(app.owner, app.packageName)
		const entry = trays.get(key)
		if (entry) {
			entry.popover?.destroy()
			entry.tray.destroy()
			trays.delete(key)
		}
		if (store.get(app.owner, app.packageName)?.menuBar)
			store.put({ ...store.get(app.owner, app.packageName), menuBar: null })
	}

	// A saved background setting counts only for the origin that asked for it,
	// and only while the package is still hosted where it was then.
	function stillGranted(app, setting, kind) {
		return Boolean(
			setting?.origin &&
			setting.appOrigin === app.appOrigin &&
			permissionState(app, setting.origin, kind) === 'granted',
		)
	}

	function wantsStartAtLogin() {
		return store
			.list()
			.some((app) => stillGranted(app, app.startAtLogin, 'startAtLogin'))
	}

	function updateStartAtLogin() {
		setStartAtLogin(wantsStartAtLogin())
	}

	/**
	 * At launch: restore granted menu-bar items, and after a login start open
	 * granted start-at-login apps hidden. Only while the owner's flag is on.
	 * Resolves how many apps opened hidden.
	 */
	async function startBackground({ atLogin }) {
		// Drops a login item whose last grant no longer applies, without
		// re-enabling one the person turned off in their OS settings.
		if (!wantsStartAtLogin()) setStartAtLogin(false)
		const wanted = store
			.list()
			.map((app) => ({
				app,
				tray: stillGranted(app, app.menuBar, 'menuBar'),
				start: atLogin && stillGranted(app, app.startAtLogin, 'startAtLogin'),
			}))
			.filter(({ tray, start }) => tray || start)
		const owners = new Map(
			[...new Set(wanted.map(({ app }) => app.owner))].map((owner) => [
				owner,
				refreshFlag(owner),
			]),
		)
		let opened = 0
		for (const { app, tray, start } of wanted) {
			if (!(await owners.get(app.owner))) continue
			if (tray) showTray(app)
			if (start) {
				open(app, '/', { hidden: true })
				opened++
			}
		}
		return opened
	}

	/**
	 * Web permission requests from installed app windows; undefined for other
	 * windows so the Kody shell's own policy applies.
	 */
	function permissionRequest(contents, permission, details) {
		const record = recordFor(contents)
		if (!record) return undefined
		if (permission !== 'notifications' || !details?.isMainFrame) return false
		const origin = frameOrigin(details.requestingUrl)
		if (!origin || !bridgeAllowed(contents, contents.mainFrame, origin))
			return false
		return gate
			.request(record.app, origin, 'notifications')
			.then((state) => state === 'granted')
	}

	function permissionCheck(contents, permission, origin) {
		const record = recordFor(contents)
		if (!record) return undefined
		const app = store.get(record.app.owner, record.app.packageName)
		const normalized = frameOrigin(origin)
		return Boolean(
			permission === 'notifications' &&
			app &&
			normalized &&
			record.origins.includes(normalized) &&
			flagOn(app.owner) &&
			permissionState(app, normalized, 'notifications') === 'granted',
		)
	}

	/** The Permissions menu for a focused installed app window, or null. */
	function menuFor(window) {
		const record = window && recordFor(window.webContents)
		if (!record) return null
		const app = store.get(record.app.owner, record.app.packageName)
		const origin = frameOrigin(window.webContents.getURL())
		if (!app || !origin || !record.origins.includes(origin)) return null
		return {
			label: 'App',
			submenu: [
				{ label: `${app.name} permissions`, enabled: false },
				...permissionKinds
					.filter((kind) => supportedPermissions.has(kind))
					.map((kind) => ({
						label: permissionLabels[kind],
						type: 'checkbox',
						checked: permissionState(app, origin, kind) === 'granted',
						click: (item) =>
							changePermission(
								app,
								origin,
								kind,
								item.checked ? 'granted' : 'denied',
							),
					})),
				{
					label: 'Ask again for every permission',
					click: () => {
						for (const kind of permissionKinds)
							changePermission(app, origin, kind, null)
					},
				},
				{ type: 'separator' },
				{
					label: `Uninstall ${app.name}…`,
					click: () => void confirmUninstall(window, app),
				},
			],
		}
	}

	/** Saves a change from the App menu and stops what a revoked grant allowed. */
	function changePermission(app, origin, kind, state) {
		store.setPermission(app.owner, app.packageName, origin, kind, state)
		if (state !== 'granted') {
			const key = packageAppKey(app.owner, app.packageName)
			if (kind === 'floating')
				for (const window of [windows.get(key), ...(extras.get(key) ?? [])])
					if (window && !window.isDestroyed()) window.setAlwaysOnTop(false)
			if (kind === 'notifications' && badges.delete(key)) totalBadge()
			if (kind === 'menuBar') removeTray(app)
			if (kind === 'shortcuts') unregisterShortcuts(key)
			if (kind === 'startAtLogin') updateStartAtLogin()
		}
		menuChanged()
	}

	async function confirmUninstall(window, app) {
		const { response } = await dialog.showMessageBox(window, {
			type: 'question',
			buttons: ['Uninstall', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
			message: `Uninstall ${app.name}?`,
			detail:
				'This removes its window, launcher, and permissions from this computer.',
		})
		if (response === 0) await uninstall(app)
	}

	return {
		install,
		installPagePath,
		uninstall,
		list,
		openLink,
		bridgeAllowed,
		call,
		permissionRequest,
		permissionCheck,
		menuFor,
		startBackground,
		/** Open app windows plus menu-bar items keeping an app running. */
		get size() {
			return windows.size + trays.size
		},
	}
}

module.exports = { createPackageAppWindows }

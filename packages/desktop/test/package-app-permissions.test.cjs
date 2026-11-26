const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
	createPermissionGate,
	permissionState,
} = require('../package-app-permissions.cjs')
const { PackageAppStore } = require('../package-apps.cjs')
const { createPackageAppWindows } = require('../package-app-windows.cjs')

const kodyOrigin = 'https://kody.codes'
const appOrigin = 'https://weather--kent.kody.run'
const app = {
	owner: 'kent',
	packageName: 'weather',
	name: 'Weather',
	appOrigin,
	openUrl: 'https://kody.codes/@kent/packages/weather/open',
	iconUrl: null,
}

function newStore() {
	const path = join(mkdtempSync(join(tmpdir(), 'kody-perms-')), 'apps.json')
	return { path, store: new PackageAppStore({ path, fs }) }
}

let nextId = 1
class FakeWindow {
	static all = []
	constructor(options) {
		this.options = options
		this.handlers = new Map()
		this.destroyed = false
		this.loads = []
		this.alwaysOnTop = false
		const frame = { origin: appOrigin, parent: null }
		this.webContents = {
			id: nextId++,
			mainFrame: frame,
			on: () => {},
			setWindowOpenHandler: () => {},
			getURL: () => this.loads.at(-1) ?? '',
			isLoading: () => false,
			once: (name, handler) => this.handlers.set(`once:${name}`, [handler]),
			sent: [],
			send: (...args) => this.webContents.sent.push(args),
		}
		FakeWindow.all.push(this)
	}
	on(name, handler) {
		const list = this.handlers.get(name) ?? []
		list.push(handler)
		this.handlers.set(name, list)
	}
	async loadURL(url) {
		this.loads.push(url)
	}
	isDestroyed() {
		return this.destroyed
	}
	destroy() {
		this.destroyed = true
		for (const handler of this.handlers.get('closed') ?? []) handler()
	}
	isMinimized() {
		return false
	}
	show() {
		this.visible = true
	}
	hide() {
		this.visible = false
		this.hidden = true
	}
	focus() {}
	setAlwaysOnTop(value) {
		this.alwaysOnTop = value
	}
	setTitle() {}
	setSize(width, height) {
		this.size = [width, height]
	}
	getSize() {
		return this.size ?? [this.options.width, this.options.height]
	}
	setBounds(bounds) {
		this.bounds = bounds
	}
	isVisible() {
		return this.visible === true
	}
}

class FakeTray {
	constructor() {
		this.handlers = new Map()
		FakeTray.last = this
	}
	on(name, handler) {
		this.handlers.set(name, handler)
	}
	setToolTip(value) {
		this.tooltip = value
	}
	getBounds() {
		return { x: 900, y: 0, width: 20, height: 24 }
	}
	destroy() {
		this.destroyed = true
	}
}

async function setup({ flag = true, answers = [], store: given } = {}) {
	const store = given ?? newStore().store
	store.put(app)
	const asked = []
	const shortcuts = new Map()
	const startAtLogin = []
	const badges = []
	const icons = []
	const apps = createPackageAppWindows({
		BrowserWindow: FakeWindow,
		dialog: {},
		store,
		kodyOrigin,
		installAllowed: async () => flag,
		openBrowser: async () => {},
		launcherContext: { home: '/home/k', iconDirectory: '/i', io: {} },
		fs: {
			mkdir: async () => {},
			rm: async () => {},
			writeFile: async () => {},
		},
		fetchIcon: async (url) => {
			icons.push(url)
			return Buffer.from('png')
		},
		platform: 'linux',
		preload: '/preload.cjs',
		askPermission: async (_app, origin, kind) => {
			asked.push([origin, kind])
			return answers.shift() ?? false
		},
		setBadge: (count) => badges.push(count),
		Tray: FakeTray,
		nativeImage: { createEmpty: () => ({}) },
		screen: {
			getDisplayMatching: () => ({
				workArea: { x: 0, y: 24, width: 1000, height: 700 },
			}),
		},
		globalShortcut: {
			register: (accelerator, handler) => {
				shortcuts.set(accelerator, handler)
				return true
			},
			unregister: (accelerator) => shortcuts.delete(accelerator),
		},
		setStartAtLogin: (on) => startAtLogin.push(on),
	})
	apps.openLink({ owner: 'kent', packageName: 'weather', path: '/' })
	const window = FakeWindow.all.at(-1)
	await new Promise((resolve) => setImmediate(resolve))
	return { store, apps, window, asked, badges, icons, shortcuts, startAtLogin }
}

test('permissions start off, ask once, and keep the answer per origin', async () => {
	const { store } = newStore()
	store.put(app)
	let asks = 0
	const gate = createPermissionGate({
		store,
		ask: async () => {
			asks++
			return true
		},
	})
	assert.equal(
		permissionState(store.get('kent', 'weather'), appOrigin, 'notifications'),
		'prompt',
	)
	const [first, second] = await Promise.all([
		gate.request(app, appOrigin, 'notifications'),
		gate.request(app, appOrigin, 'notifications'),
	])
	assert.deepEqual([first, second, asks], ['granted', 'granted', 1])
	assert.equal(await gate.request(app, appOrigin, 'notifications'), 'granted')
	assert.equal(asks, 1)
	assert.equal(
		permissionState(
			store.get('kent', 'weather'),
			'https://other.example',
			'notifications',
		),
		'prompt',
	)
	await assert.rejects(
		gate.request(app, appOrigin, 'files'),
		/Unknown permission/,
	)
})

test('grants survive a reinstall and a reload from disk', async () => {
	const { path, store } = newStore()
	store.put(app)
	store.setPermission('kent', 'weather', appOrigin, 'floating', 'denied')
	store.put({ ...app, name: 'Weather 2' })
	const reloaded = new PackageAppStore({ path, fs })
	assert.equal(
		permissionState(reloaded.get('kent', 'weather'), appOrigin, 'floating'),
		'denied',
	)
	reloaded.setPermission('kent', 'weather', appOrigin, 'floating', null)
	assert.equal(
		permissionState(reloaded.get('kent', 'weather'), appOrigin, 'floating'),
		'prompt',
	)
})

test('the bridge is only for the main frame on the app origin with the flag on', async () => {
	const { apps, window } = await setup()
	const contents = window.webContents
	assert.equal(window.options.webPreferences.preload, '/preload.cjs')
	assert.equal(
		apps.bridgeAllowed(contents, contents.mainFrame, appOrigin),
		true,
	)
	const iframe = { origin: appOrigin, parent: contents.mainFrame }
	assert.equal(apps.bridgeAllowed(contents, iframe, appOrigin), false)
	const elsewhere = { origin: 'https://evil.example', parent: null }
	assert.equal(
		apps.bridgeAllowed(contents, elsewhere, 'https://evil.example'),
		false,
	)
	assert.equal(
		apps.bridgeAllowed({ id: -1 }, contents.mainFrame, appOrigin),
		false,
	)
	await assert.rejects(
		apps.call(contents, iframe, 'permission-query', ['notifications']),
		/only available in installed apps/,
	)
	const off = await setup({ flag: false })
	const offContents = off.window.webContents
	assert.equal(
		off.apps.bridgeAllowed(offContents, offContents.mainFrame, appOrigin),
		false,
	)
})

test('desktop calls check grants: notifications, badge, floating, windows', async () => {
	const { apps, window, asked, badges } = await setup({ answers: [true] })
	const contents = window.webContents
	const frame = contents.mainFrame
	const call = (action, ...args) => apps.call(contents, frame, action, args)
	assert.equal(await call('permission-query', 'clipboardRead'), 'unavailable')
	assert.equal(await call('permission-query', 'floating'), 'prompt')
	await call('window-floating', true)
	assert.equal(window.alwaysOnTop, false)
	assert.equal(await call('permission-request', 'notifications'), 'granted')
	assert.equal(await call('permission-request', 'floating'), 'denied')
	assert.equal(await call('permission-request', 'floating'), 'denied')
	assert.deepEqual(asked, [
		[appOrigin, 'notifications'],
		[appOrigin, 'floating'],
	])
	await call('badge', 3)
	assert.deepEqual(badges, [3])
	await call('window-hide')
	assert.equal(window.hidden, true)
	await assert.rejects(
		call('window-open', 'https://evil.example/'),
		/inside this app/,
	)
	for (let i = 0; i < 8; i++)
		await call('window-open', `/w/${i}`, { width: 10 })
	const extra = FakeWindow.all.at(-1)
	assert.equal(extra.options.width, 240)
	assert.equal(
		extra.loads[0],
		`https://kody.codes/@kent/packages/weather/open/w/7`,
	)
	await assert.rejects(call('window-open', '/w/9'), /up to 8 extra windows/)
	await apps.uninstall(app)
	assert.equal(extra.destroyed, true)
	assert.deepEqual(badges, [3, 0])
})

test('web notification requests follow the local grant; other windows are not decided here', async () => {
	const { apps, window } = await setup({ answers: [false] })
	const contents = window.webContents
	const details = { isMainFrame: true, requestingUrl: `${appOrigin}/` }
	assert.equal(
		apps.permissionRequest({ id: -1 }, 'notifications', details),
		undefined,
	)
	assert.equal(apps.permissionRequest(contents, 'media', details), false)
	assert.equal(
		await apps.permissionRequest(contents, 'notifications', details),
		false,
	)
	assert.equal(
		apps.permissionCheck(contents, 'notifications', appOrigin),
		false,
	)
	assert.equal(
		apps.permissionCheck({ id: -1 }, 'notifications', appOrigin),
		undefined,
	)
})

test('revoking from the App menu stops floating and clears the badge', async () => {
	const { apps, window, badges } = await setup({ answers: [true, true] })
	const contents = window.webContents
	const call = (action, ...args) =>
		apps.call(contents, contents.mainFrame, action, args)
	await call('permission-request', 'notifications')
	await call('permission-request', 'floating')
	await call('window-floating', true)
	await call('badge', 2)
	assert.equal(window.alwaysOnTop, true)
	window.loads.push(`${appOrigin}/today`)
	window.isFocused = () => true
	const menu = apps.menuFor(window)
	const item = (label) => menu.submenu.find((entry) => entry.label === label)
	assert.equal(item('Float above other windows').checked, true)
	item('Float above other windows').click({ checked: false })
	assert.equal(window.alwaysOnTop, false)
	item('Ask again for every permission').click()
	assert.deepEqual(badges, [2, 0])
	assert.equal(apps.menuFor(window).submenu[1].checked, false)
	assert.equal(await call('permission-query', 'notifications'), 'prompt')
	await call('open-path', '/')
	assert.equal(
		window.loads.at(-1),
		'https://kody.codes/@kent/packages/weather/open',
	)
})

test('menu bar, shortcuts, and start at login need their grants and clean up on uninstall', async () => {
	const { apps, window, shortcuts, startAtLogin, store } = await setup({
		answers: [true, true, true],
	})
	const contents = window.webContents
	const call = (action, ...args) =>
		apps.call(contents, contents.mainFrame, action, args)
	assert.equal(await call('shortcut-register', 'CmdOrCtrl+Shift+K'), false)
	await call('menu-bar-set', '/menubar')
	assert.equal(FakeTray.last, undefined)
	await call('permission-request', 'menuBar')
	await call('permission-request', 'shortcuts')
	await call('permission-request', 'startAtLogin')
	await assert.rejects(
		call('menu-bar-set', 'https://evil.example/'),
		/inside this app/,
	)
	await call('menu-bar-set', '/menubar', 'Weather now')
	const tray = FakeTray.last
	assert.equal(tray.tooltip, 'Weather now')
	assert.equal(apps.size, 2)
	tray.handlers.get('click')()
	const popover = FakeWindow.all.at(-1)
	assert.equal(popover.options.frame, false)
	assert.equal(
		popover.loads[0],
		'https://kody.codes/@kent/packages/weather/open/menubar',
	)
	assert.deepEqual(popover.bounds, { x: 640, y: 24, width: 360, height: 480 })
	await apps.call(
		popover.webContents,
		popover.webContents.mainFrame,
		'menu-bar-size',
		['300x200'],
	)
	assert.deepEqual(popover.size, [300, 200])
	assert.deepEqual(popover.bounds, { x: 700, y: 24, width: 300, height: 200 })
	await call('menu-bar-size', '300x900')
	assert.deepEqual(popover.size, [300, 200])
	await call('menu-bar-set', '/menubar', 'Weather later')
	assert.equal(tray.tooltip, 'Weather later')
	assert.equal(popover.loads.length, 1)
	await assert.rejects(call('shortcut-register', 'K'), /modifier/)
	assert.equal(await call('shortcut-register', 'CmdOrCtrl+Shift+K'), true)
	shortcuts.get('CmdOrCtrl+Shift+K')()
	assert.deepEqual(contents.sent.at(-1), [
		'kody:package-app-shortcut',
		'CmdOrCtrl+Shift+K',
	])
	await call('start-at-login', true)
	assert.deepEqual(startAtLogin, [true])
	assert.equal(store.get('kent', 'weather').menuBar.path, '/menubar')
	window.destroy()
	shortcuts.get('CmdOrCtrl+Shift+K')()
	const reopened = FakeWindow.all.at(-1)
	assert.deepEqual(reopened.webContents.sent, [])
	reopened.handlers.get('once:did-finish-load')[0]()
	assert.deepEqual(reopened.webContents.sent, [
		['kody:package-app-shortcut', 'CmdOrCtrl+Shift+K'],
	])
	await apps.uninstall(app)
	assert.equal(tray.destroyed, true)
	assert.equal(shortcuts.size, 0)
	assert.deepEqual(startAtLogin, [true, false])
	assert.equal(apps.size, 0)
})

test('a login start restores menu-bar items and opens start-at-login apps hidden', async () => {
	const { store } = newStore()
	store.put({
		...app,
		startAtLogin: { origin: appOrigin, appOrigin },
		menuBar: { path: '/menubar', origin: appOrigin, appOrigin, tooltip: null },
		permissions: {
			[appOrigin]: { menuBar: 'granted', startAtLogin: 'granted' },
		},
	})
	FakeTray.last = undefined
	const before = FakeWindow.all.length
	const { apps } = await setup({ store })
	// setup() opens the app once; a fresh manager without a window is what launch sees.
	await apps.uninstall(app)
	store.put({
		...app,
		startAtLogin: { origin: appOrigin, appOrigin },
		menuBar: { path: '/menubar', origin: appOrigin, appOrigin, tooltip: null },
		permissions: {
			[appOrigin]: { menuBar: 'granted', startAtLogin: 'granted' },
		},
	})
	assert.equal(await apps.startBackground({ atLogin: true }), 1)
	assert.ok(FakeTray.last && !FakeTray.last.destroyed)
	const opened = FakeWindow.all.at(-1)
	assert.ok(FakeWindow.all.length > before)
	assert.equal(opened.options.show, false)
	await apps.uninstall(app)
	store.put({
		...app,
		appOrigin: 'https://elsewhere.example',
		startAtLogin: { origin: appOrigin, appOrigin },
		permissions: { [appOrigin]: { startAtLogin: 'granted' } },
	})
	assert.equal(await apps.startBackground({ atLogin: true }), 0)
})

test('an install link offers the install page only for a missing app with the flag on', async () => {
	const { apps } = await setup()
	assert.equal(
		await apps.installPagePath({
			owner: 'kent',
			packageName: 'weather',
			path: '/',
		}),
		null,
	)
	assert.deepEqual(
		await apps.installPagePath({
			owner: 'kent',
			packageName: 'notes',
			path: '/x',
		}),
		{ path: '/@kent/notes?install=desktop' },
	)
	const signedOut = await setup({ flag: null })
	assert.deepEqual(
		await signedOut.apps.installPagePath({
			owner: 'ann',
			packageName: 'notes',
			path: '/',
		}),
		{ signIn: true },
	)
	const off = await setup({ flag: false })
	assert.equal(
		await off.apps.installPagePath({
			owner: 'ann',
			packageName: 'notes',
			path: '/',
		}),
		null,
	)
})

test('kody.app.desktop: the install icon wins and a declared menu bar asks once', async () => {
	const { apps, asked, icons, store } = await setup({ answers: [true] })
	store.remove('kent', 'weather')
	FakeTray.last = undefined
	const request = {
		...app,
		iconUrl: 'https://kody.codes/@kent/weather/icon/abc',
		installIconUrl: `${appOrigin}/icons/icon-512.png`,
		menuBar: { path: '/menubar', tooltip: 'Weather now' },
	}
	await apps.install(request)
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(icons, [`${appOrigin}/icons/icon-512.png`])
	assert.deepEqual(asked, [[appOrigin, 'menuBar']])
	assert.equal(FakeTray.last.tooltip, 'Weather now')
	assert.equal(store.get('kent', 'weather').menuBar.path, '/menubar')
	assert.equal(store.get('kent', 'weather').declaredMenuBar, undefined)
	await apps.install(request)
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(asked.length, 1)
	await apps.uninstall(app)
})

test('a declined declared menu bar adds nothing and is not asked again', async () => {
	const { apps, asked, store } = await setup({ answers: [false] })
	store.remove('kent', 'weather')
	FakeTray.last = undefined
	const request = { ...app, menuBar: { path: '/menubar' } }
	await apps.install(request)
	await new Promise((resolve) => setImmediate(resolve))
	await apps.install(request)
	await new Promise((resolve) => setImmediate(resolve))
	assert.deepEqual(asked, [[appOrigin, 'menuBar']])
	assert.equal(FakeTray.last, undefined)
	assert.equal(store.get('kent', 'weather').menuBar, undefined)
	await apps.uninstall(app)
})

test('a changed or dropped declared menu bar follows the publisher; a runtime one stays', async () => {
	const { apps, window, asked, store } = await setup({ answers: [true] })
	store.remove('kent', 'weather')
	const install = async (menuBar) => {
		await apps.install({ ...app, ...(menuBar ? { menuBar } : {}) })
		await new Promise((resolve) => setImmediate(resolve))
	}
	await install({ path: '/menubar' })
	await install({ path: '/tray' })
	assert.equal(store.get('kent', 'weather').menuBar.path, '/tray')
	await install(null)
	assert.equal(store.get('kent', 'weather').menuBar, null)
	const contents = FakeWindow.all.at(-1).webContents
	await apps.call(contents, contents.mainFrame, 'menu-bar-set', ['/mine'])
	await install({ path: '/menubar' })
	assert.equal(store.get('kent', 'weather').menuBar.path, '/mine')
	assert.equal(asked.length, 1)
	assert.ok(window)
	await apps.uninstall(app)
})

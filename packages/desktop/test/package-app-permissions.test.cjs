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
		}
		FakeWindow.all.push(this)
	}
	on(name, handler) {
		this.handlers.set(name, handler)
	}
	async loadURL(url) {
		this.loads.push(url)
	}
	isDestroyed() {
		return this.destroyed
	}
	destroy() {
		this.destroyed = true
		this.handlers.get('closed')?.()
	}
	isMinimized() {
		return false
	}
	show() {}
	hide() {
		this.hidden = true
	}
	focus() {}
	setAlwaysOnTop(value) {
		this.alwaysOnTop = value
	}
	setTitle() {}
}

async function setup({ flag = true, answers = [] } = {}) {
	const { store } = newStore()
	store.put(app)
	const asked = []
	const badges = []
	const apps = createPackageAppWindows({
		BrowserWindow: FakeWindow,
		dialog: {},
		store,
		kodyOrigin,
		installAllowed: async () => flag,
		openBrowser: async () => {},
		launcherContext: { home: '/home/k', iconDirectory: '/i', io: {} },
		fs: { rm: async () => {} },
		platform: 'linux',
		preload: '/preload.cjs',
		askPermission: async (_app, origin, kind) => {
			asked.push([origin, kind])
			return answers.shift() ?? false
		},
		setBadge: (count) => badges.push(count),
	})
	apps.openLink({ owner: 'kent', packageName: 'weather', path: '/' })
	const window = FakeWindow.all.at(-1)
	await new Promise((resolve) => setImmediate(resolve))
	return { store, apps, window, asked, badges }
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
	assert.equal(await call('permission-query', 'menuBar'), 'unavailable')
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

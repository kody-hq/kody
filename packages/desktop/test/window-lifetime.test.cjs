const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')

function fixture(platform = 'darwin') {
	const windows = []
	const errors = []
	let ready
	let capabilities
	let quitting = 0
	let nextLoadError
	let windowProbe
	let failWindowCreation = false
	let focusedWindow
	let menu
	const ipc = new Map()
	const executionRequests = []
	let runnerCount = 0
	let login
	let finishLogin
	const capability = new Promise((resolve) => {
		capabilities = resolve
	})
	const app = Object.assign(new EventEmitter(), {
		setName() {},
		isPackaged: false,
		isReady: () => true,
		requestSingleInstanceLock: () => true,
		whenReady: () =>
			new Promise((resolve) => {
				ready = resolve
			}),
		getPath: () => '/unused',
		dock: { setIcon() {} },
		quit: () => {
			quitting++
		},
	})
	class BrowserWindow extends EventEmitter {
		static getFocusedWindow() {
			return focusedWindow
		}
		static fromWebContents(contents) {
			return windows.find(
				(window) => window.webContents === contents && !window.destroyed,
			)
		}
		constructor() {
			super()
			if (failWindowCreation) throw new Error('Window creation failed')
			this.loads = []
			this.visible = true
			this.destroyed = false
			this.minimized = false
			this.webContents = Object.assign(new EventEmitter(), {
				mainFrame: { url: 'https://kody.codes/account' },
				navigationHistory: {
					canGoBack: () => false,
					canGoForward: () => false,
				},
				send() {},
				isDestroyed: () => this.destroyed,
				loadURL: (url) => this.loadURL(url),
				isCrashed: () => this.crashed === true,
				getURL: () => this.loads.at(-1) ?? '',
				session: {
					setPermissionRequestHandler() {},
					setPermissionCheckHandler() {},
				},
				setWindowOpenHandler: (handler) => {
					this.openHandler = handler
				},
			})
			windows.push(this)
		}
		isDestroyed() {
			return this.destroyed
		}
		isMinimized() {
			return this.minimized
		}
		restore() {
			this.minimized = false
		}
		show() {
			this.visible = true
		}
		focus() {
			focusedWindow = this
			this.emit('focus')
		}
		isFullScreen() {
			return false
		}
		hide() {
			this.visible = false
		}
		loadURL(url) {
			this.loads.push(url)
			return nextLoadError ? Promise.reject(nextLoadError) : Promise.resolve()
		}
		close() {
			let prevented = false
			this.emit('close', {
				preventDefault() {
					prevented = true
				},
			})
			if (!prevented) {
				this.destroyed = true
				if (focusedWindow === this) focusedWindow = null
				this.emit('closed')
			}
		}
	}
	const mocks = {
		electron: {
			app,
			BrowserWindow,
			Menu: {
				setApplicationMenu(value) {
					menu = value
				},
				buildFromTemplate: (value) => value,
			},
			clipboard: {
				writeText(value) {
					mocks.copiedAddress = value
				},
			},
			shell: { openExternal: async () => {} },
			dialog: { showErrorBox: (...args) => errors.push(args) },
			ipcMain: {
				handle(name, handler) {
					ipc.set(name, handler)
				},
			},
			net: { fetch: async () => windowProbe ?? { ok: false } },
		},
		'./updates.cjs': { startUpdates() {}, finishQuit: async () => app.quit() },
		'./browser-login.cjs': {
			browserLogin() {
				let reject
				const result = new Promise((resolve, fail) => {
					finishLogin = resolve
					reject = fail
				})
				login = {
					result,
					cancel() {
						reject(new Error('Browser sign-in canceled.'))
					},
				}
				return login
			},
		},
		'electron-updater': {},
		'./navigation.cjs': require('../navigation.cjs'),
		'set-cookie-parser': {},
		'./site-capabilities.cjs': { supportsIntegratedTitlebar: () => capability },
		'./window-navigation.cjs': require('../window-navigation.cjs'),
		'./app-links.cjs': require('../app-links.cjs'),
		'./runner.cjs': {
			Runner: class extends EventEmitter {
				constructor() {
					super()
					runnerCount++
				}
			},
		},
		'./execution.cjs': {
			DesktopExecution: class {
				async request(command, input) {
					executionRequests.push([command, input])
					return {}
				}
			},
		},
		'node:fs': {
			readFileSync() {
				throw Object.assign(new Error(), { code: 'ENOENT' })
			},
		},
	}
	const context = {
		require: (name) => (name in mocks ? mocks[name] : require(name)),
		process: { platform, argv: [] },
		__dirname: require('node:path').join(__dirname, '..'),
		URL,
		AbortSignal,
	}
	runInNewContext(readFileSync(require.resolve('../main.cjs'), 'utf8'), context)
	return {
		app,
		windows,
		errors,
		start: async () => {
			ready()
			await Promise.resolve()
		},
		finish: async () => {
			capabilities(false)
			await new Promise(setImmediate)
		},
		show: (path, window) => context.showApp(path, window),
		newWindow: (path) => context.newWindow(path),
		pauseWindowProbe: () => {
			let resume
			windowProbe = new Promise((resolve) => {
				resume = () => resolve({ ok: false })
			})
			return resume
		},
		failWindowCreation: () => {
			failWindowCreation = true
		},
		menu: () => menu,
		ipc: (
			name,
			window,
			command,
			input,
			senderFrame = window.webContents.mainFrame,
		) =>
			ipc.get(`kody:${name}`)(
				{ sender: window.webContents, senderFrame },
				command,
				input,
			),
		executionRequests,
		runnerCount: () => runnerCount,
		copiedAddress: () => mocks.copiedAddress,
		finishLogin: () => finishLogin(),
		failLoad: (code) => {
			nextLoadError = code
				? Object.assign(new Error(code), { code })
				: undefined
		},
		quitCount: () => quitting,
	}
}

test('startup, Dock activation, and second launch share one initial page load', async () => {
	const f = fixture()
	await f.start()
	f.app.emit('activate')
	f.app.emit('second-instance')
	await f.finish()
	assert.equal(f.windows.length, 1)
	assert.deepEqual(f.windows[0].loads, ['https://kody.codes/account'])
	assert.deepEqual(f.errors, [])
})

test('macOS close hides the live window and activation restores it without navigation', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const window = f.windows[0]
	await f.show('/somewhere?draft=1#position')
	for (const event of ['activate', 'second-instance']) {
		window.close()
		assert.equal(window.visible, false)
		assert.equal(window.destroyed, false)
		window.minimized = true
		f.app.emit(event)
		assert.equal(window.visible, true)
		assert.equal(window.minimized, false)
	}
	assert.equal(f.windows.length, 1)
	assert.equal(window.loads.length, 2)
	assert.equal(f.quitCount(), 0)
	f.app.emit('before-quit', { preventDefault() {} })
	window.close()
	assert.equal(window.destroyed, true)
	await f.show()
	assert.equal(f.windows.length, 1)
})

test('Windows close still destroys the window and quits', async () => {
	const f = fixture('win32')
	await f.start()
	await f.finish()
	f.windows[0].close()
	assert.equal(f.windows[0].destroyed, true)
	f.app.emit('window-all-closed')
	assert.equal(f.quitCount(), 1)
})

test('canceled navigation is quiet but real load failures are reported', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	f.failLoad('ERR_ABORTED')
	await f.show('/account')
	assert.deepEqual(f.errors, [])
	f.failLoad('ERR_INTERNET_DISCONNECTED')
	await f.show('/account')
	assert.deepEqual(f.errors, [
		['Could not load Kody', 'ERR_INTERNET_DISCONNECTED'],
	])
})

test('reopening a crashed window reloads its current page', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const window = f.windows[0]
	await f.show('/working?draft=1')
	window.close()
	window.crashed = true
	f.app.emit('activate')
	assert.equal(window.visible, true)
	assert.deepEqual(window.loads.slice(-2), [
		'https://kody.codes/working?draft=1',
		'https://kody.codes/working?draft=1',
	])
})

test('reopening retries the failed page once and preserves it after success', async () => {
	const f = fixture()
	f.failLoad('ERR_INTERNET_DISCONNECTED')
	await f.start()
	await f.finish()
	const window = f.windows[0]
	assert.equal(f.errors.length, 1)
	f.failLoad()
	f.app.emit('activate')
	f.app.emit('second-instance')
	assert.deepEqual(window.loads, [
		'https://kody.codes/account',
		'https://kody.codes/account',
	])
})

test('reopening retries failed main-frame navigation from the page', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const window = f.windows[0]
	const url = 'https://kody.codes/working'
	window.webContents.emit('did-fail-load', {}, -106, '', url, false)
	f.app.emit('activate')
	assert.equal(window.loads.length, 1)
	window.webContents.emit('did-fail-load', {}, -3, '', url, true)
	f.app.emit('activate')
	assert.equal(window.loads.length, 1)
	window.webContents.emit('did-fail-load', {}, -106, '', url, true)
	f.app.emit('activate')
	assert.equal(window.loads.at(-1), url)
	assert.equal(window.loads.length, 2)
})

test('New Window uses CmdOrCtrl+N and each window has independent navigation', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const first = f.windows[0]
	await f.show('/first', first)
	const item = f.menu().find((entry) => entry.label === 'File').submenu[0]
	assert.equal(item.label, 'New Window')
	assert.equal(item.accelerator, 'CmdOrCtrl+N')
	item.click()
	await new Promise(setImmediate)
	const second = f.windows[1]
	assert.deepEqual(second.loads, ['https://kody.codes/account'])
	await f.show('/second', second)
	await f.ipc('navigation', first, 'home')
	assert.equal(first.loads.at(-1), 'https://kody.codes/account')
	assert.equal(second.loads.at(-1), 'https://kody.codes/second')
	assert.throws(() =>
		f.ipc('navigation', first, 'state', undefined, {
			url: 'https://kody.codes/account',
		}),
	)
	first.webContents.mainFrame.url = 'https://example.com'
	assert.throws(() => f.ipc('execution', first, 'state'))
	assert.equal(f.runnerCount(), 1)
	await f.ipc('execution', second, 'state')
	assert.equal(f.executionRequests.at(-1)[0], 'state')
})

test('menu actions target the focused window and closing another window keeps its navigation', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const first = f.windows[0]
	const second = await f.newWindow('/second')
	await f.show('/first', first)
	const navigate = f.menu().find((entry) => entry.label === 'Navigate').submenu
	await navigate.find((item) => item.label === 'Copy page address').click()
	assert.equal(f.copiedAddress(), 'https://kody.codes/first')
	first.close()
	assert.equal(first.destroyed, true)
	await f.show()
	await navigate.find((item) => item.label === 'Copy page address').click()
	assert.equal(f.copiedAddress(), 'https://kody.codes/second')
	second.close()
	assert.equal(second.destroyed, false)
	assert.equal(second.visible, false)
	f.app.emit('activate')
	assert.equal(second.visible, true)
	assert.equal(second.loads.length, 1)
	assert.equal(f.quitCount(), 0)
})

test('Cmd+N creates a new window while retaining the hidden last window', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const first = f.windows[0]
	first.close()
	const second = await f.newWindow()
	assert.equal(first.destroyed, false)
	assert.equal(first.visible, false)
	second.close()
	assert.equal(second.destroyed, true)
	f.app.emit('activate')
	assert.equal(first.visible, true)
	assert.equal(first.loads.length, 1)
})

test('failed loads and completion events remain scoped to their owning window', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const first = f.windows[0]
	const second = await f.newWindow('/second')
	first.webContents.emit(
		'did-fail-load',
		{},
		-106,
		'',
		'https://kody.codes/retry-first',
		true,
	)
	second.webContents.emit('did-finish-load')
	await f.show(undefined, second)
	assert.equal(second.loads.length, 1)
	await f.show(undefined, first)
	assert.equal(first.loads.at(-1), 'https://kody.codes/retry-first')
	assert.equal(first.loads.length, 2)
})

test('new-window links open separately and concurrent new windows stay independent', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const first = f.windows[0]
	assert.equal(
		first.openHandler({ url: 'https://kody.codes/link?q=1#here' }).action,
		'deny',
	)
	await new Promise(setImmediate)
	assert.equal(f.windows[1].loads[0], 'https://kody.codes/link?q=1#here')
	assert.equal(first.loads.length, 1)
	const [second, third] = await Promise.all([
		f.newWindow('/two'),
		f.newWindow('/three'),
	])
	assert.notEqual(second, third)
	assert.deepEqual(second.loads, ['https://kody.codes/two'])
	assert.deepEqual(third.loads, ['https://kody.codes/three'])
})

test('browser sign-in returns to its originating window and another window cannot cancel it', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	const first = f.windows[0]
	const second = await f.newWindow('/second')
	const pending = f.ipc('authentication', first, 'login')
	await f.ipc('authentication', second, 'cancel')
	f.finishLogin()
	await pending
	assert.equal(first.loads.at(-1), 'https://kody.codes/account')
	assert.deepEqual(second.loads, ['https://kody.codes/second'])
	const canceled = f.ipc('authentication', first, 'login')
	first.close()
	assert.deepEqual(Object.keys(await canceled), [])
})

for (const fails of [false, true]) {
	test(`Windows waits for a requested window before closing the app, creation ${fails ? 'fails' : 'succeeds'}`, async () => {
		const f = fixture('win32')
		await f.start()
		await f.finish()
		const resume = f.pauseWindowProbe()
		const opening = f.newWindow('/next')
		f.windows[0].close()
		f.app.emit('window-all-closed')
		assert.equal(f.quitCount(), 0)
		if (fails) f.failWindowCreation()
		resume()
		const window = await opening
		assert.equal(f.quitCount(), fails ? 1 : 0)
		if (!fails) assert.equal(window.loads[0], 'https://kody.codes/next')
	})
}

test('explicit Quit still cancels pending window creation', async () => {
	const f = fixture('win32')
	await f.start()
	await f.finish()
	const resume = f.pauseWindowProbe()
	const opening = f.newWindow()
	f.app.emit('before-quit', { preventDefault() {} })
	resume()
	assert.equal(await opening, undefined)
	assert.equal(f.windows.length, 1)
	await new Promise(setImmediate)
	assert.equal(f.quitCount(), 1)
})

function openLink(app, url, type = 'NSUserActivityTypeBrowsingWeb') {
	let handled = false
	app.emit(
		'continue-activity',
		{
			preventDefault() {
				handled = true
			},
		},
		type,
		{},
		{ webpageURL: url },
	)
	return handled
}

test('a universal link on cold start opens the first window at that page', async () => {
	const f = fixture()
	assert.equal(
		openLink(f.app, 'https://kody.codes/@acme/-/jobs?tab=runs#r1'),
		true,
	)
	await f.start()
	await f.finish()
	assert.equal(f.windows.length, 1)
	assert.deepEqual(f.windows[0].loads, [
		'https://kody.codes/@acme/-/jobs?tab=runs#r1',
	])
})

test('a universal link while running opens a new window and keeps the current page', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	await f.show('/account/secrets?draft=1')
	assert.equal(openLink(f.app, 'https://kody.codes/@kent/pkg'), true)
	await new Promise(setImmediate)
	assert.equal(f.windows.length, 2)
	assert.deepEqual(f.windows[0].loads, [
		'https://kody.codes/account',
		'https://kody.codes/account/secrets?draft=1',
	])
	assert.deepEqual(f.windows[1].loads, ['https://kody.codes/@kent/pkg'])
})

test('links for other origins or activity types are left to the system', async () => {
	const f = fixture()
	await f.start()
	await f.finish()
	assert.equal(openLink(f.app, 'https://example.com/account'), false)
	assert.equal(openLink(f.app, 'https://www.kody.codes/account'), false)
	assert.equal(openLink(f.app, 'https://kody.codes/account', 'other'), false)
	await new Promise(setImmediate)
	assert.equal(f.windows.length, 1)
})

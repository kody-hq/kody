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
		constructor() {
			super()
			this.loads = []
			this.visible = true
			this.destroyed = false
			this.minimized = false
			this.webContents = Object.assign(new EventEmitter(), {
				isCrashed: () => this.crashed === true,
				getURL: () => this.loads.at(-1) ?? '',
				session: {
					setPermissionRequestHandler() {},
					setPermissionCheckHandler() {},
				},
				setWindowOpenHandler() {},
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
		focus() {}
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
				this.emit('closed')
			}
		}
	}
	const mocks = {
		electron: {
			app,
			BrowserWindow,
			Menu: { setApplicationMenu() {}, buildFromTemplate: (value) => value },
			dialog: { showErrorBox: (...args) => errors.push(args) },
			ipcMain: { handle() {} },
			net: { fetch: async () => ({ ok: false }) },
		},
		'./updates.cjs': { startUpdates() {}, finishQuit: async () => app.quit() },
		'./browser-login.cjs': {},
		'electron-updater': {},
		'./navigation.cjs': require('../navigation.cjs'),
		'set-cookie-parser': {},
		'./site-capabilities.cjs': { supportsIntegratedTitlebar: () => capability },
		'./window-navigation.cjs': { attachWindowNavigation: () => ({}) },
		'./runner.cjs': { Runner: EventEmitter },
		'./execution.cjs': {
			DesktopExecution: class {
				async request() {}
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
		show: (path) => context.showApp(path),
		failLoad: (code) => {
			nextLoadError = Object.assign(new Error(code), { code })
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

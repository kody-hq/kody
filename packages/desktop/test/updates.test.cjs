const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { test } = require('node:test')
const { startUpdates, finishQuit } = require('../updates.cjs')

function setup({
	isPackaged = true,
	hasUpdateFeed = true,
	checkForUpdates,
} = {}) {
	const updater = new EventEmitter()
	let checks = 0
	let installs = 0
	let quits = 0
	let interval
	let milliseconds
	let changes = 0
	const messages = []
	updater.checkForUpdates = () => {
		checks++
		return (
			checkForUpdates?.() ??
			Promise.resolve({
				isUpdateAvailable: false,
				updateInfo: { version: '0.1.1' },
			})
		)
	}
	updater.quitAndInstall = () => {
		installs++
	}
	const updates = startUpdates({
		app: {
			isPackaged,
			quit: () => {
				quits++
			},
		},
		updater,
		hasUpdateFeed,
		dialog: {
			showMessageBox: async (options) => messages.push(options.message),
		},
		changed: () => {
			changes++
		},
		setIntervalFn: (callback, ms) => {
			interval = callback
			milliseconds = ms
			return { unref() {} }
		},
	})
	return {
		updates,
		updater,
		messages,
		tick: () => interval(),
		get milliseconds() {
			return milliseconds
		},
		get checks() {
			return checks
		},
		get quits() {
			return quits
		},
		get installs() {
			return installs
		},
		get changes() {
			return changes
		},
	}
}

test('development builds never contact the update feed', () => {
	const fixture = setup({ isPackaged: false })
	assert.equal(fixture.updates, null)
	assert.equal(fixture.checks, 0)
})

test('downloads automatically, checks every five minutes, and leaves restart to app shutdown', async () => {
	const fixture = setup()
	await fixture.updates.check()
	assert.equal(fixture.checks, 1)
	assert.equal(fixture.milliseconds, 300_000)
	assert.equal(fixture.updater.autoDownload, true)
	assert.equal(fixture.updater.autoInstallOnAppQuit, true)
	assert.equal(fixture.updater.allowDowngrade, false)
	assert.equal(fixture.updates.install(), false)
	fixture.updater.emit('update-downloaded')
	assert.equal(fixture.changes, 1)
	assert.equal(fixture.installs, 0)
	assert.equal(fixture.updates.install(), true)
	assert.equal(fixture.installs, 1)
	fixture.tick()
	await fixture.updates.check()
	assert.equal(fixture.checks, 2)
})

test('an offline check retries on the next interval without interrupting the user', async () => {
	let failed = true
	const fixture = setup({
		checkForUpdates: () => {
			if (failed) throw new Error('Offline')
			return Promise.resolve({
				isUpdateAvailable: false,
				updateInfo: { version: '0.1.1' },
			})
		},
	})
	await fixture.updates.check()
	assert.deepEqual(fixture.messages, [])
	failed = false
	fixture.tick()
	await fixture.updates.check()
	assert.equal(fixture.checks, 2)
})

test('manual checks explain failures and current versions', async () => {
	const fixture = setup()
	await fixture.updates.check()
	await fixture.updates.check()
	assert.deepEqual(fixture.messages, ['Kody is up to date.'])
	fixture.updater.checkForUpdates = async () => {
		throw new Error('Offline')
	}
	await fixture.updates.check()
	assert.match(fixture.messages[1], /Could not check/)
})

test('a downloaded update cannot install until the execution runner has stopped', async () => {
	let stop
	let installed = false
	const shutdown = finishQuit({
		restart: true,
		runner: {
			close: () =>
				new Promise((resolve) => {
					stop = resolve
				}),
		},
		updates: {
			install: () => {
				installed = true
				return true
			},
		},
		app: { quit: () => assert.fail('Update installer owns the final quit') },
	})
	await Promise.resolve()
	assert.equal(installed, false)
	stop()
	await shutdown
	assert.equal(installed, true)
})

test('runner shutdown failure never starts the installer', async () => {
	await assert.rejects(
		finishQuit({
			runner: {
				close: async () => {
					throw new Error('Runner still active')
				},
			},
			updates: { install: () => assert.fail('Must not replace a running app') },
			app: { quit: () => assert.fail('Must report the shutdown failure') },
		}),
		/Runner still active/,
	)
})

test('failed automatic downloads are handled and retried', async () => {
	let downloads = 0
	const fixture = setup({
		checkForUpdates: async () => ({
			updateInfo: { version: '0.1.2' },
			downloadPromise: Promise.resolve().then(() => {
				downloads++
				throw new Error('Interrupted download')
			}),
		}),
	})
	await fixture.updates.check()
	assert.equal(downloads, 1)
	assert.deepEqual(fixture.messages, [])
	fixture.tick()
	await fixture.updates.check()
	assert.equal(downloads, 2)
	assert.equal(fixture.updates.downloaded, false)
})

test('normal Quit stops the runner and lets the quit installer run without forcing a relaunch', async () => {
	const calls = []
	await finishQuit({
		runner: {
			close: async () => {
				calls.push('stopped')
			},
		},
		updates: {
			install: () => assert.fail('Only Restart requests an explicit relaunch'),
		},
		app: { quit: () => calls.push('quit') },
	})
	assert.deepEqual(calls, ['stopped', 'quit'])
})

test('an installer error still completes the requested quit', async () => {
	const fixture = setup()
	await fixture.updates.check()
	fixture.updater.emit('update-downloaded')
	fixture.updater.quitAndInstall = () =>
		fixture.updater.emit('error', new Error('Installer failed'))
	fixture.updates.install()
	assert.equal(fixture.quits, 1)
})

test('unsigned CI packages never check or install production updates', () => {
	const fixture = setup({ hasUpdateFeed: false })
	assert.equal(fixture.updates, null)
	assert.equal(fixture.checks, 0)
	assert.equal(fixture.installs, 0)
})

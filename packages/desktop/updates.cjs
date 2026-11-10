const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { setup, types, createActor } = require('xstate')

const updateReadinessState = setup({
	schemas: {
		events: {
			DOWNLOAD: /** @type {import('xstate').TypeSchema<{}>} */ (types()),
			INSTALL: /** @type {import('xstate').TypeSchema<{}>} */ (types()),
		},
	},
}).createMachine({
	id: 'desktop.update_readiness',
	description:
		'Downloaded readiness survives failed checks; a new download resets installation readiness until the app quits.',
	initial: 'waiting',
	states: {
		waiting: { on: { DOWNLOAD: { target: 'downloaded' } } },
		downloaded: { on: { DOWNLOAD: {}, INSTALL: { target: 'installing' } } },
		installing: { on: { DOWNLOAD: { target: 'downloaded' } } },
	},
})

const updateCheckState = setup({
	schemas: {
		context:
			/** @type {import('xstate').TypeSchema<{ promise: Promise<void> | null }>} */ (
				types()
			),
		events: {
			CHECK:
				/** @type {import('xstate').TypeSchema<{promise: Promise<void>}>} */ (
					types()
				),
			SETTLED: /** @type {import('xstate').TypeSchema<{}>} */ (types()),
		},
	},
}).createMachine({
	id: 'desktop.update_check',
	description:
		'One update check owns its promise through download and manual feedback, independently of downloaded readiness.',
	initial: 'idle',
	context: { promise: null },
	states: {
		idle: {
			on: {
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({ promise: event.promise }),
				},
			},
		},
		checking: {
			on: { SETTLED: { target: 'idle', context: () => ({ promise: null }) } },
		},
	},
})

// Updates stay in the main process. Quitting is owned by main.cjs so the
// execution runner always finishes shutting down before replacing the app.
function startUpdates({
	app,
	updater,
	dialog,
	changed,
	hasUpdateFeed = !!process.resourcesPath &&
		existsSync(join(process.resourcesPath, 'app-update.yml')),
	setIntervalFn = setInterval,
}) {
	if (!app.isPackaged || !hasUpdateFeed) return null
	const readiness = createActor(updateReadinessState).start()
	const checking = createActor(updateCheckState).start()
	updater.autoDownload = true
	updater.autoInstallOnAppQuit = true
	updater.allowPrerelease = false
	updater.allowDowngrade = false
	updater.on('error', () => {
		console.warn('Kody update failed, it will retry.')
	})
	updater.on('update-downloaded', () => {
		readiness.send({ type: 'DOWNLOAD' })
		changed()
	})
	async function check(manual = false) {
		const snapshot = checking.getSnapshot()
		if (snapshot.value === 'checking') return snapshot.context.promise
		const promise = Promise.resolve().then(async () => {
			try {
				const result = await updater.checkForUpdates()
				await result?.downloadPromise
				if (manual && result && !result.isUpdateAvailable)
					await dialog.showMessageBox({
						message: 'Kody is up to date.',
						buttons: ['OK'],
					})
			} catch {
				if (manual)
					await dialog.showMessageBox({
						message: 'Could not check for updates. Try again later.',
						buttons: ['OK'],
					})
			} finally {
				checking.send({ type: 'SETTLED' })
			}
		})
		checking.send({ type: 'CHECK', promise })
		return promise
	}
	void check()
	const timer = setIntervalFn(() => void check(), 5 * 60 * 1000)
	timer.unref()
	return {
		check: () => check(true),
		get downloaded() {
			return readiness.getSnapshot().value !== 'waiting'
		},
		stop: () => clearInterval(timer),
		install: () => {
			if (readiness.getSnapshot().value === 'waiting') return false
			if (readiness.getSnapshot().value === 'installing') return true
			readiness.send({ type: 'INSTALL' })
			// Some installers report failure through an event instead of throwing.
			// Finish the requested quit even when installation cannot start.
			updater.once('error', () => app.quit())
			updater.quitAndInstall(false, true)
			return true
		},
	}
}
async function finishQuit({ runner, updates, app, restart = false }) {
	await runner.close()
	if (!restart || !updates?.install()) app.quit()
}
module.exports = {
	startUpdates,
	finishQuit,
	updateReadinessState,
	updateCheckState,
}

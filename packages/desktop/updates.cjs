const { existsSync } = require('node:fs')
const { join } = require('node:path')

const updateReadinessTransitions = Object.freeze({
	waiting: Object.freeze(['downloaded']),
	downloaded: Object.freeze(['downloaded', 'installing']),
	installing: Object.freeze(['downloaded', 'installing']),
})

const updateCheckTransitions = Object.freeze({
	idle: Object.freeze(['checking']),
	checking: Object.freeze(['idle']),
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
	let readiness = 'waiting'
	let checkState = { status: 'idle' }
	const setReadiness = (next) => {
		if (!updateReadinessTransitions[readiness].includes(next))
			throw new Error('Illegal update readiness transition.')
		readiness = next
	}
	const setCheck = (next) => {
		if (!updateCheckTransitions[checkState.status].includes(next.status))
			throw new Error('Illegal update check transition.')
		checkState = next
	}
	updater.autoDownload = true
	updater.autoInstallOnAppQuit = true
	updater.allowPrerelease = false
	updater.allowDowngrade = false
	updater.on('error', () => {
		console.warn('Kody update failed, it will retry.')
	})
	updater.on('update-downloaded', () => {
		setReadiness('downloaded')
		changed()
	})
	async function check(manual = false) {
		if (checkState.status === 'checking') return checkState.promise
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
				setCheck({ status: 'idle' })
			}
		})
		setCheck({ status: 'checking', promise })
		return promise
	}
	void check()
	const timer = setIntervalFn(() => void check(), 5 * 60 * 1000)
	timer.unref()
	return {
		check: () => check(true),
		get downloaded() {
			return readiness !== 'waiting'
		},
		stop: () => clearInterval(timer),
		install: () => {
			if (readiness === 'waiting') return false
			if (readiness === 'installing') return true
			setReadiness('installing')
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
	updateReadinessTransitions,
	updateCheckTransitions,
}

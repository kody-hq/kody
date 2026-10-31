const { existsSync } = require('node:fs')
const { join } = require('node:path')

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
	let downloaded = false
	let checking
	updater.autoDownload = true
	updater.autoInstallOnAppQuit = true
	updater.allowPrerelease = false
	updater.allowDowngrade = false
	updater.on('error', () => {
		console.warn('Kody update failed, it will retry.')
	})
	updater.on('update-downloaded', () => {
		downloaded = true
		changed()
	})
	async function check(manual = false) {
		if (checking) return checking
		checking = Promise.resolve().then(async () => {
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
				checking = null
			}
		})
		return checking
	}
	void check()
	const timer = setIntervalFn(() => void check(), 5 * 60 * 1000)
	timer.unref()
	return {
		check: () => check(true),
		get downloaded() {
			return downloaded
		},
		stop: () => clearInterval(timer),
		install: () => {
			if (!downloaded) return false
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
module.exports = { startUpdates, finishQuit }

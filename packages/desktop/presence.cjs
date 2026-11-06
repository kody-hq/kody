const { Tray, Menu, nativeImage } = require('electron')
const {
	readFileSync,
	writeFileSync,
	renameSync,
	mkdirSync,
} = require('node:fs')
const { join } = require('node:path')

class DesktopPresence {
	constructor({ app, dialog, show, windows, changed }) {
		Object.assign(this, { app, dialog, show, windows, changed })
		this.background = false
		this.chosen = false
	}
	start() {
		if (!['darwin', 'win32'].includes(process.platform)) return
		this.path = join(this.app.getPath('userData'), 'presence.json')
		try {
			const saved = JSON.parse(readFileSync(this.path, 'utf8'))
			this.background = saved.background === true
			this.chosen = saved.chosen === true
		} catch (error) {
			if (error.code !== 'ENOENT') throw error
		}
		const icon =
			process.platform === 'darwin'
				? nativeImage.createFromPath(join(__dirname, 'assets/trayTemplate.png'))
				: nativeImage
						.createFromPath(join(__dirname, 'assets/icon.png'))
						.resize({ width: 20, height: 20 })
		if (process.platform === 'darwin') icon.setTemplateImage(true)
		this.tray = new Tray(icon)
		this.tray.setToolTip('Kody')
		this.tray.on('double-click', () => void this.show())
		this.apply()
	}
	menuItems() {
		if (!this.tray) return []
		return [
			{
				label: 'Run in background',
				type: 'checkbox',
				checked: this.background,
				click: () => this.setBackground(!this.background),
			},
		]
	}
	setBackground(value) {
		try {
			mkdirSync(this.app.getPath('userData'), { recursive: true })
			writeFileSync(
				`${this.path}.tmp`,
				JSON.stringify({ background: value, chosen: true }),
				{ mode: 0o600 },
			)
			renameSync(`${this.path}.tmp`, this.path)
			this.background = value
			this.chosen = true
			this.apply()
			this.changed()
			if (!value) void this.show()
		} catch (error) {
			this.dialog.showErrorBox(
				'Could not save background setting',
				error.message,
			)
		}
	}
	applyWindow(window) {
		if (process.platform === 'win32') window.setSkipTaskbar(this.background)
	}
	apply() {
		// Keep the tray available before removing the app's other entry point.
		this.tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: 'Open Kody', click: () => void this.show() },
				...this.menuItems(),
				{ type: 'separator' },
				{ label: 'Quit Kody', click: () => this.app.quit() },
			]),
		)
		for (const window of this.windows()) this.applyWindow(window)
		if (process.platform === 'darwin') {
			this.app.setActivationPolicy(this.background ? 'accessory' : 'regular')
		}
	}
	async onboard() {
		if (!this.tray || this.chosen) return
		const location = process.platform === 'darwin' ? 'menu bar' : 'system tray'
		const launcher = process.platform === 'darwin' ? 'Dock' : 'taskbar'
		const { response } = await this.dialog.showMessageBox({
			type: 'question',
			message: 'Keep Kody running in the background?',
			detail: `Keep local execution running with the window closed and the ${launcher} icon hidden. Open Kody, change this setting, or quit from the ${location}. Your computer must stay awake.`,
			buttons: ['Run in background', 'Keep in ' + launcher],
			defaultId: 0,
			cancelId: 1,
		})
		this.setBackground(response === 0)
	}
}
module.exports = { DesktopPresence }

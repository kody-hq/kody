const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
	readFileSync,
	writeFileSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { EventEmitter } = require('node:events')

for (const platform of ['darwin', 'win32']) {
	for (const installation of [
		'new',
		'upgraded',
		'invalid-json',
		'null-json',
		'unreadable',
	]) {
		test(`${platform}: ${installation} installation prompts once and preserves its choice`, async () => {
			const profile = mkdtempSync(join(tmpdir(), 'kody-presence-'))
			const machine = {
				ecid: 'ec_existing',
				enabled: true,
				owner: { username: 'existing', orgSlug: 'existing' },
				onboardingSeen: ['existing'],
			}
			if (installation === 'upgraded')
				writeFileSync(join(profile, 'machine.json'), JSON.stringify(machine))
			if (installation === 'invalid-json')
				writeFileSync(join(profile, 'presence.json'), '{')
			if (installation === 'null-json')
				writeFileSync(join(profile, 'presence.json'), 'null')
			if (installation === 'unreadable')
				mkdirSync(join(profile, 'presence.json'))
			let tray,
				visible = true,
				skipped = false,
				opened = 0,
				quit = 0,
				prompts = 0
			const window = {
				setSkipTaskbar: (value) => {
					skipped = value
				},
			}
			const app = {
				getPath: () => profile,
				setActivationPolicy: (policy) => {
					visible = policy === 'regular'
				},
				dock: {
					hide: () => {
						visible = false
					},
					show: async () => {
						visible = true
					},
				},
				quit: () => {
					quit++
				},
			}
			const dialog = {
				showMessageBox: async () => {
					prompts++
					return { response: 0 }
				},
				showErrorBox: (_, message) => {
					throw Error(message)
				},
			}
			const electron = {
				Tray: class extends EventEmitter {
					constructor() {
						super()
						tray = this
					}
					setToolTip() {}
					setContextMenu(menu) {
						this.menu = menu
					}
				},
				Menu: { buildFromTemplate: (items) => items },
				nativeImage: {
					createFromPath: () => ({
						resize() {
							return this
						},
						setTemplateImage() {},
					}),
				},
			}
			const module = { exports: {} }
			runInNewContext(
				readFileSync(join(__dirname, '../presence.cjs'), 'utf8'),
				{
					require: (name) => (name === 'electron' ? electron : require(name)),
					module,
					__dirname: join(__dirname, '..'),
					process: { platform },
				},
			)
			const options = {
				app,
				dialog,
				show: () => {
					opened++
				},
				windows: () => [window],
				changed() {},
			}
			try {
				const presence = new module.exports.DesktopPresence(options)
				if (installation === 'unreadable') {
					assert.throws(() => presence.start(), { code: 'EISDIR' })
					assert.equal(prompts, 0)
					return
				}
				presence.start()
				assert.equal(presence.background, false)
				assert.equal(presence.chosen, false)
				await presence.onboard()
				if (installation === 'upgraded')
					assert.deepEqual(
						JSON.parse(readFileSync(join(profile, 'machine.json'))),
						machine,
					)
				assert.equal(prompts, 1)
				assert.equal(presence.background, true)
				if (platform === 'darwin') assert.equal(visible, false)
				else assert.equal(skipped, true)
				tray.menu.find((item) => item.label === 'Open Kody').click()
				assert.equal(opened, 1)
				tray.menu.find((item) => item.label === 'Quit Kody').click()
				assert.equal(quit, 1)
				const reopened = new module.exports.DesktopPresence(options)
				reopened.start()
				await reopened.onboard()
				assert.equal(prompts, 1)
				assert.equal(reopened.background, true)
				let newSkipped
				reopened.applyWindow({
					setSkipTaskbar: (value) => {
						newSkipped = value
					},
				})
				if (platform === 'win32') assert.equal(newSkipped, true)
				reopened.setBackground(false)
				assert.equal(visible, true)
				assert.equal(skipped, false)
				assert.equal(opened, 2)
				assert.equal(
					JSON.parse(readFileSync(join(profile, 'presence.json'))).background,
					false,
				)
				const foreground = new module.exports.DesktopPresence(options)
				foreground.start()
				await foreground.onboard()
				assert.equal(prompts, 1)
				assert.equal(foreground.background, false)
			} finally {
				rmSync(profile, { recursive: true, force: true })
			}
		})
	}
}

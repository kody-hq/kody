const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { mkdtempSync, rmSync, realpathSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { _electron } = require('@playwright/test')

async function smoke() {
	const env = { ...process.env }
	delete env.ELECTRON_RUN_AS_NODE
	const executablePath = process.argv[2]
	const profile = realpathSync(
		mkdtempSync(join(tmpdir(), 'kody-desktop-smoke-')),
	)
	env.KODY_DESKTOP_TEST_PROFILE = profile
	const preload = ['-r', join(__dirname, 'profile.fixture.cjs')]
	const app = await _electron.launch({
		...(executablePath
			? {
					executablePath: resolve(executablePath),
					args: [`--user-data-dir=${profile}`],
				}
			: { args: [...preload, join(__dirname, '..')] }),
		env,
	})
	try {
		assert.equal(
			await app.evaluate(({ app }) => app.getPath('userData')),
			profile,
		)
		const page = await app.firstWindow()
		await page.waitForURL('https://kody.codes/**')
		await page.waitForLoadState('domcontentloaded')
		const result = await app.evaluate(
			async ({ app: electronApp, BrowserWindow, Menu }) => {
				const window = BrowserWindow.getAllWindows()[0]
				const load = process
					.getBuiltinModule('module')
					.createRequire(joinPath(electronApp.getAppPath(), 'package.json'))
				function joinPath(base, file) {
					return `${base}/${file}`
				}
				const { Runner } = load('./runner.cjs')
				const runner = new Runner()
				try {
					return {
						url: window.webContents.getURL(),
						preferences: window.webContents.getLastWebPreferences(),
						menus: Menu.getApplicationMenu().items.map((item) => item.label),
						version: await runner.command(['version']),
					}
				} finally {
					await runner.close()
				}
			},
		)
		assert.ok(result.url.startsWith('https://kody.codes/'))
		assert.equal(result.preferences.nodeIntegration, false)
		assert.equal(result.preferences.contextIsolation, true)
		assert.equal(result.preferences.sandbox, true)
		assert.equal(result.preferences.webviewTag, false)
		assert.ok(result.menus.includes('Machine'))
		assert.match(result.version, /\d+\.\d+\.\d+/)
		const workflow = executablePath
			? null
			: await app.evaluate(
					async ({ app: electronApp, Menu, dialog }, profile) => {
						if (electronApp.getPath('userData') !== profile)
							throw new Error('Smoke test profile was not isolated.')
						const load = process
							.getBuiltinModule('module')
							.createRequire(`${electronApp.getAppPath()}/package.json`)
						const { Runner } = load('./runner.cjs')
						const calls = []
						Runner.prototype.command = async function (args) {
							calls.push(args)
							if (args[0] === 'whoami')
								return JSON.stringify({
									user: {
										displayName: 'Smoke test account',
										email: 'smoke@example.com',
									},
									org: 'smoke',
									scope: ['execution_context:create'],
								})
							if (args[0] === 'context' && args[1] === 'register')
								return JSON.stringify({ ecid: 'ec_smoke' })
							throw new Error('Unexpected CLI command in smoke test.')
						}
						Runner.prototype.start = function (ecid) {
							calls.push(['start', ecid])
							this.daemon = {}
							this.emit('change')
						}
						Runner.prototype.stop = async function () {
							calls.push(['stop'])
							this.daemon = null
							this.emit('change')
						}
						dialog.showMessageBox = async (options) => ({
							response: options.message.startsWith('Registered ') ? 1 : 0,
						})
						function item(label) {
							return Menu.getApplicationMenu()
								.items.find((entry) => entry.label === 'Machine')
								.submenu.items.find((entry) => entry.label === label)
						}
						const errors = []
						dialog.showErrorBox = (_title, message) => errors.push(message)
						const fs = process.getBuiltinModule('fs')
						function idle() {
							return (
								Menu.getApplicationMenu().items.find(
									(entry) => entry.label === 'Machine',
								).submenu.items[0].label !== 'Working…'
							)
						}
						async function waitFor(predicate) {
							const { setTimeout: delay } =
								process.getBuiltinModule('timers/promises')
							for (let attempt = 0; attempt < 250; attempt++) {
								if (errors.length) throw new Error(errors.join('\n'))
								if (predicate()) return
								await delay(20)
							}
							throw new Error('Native machine action did not finish.')
						}
						item('Register this machine…').click()
						await waitFor(
							() => fs.existsSync(`${profile}/machine.json`) && idle(),
						)
						function saved() {
							return JSON.parse(
								fs.readFileSync(`${profile}/machine.json`, 'utf8'),
							)
						}
						const registered = saved()
						if (process.platform === 'win32')
							return {
								registered,
								startEnabled: item('Start runner').enabled,
								calls,
							}
						item('Stop runner').click()
						await waitFor(() => !saved().enabled && idle())
						const stopped = saved()
						item('Start runner').click()
						await waitFor(() => saved().enabled && idle())
						return { registered, stopped, restarted: saved(), calls }
					},
					profile,
				)
		if (workflow) {
			assert.deepEqual(workflow.registered, {
				ecid: 'ec_smoke',
				enabled: process.platform !== 'win32',
			})
			if (process.platform !== 'win32') {
				assert.equal(workflow.stopped.enabled, false)
				assert.equal(workflow.restarted.enabled, true)
				assert.deepEqual(workflow.calls[0], ['whoami', '--json'])
				assert.equal(workflow.calls[1][1], 'register')
				assert.deepEqual(workflow.calls[2], ['start', 'ec_smoke'])
				assert.deepEqual(workflow.calls[3], ['stop'])
			} else assert.equal(workflow.startEnabled, false)
		}

		await page.screenshot({ path: 'artifacts/desktop-live.png' })
		console.log(JSON.stringify({ ...result, workflow }, null, 2))
	} finally {
		await app.close()
		rmSync(profile, { recursive: true, force: true })
	}
}
smoke().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

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
						productionBuild:
							electronApp.isPackaged &&
							load('node:fs').existsSync(
								`${process.resourcesPath}/app-update.yml`,
							),
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
		assert.equal(result.menus.includes('Machine'), false)
		assert.equal(result.menus.includes('Updates'), result.productionBuild)
		assert.match(result.version, /\d+\.\d+\.\d+/)
		const workflow = await page.evaluate(() =>
			window.kodyDesktop.execution.getState(),
		)
		assert.equal(workflow.signedIn, false)
		assert.equal(workflow.running, false)
		assert.equal(workflow.contextId, null)

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

const { _electron } = require('@playwright/test')
;(async () => {
	const app = await _electron.launch({
		executablePath: process.argv[2],
		args: [],
		timeout: 60_000,
	})
	const win = await app.firstWindow({ timeout: 60_000 })
	await win.waitForLoadState('domcontentloaded')
	const info = await app.evaluate(({ app }) => ({
		windowsStore: process.windowsStore ?? null,
		packaged: app.isPackaged,
		version: app.getVersion(),
		exe: process.execPath,
	}))
	console.log(
		JSON.stringify({ ...info, url: win.url(), title: await win.title() }),
	)
	await app.close()
})().catch((e) => {
	console.error(e)
	process.exit(1)
})

const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { _electron, expect } = require('@playwright/test')

async function smoke() {
	const server = createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html')
		response.end('<input aria-label="Draft"><div style="height:3000px"></div>')
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const origin = `http://127.0.0.1:${server.address().port}`
	const profile = mkdtempSync(join(tmpdir(), 'kody-window-lifetime-'))
	const env = { ...process.env, KODY_DESKTOP_TEST_PROFILE: profile }
	delete env.ELECTRON_RUN_AS_NODE
	let app
	try {
		app = await _electron.launch({
			args: [
				'-r',
				join(__dirname, 'profile.fixture.cjs'),
				join(__dirname, '..'),
				`--app-url=${origin}`,
			],
			env,
		})
		const page = await app.firstWindow()
		await page.getByRole('textbox', { name: 'Draft' }).fill('unfinished draft')
		await page.evaluate(() => {
			history.pushState({}, '', '/working?draft=1#here')
			window.lifetimeMarker = Math.random()
			window.scrollTo(0, 600)
		})
		const snapshot = () =>
			page.evaluate(() => ({
				url: location.href,
				history: history.length,
				scroll: scrollY,
				marker: window.lifetimeMarker,
				draft: document.querySelector('input').value,
			}))
		const before = await snapshot()
		for (const event of ['activate', 'second-instance']) {
			await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0].close(),
			)
			assert.equal(page.isClosed(), false)
			assert.equal(
				await app.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0].isVisible(),
				),
				false,
			)
			await app.evaluate(({ app }, event) => app.emit(event), event)
			await expect
				.poll(() =>
					app.evaluate(({ BrowserWindow }) =>
						BrowserWindow.getAllWindows()[0].isVisible(),
					),
				)
				.toBe(true)
			assert.deepEqual(await snapshot(), before)
			assert.equal((await app.windows()).length, 1)
		}
		console.log(
			'Native close/reopen preserves the document, URL, history, scroll, and draft.',
		)
	} finally {
		await app?.close()
		server.closeAllConnections()
		await new Promise((resolve) => server.close(resolve))
		rmSync(profile, { recursive: true, force: true })
	}
}
smoke().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

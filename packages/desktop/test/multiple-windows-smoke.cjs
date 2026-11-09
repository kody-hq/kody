const assert = require('node:assert/strict')
const { _electron, expect } = require('@playwright/test')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

async function smoke() {
	const origin = process.argv[2]
	if (!origin) throw new Error('Pass the local control-kody origin.')
	const profile = mkdtempSync(join(tmpdir(), 'kody-multiple-windows-'))
	const env = { ...process.env, KODY_DESKTOP_TEST_PROFILE: profile }
	delete env.ELECTRON_RUN_AS_NODE
	const { readCookieFile } = await import('../../../tools/control-kody.ts')
	const cookieHeader = readCookieFile(
		join(__dirname, '../../../.tmp/control-kody-cookie'),
		origin,
	)
	if (!cookieHeader)
		throw new Error('Run control-kody login against this origin first.')
	const app = await _electron.launch({
		args: [
			'-r',
			join(__dirname, 'profile.fixture.cjs'),
			join(__dirname, '..'),
			`--app-url=${origin}`,
		],
		env,
	})
	try {
		const first = await app.firstWindow()
		await app.evaluate(
			async ({ session }, { origin, cookieHeader }) => {
				for (const cookie of cookieHeader.split(';')) {
					const at = cookie.indexOf('=')
					if (at > 0)
						await session.fromPartition('persist:kody').cookies.set({
							url: origin,
							name: cookie.slice(0, at).trim(),
							value: cookie.slice(at + 1).trim(),
							httpOnly: true,
						})
				}
			},
			{ origin, cookieHeader },
		)
		await first.goto(`${origin}/account/execution-contexts`)
		await first.getByRole('button', { name: 'Not now', exact: true }).click()
		await expect(
			first.getByRole('heading', { name: 'This machine', exact: true }),
		).toBeVisible()
		const before = await first.evaluate(() => {
			window.multipleWindowMarker = Math.random()
			return {
				url: location.href,
				marker: window.multipleWindowMarker,
				history: history.length,
			}
		})
		const opened = app.waitForEvent('window')
		await app.evaluate(({ Menu }) => {
			const file = Menu.getApplicationMenu().items.find(
				(item) => item.label === 'File',
			)
			file.submenu.items.find((item) => item.label === 'New Window').click()
		})
		const second = await opened
		await second
			.getByRole('navigation', { name: 'App navigation', exact: true })
			.waitFor()
		await expect
			.poll(() =>
				second.evaluate(
					async () => (await window.kodyDesktop.execution.getState()).signedIn,
				),
			)
			.toBe(true)
		const secondNavigation = await second.evaluate(() =>
			window.kodyDesktop.navigation.getState(),
		)
		assert.ok(secondNavigation.url.startsWith(origin))
		assert.notEqual(secondNavigation.url, before.url)
		assert.equal((await app.windows()).length, 2)
		await second.screenshot({ path: 'artifacts/desktop-second-window.png' })
		const closed = second.waitForEvent('close')
		await (await app.browserWindow(second)).evaluate((window) => window.close())
		await closed
		assert.equal(first.isClosed(), false)
		assert.deepEqual(
			await first.evaluate(() => ({
				url: location.href,
				marker: window.multipleWindowMarker,
				history: history.length,
			})),
			before,
		)
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].close(),
		)
		assert.equal(first.isClosed(), false)
		assert.equal(
			await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0].isVisible(),
			),
			false,
		)
		await app.evaluate(({ app }) => app.emit('activate'))
		assert.deepEqual(
			await first.evaluate(() => ({
				url: location.href,
				marker: window.multipleWindowMarker,
				history: history.length,
			})),
			before,
		)
		console.log(
			'Seeded workspace: shared sign-in, independent windows and IPC, close, and last-window restore passed.',
		)
	} finally {
		await app.close()
		rmSync(profile, { recursive: true, force: true })
	}
}
smoke().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

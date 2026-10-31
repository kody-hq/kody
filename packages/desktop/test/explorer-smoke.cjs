const assert = require('node:assert/strict')
const { _electron, chromium, expect } = require('@playwright/test')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

async function smoke() {
	const origin = process.argv[2]
	if (!origin) throw new Error('Pass the local control-kody origin.')
	const profile = mkdtempSync(join(tmpdir(), 'kody-explorer-'))
	const env = { ...process.env, KODY_DESKTOP_TEST_PROFILE: profile }
	delete env.ELECTRON_RUN_AS_NODE
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
		const page = await app.firstWindow()
		await page
			.getByRole('navigation', { name: 'App navigation', exact: true })
			.waitFor()
		await expect(
			page.getByRole('button', { name: 'Back', exact: true }),
		).toBeDisabled()
		if (process.platform === 'darwin')
			assert.equal(
				await page.evaluate(
					async () =>
						(await window.kodyDesktop.navigation.getState()).integratedTitlebar,
				),
				true,
			)
		await page.screenshot({ path: 'artifacts/desktop-login.png' })
		await page.getByRole('link', { name: 'Back to Kody' }).click()
		await expect(
			page.getByRole('button', { name: 'Back', exact: true }),
		).toBeEnabled()
		await page.getByRole('button', { name: 'Back', exact: true }).click()
		await page.waitForURL(/\/login/)
		await expect(
			page.getByRole('button', { name: 'Forward', exact: true }),
		).toBeEnabled()
		await page.getByRole('button', { name: 'Forward', exact: true }).click()
		await page.waitForURL(`${origin}/`)
		const { readCookieFile } = await import('../../../tools/control-kody.ts')
		const cookieHeader = readCookieFile(
			join(__dirname, '../../../.tmp/control-kody-cookie'),
			origin,
		)
		if (!cookieHeader)
			throw new Error('Run control-kody login against this origin first.')
		await app.evaluate(
			async ({ BrowserWindow }, { origin, cookieHeader }) => {
				const session = BrowserWindow.getAllWindows()[0].webContents.session
				for (const cookie of cookieHeader.split(';')) {
					const at = cookie.indexOf('=')
					if (at > 0)
						await session.cookies.set({
							url: origin,
							name: cookie.slice(0, at).trim(),
							value: cookie.slice(at + 1).trim(),
							httpOnly: true,
						})
				}
			},
			{ origin, cookieHeader },
		)
		await page.getByRole('button', { name: 'Home', exact: true }).click()
		await page
			.getByRole('complementary', { name: 'Workspace navigation', exact: true })
			.waitFor()
		await page
			.getByRole('navigation', { name: 'App navigation', exact: true })
			.waitFor()
		const layout = await page.evaluate(() => {
			const corner = document
				.querySelector('[data-desktop-navigation]')
				.getBoundingClientRect()
			const panel = document
				.querySelector('[data-workspace-panel]')
				.getBoundingClientRect()
			const sidebar = document.querySelector(
				'aside[aria-label="Workspace navigation"]',
			)
			const brand = sidebar.querySelector('a[href="/"]').getBoundingClientRect()
			return {
				cornerWidth: corner.width,
				cornerBottom: corner.bottom,
				panelTop: panel.top,
				brandTop: brand.top,
				viewportWidth: innerWidth,
			}
		})
		assert.ok(
			layout.cornerWidth < layout.viewportWidth / 2,
			'Desktop controls must stay in the corner.',
		)
		assert.equal(
			layout.panelTop,
			0,
			'Desktop controls must not push down the main panel.',
		)
		assert.ok(
			layout.brandTop >= layout.cornerBottom,
			'Sidebar branding must clear the desktop controls.',
		)
		await page.screenshot({ path: 'artifacts/desktop-workspace.png' })
		await page
			.getByRole('button', { name: 'Page address', exact: true })
			.click()
		await expect(
			page.getByRole('textbox', { name: 'Page address', exact: true }),
		).toHaveValue(page.url())
		await app.evaluate(({ clipboard }) => {
			clipboard.writeText = (value) => {
				globalThis.smokeCopiedAddress = value
			}
		})
		await page.getByRole('button', { name: 'Copy', exact: true }).click()
		assert.equal(
			await app.evaluate(() => globalThis.smokeCopiedAddress),
			page.url(),
		)
		await app.evaluate(({ shell }) => {
			shell.openExternal = async (value) => {
				globalThis.smokeBrowserAddress = value
			}
		})
		await page
			.getByRole('button', { name: 'Page address', exact: true })
			.click()
		await page
			.getByRole('button', { name: 'Open in browser', exact: true })
			.click()
		assert.equal(
			await app.evaluate(() => globalThis.smokeBrowserAddress),
			page.url(),
		)
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].setContentSize(720, 860),
		)
		await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
		const narrow = await page.evaluate(() => {
			const corner = document
				.querySelector('[data-desktop-navigation]')
				.getBoundingClientRect()
			const sidebar = document.querySelector(
				'aside[aria-label="Workspace navigation"]',
			)
			const brand = sidebar.querySelector('a[href="/"]').getBoundingClientRect()
			return { cornerBottom: corner.bottom, brandTop: brand.top }
		})
		assert.ok(narrow.brandTop >= narrow.cornerBottom)
		await page
			.getByRole('button', { name: 'Page address', exact: true })
			.click()
		const address = await page
			.getByRole('textbox', { name: 'Page address', exact: true })
			.boundingBox()
		assert.ok(address.x >= 0 && address.x + address.width <= 720)
		await page
			.getByRole('button', { name: 'Page address', exact: true })
			.click()
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0].setContentSize(1280, 860),
		)
		await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1280)
		assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0]
			window.webContents.executeJavaScript(
				'history.pushState({}, "", "?shell-history-test=1")',
			)
		})
		await page.waitForURL(/shell-history-test/)
		await expect(
			page.getByRole('button', { name: 'Back', exact: true }),
		).toBeEnabled()
		await page.getByRole('button', { name: 'Back', exact: true }).click()
		await expect(page).not.toHaveURL(/shell-history-test/)
		// Closing a window must not call the runner shutdown path.
		const closed = page.waitForEvent('close')
		await app.evaluate(({ app, BrowserWindow }) => {
			const load = process
				.getBuiltinModule('module')
				.createRequire(`${app.getAppPath()}/package.json`)
			const { Runner } = load('./runner.cjs')
			const original = Runner.prototype.close
			globalThis.smokeClosedRunner = false
			Runner.prototype.close = function () {
				globalThis.smokeClosedRunner = true
				return original.call(this)
			}
			BrowserWindow.getAllWindows()[0].close()
		})
		await closed
		if (process.platform === 'darwin') {
			assert.equal(
				await app.evaluate(
					({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
				),
				0,
			)
			assert.equal(
				await app.evaluate(() => globalThis.smokeClosedRunner),
				false,
			)
			await app.evaluate(({ app }) => app.emit('activate'))
			const reopened = await app.firstWindow()
			await reopened
				.getByRole('navigation', { name: 'App navigation', exact: true })
				.waitFor()
			assert.equal(
				await app.evaluate(() => globalThis.smokeClosedRunner),
				false,
			)
		}
		console.log(
			'Electron navigation, address copy, same-document history, and macOS close/reopen passed.',
		)
	} finally {
		await app.close()
		rmSync(profile, { recursive: true, force: true })
	}
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage()
		await page.goto(`${origin}/login`)
		await expect(
			page.getByRole('heading', { name: 'Welcome back' }),
		).toBeVisible()
		await expect(
			page.getByRole('navigation', { name: 'App navigation', exact: true }),
		).toHaveCount(0)
		console.log('Regular browser has no desktop controls.')
	} finally {
		await browser.close()
	}
}
smoke().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

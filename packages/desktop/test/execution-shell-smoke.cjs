const assert = require('node:assert/strict')
const { _electron, chromium, expect } = require('@playwright/test')
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

async function smoke() {
	const origin = process.argv[2]
	if (!origin) throw new Error('Pass the local control-kody origin.')
	const root = resolve(__dirname, '../../..')
	mkdirSync(join(root, 'artifacts'), { recursive: true })
	const profile = mkdtempSync(join(tmpdir(), 'kody-machine-'))
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
		page.setDefaultTimeout(15000)
		page.setDefaultNavigationTimeout(30000)
		await page.waitForLoadState('domcontentloaded')
		const { readCookieFile } = await import('../../../tools/control-kody.ts')
		const cookieHeader = readCookieFile(
			join(root, '.tmp/control-kody-cookie'),
			origin,
		)
		if (!cookieHeader)
			throw new Error('Run control-kody login against this origin first.')
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
		await page.goto(`${origin}/account/execution-contexts`)
		const dialog = page.getByRole('dialog', {
			name: 'Run Kody on this machine',
			exact: true,
		})
		if (await dialog.isVisible())
			await dialog.getByRole('button', { name: 'Not now', exact: true }).click()
		await expect(
			page.getByRole('heading', { name: 'This machine', exact: true }),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Set up this machine', exact: true }),
		).toBeVisible()
		const state = await page.evaluate(() =>
			window.kodyDesktop.execution.getState(),
		)
		assert.equal(state.signedIn, true)
		assert.equal(state.contextId, null)
		assert.equal(state.running, false)
		await page.screenshot({
			path: join(root, 'artifacts/desktop-machine-panel.png'),
		})
		await page
			.getByRole('button', { name: 'Set up this machine', exact: true })
			.click()
		await expect(dialog).toBeVisible()
		await page.screenshot({
			path: join(root, 'artifacts/desktop-machine-onboarding.png'),
		})
		await dialog.getByRole('button', { name: 'Not now', exact: true }).click()
		assert.equal(
			(await page.evaluate(() => window.kodyDesktop.execution.getState()))
				.onboardingSeen,
			true,
		)
		await page.reload()
		await expect(
			page.getByRole('button', { name: 'Set up this machine', exact: true }),
		).toBeVisible()
		await expect(dialog).not.toBeVisible()
		const browser = await chromium.launch({ headless: true })
		try {
			const context = await browser.newContext()
			await context.addCookies(
				cookieHeader.split(';').map((cookie) => {
					const at = cookie.indexOf('=')
					return {
						name: cookie.slice(0, at).trim(),
						value: cookie.slice(at + 1).trim(),
						url: origin,
						httpOnly: true,
					}
				}),
			)
			const web = await context.newPage()
			await web.goto(`${origin}/account/execution-contexts`)
			await expect(
				web.getByRole('heading', { name: 'Execution contexts', exact: true }),
			).toBeVisible()
			await expect(
				web.getByRole('heading', { name: 'This machine', exact: true }),
			).toHaveCount(0)
		} finally {
			await browser.close()
		}
		console.log(
			'Real Electron: session verification, native-only machine controls, skip persistence, and normal browser isolation passed. No CLI login or real registration performed.',
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

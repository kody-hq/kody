const assert = require('node:assert/strict')
const { _electron, chromium, expect } = require('@playwright/test')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
async function smoke() {
	const origin = process.argv[2]
	if (!origin) throw new Error('Pass the local control-kody origin.')
	const profile = mkdtempSync(join(tmpdir(), 'kody-browser-login-'))
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
	const browser = await chromium.launch()
	try {
		console.log('Electron launched')
		const page = await app.firstWindow({ timeout: 20_000 })
		console.log('Window ready')
		await expect(
			page.getByRole('button', {
				name: 'Continue in your browser',
				exact: true,
			}),
		).toBeVisible()
		assert.equal(await page.locator('input[type=password]').count(), 0)
		await page.screenshot({
			path: join(__dirname, '../artifacts/browser-login-native.png'),
		})
		await app.evaluate(({ shell }) => {
			shell.openExternal = async (url) => {
				global.testLoginUrl = url
			}
			const original = global.fetch
			global.fetch = async (url, options) => {
				if (String(url).endsWith('/desktop/session')) {
					const wrong = {
						...JSON.parse(options.body),
						verifier: 'w'.repeat(43),
					}
					global.testWrongStatus = (
						await original(url, { ...options, body: JSON.stringify(wrong) })
					).status
					const response = await original(url, options)
					global.testReplayStatus = (await original(url, options)).status
					return response
				}
				return original(url, options)
			}
		})
		await page
			.getByRole('button', { name: 'Continue in your browser', exact: true })
			.click()
		await expect
			.poll(() => app.evaluate(() => !!global.testLoginUrl))
			.toBe(true)
		const loginUrl = await app.evaluate(() => global.testLoginUrl)
		const signedOut = await browser.newContext()
		const signedOutPage = await signedOut.newPage()
		for (const mode of ['login', 'signup']) {
			const start = new URL(loginUrl)
			start.searchParams.set('mode', mode)
			await signedOutPage.goto(start.href)
			await expect
				.poll(() => new URL(signedOutPage.url()).pathname)
				.toBe(`/${mode}`)
			const resume = new URL(
				new URL(signedOutPage.url()).searchParams.get('redirectTo'),
				origin,
			)
			assert.equal(resume.pathname, '/desktop/login')
			assert.equal(
				resume.searchParams.get('challenge'),
				start.searchParams.get('challenge'),
			)
			assert.equal(
				resume.searchParams.get('state'),
				start.searchParams.get('state'),
			)
		}
		await signedOut.close()

		const { readCookieFile } = await import('../../../tools/control-kody.ts')
		const cookieHeader = readCookieFile(
			join(__dirname, '../../../.tmp/control-kody-cookie'),
			origin,
		)
		if (!cookieHeader)
			throw new Error(
				'Run control-kody login for the local disposable account first.',
			)
		const context = await browser.newContext()
		await context.addCookies(
			cookieHeader.split(';').map((part) => {
				const at = part.indexOf('=')
				return {
					name: part.slice(0, at).trim(),
					value: part.slice(at + 1).trim(),
					url: origin,
					httpOnly: true,
				}
			}),
		)
		const browserPage = await context.newPage()
		console.log('Opening browser consent')
		await browserPage.goto(loginUrl)
		await expect(
			browserPage.getByRole('heading', { name: 'Sign in to Kody desktop' }),
		).toBeVisible()
		await browserPage.screenshot({
			path: join(__dirname, '../artifacts/browser-login-consent.png'),
		})
		await browserPage
			.getByRole('button', { name: 'Continue to Kody desktop', exact: true })
			.click()
		await expect(
			browserPage.getByText('Signed in. You can return to Kody.', {
				exact: true,
			}),
		)
			.toBeVisible({ timeout: 15_000 })
			.catch(async (error) => {
				console.log(
					'Browser result:',
					await browserPage.locator('body').innerText(),
				)
				throw error
			})
		await expect(
			page.getByRole('complementary', {
				name: 'Workspace navigation',
				exact: true,
			}),
		).toBeVisible({ timeout: 30_000 })
		assert.deepEqual(
			await app.evaluate(() => [
				global.testWrongStatus,
				global.testReplayStatus,
			]),
			[400, 400],
		)
		const cookies = await app.evaluate(async ({ BrowserWindow }) =>
			(
				await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({
					name: 'kody_session',
				})
			).map((cookie) => ({
				httpOnly: cookie.httpOnly,
				hostOnly: cookie.hostOnly,
				sameSite: cookie.sameSite,
			})),
		)
		assert.deepEqual(cookies, [
			{ httpOnly: true, hostOnly: true, sameSite: 'lax' },
		])
		await page.screenshot({
			path: join(__dirname, '../artifacts/browser-login-complete.png'),
		})
		console.log(
			'Browser sign-in passed: native default, browser consent, PKCE rejection, one-use code, HttpOnly app session, signed-in workspace.',
		)
	} finally {
		console.log('Closing test apps')
		await app.close()
		await browser.close()
		rmSync(profile, { recursive: true, force: true })
	}
}
smoke().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

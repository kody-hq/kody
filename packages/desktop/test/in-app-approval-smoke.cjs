// Real Electron + real CLI against a local control-kody origin: machine setup
// sign-in approves in an app window on the app's session, not the browser.
const assert = require('node:assert/strict')
const { _electron, expect } = require('@playwright/test')
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

async function smoke() {
	const origin = process.argv[2]
	const cookieFile = process.argv[3] ?? '.tmp/control-kody-cookie'
	if (!origin) throw new Error('Pass the local control-kody origin.')
	const root = resolve(__dirname, '../../..')
	mkdirSync(join(root, 'artifacts'), { recursive: true })
	const profile = mkdtempSync(join(tmpdir(), 'kody-machine-'))
	const cliConfig = mkdtempSync(join(tmpdir(), 'kody-cli-'))
	const env = {
		...process.env,
		KODY_DESKTOP_TEST_PROFILE: profile,
		KODY_DESKTOP_TEST_CLI_ENV: JSON.stringify({
			KODY_MCP_URL: `${origin}/mcp`,
			KODY_API_URL: origin,
			XDG_CONFIG_HOME: cliConfig,
		}),
	}
	delete env.ELECTRON_RUN_AS_NODE
	const app = await _electron.launch({
		args: [
			'-r',
			join(__dirname, 'profile.fixture.cjs'),
			'-r',
			join(__dirname, 'cli-origin.fixture.cjs'),
			join(__dirname, '..'),
			`--app-url=${origin}`,
		],
		env,
	})
	try {
		await app.evaluate(({ shell }) => {
			globalThis.externalOpens = []
			shell.openExternal = async (url) => {
				globalThis.externalOpens.push(url)
			}
		})
		const page = await app.firstWindow()
		page.setDefaultTimeout(20000)
		page.setDefaultNavigationTimeout(30000)
		await page.waitForLoadState('domcontentloaded')
		const { readCookieFile } = await import('../../../tools/control-kody.ts')
		const cookieHeader = readCookieFile(join(root, cookieFile), origin)
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
		const setUp = page.getByRole('button', {
			name: 'Set up this machine',
			exact: true,
		})
		await expect
			.poll(
				async () => (await dialog.isVisible()) || (await setUp.isEnabled()),
				{ timeout: 60000 },
			)
			.toBe(true)
		if (!(await dialog.isVisible())) await setUp.click()
		const approvalWindow = app.waitForEvent('window')
		await dialog
			.getByRole('button', { name: 'Continue to approve', exact: true })
			.click()
		await expect(
			dialog.getByRole('button', { name: 'Waiting for approval…' }),
		).toBeVisible()
		const approval = await approvalWindow
		await approval.waitForLoadState('domcontentloaded')
		assert.equal(new URL(approval.url()).origin, origin)
		assert.equal(new URL(approval.url()).pathname, '/oauth/authorize')
		const approve = approval.getByRole('button', { name: /^(Approve|Allow)/ })
		await expect(approve).toBeVisible()
		assert.equal(await approval.evaluate(() => 'kodyDesktop' in window), false)
		const locked = approval.getByTestId('oauth-authorize-org-locked')
		if (await locked.count()) {
			await expect(
				approval.getByTestId('oauth-authorize-org-disabled'),
			).toBeDisabled()
			await expect(
				approval.getByTestId('oauth-authorize-org-locked-reason'),
			).toContainText('cannot be changed')
		}
		for (const colorScheme of ['light', 'dark']) {
			await approval.emulateMedia({ colorScheme })
			await approval.waitForTimeout(300)
			await approval.screenshot({
				fullPage: true,
				path: join(
					root,
					`artifacts/desktop-in-app-approval-${colorScheme}.png`,
				),
			})
		}
		const closed = approval.waitForEvent('close')
		await approve.click()
		await closed
		await expect(page.getByLabel('Machine name')).toBeVisible({
			timeout: 60000,
		})
		const state = await page.evaluate(() =>
			window.kodyDesktop.execution.getState(),
		)
		assert.equal(state.cliReady, true)
		assert.equal(state.error, null)
		assert.deepEqual(
			await app.evaluate(() => globalThis.externalOpens),
			[],
			'approval must not open the system browser',
		)
		await page.screenshot({
			path: join(root, 'artifacts/desktop-in-app-approval-done.png'),
		})
		console.log(
			'Real Electron + CLI: sign-in approved in an app window on the app session; no system browser; CLI signed in as the same account.',
		)
	} catch (error) {
		const window = await app.firstWindow()
		await window.screenshot({
			path: resolve(
				__dirname,
				'../../../artifacts/desktop-in-app-approval-failure.png',
			),
		})
		console.error(
			await window.evaluate(() => window.kodyDesktop?.execution?.getState()),
		)
		throw error
	} finally {
		await app.close()
		rmSync(profile, { recursive: true, force: true })
		rmSync(cliConfig, { recursive: true, force: true })
	}
}
smoke().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

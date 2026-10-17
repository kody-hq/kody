import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import {
	observeMainTransitions,
	readMainTransitions,
	expectSingleCommitTransition,
} from '../main-transitions.ts'

test('two-factor setup survives server revalidation', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `revalidate-${id}@example.com`,
		username: `revalidate-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/account/two-factor')
	await waitForClientHydration(page)
	await page.clock.install()
	await page.route('**/_serverFn/**', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1500))
		await route.continue()
	})
	await page.getByRole('button', { name: 'Enable 2FA' }).click()
	const secret = page.getByTestId('totp-secret')
	await expect(secret).toBeVisible()
	const original = await secret.textContent()
	await observeMainTransitions(page)
	await page.getByLabel('Verification code').fill('123456')
	for (let i = 0; i < 3; i++) {
		await page.clock.fastForward(61_000)
		const response = page.waitForResponse(
			(response) =>
				response.request().headers()['x-tsr-serverfn'] !== undefined,
		)
		await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
		expect((await response).ok()).toBe(true)
		await expect(secret).toHaveText(original!)
		await expect(page.getByLabel('Verification code')).toHaveValue('123456')
	}
	await page.waitForLoadState('networkidle')
	await page.unrouteAll({ behavior: 'wait' })
	await expect(secret).toHaveText(original!)
	await expect(page.getByLabel('Verification code')).toHaveValue('123456')
	expectSingleCommitTransition(await readMainTransitions(page), {
		fromHeading: 'Two-factor authentication',
		toHeading: 'Two-factor authentication',
	})
})

test('confirming setup supersedes an older disabled loader response', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const { generateTOTP } = await import('@epic-web/totp')
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `confirm-race-${id}@example.com`,
		username: `confirm-race-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/account/two-factor')
	await waitForClientHydration(page)
	let release!: () => void
	const barrier = new Promise<void>((resolve) => {
		release = resolve
	})
	let captured!: () => void
	const staleResponseReady = new Promise<void>((resolve) => {
		captured = resolve
	})
	let held = false
	await page.route('**/_serverFn/**', async (route) => {
		const response = await route.fetch()
		const body = await response.text()
		if (!held && body.includes('two-factor') && body.includes('enabled')) {
			held = true
			captured()
			await barrier
		}
		await route.fulfill({ response })
	})
	try {
		await page.getByRole('button', { name: 'Enable 2FA' }).click()
		const secret = await page.getByTestId('totp-secret').textContent()
		expect(secret).toBeTruthy()
		// Setup no longer refetches the unchanged enabled state. Start a real
		// activation refresh after the cache ages, then hold its old response.
		await page.clock.setFixedTime(new Date(Date.now() + 61_000))
		await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
		await staleResponseReady
		await page
			.getByLabel('Verification code')
			.fill((await generateTOTP({ secret: secret! })).otp)
		await page.evaluate(() => {
			const state = { enabledSeen: false, reverted: false }
			const observer = new MutationObserver(() => {
				const headings = [...document.querySelectorAll('h2')].map(
					(node) => node.textContent,
				)
				if (headings.includes('Two-factor authentication is enabled'))
					state.enabledSeen = true
				if (
					state.enabledSeen &&
					headings.includes('Two-factor authentication is disabled')
				)
					state.reverted = true
			})
			observer.observe(document.getElementById('main')!, {
				subtree: true,
				childList: true,
				characterData: true,
			})
			Object.assign(window, { twoFactorTransition: state })
		})
		await page.getByRole('button', { name: 'Confirm', exact: true }).click()
		await expect(
			page.getByText('Two-factor authentication is enabled.', { exact: true }),
		).toBeVisible()
		release()
		await page.waitForLoadState('networkidle')
		await page.unrouteAll({ behavior: 'wait' })
		await expect(
			page.getByRole('heading', {
				name: 'Two-factor authentication is enabled',
				exact: true,
			}),
		).toBeVisible()
		await expect(
			page.getByRole('button', { name: 'Enable 2FA', exact: true }),
		).toHaveCount(0)
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { twoFactorTransition: { reverted: boolean } })
						.twoFactorTransition.reverted,
			),
		).toBe(false)
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
})

import { randomUUID } from 'node:crypto'
import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from '../playwright-utils.ts'

/** Playwright Chromium reports every page focused/visible, even in headed
 * mode here, and bringToFront emits no lifecycle events. Deliver the focus
 * event explicitly; assertions still require a real server refresh after an
 * actual mutation and never reload the document or inject application data. */
async function activatePage(page: Page) {
	await page.bringToFront()
	await page.evaluate(() => {
		window.dispatchEvent(new FocusEvent('focus'))
		document.dispatchEvent(new Event('visibilitychange'))
	})
}

async function saveDisplayName(page: Page, value: string) {
	await activatePage(page)
	await page.getByLabel('Display name', { exact: true }).fill(value)
	const saved = page.waitForResponse(
		(response) =>
			response.request().headers()['x-tsr-serverfn'] === 'true' &&
			response.request().postData()?.includes('displayName') === true &&
			response.request().method() === 'POST',
	)
	await page.getByRole('button', { name: 'Save profile', exact: true }).click()
	const response = await saved
	expect(response.ok(), await response.text()).toBe(true)
	await expect(
		page.getByRole('button', { name: 'Save profile', exact: true }),
	).toBeDisabled()
}

test('activation, reconnect and history refresh account data without leaking accounts or overwriting dirty drafts', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(120_000)
	const id = randomUUID().slice(0, 8)
	const a = await seedE2eUser({
		email: `fresh-a-${id}@example.com`,
		username: `fresh-a-${id}`,
	})
	const b = await seedE2eUser({
		email: `fresh-b-${id}@example.com`,
		username: `fresh-b-${id}`,
	})
	await login({ ...a, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	const second = await page.context().newPage()
	const otherContext = await browser.newContext({ baseURL })
	try {
		await second.goto('/account')
		await waitForClientHydration(second)
		await second.clock.install()
		const signedIn = await otherContext.request.post('/auth', {
			data: { email: b.email, password: b.password, mode: 'login' },
		})
		expect(signedIn.ok(), await signedIn.text()).toBe(true)
		const other = await otherContext.newPage()
		await other.goto('/account')
		await waitForClientHydration(other)
		const bName = await other
			.getByLabel('Display name', { exact: true })
			.inputValue()
		const firstName = `Fresh profile ${id}`
		const nextName = `Updated elsewhere ${id}`
		const draft = `Unsaved local draft ${id}`
		// These markers disappear on document reload, so focus assertions cannot
		// accidentally pass by falling back to a full page navigation.
		await second.evaluate(() => {
			document.documentElement.dataset.freshnessDocument = 'original'
		})
		await other.evaluate(() => {
			document.documentElement.dataset.freshnessDocument = 'other-account'
		})
		await saveDisplayName(page, firstName)
		// A fresh snapshot is intentionally reusable after a short tab switch.
		await activatePage(second)
		await second.waitForLoadState('networkidle')
		await expect(
			second.getByLabel('Display name', { exact: true }),
		).not.toHaveValue(firstName)
		await second.clock.fastForward(61_000)
		await activatePage(second)
		await expect(
			second.getByLabel('Display name', { exact: true }),
		).toHaveValue(firstName)
		await expect(second.locator('html')).toHaveAttribute(
			'data-freshness-document',
			'original',
		)
		await expect(
			second.getByRole('link', { name: 'View public profile', exact: true }),
		).toHaveAttribute('href', `/@${a.username}`)

		await second.evaluate(
			(href) => window.history.pushState(null, '', href),
			`/@${a.username}/-/memories`,
		)
		await expect(
			second.getByRole('heading', { name: 'Memories', exact: true }),
		).toBeVisible()
		await second.goBack()
		await expect(
			second.getByLabel('Display name', { exact: true }),
		).toHaveValue(firstName)
		await second.goForward()
		await expect(
			second.getByRole('heading', { name: 'Memories', exact: true }),
		).toBeVisible()
		await second.getByTestId('account-menu').click()
		await second
			.getByTestId('account-menu-panel')
			.getByRole('link', { name: 'Account settings', exact: true })
			.click()
		await expect(
			second.getByLabel('Display name', { exact: true }),
		).toHaveValue(firstName)
		await expect(second.locator('html')).toHaveAttribute(
			'data-freshness-document',
			'original',
		)

		await second.getByLabel('Display name', { exact: true }).fill(draft)
		await saveDisplayName(page, nextName)
		// Wait for the actual focus-triggered loader response before checking the
		// draft. An immediate assertion could pass before a late reset arrived.
		const refreshed = second.waitForResponse(async (response) => {
			if (response.request().method() !== 'GET') return false
			if (response.request().headers()['x-tsr-serverfn'] !== 'true')
				return false
			const body = await response.text()
			return body.includes(nextName) && body.includes('accountProfile')
		})
		// Exercise reconnect independently of focus. The response must contain
		// the remote edit, while the local draft remains untouched.
		await second.clock.fastForward(61_000)
		await second.evaluate(() => window.dispatchEvent(new Event('online')))
		const refreshResponse = await refreshed
		expect(refreshResponse.ok()).toBe(true)
		await expect(
			second.getByLabel('Display name', { exact: true }),
		).toHaveValue(draft)
		await expect(
			second.getByRole('button', { name: 'Save profile', exact: true }),
		).toBeEnabled()
		await expect(second.locator('html')).toHaveAttribute(
			'data-freshness-document',
			'original',
		)

		await activatePage(other)
		await expect(other.getByLabel('Display name', { exact: true })).toHaveValue(
			bName,
		)
		await expect(
			other.getByRole('link', { name: 'View public profile', exact: true }),
		).toHaveAttribute('href', `/@${b.username}`)
		await expect(other.locator('html')).toHaveAttribute(
			'data-freshness-document',
			'other-account',
		)
		const otherData = await other.request.get('/account')
		expect(otherData.ok()).toBe(true)
		const otherText = await otherData.text()
		expect(otherText).not.toContain(a.email)
		expect(otherText).not.toContain(firstName)
		expect(otherText).not.toContain(nextName)
		expect(otherText).not.toContain(draft)
		await expect(
			second.getByLabel('Display name', { exact: true }),
		).toHaveValue(draft)
		await page.reload()
		await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
			nextName,
		)
		await expect(
			page.getByRole('link', { name: 'View public profile', exact: true }),
		).toHaveAttribute('href', `/@${a.username}`)
	} finally {
		await second.close()
		await otherContext.close()
	}
})

import { saveKeyThroughUi } from './account-fixtures.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

const scrollY = (page: import('@playwright/test').Page) =>
	page.evaluate(() => Math.round(window.scrollY))

async function seedCredentials(
	page: import('@playwright/test').Page,
	email: string,
	runId: number,
) {
	await saveKeyThroughUi(page, {
		name: 'zz_TARGET_KEY',
		value: `sk-target-${runId}`,
		description: 'Target key',
		allowedHosts: ['api.example.com'],
	})
	const org = `(SELECT personal_org_id FROM users WHERE email = '${email}')`
	const bucket = `(SELECT id FROM secret_buckets WHERE user_id = ${org} AND scope = 'user' AND binding_key = '')`
	const now = new Date().toISOString()
	const rows = Array.from({ length: 30 }, (_, index) => {
		const n = String(index + 1).padStart(2, '0')
		return `('dl-${runId}-${n}', ${bucket}, 'aa_FILLER_${n}', '', 'x', '["api.example.com"]', '[]', '${now}', '${now}', 'null', 'null', 'secret')`
	})
	executeE2eD1Command(
		`INSERT INTO secret_entries (id, bucket_id, name, description, encrypted_value, allowed_hosts, allowed_packages, created_at, updated_at, inject_json, source_json, kind) VALUES ${rows.join(', ')}`,
	)
}

test('a credential deep link scrolls to its record once; row clicks and Edit keep the scroll', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `deep-link-${runId}@example.com`,
		username: `deep-link-${runId}`,
		password: 'deep-link-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await seedCredentials(page, user.email, runId)
	await page.setViewportSize({ width: 1280, height: 720 })

	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	const table = page.getByRole('region', { name: 'Credentials', exact: true })
	const targetLink = table.getByRole('link', { name: /zz_TARGET_KEY/ })
	const deepLink = await targetLink.getAttribute('href')
	expect(deepLink).toBeTruthy()
	const targetRow = page.locator('tr[data-record-focus]')

	// First load of the deep link scrolls the record into view and flashes it.
	await page.goto(deepLink!)
	await waitForClientHydration(page)
	await expect(targetRow).toHaveAttribute('data-record-highlight', 'true')
	await expect(targetRow).toBeInViewport()
	await expect.poll(() => scrollY(page)).toBeGreaterThan(0)
	await expect(targetRow).not.toHaveAttribute('data-record-highlight')

	// A hard reload of the same URL does it again.
	await page.evaluate(() => window.scrollTo(0, 0))
	await page.reload()
	await waitForClientHydration(page)
	await expect(targetRow).toBeInViewport()
	await expect.poll(() => scrollY(page)).toBeGreaterThan(0)

	// Clicking rows never moves the page.
	await page.evaluate(() => window.scrollTo(0, 0))
	await expect.poll(() => scrollY(page)).toBe(0)
	await table.getByRole('link', { name: 'aa_FILLER_01' }).click()
	await expect(page).toHaveURL(/\/credentials\/dl-/)
	await page.waitForTimeout(500)
	expect(await scrollY(page)).toBe(0)
	await page.evaluate(() => window.scrollTo(0, 240))
	await expect.poll(() => scrollY(page)).toBe(240)
	await table.getByRole('link', { name: 'aa_FILLER_08' }).click()
	await expect(page).toHaveURL(new RegExp(`/credentials/dl-${runId}-08`))
	await page.waitForTimeout(500)
	// The record that closed above can nudge scroll anchoring a few pixels.
	expect(Math.abs((await scrollY(page)) - 240)).toBeLessThan(40)
	await expect(page.locator('[data-record-highlight]')).toHaveCount(0)

	// Edit opens the form in place; cancel and save keep the URL and scroll.
	await targetLink.scrollIntoViewIfNeeded()
	await targetLink.click()
	const detail = page.getByRole('region', { name: 'zz_TARGET_KEY details' })
	const edit = detail.getByTestId('credential-edit')
	await edit.scrollIntoViewIfNeeded()
	const url = page.url()
	const before = await scrollY(page)
	await edit.click()
	const name = detail.getByRole('textbox', { name: 'Name', exact: true })
	await expect(name).toHaveValue('zz_TARGET_KEY')
	expect(page.url()).toBe(url)
	expect(await scrollY(page)).toBe(before)

	await detail.getByRole('button', { name: 'Cancel' }).click()
	await expect(name).toHaveCount(0)
	expect(page.url()).toBe(url)
	expect(await scrollY(page)).toBe(before)

	await edit.click()
	await detail
		.getByRole('textbox', { name: 'Description', exact: true })
		.fill('Edited in place')
	await detail.getByRole('button', { name: 'Save', exact: true }).click()
	await expect(detail.getByText('Edited in place')).toBeVisible()
	await expect(name).toHaveCount(0)
	expect(page.url()).toBe(url)
	expect(await scrollY(page)).toBe(before)
})

test('with reduced motion the deep link jumps to the record without animating', async ({
	browser,
	seedE2eUser,
	login,
	page,
	baseURL,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `deep-link-rm-${runId}@example.com`,
		username: `deep-link-rm-${runId}`,
		password: 'deep-link-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await seedCredentials(page, user.email, runId)
	await page.goto(`/@${user.username}/-/credentials`)
	await waitForClientHydration(page)
	const deepLink = await page
		.getByRole('link', { name: /zz_TARGET_KEY/ })
		.getAttribute('href')

	const context = await browser.newContext({
		baseURL,
		reducedMotion: 'reduce',
		storageState: await page.context().storageState(),
		viewport: { width: 1280, height: 720 },
	})
	const reduced = await context.newPage()
	await reduced.goto(deepLink!)
	await waitForClientHydration(reduced)
	const targetRow = reduced.locator('tr[data-record-focus]')
	await expect(targetRow).toHaveAttribute('data-record-highlight', 'true')
	expect(
		await targetRow.evaluate((row) => getComputedStyle(row).animationName),
	).toBe('none')
	await expect(targetRow).toBeInViewport()
	await context.close()
})

import { randomUUID } from 'node:crypto'
import { requestHasMutationDataFields } from '../server-function-requests.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('a soft profile refresh changes only the title, then navigation and reload restore native metadata', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(120_000)
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `head-${id}@example.com`,
		username: `head-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto(`/@${user.username}`)
	await waitForClientHydration(page)
	const originalTitle = await page.title()
	const metadata = () =>
		page.locator('head').evaluate((head) =>
			[
				...head.querySelectorAll(
					'meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], link[rel="canonical"]',
				),
			].map((node) => ({
				tag: node.tagName,
				name: node.getAttribute('name'),
				property: node.getAttribute('property'),
				content: node.getAttribute('content'),
				rel: node.getAttribute('rel'),
				href: node.getAttribute('href'),
			})),
		)
	const originalMetadata = await metadata()
	const response = await page.request.get(`/@${user.username}`)
	expect(await response.text()).toContain(`<title>${originalTitle}</title>`)

	await page.goto('/account')
	await waitForClientHydration(page)
	const updatedName = `Updated ${id}`
	await page.getByLabel('Display name', { exact: true }).fill(updatedName)
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let saveHeld = false
	await page.route('**/_serverFn/**', async (route) => {
		if (
			requestHasMutationDataFields(route.request(), {
				displayName: updatedName,
			})
		) {
			saveHeld = true
			await held
		}
		await route.continue()
	})
	try {
		await page
			.getByRole('button', { name: 'Save profile', exact: true })
			.click()
		await expect.poll(() => saveHeld, { timeout: 15_000 }).toBe(true)
		await page
			.getByRole('link', { name: 'View public profile', exact: true })
			.click()
		await expect(page).toHaveURL(new RegExp(`/@${user.username}$`))
		await expect(page).toHaveTitle(originalTitle)
		expect(await metadata()).toEqual(originalMetadata)
		release()
		await expect(page).toHaveTitle(updatedName)
		expect(await metadata()).toEqual(originalMetadata)
		await expect(page.locator('head title')).toHaveCount(1)

		// Use a real client navigation, followed by history and a full reload.
		await page.getByRole('link', { name: 'Kody home', exact: true }).click()
		await expect(page).toHaveURL(/\/$/)
		await expect(page).not.toHaveTitle(updatedName)
		await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
			'href',
			/\/$/,
		)
		await page.goBack()
		await expect(page).toHaveTitle(updatedName)
		await page.reload()
		await waitForClientHydration(page)
		await expect(page).toHaveTitle(updatedName)
		expect(await metadata()).not.toEqual(originalMetadata)
		await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
			'content',
			new RegExp(updatedName),
		)
		await expect(page.locator('head title')).toHaveCount(1)
		const missing = await page.goto(`/missing-head-${id}`)
		expect(missing?.status()).toBe(404)
		await expect(page).toHaveTitle('Not found')
		expect(await missing!.text()).toContain('<title>Not found</title>')
	} finally {
		release()
	}
})

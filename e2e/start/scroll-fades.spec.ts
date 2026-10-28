import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('landing and workspace scroll containers keep their fade masks', async ({
	page,
	seedE2eUser,
	login,
}) => {
	await page.goto('/')
	await waitForClientHydration(page)
	const marquee = page.locator('.landing-agents')
	await expect(marquee).toBeVisible()
	await expect
		.poll(() =>
			marquee.evaluate((element) => getComputedStyle(element).maskImage),
		)
		.not.toBe('none')
	await expect
		.poll(() =>
			marquee.evaluate((element) =>
				getComputedStyle(element).getPropertyValue('--tw-fade-size-x').trim(),
			),
		)
		.not.toBe('')

	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `fades-${id}@example.com`,
		username: `fades-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	const sidebar = page.locator('[data-workspace-scroll]')
	await expect(sidebar).toBeVisible()
	await expect
		.poll(() =>
			sidebar.evaluate((element) => getComputedStyle(element).maskImage),
		)
		.not.toBe('none')
	await expect
		.poll(() =>
			sidebar.evaluate((element) =>
				getComputedStyle(element).getPropertyValue('--tw-fade-size').trim(),
			),
		)
		.not.toBe('')
})

import { randomUUID } from 'node:crypto'
import { test, expect, waitForClientHydration } from './playwright-utils.ts'

test('video comments persist and seek from the scrubber and discussion list', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const username = `video-review-${randomUUID().slice(0, 8)}`
	const owner = await seedE2eUser({
		username,
		email: `${username}@example.com`,
	})
	await login({ ...owner, mode: 'login' })
	await page.goto(`/@${username}/-/files`)
	await waitForClientHydration(page)
	await page.getByRole('button', { name: 'Create', exact: true }).last().click()
	const chooser = page.waitForEvent('filechooser')
	await page.getByRole('menuitem', { name: 'Upload files' }).click()
	await (await chooser).setFiles('e2e/fixtures/files/launch.webm')
	await page
		.getByRole('region', { name: 'Uploads' })
		.getByRole('link', { name: 'Open', exact: true })
		.click()

	const scrubber = page.getByRole('slider', { name: 'Video progress' })
	await expect(scrubber).toBeEnabled()
	await scrubber.fill('500')
	await page
		.getByRole('button', { name: 'Comment at 0:00.5', exact: true })
		.click()
	const rail = page.getByRole('complementary', { name: 'File comments' })
	await rail
		.getByRole('combobox', { name: 'New comment', exact: true })
		.fill('Hold this frame a little longer.')
	await rail.getByRole('button', { name: 'Post comment' }).click()
	await expect(rail.getByText('Hold this frame a little longer.')).toBeVisible()

	await page.reload()
	await expect(scrubber).toBeEnabled()
	await page
		.getByRole('button', { name: 'Jump to comment at 0:00.5', exact: true })
		.click()
	await expect(rail.getByText('Hold this frame a little longer.')).toBeVisible()
	await expect(scrubber).toHaveValue('500')
	await rail.getByRole('button', { name: 'All discussions' }).click()
	await scrubber.press('Home')
	await rail
		.getByRole('button', { name: /Open discussion .* at 0:00\.5/ })
		.click()
	await expect(scrubber).toHaveValue('500')
})

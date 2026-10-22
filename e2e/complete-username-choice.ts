import {
	type Page,
	expect,
	waitForClientHydration,
} from './playwright-utils.ts'

/** Finish the shared OAuth/password username chooser after social parking. */
export async function completeUsernameChoice(page: Page, username?: string) {
	await expect(page).toHaveURL(/\/signup\/choose-username/)
	await waitForClientHydration(page)
	const field = page.getByRole('textbox', { name: 'Username' })
	if (username) await field.fill(username)
	const value = (username ?? (await field.inputValue())).trim().toLowerCase()
	await expect(page.locator('[data-status="available"]')).toContainText(
		`${value} is available`,
	)
	await page.getByRole('button', { name: 'Continue', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Yes, create account', exact: true }),
	).toBeVisible()
	await page
		.getByRole('button', { name: 'Yes, create account', exact: true })
		.click()
}

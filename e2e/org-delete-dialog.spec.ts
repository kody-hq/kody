import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('deleting an org confirms in a dialog that traps focus and restores it on cancel', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `org-delete-dialog-${runId}@example.com`,
		username: `org-delete-dialog-${runId}`,
		password: 'org-delete-dialog-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	const slug = `gone-${runId}`
	await page.goto('/account/organizations/new')
	await waitForClientHydration(page)
	await page.getByLabel('Name').fill(`Gone ${runId}`)
	await expect(page.getByLabel('Handle')).toHaveValue(slug)
	await page
		.getByRole('button', { name: 'Create organization', exact: true })
		.click()
	await page.getByRole('button', { name: 'Yes, create organization' }).click()
	await expect(page).toHaveURL(new RegExp(`/@${slug}/-/overview$`))

	await page.goto(`/@${slug}/-/settings`)
	await waitForClientHydration(page)
	const open = page.getByRole('button', { name: 'Delete organization' })
	await open.click()
	const dialog = page.getByRole('dialog', { name: `Delete @${slug}?` })
	await expect(dialog).toHaveAccessibleDescription(
		`Type ${slug} or DELETE to confirm.`,
	)
	const confirmation = dialog.getByRole('textbox', { name: 'Confirmation' })
	await expect(confirmation).toBeFocused()
	await page.keyboard.press('Shift+Tab')
	await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
	await page.keyboard.press('Escape')
	await expect(dialog).toBeHidden()
	await expect(open).toBeFocused()

	await open.click()
	const submit = dialog.getByRole('button', { name: 'Delete organization' })
	await expect(submit).toBeDisabled()
	await confirmation.fill(slug)
	await submit.click()
	await expect(page).not.toHaveURL(new RegExp(`/@${slug}/`))
	await expect(dialog).toBeHidden()
})

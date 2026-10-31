import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('Agent profiles: opt in, create a profile and a sub-profile, see the tree', async ({
	page,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const user = await login({
		email: `profiles-${runId}@example.com`,
		username: `profiles-${runId}`,
		password: 'profiles-e2e-password',
	})
	await page.goto('/account/profiles')
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/profiles$`))
	await waitForClientHydration(page)

	await expect(page.getByTestId('profiles-flag-off')).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'Experiments' }).first(),
	).toHaveAttribute('href', '/account/experiments')
	await page.getByTestId('profiles-flag-opt-in').click()
	await expect(page.getByTestId('profiles-empty')).toBeVisible()

	await page.getByRole('button', { name: 'Create your first profile' }).click()
	const form = page.getByTestId('profile-create')
	await form.locator('input[name="name"]').fill('release-bot')
	await form.getByRole('checkbox', { name: 'org:read', exact: true }).check()
	await form.getByRole('button', { name: 'Create profile' }).click()

	const tree = page.getByRole('tree', { name: 'Agent profiles hierarchy' })
	const root = tree.getByRole('treeitem', { name: /^release-bot,/ })
	await expect(root).toBeVisible()
	await expect(
		page.getByTestId('profile-detail').getByRole('heading', {
			name: 'release-bot',
		}),
	).toBeVisible()

	await page.getByRole('button', { name: 'Add sub-profile' }).click()
	await expect(
		page.getByRole('heading', { name: 'New sub-profile under release-bot' }),
	).toBeVisible()
	await form.locator('input[name="name"]').fill('changelog-writer')
	await form.getByRole('button', { name: 'Create sub-profile' }).click()
	const child = tree.getByRole('treeitem', { name: /^changelog-writer,/ })
	await expect(child).toHaveAttribute('aria-level', '2')
	await expect(root).toHaveAttribute('aria-expanded', 'true')

	await root.focus()
	await page.keyboard.press('ArrowLeft')
	await expect(root).toHaveAttribute('aria-expanded', 'false')
	await expect(child).toBeHidden()
	await page.keyboard.press('ArrowRight')
	await expect(child).toBeVisible()
})

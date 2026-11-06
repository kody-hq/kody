import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { saveKeyThroughUi } from './account-fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('command menu supports keyboard navigation, favorites, confirmation, and focus return', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(90_000)
	const user = await seedE2eUser({
		email: `commands-${Date.now()}@example.com`,
		username: `commands-${Date.now()}`,
		password: 'command-test-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	const trigger = page.getByRole('button', {
		name: 'Search and commands',
		exact: true,
	})
	await trigger.click()
	const dialog = page.getByRole('dialog', { name: 'Search and commands' })
	const search = dialog.getByRole('combobox', {
		name: 'Search Kody',
		exact: true,
	})
	await expect(search).toBeFocused()
	await search.fill('page: security')
	await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
	await search.press(`${mod}+p`)
	await expect(dialog.getByLabel('Favorite', { exact: true })).toBeVisible()
	await search.press('Escape')
	await expect(dialog).not.toBeVisible()
	await expect(trigger).toBeFocused()
	await page.keyboard.press(`${mod}+k`)
	await search.fill('security')
	await expect(
		dialog.getByRole('listbox').getByRole('option').first(),
	).toContainText('Security')
	await search.press('Enter')
	await expect(page).toHaveURL(/\/account\/security$/)
	await expect(dialog).not.toBeVisible()
	await page.reload()
	await waitForClientHydration(page)
	await page.keyboard.press(`${mod}+k`)
	await dialog.getByRole('button', { name: 'Favorites', exact: true }).click()
	await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
	await expect(dialog.getByRole('listbox').getByRole('option')).toContainText(
		'Security',
	)
	await dialog.getByRole('button', { name: 'Favorites', exact: true }).click()
	await search.fill('clear command history')
	await search.press('Enter')
	await expect(
		dialog.getByRole('heading', {
			name: 'Clear command history and favorites',
		}),
	).toBeVisible()
	await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
	await expect(search).toBeFocused()
	await expect(dialog.getByRole('heading')).toHaveCount(0)
	await page.keyboard.press('Escape')
	await expect(dialog).not.toBeVisible()
})

test('resource search finds a saved credential without exposing its value', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(90_000)
	const user = await seedE2eUser({
		email: `command-key-${Date.now()}@example.com`,
		username: `command-key-${Date.now()}`,
		password: 'command-test-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	const value = `sk-command-private-${Date.now()}`
	await saveKeyThroughUi(page, {
		name: 'COMMAND_SEARCH_KEY',
		value,
		description: 'Command search fixture',
		allowedHosts: ['api.example.com'],
	})
	await page.goto('/account')
	await waitForClientHydration(page)
	await page.keyboard.press(`${mod}+k`)
	const dialog = page.getByRole('dialog', { name: 'Search and commands' })
	const search = dialog.getByRole('combobox', {
		name: 'Search Kody',
		exact: true,
	})
	await search.fill('credential: COMMAND_SEARCH_KEY')
	const result = dialog
		.getByRole('listbox')
		.getByRole('option')
		.filter({ hasText: 'COMMAND_SEARCH_KEY' })
	await expect(result).toBeVisible()
	await expect(dialog).not.toContainText(value)
	await search.press('Enter')
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/credentials/`))
	await expect(dialog).not.toBeVisible()
})

test('custom shortcuts detect conflicts, survive reload, and work with a narrow menu', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(90_000)
	const user = await seedE2eUser({
		email: `command-shortcuts-${Date.now()}@example.com`,
		username: `shortcuts-${Date.now()}`,
		password: 'command-test-password',
	})
	await login({ email: user.email, password: user.password, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	await page
		.getByRole('button', { name: 'Search and commands', exact: true })
		.click()
	const dialog = page.getByRole('dialog', { name: 'Search and commands' })
	await dialog
		.getByRole('button', { name: 'Keyboard shortcuts', exact: true })
		.click()
	const change = dialog.getByRole('button', {
		name: 'Change Go to jobs shortcut',
		exact: true,
	})
	await change.click()
	await change.press(`${mod}+k`)
	await change.press('Enter')
	await expect(dialog.getByRole('alert')).toBeVisible()
	await change.press('Escape')
	await change.click()
	await change.press('Control+Shift+9')
	await change.press('Enter')
	await expect(
		dialog.getByRole('button', {
			name: 'Reset Go to jobs shortcut',
			exact: true,
		}),
	).toBeVisible()
	await dialog
		.getByRole('button', { name: 'Back to search', exact: true })
		.click()
	await dialog
		.getByRole('combobox', { name: 'Search Kody', exact: true })
		.press('Escape')
	await page.reload()
	await waitForClientHydration(page)
	await page
		.getByRole('button', { name: 'Search and commands', exact: true })
		.press('Control+Shift+9')
	await expect(page).toHaveURL(new RegExp(`/@${user.username}/-/jobs$`))
	await page.keyboard.press(`${mod}+k`)
	await expect(
		dialog.getByRole('combobox', { name: 'Search Kody', exact: true }),
	).toBeFocused()
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.emulateMedia({ colorScheme: 'dark' })
	await expect(dialog.getByText('Searching…', { exact: true })).toHaveCount(0)
	await page.screenshot({ path: '.tmp/command-menu-desktop.png' })
	await page.setViewportSize({ width: 390, height: 844 })
	await page.emulateMedia({ colorScheme: 'light' })
	const box = await dialog.boundingBox()
	expect(box!.x).toBeGreaterThanOrEqual(0)
	expect(box!.x + box!.width).toBeLessThanOrEqual(390)
	expect(
		await dialog.evaluate(
			(element) => element.scrollWidth <= element.clientWidth,
		),
	).toBe(true)
	await expect(
		dialog.getByRole('button', { name: 'Actions', exact: false }),
	).toBeVisible()
	await page.screenshot({ path: '.tmp/command-menu-mobile.png' })
	await page.setViewportSize({ width: 1280, height: 800 })
	await dialog
		.getByRole('button', { name: 'Keyboard shortcuts', exact: true })
		.click()
	const openShortcut = dialog.getByRole('button', {
		name: 'Change Search and commands shortcut',
		exact: true,
	})
	await openShortcut.click()
	await openShortcut.press('Control+Shift+8')
	await openShortcut.press('Enter')
	await change.click()
	await change.press(`${mod}+k`)
	await change.press('Enter')
	await dialog
		.getByRole('button', {
			name: 'Reset Search and commands shortcut',
			exact: true,
		})
		.click()
	await expect(dialog.getByRole('alert')).toContainText('Go to jobs')
	await dialog
		.getByRole('button', { name: 'Reset Go to jobs shortcut', exact: true })
		.click()
	await dialog
		.getByRole('button', {
			name: 'Reset Search and commands shortcut',
			exact: true,
		})
		.click()
	await expect(dialog.getByRole('alert')).toHaveCount(0)
	await dialog
		.getByRole('button', { name: 'Back to search', exact: true })
		.click()
	await page.keyboard.press('Escape')
	await expect(dialog).not.toBeVisible()
})

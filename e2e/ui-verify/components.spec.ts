import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

// Keyboard and ARIA behavior of the shared controls, driven through the
// /dev/ui gallery so each component is tested the way pages render it.
test.describe('shared form controls', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/dev/ui#choice')
		await waitForClientHydration(page)
		await expect(
			page.getByRole('heading', { name: 'UI gallery', level: 1 }),
		).toBeVisible()
	})

	test('Field labels its control and announces description and error', async ({
		page,
	}) => {
		await expect(
			page.getByLabel('With description'),
		).toHaveAccessibleDescription('Help text, announced with the control.')
		const invalid = page.getByLabel('Invalid')
		await expect(invalid).toHaveAttribute('aria-invalid', 'true')
		await expect(invalid).toHaveAccessibleDescription(
			'Enter a valid email address.',
		)
		await page.getByText('Default', { exact: true }).click()
		await expect(page.getByLabel('Default')).toBeFocused()
	})

	test('Checkbox shows mixed state for a partly selected group', async ({
		page,
	}) => {
		const all = page.getByRole('checkbox', { name: 'Select all' })
		await expect(all).toHaveJSProperty('indeterminate', true)
		await all.focus()
		await page.keyboard.press('Space')
		await expect(all).toBeChecked()
		await expect(all).toHaveJSProperty('indeterminate', false)
		await expect(page.getByRole('checkbox', { name: 'Item 2' })).toBeChecked()
		await page.getByRole('checkbox', { name: 'Item 1' }).click()
		await expect(all).toHaveJSProperty('indeterminate', true)
	})

	test('Radio group moves selection with arrow keys and skips disabled', async ({
		page,
	}) => {
		const team = page.getByRole('radio', { name: 'Team' })
		await expect(team).toBeChecked()
		await team.focus()
		await page.keyboard.press('ArrowLeft')
		await expect(page.getByRole('radio', { name: 'Free' })).toBeChecked()
		await expect(page.getByRole('radio', { name: 'Free' })).toBeFocused()
		await expect(page.getByRole('radio', { name: 'Enterprise' })).toBeDisabled()
	})

	test('Switch toggles with Space, Enter, and its label', async ({ page }) => {
		const toggle = page.getByRole('switch', { name: 'Email notifications' })
		await expect(toggle).toHaveAttribute('aria-checked', 'true')
		await toggle.focus()
		await page.keyboard.press('Space')
		await expect(toggle).toHaveAttribute('aria-checked', 'false')
		await expect(toggle).toBeFocused()
		await page.keyboard.press('Enter')
		await expect(toggle).toHaveAttribute('aria-checked', 'true')
		await page.getByText('Email notifications', { exact: true }).click()
		await expect(toggle).toHaveAttribute('aria-checked', 'false')
		const disabled = page.getByRole('switch', { name: 'Disabled on' })
		await expect(disabled).toBeDisabled()
		await expect(disabled).toHaveAttribute('aria-checked', 'true')
	})
})

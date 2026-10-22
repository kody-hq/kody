import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('signup confirms the permanent handle before sending credentials and supports password reveal', async ({
	page,
}) => {
	let submissions = 0
	await page.route('**/_serverFn/**', async (route) => {
		if (
			route.request().method() !== 'POST' ||
			!route.request().postData()?.includes('password')
		)
			return route.fallback()
		submissions += 1
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				result: {
					successful: false,
					error: 'Test submission received.',
				},
			}),
		})
	})
	await page.goto('/signup')
	await waitForClientHydration(page)
	const usernameField = page.getByRole('textbox', { name: 'Username' })
	await usernameField.fill('parity-test')
	await page.getByLabel('Email', { exact: true }).fill('parity@example.com')
	const password = page.getByLabel('Password', { exact: true })
	await password.fill('test-password-only')
	await page.getByRole('button', { name: 'Show password', exact: true }).click()
	await expect(password).toHaveAttribute('type', 'text')
	await page.getByRole('button', { name: 'Hide password', exact: true }).click()
	await expect(password).toHaveAttribute('type', 'password')
	await expect(page.locator('[data-status="available"]')).toContainText(
		'parity-test is available',
	)
	await page
		.getByRole('button', { name: 'Create account', exact: true })
		.click()
	await expect(
		page.getByRole('button', { name: 'Yes, create account', exact: true }),
	).toBeVisible()
	expect(submissions).toBe(0)
	await usernameField.fill('other-handle')
	await expect(page.locator('[data-status="available"]')).toContainText(
		'other-handle is available',
	)
	await page
		.getByRole('button', { name: 'Create account', exact: true })
		.click()
	await expect(
		page.getByRole('button', { name: 'Yes, create account', exact: true }),
	).toBeVisible()
	await expect(page.getByTestId('username-permanence-confirm')).toContainText(
		'other-handle',
	)
	expect(submissions).toBe(0)
	await page
		.getByRole('button', { name: 'Yes, create account', exact: true })
		.click()
	await expect.poll(() => submissions).toBe(1)
	await expect(page.getByRole('alert')).toContainText(
		'Test submission received.',
	)
})

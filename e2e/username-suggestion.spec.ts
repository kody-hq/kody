import { expect, test, waitForClientHydration } from './playwright-utils.ts'
import { seedUserInE2eDatabase } from './d1-utils.ts'

function uniqueUsername() {
	return `e2e-sug-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

async function seedTakenUsername(username: string) {
	await seedUserInE2eDatabase({
		email: `${username}@example.com`,
		username,
		password: 'e2e-suggestion-password',
	})
}

test('an invalid username offers a clickable, available suggestion', async ({
	page,
}) => {
	const base = uniqueUsername()
	await page.goto('/signup')
	await waitForClientHydration(page)

	const field = page.getByLabel('Username', { exact: true })
	await field.fill(`${base};j`)
	const suggestion = page.getByRole('button', { name: `Use ${base}-j` })
	await expect(suggestion).toBeVisible()

	await suggestion.focus()
	await page.keyboard.press('Enter')
	await expect(field).toHaveValue(`${base}-j`)
	await expect(field).toBeFocused()
	await expect(page.getByText(`${base}-j is available.`)).toBeVisible()
	await expect(page.getByTestId('handle-suggestion')).toHaveCount(0)
})

test('a taken sanitized suggestion falls back to the first free variant', async ({
	page,
}) => {
	const base = uniqueUsername()
	await seedTakenUsername(base)
	await page.goto('/signup')
	await waitForClientHydration(page)

	const field = page.getByLabel('Username', { exact: true })
	await field.fill(`${base};`)
	await expect(
		page.getByRole('button', { name: `Use ${base}-2` }),
	).toBeVisible()
	await expect(
		page.getByRole('button', { name: `Use ${base}`, exact: true }),
	).toHaveCount(0)
})

test('a suggestion taken before the click shows the normal taken error', async ({
	page,
}) => {
	const base = uniqueUsername()
	await page.goto('/signup')
	await waitForClientHydration(page)

	const field = page.getByLabel('Username', { exact: true })
	await field.fill(`${base};`)
	const suggestion = page.getByRole('button', {
		name: `Use ${base}`,
		exact: true,
	})
	await expect(suggestion).toBeVisible()

	await seedTakenUsername(base)
	await suggestion.click()
	await expect(field).toHaveValue(base)
	await expect(field).toBeFocused()
	await expect(
		page.getByRole('status').filter({ hasText: 'taken' }),
	).toBeVisible()
})

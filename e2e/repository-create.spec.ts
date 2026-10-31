import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('Repositories page creates a repository and shows the agent start prompt', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 120_000 : 90_000)
	const runId = Date.now()
	const owner = await seedE2eUser({
		email: `repo-create-${runId}@example.com`,
		username: `repo-create-${runId}`,
		password: 'repo-create-password',
	})
	const repoName = `starter-${runId}`

	await login({ email: owner.email, password: owner.password, mode: 'login' })
	await page.goto(`/@${owner.username}/-/repositories`)
	await waitForClientHydration(page)
	await Promise.all([
		page.waitForURL(new RegExp(`/@${owner.username}/-/repositories/new$`)),
		page.getByTestId('repositories-new').click(),
	])

	const form = page.getByTestId('repository-create-form')
	await expect(form.getByRole('combobox', { name: 'Owner' })).toHaveValue(
		owner.username,
	)
	const name = form.getByRole('textbox', { name: 'Repository name' })
	await name.fill('Bad Name')
	await expect(page.getByTestId('repository-name-error')).toContainText(
		'only use lowercase letters, numbers, and dashes',
	)
	await expect(name).toHaveAttribute('aria-invalid', 'true')

	await name.fill(repoName)
	await expect(page.getByTestId('repository-name-error')).toHaveCount(0)
	await form.getByRole('button', { name: 'Create repository' }).click()

	await expect(
		page.getByRole('heading', { name: 'Repository created' }),
	).toBeVisible()
	const prompt = page.getByTestId('repository-start-prompt')
	await expect(prompt).toContainText(`@${owner.username}/${repoName}`)
	await expect(prompt).toContainText(
		`git clone ${new URL(page.url()).origin}/@${owner.username}/${repoName}.git`,
	)
	await expect(
		page.getByRole('link', { name: 'Open repository' }),
	).toHaveAttribute('href', `/@${owner.username}/${repoName}`)

	await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
	await page.getByRole('button', { name: 'Copy prompt' }).click()
	await expect(
		page.getByRole('status').filter({ hasText: 'Copied' }),
	).toHaveCount(1)

	await page.getByRole('button', { name: 'Create another' }).click()
	await name.fill(repoName)
	await form.getByRole('button', { name: 'Create repository' }).click()
	await expect(page.getByTestId('repository-name-error')).toContainText(
		'already exists',
	)
})

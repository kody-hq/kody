import { seedStableUserIdFromEmail } from '../tools/seed-sql.ts'
import { executeE2eD1Command } from './d1-utils.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

function sqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

test('Repositories page lists plain repos beside packages with Repo marking and a working link', async ({
	page,
	seedE2eUser,
	login,
}) => {
	test.setTimeout(process.env.CI ? 90_000 : 60_000)
	const runId = Date.now()
	const user = await seedE2eUser({
		email: `repos-plain-${runId}@example.com`,
		username: `repos-plain-${runId}`,
		password: 'repos-plain-password',
	})
	const ownerId = seedStableUserIdFromEmail(user.email)
	const repoId = `repo-plain-${runId}`
	const repoName = `stash-files-${runId}`
	const now = new Date().toISOString()
	executeE2eD1Command(`
INSERT INTO user_repos (id, user_id, name, description, is_private, created_at, updated_at)
VALUES (
	${sqlString(repoId)},
	${sqlString(ownerId)},
	${sqlString(repoName)},
	'E2E plain repo',
	1,
	${sqlString(now)},
	${sqlString(now)}
);
`)

	await login({ email: user.email, password: user.password, mode: 'login' })
	const listResponse = await page.goto(
		`/@${user.username}/-/packages?sort=name#repositories`,
	)
	await expect(page).toHaveURL(
		new RegExp(`/@${user.username}/-/repositories\\?sort=name#repositories$`),
	)
	expect(listResponse?.status()).toBe(200)
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { level: 1, name: 'Repositories' }),
	).toBeVisible()
	const row = page.locator('li').filter({ hasText: repoName })
	await expect(row).toBeVisible()
	await expect(row.getByTitle('Repo')).toBeVisible()
	await expect(row.getByTitle('Package')).toHaveCount(0)
	const link = row.getByRole('link', { name: new RegExp(repoName) })
	await expect(link).toHaveAttribute('href', `/@${user.username}/${repoName}`)

	await Promise.all([
		page.waitForURL(new RegExp(`/@${user.username}/${repoName}$`)),
		link.click(),
	])
	await expect(page.getByTestId('package-title-name')).toContainText(repoName)
	await expect(page.getByTestId('not-found-page')).toHaveCount(0)
})

test('legacy repository documents redirect with their query and retired JSON stays absent', async ({
	request,
}) => {
	const response = await request.get(
		'/@legacy/-/packages?q=hello&visibility=public',
		{ maxRedirects: 0 },
	)
	expect(response.status()).toBe(301)
	const location = new URL(response.headers().location!, response.url())
	expect(location.pathname).toBe('/@legacy/-/repositories')
	expect(location.search).toBe('?q=hello&visibility=public')
	const retired = await request.get('/@legacy/-/packages.json?q=hello', {
		maxRedirects: 0,
	})
	expect(retired.status()).toBe(404)
})

import { saveKeyThroughUi } from './account-fixtures.ts'
import { expect, test, waitForClientHydration } from './playwright-utils.ts'

test('Start matches unknown admin paths before any admin authorization redirect', async ({
	page,
}) => {
	for (const path of [
		'/administrator',
		'/admin/missing-route',
		'/admin/users/missing/extra',
		'/admin/users/missing/extra?q=kept&pageSize=37',
		'/admin/feature-flags/missing',
	]) {
		const response = await page.request.get(path, { maxRedirects: 0 })
		expect(response.status(), path).toBe(404)
		expect(response.headers().location, path).toBeUndefined()
	}
	const trailingSlash = await page.request.get('/admin/', { maxRedirects: 0 })
	expect(trailingSlash.status()).toBe(307)
	expect(trailingSlash.headers().location).toBe('/admin')
	for (const path of ['/admin', '/admin/users', '/admin/users/missing']) {
		const response = await page.request.get(path, { maxRedirects: 0 })
		expect(response.status(), path).toBe(302)
		expect(response.headers().location, path).toContain('/login?')
	}
})

test('admin RBAC controls access, role assignment, and privacy boundaries', async ({
	page,
	seedE2eUser,
	assignRole,
	login,
}) => {
	const runId = Date.now()
	const adminUser = await seedE2eUser({
		email: `admin-rbac-${runId}@example.com`,
		username: `admin-rbac-${runId}`,
		password: 'admin-rbac-password',
	})
	const memberUser = await seedE2eUser({
		email: `member-rbac-${runId}@example.com`,
		username: `member-rbac-${runId}`,
		password: 'member-rbac-password',
	})

	await assignRole(adminUser.email, 'admin')

	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	const forbiddenDocument = await page.goto('/admin/users')
	expect(forbiddenDocument?.status()).toBe(403)
	const forbiddenIndex = await page.request.get('/admin', { maxRedirects: 0 })
	expect(forbiddenIndex.status()).toBe(403)
	await expect(page.getByRole('heading', { name: 'Admin users' })).toBeHidden()
	await expect(page.getByText('Forbidden')).toBeVisible()
	const memberUsageResponse = await page.request.get('/admin/users/forbidden')
	expect(memberUsageResponse.status()).toBe(403)
	await page.goto('/admin/insights')
	await expect(
		page.getByRole('heading', { name: 'Admin insights' }),
	).toBeHidden()
	await expect(page.getByText('Forbidden')).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'Admin', exact: true }),
	).toHaveCount(0)

	await saveKeyThroughUi(page, {
		name: 'memberPrivateSecret',
		value: 'super-secret-value',
	})

	await page.context().clearCookies()
	await login({
		email: adminUser.email,
		password: adminUser.password,
		mode: 'login',
	})
	await page.goto('/')

	await expect(
		page.getByRole('link', { name: 'Admin', exact: true }),
	).toBeVisible()
	await page.getByRole('link', { name: 'Admin', exact: true }).click()
	await expect(page).toHaveURL(/\/admin\/users\/?$/)
	await expect(page.getByRole('heading', { name: 'Admin users' })).toBeVisible()

	await page.goto(`/admin/users?q=rbac-${runId}`)
	await expect(
		page.getByRole('link', { name: memberUser.username }),
	).toBeVisible()
	await expect(page.getByText(memberUser.email)).toBeVisible()
	await expect(page.getByText('memberPrivateSecret')).toHaveCount(0)
	await expect(page.getByText('super-secret-value')).toHaveCount(0)

	const usersDocument = await page.request.get(`/admin/users?q=rbac-${runId}`)
	expect(usersDocument.ok()).toBe(true)
	const usersHtml = await usersDocument.text()
	expect(usersHtml).toContain(memberUser.email)
	expect(usersHtml).not.toContain('memberPrivateSecret')
	expect(usersHtml).not.toContain('super-secret-value')

	await page.getByRole('link', { name: memberUser.username }).click()
	await expect(page.getByText('Account metadata only')).toBeVisible()
	await expect(page.getByText('memberPrivateSecret')).toHaveCount(0)
	await expect(page.getByText('super-secret-value')).toHaveCount(0)

	await page.goto(`/admin/users?q=rbac-${runId}`)
	await page.getByRole('link', { name: memberUser.username }).click()
	// Assign requires client hydration before its native mutation can run.
	await waitForClientHydration(page)
	const roleSelect = page.getByLabel('Role', { exact: true })
	await roleSelect.selectOption('admin')
	await page.getByRole('button', { name: 'Assign', exact: true }).click()
	await expect(page.getByText('Assigned admin role.')).toBeVisible()
	await expect(page.getByText('admin, user')).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Remove', exact: true }),
	).toBeEnabled()

	await page.context().clearCookies()
	await login({
		email: memberUser.email,
		password: memberUser.password,
		mode: 'login',
	})
	await page.goto('/admin/users')
	await expect(
		page.getByRole('heading', { name: 'Admin users', exact: true }),
	).toBeVisible()
})

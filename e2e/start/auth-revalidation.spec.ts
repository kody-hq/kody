import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('revoking the same user admin role blocks a warm cached revisit', async ({
	page,
	browser,
	baseURL,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `role-a-${id}@example.com`,
		username: `role-a-${id}`,
		admin: true,
	})
	const operator = await seedE2eUser({
		email: `role-b-${id}@example.com`,
		username: `role-b-${id}`,
		admin: true,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/admin/feature-flags')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Admin feature flags' }),
	).toBeVisible()
	await page.evaluate(() => {
		document.documentElement.dataset.permissionDocument = 'original'
		window.history.pushState(null, '', '/account')
	})
	await expect(page.getByLabel('Display name', { exact: true })).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'View public profile', exact: true }),
	).toHaveAttribute('href', `/@${user.username}`)
	const other = await browser.newContext({ baseURL })
	try {
		const signedIn = await other.request.post('/auth', {
			data: { ...operator, mode: 'login' },
		})
		expect(signedIn.ok()).toBe(true)
		const operatorPage = await other.newPage()
		await operatorPage.goto(`/admin/users?q=${encodeURIComponent(user.email)}`)
		await waitForClientHydration(operatorPage)
		await operatorPage
			.getByRole('row')
			.filter({ hasText: user.email })
			.getByRole('link')
			.first()
			.click()
		await operatorPage
			.getByRole('combobox', { name: 'Role', exact: true })
			.selectOption('admin')
		await expect(
			operatorPage.getByRole('combobox', { name: 'Role', exact: true }),
		).toHaveValue('admin')
		const roleChangeResponse = operatorPage.waitForResponse(
			(response) =>
				new URL(response.url()).pathname.startsWith('/_serverFn/') &&
				response.request().method() === 'POST' &&
				response.request().postData()?.includes('stableUserId') === true &&
				response.request().postData()?.includes('admin') === true,
		)
		await operatorPage
			.getByRole('button', { name: 'Remove', exact: true })
			.click()
		const changed = await roleChangeResponse
		const changeResult = await changed.text()
		expect(changed.status(), changeResult).toBe(200)
		expect(changeResult).toContain('updatedUser')
		await expect
			.poll(async () => operatorPage.locator('main').innerText())
			.toContain('Removed admin role.')
		await page.evaluate(() =>
			window.history.pushState(null, '', '/admin/feature-flags'),
		)
		await expect(page.getByText('Forbidden', { exact: true })).toBeVisible()
		await expect(
			page.getByRole('heading', { name: 'Admin feature flags' }),
		).toHaveCount(0)
		await expect(page.locator('html')).toHaveAttribute(
			'data-permission-document',
			'original',
		)
	} finally {
		await other.close()
	}
})

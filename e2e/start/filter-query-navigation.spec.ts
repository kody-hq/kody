import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import { requestHasDataFields } from '../server-function-requests.ts'

test('memory search commits filters while Query fetches without replacing the input', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `filter-${id}@example.com`,
		username: `filter-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto(`/@${user.username}/-/memories`)
	await waitForClientHydration(page)
	await page.waitForLoadState('networkidle')
	let verifications = 0
	page.on('request', (request) => {
		if (
			requestHasDataFields(request, {
				orgSlug: user.username,
				section: 'memories',
			})
		)
			verifications++
	})
	const search = page.getByRole('searchbox', { name: 'Search memories' })
	await search.evaluate((element) =>
		element.setAttribute('data-original-input', 'yes'),
	)
	let release!: () => void
	const blocked = new Promise<void>((resolve) => {
		release = resolve
	})
	let requested = false
	await page.route('**/_serverFn/**', async (route) => {
		if (!requestHasDataFields(route.request(), { query: 'pending' }))
			return route.continue()
		requested = true
		await blocked
		await route.continue()
	})
	try {
		await search.fill('pending')
		await expect.poll(() => requested).toBe(true)
		await expect(page).toHaveURL(
			(url) => url.searchParams.get('q') === 'pending',
			{ timeout: 1500 },
		)
		await expect(search).toHaveAttribute('data-original-input', 'yes')
		await expect(search).toBeFocused()
		await expect(search).toHaveValue('pending')
		expect(verifications).toBe(0)
		const deleted = page.getByRole('checkbox', {
			name: 'Include deleted',
			exact: true,
		})
		await deleted.check()
		await expect(deleted).toBeChecked()
		await expect(search).toHaveAttribute('data-original-input', 'yes')
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
	await expect(
		page.getByRole('checkbox', { name: 'Include deleted', exact: true }),
	).toBeVisible()
})

import { randomUUID } from 'node:crypto'
import { seedStableUserIdFromEmail } from '../../tools/seed-sql.ts'
import { executeE2eD1Command } from '../d1-utils.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import { requestHasDataFields } from '../server-function-requests.ts'

test('a memory detail click wins over an earlier pending search navigation', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const suffix = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `memory-nav-${suffix}@example.com`,
		username: `memory-nav-${suffix}`,
	})
	const memoryId = randomUUID()
	const ownerId = seedStableUserIdFromEmail(user.email)
	executeE2eD1Command(`INSERT INTO mcp_memories (id, user_id, subject, summary)
		VALUES ('${memoryId}', '${ownerId}', 'Navigation fixture', 'Persisted detail summary');`)
	await login({ ...user, mode: 'login' })
	const listPath = `/@${user.username}/-/memories`
	await page.goto(listPath)
	await waitForClientHydration(page)
	const link = page.getByRole('link', {
		name: 'Navigation fixture',
		exact: true,
	})
	await expect(link).toBeVisible()
	let release!: () => void
	let started!: () => void
	let completed!: () => void
	const blocked = new Promise<void>((resolve) => (release = resolve))
	const searchStarted = new Promise<void>((resolve) => (started = resolve))
	const searchCompleted = new Promise<void>((resolve) => (completed = resolve))
	await page.route('**/_serverFn/**', async (route) => {
		if (
			!requestHasDataFields(route.request(), {
				query: 'Navigation',
				memoryId: undefined,
			})
		) {
			await route.continue()
			return
		}
		const response = await route.fetch()
		started()
		await blocked
		try {
			await route.fulfill({ response })
		} finally {
			completed()
		}
	})
	try {
		await page
			.getByRole('searchbox', { name: 'Search memories' })
			.fill('Navigation')
		await searchStarted
		// The list is intentionally retained while its search read is blocked.
		await link.click()
		await expect(page).toHaveURL(
			(url) => url.pathname === `${listPath}/${memoryId}`,
		)
		await expect(
			page
				.getByRole('paragraph')
				.filter({ hasText: /^Persisted detail summary$/ }),
		).toBeVisible()
		release()
		await searchCompleted
		await expect(page).toHaveURL(
			(url) => url.pathname === `${listPath}/${memoryId}`,
		)
		await expect(
			page.getByRole('heading', { name: 'Navigation fixture', exact: true }),
		).toBeVisible()
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
	await page.getByRole('button', { name: 'Soft delete', exact: true }).click()
	await page
		.getByRole('button', { name: 'Confirm soft delete', exact: true })
		.click()
	await expect(
		page.getByRole('link', { name: 'Navigation fixture', exact: true }),
	).toHaveCount(0)
	// Keep filter state as a native boolean across navigation and a full reload.
	await page
		.getByRole('checkbox', { name: 'Include deleted', exact: true })
		.check()
	await expect(page).toHaveURL(
		(url) => url.searchParams.get('includeDeleted') === 'true',
	)
	await expect(
		page.getByRole('link', { name: 'Navigation fixture', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('cell', { name: 'Deleted', exact: true }),
	).toBeVisible()
	await page.reload()
	await expect(
		page.getByRole('checkbox', { name: 'Include deleted', exact: true }),
	).toBeChecked()
	await expect(
		page.getByRole('cell', { name: 'Deleted', exact: true }),
	).toBeVisible()
})

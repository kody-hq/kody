import { randomUUID } from 'node:crypto'
import { orgResourcePath } from '../../packages/worker/universal/org-pages.ts'
import { requestHasDataFields } from '../server-function-requests.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('private data loads while access verification is pending, but cannot commit ahead of it', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `parallel-access-${id}@example.com`,
		username: `parallel-access-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	await page.waitForLoadState('networkidle')
	const destination = orgResourcePath(user.username, 'jobs')
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let verificationStarted = false
	await page.route('**/_serverFn/**', async (route) => {
		if (
			requestHasDataFields(route.request(), {
				orgSlug: user.username,
				section: 'jobs',
			})
		) {
			verificationStarted = true
			await held
		}
		await route.continue()
	})
	try {
		const dataRead = page.waitForResponse((response) =>
			requestHasDataFields(
				response.request(),
				{ orgSlug: user.username, jobId: undefined },
				['section'],
			),
		)
		await page.evaluate(
			(href) => window.history.pushState(null, '', href),
			destination,
		)
		const response = await dataRead
		expect(response.ok()).toBe(true)
		expect(verificationStarted).toBe(true)
		// The data RPC has completed, but the root authorization gate has not.
		await expect(page.getByLabel('Display name', { exact: true })).toBeVisible()
		release()
		await expect(page.getByLabel('Search jobs')).toBeVisible()
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
})

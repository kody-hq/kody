import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

for (const { outcome, prewarm } of [
	{ outcome: 'accepted', prewarm: true },
	{ outcome: 'rejected', prewarm: true },
	{ outcome: 'accepted', prewarm: false },
	{ outcome: 'rejected', prewarm: false },
] as const) {
	test(`profile writes reconcile after unmount and ${outcome === 'accepted' ? 'persists after' : 'rolls back after'} a held write${prewarm ? '' : ' on an uncached profile'}`, async ({
		page,
		seedE2eUser,
		login,
	}) => {
		const id = randomUUID().slice(0, 8)
		const user = await seedE2eUser({
			email: `query-${id}@example.com`,
			username: `query-${id}`,
		})
		await login({ ...user, mode: 'login' })
		await page.goto('/account')
		await waitForClientHydration(page)
		await page.clock.install()
		const original = await page
			.getByLabel('Display name', { exact: true })
			.inputValue()
		const originalBio = await page
			.getByRole('textbox', { name: 'Bio', exact: true })
			.inputValue()
		if (prewarm) {
			await page
				.getByRole('link', { name: 'View public profile', exact: true })
				.click()
			await expect(page.getByTestId('profile-display-name')).toHaveText(
				original,
			)
			await page
				.getByRole('link', { name: 'Account settings', exact: true })
				.click()
			await expect(
				page.getByLabel('Display name', { exact: true }),
			).toHaveValue(original)
		}

		await page.evaluate(() => {
			document.documentElement.dataset.queryMutationDocument = 'original'
		})
		const nextName = `Optimistic ${id}`
		const nextBio = `Changed before the server responds ${id}`
		let release!: () => void
		let captured!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		const held = new Promise<void>((resolve) => {
			captured = resolve
		})
		await page.route('**/*', async (route) => {
			if (
				route.request().method() !== 'POST' ||
				route.request().headers()['x-tsr-serverfn'] !== 'true' ||
				!route.request().postData()?.includes('displayName')
			)
				return route.continue()
			captured()
			await barrier
			if (outcome === 'rejected')
				return route.fulfill({
					status: 500,
					contentType: 'text/plain',
					body: 'Controlled profile write failed',
				})
			await route.continue()
		})
		const errors: string[] = []
		page.on('pageerror', (error) => errors.push(error.message))
		try {
			await page.getByLabel('Display name', { exact: true }).fill(nextName)
			await page
				.getByRole('textbox', { name: 'Bio', exact: true })
				.fill(nextBio)
			const writeResponse = page.waitForResponse(
				(response) =>
					response.request().headers()['x-tsr-serverfn'] === 'true' &&
					response.request().postData()?.includes('displayName') === true &&
					response.request().method() === 'POST',
			)
			await page
				.getByRole('button', { name: 'Save profile', exact: true })
				.click()
			await held
			const observer = await page.context().newPage()
			await observer.goto('/account')
			await expect(
				observer.getByLabel('Display name', { exact: true }),
			).toHaveValue(original)
			await observer.close()
			await page
				.getByRole('link', { name: 'View public profile', exact: true })
				.click()
			// Cached profiles still require a fresh visibility check. That read waits
			// for this write, so keep the current form until access is confirmed.
			await expect(
				page.getByLabel('Display name', { exact: true }),
			).toHaveValue(nextName)
			await expect(page.getByTestId('profile-display-name')).toHaveCount(0)
			// Supersede the waiting profile navigation and unmount the submitter.
			await page.evaluate(() => window.history.pushState(null, '', '/pricing'))
			await expect(page.locator('main')).toContainText('Worker compute')
			await page.clock.fastForward(61_000)
			await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
			release()
			expect((await writeResponse).status()).toBe(
				outcome === 'accepted' ? 200 : 500,
			)
			await page.evaluate(
				(href) => window.history.pushState(null, '', href),
				`/@${user.username}`,
			)
			await expect(page.getByTestId('profile-display-name')).toHaveText(
				outcome === 'accepted' ? nextName : original,
			)
			await expect(page).toHaveTitle(
				outcome === 'accepted' ? nextName : original,
			)
			if (outcome === 'rejected')
				await expect(
					page
						.getByRole('alert')
						.filter({ hasText: /failed|fetch|network|error/i }),
				).toBeVisible()
			await expect(page.locator('html')).toHaveAttribute(
				'data-query-mutation-document',
				'original',
			)
			await page
				.getByRole('link', { name: 'Account settings', exact: true })
				.click()
			await expect(
				page.getByLabel('Display name', { exact: true }),
			).toHaveValue(outcome === 'accepted' ? nextName : original)
			await expect(
				page.getByRole('textbox', { name: 'Bio', exact: true }),
			).toHaveValue(outcome === 'accepted' ? nextBio : originalBio)
			const bio = page.getByRole('textbox', { name: 'Bio', exact: true })
			await expect(bio).toHaveAccessibleName('Bio')
			const labels = await bio.evaluate((element) => {
				if (!(element instanceof HTMLTextAreaElement))
					throw new Error('Expected textarea')
				return Array.from(element.labels ?? []).map((label) => ({
					text: label.textContent,
					caption: label.querySelector('span')?.textContent,
				}))
			})
			expect(labels).toHaveLength(1)
			expect(labels[0]?.caption).toBe('Bio')
			test.info().annotations.push({
				type: 'bio-label-association',
				description: JSON.stringify(labels),
			})
			await page.reload()
			await waitForClientHydration(page)
			await expect(
				page.getByLabel('Display name', { exact: true }),
			).toHaveValue(outcome === 'accepted' ? nextName : original)
			expect(errors).toEqual([])
		} finally {
			release()
			await page.unrouteAll({ behavior: 'wait' })
		}
	})
}

test('profile drafts preserve edits while untouched fields follow background changes', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `query-draft-${id}@example.com`,
		username: `query-draft-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	await page.clock.install()
	const displayName = page.getByLabel('Display name', { exact: true })
	const bio = page.getByRole('textbox', { name: 'Bio', exact: true })
	await displayName.fill(`Unsaved ${id}`)
	const updatedBio = `Saved in another session ${id}`
	const other = await page.context().newPage()
	try {
		await other.goto('/account')
		await waitForClientHydration(other)
		await other
			.getByRole('textbox', { name: 'Bio', exact: true })
			.fill(updatedBio)
		await other
			.getByRole('button', { name: 'Save profile', exact: true })
			.click()
		await expect(
			other.getByRole('button', { name: 'Save profile', exact: true }),
		).toBeDisabled()
		await other.reload()
		await expect(
			other.getByRole('textbox', { name: 'Bio', exact: true }),
		).toHaveValue(updatedBio)
	} finally {
		await other.close()
	}
	await page.clock.fastForward(61_000)
	await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
	await expect(bio).toHaveValue(updatedBio)
	await expect(displayName).toHaveValue(`Unsaved ${id}`)
})

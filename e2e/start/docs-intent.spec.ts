import {
	collectJsonRequests,
	expectSingleCommitTransition,
	observeMainTransitions,
	readMainTransitions,
} from '../main-transitions.ts'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

for (const intent of ['hover', 'focus', 'touch'] as const) {
	test(`docs render warms the sidebar and ${intent} reuses the chosen article`, async ({
		page,
	}) => {
		const reads = collectJsonRequests(page)
		const loaded = page.waitForResponse(
			(response) =>
				response.url().includes('/_serverFn/') &&
				decodeURIComponent(response.url()).includes('"secrets"'),
		)
		await page.goto('/docs/memory')
		await waitForClientHydration(page)
		await (await loaded).finished()
		await page.waitForLoadState('networkidle')
		expect(reads.forDoc('secrets')).toHaveLength(1)
		const link = page
			.getByRole('navigation', { name: 'Docs' })
			.first()
			.getByRole('link', { name: 'Secrets', exact: true })
		if (intent === 'hover') await link.hover()
		else if (intent === 'focus') await link.focus()
		else await link.dispatchEvent('touchstart')
		await page.waitForLoadState('networkidle')
		expect(reads.forDoc('secrets')).toHaveLength(1)
		await observeMainTransitions(page)
		await link.click()
		await expect(
			page.getByRole('heading', { name: 'Secrets', exact: true }),
		).toBeVisible()
		await page.waitForLoadState('networkidle')
		expectSingleCommitTransition(await readMainTransitions(page), {
			fromHeading: 'Shared memory',
			toHeading: 'Secrets',
		})
		expect(reads.forDoc('secrets')).toHaveLength(1)
	})
}

test('a docs click during an unfinished render preload keeps its article until the read completes', async ({
	page,
}) => {
	let release!: () => void
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	let started!: () => void
	const reading = new Promise<void>((resolve) => {
		started = resolve
	})
	await page.route('**/_serverFn/**', async (route) => {
		if (decodeURIComponent(route.request().url()).includes('"secrets"')) {
			started()
			await held
		}
		await route.continue()
	})
	try {
		await page.goto('/docs/memory')
		await waitForClientHydration(page)
		await reading
		await observeMainTransitions(page)
		// Native click activation without pointer hover or focus prewarming.
		await page
			.getByRole('navigation', { name: 'Docs' })
			.first()
			.getByRole('link', { name: 'Secrets', exact: true })
			.evaluate((link: HTMLAnchorElement) => link.click())
		await reading
		await expect(
			page.getByRole('heading', { name: 'Shared memory', exact: true }),
		).toBeVisible()
		await expect(
			page.getByRole('heading', { name: 'Secrets', exact: true }),
		).toHaveCount(0)
		release()
		await expect(
			page.getByRole('heading', { name: 'Secrets', exact: true }),
		).toBeVisible()
		expectSingleCommitTransition(await readMainTransitions(page), {
			fromHeading: 'Shared memory',
			toHeading: 'Secrets',
		})
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
})

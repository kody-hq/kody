import { randomUUID } from 'node:crypto'
import { expect, test, waitForClientHydration } from '../playwright-utils.ts'

test('onboarding polls one shared query across steps and pauses while hidden', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `onboarding-query-${id}@example.com`,
		username: `onboarding-query-${id}`,
	})
	await login({ ...user, mode: 'login' })
	// Install before Query mounts so the poll interval uses the controlled clock.
	await page.clock.install()
	await page.goto('/onboarding/step-1')
	await waitForClientHydration(page)
	await page.waitForLoadState('networkidle')
	const chooserCards = page
		.getByRole('list', {
			name: 'Choose the agent you want to connect first. You can add others later.',
		})
		.getByRole('link')
	await expect.poll(() => chooserCards.count()).toBeGreaterThan(1)
	const chooserOrder = await chooserCards.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute('href')),
	)
	const reads: Array<string> = []
	page.on('request', (request) => {
		if (request.url().includes('/_serverFn/')) reads.push(request.url())
	})
	await page.clock.runFor(4100)
	await expect.poll(() => reads.length).toBe(1)
	await page.waitForLoadState('networkidle')
	const progressUrl = reads[0]
	const steps = page.getByRole('navigation', { name: 'Onboarding steps' })
	for (const step of [2, 3, 1]) {
		const destination = steps.getByTestId(`onboarding-step-${step}`)
		await destination.click()
		await expect(page).toHaveURL(new RegExp(`/onboarding/step-${step}$`))
		await expect(destination).toHaveAttribute('aria-current', 'step')
		// The shared navigation survives transitions. Wait for the destination's
		// actual panel, rather than accepting a URL update before React commits.
		await expect(page.locator(`section#onboarding-step-${step}`)).toBeVisible()
	}
	await expect(chooserCards).toHaveCount(chooserOrder.length)
	expect(reads.filter((url) => url === progressUrl)).toHaveLength(1)
	expect(
		await chooserCards.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute('href')),
		),
	).toEqual(chooserOrder)
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		})
		Object.defineProperty(document, 'hidden', {
			configurable: true,
			get: () => true,
		})
		document.dispatchEvent(new Event('visibilitychange'))
	})
	await page.clock.runFor(12_000)
	expect(reads.filter((url) => url === progressUrl)).toHaveLength(1)
})

test('onboarding preserves the server-rendered agent order through hydration', async ({
	page,
}) => {
	let hydrationHeld = false
	let release!: () => void
	const scripts = new Promise<void>((resolve) => {
		release = resolve
	})
	await page.route('**/*', async (route) => {
		// Leave head scripts free to run so the HTML parser can reach the body.
		if (new URL(route.request().url()).pathname.endsWith('/start/client.tsx')) {
			hydrationHeld = true
			await scripts
		}
		await route.continue()
	})
	try {
		await page.goto('/onboarding/step-1', { waitUntil: 'commit' })
		const cards = page
			.getByRole('list', {
				name: 'Choose the agent you want to connect first. You can add others later.',
			})
			.getByRole('link')
		await expect.poll(() => cards.count()).toBeGreaterThan(1)
		await expect.poll(() => hydrationHeld).toBe(true)
		const serverOrder = await cards.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute('href')),
		)
		release()
		await waitForClientHydration(page)
		await page.waitForLoadState('networkidle')
		expect(
			await cards.evaluateAll((nodes) =>
				nodes.map((node) => node.getAttribute('href')),
			),
		).toEqual(serverOrder)
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
})

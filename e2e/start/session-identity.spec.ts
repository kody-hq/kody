import { randomUUID } from 'node:crypto'
import {
	expect,
	test,
	waitForClientHydration,
	type Page,
} from '../playwright-utils.ts'

async function switchUser(
	page: Page,
	user: { email: string; password: string },
) {
	const other = await page.context().newPage()
	try {
		await other.goto('/account')
		await waitForClientHydration(other)
		await other.getByTestId('account-menu').click()
		await other
			.getByTestId('org-switcher-logout')
			.filter({ visible: true })
			.click()
		await expect(other).not.toHaveURL(/\/account$/)
		const response = await other.request.post('/auth', {
			data: { email: user.email, password: user.password, mode: 'login' },
		})
		expect(response.ok(), await response.text()).toBe(true)
	} finally {
		await other.close()
	}
}

async function watchForOldProfile(page: Page, oldUsername: string) {
	// Record even a transient stale profile, including across a document reset.
	// A final toHaveValue assertion alone can miss an incorrect first frame.
	function watch(username: string) {
		const check = () => {
			const field = document.querySelector('[data-testid="account-username"]')
			if (field?.textContent?.trim().endsWith(`/@${username}`))
				sessionStorage.setItem('old-profile-rendered', 'true')
		}
		new MutationObserver(check).observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
		})
		const frame = () => {
			check()
			requestAnimationFrame(frame)
		}
		requestAnimationFrame(frame)
	}
	await page.addInitScript(watch, oldUsername)
	await page.evaluate(watch, oldUsername)
}

for (const delayOldShell of [false, true]) {
	test(`an identity switch never renders another user's preloaded profile${delayOldShell ? ' after an older session response' : ''}`, async ({
		page,
		seedE2eUser,
		login,
	}) => {
		const browserErrors: string[] = []
		page.on('pageerror', (error) => browserErrors.push(error.message))
		page.on('console', (message) => {
			if (message.type() === 'error') browserErrors.push(message.text())
		})
		const id = randomUUID().slice(0, 8)
		const first = await seedE2eUser({
			email: `identity-a-${id}@example.com`,
			username: `identity-a-${id}`,
		})
		const second = await seedE2eUser({
			email: `identity-b-${id}@example.com`,
			username: `identity-b-${id}`,
		})
		await login({ ...first, mode: 'login' })
		await page.goto('/account/jobs')
		await waitForClientHydration(page)
		await page.getByTestId('account-menu').click()
		const account = page
			.locator('a[href="/account"]')
			.filter({ visible: true })
			.first()
		const preload = page.waitForResponse(
			async (response) =>
				response.url().includes('/_serverFn/') &&
				(await response.text()).includes(first.username) &&
				(await response.text()).includes('accountProfile'),
		)
		await account.hover()
		await preload
		await page.evaluate(() => {
			document.documentElement.dataset.identityDocument = 'original'
		})
		let release!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		let captured!: () => void
		const oldRead = new Promise<void>((resolve) => {
			captured = resolve
		})
		const firstActor: string = JSON.parse(
			(await page
				.locator('meta[name="kody-document-actor"]')
				.getAttribute('content'))!,
		)
		let hold = delayOldShell
		if (delayOldShell) {
			await page.route('**/_serverFn/**', async (route) => {
				const response = await route.fetch()
				const body = await response.text()
				if (
					hold &&
					body.includes('actorKey') &&
					!body.includes('siteBanner') &&
					body.includes(firstActor)
				) {
					hold = false
					captured()
					await barrier
				}
				await route.fulfill({ response })
			})
			await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
			await oldRead
		}
		try {
			await switchUser(page, second)
			await watchForOldProfile(page, first.username)
			// Do not depend on the activation debounce running before navigation.
			await account.evaluate((anchor: HTMLAnchorElement) => anchor.click())
			await expect(page.getByTestId('account-username')).toContainText(
				second.username,
			)
			await expect(page.locator('html')).not.toHaveAttribute(
				'data-identity-document',
				'original',
			)
			release()
			// Keep interception stable until new-document module imports finish.
			// Disabling CDP Fetch mid-import can strand an unrelated script request.
			await waitForClientHydration(page)
			await page.unrouteAll({ behavior: 'wait' })
			await page.waitForLoadState('networkidle')
			expect(browserErrors).toEqual([])
			expect(
				await page.evaluate(() =>
					sessionStorage.getItem('old-profile-rendered'),
				),
			).toBeNull()
			await expect(page.getByTestId('account-username')).toContainText(
				second.username,
			)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'wait' })
		}
	})
}

test('a preload made under another cookie identity cannot poison the original document cache', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const first = await seedE2eUser({
		email: `preload-a-${id}@example.com`,
		username: `preload-a-${id}`,
	})
	const second = await seedE2eUser({
		email: `preload-b-${id}@example.com`,
		username: `preload-b-${id}`,
	})
	await login({ ...first, mode: 'login' })
	await page.goto('/account/jobs')
	await waitForClientHydration(page)
	await page.mouse.move(0, 0)
	await switchUser(page, second)
	await watchForOldProfile(page, second.username)
	await page.getByTestId('account-menu').click()
	const account = page
		.locator('a[href="/account"]')
		.filter({ visible: true })
		.first()
	let releaseRedirect!: () => void
	const redirectHeld = new Promise<void>((resolve) => {
		releaseRedirect = resolve
	})
	let sawRejectedPreload!: (headers: Record<string, string>) => void
	const rejectedPreload = new Promise<Record<string, string>>((resolve) => {
		sawRejectedPreload = resolve
	})
	await page.route('**/_serverFn/**', async (route) => {
		const response = await route.fetch()
		const body = await response.text()
		if (body.includes('reloadDocument')) {
			sawRejectedPreload(response.headers())
			await redirectHeld
		}
		await route.fulfill({ response, body })
	})
	try {
		await account.hover()
		const headers = await rejectedPreload
		expect(headers['cache-control']).toContain('no-store')
		// Return to A before the rejected B preload reaches the browser. Query's
		// redirect integration resets the document when that response arrives.
		await switchUser(page, first)
		const reset = page.waitForEvent('load')
		releaseRedirect()
		await reset
		await waitForClientHydration(page)
	} finally {
		releaseRedirect()
		await page.unrouteAll({ behavior: 'wait' })
	}
	await page.getByTestId('account-menu').click()
	await page
		.locator('a[href="/account"]')
		.filter({ visible: true })
		.first()
		.click()

	await expect(page.getByTestId('account-username')).toContainText(
		first.username,
	)
	await waitForClientHydration(page)
	expect(
		await page.evaluate(() => sessionStorage.getItem('old-profile-rendered')),
	).toBeNull()
})

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

test('switching identity clears private drafts, while same-user activation preserves them', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const first = await seedE2eUser({
		email: `draft-a-${id}@example.com`,
		username: `draft-a-${id}`,
	})
	const second = await seedE2eUser({
		email: `draft-b-${id}@example.com`,
		username: `draft-b-${id}`,
	})
	await login({ ...first, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	const draft = `Private unsaved draft ${id}`
	await page.getByLabel('Display name', { exact: true }).fill(draft)
	await page.evaluate(() => {
		document.documentElement.dataset.identityDocument = 'original'
	})
	await page.clock.install()
	await page.clock.fastForward(61_000)
	const refreshed = page.waitForResponse(
		async (response) =>
			response.url().includes('/_serverFn/') &&
			(await response.text()).includes('accountProfile'),
	)
	await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
	await refreshed
	await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
		draft,
	)
	await expect(page.locator('html')).toHaveAttribute(
		'data-identity-document',
		'original',
	)
	await switchUser(page, second)
	await page.evaluate(() => {
		window.dispatchEvent(new FocusEvent('focus'))
		window.dispatchEvent(new Event('online'))
	})
	await expect(page.getByTestId('account-username')).toContainText(
		second.username,
	)
	await expect(
		page.getByLabel('Display name', { exact: true }),
	).not.toHaveValue(draft)
	await expect(page.locator('html')).not.toHaveAttribute(
		'data-identity-document',
		'original',
	)
})

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

test('the explicit Start entry preserves cross-site RPC rejection', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const user = await seedE2eUser({
		email: `csrf-${id}@example.com`,
		username: `csrf-${id}`,
	})
	await login({ ...user, mode: 'login' })
	await page.goto('/account')
	await waitForClientHydration(page)
	await page.clock.install()
	await page.clock.fastForward(61_000)
	const observed = page.waitForResponse(
		async (response) =>
			response.url().includes('/_serverFn/') &&
			response.ok() &&
			(await response.text()).includes(user.username),
	)
	await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
	const rpc = await observed
	const rejected = await page.request.get(rpc.url(), {
		headers: {
			'x-tsr-serverfn': 'true',
			Origin: 'https://external.example',
			'Sec-Fetch-Site': 'cross-site',
		},
	})
	expect(rejected.status()).toBe(403)
	expect(await rejected.text()).not.toContain(user.username)
	const accepted = await page.request.get(rpc.url(), {
		headers: {
			'x-tsr-serverfn': 'true',
			Origin: new URL(page.url()).origin,
			'Sec-Fetch-Site': 'same-origin',
		},
	})
	expect(accepted.status()).toBe(200)
	expect(await accepted.text()).toContain(user.username)
	expect(accepted.headers()['cache-control']).toContain('no-store')
})

test('an identity switch cannot reuse a cached admin-only guide', async ({
	page,
	seedE2eUser,
	login,
}) => {
	const id = randomUUID().slice(0, 8)
	const admin = await seedE2eUser({
		email: `doc-admin-${id}@example.com`,
		username: `doc-admin-${id}`,
		admin: true,
	})
	const member = await seedE2eUser({
		email: `doc-member-${id}@example.com`,
		username: `doc-member-${id}`,
	})
	await login({ ...admin, mode: 'login' })
	await page.goto('/docs/admin-events')
	await waitForClientHydration(page)
	await expect(
		page.getByRole('heading', { name: 'Admin events', exact: true }),
	).toBeVisible()
	await page.locator('a[href="/support"]').first().click()
	await expect(page).toHaveURL(/\/support$/)
	await expect(
		page.getByRole('heading', { name: 'Admin events', exact: true }),
	).toHaveCount(0)
	await switchUser(page, member)
	const watch = () => {
		const check = () => {
			if (
				[...document.querySelectorAll('h1')].some(
					(heading) => heading.textContent === 'Admin events',
				)
			)
				sessionStorage.setItem('stale-admin-guide', 'visible')
		}
		new MutationObserver(check).observe(document, {
			childList: true,
			subtree: true,
		})
	}
	await page.addInitScript(watch)
	await page.evaluate(watch)
	await page.evaluate(() => {
		document.documentElement.dataset.originalAdminDocument = 'true'
	})
	await page.goBack()
	await expect(page.getByTestId('not-found-page')).toBeVisible()
	await waitForClientHydration(page)
	await expect(page.locator('html')).not.toHaveAttribute(
		'data-original-admin-document',
		'true',
	)
	expect(
		await page.evaluate(() => sessionStorage.getItem('stale-admin-guide')),
	).toBeNull()
})

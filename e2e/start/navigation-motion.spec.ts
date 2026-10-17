import { expect, test, waitForClientHydration } from '../playwright-utils.ts'
import {
	observeMainTransitions,
	readMainTransitions,
	expectSingleCommitTransition,
} from '../main-transitions.ts'

test('page navigation preserves selective motion and suppresses repeated homepage entrance', async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' })
	await page.addInitScript(() => {
		const transitions: Array<{ href: string; finished: Promise<void> }> = []
		Object.assign(window, {
			motionAnimations: [] as Array<string>,
			motionTransitions: transitions,
		})
		if (document.startViewTransition) {
			const original = document.startViewTransition.bind(document)
			document.startViewTransition = (...args) => {
				const transition = original(...args)
				transitions.push({
					href: location.pathname,
					finished: transition.finished.then(
						() => {},
						() => {},
					),
				})
				return transition
			}
		}
		document.addEventListener('animationstart', (event) => {
			;(
				window as unknown as { motionAnimations: Array<string> }
			).motionAnimations.push(event.animationName)
		})
	})
	await page.goto('/')
	await waitForClientHydration(page)
	await expect(page.locator('html')).not.toHaveAttribute('data-spa-nav')
	const timeOrigin = await page.evaluate(() => performance.timeOrigin)
	const supported = await page.evaluate(
		() => typeof document.startViewTransition === 'function',
	)
	await page.locator('a[href="/pricing"]').first().click()
	await expect(page).toHaveURL(/\/pricing$/)
	await expect(page.locator('html')).toHaveAttribute('data-spa-nav', '')
	if (supported)
		await expect
			.poll(() =>
				page.evaluate(() =>
					(
						window as unknown as { motionAnimations: Array<string> }
					).motionAnimations.includes('vt-page-in'),
				),
			)
			.toBe(true)
	await page.locator('a[href="/"]').first().click()
	await expect(page).toHaveURL(/\/$/)
	await expect(page.locator('[data-rise]').first()).toHaveCSS(
		'animation-name',
		'none',
	)
	expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
	await page.locator('a[href="/docs"]').first().click()
	await expect(page).toHaveURL(/\/docs$/)
	await expect(page.locator('[data-docs-nav]')).toBeVisible()
	// Await every recorded transition, including one whose start raced an
	// earlier URL assertion, and drain its queued animation events before reset.
	await page.evaluate(async () => {
		const transitions = (
			window as unknown as {
				motionTransitions: Array<{ finished: Promise<void> }>
			}
		).motionTransitions
		await Promise.all(transitions.map((transition) => transition.finished))
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		)
	})
	const transitionsBeforeGuide = await page.evaluate(
		() =>
			(window as unknown as { motionTransitions: Array<unknown> })
				.motionTransitions.length,
	)
	await page.evaluate(() => {
		;(
			window as unknown as { motionAnimations: Array<string> }
		).motionAnimations = []
	})
	const beforeHeading = await page.locator('main h1').textContent()
	await observeMainTransitions(page)
	const guideHref = '/docs/search-and-execute'
	const guide = page.locator(`main a[href="${guideHref}"]`).first()
	await guide.click()
	await expect.poll(() => new URL(page.url()).pathname).toBe(guideHref)
	await expect(page.locator('main h1')).toHaveText('Search and execute')
	const afterHeading = await page.locator('main h1').textContent()
	const guideTransitions = await page.evaluate(
		(before) =>
			(
				window as unknown as { motionTransitions: Array<{ href: string }> }
			).motionTransitions
				.slice(before)
				.map((transition) => transition.href),
		transitionsBeforeGuide,
	)
	expect(
		guideTransitions,
		'docs navigation must not start a new view transition',
	).toEqual([])
	expectSingleCommitTransition(await readMainTransitions(page), {
		fromHeading: beforeHeading!,
		toHeading: afterHeading!,
	})
	expect(
		await page.evaluate(() =>
			(
				window as unknown as { motionAnimations: Array<string> }
			).motionAnimations.filter((name) => name.startsWith('vt-page')),
		),
	).toEqual([])
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.locator('a[href="/pricing"]').first().click()
	await expect(page).toHaveURL(/\/pricing$/)
	await page.waitForLoadState('networkidle')
	expect(
		await page.evaluate(() =>
			(
				window as unknown as { motionAnimations: Array<string> }
			).motionAnimations.filter((name) => name.startsWith('vt-page')),
		),
	).toEqual([])
})

test('a browser transition API failure cannot strand a ready page navigation', async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' })
	await page.goto('/')
	await waitForClientHydration(page)
	await page.evaluate(() => {
		document.startViewTransition = (() => {
			throw new DOMException('Simulated busy transition', 'InvalidStateError')
		}) as typeof document.startViewTransition
	})
	await page.locator('a[href="/pricing"]').first().click()
	await expect(page).toHaveURL(/\/pricing$/)
	await expect(page.locator('main')).toContainText('Worker compute')
})

test('a superseded slow page cannot replace the later navigation or blank main', async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' })
	await page.goto('/')
	await waitForClientHydration(page)
	const fromHeading = await page.locator('main h1').textContent()
	await observeMainTransitions(page)
	let release!: () => void
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let started!: () => void
	const firstRequest = new Promise<void>((resolve) => {
		started = resolve
	})
	let held = false
	await page.route('**/_serverFn/**', async (route) => {
		if (!held) {
			held = true
			started()
			await gate
		}
		await route.continue()
	})
	try {
		await page.locator('a[href="/docs"]').first().click()
		await firstRequest
		await page.locator('a[href="/pricing"]').first().click()
		await expect(page).toHaveURL(/\/pricing$/)
		await expect(page.locator('main')).toContainText('Worker compute')
		release()
		await page.waitForLoadState('networkidle')
		await expect(page).toHaveURL(/\/pricing$/)
		expectSingleCommitTransition(await readMainTransitions(page), {
			fromHeading: fromHeading!,
			toHeading: (await page.locator('main h1').textContent())!,
		})
	} finally {
		release()
		await page.unrouteAll({ behavior: 'wait' })
	}
})

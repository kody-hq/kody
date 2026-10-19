import { expect, test, type Page } from '../playwright-utils.ts'

/**
 * Emotion SSR emits <style data-emotion="css …"> as Insertion siblings in the
 * body. Client Insertion returns null, so those nodes are not in the hydrate
 * tree. Emotion's createCache also hoists them to <head>, but only after the
 * Emotion module evaluates — a race that produced KODY-9W
 * ("Hydration mismatch." / expected <div> but found STYLE) on /account and
 * /oauth/authorize.
 *
 * Coverage is two paths:
 * 1. Early `/emotion-style-hoist.js` relocates styles before hydration.
 * 2. When that hoist cannot see the styles, Redact's cursor still skips them.
 */

const accountAndOauthPaths = [
	'/account',
	'/oauth/authorize?response_type=code&client_id=test&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&code_challenge=xyz&code_challenge_method=S256&state=abc&scope=openid',
] as const

function collectHydrationErrors(page: Page) {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('console', (message) => {
		if (
			message.type() === 'error' &&
			/hydration|React client error|didn't match/i.test(message.text())
		)
			errors.push(message.text())
	})
	return errors
}

async function expectHydratedWithoutMismatch(
	page: Page,
	path: string,
	errors: string[],
) {
	errors.length = 0
	await page.goto(path)
	await expect(page.locator('html[data-hydrated="true"]')).toBeVisible({
		timeout: 30_000,
	})
	await expect(page.locator('h1')).toBeVisible()
	expect(errors, `hydration errors on ${path}`).toEqual([])
}

test('early Emotion style hoist moves SSR styles to head before hydration', async ({
	page,
	login,
	seedE2eUser,
}) => {
	test.setTimeout(90_000)
	const errors = collectHydrationErrors(page)
	// Allow `/emotion-style-hoist.js` (classic script; document.currentScript
	// is set) to find SSR styles, but hide them from Emotion createCache and
	// any other caller so head placement cannot be credited to Emotion's own
	// hoist.
	await page.addInitScript(() => {
		const original = Document.prototype.querySelectorAll
		Document.prototype.querySelectorAll = function (
			this: Document,
			selectors: string,
		) {
			if (typeof selectors === 'string' && selectors.includes('data-emotion')) {
				const current = document.currentScript
				const fromEarlyHoist =
					current instanceof HTMLScriptElement &&
					current.src.includes('emotion-style-hoist')
				if (!fromEarlyHoist) return [] as unknown as NodeListOf<Element>
			}
			return original.call(this, selectors)
		}
	})

	const user = await seedE2eUser()
	await login({ ...user, mode: 'login' })

	for (const path of accountAndOauthPaths) {
		await expectHydratedWithoutMismatch(page, path, errors)
		const placement = await page.evaluate(() => {
			const hashed = (el: Element) =>
				(el.getAttribute('data-emotion') ?? '').includes(' ')
			return {
				headMarked: [
					...document.head.querySelectorAll('style[data-emotion][data-s]'),
				].filter(hashed).length,
				bodyUnmarkedHashed: [
					...document.body.querySelectorAll(
						'style[data-emotion]:not([data-s])',
					),
				].filter(hashed).length,
			}
		})
		expect(
			placement.headMarked,
			`early hoist should mark hashed Emotion SSR styles in head on ${path}`,
		).toBeGreaterThan(0)
		expect(
			placement.bodyUnmarkedHashed,
			`no unmarked hashed Emotion SSR styles should remain in body on ${path}`,
		).toBe(0)
	}
})

test('hydrates account and oauth authorize when Emotion cannot hoist SSR styles first', async ({
	page,
	login,
	seedE2eUser,
}) => {
	test.setTimeout(90_000)
	const errors = collectHydrationErrors(page)
	// Block Emotion createCache (and the early body hoist) from moving SSR
	// style tags. Redact must skip those foreign nodes during adoption.
	await page.addInitScript(() => {
		const original = Document.prototype.querySelectorAll
		Document.prototype.querySelectorAll = function (
			this: Document,
			selectors: string,
		) {
			if (typeof selectors === 'string' && selectors.includes('data-emotion'))
				return [] as unknown as NodeListOf<Element>
			return original.call(this, selectors)
		}
	})

	const user = await seedE2eUser()
	await login({ ...user, mode: 'login' })

	for (const path of accountAndOauthPaths) {
		await expectHydratedWithoutMismatch(page, path, errors)
	}
})

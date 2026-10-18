import { expect, test } from '../playwright-utils.ts'

/**
 * Emotion SSR emits <style data-emotion="css …"> as Insertion siblings in the
 * body. Client Insertion returns null, so those nodes are not in the hydrate
 * tree. Emotion's createCache also hoists them to <head>, but only after the
 * Emotion module evaluates — a race that produced KODY-9W
 * ("Hydration mismatch." / expected <div> but found STYLE) on /account and
 * /oauth/authorize.
 *
 * This fixture blocks Emotion's own hoist so the Redact cursor + early body
 * hoist must keep hydration clean on their own.
 */
test('hydrates account and oauth authorize when Emotion cannot hoist SSR styles first', async ({
	page,
	login,
	seedE2eUser,
}) => {
	test.setTimeout(90_000)
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('console', (message) => {
		if (
			message.type() === 'error' &&
			/hydration|React client error|didn't match/i.test(message.text())
		)
			errors.push(message.text())
	})
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

	for (const path of [
		'/account',
		'/oauth/authorize?response_type=code&client_id=test&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&code_challenge=xyz&code_challenge_method=S256&state=abc&scope=openid',
	]) {
		errors.length = 0
		await page.goto(path)
		await expect(page.locator('html[data-hydrated="true"]')).toBeVisible({
			timeout: 30_000,
		})
		await expect(page.locator('h1')).toBeVisible()
		expect(errors, `hydration errors on ${path}`).toEqual([])
	}
})

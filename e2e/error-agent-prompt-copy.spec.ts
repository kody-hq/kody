import { expect, test, type Page } from './playwright-utils.ts'
import { renderInternalServerErrorPage } from '../packages/worker/src/app/internal-error-page.ts'

// The static 500 only renders when the app shell itself throws, so the spec
// serves that exact document on a same-origin path while the real server
// still answers `/error-agent-prompt-copy.js` and `/styles.css`.
const errorPath = '/e2e-static-error/agent-prompt?tab=usage'

async function openStaticErrorPage(page: Page) {
	const body = await renderInternalServerErrorPage(errorPath).text()
	await page.route('**/e2e-static-error/**', (route) =>
		route.fulfill({
			status: 500,
			contentType: 'text/html; charset=utf-8',
			body,
		}),
	)
	await page.goto(errorPath)
	await page.getByText('Copy prompt for your agent', { exact: true }).click()
}

async function renderedPromptText(page: Page) {
	return page
		.locator('[data-error-agent-prompt-text]')
		.evaluate((node) => node.textContent ?? '')
}

async function replacePromptWithSentinel(page: Page) {
	const sentinel = `copy-oracle-${crypto.randomUUID()}`
	await page
		.locator('[data-error-agent-prompt-text]')
		.evaluate((node, text) => {
			node.textContent = text
		}, sentinel)
	return sentinel
}

test('static error page Copy prompt copies the pre text, not a baked-in string', async ({
	page,
}) => {
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
	await openStaticErrorPage(page)

	const prompt = await renderedPromptText(page)
	expect(prompt).toContain(`Path: ${errorPath}`)
	expect(prompt).toContain('Error code: internal_error')
	expect(prompt).toContain('illustrated internal error')
	expect(prompt).toContain('runList')
	expect(prompt).toContain('guide:sentry_issues')

	const sentinel = await replacePromptWithSentinel(page)
	await page.getByRole('button', { name: 'Copy prompt', exact: true }).click()

	await expect(page.locator('[data-error-agent-prompt-copy]')).toHaveAttribute(
		'data-state',
		'copied',
	)
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		sentinel,
	)
	await expect(
		page.getByRole('button', { name: 'Copy prompt', exact: true }),
	).toBeVisible({ timeout: 5_000 })
})

test('static error page Copy prompt reports failure instead of Copied', async ({
	page,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: () => Promise.reject(new Error('denied')) },
		})
		document.execCommand = () => false
	})
	await openStaticErrorPage(page)

	const sentinel = await replacePromptWithSentinel(page)
	await page.getByRole('button', { name: 'Copy prompt', exact: true }).click()

	await expect(page.locator('[data-error-agent-prompt-copy]')).toHaveAttribute(
		'data-state',
		'error',
	)
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
		sentinel,
	)
})

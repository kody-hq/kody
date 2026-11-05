import { expect, test, type Page } from './playwright-utils.ts'
import { renderInternalServerErrorPage } from '../packages/worker/src/app/internal-error-page.ts'
import { buildInternalErrorAgentPrompt } from '../packages/worker/universal/error-agent-prompt-presets.ts'

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

test('static error page Copy prompt copies the full rendered prompt', async ({
	page,
}) => {
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
	await openStaticErrorPage(page)

	const prompt = buildInternalErrorAgentPrompt({ path: errorPath })
	await expect(page.locator('[data-error-agent-prompt-text]')).toHaveText(
		prompt,
	)
	await page.getByRole('button', { name: 'Copy prompt', exact: true }).click()

	await expect(
		page.getByRole('button', { name: 'Copied', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('status')).toHaveText(
		'Copied prompt to clipboard',
	)
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt)
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

	await page.getByRole('button', { name: 'Copy prompt', exact: true }).click()

	await expect(
		page.getByRole('button', { name: 'Copy failed', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('status')).toHaveText(
		'Copy failed. The prompt is selected so you can copy it manually.',
	)
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
		buildInternalErrorAgentPrompt({ path: errorPath }),
	)
})

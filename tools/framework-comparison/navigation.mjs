#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const [origin, output, executablePath] = process.argv.slice(2)
if (!origin || !output)
	throw new Error('Usage: node navigation.mjs ORIGIN OUTPUT_JSON [CHROME_PATH]')
const browser = await chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const results = []
try {
	for (const path of ['/pricing', '/docs']) {
		await page.goto(origin, { waitUntil: 'networkidle' })
		const link = page.locator(`a[href="${path}"]`).first()
		if ((await link.count()) === 0) {
			results.push({ path, error: 'No source link available' })
			continue
		}
		const before = await page.evaluate(() => performance.timeOrigin)
		const requests = []
		const listener = (request) =>
			requests.push({ url: request.url(), type: request.resourceType() })
		page.on('request', listener)
		const started = performance.now()
		await link.click()
		await page.waitForURL((url) => url.pathname === path)
		await page.waitForLoadState('networkidle')
		await page.locator('main').waitFor()
		const elapsedMs = performance.now() - started
		const after = await page.evaluate(() => performance.timeOrigin)
		page.off('request', listener)
		results.push({
			path,
			elapsedMs,
			fullDocumentReload: before !== after,
			heading: await page.locator('h1').allTextContents(),
			requests,
		})
	}
} finally {
	await browser.close()
}
writeFileSync(
	output,
	JSON.stringify(
		{
			origin,
			measuredAt: new Date().toISOString(),
			results,
			errors,
			caveats: [
				'Observational navigation smoke test, not a Lighthouse score.',
				'Timing includes Playwright click actionability and 500ms network idle.',
				'No authenticated freshness behavior is tested by this script.',
			],
		},
		null,
		2,
	) + '\n',
)

#!/usr/bin/env node
import { chromium } from '@playwright/test'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { createHash } from 'node:crypto'
const [
	origin,
	improvedAssetsArg,
	outputArg,
	destination = '/account/memories',
	mode = 'missing-assets',
] = process.argv.slice(2)
if (!origin || !improvedAssetsArg || !outputArg)
	throw new Error(
		'Usage: node old-asset-probe.mjs FROZEN_LOCAL_ORIGIN IMPROVED_CLIENT_DIRECTORY NEW_OUTPUT_DIRECTORY [DESTINATION]',
	)
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
	throw new Error('Only local origins are allowed')
const assets = resolve(improvedAssetsArg)
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
const inventory = readdirSync(join(assets, 'assets'))
	.filter((name) => name.endsWith('.js'))
	.sort()
const result = {
	origin,
	destination,
	mode,
	inventorySha256: createHash('sha256')
		.update(inventory.join('\n'))
		.digest('hex'),
	inventory,
	missingRequests: [],
	errors: [],
	caveat:
		'Controlled old-document/new-asset-inventory mismatch, not an actual Cloudflare deployment. Existing assets are served by the frozen origin; only filenames absent from improved output receive404. No automatic reload is injected.',
}
const browser = await chromium.launch({
	executablePath:
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
try {
	const context = await browser.newContext({
		viewport: { width: 1350, height: 940 },
	})
	const credentials = process.env.SESSION_AUTH_FILE
		? JSON.parse(readFileSync(process.env.SESSION_AUTH_FILE, 'utf8'))[origin]
		: { email: 'jane@example.com', password: 'ilikecode' }
	const login = await context.request.post(origin + '/auth', {
		data: { ...credentials, mode: 'login' },
	})
	if (!login.ok()) throw new Error(`Seed login returned ${login.status()}`)
	const page = await context.newPage()
	page.on('pageerror', (error) => result.errors.push(error.message))
	await page.goto(origin + '/account', { waitUntil: 'networkidle' })
	const field = page.getByLabel('Display name', { exact: true })
	await field.waitFor()
	const draft = 'Unsaved old-asset probe draft'
	await field.fill(draft)
	const before = await page.evaluate(() => performance.timeOrigin)
	await page.route('**/assets/*.js', async (route) => {
		const url = new URL(route.request().url())
		const path = resolve(assets, '.' + decodeURIComponent(url.pathname))
		if (
			mode !== 'control' &&
			url.origin === origin &&
			path.startsWith(assets + sep) &&
			!existsSync(path)
		) {
			result.missingRequests.push(url.pathname)
			await route.fulfill({
				status: 404,
				contentType: 'text/plain',
				body: 'Asset not present in improved production inventory',
			})
		} else await route.continue()
	})
	await page
		.locator(`a[href="${destination}"]`)
		.filter({ visible: true })
		.first()
		.click()
	await new Promise((done) => setTimeout(done, 5000))
	result.after = await page.evaluate(() => ({
		path: location.pathname,
		timeOrigin: performance.timeOrigin,
		heading: document.querySelector('main h1')?.textContent,
		title: document.title,
		alertText: [...document.querySelectorAll('[role=alert]')].map(
			(node) => node.textContent,
		),
	}))
	result.fullDocumentReload = result.after.timeOrigin !== before
	result.draftRetained =
		(await field.count()) > 0 && (await field.inputValue()) === draft
	result.exercisedMissingAsset = result.missingRequests.length > 0
	await page.goBack({ waitUntil: 'domcontentloaded' })
	await page.waitForTimeout(1500)
	result.afterBack = {
		path: new URL(page.url()).pathname,
		draftRetained:
			(await field.count()) > 0 && (await field.inputValue()) === draft,
	}
	result.conclusion =
		mode === 'control'
			? 'Normal navigation and back control, no asset responses changed'
			: !result.exercisedMissingAsset
				? 'Inconclusive: no missing asset request exercised'
				: result.fullDocumentReload
					? 'Full document reload observed'
					: result.draftRetained
						? 'Old form and draft retained after missing asset request'
						: 'Draft no longer present, inspect heading and error evidence'
} catch (error) {
	result.failure = error.message
} finally {
	await browser.close()
	writeFileSync(
		join(output, 'result.json'),
		JSON.stringify(result, null, 2) + '\n',
	)
}
console.log(
	JSON.stringify({
		exercisedMissingAsset: result.exercisedMissingAsset,
		missingRequests: result.missingRequests.length,
		fullDocumentReload: result.fullDocumentReload,
		draftRetained: result.draftRetained,
		failure: result.failure ?? null,
	}),
)
process.exitCode = result.failure ? 1 : 0

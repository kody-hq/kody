#!/usr/bin/env node
import { chromium, expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [configFile, outputArg] = process.argv.slice(2)
if (!configFile || !outputArg)
	throw new Error('Usage: freshness.mjs CONFIG NEW_OUTPUT_DIRECTORY')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
for (const target of config.targets)
	if (!['127.0.0.1', 'localhost'].includes(new URL(target.origin).hostname))
		throw new Error('Disposable local origins only')
mkdirSync(output, { recursive: true })
const report = {
	config,
	runs: [],
	caveats: [
		'Controlled held writes and injected failures test correctness. They are not latency benchmarks.',
		'Uses only seeded Jane accounts. Original display names are restored through each revision’s own profile UI.',
		'No retired profile JSON endpoint is required by the harness.',
	],
}
const save = () =>
	writeFileSync(
		join(output, 'runs.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
const browser = await chromium.launch({
	executablePath:
		config.chromePath ??
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const field = (page) => page.getByLabel('Display name', { exact: true })
const button = (page) =>
	page.getByRole('button', { name: 'Save profile', exact: true })
const clickSave = async (page, value) => {
	await field(page).fill(value)
	if (await button(page).isDisabled()) return
	const response = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST' &&
			response.request().postData()?.includes('displayName'),
	)
	await button(page).click()
	if (!(await response).ok()) throw new Error('Profile save failed')
}
try {
	for (let round = 0; round < (config.rounds ?? 3); round++) {
		for (let offset = 0; offset < config.targets.length; offset++) {
			const target = config.targets[(round + offset) % config.targets.length]
			for (const outcome of ['accepted', 'rejected']) {
				const row = {
					label: target.label,
					round: round + 1,
					outcome,
					errors: [],
				}
				report.runs.push(row)
				const context = await browser.newContext()
				let release = () => {},
					original,
					editor
				try {
					const auth = await context.request.post(target.origin + '/auth', {
						data: {
							email: 'jane@example.com',
							password: 'ilikecode',
							mode: 'login',
						},
					})
					if (!auth.ok()) throw new Error(`Login ${auth.status()}`)
					const page = await context.newPage()
					page.on('pageerror', (error) => row.errors.push(error.message))
					await page.goto(target.origin + '/account', {
						waitUntil: 'networkidle',
					})
					await expect(field(page)).toBeVisible()
					original = await field(page).inputValue()
					const profileLink = page.getByRole('link', {
						name: 'View public profile',
						exact: true,
					})
					const profilePath = await profileLink.getAttribute('href')
					await profileLink.click()
					await page.waitForURL(
						(url) =>
							url.pathname === new URL(profilePath, target.origin).pathname,
					)
					await expect(field(page)).toHaveCount(0)
					await expect(page.locator('h1')).toBeVisible()
					await page.goBack()
					await page.waitForURL((url) => url.pathname === '/account')
					await expect(field(page)).toBeVisible()
					const token = `perf-${target.label}-${round}-${outcome}`
					let held
					const arrived = new Promise((resolve) => {
						held = resolve
					})
					const gate = new Promise((resolve) => {
						release = resolve
					})
					await context.route('**/*', async (route) => {
						const request = route.request()
						if (
							request.method() !== 'POST' ||
							!request.postData()?.includes(token)
						)
							return route.continue()
						held()
						await gate
						if (outcome === 'accepted') return route.continue()
						return route.fulfill({
							status: 500,
							contentType: 'application/json',
							body: JSON.stringify({ error: 'Controlled benchmark rejection' }),
						})
					})
					await field(page).fill(token)
					await button(page).click()
					await Promise.race([
						arrived,
						new Promise((_, reject) =>
							setTimeout(
								() => reject(new Error('Save request not intercepted')),
								10_000,
							),
						),
					])
					await page
						.getByRole('link', { name: 'View public profile', exact: true })
						.click()
					await page.waitForURL(
						(url) =>
							url.pathname === new URL(profilePath, target.origin).pathname,
					)
					await expect(field(page)).toHaveCount(0)
					await expect(page.locator('h1')).toBeVisible()
					row.optimisticBeforeResponse = (
						await page.locator('h1').textContent()
					).includes(token)
					release()
					try {
						if (outcome === 'accepted')
							await expect(page.locator('h1')).toContainText(token, {
								timeout: 5000,
							})
						else
							await expect(page.locator('h1')).not.toContainText(token, {
								timeout: 5000,
							})
						row.reconciledAfterUnmount = true
					} catch {
						row.reconciledAfterUnmount = false
					}
					await context.unrouteAll({ behavior: 'wait' })
					editor = await context.newPage()
					await editor.goto(target.origin + '/account', {
						waitUntil: 'networkidle',
					})
					await expect(field(editor)).toBeVisible()
					row.persistedCorrectly =
						(await field(editor).inputValue()) ===
						(outcome === 'accepted' ? token : original)
					if (!row.persistedCorrectly)
						throw new Error(
							'Authoritative profile state differs from write outcome',
						)
					row.profilePath = profilePath
				} catch (error) {
					row.failure = error.message
				} finally {
					release()
					await context.unrouteAll({ behavior: 'wait' })
					if (original !== undefined) {
						try {
							editor ??= await context.newPage()
							await editor.goto(target.origin + '/account', {
								waitUntil: 'networkidle',
							})
							await clickSave(editor, original)
							await editor.reload({ waitUntil: 'networkidle' })
							await expect(field(editor)).toHaveValue(original)
							row.restored = true
						} catch (error) {
							row.restorationFailure = error.message
						}
					}
					await context.close()
					save()
				}
			}
		}
	}
} finally {
	await browser.close()
}
process.exitCode = report.runs.some(
	(run) => run.failure || run.restorationFailure || !run.persistedCorrectly,
)
	? 1
	: 0

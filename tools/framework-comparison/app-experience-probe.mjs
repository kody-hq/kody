#!/usr/bin/env node
import { chromium, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

// Usage: node app-experience-probe.mjs CONFIG_JSON NEW_OUTPUT_DIRECTORY
// Config: { targets: [{label, origin}], rounds?: 3, holdMs?: 2000,
//           timeoutMs?: 15000, chromePath?: string, freshness?: true }
const [configPath, outputPath] = process.argv.slice(2)
if (!configPath || !outputPath)
	throw new Error('Config and new output directory required')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (!config.targets?.length) throw new Error('Targets required')
for (const target of config.targets) {
	const url = new URL(target.origin)
	if (
		!['localhost', '127.0.0.1'].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/'
	)
		throw new Error('Bare local origins only')
}
const output = resolve(outputPath)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
const report = {
	startedAt: new Date().toISOString(),
	harnessSha256: createHash('sha256')
		.update(readFileSync(new URL(import.meta.url)))
		.digest('hex'),
	config,
	caveats: [
		'Local production diagnostic with a deliberately held POST, not natural network latency.',
		'Feedback and navigation markers use frame-observed DOM visibility, not physical screen pixels.',
		'Before-release observations record behavior without requiring either implementation to be optimistic.',
		'Playwright routing disables HTTP cache. These controlled timings must not be presented as natural navigation latency.',
		'Authoritative response timing includes the artificial hold. Server persistence is checked separately.',
		'Freshness uses a browser clock only for correctness and contributes no timing result.',
		'Seeded local jane account only. Login cookies remain in memory. Recovery contains original profile fields, never credentials.',
	],
	runs: [],
}
const recovery = []
const save = () => {
	writeFileSync(
		join(output, 'results.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
	writeFileSync(
		join(output, 'recovery.json'),
		JSON.stringify(recovery, null, 2) + '\n',
		{ mode: 0o600 },
	)
}
const cookies = new Map()
const apiPath = '/account/profile.json'
const read = async (context, origin) => {
	const response = await context.request.get(origin + apiPath)
	if (!response.ok())
		throw new Error(`Profile read status ${response.status()}`)
	return response.json()
}
const write = async (context, origin, data) => {
	const response = await context.request.post(origin + apiPath, { data })
	if (!response.ok())
		throw new Error(`Profile write status ${response.status()}`)
	const persisted = await read(context, origin)
	if (Object.entries(data).some(([key, value]) => persisted[key] !== value))
		throw new Error('Profile write not persisted')
}
const navigate = async (page, name) => {
	// DOM activation avoids giving either implementation a pointer-hover head start.
	await page
		.getByRole('link', { name, exact: true })
		.evaluate((node) => node.click())
}
const accountReady = async (page) => {
	await page.getByLabel('Display name', { exact: true }).waitFor()
	await page.waitForFunction(
		() => document.documentElement.dataset.hydrated === 'true',
	)
	await page.waitForLoadState('networkidle')
}
save()
for (let round = 0; round < (config.rounds ?? 3); round++) {
	for (let offset = 0; offset < config.targets.length; offset++) {
		const target = config.targets[(round + offset) % config.targets.length]
		for (const outcome of ['accepted', 'rejected']) {
			const run = {
				label: target.label,
				round: round + 1,
				outcome,
				stage: 'setup',
				errors: [],
				requests: [],
			}
			report.runs.push(run)
			const browser = await chromium.launch({
				executablePath:
					config.chromePath ??
					'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			})
			let context,
				original,
				record,
				pendingResponse,
				postCaptured = false,
				release = () => {},
				handlerDone = Promise.resolve()
			try {
				context = await browser.newContext({
					viewport: { width: 1350, height: 940 },
				})
				context.setDefaultTimeout(config.timeoutMs ?? 15000)
				if (cookies.has(target.origin))
					await context.addCookies(cookies.get(target.origin))
				else {
					const auth = await context.request.post(target.origin + '/auth', {
						data: {
							email: 'jane@example.com',
							password: 'ilikecode',
							mode: 'login',
						},
					})
					if (!auth.ok())
						throw new Error(`Fixture login status ${auth.status()}`)
					cookies.set(target.origin, await context.cookies())
				}
				run.stage = 'read-original'
				const profile = await read(context, target.origin)
				original = { displayName: profile.displayName, bio: profile.bio }
				if (
					typeof original.displayName !== 'string' ||
					(original.bio !== null && typeof original.bio !== 'string')
				)
					throw new Error('Unexpected profile shape')
				record = {
					origin: target.origin,
					round: round + 1,
					outcome,
					original,
					restored: false,
				}
				recovery.push(record)
				save()
				const next = {
					displayName: `Probe ${outcome} ${round + 1}`,
					bio: `Local held profile write ${outcome} ${round + 1}`,
				}
				const page = await context.newPage()
				// Save only counts, never potentially sensitive error text or server bodies.
				page.on('pageerror', () => run.errors.push('browser-page-error'))
				run.stage = 'account-load'
				await page.goto(target.origin + '/account', {
					waitUntil: 'networkidle',
				})
				await accountReady(page)
				run.stage = 'public-profile-navigation'
				await navigate(page, 'View public profile')
				await expect(page.getByTestId('profile-display-name')).toHaveText(
					original.displayName,
				)
				await navigate(page, 'Edit profile')
				await accountReady(page)
				await page
					.getByLabel('Display name', { exact: true })
					.fill(next.displayName)
				await page
					.getByRole('textbox', { name: 'Bio', exact: true })
					.fill(next.bio)
				let captured
				const held = new Promise((done) => {
					captured = done
				})
				const barrier = new Promise((done) => {
					release = done
				})
				let finishHandler
				handlerDone = new Promise((done) => {
					finishHandler = done
				})
				await page.route('**/account/profile.json', async (route) => {
					if (route.request().method() !== 'POST') return route.continue()
					postCaptured = true
					captured()
					try {
						await barrier
						if (outcome === 'rejected')
							await route.fulfill({
								status: 500,
								contentType: 'application/json',
								body: JSON.stringify({
									error: 'Controlled failed profile save',
								}),
							})
						else await route.continue()
					} catch {
						run.errors.push('intercepted-save-disconnected')
					} finally {
						finishHandler()
					}
				})
				let active = true
				page.on('request', (request) => {
					if (active)
						run.requests.push({
							method: request.method(),
							path: new URL(request.url()).pathname,
						})
				})
				await page.evaluate(
					({ nextName, originalName }) => {
						const state = (window.__appProbe = {
							start: performance.now(),
							feedbackMs: null,
							optimisticProfileMs: null,
							originalProfileMs: null,
						})
						const visible = (element) =>
							element &&
							element.getBoundingClientRect().width > 0 &&
							element.getBoundingClientRect().height > 0 &&
							getComputedStyle(element).visibility !== 'hidden' &&
							getComputedStyle(element).opacity !== '0'
						const observe = () => {
							const button = [...document.querySelectorAll('button')].find(
								(node) =>
									/sav(?:e|ing).*profile|saving/i.test(node.textContent),
							)
							if (
								state.feedbackMs === null &&
								visible(button) &&
								(button.disabled || /saving/i.test(button.textContent))
							)
								state.feedbackMs = performance.now() - state.start
							const marker = document.querySelector(
								'[data-testid="profile-display-name"]',
							)
							if (visible(marker)) {
								if (
									marker.textContent.trim() === nextName &&
									state.optimisticProfileMs === null
								)
									state.optimisticProfileMs = performance.now() - state.start
								if (
									marker.textContent.trim() === originalName &&
									state.originalProfileMs === null
								)
									state.originalProfileMs = performance.now() - state.start
							}
							state.frame = requestAnimationFrame(observe)
						}
						state.frame = requestAnimationFrame(observe)
					},
					{ nextName: next.displayName, originalName: original.displayName },
				)
				run.stage = 'held-save'
				const started = performance.now()
				const responsePromise = page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname === apiPath &&
						response.request().method() === 'POST',
				)
				pendingResponse = responsePromise.then(
					async (response) => {
						await response.finished()
						return true
					},
					() => false,
				)
				await page
					.getByRole('button', { name: 'Save profile', exact: true })
					.evaluate((node) => node.click())
				await Promise.race([
					held,
					page.waitForTimeout(config.timeoutMs ?? 15000).then(() => {
						throw new Error('Save POST was not captured')
					}),
				])
				run.serverUnchangedBeforeRelease =
					(await read(context, target.origin)).displayName ===
					original.displayName
				run.stage = 'public-profile-navigation'
				await navigate(page, 'View public profile')
				await page.waitForTimeout(config.holdMs ?? 2000)
				run.beforeRelease = await page.evaluate(() => {
					if (!window.__appProbe)
						return {
							documentPreserved: false,
							feedbackMs: null,
							optimisticProfileMs: null,
							originalProfileMs: null,
							pathname: location.pathname,
						}
					const { feedbackMs, optimisticProfileMs, originalProfileMs } =
						window.__appProbe
					return {
						feedbackMs,
						optimisticProfileMs,
						originalProfileMs,
						pathname: location.pathname,
					}
				})
				run.stage = 'release-save'
				run.holdUntilReleaseMs = performance.now() - started
				release()
				const response = await responsePromise
				await response.finished()
				run.authoritativeResponseMs = performance.now() - started
				run.responseStatus = response.status()
				await handlerDone
				const expected = outcome === 'accepted' ? next : original
				run.stage = 'verify-persistence'
				const persisted = await read(context, target.origin)
				run.persistedOutcomeCorrect =
					persisted.displayName === expected.displayName &&
					persisted.bio === expected.bio
				// Record settlement independently from durable server success. A cached view
				// remaining old after an accepted write is a UX failure, not a failed POST.
				try {
					await expect(page.getByTestId('profile-display-name')).toHaveText(
						expected.displayName,
						{ timeout: config.timeoutMs ?? 15000 },
					)
					run.visibleOutcomeCorrect = true
				} catch {
					run.visibleOutcomeCorrect = false
				}
				run.settledObservationMs = performance.now() - started
				run.documentPreserved = await page.evaluate(() =>
					Boolean(window.__appProbe),
				)
				await page.evaluate(() => {
					if (window.__appProbe) cancelAnimationFrame(window.__appProbe.frame)
				})
				active = false
				await page.unrouteAll({ behavior: 'wait' })
				run.stage = 'account-load'
				await page.goto(target.origin + '/account', {
					waitUntil: 'networkidle',
				})
				await accountReady(page)
				run.reloadOutcomeCorrect =
					(await page
						.getByLabel('Display name', { exact: true })
						.inputValue()) === expected.displayName
				if (config.freshness !== false && outcome === 'accepted') {
					run.stage = 'external-freshness'
					await page.clock.install()
					const externalName = `External probe ${round + 1}`
					await write(context, target.origin, { displayName: externalName })
					await page.evaluate(() =>
						window.dispatchEvent(new FocusEvent('focus')),
					)
					await page.waitForTimeout(1000)
					await page.waitForLoadState('networkidle')
					run.freshness = {
						beforeAgeUpdated:
							(await page
								.getByLabel('Display name', { exact: true })
								.inputValue()) === externalName,
					}
					await page.clock.fastForward(61_000)
					await page.evaluate(() =>
						window.dispatchEvent(new FocusEvent('focus')),
					)
					try {
						await expect(
							page.getByLabel('Display name', { exact: true }),
						).toHaveValue(externalName, { timeout: config.timeoutMs ?? 15000 })
						run.freshness.afterAgeUpdated = true
					} catch {
						run.freshness.afterAgeUpdated = false
					}
				}
			} catch (error) {
				// Playwright errors can include DOM values. Retain the stage-independent
				// error class only; booleans above retain the actual observed outcomes.
				run.failure = error.name ?? 'Error'
			} finally {
				release()
				if (context) {
					try {
						if (postCaptured) {
							await handlerDone
							if (!(await pendingResponse))
								throw new Error('Save completion uncertain; recovery required')
						}
						// Closing pages first cancels outstanding browser work before restoration.
						for (const page of context.pages()) await page.close()
						if (original) {
							await write(context, target.origin, original)
							run.restored = true
							if (record) record.restored = true
						}
					} catch {
						run.cleanupFailure = true
					}
				}
				await browser.close()
				save()
			}
		}
	}
}
process.exitCode = report.runs.some(
	(run) =>
		run.failure ||
		run.cleanupFailure ||
		!run.restored ||
		!run.serverUnchangedBeforeRelease ||
		!run.persistedOutcomeCorrect ||
		!run.reloadOutcomeCorrect ||
		!run.visibleOutcomeCorrect ||
		run.errors.length,
)
	? 1
	: 0

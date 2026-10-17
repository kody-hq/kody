#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { securityProbeFailures } from './security-probe-contract.mjs'

const [origin, outputArg] = process.argv.slice(2)
if (
	!origin ||
	!outputArg ||
	!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)
)
	throw new Error(
		'Usage: logout-isolation-probe.mjs LOCAL_ORIGIN NEW_OUTPUT_DIRECTORY',
	)
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
const report = {
	origin,
	startedAt: new Date().toISOString(),
	cases: [],
	caveat:
		'Explicit focus/online events and a controlled delayed authenticated response. This does not establish instantaneous cross-tab invalidation.',
}
async function observeIdentityFrames(page, result) {
	result.identityFrames = []
	await page.exposeFunction('__recordIdentityFrame', (frame) => {
		if (result.identityFrames.length < 1000) result.identityFrames.push(frame)
	})
	await page.addInitScript(() => {
		let previous
		const sample = () => {
			const profileValue = document.querySelector(
				'input[name="username"]',
			)?.value
			const profile =
				profileValue === 'jane' ? 'A' : profileValue === 'kody' ? 'B' : null
			const shell = document.querySelector('header a[aria-label="@jane"]')
				? 'A'
				: document.querySelector('header a[aria-label="@kody"]')
					? 'B'
					: null
			const signature = `${location.pathname}:${shell}:${profile}`
			if (signature !== previous) {
				previous = signature
				void window.__recordIdentityFrame({
					path: location.pathname,
					shell,
					profile,
					timeOrigin: performance.timeOrigin,
					atMs: performance.now(),
				})
			}
			requestAnimationFrame(sample)
		}
		requestAnimationFrame(sample)
	})
}
const browser = await chromium.launch({
	executablePath:
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
try {
	for (const delayed of [false, true]) {
		const context = await browser.newContext()
		const row = { delayed, errors: [] }
		report.cases.push(row)
		let release
		try {
			const login = await context.request.post(origin + '/auth', {
				data: {
					email: 'jane@example.com',
					password: 'ilikecode',
					mode: 'login',
				},
			})
			if (!login.ok()) throw new Error(`Login returned ${login.status()}`)
			const page = await context.newPage()
			page.on('pageerror', (error) => row.errors.push(error.message))
			await page.goto(origin + '/account', { waitUntil: 'networkidle' })
			const field = page.getByLabel('Display name', { exact: true })
			await field.fill('Unsaved logout isolation draft')
			const other = await context.newPage()
			await other.goto(origin + '/account', { waitUntil: 'networkidle' })
			if (delayed) {
				let captured
				const capture = new Promise((done) => {
					captured = done
				})
				const barrier = new Promise((done) => {
					release = done
				})
				let first = true
				await page.route('**/_serverFn/**', async (route) => {
					if (!first || route.request().method() !== 'GET')
						return route.continue()
					first = false
					const response = await route.fetch()
					row.delayedResponseStatus = response.status()
					captured()
					await barrier
					await route.fulfill({ response })
				})
				await page.evaluate(() => window.dispatchEvent(new Event('online')))
				row.capturedLateResponse = await Promise.race([
					capture.then(() => true),
					new Promise((done) => setTimeout(() => done(false), 5000)),
				])
			}
			await other.getByRole('button', { name: 'Log out', exact: true }).click()
			await other.waitForURL((url) => url.pathname !== '/account')
			row.protectedApiStatus = (
				await context.request.get(origin + '/account/profile.json')
			).status()
			row.visibilityBeforeActivation = await page.evaluate(
				() => document.visibilityState,
			)
			await page.bringToFront()
			row.visibilityAfterActivation = await page.evaluate(
				() => document.visibilityState,
			)
			await page.evaluate(() => {
				window.dispatchEvent(new FocusEvent('focus'))
				window.dispatchEvent(new Event('online'))
			})
			release?.()
			await page.waitForTimeout(5000)
			row.afterRefresh = {
				path: new URL(page.url()).pathname,
				profileFieldPresent: await field.count(),
				draftRetained:
					(await field.count()) > 0 &&
					(await field.inputValue()) === 'Unsaved logout isolation draft',
			}
			await page.goto(origin + '/account/jobs', { waitUntil: 'networkidle' })
			row.afterProtectedNavigation = {
				path: new URL(page.url()).pathname,
				jobsSearchPresent: await page.getByPlaceholder('Search jobs').count(),
			}
		} catch (error) {
			row.failure = error.message
		} finally {
			release?.()
			await context.close()
		}
	}
	for (const activationDelayMs of [0, 1000]) {
		const context = await browser.newContext()
		const identity = {
			activationDelayMs,
			name: 'same-context identity switch',
			errors: [],
		}
		report.cases.push(identity)
		try {
			await context.request.post(origin + '/auth', {
				data: {
					email: 'jane@example.com',
					password: 'ilikecode',
					mode: 'login',
				},
			})
			const page = await context.newPage()
			page.on('pageerror', (error) => identity.errors.push(error.message))
			await observeIdentityFrames(page, identity)
			const jobsResponse = await page.goto(origin + '/account/jobs', {
				waitUntil: 'networkidle',
			})
			if (
				jobsResponse.status() !== 200 ||
				(await page.locator('main h1').innerText()).trim() !== 'Jobs'
			)
				throw new Error('Jobs setup document/heading prerequisite failed')
			const originalDocument = await page.evaluate(() => performance.timeOrigin)
			let preloads = 0
			page.on('response', (response) => {
				if (new URL(response.url()).pathname.startsWith('/_serverFn/'))
					preloads++
			})
			const accountLink = page
				.locator('a[href="/account"]')
				.filter({ visible: true })
				.first()
			await accountLink.hover()
			await page.waitForTimeout(1000)
			identity.preloadResponses = preloads
			const other = await context.newPage()
			await other.goto(origin + '/account', { waitUntil: 'networkidle' })
			await other.getByRole('button', { name: 'Log out', exact: true }).click()
			await other.waitForURL((url) => url.pathname !== '/account')
			const login = await other.request.post(origin + '/auth', {
				data: {
					email: 'kody@example.com',
					password: 'ilikecode',
					mode: 'login',
				},
			})
			if (!login.ok())
				throw new Error(`Second user login returned ${login.status()}`)
			const profile = await other.request.get(origin + '/account/profile.json')
			const expected = await profile.json()
			identity.secondUserProfileStatus = profile.status()
			identity.secondUserApiIdentityMatchesFixture =
				expected.username === 'kody'
			identity.visibilityBeforeActivation = await page.evaluate(
				() => document.visibilityState,
			)
			await page.bringToFront()
			identity.visibilityAfterActivation = await page.evaluate(
				() => document.visibilityState,
			)
			await page.evaluate((delayMs) => {
				window.dispatchEvent(new FocusEvent('focus'))
				document.dispatchEvent(new Event('visibilitychange'))
				window.dispatchEvent(new Event('online'))
				if (!delayMs) document.querySelector('a[href="/account"]').click()
			}, activationDelayMs)
			if (activationDelayMs) {
				await page.waitForTimeout(activationDelayMs)
				await accountLink.click()
			}
			const username = page.getByLabel('Username', { exact: true })
			await username.waitFor()
			identity.profileMatchesSecondUser =
				(await username.inputValue()) === expected.username
			identity.oldUserVisible = (await username.inputValue()) === 'jane'
			identity.finalPath = new URL(page.url()).pathname
			identity.shellMatchesSecondUser =
				(await page.locator('header a[aria-label="@kody"]').count()) > 0
			await page.waitForTimeout(1000)
			identity.afterSettle = {
				profileMatchesSecondUser:
					(await username.inputValue()) === expected.username,
				shellMatchesSecondUser:
					(await page.locator('header a[aria-label="@kody"]').count()) > 0,
			}
			identity.identityTriggeredReload =
				originalDocument !== (await page.evaluate(() => performance.timeOrigin))
			identity.mixedIdentityFrames = identity.identityFrames.filter(
				(frame) =>
					frame.shell && frame.profile && frame.shell !== frame.profile,
			)
		} catch (error) {
			identity.failure = error.message
		} finally {
			await context.close()
		}
	}
	{
		const context = await browser.newContext()
		const identity = {
			name: 'A document, B cookie preload, A cookie navigation',
			errors: [],
		}
		report.cases.push(identity)
		try {
			const login = async (email) => {
				const response = await context.request.post(origin + '/auth', {
					data: { email, password: 'ilikecode', mode: 'login' },
				})
				if (!response.ok())
					throw new Error(`Local identity login returned ${response.status()}`)
			}
			await login('jane@example.com')
			const page = await context.newPage()
			page.on('pageerror', (error) => identity.errors.push(error.message))
			await observeIdentityFrames(page, identity)
			const jobsResponse = await page.goto(origin + '/account/jobs', {
				waitUntil: 'networkidle',
			})
			if (
				jobsResponse.status() !== 200 ||
				(await page.locator('main h1').innerText()).trim() !== 'Jobs'
			)
				throw new Error('Jobs setup document/heading prerequisite failed')
			const originalDocument = await page.evaluate(() => performance.timeOrigin)
			const other = await context.newPage()
			const logout = async () => {
				await other.goto(origin + '/account', { waitUntil: 'networkidle' })
				await other
					.getByRole('button', { name: 'Log out', exact: true })
					.click()
				await other.waitForURL((url) => url.pathname !== '/account')
			}
			await logout()
			await login('kody@example.com')
			identity.bCookieConfirmed =
				(
					await (
						await context.request.get(origin + '/account/profile.json')
					).json()
				).username === 'kody'
			identity.preloadResponses = []
			page.on('response', (response) => {
				const path = new URL(response.url()).pathname
				if (path.startsWith('/_serverFn/'))
					identity.preloadResponses.push({ path, status: response.status() })
			})
			await page
				.locator('a[href="/account"]')
				.filter({ visible: true })
				.first()
				.hover()
			await page.waitForTimeout(1500)
			identity.documentChangedDuringBCookiePreload =
				originalDocument !== (await page.evaluate(() => performance.timeOrigin))
			await logout()
			await login('jane@example.com')
			identity.aCookieRestored =
				(
					await (
						await context.request.get(origin + '/account/profile.json')
					).json()
				).username === 'jane'
			await page.bringToFront()
			await page.evaluate(() => {
				window.dispatchEvent(new FocusEvent('focus'))
				document.dispatchEvent(new Event('visibilitychange'))
				window.dispatchEvent(new Event('online'))
			})
			await page.waitForTimeout(1000)
			await page
				.locator('a[href="/account"]')
				.filter({ visible: true })
				.first()
				.click()
			const username = page.getByLabel('Username', { exact: true })
			await username.waitFor()
			identity.profileMatchesOriginalUser =
				(await username.inputValue()) === 'jane'
			await page.waitForTimeout(1000)
			identity.afterSettleMatchesOriginalUser =
				(await username.inputValue()) === 'jane'
			identity.mixedIdentityFrames = identity.identityFrames.filter(
				(frame) =>
					frame.shell && frame.profile && frame.shell !== frame.profile,
			)
			identity.identityTriggeredReload =
				originalDocument !== (await page.evaluate(() => performance.timeOrigin))
			const readRpcPath = identity.preloadResponses.find(
				(response) => response.path,
			)?.path
			if (readRpcPath) {
				const crossSite = await context.request.get(origin + readRpcPath, {
					headers: {
						origin: 'https://cross-site.invalid',
						referer: 'https://cross-site.invalid/',
						'sec-fetch-site': 'cross-site',
					},
					maxRedirects: 0,
				})
				identity.crossSiteReadRpc = {
					path: readRpcPath,
					status: crossSite.status(),
					csrfMessagePresent: /csrf|cross.site/i.test(await crossSite.text()),
				}
			}
		} catch (error) {
			identity.failure = error.message
		} finally {
			await context.close()
		}
	}
} finally {
	await browser.close()
	for (const result of report.cases)
		result.contractFailures = securityProbeFailures(result)
	writeFileSync(
		join(output, 'result.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
}
console.log(JSON.stringify(report))
process.exitCode = report.cases.some((result) => result.contractFailures.length)
	? 1
	: 0

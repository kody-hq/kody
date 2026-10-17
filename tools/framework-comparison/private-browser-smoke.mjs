#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { loginToOrigin, requestAsSession } from '../control-kody.ts'
import { privateOriginFetch } from './private-smoke.ts'
import { readEdgeAuth } from './edge-auth.mjs'

const [
	origin,
	headersFile,
	accountFile,
	packageDirectory,
	outputFile,
	mutationFlag,
] = process.argv.slice(2)
if (
	!origin ||
	!headersFile ||
	!accountFile ||
	!packageDirectory ||
	!outputFile ||
	mutationFlag !== '--allow-profile-mutation'
)
	throw new Error(
		'Usage: private-browser-smoke.mjs HTTPS_ORIGIN HEADERS_FILE ACCOUNT_FILE LIGHTHOUSE_PACKAGE_DIRECTORY OUTPUT_JSON --allow-profile-mutation',
	)
if (existsSync(outputFile)) throw new Error('Use a fresh report path')
for (const file of [headersFile, accountFile]) {
	if ((statSync(file).mode & 0o077) !== 0)
		throw new Error(
			'Credential files must not be accessible to group or other users',
		)
}
const access = readEdgeAuth(readFileSync(headersFile, 'utf8')).get(origin)
if (!access)
	throw new Error('Origin has no configured private Access credentials')
const account = JSON.parse(readFileSync(accountFile, 'utf8'))
if (
	![account.email, account.password, account.username].every(
		(value) => typeof value === 'string' && value.length,
	)
)
	throw new Error('Invalid disposable account file')
const require = createRequire(join(resolve(packageDirectory), 'package.json'))
const { default: puppeteer } = await import(
	pathToFileURL(require.resolve('puppeteer-core')).href
)
const fetchImpl = privateOriginFetch(origin, access)
const report = {
	origin,
	checks: [],
	focusDelivery: null,
	restored: false,
	errors: 0,
	limitations: [
		'One disposable identity, not cross-user isolation.',
		'No provider, email, billing, package or administrative actions.',
		'Only display name changes; original visible value is restored.',
		'Focus timing is explicitly labeled if browser activation needs event simulation.',
	],
}
let browser
let session
let originalName
const marker = `Preview check ${randomUUID().slice(0, 8)}`
let changed = false
let stage = 'initialization'
function check(name, passed) {
	report.checks.push({ name, passed: Boolean(passed) })
	console.log(JSON.stringify({ check: name, passed: Boolean(passed) }))
	if (!passed) throw new Error(name)
}
async function api(method, path, body = null, expectedStatus = 200) {
	return requestAsSession({
		origin,
		cookieHeader: session?.cookieHeader ?? null,
		fetchImpl,
		spec: { method, path, body, expectedStatus, dump: false, contains: [] },
	})
}
async function preparePage(context) {
	const page = await context.newPage()
	await page.setViewport({ width: 1280, height: 900 })
	page.setDefaultTimeout(20_000)
	page.on('pageerror', () => report.errors++)
	await page.setBypassServiceWorker(true)
	await page.setRequestInterception(true)
	page.on('request', (request) => {
		if (request.isInterceptResolutionHandled()) return
		const sameOrigin = new URL(request.url()).origin === origin
		const headers = Object.fromEntries(
			Object.entries(request.headers()).filter(
				([name]) =>
					!/^cf-access-/i.test(name) &&
					(sameOrigin ||
						!/^(cookie|authorization|proxy-authorization)$/i.test(name)),
			),
		)
		if (!sameOrigin && request.isNavigationRequest()) {
			void request.abort().catch(() => {})
			return
		}
		// Keep the browser's session cookie on the app origin, unlike anonymous audits.
		void request
			.continue({ headers: { ...headers, ...(sameOrigin ? access : {}) } })
			.catch(() => {})
	})
	return page
}
async function profileValue(page) {
	return page.$eval('input[name="displayName"]', (input) => input.value)
}
async function waitProfile(page, value) {
	await page.waitForFunction(
		(expected) =>
			document.querySelector('input[name="displayName"]')?.value === expected,
		{},
		value,
	)
}
async function saveName(page, value) {
	stage = 'activate profile editor'
	await page.bringToFront()
	stage = 'fill display name'
	await page.locator('input[name="displayName"]').fill(value)
	const saved = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === '/account/profile.json' &&
			response.request().method() === 'POST',
	)
	stage = 'submit profile mutation'
	await page.locator('::-p-text(Save profile)').click()
	stage = 'wait for profile mutation response'
	check('Profile mutation accepted', (await saved).ok())
}
async function refreshTab(page) {
	await page.evaluate(() => {
		window.__smokeFocusEvents = 0
		window.addEventListener('focus', () => window.__smokeFocusEvents++, {
			once: true,
		})
	})
	await page.bringToFront()
	await page.evaluate(
		() =>
			new Promise((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			),
	)
	const delivered = await page.evaluate(() => window.__smokeFocusEvents > 0)
	if (!delivered)
		await page.evaluate(() => window.dispatchEvent(new FocusEvent('focus')))
	report.focusDelivery = delivered
		? 'browser activation'
		: 'explicit lifecycle event after browser activation emitted none'
}
try {
	session = await loginToOrigin({
		origin,
		email: account.email,
		password: account.password,
		fetchImpl,
	})
	check('CLI fixture session', session.ok && session.cookieHeader)
	const profile = await api('GET', '/account/profile.json')
	check(
		'CLI profile identity',
		profile.ok &&
			profile.body.email === account.email &&
			profile.body.username === account.username,
	)
	originalName = profile.body.displayName
	check('Restorable display name', typeof originalName === 'string')
	browser = await puppeteer.launch({
		executablePath:
			process.env.CHROME_PATH ??
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		headless: process.env.SMOKE_HEADED !== '1',
	})
	const context = await browser.createBrowserContext()
	const page = await preparePage(context)
	await page.goto(`${origin}/login`, { waitUntil: 'networkidle0' })
	await page.locator('input[name="email"]').fill(account.email)
	await page.locator('input[name="password"]').fill(account.password)
	await page.locator('button[type="submit"]').click()
	await page.waitForFunction(() => location.pathname === '/account')
	await waitProfile(page, originalName)
	await page.waitForFunction(
		() => document.documentElement.dataset.hydrated === 'true',
	)
	check('Browser password sign-in and account render', true)
	const timeOrigin = await page.evaluate(() => performance.timeOrigin)
	await page.evaluate(() => {
		window.__smokeBlankMain = false
		const main = document.getElementById('main')
		new MutationObserver(() => {
			if (!main.querySelector('h1')) window.__smokeBlankMain = true
		}).observe(main, { subtree: true, childList: true })
	})
	stage = 'open connections'
	await page
		.locator('[data-account-nav] a[href="/account/connections"]')
		.click()
	stage = 'wait for connections'
	await page.waitForFunction(() => location.pathname === '/account/connections')
	stage = 'return to account'
	await page.locator('[data-account-nav] a[href="/account"]').click()
	stage = 'wait for account'
	await page.waitForFunction(() => location.pathname === '/account')
	await waitProfile(page, originalName)
	check(
		'Account navigation preserves document',
		await page.evaluate(
			(before) => performance.timeOrigin === before,
			timeOrigin,
		),
	)
	check(
		'Account navigation keeps main content',
		await page.evaluate(() => !window.__smokeBlankMain),
	)
	await page.goBack()
	await page.waitForFunction(() => location.pathname === '/account/connections')
	await page.goForward()
	await page.waitForFunction(() => location.pathname === '/account')
	await waitProfile(page, originalName)
	check(
		'Back and Forward preserve account and document',
		await page.evaluate(
			(before) => performance.timeOrigin === before,
			timeOrigin,
		),
	)
	const second = await preparePage(context)
	await second.goto(`${origin}/account`, { waitUntil: 'networkidle0' })
	await waitProfile(second, originalName)
	await page.bringToFront()
	changed = true
	await saveName(page, marker)
	const fresh = await api('GET', '/account/profile.json')
	check(
		'Mutation persisted to backend',
		fresh.ok && fresh.body.displayName === marker,
	)
	const secondTimeOrigin = await second.evaluate(() => performance.timeOrigin)
	await refreshTab(second)
	const focusFresh = await waitProfile(second, marker).then(
		() => true,
		() => false,
	)
	const focusPreservedDocument = await second.evaluate(
		(before) => performance.timeOrigin === before,
		secondTimeOrigin,
	)
	const focusPassed = focusFresh && focusPreservedDocument
	report.checks.push({
		name: 'Second tab refresh receives current data without reload',
		passed: focusPassed,
	})
	if (!focusPassed) process.exitCode = 1
	stage = 'fill second-tab dirty draft'
	await second.locator('input[name="displayName"]').fill(`${marker} draft`)
	await saveName(page, `${marker} newer`)
	await refreshTab(second)
	await second.waitForNetworkIdle()
	check(
		'Dirty draft survives refresh',
		(await profileValue(second)) === `${marker} draft`,
	)
	await saveName(page, originalName)
	const restored = await api('GET', '/account/profile.json')
	check(
		'Display name restored',
		restored.ok && restored.body.displayName === originalName,
	)
	report.restored = true
	changed = false
	stage = 'sign out'
	await page.locator('form[action="/logout"] button').click()
	await page.waitForFunction(() => location.pathname !== '/account')
	const signedOut = await page.evaluate(async () => {
		const response = await fetch('/account/profile.json', {
			headers: { Accept: 'application/json' },
		})
		return { status: response.status, body: await response.text() }
	})
	check(
		'Signed-out profile is denied and omits identity',
		signedOut.status === 401 &&
			!signedOut.body.includes(account.email) &&
			!signedOut.body.includes(account.username),
	)
	await second.goto(`${origin}/account`, { waitUntil: 'networkidle0' })
	check(
		'Shared session tab cannot reopen account after logout',
		new URL(second.url()).pathname === '/login' &&
			(await second.$('input[name="displayName"]')) === null,
	)
} catch (error) {
	report.failureStage = stage
	report.failureType = error instanceof Error ? error.name : 'unknown'
	report.failureSource =
		error instanceof Error
			? error.stack
					?.split('\n')
					.find((line) => line.includes('private-browser-smoke.mjs:'))
					?.trim()
			: undefined
	report.checks.push({ name: 'Journey completed', passed: false })
	process.exitCode = 1
} finally {
	if (changed && typeof originalName === 'string' && session?.cookieHeader) {
		try {
			const current = await api('GET', '/account/profile.json')
			if (
				current.ok &&
				[marker, `${marker} newer`].includes(current.body.displayName)
			) {
				const restored = await api('POST', '/account/profile.json', {
					displayName: originalName,
				})
				const verify = await api('GET', '/account/profile.json')
				report.restored =
					restored.ok && verify.ok && verify.body.displayName === originalName
			} else
				report.restored =
					current.ok && current.body.displayName === originalName
		} catch {
			report.restored = false
		}
		if (!report.restored) process.exitCode = 1
	}
	await browser?.close()
	writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n', {
		mode: 0o600,
		flag: 'wx',
	})
	console.log(
		JSON.stringify({
			checks: report.checks.length,
			passed: report.checks.every((check) => check.passed),
			restored: report.restored,
			output: outputFile,
		}),
	)
}

#!/usr/bin/env node
import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	statSync,
	existsSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { chromium } from '@playwright/test'
import { restoreVideoFixtures } from './video-cleanup.mjs'
import { loginToOrigin, requestAsSession } from '../control-kody.ts'
import { privateOriginFetch } from './private-smoke.ts'
import { readEdgeAuth } from './edge-auth.mjs'
import { startCapture, findSyncFrame } from './video-capture.mjs'

const [configFile, targetLabel] = process.argv.slice(2)
if (!configFile || !targetLabel)
	throw new Error('Usage: video-workflow.mjs CONFIG_JSON TARGET_LABEL')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const target = config.targets.find((value) => value.label === targetLabel)
if (
	!target ||
	!/^https:\/\/kody-branch-compare-(?:remix|start)\.[a-z0-9-]+\.workers\.dev$/.test(
		target.origin,
	)
)
	throw new Error('Only the isolated comparison origins are allowed')
for (const file of [config.accessFile, config.accountFile]) {
	if ((statSync(file).mode & 0o077) !== 0)
		throw new Error('Credential files must have private permissions')
}
const access = readEdgeAuth(readFileSync(config.accessFile, 'utf8')).get(
	target.origin,
)
const account = JSON.parse(readFileSync(config.accountFile, 'utf8'))
if (!access || !account.email || !account.password || !account.username)
	throw new Error('Private access and disposable account required')
const output = resolve(config.outputDirectory, target.label)
if (existsSync(output)) throw new Error('Use a new output directory')
mkdirSync(output, { recursive: true })
const fetchImpl = privateOriginFetch(target.origin, access, (input, init) =>
	fetch(input, {
		...init,
		signal: init?.signal
			? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
			: AbortSignal.timeout(5000),
	}),
)
const session = await loginToOrigin({
	origin: target.origin,
	email: account.email,
	password: account.password,
	fetchImpl,
})
if (!session.ok) throw new Error(`Fixture login failed (${session.status})`)
async function api(method, path, body = null) {
	const response = await requestAsSession({
		origin: target.origin,
		cookieHeader: session.cookieHeader,
		fetchImpl,
		spec: {
			method,
			path,
			body,
			expectedStatus: 200,
			dump: false,
			contains: [],
		},
	})
	if (!response.ok)
		throw new Error(`Fixture ${method} ${path} returned ${response.status}`)
	return response.body
}
const profile = await api('GET', '/account/profile.json')
const jobs = await api('GET', '/account/jobs.json')
if (!Array.isArray(jobs.jobs) || typeof profile.displayName !== 'string')
	throw new Error('Invalid prerequisite data')
const original = {
	displayName: profile.displayName,
	retention: Object.fromEntries(
		[
			'successOnceDays',
			'failedOrNeverRanOnceDays',
			'disabledRecurringDays',
		].map((key) => [key, jobs.retention[key]]),
	),
}
// Retain a private recovery record even if the process is forcibly killed.
writeFileSync(
	join(output, 'fixture-recovery.json'),
	JSON.stringify({ origin: target.origin, original }, null, 2),
	{ mode: 0o600, flag: 'wx' },
)
const report = {
	label: target.label,
	origin: target.origin,
	deploymentVersion: target.deploymentVersion,
	fixture: {
		username: profile.username,
		jobsCount: jobs.jobs.length,
		retention: original.retention,
	},
	network: [],
	actions: [],
	pageErrors: 0,
	consoleErrors: 0,
	restored: false,
	capture: null,
	limitations: [
		'Recording is real desktop capture, rendering includes capture overhead.',
		'A pending input or status is not by itself proof of optimistic server state.',
		'This runner never labels a cache hit as fresh without checking the expected value.',
	],
}
let browser, capture, start, page, editor
const pendingWrites = new Set()
let writeAmbiguity = false
let stopRequested = false
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, () => {
		stopRequested = true
	})
const delay = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)))
async function visibleFrame() {
	await page.evaluate(
		() =>
			new Promise((done) =>
				requestAnimationFrame(() => requestAnimationFrame(done)),
			),
	)
}
async function saveName(activePage, name) {
	await activePage.getByLabel('Display name', { exact: true }).fill(name)
	const response = activePage.waitForResponse(
		(value) =>
			new URL(value.url()).pathname === '/account/profile.json' &&
			value.request().method() === 'POST',
	)
	await activePage
		.getByRole('button', { name: 'Save profile', exact: true })
		.click()
	if (!(await response).ok()) throw new Error('Profile save failed')
	if ((await api('GET', '/account/profile.json')).displayName !== name)
		throw new Error('Profile save did not persist')
}
try {
	browser = await chromium.launch({
		headless: false,
		executablePath:
			config.chromePath ??
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		args: [
			'--window-position=20,40',
			'--window-size=1280,1000',
			'--disable-session-crashed-bubble',
		],
		handleSIGINT: false,
		handleSIGTERM: false,
	})
	const context = await browser.newContext({
		viewport: null,
		reducedMotion: 'no-preference',
		serviceWorkers: 'block',
	})
	context.on('request', (request) => {
		if (
			request.method() === 'POST' &&
			new URL(request.url()).origin === target.origin
		)
			pendingWrites.add(request)
	})
	context.on('requestfinished', (request) => pendingWrites.delete(request))
	context.on('requestfailed', (request) => {
		if (pendingWrites.delete(request)) writeAmbiguity = true
	})
	// Playwright context.route disables the HTTP cache. Use origin-scoped CDP
	// interception instead and explicitly leave the browser cache enabled.
	async function newPage() {
		const opened = await context.newPage()
		opened.on('pageerror', () => report.pageErrors++)
		opened.on('console', (message) => {
			if (message.type() === 'error') report.consoleErrors++
		})
		const cdp = await context.newCDPSession(opened)
		const requests = new Map()
		cdp.on(
			'Network.requestWillBeSent',
			({ requestId, request, timestamp, type }) => {
				if (new URL(request.url).origin !== target.origin) return
				const row = {
					page: opened === page ? 'main' : 'other',
					path: new URL(request.url).pathname,
					method: request.method,
					type,
					started: timestamp,
				}
				requests.set(requestId, row)
				report.network.push(row)
			},
		)
		cdp.on('Network.responseReceived', ({ requestId, response, timestamp }) => {
			const row = requests.get(requestId)
			if (row)
				Object.assign(row, {
					status: response.status,
					responseMs: (timestamp - row.started) * 1000,
					fromDiskCache: response.fromDiskCache ?? false,
					fromPrefetchCache: response.fromPrefetchCache ?? false,
				})
		})
		cdp.on(
			'Network.loadingFinished',
			({ requestId, timestamp, encodedDataLength }) => {
				const row = requests.get(requestId)
				if (row)
					Object.assign(row, {
						completedMs: (timestamp - row.started) * 1000,
						encodedDataLength,
					})
			},
		)
		cdp.on('Network.loadingFailed', ({ requestId, canceled }) => {
			const row = requests.get(requestId)
			if (row) Object.assign(row, { failed: true, canceled: canceled ?? false })
		})
		await cdp.send('Network.enable')
		await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })
		await cdp.send('Fetch.enable', {
			patterns: [{ urlPattern: target.origin + '/*', requestStage: 'Request' }],
		})
		cdp.on('Fetch.requestPaused', async ({ requestId, request }) => {
			const headers = Object.entries({ ...request.headers, ...access }).map(
				([name, value]) => ({ name, value: String(value) }),
			)
			await cdp
				.send('Fetch.continueRequest', { requestId, headers })
				.catch(() => {})
		})
		return opened
	}
	page = await newPage()
	page.setDefaultTimeout(config.actionTimeoutMs ?? 5000)
	await page.setContent(
		'<!doctype html><html><body style="margin:0;background:#111"></body></html>',
	)
	await page.bringToFront()
	await delay(1500)
	report.screen = await page.evaluate(() => ({
		x: screenX,
		y: screenY,
		width: innerWidth,
		height: innerHeight,
		outerHeight,
		dpr: devicePixelRatio,
		screenWidth: screen.width,
		screenHeight: screen.height,
	}))
	const { x, y, width, height, outerHeight, dpr } = report.screen
	// Four CSS pixels inset excludes the window's rounded border and other apps.
	const crop = [
		(width - 8) * dpr,
		(height - 8) * dpr,
		(x + 4) * dpr,
		(y + outerHeight - height + 4) * dpr,
	]
		.map((value) => Math.floor(value / 2) * 2)
		.join(':')
	report.crop = crop
	capture = await startCapture({
		output: join(output, 'workflow.mp4'),
		device: config.captureDevice,
		crop,
	})
	await page.evaluate(() => {
		document.body.style.background = 'white'
	})
	start = performance.now()
	await delay(500)
	await page.evaluate(() => {
		document.body.style.background = '#111'
	})
	report.scheduleStartedAt = new Date().toISOString()
	for (const rawStep of config.steps) {
		const step = {
			...rawStep,
			path: rawStep.path?.replace('{username}', account.username),
		}
		if (stopRequested)
			throw new Error('Recording interrupted; restoring fixture')
		await delay(step.atMs - (performance.now() - start))
		const row = {
			id: step.id,
			action: step.action,
			scheduledMs: step.atMs,
			startedMs: performance.now() - start,
		}
		report.actions.push(row)
		if (row.startedMs - step.atMs > 250)
			throw new Error(
				`Action schedule missed at ${step.id}; do not use this as a synchronized pair`,
			)
		const begin = performance.now()
		if (step.action === 'open')
			await page.goto(target.origin + step.path, {
				waitUntil: 'domcontentloaded',
			})
		else if (step.action === 'navigate') {
			await page
				.locator(`a[href="${step.path}"]`)
				.filter({ visible: true })
				.first()
				.click()
			await page.waitForURL((url) => url.pathname === step.path)
		} else if (step.action === 'login') {
			await page.locator('input[name="email"]').fill(account.email)
			await page.locator('input[name="password"]').fill(account.password)
			await page.getByRole('button', { name: 'Sign in', exact: true }).click()
			await page.waitForURL((url) => url.pathname === '/account')
			await page.getByLabel('Display name', { exact: true }).waitFor()
		} else if (step.action === 'profile-fast-visit') {
			await page.getByLabel('Display name', { exact: true }).fill(step.value)
			const accepted = page
				.waitForResponse(
					(value) =>
						new URL(value.url()).pathname === '/account/profile.json' &&
						value.request().method() === 'POST',
				)
				.then((response) => {
					row.acceptedMs = performance.now() - begin
					return response
				})
			await page
				.getByRole('button', { name: 'Save profile', exact: true })
				.click()
			await page
				.locator(`a[href="/@${account.username}"]`)
				.filter({ visible: true })
				.first()
				.click()
			await page.waitForURL((url) => url.pathname === `/@${account.username}`)
			row.newNameVisible = await page
				.getByTestId('profile-display-name')
				.filter({ hasText: step.value })
				.waitFor({ timeout: 3000 })
				.then(
					() => true,
					() => false,
				)
			await visibleFrame()
			row.newNameVisibleMs = row.newNameVisible
				? performance.now() - begin
				: null
			if (!(await accepted).ok()) throw new Error('Profile save failed')
			row.optimisticCrossPagePaintObserved =
				row.newNameVisible && row.newNameVisibleMs < row.acceptedMs
			if (
				(await api('GET', '/account/profile.json')).displayName !== step.value
			)
				throw new Error('Profile did not persist')
		} else if (step.action === 'profile') await saveName(page, step.value)
		else if (step.action === 'retention') {
			await page
				.getByLabel('Successful one-off (days)', { exact: true })
				.fill(String(step.value))
			const accepted = page.waitForResponse(
				(value) =>
					new URL(value.url()).pathname === '/account/jobs.json' &&
					value.request().method() === 'POST',
			)
			await page
				.getByRole('button', { name: 'Save retention', exact: true })
				.click()
			if (!(await accepted).ok()) throw new Error('Retention save failed')
			row.acceptedMs = performance.now() - begin
			if (
				(await api('GET', '/account/jobs.json')).retention.successOnceDays !==
				step.value
			)
				throw new Error('Retention save did not persist')
		} else if (step.action === 'second-tab-profile') {
			editor ??= await newPage()
			await editor.bringToFront()
			await editor.goto(target.origin + '/account', {
				waitUntil: 'domcontentloaded',
			})
			await saveName(editor, step.value)
		} else if (step.action === 'return-main') {
			await page.bringToFront()
			row.fresh = await page
				.waitForFunction(
					(name) =>
						document.querySelector('input[name="displayName"]')?.value === name,
					step.value,
					{ timeout: step.freshnessTimeoutMs ?? 3000 },
				)
				.then(
					() => true,
					() => false,
				)
		} else if (step.action === 'back')
			await page.goBack({ waitUntil: 'domcontentloaded' })
		else throw new Error(`Unknown action ${step.action}`)
		if (step.heading)
			await page
				.getByRole('heading', { name: step.heading, exact: true })
				.waitFor()
		if (step.field) await page.getByLabel(step.field, { exact: true }).waitFor()
		await visibleFrame()
		row.readyMs = performance.now() - begin
		row.finishedMs = performance.now() - start
		row.path = new URL(page.url()).pathname
		if (step.expectRetention !== undefined)
			row.retentionVisible =
				(await page
					.getByLabel('Successful one-off (days)', { exact: true })
					.inputValue()) === String(step.expectRetention)
		if (row.retentionVisible === false)
			throw new Error('Saved retention missing on revisit')
		console.log(JSON.stringify(row))
	}
	await delay(config.durationMs - (performance.now() - start))
} catch (error) {
	report.failure = String(error.message)
		.replaceAll(account.password, '[REDACTED]')
		.replaceAll(account.email, '[REDACTED]')
	process.exitCode = 1
} finally {
	if (capture)
		report.capture = await capture.stop().catch(() => ({
			passes60fps: false,
			failure: 'Capture finalization failed',
		}))
	if (report.capture?.frameTimestampsSeconds) {
		try {
			report.sync = findSyncFrame(
				join(output, 'workflow.mp4'),
				report.capture.frameTimestampsSeconds,
			)
		} catch {
			report.sync = null
			process.exitCode = 1
		}
	}
	// Let already-dispatched writes finish before closing the browser and restoring.
	// Otherwise a late response could apply its mutation after restoration.
	const settleDeadline = performance.now() + 10000
	while (pendingWrites.size && performance.now() < settleDeadline)
		await delay(50)
	report.writesSettled = pendingWrites.size === 0 && !writeAmbiguity
	try {
		await browser?.close()
	} catch {
		report.browserCloseFailed = true
		process.exitCode = 1
	}
	report.restoration = await restoreVideoFixtures(api, original)
	report.restored =
		report.writesSettled &&
		report.restoration.profileRestored &&
		report.restoration.retentionRestored
	writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2))
	if (!report.restored || !report.capture?.passes60fps || report.pageErrors)
		process.exitCode = 1
}

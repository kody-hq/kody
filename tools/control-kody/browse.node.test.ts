import path from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import {
	assertBrowseLandedOnTarget,
	browseTargetUrl,
	defaultBrowsePath,
	formatBrowseReport,
	normalizeBrowsePath,
	normalizeScreenshotPath,
	openBrowseSession,
	playwrightCookiesFromHeader,
	type BrowseChromium,
} from './browse.ts'

test('playwrightCookiesFromHeader maps Cookie header for https preview origin', () => {
	expect(
		playwrightCookiesFromHeader(
			'kody_session=abc123; other=value',
			'https://kody-pr-9.kody.workers.dev/',
		),
	).toEqual([
		{
			name: 'kody_session',
			value: 'abc123',
			domain: 'kody-pr-9.kody.workers.dev',
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
		},
		{
			name: 'other',
			value: 'value',
			domain: 'kody-pr-9.kody.workers.dev',
			path: '/',
			httpOnly: false,
			secure: true,
			sameSite: 'Lax',
		},
	])
})

test('playwrightCookiesFromHeader uses insecure cookies for localhost', () => {
	expect(
		playwrightCookiesFromHeader('kody_session=local', 'http://127.0.0.1:3742'),
	).toEqual([
		{
			name: 'kody_session',
			value: 'local',
			domain: '127.0.0.1',
			path: '/',
			httpOnly: true,
			secure: false,
			sameSite: 'Lax',
		},
	])
})

test('normalizeBrowsePath rejects full URLs, protocol-relative paths, and backslashes', () => {
	expect(normalizeBrowsePath('')).toBe(defaultBrowsePath)
	expect(normalizeBrowsePath('  /account/packages  ')).toBe('/account/packages')
	expect(() => normalizeBrowsePath('account')).toThrow(/same-origin path/)
	expect(() =>
		normalizeBrowsePath('https://kody-pr-9.example/account'),
	).toThrow(/same-origin path/)
	expect(() => normalizeBrowsePath('//attacker.example/account')).toThrow(
		/same-origin path/,
	)
	expect(() => normalizeBrowsePath('/\\attacker.example')).toThrow(
		/backslashes/,
	)
})

test('browseTargetUrl joins origin and path and refuses host escape', () => {
	expect(browseTargetUrl('https://kody-pr-9.example/', '/@user/pkg')).toBe(
		'https://kody-pr-9.example/@user/pkg',
	)
	expect(() =>
		browseTargetUrl('https://kody-pr-9.example/', '//attacker.example/x'),
	).toThrow(/same-origin path/)
})

test('openBrowseSession injects cookies and opens the target path', async () => {
	const added: Array<unknown> = []
	const gotoCalls: Array<string> = []
	let disconnected: (() => void) | null = null
	let currentUrl = 'https://kody-pr-9.example/account/packages/demo'
	const page = {
		goto: async (url: string) => {
			gotoCalls.push(url)
			currentUrl = url
		},
		url: () => currentUrl,
		waitForLoadState: async () => {},
		screenshot: async () => {},
		on: (_event: string, _listener: () => void) => {},
	}
	const context = {
		addCookies: async (cookies: Array<unknown>) => {
			added.push(...cookies)
		},
		newPage: async () => page,
		close: async () => {},
	}
	const browser = {
		newContext: async () => context,
		close: async () => {},
		on: (event: string, listener: () => void) => {
			if (event === 'disconnected') disconnected = listener
		},
		isConnected: () => true,
	}
	const fakeChromium: BrowseChromium = {
		launch: async () => browser as never,
	}

	const reportPromise = openBrowseSession({
		origin: 'https://kody-pr-9.example',
		path: '/account/packages/demo',
		cookieHeader: 'kody_session=seed',
		chromium: fakeChromium,
		closeAfterMs: 0,
	})
	const report = await reportPromise
	expect(added).toEqual([
		expect.objectContaining({
			name: 'kody_session',
			value: 'seed',
			domain: 'kody-pr-9.example',
			secure: true,
		}),
	])
	expect(gotoCalls).toEqual(['https://kody-pr-9.example/account/packages/demo'])
	expect(report).toMatchObject({
		ok: true,
		url: 'https://kody-pr-9.example/account/packages/demo',
		headed: true,
		record: false,
		screenshotPath: null,
	})
	expect(formatBrowseReport(report)).toContain('signed in')
	expect(disconnected).toBeNull()
})

test('normalizeScreenshotPath resolves a relative path and rejects flags', () => {
	expect(normalizeScreenshotPath('.tmp/approve.png')).toBe(
		path.resolve('.tmp/approve.png'),
	)
	expect(normalizeScreenshotPath(null)).toBe(null)
	expect(() => normalizeScreenshotPath('')).toThrow(/file path/)
	expect(() => normalizeScreenshotPath('--headless')).toThrow(/not a flag/)
	expect(() => normalizeScreenshotPath('.tmp/approve.jpeg')).toThrow(/\.png/)
})

test('assertBrowseLandedOnTarget rejects login and cross-origin landings', () => {
	expect(() =>
		assertBrowseLandedOnTarget({
			requestedUrl: 'https://kody.example/account',
			finalUrl: 'https://kody.example/account',
		}),
	).not.toThrow()
	expect(() =>
		assertBrowseLandedOnTarget({
			requestedUrl: 'https://kody.example/account',
			finalUrl: 'https://kody.example/login',
		}),
	).toThrow(/login/)
	expect(() =>
		assertBrowseLandedOnTarget({
			requestedUrl: 'https://kody.example/account',
			finalUrl: 'https://attacker.example/account',
		}),
	).toThrow(/different origin/)
})

test('openBrowseSession writes a screenshot and closes headless without closeAfterMs', async () => {
	const screenshotCalls: Array<{
		path: string
		fullPage: boolean
		type: string
	}> = []
	const loadWaits: Array<{ state: string; timeout?: number }> = []
	const page = {
		goto: async () => {},
		url: () => 'https://kody-pr-9.example/@user/pkg/approve-capabilities',
		waitForLoadState: async (state: string, options?: { timeout?: number }) => {
			loadWaits.push({ state, timeout: options?.timeout })
		},
		screenshot: async (options: {
			path: string
			fullPage: boolean
			type: string
		}) => {
			screenshotCalls.push(options)
		},
		on: () => {},
	}
	const context = {
		addCookies: async () => {},
		newPage: async () => page,
		close: async () => {},
	}
	const browser = {
		newContext: async () => context,
		close: async () => {},
		on: () => {},
		isConnected: () => true,
	}
	const screenshotPath = path.join(
		tmpdir(),
		`control-kody-shot-${Date.now()}.png`,
	)
	const report = await openBrowseSession({
		origin: 'https://kody-pr-9.example',
		path: '/@user/pkg/approve-capabilities',
		cookieHeader: 'kody_session=seed',
		headed: false,
		screenshotPath,
		chromium: {
			launch: async () => browser as never,
		},
	})
	expect(screenshotCalls).toEqual([
		{ path: screenshotPath, fullPage: true, type: 'png' },
	])
	expect(loadWaits).toEqual([{ state: 'load', timeout: 30_000 }])
	expect(report.screenshotPath).toBe(path.resolve(screenshotPath))
	expect(formatBrowseReport(report)).toContain(`screenshot ${screenshotPath}`)
})

test('openBrowseSession rejects a login redirect before screenshot', async () => {
	const screenshotCalls: Array<unknown> = []
	const page = {
		goto: async () => {},
		url: () => 'https://kody-pr-9.example/login',
		waitForLoadState: async () => {},
		screenshot: async (options: unknown) => {
			screenshotCalls.push(options)
		},
		on: () => {},
	}
	const context = {
		addCookies: async () => {},
		newPage: async () => page,
		close: async () => {},
	}
	const browser = {
		newContext: async () => context,
		close: async () => {},
		on: () => {},
		isConnected: () => true,
	}
	await expect(
		openBrowseSession({
			origin: 'https://kody-pr-9.example',
			path: '/account',
			cookieHeader: 'kody_session=seed',
			headed: false,
			screenshotPath: path.join(
				tmpdir(),
				`control-kody-login-${Date.now()}.png`,
			),
			chromium: {
				launch: async () => browser as never,
			},
		}),
	).rejects.toThrow(/login/)
	expect(screenshotCalls).toEqual([])
})

test('openBrowseSession refuses an empty cookie header', async () => {
	await expect(
		openBrowseSession({
			origin: 'http://localhost:3742',
			path: '/account',
			cookieHeader: '   ',
			chromium: {
				launch: async () => {
					throw new Error('should not launch')
				},
			},
		}),
	).rejects.toThrow(/session cookie/)
})

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { normalizeCookieOrigin } from './session-cookie.ts'

export const defaultBrowsePath = '/account'
export const defaultBrowseVideoDir = path.join('.tmp', 'control-kody-browse')

export type BrowsePlaywrightCookie = {
	name: string
	value: string
	domain: string
	path: string
	httpOnly: boolean
	secure: boolean
	sameSite: 'Strict' | 'Lax' | 'None'
}

export type BrowseChromium = {
	launch: (options: { headless: boolean }) => Promise<Browser>
}

export type BrowseSessionInput = {
	origin: string
	path: string
	cookieHeader: string
	headed?: boolean
	record?: boolean
	videoDir?: string
	/** Write a PNG of the loaded page (PR walkthrough evidence). */
	screenshotPath?: string | null
	/** Close the browser after this many ms (scripted smoke / tests). */
	closeAfterMs?: number | null
	chromium?: BrowseChromium
}

export type BrowseSessionReport = {
	ok: true
	origin: string
	path: string
	url: string
	headed: boolean
	record: boolean
	videoDir: string | null
	screenshotPath: string | null
	detail: string
}

/**
 * Turn a `Cookie` request header (from `.tmp/control-kody-cookie`) into
 * Playwright `addCookies` entries for the session origin — same shape E2E
 * uses after parsing Set-Cookie.
 */
export function playwrightCookiesFromHeader(
	cookieHeader: string,
	origin: string,
): Array<BrowsePlaywrightCookie> {
	const url = new URL(normalizeCookieOrigin(origin))
	const secure = url.protocol === 'https:'
	const cookies: Array<BrowsePlaywrightCookie> = []
	for (const part of cookieHeader.split(';')) {
		const trimmed = part.trim()
		if (!trimmed) continue
		const eq = trimmed.indexOf('=')
		if (eq <= 0) continue
		const name = trimmed.slice(0, eq).trim()
		const value = trimmed.slice(eq + 1).trim()
		if (!name) continue
		cookies.push({
			name,
			value,
			domain: url.hostname,
			path: '/',
			httpOnly: name === 'kody_session',
			secure,
			sameSite: 'Lax',
		})
	}
	return cookies
}

export function normalizeBrowsePath(browsePath: string) {
	const trimmed = browsePath.trim()
	if (!trimmed) return defaultBrowsePath
	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		throw new Error(
			'browse --path must be a same-origin path (for example /account), not a full URL. Pass --origin separately.',
		)
	}
	if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
		throw new Error(
			'browse --path must be a same-origin path starting with a single /',
		)
	}
	if (trimmed.includes('\\')) {
		throw new Error('browse --path must not contain backslashes')
	}
	return trimmed
}

export function normalizeScreenshotPath(
	screenshotPath: string | null | undefined,
) {
	if (screenshotPath == null) return null
	const trimmed = screenshotPath.trim()
	if (!trimmed) {
		throw new Error('browse --screenshot requires a file path')
	}
	if (trimmed.startsWith('-')) {
		throw new Error('browse --screenshot must be a file path, not a flag')
	}
	return path.resolve(trimmed)
}

export function browseTargetUrl(origin: string, browsePath: string) {
	const base = normalizeCookieOrigin(origin)
	const normalizedPath = normalizeBrowsePath(browsePath)
	const target = new URL(normalizedPath, `${base}/`)
	if (target.origin !== new URL(base).origin) {
		throw new Error(
			`browse --path must stay on the --origin host (resolved ${target.origin})`,
		)
	}
	return target.toString()
}

export function formatBrowseReport(report: BrowseSessionReport) {
	const lines = [report.detail, `url ${report.url}`]
	if (report.record && report.videoDir) {
		lines.push(`video-dir ${report.videoDir}`)
	}
	if (report.screenshotPath) {
		lines.push(`screenshot ${report.screenshotPath}`)
	}
	return lines.join('\n')
}

/**
 * Launch headed (default) Playwright Chromium, inject the seed session cookie,
 * and open the target path already signed in. Waits until the page or browser
 * closes unless `closeAfterMs` is set.
 */
export async function openBrowseSession(
	input: BrowseSessionInput,
): Promise<BrowseSessionReport> {
	const origin = normalizeCookieOrigin(input.origin)
	const browsePath = normalizeBrowsePath(input.path)
	const url = browseTargetUrl(origin, browsePath)
	const cookies = playwrightCookiesFromHeader(input.cookieHeader, origin)
	if (cookies.length === 0) {
		throw new Error(
			'browse needs a session cookie. Run control-kody login or preview first.',
		)
	}

	const headed = input.headed !== false
	const record = input.record === true
	const videoDir = record ? (input.videoDir ?? defaultBrowseVideoDir) : null
	const screenshotPath = normalizeScreenshotPath(input.screenshotPath)
	if (videoDir) await mkdir(videoDir, { recursive: true })
	if (screenshotPath) {
		await mkdir(path.dirname(screenshotPath), { recursive: true })
	}
	// Headless + screenshot with no close budget would hang waiting for a
	// window the agent cannot see. Capture and exit.
	const closeAfterMs =
		input.closeAfterMs == null && screenshotPath && !headed
			? 0
			: input.closeAfterMs

	const launcher = input.chromium ?? chromium
	let browser: Browser
	try {
		browser = await launcher.launch({ headless: !headed })
	} catch (error) {
		throw new Error(formatBrowseLaunchError(error, { headed, record }), {
			cause: error instanceof Error ? error : undefined,
		})
	}
	let context: BrowserContext | null = null
	try {
		context = await browser.newContext(
			videoDir
				? {
						recordVideo: {
							dir: videoDir,
						},
					}
				: {},
		)
		await context.addCookies(cookies)
		const page = await context.newPage()
		const sessionClosed =
			closeAfterMs == null
				? new Promise<void>((resolve) => {
						if (!browser.isConnected()) {
							resolve()
							return
						}
						browser.on('disconnected', () => resolve())
						page.on('close', () => resolve())
					})
				: null
		await page.goto(url, { waitUntil: 'domcontentloaded' })
		if (screenshotPath) {
			await page.waitForLoadState('load').catch(() => {})
			await page.screenshot({ path: screenshotPath, fullPage: true })
		}

		const report: BrowseSessionReport = {
			ok: true,
			origin,
			path: browsePath,
			url,
			headed,
			record,
			videoDir,
			screenshotPath,
			detail: `opened ${url} (signed in)`,
		}

		if (closeAfterMs != null) {
			if (closeAfterMs > 0) {
				await delay(closeAfterMs)
			}
			await context.close()
			context = null
			await browser.close()
			return report
		}

		await sessionClosed
		await context.close().catch(() => {})
		context = null
		await browser.close().catch(() => {})
		return report
	} catch (error) {
		await context?.close().catch(() => {})
		await browser.close().catch(() => {})
		throw new Error(formatBrowseLaunchError(error, { headed, record }), {
			cause: error instanceof Error ? error : undefined,
		})
	}
}

function formatBrowseLaunchError(
	error: unknown,
	options: { headed: boolean; record: boolean },
) {
	const message = error instanceof Error ? error.message : String(error)
	if (
		options.record &&
		/ffmpeg/i.test(message) &&
		!/browse --record needs Playwright's ffmpeg/i.test(message)
	) {
		return `${message}\nbrowse --record needs Playwright's ffmpeg. On Cloud Agents prefer: npx playwright install ffmpeg (small download; do not run playwright install chromium). Then retry browse --record.`
	}
	return message
}

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

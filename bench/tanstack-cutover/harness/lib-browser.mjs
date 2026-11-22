import { chromium } from 'playwright'
export const chromePath = process.env.BENCH_CHROME ?? '/home/ubuntu/.local/bin/google-chrome'
export async function launch() {
	return chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-first-run', '--disable-extensions'] })
}
export async function newContext(browser, origin, cookie) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
	if (cookie) {
		const [name, ...rest] = cookie.split('=')
		await context.addCookies([{ name, value: rest.join('='), url: origin }])
	}
	return context
}

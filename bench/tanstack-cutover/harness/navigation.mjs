// Metric 4 (+ web-vitals): client navigation sequences with loading-flash sampling.
// Usage: node navigation.mjs ORIGIN VARIANT OUT.json [reps=20] [cpu=1] [hover=0|300]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { login } from './lib-auth.mjs'
import { resolveRoutes } from './lib-routes.mjs'
import { launch, newContext } from './lib-browser.mjs'
const [origin, variant, out, repsArg = '20', cpuArg = '1', hoverArg = '0'] = process.argv.slice(2)
const reps = Number(repsArg), cpu = Number(cpuArg), hover = Number(hoverArg)
const require = createRequire(import.meta.url)
const webVitals = readFileSync(new URL('./node_modules/web-vitals/dist/web-vitals.iife.js', import.meta.url), 'utf8')
const cookie = await login(origin)
const { routes, extra } = await resolveRoutes(origin, cookie)
const p = (n) => routes.find((r) => r.name === n).path
const sequences = [
	{ name: 'docs', auth: false, start: '/docs/connect-your-agent', steps: [{ to: '/docs/how-kody-works' }, { to: '/docs/kody-factory' }] },
	{ name: 'jobs', auth: true, start: '/@user-me/-/overview', steps: [{ to: '/@user-me/-/jobs' }, { to: p('job-detail') }, { to: extra.job2 }, { back: p('job-detail') }, { back: '/@user-me/-/jobs' }] },
	{ name: 'email', auth: true, start: '/@user-me/-/email', steps: [{ to: extra.emails[0] }, { to: extra.emails[1] }, { filter: 'select[aria-label="Filter messages by classification"]' }] },
	{ name: 'credentials', auth: true, start: '/@user-me/-/credentials', steps: [{ to: extra.creds[0] }] },
	{ name: 'marketing', auth: false, start: '/', steps: [{ to: '/pricing' }, { to: '/docs' }] },
	{ name: 'org-tabs', auth: true, start: '/@bench-org/-/members', steps: [{ to: '/@bench-org/-/teams' }] },
]
// Destination signature: first heading (h1-h3) text in the destination SSR <main> that the source page lacks,
// falling back to the longest stable text line (no dates, times or quotes).
const textCache = new Map()
async function mainText(path) {
	if (!textCache.has(path)) {
		const html = await (await fetch(new URL(path, origin), { headers: { cookie } })).text()
		const main = (html.match(/<main[\s\S]*?<\/main>/) ?? [html])[0].replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
		const clean = (t) => t.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim()
		const headings = [1, 2, 3].flatMap((l) => [...main.matchAll(new RegExp(`<h${l}[^>]*>([\\s\\S]*?)</h${l}>`, 'g'))].map((m) => clean(m[1]))).filter((t) => t.length >= 3 && t.length <= 80)
		const lines = main.split(/<[^>]+>/).map(clean).filter((t) => t.length >= 8 && t.length <= 80 && !/\d{1,2}:\d{2}|\d{4}|[“”"\u2014]/.test(t))
		textCache.set(path, { headings, lines })
	}
	return textCache.get(path)
}
async function signature(from, to) {
	const src = await mainText(from)
	const dst = await mainText(to)
	const all = new Set([...src.headings, ...src.lines])
	return dst.headings.find((t) => !all.has(t)) ?? dst.lines.filter((t) => !all.has(t)).sort((a, b) => b.length - a.length)[0] ?? null
}
for (const seq of sequences) {
	let prev = seq.start
	for (const step of seq.steps) {
		const dest = step.to ?? step.back
		if (dest) step.signature = await signature(prev, dest)
		step.dest = dest
		if (dest) prev = dest
	}
}
const sampler = `(() => {
	window.__bench = { token: Math.random(), longtasks: [], frames: [], sampling: false, clickAt: 0 }
	try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__bench.longtasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask', buffered: true }) } catch {}
	addEventListener('pointerdown', () => { window.__bench.clickAt = performance.now() }, true)
	const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 }
	const check = () => {
		const ind = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"],[class*="skeleton" i],[class*="spinner" i],[data-loading="true"],[data-pending="true"]')].some(visible)
		const main = document.querySelector('main')
		const empty = !main || main.innerText.trim() === ''
		const loadingText = !!main && /\\bLoading\\b/.test(main.innerText)
		return ind || empty || loadingText
	}
	let flagged = false
	new MutationObserver(() => { if (window.__bench.sampling && check()) flagged = true }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
	let last = performance.now()
	const tick = (t) => { if (window.__bench.sampling) { window.__bench.frames.push({ t, dt: t - last, loading: flagged || check() }); flagged = false } last = t; requestAnimationFrame(tick) }
	requestAnimationFrame(tick)
})()`
const browser = await launch()
const result = { variant, origin, cpu, hover, reps, browser: browser.version(), startedAt: new Date().toISOString(), sequences: sequences.map(({ name, start, steps }) => ({ name, start, steps })), runs: [], failures: [] }
for (let rep = 0; rep < reps; rep += 1) {
	for (const seq of sequences) {
		const context = await newContext(browser, origin, seq.auth ? cookie : null)
		await context.addInitScript(sampler)
		await context.addInitScript(webVitals + `;window.__vitals={};['onLCP','onCLS','onINP','onFCP','onTTFB'].forEach(k=>webVitals[k]((m)=>{window.__vitals[m.name]=m.value},{reportAllChanges:true}))`)
		const page = await context.newPage()
		const cdp = await context.newCDPSession(page)
		await cdp.send('Network.enable')
		if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
		let net = { requests: 0, bytes: 0, documents: 0 }
		cdp.on('Network.requestWillBeSent', (e) => { net.requests += 1; if (e.type === 'Document') net.documents += 1 })
		cdp.on('Network.loadingFinished', (e) => { net.bytes += e.encodedDataLength })
		const run = { rep, sequence: seq.name, steps: [] }
		try {
			await page.goto(new URL(seq.start, origin).href, { waitUntil: 'networkidle', timeout: 90000 })
			await page.waitForTimeout(300)
			for (const [index, step] of seq.steps.entries()) {
				await page.evaluate(() => { window.__bench.frames = []; window.__bench.sampling = true })
				const token = await page.evaluate(() => window.__bench.token)
				net = { requests: 0, bytes: 0, documents: 0 }
				let t0 = Date.now()
				if (step.to) {
					const link = page.locator(`a[href="${step.to}"]:visible`).first()
					await link.scrollIntoViewIfNeeded()
					if (hover) { await link.hover(); await page.waitForTimeout(hover) }
					await page.evaluate(() => { window.__bench.frames = [] })
					t0 = Date.now()
					await link.click()
				} else if (step.back) {
					await page.evaluate(() => history.back())
				} else if (step.filter) {
					const select = page.locator(step.filter).first()
					const options = await select.locator('option').evaluateAll((os) => os.map((o) => o.value))
					const before = page.url()
					await select.selectOption(options[1])
					await page.waitForFunction((b) => location.href !== b, before, { timeout: 30000 }).catch(() => {})
				}
				const t1 = Date.now()
				if (step.dest) {
					await page.waitForFunction(({ dest, sig }) => location.pathname + location.search === decodeURI(dest) || location.pathname === dest || encodeURI(decodeURI(location.pathname)) === dest ? (!sig || (document.querySelector('main')?.innerText ?? '').replace(/\s+/g, '').includes(sig.replace(/\s+/g, ''))) : false, { dest: step.dest, sig: step.signature }, { polling: 'raf', timeout: 30000 })
				} else {
					await page.waitForFunction(() => (document.querySelector('main')?.innerText.trim() ?? '') !== '', null, { polling: 'raf', timeout: 30000 })
				}
				const readyMs = Date.now() - t0
				await page.waitForTimeout(150)
				const inPage = await page.evaluate(() => { const b = window.__bench; b.sampling = false; return { token: b.token, frames: b.frames, longtasks: b.longtasks.filter((l) => l.start >= b.clickAt - 1), clickAt: b.clickAt } })
				let flashes = 0, flashMs = 0, prevLoading = false
				for (const f of inPage.frames) { if (f.loading) { flashMs += f.dt; if (!prevLoading) flashes += 1 } prevLoading = f.loading }
				run.steps.push({ index, kind: step.to ? 'click' : step.back ? 'back' : 'filter', dest: step.dest ?? null, readyMs, actionMs: t1 - t0, fullReload: inPage.token !== token || net.documents > 0, requests: net.requests, bytes: net.bytes, longTasks: inPage.longtasks.length, longTaskMs: inPage.longtasks.reduce((a, l) => a + l.duration, 0), flashes, flashMs, frames: inPage.frames.length })
			}
			await page.mouse.click(5, 5)
			await page.waitForTimeout(100)
			run.vitals = await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); return window.__vitals })
		} catch (error) {
			result.failures.push({ rep, sequence: seq.name, step: run.steps.length, error: String(error).slice(0, 400) })
			run.failed = true
		}
		result.runs.push(run)
		await context.close()
	}
}
await browser.close()
writeFileSync(out, JSON.stringify(result, null, 1))
console.log(`navigation ${variant} cpu${cpu} hover${hover} runs ${result.runs.length} failures ${result.failures.length}`)

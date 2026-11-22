// Metric 5: hydration cost on cold load with CDP tracing.
// Hydration marker: an init script clicks the header Menu button every 10 ms; the first click whose
// aria-expanded update is applied (requires the app's JS handlers) marks hydration complete.
// Usage: node hydration.mjs ORIGIN VARIANT OUT.json [n=20] [cpu=1]
import { writeFileSync } from 'node:fs'
import { login } from './lib-auth.mjs'
import { launch, newContext } from './lib-browser.mjs'
const [origin, variant, out, nArg = '20', cpuArg = '1'] = process.argv.slice(2)
const n = Number(nArg), cpu = Number(cpuArg)
const cookie = await login(origin)
const routes = [['home', '/', false], ['docs', '/docs', false], ['account', '/account', true], ['jobs', '/@user-me/-/jobs', true]]
const marker = `(() => {
	window.__hyd = { at: null, clicks: 0 }
	let lastClick = 0
	const id = setInterval(() => {
		const btn = document.querySelector('button[aria-label="Menu"][aria-expanded]')
		if (!btn) return
		if (btn.getAttribute('aria-expanded') === 'true') { window.__hyd.at = lastClick; clearInterval(id); try { document.getElementById(btn.getAttribute('popovertarget'))?.hidePopover() } catch {} return }
		const pop = document.getElementById(btn.getAttribute('popovertarget'))
		try { if (pop?.matches(':popover-open')) pop.hidePopover() } catch {}
		lastClick = performance.now(); window.__hyd.clicks += 1; btn.click()
	}, 10)
})()`
const browser = await launch()
const result = { variant, origin, cpu, n, browser: browser.version(), method: 'Menu button aria-expanded click marker', routes: {}, failures: [] }
for (const [name, path, auth] of routes) {
	const samples = []
	for (let i = 0; i < n; i += 1) {
		const context = await newContext(browser, origin, auth ? cookie : null)
		await context.addInitScript(marker)
		const page = await context.newPage()
		const cdp = await context.newCDPSession(page)
		await cdp.send('Network.enable')
		await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
		await cdp.send('Performance.enable')
		if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
		const events = []
		cdp.on('Tracing.dataCollected', (e) => events.push(...e.value))
		const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r))
		await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing,loading,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' })
		try {
			await page.goto(new URL(path, origin).href, { waitUntil: 'load', timeout: 90000 })
			await page.waitForFunction(() => window.__hyd.at !== null, null, { timeout: 60000 })
			const hyd = await page.evaluate(() => ({ at: window.__hyd.at, clicks: window.__hyd.clicks }))
			const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
			await cdp.send('Tracing.end')
			await done
			const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain' && events.some((x) => x.pid === e.pid && x.name === 'navigationStart'))
			const navStart = events.filter((e) => e.name === 'navigationStart' && e.pid === main?.pid).map((e) => e.ts).sort((a, b) => a - b).at(-1)
			const timeOrigin = await page.evaluate(() => performance.timeOrigin)
			const onMain = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && e.ts >= navStart)
			const endTs = navStart + hyd.at * 1000
			const before = onMain.filter((e) => e.ts <= endTs)
			const tasks = before.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask')
			const scriptEval = before.filter((e) => ['EvaluateScript', 'v8.evaluateModule', 'v8.compileModule', 'v8.compile'].includes(e.name))
			samples.push({
				hydratedAtMs: hyd.at, markerClicks: hyd.clicks,
				mainThreadTaskMsUntilHydration: tasks.reduce((a, e) => a + Math.min(e.dur, endTs - e.ts), 0) / 1000,
				scriptEvaluationMsUntilHydration: scriptEval.reduce((a, e) => a + e.dur, 0) / 1000,
				longTasksBeforeHydration: tasks.filter((e) => e.dur > 50000).length,
				functionCallMsUntilHydration: before.filter((e) => e.name === 'FunctionCall' || e.name === 'v8.callFunction').reduce((a, e) => a + e.dur, 0) / 1000,
				ScriptDuration: metrics.ScriptDuration * 1000, TaskDuration: metrics.TaskDuration * 1000, timeOrigin,
			})
		} catch (error) {
			result.failures.push({ route: name, i, error: String(error).slice(0, 300) })
			await cdp.send('Tracing.end').catch(() => {})
		}
		await context.close()
	}
	result.routes[name] = { path, auth, samples }
}
await browser.close()
writeFileSync(out, JSON.stringify(result, null, 1))
console.log(`hydration ${variant} cpu${cpu} failures ${result.failures.length}`)

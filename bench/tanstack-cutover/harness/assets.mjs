// Metric 1: per-route JS/CSS the browser requests on a cold direct load (cache disabled).
// Usage: node assets.mjs ORIGIN VARIANT OUT.json [n=20]
import { writeFileSync } from 'node:fs'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { login } from './lib-auth.mjs'
import { resolveRoutes } from './lib-routes.mjs'
import { launch, newContext } from './lib-browser.mjs'
const [origin, variant, out, nArg = '20'] = process.argv.slice(2)
const cookie = await login(origin)
const { routes } = await resolveRoutes(origin, cookie)
const browser = await launch()
const sizeCache = new Map()
function sizes(url, buf) {
	if (!sizeCache.has(url)) sizeCache.set(url, { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length })
	return sizeCache.get(url)
}
const result = { variant, origin, browser: browser.version(), startedAt: new Date().toISOString(), routes: {}, failures: [] }
for (const route of routes) {
	const samples = []
	for (let i = 0; i < Number(nArg); i += 1) {
		const context = await newContext(browser, origin, route.auth ? cookie : null)
		const page = await context.newPage()
		const cdp = await context.newCDPSession(page)
		await cdp.send('Network.enable')
		await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
		const pending = []
		page.on('response', (response) => {
			const type = response.request().resourceType()
			if (type !== 'script' && type !== 'stylesheet') return
			pending.push(response.body().then((buf) => ({ url: response.url(), type, status: response.status(), ...sizes(response.url(), buf) })).catch((e) => ({ url: response.url(), type, error: String(e) })))
		})
		try {
			const nav = await page.goto(new URL(route.path, origin).href, { waitUntil: 'networkidle', timeout: 60000 })
			const files = await Promise.all(pending)
			const agg = (t) => files.filter((f) => f.type === t && !f.error).reduce((a, f) => ({ requests: a.requests + 1, raw: a.raw + f.raw, gzip: a.gzip + f.gzip, brotli: a.brotli + f.brotli }), { requests: 0, raw: 0, gzip: 0, brotli: 0 })
			samples.push({ status: nav?.status(), finalUrl: page.url(), js: agg('script'), css: agg('stylesheet'), files: i === 0 ? files : undefined })
		} catch (error) {
			result.failures.push({ route: route.name, i, error: String(error) })
		}
		await context.close()
	}
	result.routes[route.name] = { path: route.path, auth: route.auth, samples }
}
await browser.close()
writeFileSync(out, JSON.stringify(result, null, 1))
console.log(`assets ${variant} done, failures ${result.failures.length}`)

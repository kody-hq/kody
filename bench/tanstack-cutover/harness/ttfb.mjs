// Metric 3: warm server render. Usage: node ttfb.mjs ORIGIN VARIANT OUT.json [measured=50] [warmup=5]
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { login } from './lib-auth.mjs'
import { resolveRoutes } from './lib-routes.mjs'
const [origin, variant, out, measuredArg = '50', warmArg = '5'] = process.argv.slice(2)
const cookie = await login(origin)
const { routes } = await resolveRoutes(origin, cookie)
const agent = new http.Agent({ keepAlive: false })
function timed(path, auth) {
	return new Promise((resolve) => {
		const start = process.hrtime.bigint()
		const req = http.get(new URL(path, origin), { agent, headers: auth ? { cookie } : {} }, (res) => {
			const ttfb = Number(process.hrtime.bigint() - start) / 1e6
			let bytes = 0
			res.on('data', (c) => { bytes += c.length })
			res.on('end', () => resolve({ status: res.statusCode, ttfbMs: ttfb, totalMs: Number(process.hrtime.bigint() - start) / 1e6, htmlBytes: bytes, serverTiming: res.headers['server-timing'] ?? null }))
		})
		req.on('error', (error) => resolve({ status: 0, error: String(error) }))
	})
}
const result = { variant, origin, startedAt: new Date().toISOString(), routes: {} }
for (const route of routes) {
	for (let i = 0; i < Number(warmArg); i += 1) await timed(route.path, route.auth)
	const samples = []
	for (let i = 0; i < Number(measuredArg); i += 1) samples.push(await timed(route.path, route.auth))
	result.routes[route.name] = { path: route.path, auth: route.auth, samples }
}
writeFileSync(out, JSON.stringify(result, null, 1))
console.log(`ttfb ${variant} done ${routes.length} routes`)

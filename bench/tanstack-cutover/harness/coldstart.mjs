// Metric 2b: local cold first-request latency after a server restart.
// Usage: node coldstart.mjs VARIANT OUT.json [n=10]
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { login } from './lib-auth.mjs'
const [variant, out, nArg = '10'] = process.argv.slice(2)
const port = { a: 4101, b: 4102, c: 4103 }[variant]
const origin = `http://127.0.0.1:${port}`
const server = new URL('./server.sh', import.meta.url).pathname
function timed(path, cookie) {
	return new Promise((resolve) => {
		const start = process.hrtime.bigint()
		http.get(new URL(path, origin), { headers: cookie ? { cookie } : {} }, (res) => {
			const ttfb = Number(process.hrtime.bigint() - start) / 1e6
			let bytes = 0
			res.on('data', (c) => { bytes += c.length })
			res.on('end', () => resolve({ status: res.statusCode, ttfbMs: ttfb, totalMs: Number(process.hrtime.bigint() - start) / 1e6, bytes }))
		}).on('error', (e) => resolve({ status: 0, error: String(e) }))
	})
}
const result = { variant, origin, n: Number(nArg), method: 'server.sh restart (waits for /health 200), then first GET / and first signed-in GET /account. Session cookie minted before the restart cycle.', samples: [], failures: [] }
execFileSync('bash', [server, 'restart', variant], { stdio: 'pipe' })
const cookie = await login(origin)
for (let i = 0; i < Number(nArg); i += 1) {
	const order = i % 2 === 0 ? ['/', '/account'] : ['/account', '/']
	const sample = { i, order }
	try {
		execFileSync('bash', [server, 'restart', variant], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 })
	} catch (error) {
		result.failures.push({ i, restartError: String(error).slice(0, 500) })
		continue
	}
	for (const path of order) sample[path] = await timed(path, path === '/account' ? cookie : null)
	if (sample['/'].status !== 200 || sample['/account'].status !== 200) result.failures.push({ i, sample })
	result.samples.push(sample)
}
writeFileSync(out, JSON.stringify(result, null, 1))
console.log(`coldstart ${variant} failures ${result.failures.length}`)

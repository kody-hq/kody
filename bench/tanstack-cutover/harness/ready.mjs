// Readiness gate after a server (re)start: /health can return 200 while the first app requests still fail
// with "Network connection lost". Retries login + route resolution until both succeed. Usage: node ready.mjs ORIGIN
import { login } from './lib-auth.mjs'
import { resolveRoutes } from './lib-routes.mjs'
const origin = process.argv[2]
const started = Date.now()
let failures = 0
for (;;) {
	try {
		const cookie = await login(origin)
		await resolveRoutes(origin, cookie)
		console.log(`ready after ${Date.now() - started} ms, ${failures} failed attempts`)
		break
	} catch (error) {
		failures += 1
		if (Date.now() - started > 120000) { console.log(`not ready: ${error}`); process.exit(1) }
		await new Promise((r) => setTimeout(r, 1000))
	}
}

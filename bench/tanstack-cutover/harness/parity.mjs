// Fixture and route parity: list counts and each route's status, h1 and final URL. Usage: node parity.mjs ORIGIN VARIANT OUT.json
import { writeFileSync } from 'node:fs'
import { login } from './lib-auth.mjs'
import { resolveRoutes } from './lib-routes.mjs'
const [origin, variant, out] = process.argv.slice(2)
const cookie = await login(origin)
const { routes, extra } = await resolveRoutes(origin, cookie)
const jobsHtml = await (await fetch(new URL('/@user-me/-/jobs', origin), { headers: { cookie } })).text()
const result = { variant, counts: { jobLinks: new Set([...jobsHtml.matchAll(/href="([^"]*\/-\/jobs\/package-job[^"]*)"/g)].map((m) => m[1])).size, emails: extra.emails.length, credentials: extra.creds.length, memories: extra.mems.length }, routes: [] }
for (const r of routes) {
	const res = await fetch(new URL(r.path, origin), { headers: r.auth ? { cookie } : {} })
	const html = await res.text()
	const h1 = ((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [])[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
	result.routes.push({ ...r, status: res.status, finalUrl: res.url.replace(origin, ''), h1, htmlBytes: Buffer.byteLength(html) })
}
writeFileSync(out, JSON.stringify(result, null, 1))
console.log(JSON.stringify(result.counts))

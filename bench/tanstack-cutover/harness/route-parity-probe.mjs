// Probe one-sided route patterns from results/routes/route-diff.json against a running variant, signed in, no redirect following.
// Usage: node route-parity-probe.mjs ORIGIN VARIANT OUT.json
import { readFileSync, writeFileSync } from 'node:fs'
import { login } from './lib-auth.mjs'
const [origin, variant, out] = process.argv.slice(2)
const diff = JSON.parse(readFileSync(new URL('../results/routes/route-diff.json', import.meta.url), 'utf8'))
const fill = (p) => p.replace(/\(\/\*\w+\)$/, '').replace(/\/\*\w*$/, '/x').replace(/:orgSlug|:username/g, 'user-me').replace(/:hash\.:ext/, 'x.png').replace(/:\w+/g, 'bench-missing')
const cookie = await login(origin)
const rows = []
for (const side of ['onlyA', 'onlyB']) for (const pattern of diff[side]) {
	const path = fill(pattern)
	const r = await fetch(origin + path, { headers: { cookie }, redirect: 'manual' })
	const body = await r.text()
	rows.push({ side, pattern, path, status: r.status, location: r.headers.get('location'), notFoundPage: /not found|404/i.test(body.slice(0, 20000)) && r.status === 404 })
}
writeFileSync(out, JSON.stringify({ variant, origin, rows }, null, 1))
console.log(rows.map((x) => `${x.side} ${x.status} ${x.pattern} ${x.location ?? ''}`).join('\n'))

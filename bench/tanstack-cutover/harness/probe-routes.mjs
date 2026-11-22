// Probe candidate paths and extract detail links. Usage: node probe-routes.mjs ORIGIN
import { login } from './lib-auth.mjs'
const origin = process.argv[2]
const cookie = await login(origin)
const paths = process.argv.slice(3).length ? process.argv.slice(3) : ['/', '/pricing', '/docs', '/blog', '/community', '/@user-me', '/community/bench-listing-1', '/account', '/@user-me/-/jobs', '/@user-me/-/email', '/@user-me/-/credentials', '/@user-me/-/memories', '/@bench-org/-/overview', '/@bench-org/-/members', '/@bench-org/-/teams', '/@bench-org/-/settings', '/@bench-org/-/usage']
const out = {}
for (const p of paths) {
	const r = await fetch(new URL(p, origin), { headers: { cookie }, redirect: 'manual' })
	const html = await r.text()
	const links = [...new Set([...html.matchAll(/href="([^"#?]+)"/g)].map((m) => m[1]))]
	const pick = (re) => links.filter((l) => re.test(l)).slice(0, 4)
	out[p] = { status: r.status, location: r.headers.get('location'), bytes: html.length, links: {
		docs: pick(/^\/docs\/[^/]+$/), blog: pick(/^\/blog\/[^/]+$/), jobs: pick(/\/-\/jobs\/./), email: pick(/\/-\/email\/./), cred: pick(/\/-\/credentials\/./), mem: pick(/\/-\/memories\/./), community: pick(/^\/community\/./), org: pick(/^\/@bench-org\/-\//) } }
	for (const k of Object.keys(out[p].links)) if (!out[p].links[k].length) delete out[p].links[k]
}
console.log(JSON.stringify(out, null, 1))

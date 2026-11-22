// Aggregates raw results into results/summary.json and results/summary.md.
// Every metric: n, median, p25, p75, min, max, CV; pairwise median differences with 95% bootstrap CIs.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const res = new URL('../results/', import.meta.url).pathname
const V = ['a', 'b', 'c']
const PAIRS = [['a', 'b'], ['b', 'c'], ['a', 'c']]
const read = (f) => JSON.parse(readFileSync(f, 'utf8'))
const files = (dir, re) => existsSync(join(res, dir)) ? readdirSync(join(res, dir)).filter((f) => re.test(f)).map((f) => join(res, dir, f)) : []
function quantile(sorted, q) { if (!sorted.length) return null; const p = (sorted.length - 1) * q; const lo = Math.floor(p); return sorted[lo] + (sorted[Math.ceil(p)] - sorted[lo]) * (p - lo) }
export function describe(xs) {
	const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
	if (!v.length) return { n: 0 }
	const mean = v.reduce((a, b) => a + b, 0) / v.length
	const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length - 1))
	return { n: v.length, median: quantile(v, 0.5), p25: quantile(v, 0.25), p75: quantile(v, 0.75), min: v[0], max: v.at(-1), mean, cv: mean === 0 ? 0 : sd / Math.abs(mean) }
}
let seed = 1122
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
const med = (v) => { const s = [...v].sort((a, b) => a - b); return quantile(s, 0.5) }
export function bootDiff(x, y, iters = 5000) {
	x = x.filter(Number.isFinite); y = y.filter(Number.isFinite)
	if (!x.length || !y.length) return null
	const d = []
	for (let i = 0; i < iters; i += 1) {
		const bx = Array.from(x, () => x[Math.floor(rand() * x.length)])
		const by = Array.from(y, () => y[Math.floor(rand() * y.length)])
		d.push(med(by) - med(bx))
	}
	d.sort((a, b) => a - b)
	const lo = quantile(d, 0.025), hi = quantile(d, 0.975)
	return { diff: med(y) - med(x), lo, hi, withinNoise: lo <= 0 && hi >= 0 }
}
const metrics = {}
function add(group, key, variant, values) { ((metrics[group] ??= {})[key] ??= {})[variant] = [...(metrics[group][key][variant] ?? []), ...values] }
const failures = []
// Build
for (const v of V) {
	const f = join(res, 'build', `build-${v}.json`)
	if (!existsSync(f)) continue
	const b = read(f)
	for (const k of ['raw', 'gzip', 'brotli']) { add('build', `total client JS ${k}`, v, [b.totals.js[k]]); add('build', `total client CSS ${k}`, v, [b.totals.css[k]]) }
	add('build', 'client JS files', v, [b.totals.js.files])
	for (const k of ['raw', 'gzip', 'brotli']) add('build', `entry + static closure JS ${k}`, v, [b.entries[0].closure[k]])
	add('build', 'entry closure files', v, [b.entries[0].closure.files])
	add('build', 'entry chunk JS gzip', v, [b.entries[0].entrySize?.gzip])
	for (const [c, bytes] of Object.entries(b.breakdownWholeBuildRawBytes)) add('bundle-breakdown-whole-build-raw', c, v, [bytes])
	for (const [c, bytes] of Object.entries(b.breakdownEntryClosureRawBytes[0])) add('bundle-breakdown-entry-closure-raw', c, v, [bytes])
}
// Assets
for (const f of files('assets', /\.json$/)) {
	const d = read(f)
	failures.push(...d.failures.map((x) => ({ metric: 'assets', variant: d.variant, ...x })))
	for (const [route, r] of Object.entries(d.routes)) for (const s of r.samples) {
		if (s.status !== 200) failures.push({ metric: 'assets', variant: d.variant, route, status: s.status })
		for (const k of ['raw', 'gzip', 'brotli', 'requests']) { add('assets-js', `${route} JS ${k}`, d.variant, [s.js[k]]); add('assets-css', `${route} CSS ${k}`, d.variant, [s.css[k]]) }
	}
}
// TTFB
for (const f of files('ttfb', /\.json$/)) {
	const d = read(f)
	for (const [route, r] of Object.entries(d.routes)) {
		const ok = r.samples.filter((s) => s.status === 200)
		for (const s of r.samples) if (s.status !== 200) failures.push({ metric: 'ttfb', variant: d.variant, route, status: s.status, error: s.error })
		add('ttfb', `${route} TTFB ms`, d.variant, ok.map((s) => s.ttfbMs))
		add('ttfb-total', `${route} full HTML ms`, d.variant, ok.map((s) => s.totalMs))
		add('html-bytes', `${route} HTML bytes`, d.variant, ok.map((s) => s.htmlBytes))
		const st = [...new Set(ok.map((s) => s.serverTiming).filter(Boolean))]
		;((metrics['server-timing'] ??= {})[route] ??= {})[d.variant] = st.slice(0, 5)
	}
}
// Cold start
for (const f of files('coldstart', /\.json$/)) {
	const d = read(f)
	failures.push(...d.failures.map((x) => ({ metric: 'coldstart', variant: d.variant, ...x })))
	for (const p of ['/', '/account']) {
		const ok = d.samples.map((s) => s[p]).filter((s) => s.status === 200)
		add('coldstart', `first ${p} TTFB ms`, d.variant, ok.map((s) => s.ttfbMs))
		add('coldstart', `first ${p} full ms`, d.variant, ok.map((s) => s.totalMs))
	}
}
// Worker startup (startup-samples.ts JSON) and bundle sizes (commit script with --keep-outdir)
for (const f of files('worker', /^startup-samples-.*\.json$/)) {
	const d = read(f)
	failures.push(...d.failures.map((x) => ({ metric: 'worker-startup', variant: d.variant, pass: d.pass, ...x })))
	for (const [target, samples] of Object.entries(d.targets)) add('worker-startup', `${target} startup active CPU ms`, d.variant, samples.map((s) => s.activeMs))
}
for (const f of files('worker', /^bundles-keep-[abc]\.txt$/)) {
	const v = f.match(/bundles-keep-([abc])/)[1]
	for (const m of readFileSync(f, 'utf8').matchAll(/(\w+) startup entry: (\d+) \//g)) add('worker-bundle', `${m[1]} entry raw bytes (commit script)`, v, [Number(m[2])])
}
for (const f of files('worker', /^worker-files-[abc]\.json$/)) {
	const d = read(f)
	;(metrics['worker-files'] ??= {})[d.variant] = d.files
	const keep = join(res, 'worker', `bundles-keep-${d.variant}.txt`)
	if (existsSync(keep)) for (const m of readFileSync(keep, 'utf8').matchAll(/(\w+) startup entry: (\d+) \//g)) {
		const file = d.files.find((x) => x.raw === Number(m[2]))
		if (file) add('worker-bundle', `${m[1]} entry gzip bytes (${file.file})`.replace(/\(.*\/(index|[\w-]+worker)\.js\)/, '(entry)'), d.variant, [file.gzip])
	}
	const server = d.files.filter((x) => /^origin\/(ssr|server)\/.*\.js$/.test(x.file))
	add('worker-bundle', 'origin server JS total raw bytes (all chunks, excl wasm)', d.variant, [server.reduce((a, x) => a + x.raw, 0)])
	add('worker-bundle', 'origin server JS total gzip bytes (all chunks, excl wasm)', d.variant, [server.reduce((a, x) => a + x.gzip, 0)])
	add('worker-bundle', 'origin server JS files', d.variant, [server.length])
}
// Hydration
for (const f of files('hydration', /\.json$/)) {
	const d = read(f)
	failures.push(...d.failures.map((x) => ({ metric: `hydration cpu${d.cpu}`, variant: d.variant, ...x })))
	for (const [route, r] of Object.entries(d.routes)) for (const k of ['mainThreadTaskMsUntilHydration', 'scriptEvaluationMsUntilHydration', 'longTasksBeforeHydration', 'ScriptDuration', 'TaskDuration', 'hydratedAtMs']) add(`hydration-cpu${d.cpu}`, `${route} ${k}`, d.variant, r.samples.map((s) => s[k]))
}
// Navigation
for (const f of files('navigation', /\.json$/)) {
	const d = read(f)
	const g = `navigation-cpu${d.cpu}-hover${d.hover}`
	failures.push(...d.failures.map((x) => ({ metric: g, variant: d.variant, ...x })))
	for (const run of d.runs) {
		if (run.failed) continue
		for (const s of run.steps) {
			const key = `${run.sequence} step${s.index} ${s.kind}${s.dest ? ` ${decodeURIComponent(s.dest).replace(/package-job:[0-9a-f]+:/, '').replace(/email-inbound-message:[0-9a-f]+/, 'message').replace(/credentials\/[0-9a-f-]{36}/, 'credentials/detail').slice(0, 40)}` : ''}`
			add(g, `${key} ready ms`, d.variant, [s.readyMs])
			add(`${g}-all`, 'all steps ready ms', d.variant, [s.readyMs])
			add(`${g}-all`, 'flashes per navigation', d.variant, [s.flashes])
			add(`${g}-all`, 'flash visible ms per navigation', d.variant, [s.flashMs])
			add(`${g}-all`, 'full reloads per navigation', d.variant, [s.fullReload ? 1 : 0])
			add(`${g}-all`, 'requests per navigation', d.variant, [s.requests])
			add(`${g}-all`, 'bytes per navigation', d.variant, [s.bytes])
			add(`${g}-all`, 'long tasks per navigation', d.variant, [s.longTasks])
			add(`${g}-all`, 'long task ms per navigation', d.variant, [s.longTaskMs])
			add(`${g}-flashes`, `${key} flashes`, d.variant, [s.flashes])
		}
		for (const [k, val] of Object.entries(run.vitals ?? {})) add(`webvitals-cpu${d.cpu}-hover${d.hover}`, `${run.sequence} ${k}`, d.variant, [val])
	}
}
// Lighthouse
for (const f of files('lighthouse', /^round\d+$/).flatMap((dir) => readdirSync(dir).filter((x) => x.endsWith('-summary.json')).map((x) => join(dir, x)))) {
	const d = read(f)
	failures.push(...d.failures.map((x) => ({ metric: 'lighthouse', variant: d.variant, ...x })))
	for (const r of d.runs) {
		if (r.runtimeError) { failures.push({ metric: 'lighthouse', variant: d.variant, route: r.route, preset: r.preset, runtimeError: r.runtimeError }); continue }
		for (const k of ['performance', 'accessibility', 'bestPractices', 'seo']) add(`lighthouse-${r.preset}-scores`, `${r.route} ${k}`, d.variant, [r[k] * 100])
		for (const k of ['LCP', 'FCP', 'CLS', 'TBT', 'SpeedIndex']) add(`lighthouse-${r.preset}-timings`, `${r.route} ${k}`, d.variant, [r[k]])
	}
}
const summary = {}
for (const [group, keys] of Object.entries(metrics)) {
	if (['server-timing', 'worker-files'].includes(group)) { summary[group] = keys; continue }
	summary[group] = {}
	for (const [key, byV] of Object.entries(keys)) {
		const row = { stats: Object.fromEntries(V.filter((v) => byV[v]).map((v) => [v, describe(byV[v])])), deltas: {} }
		for (const [x, y] of PAIRS) if (byV[x]?.length && byV[y]?.length) row.deltas[`${x}->${y}`] = bootDiff(byV[x], byV[y])
		summary[group][key] = row
	}
}
summary.failures = failures
writeFileSync(join(res, 'summary.json'), JSON.stringify(summary, null, 1))
const fmt = (x, d = 1) => x == null ? '' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(d)
const delta = (r, p) => { const d = r.deltas[p]; if (!d) return ''; return `${fmt(d.diff)} [${fmt(d.lo)}, ${fmt(d.hi)}]${d.withinNoise ? ' (noise)' : ''}` }
let md = '# Summary tables (generated by harness/stats.mjs)\n\nCells: median (p25 to p75), CV. Deltas: later minus earlier median with 95% bootstrap CI; "(noise)" means the CI crosses zero.\n\n'
for (const [group, rows] of Object.entries(summary)) {
	if (['server-timing', 'worker-files', 'failures'].includes(group)) continue
	md += `## ${group}\n\n| metric | n (A/B/C) | A | B | C | A to B | B to C | A to C |\n|---|---|---|---|---|---|---|---|\n`
	for (const [key, r] of Object.entries(rows)) {
		const cell = (v) => { const s = r.stats[v]; return !s || !s.n ? '' : `${fmt(s.median)} (${fmt(s.p25)} to ${fmt(s.p75)}), ${(s.cv * 100).toFixed(1)}%` }
		md += `| ${key} | ${V.map((v) => r.stats[v]?.n ?? 0).join('/')} | ${cell('a')} | ${cell('b')} | ${cell('c')} | ${delta(r, 'a->b')} | ${delta(r, 'b->c')} | ${delta(r, 'a->c')} |\n`
	}
	md += '\n'
}
md += `## Failures (${failures.length})\n\n` + failures.map((f) => `- ${JSON.stringify(f).slice(0, 300)}`).join('\n') + '\n'
writeFileSync(join(res, 'summary.md'), md)
console.log(`summary written, groups ${Object.keys(summary).length}, failures ${failures.length}`)

// Metric 1 (build side): emitted client asset totals, entry chunk + static import closure,
// and source-map byte attribution by category. Usage: node build-stats.mjs ROOT VARIANT ORIGIN OUT.json
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { SourceMapConsumer } from 'source-map'
const [root, variant, origin, out] = process.argv.slice(2)
const client = join(root, 'dist/client')
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p] })
export const sizes = (buf) => ({ raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, brotli: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length })
const files = walk(client)
const sum = (list) => list.reduce((a, f) => { const s = sizes(readFileSync(f)); return { files: a.files + 1, raw: a.raw + s.raw, gzip: a.gzip + s.gzip, brotli: a.brotli + s.brotli } }, { files: 0, raw: 0, gzip: 0, brotli: 0 })
const js = files.filter((f) => f.endsWith('.js'))
const css = files.filter((f) => f.endsWith('.css'))
const totals = { js: sum(js), css: sum(css), allFiles: files.length, allRawBytesExcludingMaps: files.filter((f) => !f.endsWith('.map')).reduce((a, f) => a + statSync(f).size, 0) }

// Entry: module scripts referenced by the home page HTML.
const html = await (await fetch(new URL('/', origin))).text()
const entrySrcs = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1])
const inlineImports = [...html.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)].flatMap((m) => [...m[1].matchAll(/import\(?\s*["']([^"']+\.js)["']/g)].map((x) => x[1]))
const entries = [...new Set([...entrySrcs, ...inlineImports])].map((src) => join(client, new URL(src, origin).pathname))
const importRe = /(?:import|export)\s*(?:[\w*${}\s,]*?\s*from\s*)?["'](\.{1,2}\/[^"']+\.js|\/[^"']+\.js)["']/g
function closure(entry) {
	const seen = new Set()
	const stack = [entry]
	while (stack.length) {
		const f = stack.pop()
		if (seen.has(f) || !existsSync(f)) continue
		seen.add(f)
		const code = readFileSync(f, 'utf8')
		for (const m of code.matchAll(importRe)) stack.push(m[1].startsWith('/') ? join(client, m[1]) : resolve(dirname(f), m[1]))
	}
	return [...seen]
}
const entryInfo = entries.map((e) => ({ entry: relative(client, e), entrySize: existsSync(e) ? sizes(readFileSync(e)) : null, closureFiles: closure(e).map((f) => relative(client, f)) }))
for (const e of entryInfo) e.closure = sum(e.closureFiles.map((f) => join(client, f)))

export function category(source) {
	const s = source.replace(/\\/g, '/')
	if (s.includes('@tanstack/redact')) return 'redact'
	if (/node_modules\/(react|react-dom|scheduler)\//.test(s)) return 'react'
	if (/@tanstack\/(react-router|router-core|history|router-ssr-query|react-router-ssr-query)/.test(s)) return 'tanstack-router'
	if (/@tanstack\/(query-core|react-query)/.test(s)) return 'tanstack-query'
	if (/@tanstack\/(react-start|start-|start$)/.test(s) || /@tanstack\/[^/]*start/.test(s)) return 'tanstack-start'
	if (/@emotion\//.test(s)) return 'emotion'
	if (/node_modules\/(remix|@remix-run)\//.test(s)) return 'remix'
	if (/node_modules\//.test(s)) return 'other-deps'
	return 'app'
}
async function attribute(file) {
	const mapPath = `${file}.map`
	const code = readFileSync(file, 'utf8')
	const lines = code.split('\n')
	const perSource = {}
	if (!existsSync(mapPath)) return { unmapped: Buffer.byteLength(code), perSource }
	const raw = JSON.parse(readFileSync(mapPath, 'utf8'))
	const mapped = []
	await SourceMapConsumer.with(raw, null, (c) => c.eachMapping((m) => mapped.push(m)))
	let unmapped = 0
	const byLine = new Map()
	for (const m of mapped) { if (!byLine.has(m.generatedLine)) byLine.set(m.generatedLine, []); byLine.get(m.generatedLine).push(m) }
	lines.forEach((text, i) => {
		const ms = (byLine.get(i + 1) ?? []).sort((a, b) => a.generatedColumn - b.generatedColumn)
		if (!ms.length) { unmapped += Buffer.byteLength(text); return }
		unmapped += Buffer.byteLength(text.slice(0, ms[0].generatedColumn))
		ms.forEach((m, j) => {
			const end = j + 1 < ms.length ? ms[j + 1].generatedColumn : text.length
			const bytes = Buffer.byteLength(text.slice(m.generatedColumn, end))
			const key = m.source ?? '(unmapped)'
			perSource[key] = (perSource[key] ?? 0) + bytes
		})
	})
	return { unmapped, perSource }
}
const perFile = {}
for (const f of js) {
	const { unmapped, perSource } = await attribute(f)
	const cats = { unmapped }
	for (const [s, b] of Object.entries(perSource)) { const c = s === '(unmapped)' ? 'unmapped' : category(s); cats[c] = (cats[c] ?? 0) + b }
	perFile[relative(client, f)] = cats
}
const addCats = (names) => names.reduce((a, n) => { for (const [c, b] of Object.entries(perFile[n] ?? {})) a[c] = (a[c] ?? 0) + b; return a }, {})
const result = { variant, root, totals, entries: entryInfo, breakdownWholeBuildRawBytes: addCats(Object.keys(perFile)), breakdownEntryClosureRawBytes: entryInfo.map((e) => addCats(e.closureFiles)), perFileCategoryRawBytes: perFile }
writeFileSync(out, JSON.stringify(result, null, 1))
console.log(JSON.stringify({ variant, totals, entries: entryInfo.map((e) => ({ entry: e.entry, closure: e.closure })), whole: result.breakdownWholeBuildRawBytes }))

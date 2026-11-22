// Metric 6: Lighthouse (mobile default and desktop preset). Usage: node lighthouse.mjs ORIGIN VARIANT OUTDIR [n=5]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { login } from './lib-auth.mjs'
import { publicRoutes } from './lib-routes.mjs'
import { chromePath } from './lib-browser.mjs'
const [origin, variant, outDir, nArg = '5'] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const cookie = await login(origin)
const routes = [...publicRoutes.map(([name, path]) => [name, path, false]), ['account', '/account', true]]
const summary = { variant, origin, n: Number(nArg), runs: [], failures: [] }
const cli = new URL('./node_modules/lighthouse/cli/index.js', import.meta.url).pathname
for (let i = 0; i < Number(nArg); i += 1) {
	for (const preset of ['mobile', 'desktop']) {
		for (const [name, path, auth] of routes) {
			const file = join(outDir, `${variant}-${name}-${preset}-${i}.json`)
			const args = [cli, new URL(path, origin).href, '--output=json', `--output-path=${file}`, `--chrome-path=${chromePath}`, '--chrome-flags=--headless=new --no-first-run', '--quiet', '--only-categories=performance,accessibility,best-practices,seo']
			if (preset === 'desktop') args.push('--preset=desktop')
			if (auth) args.push(`--extra-headers=${JSON.stringify({ Cookie: cookie })}`)
			try {
				execFileSync(process.execPath, args, { stdio: 'pipe', timeout: 180000 })
				const lhr = JSON.parse(readFileSync(file, 'utf8'))
				const a = lhr.audits
				summary.runs.push({ i, preset, route: name, path, finalUrl: lhr.finalDisplayedUrl, runtimeError: lhr.runtimeError?.code ?? null,
					performance: lhr.categories.performance?.score, accessibility: lhr.categories.accessibility?.score, bestPractices: lhr.categories['best-practices']?.score, seo: lhr.categories.seo?.score,
					LCP: a['largest-contentful-paint']?.numericValue, FCP: a['first-contentful-paint']?.numericValue, CLS: a['cumulative-layout-shift']?.numericValue, TBT: a['total-blocking-time']?.numericValue, SpeedIndex: a['speed-index']?.numericValue })
			} catch (error) {
				summary.failures.push({ i, preset, route: name, error: String(error).slice(0, 300) })
			}
		}
	}
}
writeFileSync(join(outDir, `${variant}-summary.json`), JSON.stringify(summary, null, 1))
console.log(`lighthouse ${variant} runs ${summary.runs.length} failures ${summary.failures.length}`)

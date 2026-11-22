// Metric 2a startup CPU with per-sample failure tolerance. Uses the commit's own tools (same build and
// `wrangler check startup` invocation as tools/check-worker-startup-time.ts) but keeps every sample,
// records "profiling timed out" failures instead of aborting, and retries until N successes (max 3N attempts).
// Usage (cwd = variant worktree): node startup-samples.ts VARIANT PASS OUT.json [n=5]
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
const [variant, pass, out, nArg = '5'] = process.argv.slice(2)
const n = Number(nArg)
const wt = process.cwd()
const t = (f: string) => import(pathToFileURL(path.join(wt, 'tools', f)).href)
const time = await t('check-worker-startup-time.ts')
const { ensureGuideCatalogModules } = await t('build-guide-catalog-modules.ts')
const { ensureWorkerBundlerModules } = await t('build-worker-bundler-modules.ts')
const { resolveLocalBinary } = await t('node-runtime.ts')
const { writeRuntimeStartupCheckConfig } = await t('local-runtime-dev-config.ts')
const { buildOriginProductionViteBundle } = await t('origin-vite-startup-build.ts')
const execFileAsync = promisify(execFile)
await Promise.all([ensureWorkerBundlerModules(), ensureGuideCatalogModules()])
const outputRoot = await mkdtemp(path.join(tmpdir(), 'bench-startup-'))
const wrangler = resolveLocalBinary('wrangler')
const result: any = { variant, pass, n, targets: {}, failures: [] }
try {
	const originBuild = await buildOriginProductionViteBundle(path.join(outputRoot, 'origin-vite'))
	for (const target of time.startupTimeTargets) {
		let resolved = time.resolveStartupTimeTarget(target, originBuild.wranglerConfigPath)
		if (target.name === 'runtime') {
			const snapshotDir = path.join(outputRoot, 'runtime-wrangler')
			await mkdir(snapshotDir, { recursive: true })
			await writeRuntimeStartupCheckConfig({ runtimeConfigPath: path.join(time.resolveStartupTimeCwd(target.packageDir), 'wrangler.jsonc'), envName: 'production', outputDir: snapshotDir })
			resolved = { ...target, packageDir: snapshotDir, args: ['--env', 'production'] }
		}
		const samples: any[] = []
		for (let attempt = 0; samples.length < n && attempt < 3 * n; attempt += 1) {
			try {
				const { stdout, stderr } = await execFileAsync(wrangler, ['check', 'startup', '--outfile', path.join(outputRoot, `${target.name}-${attempt}.cpuprofile`), ...resolved.args], { cwd: time.resolveStartupTimeCwd(resolved.packageDir), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 64 * 1024 * 1024 })
				const summary = time.parseStartupProfileSummary(`${stdout}\n${stderr}`)
				if (!summary) throw new Error('unparsable summary')
				samples.push({ attempt, ...summary })
			} catch (error: any) {
				result.failures.push({ target: target.name, attempt, error: String(error?.stderr ?? error).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300) })
			}
		}
		result.targets[target.name] = samples
		console.log(`${variant} pass${pass} ${target.name}: ${samples.map((s) => s.activeMs).join(' / ')}`)
	}
} finally {
	await rm(outputRoot, { recursive: true, force: true })
}
await writeFile(out, JSON.stringify(result, null, 1))

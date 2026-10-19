import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'
import { isExecutedDirectly, resolveLocalBinary } from './node-runtime.ts'
import { writeRuntimeStartupCheckConfig } from './local-runtime-dry-run-config.ts'
import { buildOriginProductionViteBundle } from './origin-vite-startup-build.ts'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export const startupBudgetPath = path.join(
	repoRoot,
	'tools',
	'worker-startup-budget.json',
)

export type StartupTimeTarget = {
	name: 'origin' | 'platform' | 'runtime'
	packageDir: string
	/** Extra `wrangler check startup` flags (env and positional entry). */
	args: ReadonlyArray<string>
}

/**
 * Same three production entries as `check-worker-startup-bundles.ts`.
 * Origin profiles the Vite-built slim entry (the artifact `tools/deploy.ts`
 * uploads). Platform and runtime still profile Wrangler's own bundle.
 */
export const startupTimeTargets: ReadonlyArray<StartupTimeTarget> = [
	{
		name: 'origin',
		// Replaced at profile time with the Vite snapshot directory. Wrangler
		// 4.129 refuses `check startup` when cwd is a workspace root, even
		// with `--config` pointing at the generated snapshot.
		packageDir: '.',
		args: [],
	},
	{
		name: 'platform',
		packageDir: 'packages/platform-worker',
		args: ['--config', 'wrangler.jsonc'],
	},
	{
		name: 'runtime',
		packageDir: 'packages/runtime-worker',
		args: ['--config', 'wrangler.jsonc'],
	},
]

export function resolveStartupTimeTarget(
	target: StartupTimeTarget,
	originWranglerConfigPath: string,
): StartupTimeTarget {
	if (target.name !== 'origin') return target
	return {
		...target,
		packageDir: path.dirname(originWranglerConfigPath),
		args: ['--config', path.basename(originWranglerConfigPath)],
	}
}

export function resolveStartupTimeCwd(packageDir: string) {
	return path.isAbsolute(packageDir)
		? packageDir
		: path.join(repoRoot, packageDir)
}

async function resolveRuntimeDryRunTarget(
	target: StartupTimeTarget,
	outputRoot: string,
) {
	if (target.name !== 'runtime') return target
	const snapshotDir = path.join(outputRoot, 'runtime-wrangler')
	await mkdir(snapshotDir, { recursive: true })
	await writeRuntimeStartupCheckConfig({
		runtimeConfigPath: path.join(
			resolveStartupTimeCwd(target.packageDir),
			'wrangler.jsonc',
		),
		envName: 'production',
		outputDir: snapshotDir,
	})
	return {
		...target,
		packageDir: snapshotDir,
		args: ['--env', 'production'],
	}
}

export type StartupBudget = {
	/** Reviewed ceiling for the best-of-N active CPU sample, in milliseconds. */
	maxActiveMs: Record<StartupTimeTarget['name'], number>
	/** How many profiles to take per worker; the minimum is compared. */
	runs: number
}

export type StartupProfileSummary = {
	activeMs: number
	garbageCollectionMs: number
	idleMs: number
}

/**
 * Parses the summary block `wrangler check startup` prints, for example
 * `Active: 116.3 ms (including 9.3 ms garbage collection)` and `Idle: 186.9 ms`.
 */
export function parseStartupProfileSummary(
	output: string,
): StartupProfileSummary | null {
	const active =
		/Active:\s*([\d.]+)\s*ms\s*\(including\s*([\d.]+)\s*ms garbage collection\)/i.exec(
			output,
		)
	const idle = /Idle:\s*([\d.]+)\s*ms/i.exec(output)
	if (!active?.[1] || !active[2]) return null
	return {
		activeMs: Number(active[1]),
		garbageCollectionMs: Number(active[2]),
		idleMs: idle?.[1] ? Number(idle[1]) : 0,
	}
}

export async function readStartupBudget(
	budgetPath = startupBudgetPath,
): Promise<StartupBudget> {
	const parsed = JSON.parse(await readFile(budgetPath, 'utf8')) as unknown
	if (
		!parsed ||
		typeof parsed !== 'object' ||
		!('maxActiveMs' in parsed) ||
		!('runs' in parsed)
	) {
		throw new Error(`Invalid startup budget file at ${budgetPath}`)
	}
	return parsed as StartupBudget
}

async function profileStartupOnce(
	target: StartupTimeTarget,
	outputRoot: string,
	wranglerBinary: string,
	run: number,
): Promise<StartupProfileSummary> {
	const outfile = path.join(
		outputRoot,
		`${target.name}-${String(run)}.cpuprofile`,
	)
	const { stdout, stderr } = await execFileAsync(
		wranglerBinary,
		['check', 'startup', '--outfile', outfile, ...target.args],
		{
			cwd: resolveStartupTimeCwd(target.packageDir),
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
			maxBuffer: 64 * 1024 * 1024,
		},
	)
	const summary = parseStartupProfileSummary(`${stdout}\n${stderr}`)
	if (!summary) {
		throw new Error(
			`Could not parse the startup profile summary for ${target.name}:\n${stdout}\n${stderr}`,
		)
	}
	return summary
}

export type StartupTimeResult = {
	name: StartupTimeTarget['name']
	bestActiveMs: number
	samples: Array<StartupProfileSummary>
	maxActiveMs: number
}

export function formatStartupTimeResult(result: StartupTimeResult) {
	const samples = result.samples
		.map((sample) => `${sample.activeMs.toFixed(1)}`)
		.join(' / ')
	return `${result.name} startup active CPU: ${result.bestActiveMs.toFixed(1)} ms best of [${samples}] (budget ${String(result.maxActiveMs)} ms)`
}

export function findStartupBudgetViolations(
	results: ReadonlyArray<StartupTimeResult>,
) {
	return results.filter((result) => result.bestActiveMs > result.maxActiveMs)
}

/**
 * Profiles each production entry with `wrangler check startup` (workerd,
 * sampled CPU during module evaluation) and compares the best of N runs to a
 * reviewed budget. This is a regression tripwire, not a reproduction of
 * Cloudflare's upload-time limit: the absolute numbers depend on the machine,
 * so budgets sit well above the steady-state reading and well below the level
 * that made production uploads flaky. See
 * `docs/contributing/architecture/startup-budget.md`.
 */
export async function checkWorkerStartupTime() {
	await Promise.all([ensureWorkerBundlerModules(), ensureGuideCatalogModules()])
	const budget = await readStartupBudget()
	const outputRoot = await mkdtemp(path.join(tmpdir(), 'kody-startup-time-'))
	const wranglerBinary = resolveLocalBinary('wrangler')
	const results: Array<StartupTimeResult> = []
	try {
		const originBuild = await buildOriginProductionViteBundle(
			path.join(outputRoot, 'origin-vite'),
		)
		// Sequential on purpose: concurrent workerd instances would contend for
		// CPU and inflate each other's samples.
		for (const target of startupTimeTargets) {
			const resolvedTarget = await resolveRuntimeDryRunTarget(
				resolveStartupTimeTarget(target, originBuild.wranglerConfigPath),
				outputRoot,
			)
			const samples: Array<StartupProfileSummary> = []
			for (let run = 0; run < budget.runs; run++) {
				samples.push(
					await profileStartupOnce(
						resolvedTarget,
						outputRoot,
						wranglerBinary,
						run,
					),
				)
			}
			results.push({
				name: target.name,
				bestActiveMs: Math.min(...samples.map((sample) => sample.activeMs)),
				samples,
				maxActiveMs: budget.maxActiveMs[target.name],
			})
		}
	} finally {
		await rm(outputRoot, { recursive: true, force: true })
	}
	for (const result of results) console.log(formatStartupTimeResult(result))
	const violations = findStartupBudgetViolations(results)
	if (violations.length > 0) {
		throw new Error(
			`Worker startup budget exceeded for ${violations
				.map((violation) => violation.name)
				.join(
					', ',
				)}. Profile with \`wrangler check startup\` in the worker's package directory and move module-scope work (schema construction, heavy library evaluation, Intl formatters, wasm) behind first-use loaders. Lower the budget in tools/worker-startup-budget.json when a change buys headroom; only raise it with a written justification in the PR.`,
		)
	}
	return results
}

if (isExecutedDirectly(import.meta.url)) {
	await checkWorkerStartupTime()
}

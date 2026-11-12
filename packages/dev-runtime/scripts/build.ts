/**
 * Build @kodycodes/dev-runtime: the real Kody workers (origin, platform,
 * runtime, jobs, highlight) plus the mock Cloudflare boundary worker, with
 * generated local configs. Run from anywhere in the repo:
 *
 *   node packages/dev-runtime/scripts/build.ts [--skip-origin-build]
 */
import { execFileSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { build } from 'esbuild'
import { parseJsonc } from '../../../tools/ci/resource-utils.ts'
import {
	createLocalWorkerConfig,
	droppedBindingKeys,
	flattenProductionConfig,
	type LocalWorkerName,
} from '../src/local-config.ts'

const packageRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(packageRoot, '../..')
const distDir = join(packageRoot, 'dist')
const workersDir = join(distDir, 'workers')
const generatedModulesFrom = 'node_modules/.kody-generated'
// npm never publishes nested node_modules, so generated worker modules move.
const generatedModulesTo = 'kody-generated'

type SiblingWorker = Exclude<LocalWorkerName, 'origin'>

const siblingWorkers: Record<SiblingWorker, { main: string }> = {
	platform: { main: 'platform-worker.js' },
	runtime: { main: 'runtime-worker.js' },
	jobs: { main: 'index.js' },
	highlight: { main: 'index.js' },
}

export const d1MigrationsDirs = {
	APP_DB: '../../migrations/app',
	AUDIT_DB: '../../migrations/audit',
	JOBS_DB: '../../migrations/jobs',
} as const

function run(command: string, args: Array<string>, env = process.env) {
	execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit', env })
}

function readJson(path: string) {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function writeJson(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, '\t')}\n`)
}

function walk(dir: string): Array<string> {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		return statSync(path).isDirectory() ? walk(path) : [path]
	})
}

function stripSourceMaps(dir: string) {
	for (const file of walk(dir)) {
		if (file.endsWith('.map')) rmSync(file)
	}
}

function relocateGeneratedModules(dir: string) {
	const from = join(dir, generatedModulesFrom)
	if (!existsSync(from)) return
	renameSync(from, join(dir, generatedModulesTo))
	rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
	for (const file of walk(dir)) {
		if (!/\.(m?js)$/.test(file)) continue
		const source = readFileSync(file, 'utf8')
		if (!source.includes(generatedModulesFrom)) continue
		const depth = relative(dir, file).split(/[\\/]/).length - 1
		const prefix = depth === 0 ? './' : '../'.repeat(depth)
		writeFileSync(
			file,
			source.replaceAll(
				new RegExp(
					`(\\.{1,2}/)+${generatedModulesFrom.replace('.', '\\.')}/`,
					'g',
				),
				`${prefix}${generatedModulesTo}/`,
			),
		)
	}
}

function buildOrigin(skipBuild: boolean) {
	if (!skipBuild) run('npx', ['vite', 'build'])
	const server = join(repoRoot, 'dist/server')
	const client = join(repoRoot, 'dist/client')
	const out = join(workersDir, 'origin')
	cpSync(server, out, { recursive: true })
	cpSync(client, join(workersDir, 'client'), { recursive: true })
	stripSourceMaps(out)
	stripSourceMaps(join(workersDir, 'client'))
	relocateGeneratedModules(out)
	const production = readJson(join(server, 'wrangler.json'))
	const config = createLocalWorkerConfig({
		worker: 'origin',
		config: production,
		main: 'index.js',
		assetsDirectory: '../client',
		d1MigrationsDirs,
	})
	writeJson(join(out, 'wrangler.json'), config)
	return droppedBindingKeys(production)
}

function buildSibling(worker: SiblingWorker) {
	const configPath = join(repoRoot, `packages/${worker}-worker/wrangler.jsonc`)
	const out = join(workersDir, worker)
	run('npx', [
		'wrangler',
		'deploy',
		'--dry-run',
		'--config',
		configPath,
		'--env',
		'production',
		'--outdir',
		out,
	])
	stripSourceMaps(out)
	relocateGeneratedModules(out)
	const production = flattenProductionConfig(
		parseJsonc<Record<string, unknown>>(readFileSync(configPath, 'utf8')),
	)
	writeJson(
		join(out, 'wrangler.json'),
		createLocalWorkerConfig({
			worker,
			config: production,
			main: siblingWorkers[worker].main,
			d1MigrationsDirs,
		}),
	)
	return droppedBindingKeys(production)
}

function buildMockCloudflare() {
	const configPath = join(
		repoRoot,
		'packages/mock-servers/cloudflare/wrangler.jsonc',
	)
	const out = join(workersDir, 'mock-cloudflare')
	run('npx', [
		'wrangler',
		'deploy',
		'--dry-run',
		'--config',
		configPath,
		'--outdir',
		out,
	])
	stripSourceMaps(out)
	const source = parseJsonc<Record<string, unknown>>(
		readFileSync(configPath, 'utf8'),
	)
	writeJson(join(out, 'wrangler.json'), {
		name: source.name,
		compatibility_date: source.compatibility_date,
		compatibility_flags: source.compatibility_flags,
		main: 'worker.js',
		no_bundle: true,
		migrations: source.migrations,
		durable_objects: source.durable_objects,
		observability: { enabled: false },
	})
}

function copyMigrations() {
	const dirs = {
		app: 'packages/worker/migrations',
		audit: 'packages/worker/audit-migrations',
		jobs: 'packages/jobs-worker/migrations',
	}
	for (const [name, from] of Object.entries(dirs)) {
		cpSync(join(repoRoot, from), join(distDir, 'migrations', name), {
			recursive: true,
			filter: (path) => !path.endsWith('.md'),
		})
	}
}

async function bundleEntry() {
	await build({
		entryPoints: [join(packageRoot, 'src/index.ts')],
		outfile: join(distDir, 'index.js'),
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		tsconfig: join(repoRoot, 'tsconfig.json'),
		banner: {
			js: "import { createRequire as __kodyCreateRequire } from 'node:module';const require = __kodyCreateRequire(import.meta.url);",
		},
		logLevel: 'warning',
	})
}

function gitSha() {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: repoRoot,
			encoding: 'utf8',
		}).trim()
	} catch {
		return null
	}
}

async function main() {
	const skipOriginBuild = process.argv.includes('--skip-origin-build')
	rmSync(distDir, { recursive: true, force: true })
	mkdirSync(workersDir, { recursive: true })
	const boundaryBindings: Record<string, Array<string>> = {
		origin: buildOrigin(skipOriginBuild),
	}
	for (const worker of Object.keys(siblingWorkers) as Array<SiblingWorker>) {
		boundaryBindings[worker] = buildSibling(worker)
	}
	buildMockCloudflare()
	copyMigrations()
	await bundleEntry()
	writeJson(join(distDir, 'manifest.json'), {
		sourceSha: gitSha(),
		workers: ['origin', ...Object.keys(siblingWorkers)],
		boundaryBindings,
	})
	console.log(
		`Built @kodycodes/dev-runtime into ${relative(repoRoot, distDir)}`,
	)
}

await main()

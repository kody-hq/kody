import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parseJsonc } from './ci/resource-utils.ts'
import { resolveLocalBinary } from './node-runtime.ts'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const workerDir = path.join(repoRoot, 'packages/worker')

const originProductionEntryPath = './src/production-worker.ts'
const originStartupWranglerConfigPath = path.join(
	workerDir,
	'wrangler-origin-startup.generated.json',
)

const originViteDeferredAssetPatterns = {
	guideCatalog: /^guide-catalog-[^/]+\.js$/,
	workerBundler: /^worker-bundler-[^/]+\.js$/,
	oauthProvider: /^oauth-provider-[^/]+\.js$/,
	esbuildWasm: /^esbuild-[^/]+\.wasm$/,
} as const

export type OriginViteDeferredAssets = {
	guideCatalog: Array<string>
	workerBundler: Array<string>
	oauthProvider: Array<string>
	esbuildWasm: Array<string>
}

export function findOriginViteDeferredAssets(
	assetNames: ReadonlyArray<string>,
): OriginViteDeferredAssets {
	return {
		guideCatalog: assetNames.filter((name) =>
			originViteDeferredAssetPatterns.guideCatalog.test(name),
		),
		workerBundler: assetNames.filter((name) =>
			originViteDeferredAssetPatterns.workerBundler.test(name),
		),
		oauthProvider: assetNames.filter((name) =>
			originViteDeferredAssetPatterns.oauthProvider.test(name),
		),
		esbuildWasm: assetNames.filter((name) =>
			originViteDeferredAssetPatterns.esbuildWasm.test(name),
		),
	}
}

export type OriginViteStartupBuild = {
	outDir: string
	entryPath: string
	sourceMapPath: string
	assetsDir: string
	wranglerConfigPath: string
	clientDir: string
}

/**
 * Copies the Vite origin `dist/server` + `dist/client` trees into `outputRoot`.
 * The generated `server/wrangler.json` points `assets.directory` at `../client`,
 * so the client tree must sit next to the SSR snapshot.
 */
export async function copyOriginViteBuildSnapshot({
	sourceRoot,
	outputRoot,
}: {
	sourceRoot: string
	outputRoot: string
}) {
	const serverDir = path.join(outputRoot, 'server')
	const clientDir = path.join(outputRoot, 'client')
	await cp(path.join(sourceRoot, 'dist', 'server'), serverDir, {
		recursive: true,
	})
	await cp(path.join(sourceRoot, 'dist', 'client'), clientDir, {
		recursive: true,
	})
	return { serverDir, clientDir }
}

let originViteBuildQueue: Promise<void> = Promise.resolve()

/**
 * Builds the slim origin production entry with the same Vite + TanStack Start
 * pipeline production deploy uses. The Cloudflare Vite plugin always writes
 * `dist/server` and `dist/client` at the repo root; this snapshots both into
 * `outputRoot` so `wrangler check startup` can resolve Workers Assets.
 * Calls are serialized because they share the generated Wrangler config and
 * those repo-root `dist/` directories.
 */
export async function buildOriginProductionViteBundle(
	outputRoot: string,
): Promise<OriginViteStartupBuild> {
	const previous = originViteBuildQueue
	let release!: () => void
	originViteBuildQueue = new Promise((resolve) => {
		release = resolve
	})
	await previous
	try {
		return await buildOriginProductionViteBundleUnlocked(outputRoot)
	} finally {
		release()
	}
}

async function buildOriginProductionViteBundleUnlocked(
	outputRoot: string,
): Promise<OriginViteStartupBuild> {
	await mkdir(outputRoot, { recursive: true })
	const committedConfig = parseJsonc<Record<string, unknown>>(
		await readFile(path.join(workerDir, 'wrangler.jsonc'), 'utf8'),
	)
	await writeFile(
		originStartupWranglerConfigPath,
		`${JSON.stringify({
			...committedConfig,
			main: originProductionEntryPath,
		})}\n`,
	)
	try {
		await execFileAsync(resolveLocalBinary('vite'), ['build'], {
			cwd: repoRoot,
			env: {
				...process.env,
				KODY_WRANGLER_CONFIG: originStartupWranglerConfigPath,
			},
			maxBuffer: 20 * 1024 * 1024,
		})
	} finally {
		await rm(originStartupWranglerConfigPath, { force: true })
	}
	// Vite's Cloudflare plugin writes a repo-root deploy redirect. Sibling
	// `wrangler check startup` runs then see both their wrangler.jsonc and
	// that redirect and abort.
	await rm(path.join(repoRoot, '.wrangler', 'deploy', 'config.json'), {
		force: true,
	})

	const { serverDir, clientDir } = await copyOriginViteBuildSnapshot({
		sourceRoot: repoRoot,
		outputRoot,
	})
	const wranglerConfigPath = path.join(serverDir, 'wrangler.json')
	const builtWrangler = JSON.parse(
		await readFile(wranglerConfigPath, 'utf8'),
	) as { main?: string }
	const entryFile = builtWrangler.main ?? 'index.js'
	const entryPath = path.join(serverDir, entryFile)
	return {
		outDir: outputRoot,
		entryPath,
		sourceMapPath: `${entryPath}.map`,
		assetsDir: path.join(serverDir, 'assets'),
		wranglerConfigPath,
		clientDir,
	}
}

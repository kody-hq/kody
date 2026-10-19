import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type BuildOptions } from 'esbuild'

/**
 * Bundles a tools/*-test-service.entry.ts into a standalone worker module for
 * the workers-unit vitest pool's auxiliary workers (see vitest.workers.config.ts).
 * Miniflare auxiliary workers take a prebuilt script.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const sharedBuildOptions = {
	bundle: true,
	format: 'esm',
	platform: 'neutral',
	conditions: ['workerd', 'worker', 'import'],
} as const satisfies BuildOptions

export type BuildTestServiceOptions = {
	/** Repo-relative entry, e.g. `tools/jobs-test-service.entry.ts`. */
	entry: string
	/** Repo-relative out dir; writes `index.mjs` there. */
	outDir: string
	/** Extra esbuild options (e.g. `.sql` loader, `cloudflare:workers` external). */
	esbuild?: Omit<
		BuildOptions,
		'entryPoints' | 'outfile' | 'bundle' | 'format' | 'platform' | 'conditions'
	>
}

export async function buildTestService(options: BuildTestServiceOptions) {
	const absoluteOutDir = path.join(repoRoot, options.outDir)
	const outfile = path.join(absoluteOutDir, 'index.mjs')
	await mkdir(absoluteOutDir, { recursive: true })
	await build({
		...sharedBuildOptions,
		...options.esbuild,
		entryPoints: [path.join(repoRoot, options.entry)],
		outfile,
	})
}

export async function buildHighlightTestService() {
	await buildTestService({
		entry: 'tools/highlight-test-service.entry.ts',
		outDir: '.tmp/highlight-test-service',
	})
}

export async function buildJobsTestService() {
	await buildTestService({
		entry: 'tools/jobs-test-service.entry.ts',
		outDir: '.tmp/jobs-test-service',
		esbuild: {
			external: ['cloudflare:workers'],
			loader: { '.sql': 'text' },
		},
	})
}

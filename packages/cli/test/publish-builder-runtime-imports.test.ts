import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildPublishBuilder } from '../scripts/build-publish-builder.mjs'
import { loadPublishBuilder } from '../src/local-publish-build.js'

const base64 = (text: string) => Buffer.from(text).toString('base64')

/**
 * Runs the builder the CLI ships (bundled, in a real workerd), not the
 * worker source it is built from: a module the bundle leaves unresolved only
 * fails here. When the source parser was one, every target kept its raw
 * `kody:runtime` import and the published app 500ed on every route.
 */
test('the shipped publish builder rewrites kody:runtime in app, job, and export bundles', async () => {
	const builderDir = mkdtempSync(join(tmpdir(), 'kody-builder-under-test-'))
	const previous = process.env.KODY_PUBLISH_BUILDER_DIR
	process.env.KODY_PUBLISH_BUILDER_DIR = builderDir
	try {
		await buildPublishBuilder({ outDir: builderDir })
		const builder = await loadPublishBuilder()
		const built = await builder
			.buildPublishTargets({
				files: [
					{
						path: 'package.json',
						base64: base64(
							JSON.stringify({
								name: '@me/runtime-app',
								version: '1.0.0',
								exports: { '.': './src/index.ts' },
								kody: {
									id: 'runtime-app',
									description: 'App that imports kody:runtime',
									app: { entry: './src/app.ts' },
									jobs: {
										tick: {
											entry: './src/tick.ts',
											schedule: { type: 'interval', every: '1h' },
										},
									},
								},
							}),
						),
					},
					{
						path: 'src/index.ts',
						base64: base64(
							`import { packageContext } from 'kody:runtime'\nexport default async function main() {\n\treturn packageContext?.packageId ?? null\n}\n`,
						),
					},
					{
						path: 'src/tick.ts',
						base64: base64(
							`import { packageContext } from 'kody:runtime'\nexport default async function tick() {\n\treturn packageContext?.packageId ?? null\n}\n`,
						),
					},
					{
						path: 'src/app.ts',
						base64: base64(
							`import { packageContext } from 'kody:runtime'\nexport default {\n\tasync fetch() {\n\t\treturn new Response(packageContext?.packageId ?? 'none')\n\t},\n}\n`,
						),
					},
				],
				sourceRoot: '/',
				manifestPath: 'package.json',
				rootPackageId: 'pkg-1',
				userId: 'user-1',
				baseUrl: 'https://kody.test',
			})
			.finally(() => builder.close())
		const kinds = built.targets.map(
			(entry) => `${entry.target.kind}:${entry.target.bundleKind}`,
		)
		for (const kind of [
			'app:app',
			'job:module',
			'module:module',
			'importable-module:importable-module',
		]) {
			assert.ok(kinds.includes(kind), `${kind} in ${kinds.join(', ')}`)
		}
		for (const entry of built.targets) {
			const label = `${entry.target.bundleKind} ${entry.target.entryPoint}`
			const sources = Object.values(entry.modules).map((bytes) =>
				Buffer.from(bytes).toString('utf8'),
			)
			for (const source of sources) {
				assert.doesNotMatch(source, /["']kody:/, label)
			}
			assert.ok(
				sources.some((source) =>
					source.includes('.__kody_virtual__/runtime.js'),
				),
				`${label} imports the runtime module Kody supplies`,
			)
		}
	} finally {
		if (previous === undefined) delete process.env.KODY_PUBLISH_BUILDER_DIR
		else process.env.KODY_PUBLISH_BUILDER_DIR = previous
		rmSync(builderDir, { recursive: true, force: true })
	}
})

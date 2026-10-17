import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { planSentrySourcemapUploads } from './sentry-upload-sourcemaps.ts'

async function sourcemapFixture(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'sentry-sourcemaps-'))
	for (const [file, contents] of Object.entries(files)) {
		const absolute = join(root, file)
		await mkdir(dirname(absolute), { recursive: true })
		await writeFile(absolute, contents)
	}
	return {
		root,
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true })
		},
	}
}

test('sibling-only deploys upload wrangler maps next to each worker config and skip client assets', async () => {
	await using fixture = await sourcemapFixture({
		'packages/platform-worker/.wrangler/sentry-bundle/index.js': 'platform()',
		'packages/platform-worker/.wrangler/sentry-bundle/index.js.map': '{}',
		'packages/runtime-worker/.wrangler/sentry-bundle/index.js': 'runtime()',
		'packages/runtime-worker/.wrangler/sentry-bundle/index.js.map': '{}',
	})

	expect(planSentrySourcemapUploads({ root: fixture.root })).toEqual({
		ok: true,
		uploads: [
			{
				dir: join(
					fixture.root,
					'packages/platform-worker/.wrangler/sentry-bundle',
				),
				label: 'platform worker bundle',
			},
			{
				dir: join(
					fixture.root,
					'packages/runtime-worker/.wrangler/sentry-bundle',
				),
				label: 'runtime worker bundle',
			},
		],
	})
})

test('origin vite deploys require client maps and upload every worker bundle that has maps', async () => {
	await using fixture = await sourcemapFixture({
		'dist/server/index.js': 'origin()',
		'dist/server/index.js.map': '{}',
		'dist/client/assets/entry.js': 'client()',
		'dist/client/assets/entry.js.map': '{}',
		'packages/platform-worker/.wrangler/sentry-bundle/index.js.map': '{}',
	})

	expect(planSentrySourcemapUploads({ root: fixture.root })).toEqual({
		ok: true,
		uploads: [
			{
				dir: join(fixture.root, 'dist/server'),
				label: 'origin vite worker bundle',
			},
			{
				dir: join(
					fixture.root,
					'packages/platform-worker/.wrangler/sentry-bundle',
				),
				label: 'platform worker bundle',
			},
			{
				dir: join(fixture.root, 'dist/client'),
				label: 'client assets',
			},
		],
	})

	await using originWithoutClient = await sourcemapFixture({
		'dist/server/index.js.map': '{}',
	})
	expect(
		planSentrySourcemapUploads({ root: originWithoutClient.root }),
	).toEqual({
		ok: false,
		error:
			'sentry-upload-sourcemaps: no client source maps in dist/client (expected from vite build).',
	})
})

test('missing worker maps fail the pipeline instead of silently skipping', async () => {
	await using fixture = await sourcemapFixture({
		'dist/client/assets/entry.js.map': '{}',
	})
	const plan = planSentrySourcemapUploads({ root: fixture.root })
	expect(plan.ok).toBe(false)
	if (plan.ok) throw new Error('expected a missing-bundle failure')
	expect(plan.error).toContain(join(fixture.root, 'dist/server'))
	expect(plan.error).toContain(
		join(fixture.root, 'packages/platform-worker/.wrangler/sentry-bundle'),
	)
	expect(plan.error).toContain('sibling deploys still use')
})

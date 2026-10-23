import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { buildPreviewApiWorkerConfig } from './api-worker-config.ts'
import { parseJsonc } from './resource-utils.ts'

test('preview api worker binds the per-preview app worker and drops production routes', async () => {
	const base = parseJsonc<Record<string, unknown>>(
		await readFile('packages/api-worker/wrangler.jsonc', 'utf8'),
	)
	const config = buildPreviewApiWorkerConfig(base, {
		workerName: 'kody-pr-42-api',
		appWorkerName: 'kody-pr-42',
	})
	expect(config.name).toBe('kody-pr-42-api')
	expect(Object.keys(config.env as object)).toEqual(['preview'])
	const preview = (config.env as Record<string, Record<string, unknown>>)
		.preview!
	expect(preview.services).toEqual([
		{ binding: 'KODY_API', service: 'kody-pr-42', entrypoint: 'KodyApi' },
	])
	expect(preview.routes).toBeUndefined()
})

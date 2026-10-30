import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { parseJsonc } from './resource-utils.ts'

type Observability = {
	enabled?: boolean
	logs?: { enabled?: boolean; head_sampling_rate?: number }
	traces?: { enabled?: boolean; head_sampling_rate?: number }
}
type WranglerConfig = {
	observability?: Observability
	env?: Record<string, { observability?: Observability }>
}

async function readConfig(path: string) {
	return parseJsonc<WranglerConfig>(await readFile(path, 'utf8'))
}

// Per-Worker sampling: high-volume Workers trace at 10%, mid-volume at 25%,
// low-volume Workers keep everything. Logs stay at 100% in production.
const productionSampling = [
	['packages/worker/wrangler.jsonc', 0.1],
	['packages/platform-worker/wrangler.jsonc', 0.1],
	['packages/runtime-worker/wrangler.jsonc', 0.1],
	['packages/jobs-worker/wrangler.jsonc', 0.25],
	['packages/api-worker/wrangler.jsonc', 0.25],
	['packages/highlight-worker/wrangler.jsonc', 1],
	['packages/push-queue-worker/wrangler.jsonc', 1],
	['packages/api-docs-worker/wrangler.jsonc', 1],
] as const

test.each(productionSampling)(
	'%s samples traces at %s and keeps every log in production',
	async (path, tracesRate) => {
		const config = await readConfig(path)
		const production = config.env?.production?.observability
		const effective = production ?? config.observability
		expect(effective?.enabled).toBe(true)
		expect(effective?.logs).toMatchObject({
			enabled: true,
			head_sampling_rate: 1,
		})
		expect(effective?.traces).toMatchObject({
			enabled: true,
			head_sampling_rate: tracesRate,
		})
		if (production) {
			expect(config.observability?.traces?.head_sampling_rate).toBe(tracesRate)
		}
	},
)

test.each([
	'packages/status/wrangler.jsonc',
	'packages/nx-cache/wrangler.jsonc',
	'packages/backup-control-plane/wrangler.jsonc',
])('%s keeps every log and no traces', async (path) => {
	const config = await readConfig(path)
	expect(config.observability?.logs).toMatchObject({
		enabled: true,
		head_sampling_rate: 1,
	})
	expect(config.observability?.traces).toBeUndefined()
})

// Every config that deploys a preview Worker: traces off, 10% of logs.
test.each([
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
	'packages/runtime-worker/wrangler.jsonc',
	'packages/jobs-worker/wrangler.jsonc',
	'packages/api-worker/wrangler.jsonc',
	'packages/highlight-worker/wrangler.jsonc',
	'packages/push-queue-worker/wrangler.jsonc',
	'packages/mock-servers/cloudflare/wrangler.jsonc',
])('%s preview env turns traces off and samples logs', async (path) => {
	const config = await readConfig(path)
	expect(config.env?.preview?.observability).toEqual({
		enabled: true,
		logs: { enabled: true, head_sampling_rate: 0.1, invocation_logs: true },
		traces: { enabled: false },
	})
})

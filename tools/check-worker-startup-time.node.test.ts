import { expect, test } from 'vitest'
import {
	resampleStartupBudgetViolations,
	findStartupBudgetViolations,
	formatStartupTimeResult,
	isStartupProfilerTimeout,
	parseStartupProfileSummary,
	profileStartupWithRetry,
	resolveStartupTimeCwd,
	resolveStartupTimeTarget,
} from './check-worker-startup-time.ts'

const sampleOutput = `
│ Bundle: 27987.36 KiB / gzip: 8010.60 KiB
│
│ Local startup profile:
│   Profile window: 305.1 ms
│   Sampled time: 303.2 ms
│   Active: 116.3 ms (including 9.3 ms garbage collection)
│   Idle: 186.9 ms
│   Samples: 210
`

test('parses the wrangler check startup summary block', () => {
	expect(parseStartupProfileSummary(sampleOutput)).toEqual({
		activeMs: 116.3,
		garbageCollectionMs: 9.3,
		idleMs: 186.9,
	})
})

test('returns null when the summary block is missing', () => {
	expect(parseStartupProfileSummary('wrangler exploded')).toBeNull()
})

test('startup profiling retries timeout measurements but not other errors', async () => {
	expect(
		isStartupProfilerTimeout(new Error('Startup profiling timed out')),
	).toBe(true)
	expect(
		isStartupProfilerTimeout(
			Object.assign(new Error('Command failed'), {
				stdout: '',
				stderr: 'wrangler: startup profiling timed out',
			}),
		),
	).toBe(true)
	expect(isStartupProfilerTimeout(new Error('invalid wrangler config'))).toBe(
		false,
	)

	let attempts = 0
	await expect(
		profileStartupWithRetry(async () => {
			attempts += 1
			if (attempts === 1) throw new Error('Startup profiling timed out')
			return 'profile'
		}),
	).resolves.toBe('profile')
	expect(attempts).toBe(2)

	attempts = 0
	await expect(
		profileStartupWithRetry(async () => {
			attempts += 1
			throw new Error('startup profiling timed out')
		}),
	).rejects.toThrow('startup profiling timed out')
	expect(attempts).toBe(3)

	attempts = 0
	await expect(
		profileStartupWithRetry(async () => {
			attempts += 1
			throw new Error('invalid wrangler config')
		}),
	).rejects.toThrow('invalid wrangler config')
	expect(attempts).toBe(1)
})

test('origin startup profile runs from the Vite snapshot, not the workspace root', () => {
	const resolved = resolveStartupTimeTarget(
		{ name: 'origin', packageDir: '.', args: [] },
		'/tmp/kody-startup-time/origin-vite/ssr/wrangler.json',
	)
	expect(resolved.packageDir).toBe('/tmp/kody-startup-time/origin-vite/ssr')
	expect(resolved.args).toEqual(['--config', 'wrangler.json'])
	expect(resolveStartupTimeCwd(resolved.packageDir)).toBe(
		'/tmp/kody-startup-time/origin-vite/ssr',
	)
	expect(resolveStartupTimeCwd('packages/platform-worker')).toMatch(
		/packages\/platform-worker$/,
	)
})

test('reports only workers whose best sample exceeds the budget', () => {
	const results = [
		{
			name: 'origin' as const,
			bestActiveMs: 120,
			samples: [{ activeMs: 130, garbageCollectionMs: 5, idleMs: 100 }],
			maxActiveMs: 240,
		},
		{
			name: 'runtime' as const,
			bestActiveMs: 190,
			samples: [{ activeMs: 190, garbageCollectionMs: 5, idleMs: 100 }],
			maxActiveMs: 150,
		},
	]
	expect(findStartupBudgetViolations(results).map((r) => r.name)).toEqual([
		'runtime',
	])
	expect(formatStartupTimeResult(results[0]!)).toBe(
		'origin startup active CPU: 120.0 ms best of [130.0] (budget 240 ms)',
	)
})

test('re-samples over-budget workers once after the machine settles', async () => {
	const sample = (activeMs: number) => ({
		activeMs,
		garbageCollectionMs: 5,
		idleMs: 100,
	})
	const origin = {
		name: 'origin' as const,
		bestActiveMs: 120,
		samples: [sample(120)],
		maxActiveMs: 280,
	}
	const runtime = {
		name: 'runtime' as const,
		bestActiveMs: 166,
		samples: [sample(166)],
		maxActiveMs: 160,
	}
	const calls: Array<string> = []
	const results = await resampleStartupBudgetViolations({
		results: [origin, runtime],
		settle: async () => {
			calls.push('settle')
		},
		resample: async (name) => {
			calls.push(name)
			return [sample(90)]
		},
	})
	expect(calls).toEqual(['settle', 'runtime'])
	expect(results[0]).toBe(origin)
	expect(results[1]).toMatchObject({ bestActiveMs: 90 })
	expect(results[1]!.samples.map((entry) => entry.activeMs)).toEqual([166, 90])

	const steady = await resampleStartupBudgetViolations({
		results: [origin],
		settle: async () => {
			throw new Error('no violation: must not wait')
		},
		resample: async () => {
			throw new Error('no violation: must not re-sample')
		},
	})
	expect(steady).toEqual([origin])
})

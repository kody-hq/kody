import { expect, test } from 'vitest'
import {
	packageAppSlowColdRequestLimit,
	percentileMs,
	summarizePackageAppCpuSamples,
	type PackageAppCpuSample,
} from './package-app-cpu-samples.ts'

function sample(
	overrides: Partial<PackageAppCpuSample> & { requestId: string },
): PackageAppCpuSample {
	return {
		occurredAt: '2026-11-07T12:00:00.000Z',
		packageId: 'pkg-a',
		packageName: 'app-a',
		cold: false,
		cpuMs: 1,
		wallMs: 10,
		path: '/',
		status: 200,
		outcome: 'ok',
		...overrides,
	}
}

test('percentileMs uses nearest rank and handles empty input', () => {
	expect(percentileMs([], 50)).toBe(0)
	expect(percentileMs([5], 95)).toBe(5)
	const values = Array.from({ length: 100 }, (_, index) => 100 - index)
	expect(percentileMs(values, 50)).toBe(50)
	expect(percentileMs(values, 95)).toBe(95)
})

test('summarizePackageAppCpuSamples groups per app and lists slowest cold requests', () => {
	const samples = [
		sample({ requestId: 'a1', cpuMs: 2, wallMs: 20 }),
		sample({ requestId: 'a2', cpuMs: 4, wallMs: 40, cold: true }),
		sample({ requestId: 'a3', cpuMs: 6, wallMs: 60 }),
		sample({
			requestId: 'b1',
			packageId: 'pkg-b',
			packageName: 'app-b',
			cpuMs: 30,
			wallMs: 900,
			cold: true,
		}),
	]
	const summary = summarizePackageAppCpuSamples({
		since: '2026-10-31T12:00:00.000Z',
		samples,
	})
	expect(summary.apps).toEqual([
		{
			packageId: 'pkg-b',
			packageName: 'app-b',
			samples: 1,
			coldSamples: 1,
			cpuP50Ms: 30,
			cpuP95Ms: 30,
			wallP50Ms: 900,
			wallP95Ms: 900,
		},
		{
			packageId: 'pkg-a',
			packageName: 'app-a',
			samples: 3,
			coldSamples: 1,
			cpuP50Ms: 4,
			cpuP95Ms: 6,
			wallP50Ms: 40,
			wallP95Ms: 60,
		},
	])
	expect(summary.slowColdRequests.map((entry) => entry.requestId)).toEqual([
		'b1',
		'a2',
	])
	expect(summary.retentionDays).toBe(7)
	expect(summary.warmSampleRate).toBe(0.05)
})

test('slow cold requests are capped', () => {
	const samples = Array.from({ length: 25 }, (_, index) =>
		sample({ requestId: `c${index}`, cold: true, wallMs: index }),
	)
	const summary = summarizePackageAppCpuSamples({ since: '', samples })
	expect(summary.slowColdRequests).toHaveLength(packageAppSlowColdRequestLimit)
	expect(summary.slowColdRequests[0]?.wallMs).toBe(24)
})

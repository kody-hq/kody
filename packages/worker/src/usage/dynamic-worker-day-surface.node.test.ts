import { expect, test } from 'vitest'
import { runSurfaceValues } from '#worker/run-records/types.ts'
import {
	dynamicWorkerDaySurfaceFromRunSurface,
	resolveDynamicWorkerDaySurface,
} from './dynamic-worker-day-surface.ts'

test('every run surface maps to a documented UWD surface', () => {
	expect(dynamicWorkerDaySurfaceFromRunSurface('export')).toBe('package_export')
	expect(dynamicWorkerDaySurfaceFromRunSurface(null)).toBe('unknown')
	expect(dynamicWorkerDaySurfaceFromRunSurface(undefined)).toBe('unknown')

	for (const surface of runSurfaceValues) {
		expect(dynamicWorkerDaySurfaceFromRunSurface(surface)).not.toBe('unknown')
	}
})

test('resolveDynamicWorkerDaySurface infers package_export only when the run surface is missing', () => {
	expect(
		resolveDynamicWorkerDaySurface({
			surface: 'job',
			hasPackageContext: true,
		}),
	).toBe('job')
	expect(
		resolveDynamicWorkerDaySurface({
			surface: null,
			hasPackageContext: true,
		}),
	).toBe('package_export')
	expect(
		resolveDynamicWorkerDaySurface({
			hasPackageContext: false,
		}),
	).toBe('execute')
	expect(
		resolveDynamicWorkerDaySurface({
			surface: null,
			handleSurface: 'subscription',
			hasPackageContext: true,
		}),
	).toBe('subscription')
	expect(
		resolveDynamicWorkerDaySurface({
			runSurface: 'webhook',
			hasPackageContext: true,
		}),
	).toBe('webhook')
})

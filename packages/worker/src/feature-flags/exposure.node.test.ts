import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi, type Mock } from 'vitest'
import { recordFeatureFlagExposures } from './exposure.ts'
import {
	connectionProfilesFlagKey,
	mcpEventsExtensionFlagKey,
} from '#universal/feature-flags/registry.ts'

function exposureEnv(writeDataPoint: Mock) {
	return {
		FLAG_EXPOSURES: { writeDataPoint } as unknown as AnalyticsEngineDataset,
	}
}

test('skips exposure recording without measured flags or a stable user id', async () => {
	const writeDataPoint = vi.fn()
	const batch = vi.fn()

	await recordFeatureFlagExposures(
		{
			...exposureEnv(writeDataPoint),
			APP_DB: { batch } as unknown as D1Database,
		},
		{
			stableUserId: ownerIdFromStored('user-1'),
			evaluations: {
				'demo-indicator': { enabled: true, source: 'global' },
			},
			timestamp: '2026-07-31T00:00:00.000Z',
		},
	)
	expect(writeDataPoint).not.toHaveBeenCalled()
	expect(batch).not.toHaveBeenCalled()

	await recordFeatureFlagExposures(exposureEnv(writeDataPoint), {
		stableUserId: '' as OwnerId,
		evaluations: {
			'demo-indicator': { enabled: true, source: 'default' },
		},
	})
	expect(writeDataPoint).not.toHaveBeenCalled()
})

test('evaluation chokepoint skips dedicated-site flags; dedicated site records them', async () => {
	const writeDataPoint = vi.fn()
	await recordFeatureFlagExposures(exposureEnv(writeDataPoint), {
		stableUserId: ownerIdFromStored('a').repeat(64),
		evaluations: {
			[mcpEventsExtensionFlagKey]: { enabled: true, source: 'global' },
			[connectionProfilesFlagKey]: { enabled: true, source: 'global' },
		},
		recordingSite: 'evaluation',
		timestamp: '2026-09-20T00:00:00.000Z',
	})
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: expect.arrayContaining([connectionProfilesFlagKey, 'on']),
	})

	writeDataPoint.mockClear()
	await recordFeatureFlagExposures(exposureEnv(writeDataPoint), {
		stableUserId: ownerIdFromStored('a').repeat(64),
		evaluations: {
			[mcpEventsExtensionFlagKey]: { enabled: true, source: 'global' },
		},
		recordingSite: 'dedicated',
		timestamp: '2026-09-20T00:00:00.000Z',
	})
	expect(writeDataPoint).toHaveBeenCalledTimes(1)
	expect(writeDataPoint.mock.calls[0]?.[0]).toMatchObject({
		blobs: expect.arrayContaining([mcpEventsExtensionFlagKey, 'on', 'global']),
	})
})

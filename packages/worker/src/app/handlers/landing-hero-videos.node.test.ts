import { expect, test, vi } from 'vitest'
import { loadLandingHeroVideos } from '../landing-hero-videos.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

test('landing hero video data stays available when its source is offline', async () => {
	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockRejectedValue(new Error('offline'))
	await expect(loadLandingHeroVideos({ env: {} as Env })).resolves.toEqual([])
	fetchMock.mockRestore()
})

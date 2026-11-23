import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { listRecommendedAppStarters } from './service.ts'

const mocks = vi.hoisted(() => ({
	listAppStarterRows: vi.fn(),
	getOrgBySlug: vi.fn(),
}))

vi.mock('./repo.ts', () => ({ listAppStarterRows: mocks.listAppStarterRows }))
vi.mock('#worker/orgs/repo.ts', () => ({ getOrgBySlug: mocks.getOrgBySlug }))

const env = { APP_DB: {} } as Env
const row = (packageId: string, rank: number) => ({
	packageId,
	rank,
	enabled: true,
	note: null,
})

test('a stalled starter list read returns no recommendations within the budget', async () => {
	mocks.listAppStarterRows.mockReturnValue(new Promise(() => {}))
	await expect(
		listRecommendedAppStarters(env, { budgetMs: 5 }),
	).resolves.toEqual([])
})

test('a failed batch resolves with the starters validated so far instead of throwing', async () => {
	consoleError.mockImplementation(() => {})
	mocks.listAppStarterRows.mockResolvedValue([row('pkg-1', 1), row('pkg-2', 2)])
	mocks.getOrgBySlug.mockRejectedValue(new Error('database unavailable'))
	await expect(listRecommendedAppStarters(env, { limit: 1 })).resolves.toEqual(
		[],
	)
	expect(consoleError).toHaveBeenCalledWith(
		'app-starters-recommendation-batch-failed',
		expect.any(Error),
	)
})

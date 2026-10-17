import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	client: {},
	invalidate: vi.fn(),
	resources: vi.fn(),
	shell: vi.fn(),
	state: {
		location: { href: '/account' },
		matches: [{ context: { actorKey: 'actor-a' } }],
	},
}))
vi.mock('react', () => ({ useCallback: (callback: unknown) => callback }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.client }))
vi.mock('@tanstack/react-router', () => ({
	useRouter: () => ({ state: mocks.state, invalidate: mocks.invalidate }),
}))
vi.mock('./use-matched-page-scope.ts', () => ({
	useMatchedPageScope: () => ({
		actorKey: 'actor-a',
		orgSlug: null,
		pageLocation: { href: '/account' },
	}),
}))
vi.mock('./page-invalidation-cache.ts', () => ({
	invalidatePageResources: mocks.resources,
}))
vi.mock('./shell-query.ts', () => ({ invalidateShellQueries: mocks.shell }))
import { usePageInvalidation } from './page-invalidation.ts'
beforeEach(() => {
	vi.clearAllMocks()
	mocks.resources.mockResolvedValue(undefined)
	mocks.state.location.href = '/account'
	mocks.state.matches[0]!.context.actorKey = 'actor-a'
})
test('Query-owned writes refresh active data without restarting route loaders', async () => {
	await usePageInvalidation(['loadAccountPage'], { refreshShell: true })()
	expect(mocks.resources).toHaveBeenCalledWith(
		mocks.client,
		'actor-a',
		['loadAccountPage'],
		'active',
		undefined,
	)
	expect(mocks.invalidate).not.toHaveBeenCalled()
	expect(mocks.shell).toHaveBeenCalledWith(mocks.client, 'actor-a')
})
test('action route refresh recognizes a directly opened anchor', async () => {
	mocks.state.location.href = '/account#section'
	await usePageInvalidation(['loadAccountPage'], { refreshRoute: true })()
	expect(mocks.resources).toHaveBeenCalledWith(
		mocks.client,
		'actor-a',
		['loadAccountPage'],
		'none',
		undefined,
	)
	expect(mocks.invalidate).toHaveBeenCalledOnce()
})
test('departed action page still refreshes affected active queries', async () => {
	mocks.state.location.href = '/account/security'
	await usePageInvalidation(['loadAccountPage'], { refreshRoute: true })()
	expect(mocks.resources).toHaveBeenCalledWith(
		mocks.client,
		'actor-a',
		['loadAccountPage'],
		'active',
		undefined,
	)
	expect(mocks.invalidate).not.toHaveBeenCalled()
})
test('navigation during cancellation never refreshes the destination router', async () => {
	mocks.resources.mockImplementationOnce(async () => {
		mocks.state.location.href = '/account/security'
	})
	await usePageInvalidation(['loadAccountPage'], { refreshRoute: true })()
	expect(mocks.resources).toHaveBeenLastCalledWith(
		mocks.client,
		'actor-a',
		['loadAccountPage'],
		'active',
		undefined,
	)
	expect(mocks.invalidate).not.toHaveBeenCalled()
})

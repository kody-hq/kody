import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ match: vi.fn(), router: vi.fn() }))
vi.mock('@tanstack/react-start', () => ({ getRouterInstance: state.router }))
import { rejectUnsupportedRouteMethod } from './route-method-policy.ts'
beforeEach(() => {
	vi.clearAllMocks()
	state.router.mockResolvedValue({ getMatchedRoutes: state.match })
})
test('native boundary reads the exact route metadata before unsupported methods can render', async () => {
	state.match.mockReturnValue([[], {}, { options: {} }])
	const response = await rejectUnsupportedRouteMethod(
		new Request('https://kody.test/verify-email?token=secret', {
			method: 'POST',
		}),
	)
	expect(response?.status).toBe(405)
	expect(state.match).toHaveBeenCalledWith('/verify-email')
})
test('native explicit protocol handlers retain POST and fuzzy matches do not', async () => {
	const route = { options: { server: { handlers: { POST: vi.fn() } } } }
	state.match.mockReturnValue([[], {}, route])
	expect(
		await rejectUnsupportedRouteMethod(
			new Request('https://kody.test/auth', { method: 'POST' }),
		),
	).toBeUndefined()
	state.match.mockReturnValue([[], { '**': 'extra' }, route])
	expect(
		(
			await rejectUnsupportedRouteMethod(
				new Request('https://kody.test/auth/extra', { method: 'POST' }),
			)
		)?.status,
	).toBe(405)
	expect(route.options.server.handlers.POST).not.toHaveBeenCalled()
})
test('ordinary document reads remain allowed', async () => {
	state.match.mockReturnValue([[], {}, { options: {} }])
	expect(
		await rejectUnsupportedRouteMethod(
			new Request('https://kody.test/pricing'),
		),
	).toBeUndefined()
	expect(state.match).toHaveBeenCalledWith('/pricing')
})

test('reads of POST-only protocols return 405 instead of rendering a document', async () => {
	state.match.mockReturnValue([
		[],
		{},
		{ options: { server: { handlers: { POST: vi.fn() } } } },
	])
	for (const method of ['GET', 'HEAD']) {
		const response = await rejectUnsupportedRouteMethod(
			new Request('https://kody.test/auth', { method }),
		)
		expect(response?.status).toBe(405)
		expect(response?.headers.get('Allow')).toBe('POST')
	}
})

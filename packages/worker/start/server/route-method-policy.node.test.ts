import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	match: vi.fn(),
	router: vi.fn(),
	allowReplicaReads: vi.fn(),
}))
vi.mock('../../src/d1-replica-reads.ts', () => ({
	allowReplicaReads: state.allowReplicaReads,
}))
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

test('unknown paths answer 404 to JSON reads before Start can answer 406', async () => {
	state.match.mockReturnValue([[], {}, undefined])
	const response = await rejectUnsupportedRouteMethod(
		new Request('https://kody.test/.well-known/ai-catalog.json', {
			headers: { accept: 'application/json' },
		}),
	)
	expect(response?.status).toBe(404)
	await expect(response?.json()).resolves.toEqual({
		ok: false,
		error: 'Not found.',
	})
	expect(
		await rejectUnsupportedRouteMethod(
			new Request('https://kody.test/.well-known/ai-catalog.json', {
				headers: { accept: 'text/html' },
			}),
		),
	).toBeUndefined()
})

test('only a plain page that passed the method check may read from a replica', async () => {
	const page = new Request('https://kody.test/pricing')
	state.match.mockReturnValue([[], {}, { options: {} }])
	await rejectUnsupportedRouteMethod(page)
	expect(state.allowReplicaReads.mock.calls).toEqual([[page]])

	state.allowReplicaReads.mockClear()
	// Token links and OAuth callbacks have handlers and act on what they read.
	state.match.mockReturnValue([
		[],
		{},
		{ options: { server: { handlers: { GET: vi.fn() } } } },
	])
	await rejectUnsupportedRouteMethod(
		new Request('https://kody.test/verify-email?token=secret'),
	)
	state.match.mockReturnValue([[], { '**': 'extra' }, { options: {} }])
	await rejectUnsupportedRouteMethod(new Request('https://kody.test/x/extra'))
	state.match.mockReturnValue([[], {}, undefined])
	await rejectUnsupportedRouteMethod(new Request('https://kody.test/missing'))
	expect(state.allowReplicaReads).not.toHaveBeenCalled()
})

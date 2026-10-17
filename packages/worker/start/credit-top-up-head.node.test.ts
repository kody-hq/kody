import { expect, test, vi } from 'vitest'
import { createRouter, createMemoryHistory } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import { creditTopUpHead } from './credit-top-up-head.ts'

const router = createRouter({
	origin: 'https://kody.test',
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})

test.each(['/account/usage', '/@example/-/usage'])(
	'%s guards payment probes before the native document loader',
	async (pathname) => {
		const [, , route] = router.getMatchedRoutes(pathname)
		expect(route?.options.server?.middleware).toContain(creditTopUpHead)
		// A method handler cannot defer to a componentless redirect route.
		expect(route?.options.server?.handlers).toBeUndefined()
		const server = creditTopUpHead.options.server!
		for (const [method, search, blocked] of [
			['HEAD', '?topup=success&session_id=cs_payment', true],
			['HEAD', '', false],
			['HEAD', '?topup=success&session_id=%20', false],
			['GET', '?topup=success&session_id=cs_payment', false],
		] as const) {
			const request = new Request(`https://kody.test${pathname}${search}`, {
				method,
			})
			const response = new Response(null, {
				status: 302,
				headers: {
					Location: `/login?redirectTo=${encodeURIComponent(pathname + search)}`,
				},
			})
			const next = vi.fn(async () => ({
				request,
				pathname,
				context: {},
				response,
			}))
			const result = await server({
				request,
				pathname,
				context: undefined,
				handlerType: 'router',
				next: next as Parameters<typeof server>[0]['next'],
			})
			if (blocked) {
				expect(next).not.toHaveBeenCalled()
				expect(result).toBeInstanceOf(Response)
				if (!(result instanceof Response))
					throw new Error('Expected HEAD rejection')
				expect(result.status).toBe(405)
				expect(result.headers.get('Allow')).toBe('GET')
			} else {
				expect(next).toHaveBeenCalledOnce()
				if (result instanceof Response)
					throw new Error('Expected document result')
				expect(result.response).toBe(response)
			}
		}
	},
)

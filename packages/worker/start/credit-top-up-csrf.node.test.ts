import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('#start/server/document-policy', () => ({
	applyDocumentPolicies: vi.fn(),
}))
vi.mock('#start/server/document-actor', () => ({
	verifyBrowserDocument: vi.fn(),
	markRpcResponsePrivate: vi.fn(),
}))
import { startInstance } from './start.ts'
const completion = vi.fn()
beforeEach(() => vi.clearAllMocks())
test.each([
	{
		handlerType: 'router' as const,
		method: 'GET',
		origin: undefined,
		allowed: true,
	},
	{
		handlerType: 'serverFn' as const,
		method: 'POST',
		origin: 'https://kody.test',
		allowed: true,
	},
	{
		handlerType: 'serverFn' as const,
		method: 'POST',
		origin: 'https://evil.test',
		allowed: false,
	},
	{
		handlerType: 'serverFn' as const,
		method: 'POST',
		origin: undefined,
		allowed: false,
	},
])(
	'configured CSRF middleware allows SSR document completion but protects RPC: $handlerType $origin',
	async ({ handlerType, method, origin, allowed }) => {
		const middleware = (await startInstance.getOptions()).requestMiddleware![3]!
		const server = middleware.options.server!
		const request = new Request(
			'https://kody.test/@team/-/usage?topup=success&session_id=cs_1',
			{ method, headers: origin ? { Origin: origin } : {} },
		)
		const next = vi.fn(async () => {
			await completion()
			return {
				request,
				pathname: new URL(request.url).pathname,
				context: {},
				response: new Response('completed'),
			}
		})
		const result = await server({
			request,
			pathname: new URL(request.url).pathname,
			context: undefined,
			handlerType,
			next: next as Parameters<typeof server>[0]['next'],
		})
		if (allowed) {
			expect(next).toHaveBeenCalledOnce()
			expect(completion).toHaveBeenCalledOnce()
		} else {
			expect(next).not.toHaveBeenCalled()
			expect(completion).not.toHaveBeenCalled()
			expect(result).toMatchObject({ status: 403 })
		}
	},
)

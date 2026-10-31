import { expect, test } from 'vitest'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { originWorkerHandler } from './origin-handler.ts'

async function workerFetch(request: Request) {
	const handleFetch = originWorkerHandler.fetch
	if (!handleFetch) throw new Error('Expected the origin fetch handler.')
	const ctx = createExecutionContext()
	const response = await handleFetch(request, env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

test('signed-out /@me requests go to login with a private, uncacheable 302', async () => {
	for (const path of [
		'/@me',
		'/@me/-/profiles?tab=grants',
		'/@ME/-/settings',
		'/@me/packages/daily-notes',
	]) {
		const response = await workerFetch(
			new Request(`https://test.kody.dev${path}`, {
				headers: { Accept: 'text/html' },
			}),
		)
		expect(response.status).toBe(302)
		const location = new URL(
			response.headers.get('Location') ?? '',
			'https://test.kody.dev',
		)
		expect(location.pathname).toBe('/login')
		expect(location.searchParams.get('redirectTo')).toBe(path)
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
		expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
		expect(response.headers.get('Vary')).toBe('Cookie')
	}
})

test('/@me package links resolve before runtime Worker forwarding', async () => {
	const forwarded: Array<string> = []
	const runtimeWorker = {
		fetch: async (input: RequestInfo | URL) => {
			forwarded.push(new Request(input).url)
			return new Response('runtime', { status: 200 })
		},
	} as unknown as Env['RUNTIME_WORKER']
	const handleFetch = originWorkerHandler.fetch
	if (!handleFetch) throw new Error('Expected the origin fetch handler.')
	const ctx = createExecutionContext()
	const response = await handleFetch(
		new Request('https://test.kody.dev/@me/packages/daily-notes', {
			headers: { Accept: 'text/html' },
		}),
		{ ...env, RUNTIME_WORKER: runtimeWorker },
		ctx,
	)
	await waitOnExecutionContext(ctx)
	expect(forwarded).toEqual([])
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'/login?redirectTo=%2F%40me%2Fpackages%2Fdaily-notes',
	)
})

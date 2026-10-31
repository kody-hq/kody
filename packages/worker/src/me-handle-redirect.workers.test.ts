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

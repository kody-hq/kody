import { expect, test, vi } from 'vitest'
import { postAccountPackagesAction } from './account-packages-api.ts'

test('postAccountPackagesAction rejects empty 405 bodies with a clear error', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } }),
		),
	)
	await expect(
		postAccountPackagesAction({ action: 'lock', packageId: 'pkg-1' }),
	).rejects.toThrow(/Request failed \(405\)/)
	vi.unstubAllGlobals()
})

test('postAccountPackagesAction returns JSON domain errors from the API', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: false, error: 'Unauthorized.' }), {
					status: 401,
					headers: { 'content-type': 'application/json' },
				}),
		),
	)
	await expect(
		postAccountPackagesAction({ action: 'lock', packageId: 'pkg-1' }),
	).rejects.toThrow('Unauthorized.')
	vi.unstubAllGlobals()
})

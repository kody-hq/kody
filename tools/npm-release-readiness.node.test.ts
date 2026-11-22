import { expect, test, vi } from 'vitest'
import { waitForNpmPackage } from './npm-release-readiness.ts'

const name = '@kodycodes/dev-runtime'
const version = '1.2.3'
const metadata = () =>
	Response.json({
		versions: {
			[version]: {
				dist: { tarball: 'https://registry.npmjs.org/runtime.tgz' },
			},
		},
	})

function clock() {
	let time = 0
	return {
		now: () => time,
		sleep: async (ms: number) => {
			time += ms
		},
		timeoutMs: 30,
		intervalMs: 10,
	}
}

test('waits for the exact version then downloads its tarball', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(Response.json({ versions: {} }))
		.mockResolvedValueOnce(new Response(null, { status: 404 }))
		.mockResolvedValueOnce(metadata())
		.mockResolvedValueOnce(new Response('tarball'))
	await waitForNpmPackage(name, version, { ...clock(), fetch })
	expect(fetch).toHaveBeenCalledTimes(4)
	expect(String(fetch.mock.calls[0]?.[0])).toContain('registry.npmjs.org')
	expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
		'cache-control': 'no-cache, no-store',
		pragma: 'no-cache',
	})
})

test('times out with the package and exact version when npm never resolves', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockImplementation(async () => Response.json({ versions: {} }))
	await expect(
		waitForNpmPackage(name, version, { ...clock(), fetch }),
	).rejects.toThrow(`${name}@${version}`)
	expect(fetch).toHaveBeenCalledTimes(3)
})

test('keeps waiting when the version is listed but the tarball is 404', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(metadata())
		.mockResolvedValueOnce(new Response(null, { status: 404 }))
		.mockResolvedValueOnce(metadata())
		.mockResolvedValueOnce(new Response('tarball'))
	await waitForNpmPackage(name, version, { ...clock(), fetch })
	expect(fetch).toHaveBeenCalledTimes(4)
})

test('an already published runtime resolves without sleeping', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValueOnce(metadata())
		.mockResolvedValueOnce(new Response('tarball'))
	const sleep = vi.fn()
	await waitForNpmPackage(name, version, { ...clock(), fetch, sleep })
	expect(sleep).not.toHaveBeenCalled()
})

test('retries unreachable registries until the bounded timeout', async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockRejectedValue(new Error('offline'))
	await expect(
		waitForNpmPackage(name, version, { ...clock(), fetch }),
	).rejects.toThrow(`${name}@${version}`)
	expect(fetch).toHaveBeenCalledTimes(3)
})

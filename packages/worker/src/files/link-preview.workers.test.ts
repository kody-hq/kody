import { expect, test, vi } from 'vitest'
import { fetchLinkPreviewTitle } from './link-preview.ts'

test('fetches a public page title without credentials or redirects', async () => {
	const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(
			'<title>Fallback</title><meta property="og:title" content="Project plan">',
			{
				headers: { 'content-type': 'text/html' },
			},
		),
	)
	try {
		await expect(
			fetchLinkPreviewTitle('https://example.com/plan#details'),
		).resolves.toBe('Project plan')
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			new URL('https://example.com/plan'),
			expect.objectContaining({
				redirect: 'manual',
				headers: { accept: 'text/html' },
			}),
		)
		await expect(
			fetchLinkPreviewTitle('https://localhost/plan'),
		).resolves.toBeNull()
		await expect(
			fetchLinkPreviewTitle('https://name:password@example.com/plan'),
		).resolves.toBeNull()
		expect(fetchMock).toHaveBeenCalledTimes(1)
		fetchMock.mockResolvedValueOnce(
			Response.redirect('https://example.com/other'),
		)
		await expect(
			fetchLinkPreviewTitle('https://example.com/plan'),
		).resolves.toBeNull()
		expect(fetchMock).toHaveBeenCalledTimes(2)
	} finally {
		fetchMock.mockRestore()
	}
})

import { afterEach, expect, test, vi } from 'vitest'

const capture = vi.hoisted(() => vi.fn())
vi.mock('./sentry-init.ts', () => ({
	initBrowserSentry: vi.fn(),
	captureBrowserException: capture,
}))

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
	capture.mockClear()
})

test('keeps component stacks with their errors before and after Sentry loads', async () => {
	vi.stubGlobal('window', new EventTarget())
	vi.stubGlobal('requestIdleCallback', vi.fn())
	const { initSentryClient, captureClientException } =
		await import('./sentry-client.ts')
	const doc = {
		querySelector: () => ({
			getAttribute: () =>
				JSON.stringify({
					dsn: 'https://key@o1.ingest.sentry.io/2',
					environment: 'production',
					tunnel: '/sentry-tunnel',
				}),
		}),
	} as unknown as Document
	expect(initSentryClient(doc)).toBe(true)
	const early = new Error('early hydration failure')
	const earlyContext = { componentStack: '\n    at CredentialsFeature' }
	captureClientException(early, earlyContext)
	await vi.waitFor(() =>
		expect(capture).toHaveBeenCalledWith(early, earlyContext),
	)
	const later = new Error('later render failure')
	const laterContext = { componentStack: '\n    at PackagePage' }
	captureClientException(later, laterContext)
	expect(capture).toHaveBeenLastCalledWith(later, laterContext)
	captureClientException(new Error('no React context'))
	expect(capture).toHaveBeenLastCalledWith(expect.any(Error), undefined)
})

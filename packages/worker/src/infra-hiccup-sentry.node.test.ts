import { afterEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	captureMessage: vi.fn(),
	setFingerprint: vi.fn(),
	setTag: vi.fn(),
	setLevel: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	captureMessage: mocks.captureMessage,
	withScope: (callback: (scope: unknown) => void) =>
		callback({
			setLevel: mocks.setLevel,
			setTag: mocks.setTag,
			setFingerprint: mocks.setFingerprint,
		}),
}))

const {
	hashStorageIdForSentry,
	infraHiccupGlobalMaxPerWindow,
	infraHiccupPerFingerprintIntervalMs,
	reportInfraHiccup,
	resetInfraHiccupRateLimitForTests,
} = await import('./infra-hiccup-sentry.ts')

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
	resetInfraHiccupRateLimitForTests()
})

function sentTags() {
	return Object.fromEntries(
		mocks.setTag.mock.calls.map(([key, value]) => [key, value]),
	)
}

test('reports a storage estimate hiccup with tags, fingerprint, and hashed storage id', async () => {
	const storageId = 'package:11111111-2222-3333-4444-555555555555'
	await reportInfraHiccup({
		kind: 'storage_estimate_unavailable',
		operation: 'storage_entitlement_baseline',
		attempts: 4,
		errorClass: 'timeout',
		storageId,
		bucketKind: 'package',
	})
	expect(mocks.captureMessage).toHaveBeenCalledExactlyOnceWith(
		'Infra hiccup: storage_estimate_unavailable (storage_entitlement_baseline, timeout)',
	)
	expect(mocks.setLevel).toHaveBeenCalledWith('warning')
	expect(mocks.setFingerprint).toHaveBeenCalledWith([
		'infra-hiccup',
		'storage_estimate_unavailable',
		'storage_entitlement_baseline',
		'timeout',
	])
	const hash = await hashStorageIdForSentry(storageId)
	expect(hash).toMatch(/^[0-9a-f]{16}$/)
	expect(sentTags()).toEqual({
		infra_hiccup: 'storage_estimate_unavailable',
		'infra_hiccup.operation': 'storage_entitlement_baseline',
		'infra_hiccup.error_class': 'timeout',
		'infra_hiccup.attempts': '4',
		'infra_hiccup.storage_id_hash': hash,
		'infra_hiccup.bucket_kind': 'package',
	})
	expect(JSON.stringify(mocks.setTag.mock.calls)).not.toContain('11111111-2222')
})

test('rate limits per fingerprint and globally so a burst cannot flood Sentry', async () => {
	vi.useFakeTimers()
	const d1 = (operation: string) =>
		reportInfraHiccup({
			kind: 'd1_transient',
			operation,
			attempts: 6,
			errorClass: 'export',
		})
	for (let i = 0; i < 20; i += 1) await d1('packageStorageSet')
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)

	vi.advanceTimersByTime(infraHiccupPerFingerprintIntervalMs)
	await d1('packageStorageSet')
	expect(mocks.captureMessage).toHaveBeenCalledTimes(2)

	mocks.captureMessage.mockClear()
	vi.advanceTimersByTime(infraHiccupPerFingerprintIntervalMs)
	for (let i = 0; i < infraHiccupGlobalMaxPerWindow + 5; i += 1) {
		await d1(`op${String(i)}`)
	}
	expect(mocks.captureMessage).toHaveBeenCalledTimes(
		infraHiccupGlobalMaxPerWindow,
	)
})

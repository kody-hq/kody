import { expect, test, vi } from 'vitest'
import { transientDatabaseUnavailableMessage } from '#worker/d1-retry.ts'
import { respondToRuntimeStorageUnavailable } from '#worker/runtime-worker-storage-unavailable.ts'

const reportInfraHiccup = vi.hoisted(() => vi.fn())
vi.mock('#worker/infra-hiccup-sentry.ts', () => ({ reportInfraHiccup }))

test('a D1 overload while serving a runtime request answers 503 instead of throwing', async () => {
	const response = await respondToRuntimeStorageUnavailable(async () => {
		throw new Error(
			'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.',
		)
	})
	expect(response.status).toBe(503)
	expect(response.headers.get('Retry-After')).toBe('5')
	expect(response.headers.get('Cache-Control')).toBe('no-store')
	expect(await response.text()).toBe(transientDatabaseUnavailableMessage)
	expect(reportInfraHiccup).toHaveBeenCalledWith({
		kind: 'd1_transient',
		operation: 'runtime_worker_fetch',
		attempts: null,
		errorClass: 'overloaded',
	})
})

test('other runtime errors still throw', async () => {
	const failure = new Error('boom')
	await expect(
		respondToRuntimeStorageUnavailable(async () => {
			throw failure
		}),
	).rejects.toBe(failure)
})

test('successful responses pass through', async () => {
	const ok = new Response('ok')
	await expect(
		respondToRuntimeStorageUnavailable(async () => ok),
	).resolves.toBe(ok)
})

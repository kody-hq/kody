import { beforeEach, expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'

const mocks = vi.hoisted(() => ({
	reportInfraHiccup: vi.fn(async (_report: unknown) => undefined),
}))

vi.mock('#worker/infra-hiccup-sentry.ts', () => ({
	reportInfraHiccup: mocks.reportInfraHiccup,
}))

const { toApiError } = await import('./errors.ts')

beforeEach(() => {
	mocks.reportInfraHiccup.mockClear()
})

test('the retryable D1 "briefly unavailable" remap reports an infra hiccup', async () => {
	const exportLock = new Error(
		'D1_ERROR: Currently processing a long-running export',
	)
	const thrown = await runD1WithRetry(
		async () => {
			throw exportLock
		},
		{ maxAttempts: 2, baseDelayMs: 0 },
	).catch((error: unknown) => error)

	const apiError = toApiError(
		new McpCallerError('Package preparation failed.', { cause: thrown }),
		{ operation: 'capability:kody.packageStorageSet' },
	)

	expect(apiError.status).toBe(503)
	expect(mocks.reportInfraHiccup).toHaveBeenCalledExactlyOnceWith({
		kind: 'd1_transient',
		operation: 'capability:kody.packageStorageSet',
		attempts: 2,
		errorClass: 'export',
	})
})

test('caller errors, bad SQL, and limits are not reported as infra hiccups', () => {
	const notReported = [
		new McpCallerError('Job "SQLITE_BUSY" was not found.'),
		new Error('D1_ERROR: no such table: missing: SQLITE_ERROR'),
		new Error('D1_ERROR: near "SELEC": syntax error at offset 0'),
		new McpCallerError('storageSql failed', {
			cause: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'),
		}),
		new EntitlementLimitError({
			resource: 'storage_bytes',
			plan: 'free',
			limit: 100,
			current: 200,
			upgradeHint: 'Delete storage you no longer need.',
		}),
	]
	for (const error of notReported) {
		expect(toApiError(error).status).not.toBe(503)
	}
	expect(mocks.reportInfraHiccup).not.toHaveBeenCalled()
})

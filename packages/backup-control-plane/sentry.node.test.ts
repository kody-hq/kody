import assert from 'node:assert/strict'
import type { CloudflareOptions } from '@sentry/cloudflare'
import { test, vi } from 'vitest'
import type { BackupEnvironment } from './backup-types.ts'

type ErrorEvent = Parameters<NonNullable<CloudflareOptions['beforeSend']>>[0]

const sentryMocks = vi.hoisted(() => {
	const scope = { setFingerprint: vi.fn(), setTag: vi.fn() }
	return {
		scope,
		captureMessage: vi.fn(),
		withScope: vi.fn((callback: (value: typeof scope) => void) =>
			callback(scope),
		),
	}
})

vi.mock('@sentry/cloudflare', () => ({
	withScope: sentryMocks.withScope,
	captureMessage: sentryMocks.captureMessage,
}))

const {
	buildControlPlaneSentryOptions,
	captureFullSealBlocked,
	captureRestExportFailure,
} = await import('./sentry.ts')

test('a REST export failure groups by source and error code, not by day', () => {
	captureRestExportFailure({
		databaseName: 'kody',
		day: '2026-11-17',
		code: 'backup-unrestorable-statements',
	})
	captureRestExportFailure({
		databaseName: 'kody',
		day: '2026-11-18',
		code: 'backup-unrestorable-statements',
	})
	const fingerprints = sentryMocks.scope.setFingerprint.mock.calls.map(
		(call) => call[0],
	)
	assert.deepEqual(fingerprints, [
		['dr', 'rest-d1-export-failed', 'kody:backup-unrestorable-statements'],
		['dr', 'rest-d1-export-failed', 'kody:backup-unrestorable-statements'],
	])
	assert.deepEqual(sentryMocks.captureMessage.mock.calls[0], [
		'REST D1 export failed for kody: backup-unrestorable-statements',
		'error',
	])
	assert.ok(
		sentryMocks.scope.setTag.mock.calls.some(
			(call) => call[0] === 'dr.day' && call[1] === '2026-11-18',
		),
	)
})

test('a blocked full seal is one issue per reason', () => {
	captureFullSealBlocked({ day: '2026-11-17', reason: 'd1-manifest-missing' })
	assert.deepEqual(sentryMocks.scope.setFingerprint.mock.calls[0]?.[0], [
		'dr',
		'full-seal-blocked',
		'd1-manifest-missing',
	])
	assert.deepEqual(sentryMocks.captureMessage.mock.calls[0], [
		'Full DR seal is blocked: d1-manifest-missing',
		'error',
	])
})

test('the SDK capture of a failed workflow step is dropped; other events pass', () => {
	const beforeSend = buildControlPlaneSentryOptions({
		BUILD_COMMIT: 'abc',
	} as BackupEnvironment).beforeSend!
	const stepFailure = {
		type: undefined,
		exception: {
			values: [{ mechanism: { type: 'auto.faas.cloudflare.workflow' } }],
		},
	}
	const other = { type: undefined, message: 'Full DR seal is blocked' }
	assert.equal(beforeSend(stepFailure as ErrorEvent, {}), null)
	assert.equal(beforeSend(other as ErrorEvent, {}), other)
})

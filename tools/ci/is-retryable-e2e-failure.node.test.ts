import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { isRetryableE2eFailure, main } from './is-retryable-e2e-failure.ts'

test('validate E2E retries webServer start/death flakes and fails fast on real specs', () => {
	const previousExitCode = process.exitCode
	const logDir = mkdtempSync(join(tmpdir(), 'retryable-e2e-'))

	const loadCrashLog = [
		'\u001b[2m[WebServer] \u001b[22m\u001b[31merror when starting dev server:',
		'\u001b[2m[WebServer] \u001b[22mReferenceError: __LOAD__ is not defined',
		'\u001b[2m[WebServer] \u001b[22m    at runInRunnerObject (workers/runner-worker/index.js:107:3)',
		'\u001b[2m[WebServer] \u001b[22m    at getWorkerEntryExportTypes (workers/runner-worker/index.js:252:24)',
		'',
		'Error: Process from config.webServer was not able to start. Exit code: 1',
	].join('\n')
	const recoveredLoadThenAssertionLog = [
		'ReferenceError: __LOAD__ is not defined',
		'    at getWorkerEntryExportTypes (workers/runner-worker/index.js:252:24)',
		'  1) [chromium] › e2e/auth.spec.ts:12:1 › signs in',
		'    Error: expect(locator).toHaveText failed',
	].join('\n')
	const midSuiteDeathLog =
		'E2eWebServerDeadError: Playwright webServer (wrangler) is not reachable at http://127.0.0.1:3847'
	const connectionRefusedLog =
		'apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3847'
	const otherPortRefusedLog = 'connect ECONNREFUSED 127.0.0.1:5432'
	const ordinaryAssertionLog = 'Error: expect(locator).toHaveText failed'
	// Vite keeps the webServer process alive across a workerd crash, so the
	// poisoned tests look like ordinary assertions. Still retry once.
	const workerdCrashThenAssertionLog = [
		'[vite] Internal server error: fetch failed',
		'The Workers runtime crashed unexpectedly and is being restarted (crash #1).',
		'  1) [chromium] › e2e/admin-feature-flags.spec.ts:28:1 › admin feature flags',
		'    Error: expect(locator).toBeVisible() failed',
	].join('\n')

	expect(isRetryableE2eFailure(loadCrashLog)).toBe(true)
	expect(isRetryableE2eFailure(recoveredLoadThenAssertionLog)).toBe(false)
	expect(isRetryableE2eFailure(midSuiteDeathLog)).toBe(true)
	expect(isRetryableE2eFailure(connectionRefusedLog)).toBe(true)
	expect(isRetryableE2eFailure(otherPortRefusedLog)).toBe(false)
	expect(isRetryableE2eFailure(ordinaryAssertionLog)).toBe(false)
	expect(isRetryableE2eFailure(workerdCrashThenAssertionLog)).toBe(true)
	expect(
		isRetryableE2eFailure('[vite] Internal server error: fetch failed'),
	).toBe(false)
	expect(isRetryableE2eFailure('')).toBe(false)

	const startLogPath = join(logDir, 'e2e-attempt-1.log')
	writeFileSync(startLogPath, loadCrashLog)
	process.exitCode = undefined
	main([startLogPath])
	expect(process.exitCode).toBe(0)

	const assertionLogPath = join(logDir, 'assertion.log')
	writeFileSync(assertionLogPath, ordinaryAssertionLog)
	process.exitCode = undefined
	main([assertionLogPath])
	expect(process.exitCode).toBe(1)

	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	main([])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'Usage: node tools/ci/is-retryable-e2e-failure.ts <e2e-attempt-log>',
	)

	process.exitCode = previousExitCode
})

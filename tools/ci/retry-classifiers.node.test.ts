import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	isPermanentCloudflareAuthFailure,
	isRetryableCloudflareApiError,
	isRetryableCloudflareFailure,
	isRetryableDeployFailure,
	isRetryableE2eFailure,
	isRetryableWorkersDevSubdomainRace,
	isRetryableWranglerDeployFailure,
	isWranglerD1MigrationsApply,
	main,
	mainDeploy,
	mainE2e,
	runWranglerDeployWithRetry,
	spawnWranglerDeploy,
} from './retry-classifiers.ts'

test('production deploy retries transient Cloudflare flakes and fails fast on real errors', () => {
	const previousExitCode = process.exitCode
	const logDir = mkdtempSync(join(tmpdir(), 'retryable-deploy-'))

	const startupCpuLog = [
		'\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mYour Worker failed validation because it exceeded startup limits.\u001b[0m',
		'',
		'  A request to the Cloudflare API (/accounts/a99ee2e72728dd52902ef288b7b1447d/workers/scripts/kody-platform/versions) failed.',
		'   - Error: Script startup exceeded CPU time limit.',
		'   [code: 10021]',
	].join('\n')
	const internalServerLog =
		'workflows.api.error.internal_server: failed to create workflow'
	const apiAuthFlakeLog =
		'A request to the Cloudflare API (/accounts/acct/workers/scripts/kody-production/versions) failed.\n [code: 10001]'
	const durableObjectMigrationLog = [
		'A request to the Cloudflare API (/accounts/acct/workers/scripts/kody-production/versions) failed.',
		"Cannot apply delete-class migration to class 'AppRunner' which was not exported in the previous version of the script",
		'[code: 10074]',
	].join('\n')
	const secretBulk503Log = [
		'🚨 Secrets failed to upload',
		'',
		'Received a malformed response from the API',
		'',
		'  upstream connect error or disconnect/reset before headers. reset reason: connection termination',
		'  PATCH /accounts/acct/workers/scripts/kody-runtime/secrets-bulk -> 503 Service Unavailable',
	].join('\n')
	const deploymentsList200Log = [
		'✘ [ERROR] Received a malformed response from the API',
		'',
		'  {',
		'    "result": {',
		'      "deployments": [',
		'        {',
		'          "id": "4cb6dc7e-ee4f-4342-beea-6ca7952ac2f1",',
		'    ... (length = 3959)',
		'',
		'  GET /accounts/acct/workers/scripts/kody-platform/deployments -> 200 OK',
	].join('\n')

	const gatewayTimeout504Log = [
		'✘ [ERROR] Received a malformed response from the API',
		'',
		'  GET /accounts/acct/workers/scripts/kody-pr-3501-runtime/deployments -> 504 Gateway Timeout',
	].join('\n')

	expect(isRetryableDeployFailure(startupCpuLog)).toBe(true)
	expect(
		isRetryableDeployFailure('Error: Script startup exceeded CPU time limit.'),
	).toBe(true)
	expect(isRetryableDeployFailure(internalServerLog)).toBe(true)
	expect(isRetryableDeployFailure(apiAuthFlakeLog)).toBe(true)
	expect(isRetryableDeployFailure(secretBulk503Log)).toBe(true)
	expect(isRetryableDeployFailure(deploymentsList200Log)).toBe(true)
	expect(isRetryableDeployFailure(gatewayTimeout504Log)).toBe(true)
	expect(isRetryableDeployFailure('504 Gateway Timeout')).toBe(true)
	expect(isRetryableDeployFailure(durableObjectMigrationLog)).toBe(false)
	expect(isRetryableDeployFailure('')).toBe(false)

	const startupLogPath = join(logDir, 'deploy-platform.log')
	writeFileSync(startupLogPath, startupCpuLog)
	process.exitCode = undefined
	mainDeploy([startupLogPath])
	expect(process.exitCode).toBe(0)

	const migrationLogPath = join(logDir, 'deploy.log')
	writeFileSync(migrationLogPath, durableObjectMigrationLog)
	process.exitCode = undefined
	mainDeploy([migrationLogPath])
	expect(process.exitCode).toBe(1)

	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	mainDeploy([])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'Usage: node tools/ci/retry-classifiers.ts deploy <deploy-log>',
	)

	process.exitCode = previousExitCode
})

test('validate E2E retries webServer start/death flakes and fails fast on real specs', () => {
	const previousExitCode = process.exitCode
	const logDir = mkdtempSync(join(tmpdir(), 'retryable-e2e-'))
	const workflow = readFileSync(
		new URL('../../.github/workflows/validate.yml', import.meta.url),
		'utf8',
	)

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
	expect(workflow).toContain(
		'node tools/ci/retry-classifiers.ts e2e e2e-attempt-1.log',
	)

	const startLogPath = join(logDir, 'e2e-attempt-1.log')
	writeFileSync(startLogPath, loadCrashLog)
	process.exitCode = undefined
	mainE2e([startLogPath])
	expect(process.exitCode).toBe(0)

	const assertionLogPath = join(logDir, 'assertion.log')
	writeFileSync(assertionLogPath, ordinaryAssertionLog)
	process.exitCode = undefined
	mainE2e([assertionLogPath])
	expect(process.exitCode).toBe(1)

	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	mainE2e([])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'Usage: node tools/ci/retry-classifiers.ts e2e <e2e-attempt-log>',
	)

	process.exitCode = undefined
	main([])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'Usage: node tools/ci/retry-classifiers.ts <deploy|e2e> <log-path>',
	)

	process.exitCode = previousExitCode
})

const wranglerD1FetchFailedLog = [
	'▲ [WARNING] A fetch request failed, likely due to a connectivity issue.',
	'',
	'  Common causes:',
	'    - No internet connection or network connectivity problems',
	'',
	'✘ [ERROR] fetch failed',
].join('\n')

test('isRetryableWorkersDevSubdomainRace requires a successful upload then 10007', () => {
	expect(
		isRetryableWorkersDevSubdomainRace(
			'Uploaded kody-pr-2170-highlight\nThis Worker does not exist on your account [code: 10007]',
		),
	).toBe(true)
	expect(
		isRetryableWorkersDevSubdomainRace(
			'This Worker does not exist on your account [code: 10007]',
		),
	).toBe(false)
	expect(isRetryableWorkersDevSubdomainRace('Uploaded kody-pr-1-jobs')).toBe(
		false,
	)
	expect(
		isRetryableWranglerDeployFailure(
			'Received a malformed response from the API\nupstream connect error or disconnect/reset before headers',
		),
	).toBe(true)
	expect(
		isRetryableWranglerDeployFailure(
			'Received a malformed response from the API\nGET /accounts/acct/workers/scripts/kody-platform/deployments -> 200 OK',
		),
	).toBe(true)
	expect(isRetryableWranglerDeployFailure(wranglerD1FetchFailedLog)).toBe(true)
	expect(
		isRetryableWranglerDeployFailure(
			'✘ [ERROR] Migration 0002_add_audit_actor.sql failed: UNIQUE constraint failed',
		),
	).toBe(false)
})

test('isWranglerD1MigrationsApply matches apply and ignores other d1 commands', () => {
	expect(
		isWranglerD1MigrationsApply([
			'd1',
			'migrations',
			'apply',
			'AUDIT_DB',
			'--remote',
		]),
	).toBe(true)
	expect(isWranglerD1MigrationsApply(['d1', 'migrations', 'list'])).toBe(false)
	expect(isWranglerD1MigrationsApply(['d1', 'execute', 'APP_DB'])).toBe(false)
	expect(isWranglerD1MigrationsApply(['deploy'])).toBe(false)
})

test('runWranglerDeployWithRetry retries a 10007 subdomain race then succeeds', async () => {
	const attempts: Array<number> = []
	const result = await runWranglerDeployWithRetry({
		command: 'wrangler',
		args: ['deploy'],
		maxAttempts: 3,
		sleep: async () => {},
		log: () => {},
		run: () => {
			attempts.push(attempts.length + 1)
			if (attempts.length === 1) {
				return {
					status: 1,
					output:
						'Uploaded kody-pr-2163-jobs\nThis Worker does not exist on your account [code: 10007]\n',
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output: 'Uploaded kody-pr-2163-jobs\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([1, 2])
})

test('runWranglerDeployWithRetry backs off 10s+ after a 10007 race and retries the null-tag crash that follows it', async () => {
	const delays: Array<number> = []
	const outputs = [
		'Uploaded kody-pr-3715-highlight\nThis Worker does not exist on your account. [code: 10007]\n',
		"✘ [ERROR] Cannot read properties of null (reading 'tag')\n",
		'Uploaded kody-pr-3715-highlight\n',
	]
	let calls = 0
	const result = await runWranglerDeployWithRetry({
		command: 'wrangler',
		args: ['deploy'],
		sleep: async (ms) => {
			delays.push(ms)
		},
		log: () => {},
		run: () => {
			const output = outputs[calls] ?? ''
			calls += 1
			return { status: calls === 3 ? 0 : 1, output, errorMessage: '' }
		},
	})
	expect(result.status).toBe(0)
	expect(delays).toEqual([10_000, 20_000])
})

test('runWranglerDeployWithRetry does not retry a null-tag crash without a prior 10007 race', async () => {
	let calls = 0
	const result = await runWranglerDeployWithRetry({
		command: 'wrangler',
		args: ['deploy'],
		sleep: async () => {},
		log: () => {},
		run: () => {
			calls += 1
			return {
				status: 1,
				output: "✘ [ERROR] Cannot read properties of null (reading 'tag')\n",
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(calls).toBe(1)
})

test('runWranglerDeployWithRetry retries a D1 fetch-failed flake then succeeds', async () => {
	const attempts: Array<number> = []
	const delays: Array<number> = []
	const result = await runWranglerDeployWithRetry({
		command: 'wrangler',
		args: ['d1', 'migrations', 'apply', 'AUDIT_DB', '--remote'],
		maxAttempts: 3,
		baseDelayMs: 10_000,
		sleep: async (ms) => {
			delays.push(ms)
		},
		log: () => {},
		run: () => {
			attempts.push(attempts.length + 1)
			if (attempts.length === 1) {
				return {
					status: 1,
					output: wranglerD1FetchFailedLog,
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output: '✅ No migrations to apply!\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([1, 2])
	expect(delays).toHaveLength(1)
})

test('runWranglerDeployWithRetry does not retry a genuine missing worker', async () => {
	const attempts: Array<number> = []
	const result = await runWranglerDeployWithRetry({
		command: 'wrangler',
		args: ['deploy'],
		maxAttempts: 3,
		sleep: async () => {},
		log: () => {},
		run: () => {
			attempts.push(attempts.length + 1)
			return {
				status: 1,
				output: 'This Worker does not exist on your account [code: 10007]\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toEqual([1])
})

test('spawnWranglerDeploy captures more than spawnSync maxBuffer without killing', async () => {
	const oversizedBytes = 2 * 1024 * 1024
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback()
		},
	})
	const result = await spawnWranglerDeploy(
		process.execPath,
		[
			'-e',
			`process.stdout.write('x'.repeat(${String(oversizedBytes)})); process.stderr.write('Uploaded kody\\n')`,
		],
		undefined,
		{ stdout: sink, stderr: sink },
	)
	expect(result.status).toBe(0)
	expect(result.output.includes('Uploaded kody')).toBe(true)
	expect(result.output.length).toBeGreaterThan(1024 * 1024)
})

test('Cloudflare API and message classifiers match the prior resource-utils cases', () => {
	const cases: Array<[(value: string) => boolean, string, boolean]> = [
		[isRetryableCloudflareFailure, 'Gateway Timeout [code: 504]', true],
		[isRetryableCloudflareFailure, '✘ [ERROR] fetch failed', true],
		[
			isRetryableCloudflareFailure,
			'▲ [WARNING] A fetch request failed, likely due to a connectivity issue.\n✘ [ERROR] fetch failed',
			true,
		],
		[
			isRetryableCloudflareFailure,
			'This Worker does not exist on your account [code: 10007]',
			false,
		],
		[
			isRetryableCloudflareFailure,
			'Received a malformed response from the API\nGET /accounts/acct/workers/scripts/kody-platform/deployments -> 200 OK',
			true,
		],
		[
			isPermanentCloudflareAuthFailure,
			'Authentication error [code: 10000]',
			true,
		],
		[
			isPermanentCloudflareAuthFailure,
			'Cloudflare API request failed (500): Internal authentication error: internal server error',
			false,
		],
		[
			isPermanentCloudflareAuthFailure,
			'Cloudflare API request failed (403): Authentication error',
			true,
		],
		[
			isPermanentCloudflareAuthFailure,
			'Cloudflare API request failed (403): Internal authentication error',
			true,
		],
		[
			isPermanentCloudflareAuthFailure,
			'Cloudflare API request failed (401): Internal authentication error',
			true,
		],
		[
			isRetryableCloudflareFailure,
			'Cloudflare API request failed (500): Internal authentication error: internal server error',
			true,
		],
		[
			isRetryableCloudflareFailure,
			'✘ [ERROR] Internal authentication error: internal server error',
			true,
		],
		[
			isRetryableCloudflareFailure,
			'Cloudflare API request failed (403): Internal authentication error',
			false,
		],
	]
	expect(cases.filter(([fn, value, want]) => fn(value) !== want)).toEqual([])

	const apiErrors: Array<[string, boolean]> = [
		[
			'Malformed Cloudflare response (502) for /queues: upstream connect error or disconnect/reset before headers. reset reason: connection termination',
			true,
		],
		['Cloudflare API request failed (400): invalid queue name', false],
		[
			'Malformed Cloudflare response (200) for /workers/scripts/kody-runtime: --boundary',
			false,
		],
		['Cloudflare API request failed (429): Rate limited', true],
		['Cloudflare API request failed (403): Authentication error', false],
		['Cloudflare API request failed (401): unauthorized', false],
		[
			'Cloudflare API request failed (500): Internal authentication error: internal server error',
			true,
		],
		[
			'Cloudflare API request failed (403): Internal authentication error',
			false,
		],
	]
	expect(
		apiErrors.filter(
			([message, want]) =>
				isRetryableCloudflareApiError(new Error(message)) !== want,
		),
	).toEqual([])
})

import { expect, test } from 'vitest'
import {
	nxFailedTasksAreRemoteCacheOnly,
	nxPlaywrightSuitePassed,
	nxRunReportedTaskFailure,
	nxTaskPrintedSuccess,
	nxTasksSucceededDespiteRemoteCacheFailure,
	runNxWithRemoteCacheFallback,
} from './run-nx.ts'

const remoteCacheServer = 'https://nx-cache.kody.codes'

const usableProbe = async ({ server }: { server: string }) => ({
	server,
	health: 'ok' as const,
	read: 'ok' as const,
	write: 'ok' as const,
})

const cacheRejectedAsFailedTaskAfterSuccess = `
✔  nx run worker:typecheck  [remote cache]
✔  nx run highlight-worker:typecheck

 NX   Running target typecheck for 12 projects and 3 tasks they depend on failed

Failed tasks:

- highlight-worker:typecheck

Misconfigured remote cache endpoint: Unexpected response status: 404 Not Found
`

/**
 * Validate #44965301568: Playwright printed an all-pass summary, then Nx
 * marked worker:test-e2e ❌ because GET /v1/cache returned 500. No ✔ line.
 */
const e2ePassedThenCache500 = `
${String.fromCharCode(0x1b)}[32m  73 passed${String.fromCharCode(0x1b)}[39m${String.fromCharCode(0x1b)}[2m (8.6m)${String.fromCharCode(0x1b)}[22m
##[notice]  73 passed (8.6m)

##[group]❌ ${String.fromCharCode(0x1b)}[2m> ${String.fromCharCode(0x1b)}[22m${String.fromCharCode(0x1b)}[2mnx run${String.fromCharCode(0x1b)}[22m worker:test-e2e

Misconfigured remote cache endpoint: Unexpected response status: 500 Internal Server Error
##[endgroup]

 NX  Running target test-e2e for project worker and 2 tasks it depends on failed

Failed tasks:

- worker:test-e2e

  Cache:             1/2 hit (50%)
`

const e2eFailedThenCache500 = `
  1 failed
    [chromium] › e2e/example.spec.ts:1:1 › a real assertion
  72 passed (8.6m)

##[group]❌ > nx run worker:test-e2e

Misconfigured remote cache endpoint: Unexpected response status: 500 Internal Server Error
##[endgroup]

 NX  Running target test-e2e for project worker and 2 tasks it depends on failed

Failed tasks:

- worker:test-e2e
`

const e2eTeardownErrorThenCache500 = `
  73 passed (8.6m)
  1 error was not a part of any test, see above for details

##[group]❌ > nx run worker:test-e2e

Misconfigured remote cache endpoint: Unexpected response status: 500 Internal Server Error
##[endgroup]

 NX  Running target test-e2e for project worker and 2 tasks it depends on failed

Failed tasks:

- worker:test-e2e
`

const e2eDidNotRunThenCache500 = `
  2 did not run
  71 passed (8.6m)

##[group]❌ > nx run worker:test-e2e

Misconfigured remote cache endpoint: Unexpected response status: 500 Internal Server Error
##[endgroup]

 NX  Running target test-e2e for project worker and 2 tasks it depends on failed

Failed tasks:

- worker:test-e2e
`

test('a Playwright all-pass summary counts as success for test-e2e', () => {
	expect(nxPlaywrightSuitePassed(e2ePassedThenCache500)).toBe(true)
	expect(nxTaskPrintedSuccess(e2ePassedThenCache500, 'worker:test-e2e')).toBe(
		true,
	)
	expect(nxTaskPrintedSuccess(e2ePassedThenCache500, 'worker:typecheck')).toBe(
		false,
	)
	expect(nxFailedTasksAreRemoteCacheOnly(e2ePassedThenCache500)).toBe(true)
	expect(nxRunReportedTaskFailure(e2ePassedThenCache500)).toBe(false)
	expect(nxTasksSucceededDespiteRemoteCacheFailure(e2ePassedThenCache500)).toBe(
		true,
	)
})

test('a Playwright failure next to a cache 500 stays a real task failure', () => {
	expect(nxPlaywrightSuitePassed(e2eFailedThenCache500)).toBe(false)
	expect(nxFailedTasksAreRemoteCacheOnly(e2eFailedThenCache500)).toBe(false)
	expect(nxRunReportedTaskFailure(e2eFailedThenCache500)).toBe(true)
	expect(nxTasksSucceededDespiteRemoteCacheFailure(e2eFailedThenCache500)).toBe(
		false,
	)
})

test('a Playwright worker teardown error next to a cache 500 stays a real task failure', () => {
	expect(nxPlaywrightSuitePassed(e2eTeardownErrorThenCache500)).toBe(false)
	expect(nxFailedTasksAreRemoteCacheOnly(e2eTeardownErrorThenCache500)).toBe(
		false,
	)
	expect(nxRunReportedTaskFailure(e2eTeardownErrorThenCache500)).toBe(true)
	expect(
		nxTasksSucceededDespiteRemoteCacheFailure(e2eTeardownErrorThenCache500),
	).toBe(false)
})

test('Playwright tests that did not run next to a cache 500 stay a real task failure', () => {
	expect(nxPlaywrightSuitePassed(e2eDidNotRunThenCache500)).toBe(false)
	expect(nxFailedTasksAreRemoteCacheOnly(e2eDidNotRunThenCache500)).toBe(false)
	expect(nxRunReportedTaskFailure(e2eDidNotRunThenCache500)).toBe(true)
})

test('a listed task with a success mark is still a cache-only failure', () => {
	expect(
		nxFailedTasksAreRemoteCacheOnly(cacheRejectedAsFailedTaskAfterSuccess),
	).toBe(true)
	expect(nxRunReportedTaskFailure(cacheRejectedAsFailedTaskAfterSuccess)).toBe(
		false,
	)
})

test('runNxWithRemoteCacheFallback treats a post-success e2e cache 500 as success', async () => {
	const attempts: Array<ReadonlyArray<string>> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-e2e'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
		},
		log: (line) => {
			logs.push(line)
		},
		probe: usableProbe,
		run: (args) => {
			attempts.push(args)
			return {
				status: 1,
				output: e2ePassedThenCache500,
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([['run', 'worker:test-e2e']])
	expect(logs.join('\n')).toMatch(/after tasks succeeded/)
})

test('runNxWithRemoteCacheFallback does not retry a Playwright failure with a cache 500', async () => {
	const attempts: Array<number> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-e2e'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
		},
		log: (line) => {
			logs.push(line)
		},
		probe: usableProbe,
		run: () => {
			attempts.push(attempts.length + 1)
			return {
				status: 1,
				output: e2eFailedThenCache500,
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toEqual([1])
	expect(logs.join('\n')).not.toMatch(/treating the run as successful/)
})

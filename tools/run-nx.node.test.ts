import { Writable } from 'node:stream'
import { expect, test } from 'vitest'
import {
	isNxRemoteCacheDegradableFailure,
	isNxRemoteCacheRejected,
	isNxRemoteCacheTransportFailure,
	nxFailedTasksAreRemoteCacheOnly,
	nxRunReportedFailedTasks,
	nxRunReportedTaskFailure,
	nxTasksSucceededDespiteRemoteCacheFailure,
	runNxWithRemoteCacheFallback,
	spawnNx,
} from './run-nx.ts'
import { type probeNxRemoteCache } from './nx-remote-cache-probe.ts'

const cacheTransportFailure = `
 NX  Successfully ran target test-node for project worker

1 skipped

 NX  Failed to send request: error sending request for url (https://nx-cache.kody.codes/v1/cache/6563052018947667317)
`

const cacheTransportFailureBeforeTasks = `
 NX  Failed to send request: error sending request for url (https://nx-cache.kody.codes/v1/cache/6563052018947667317)

Pass --verbose to see the stacktrace.
`

const cacheRejectedAfterTasks = `
 NX   Successfully ran target typecheck for project worker

12 skipped

 NX   Misconfigured remote cache endpoint: Requests should respond with text/plain on 401s

Pass --verbose to see the stacktrace.
`

const cacheRejectedBeforeTasks = `
 NX   Misconfigured remote cache endpoint: Requests should respond with text/plain on 401s

Pass --verbose to see the stacktrace.
`

const cacheRejectedAsFailedTaskAfterSuccess = `
✔  nx run worker:typecheck  [remote cache]
✔  nx run highlight-worker:typecheck

 NX   Running target typecheck for 12 projects and 3 tasks they depend on failed

Failed tasks:

- highlight-worker:typecheck

Output of 15 successful tasks were not shown. Run with --verbose or --output-style=static to see it.

  Cache:             14/14 hit (100%)

Misconfigured remote cache endpoint: Unexpected response status: 404 Not Found
`

const cacheUnauthorizedAfterTasks = `
 NX   Successfully ran target typecheck for project worker

 \u001b[31mNX\u001b[39m   Unauthorized: Unauthorized
`

const remoteCacheServer = 'https://nx-cache.kody.codes'

const usableProbe: typeof probeNxRemoteCache = async ({ server }) => ({
	server,
	health: 'ok',
	read: 'ok',
	write: 'ok',
})

test('isNxRemoteCacheTransportFailure requires the Nx request error and cache path', () => {
	expect(isNxRemoteCacheTransportFailure(cacheTransportFailure)).toBe(true)
	expect(
		isNxRemoteCacheTransportFailure(
			'Failed to send request: error sending request for url (https://example.com/health)',
		),
	).toBe(false)
	expect(
		isNxRemoteCacheTransportFailure(
			'GET https://nx-cache.kody.codes/v1/cache/abc returned 404',
		),
	).toBe(false)
	expect(nxTasksSucceededDespiteRemoteCacheFailure(cacheTransportFailure)).toBe(
		true,
	)
	expect(
		nxTasksSucceededDespiteRemoteCacheFailure(cacheTransportFailureBeforeTasks),
	).toBe(false)
	expect(isNxRemoteCacheRejected(cacheTransportFailure)).toBe(false)
	expect(isNxRemoteCacheTransportFailure(cacheRejectedAfterTasks)).toBe(false)
	expect(isNxRemoteCacheRejected(cacheRejectedAfterTasks)).toBe(true)
	expect(isNxRemoteCacheRejected(cacheUnauthorizedAfterTasks)).toBe(true)
	expect(isNxRemoteCacheDegradableFailure(cacheRejectedBeforeTasks)).toBe(true)
	expect(
		isNxRemoteCacheRejected(
			'AssertionError: expected 401 Unauthorized access denied',
		),
	).toBe(false)
	expect(
		nxTasksSucceededDespiteRemoteCacheFailure(cacheRejectedAfterTasks),
	).toBe(true)
	expect(
		nxTasksSucceededDespiteRemoteCacheFailure(cacheRejectedBeforeTasks),
	).toBe(false)
	const mixedFailure = `${cacheRejectedAfterTasks}\nFailed tasks:\n\n- other:typecheck\n`
	expect(nxRunReportedFailedTasks(mixedFailure)).toBe(true)
	expect(nxFailedTasksAreRemoteCacheOnly(mixedFailure)).toBe(false)
	expect(nxRunReportedTaskFailure(mixedFailure)).toBe(true)
	expect(nxTasksSucceededDespiteRemoteCacheFailure(mixedFailure)).toBe(false)
	expect(
		nxFailedTasksAreRemoteCacheOnly(cacheRejectedAsFailedTaskAfterSuccess),
	).toBe(true)
	expect(nxRunReportedTaskFailure(cacheRejectedAsFailedTaskAfterSuccess)).toBe(
		false,
	)
	expect(
		nxTasksSucceededDespiteRemoteCacheFailure(
			cacheRejectedAsFailedTaskAfterSuccess,
		),
	).toBe(true)
	expect(
		nxRunReportedFailedTasks(
			'Tasks stopped before they finished:\n\n- worker:typecheck',
		),
	).toBe(false)
	expect(
		nxRunReportedTaskFailure(
			'Tasks stopped before they finished:\n\n- worker:typecheck',
		),
	).toBe(true)
})

test('runNxWithRemoteCacheFallback treats a post-success cache transport flake as success', async () => {
	const attempts: Array<ReadonlyArray<string>> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
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
				output: cacheTransportFailure,
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([['run', 'worker:test-node']])
	expect(logs.join('\n')).toMatch(/after tasks succeeded/)
})

test('runNxWithRemoteCacheFallback retries once without the remote cache when tasks never finished', async () => {
	const attempts: Array<{
		args: ReadonlyArray<string>
		hasServer: boolean
	}> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
			CI: '1',
		},
		log: () => {},
		probe: usableProbe,
		run: (args, env) => {
			attempts.push({
				args,
				hasServer: Boolean(env?.NX_SELF_HOSTED_REMOTE_CACHE_SERVER),
			})
			if (attempts.length === 1) {
				return {
					status: 1,
					output: cacheTransportFailureBeforeTasks,
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output: ' NX  Successfully ran target test-node for project worker\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([
		{ args: ['run', 'worker:test-node'], hasServer: true },
		{
			args: ['run', 'worker:test-node', '--skipRemoteCache'],
			hasServer: false,
		},
	])
})

test('runNxWithRemoteCacheFallback does not retry a real task failure', async () => {
	const attempts: Array<number> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
		},
		log: () => {},
		probe: usableProbe,
		run: () => {
			attempts.push(attempts.length + 1)
			return {
				status: 1,
				output: 'AssertionError: expected true to be false\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toEqual([1])
})

test('spawnNx captures stdout from the local nx binary', async () => {
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback()
		},
	})
	const result = await spawnNx(['--version'], undefined, {
		stdout: sink,
		stderr: sink,
	})
	expect(result.status).toBe(0)
	expect(result.output).toMatch(/\d+\.\d+\.\d+/)
})

test('runNxWithRemoteCacheFallback reports whether the token writes next to the Nx hit count', async () => {
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run-many', '-t', 'typecheck'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'https://nx-cache.kody.codes',
			NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'read-token',
		},
		log: (line) => {
			logs.push(line)
		},
		run: () => ({
			status: 0,
			output:
				'\n NX   Successfully ran target typecheck for 9 projects\n\nCache:             0/12 hit (0%)\n',
			errorMessage: '',
		}),
		probe: async ({ server, token }) => ({
			server,
			health: 'ok',
			read: 'ok',
			write: token === 'read-token' ? 'read-only' : 'ok',
		}),
	})
	expect(result.status).toBe(0)
	expect(logs).toEqual([
		expect.stringMatching(
			/^Nx remote cache enabled \(https:\/\/nx-cache\.kody\.codes\) READ-ONLY: .* Cache: {13}0\/12 hit \(0%\)$/,
		),
	])
})

test('runNxWithRemoteCacheFallback stays quiet when no remote cache is configured', async () => {
	const logs: Array<string> = []
	await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {},
		log: (line) => {
			logs.push(line)
		},
		run: () => ({
			status: 0,
			output: 'Cache: 1/1 hit (100%)',
			errorMessage: '',
		}),
		probe: async () => {
			throw new Error('probe must not run without a server')
		},
	})
	expect(logs).toEqual([])
})

test('runNxWithRemoteCacheFallback reports a local retry as skipped instead of probing', async () => {
	const logs: Array<string> = []
	let attempts = 0
	let probes = 0
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: 'https://nx-cache.kody.codes',
			NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'write-token',
		},
		log: (line) => {
			logs.push(line)
		},
		run: () => {
			attempts += 1
			if (attempts === 1) {
				return {
					status: 1,
					output: cacheTransportFailureBeforeTasks,
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output:
					' NX  Successfully ran target test-node for project worker\n\nCache:             0/1 hit (0%)\n',
				errorMessage: '',
			}
		},
		probe: async ({ server }) => {
			probes += 1
			if (probes > 1) {
				throw new Error(
					'probe must not speak for a run that skipped the remote cache',
				)
			}
			return {
				server,
				health: 'ok' as const,
				read: 'ok' as const,
				write: 'ok' as const,
			}
		},
	})
	expect(result.status).toBe(0)
	expect(logs).toEqual([
		'Nx remote cache request failed before tasks finished; retrying without the remote cache.',
		expect.stringMatching(
			/^Nx remote cache skipped \(https:\/\/nx-cache\.kody\.codes\): .*nothing was uploaded\. Cache: {13}0\/1 hit \(0%\)$/,
		),
	])
	expect(probes).toBe(1)
})

test('runNxWithRemoteCacheFallback treats a 401 misconfigured cache as success when tasks passed', async () => {
	const attempts: Array<ReadonlyArray<string>> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run-many', '-t', 'typecheck'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
			NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'stale-token',
		},
		log: (line) => {
			logs.push(line)
		},
		probe: usableProbe,
		run: (args) => {
			attempts.push(args)
			return {
				status: 1,
				output: cacheRejectedAfterTasks,
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([['run-many', '-t', 'typecheck']])
	expect(logs).toEqual([
		'Nx remote cache rejected the token after tasks succeeded; treating the run as successful.',
		expect.stringMatching(
			/^Nx remote cache skipped \(https:\/\/nx-cache\.kody\.codes\): the token was rejected after tasks succeeded/,
		),
	])
})

test('runNxWithRemoteCacheFallback retries a 401 that lands before tasks finish', async () => {
	const attempts: Array<{
		args: ReadonlyArray<string>
		hasServer: boolean
	}> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
			NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'stale-token',
		},
		log: (line) => {
			logs.push(line)
		},
		probe: usableProbe,
		run: (args, env) => {
			attempts.push({
				args,
				hasServer: Boolean(env?.NX_SELF_HOSTED_REMOTE_CACHE_SERVER),
			})
			if (attempts.length === 1) {
				return {
					status: 1,
					output: cacheRejectedBeforeTasks,
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output:
					' NX  Successfully ran target test-node for project worker\n\nCache:             0/1 hit (0%)\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([
		{ args: ['run', 'worker:test-node'], hasServer: true },
		{
			args: ['run', 'worker:test-node', '--skipRemoteCache'],
			hasServer: false,
		},
	])
	expect(logs[0]).toBe(
		'Nx remote cache rejected the token before tasks finished; retrying without the remote cache.',
	)
})

test('runNxWithRemoteCacheFallback treats an Nx Unauthorized cache error as success when tasks passed', async () => {
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run-many', '-t', 'typecheck'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
		},
		log: (line) => {
			logs.push(line)
		},
		probe: usableProbe,
		run: () => ({
			status: 1,
			output: cacheUnauthorizedAfterTasks,
			errorMessage: '',
		}),
	})
	expect(result.status).toBe(0)
	expect(logs.join('\n')).toMatch(/rejected the token after tasks succeeded/)
})

test('runNxWithRemoteCacheFallback unsets an unusable remote cache before Nx starts', async () => {
	const env = {
		NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
		NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'revoked-token',
		PATH: '/usr/bin',
	}
	const attempts: Array<{ hasServer: boolean; hasToken: boolean }> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run-many', '-t', 'typecheck'],
		env,
		log: (line) => {
			logs.push(line)
		},
		probe: async ({ server, token }) => ({
			server,
			health: 'ok',
			read: token === 'revoked-token' ? 'unauthorized' : 'ok',
			write: 'skipped',
		}),
		run: (args, runEnv) => {
			attempts.push({
				hasServer: Boolean(runEnv?.NX_SELF_HOSTED_REMOTE_CACHE_SERVER),
				hasToken: Boolean(runEnv?.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN),
			})
			expect(args).toEqual(['run-many', '-t', 'typecheck'])
			return {
				status: 0,
				output:
					'\n NX   Successfully ran target typecheck for 9 projects\n\nCache:             0/12 hit (0%)\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([{ hasServer: false, hasToken: true }])
	expect(env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER).toBe(remoteCacheServer)
	expect(logs).toEqual([
		expect.stringMatching(
			/^Nx remote cache skipped: https:\/\/nx-cache\.kody\.codes rejected the token on GET \(unauthorized\); running with the local cache only\. Cache: {13}0\/12 hit \(0%\)$/,
		),
	])
})

test('runNxWithRemoteCacheFallback still fails a real task error when the cache token is rejected', async () => {
	const attempts: Array<number> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
			NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'revoked-token',
		},
		log: () => {},
		probe: async ({ server }) => ({
			server,
			health: 'ok',
			read: 'unauthorized',
			write: 'skipped',
		}),
		run: () => {
			attempts.push(attempts.length + 1)
			return {
				status: 1,
				output: 'AssertionError: expected 401 Unauthorized access denied\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toEqual([1])
})

test('runNxWithRemoteCacheFallback treats a post-success cache 404 attributed as Failed tasks as success', async () => {
	const attempts: Array<ReadonlyArray<string>> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run-many', '-t', 'typecheck'],
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
				output: cacheRejectedAsFailedTaskAfterSuccess,
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([['run-many', '-t', 'typecheck']])
	expect(logs.join('\n')).toMatch(/after tasks succeeded/)
})

test('runNxWithRemoteCacheFallback keeps a failed exit when another target failed beside the cache error', async () => {
	const attempts: Array<number> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run-many', '-t', 'typecheck'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
			NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'stale-token',
		},
		log: (line) => {
			logs.push(line)
		},
		probe: usableProbe,
		run: () => {
			attempts.push(attempts.length + 1)
			return {
				status: 1,
				output: `${cacheRejectedAfterTasks}\n NX   Running target typecheck for 2 projects failed\n\nFailed tasks:\n\n- other:typecheck\n`,
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toEqual([1])
	expect(logs.join('\n')).not.toMatch(/treating the run as successful/)
})

test('runNxWithRemoteCacheFallback retries when the cache stops tasks before they finish', async () => {
	const attempts: Array<{
		args: ReadonlyArray<string>
		hasServer: boolean
	}> = []
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run-many', '-t', 'typecheck'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
			NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'stale-token',
		},
		log: (line) => {
			logs.push(line)
		},
		probe: usableProbe,
		run: (args, env) => {
			attempts.push({
				args,
				hasServer: Boolean(env?.NX_SELF_HOSTED_REMOTE_CACHE_SERVER),
			})
			if (attempts.length === 1) {
				return {
					status: 1,
					output: `${cacheRejectedBeforeTasks}\nTasks stopped before they finished:\n\n- worker:typecheck\n`,
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output:
					' NX  Successfully ran target typecheck for project worker\n\nCache:             0/1 hit (0%)\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([
		{ args: ['run-many', '-t', 'typecheck'], hasServer: true },
		{
			args: ['run-many', '-t', 'typecheck', '--skipRemoteCache'],
			hasServer: false,
		},
	])
	expect(logs[0]).toMatch(/retrying without the remote cache/)
})

test('runNxWithRemoteCacheFallback reports the post-run write probe when the token changes mid-run', async () => {
	let probes = 0
	const logs: Array<string> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run-many', '-t', 'typecheck'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
			NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: 'write-token',
		},
		log: (line) => {
			logs.push(line)
		},
		probe: async ({ server }) => {
			probes += 1
			return {
				server,
				health: 'ok' as const,
				read: 'ok' as const,
				write: probes === 1 ? ('ok' as const) : ('read-only' as const),
			}
		},
		run: () => ({
			status: 0,
			output:
				'\n NX   Successfully ran target typecheck for 9 projects\n\nCache:             0/12 hit (0%)\n',
			errorMessage: '',
		}),
	})
	expect(result.status).toBe(0)
	expect(probes).toBe(2)
	expect(logs).toEqual([expect.stringMatching(/READ-ONLY: PUT returned 403/)])
})

test('runNxWithRemoteCacheFallback does not degrade a task failure that only mentions 401', async () => {
	const attempts: Array<number> = []
	const result = await runNxWithRemoteCacheFallback({
		args: ['run', 'worker:test-node'],
		env: {
			NX_SELF_HOSTED_REMOTE_CACHE_SERVER: remoteCacheServer,
		},
		log: () => {},
		probe: usableProbe,
		run: () => {
			attempts.push(attempts.length + 1)
			return {
				status: 1,
				output: 'AssertionError: expected 401 Unauthorized access denied\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toEqual([1])
})

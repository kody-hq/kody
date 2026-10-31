import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
	runNpmCiWithRetry,
	spawnNpmCiShellOption,
} from './npm-ci-with-retry.ts'
import { isRetryableNpmInstallFailure } from './retry-classifiers.ts'

const setupAction = readFileSync(
	new URL('../../.github/actions/setup-validate/action.yml', import.meta.url),
	'utf8',
)

const econnresetLog = [
	'npm warn ERESOLVE overriding peer dependency',
	'npm error code ECONNRESET',
	'npm error network aborted',
	'npm error network This is a problem related to network connectivity.',
	'npm error network In most cases you are behind a proxy or have bad network settings.',
].join('\n')

test('isRetryableNpmInstallFailure retries registry transport blips only', () => {
	expect(isRetryableNpmInstallFailure(econnresetLog)).toBe(true)
	expect(
		isRetryableNpmInstallFailure(
			'npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/vite failed',
		),
	).toBe(true)
	expect(isRetryableNpmInstallFailure('npm error network aborted')).toBe(true)
	expect(isRetryableNpmInstallFailure('socket hang up')).toBe(true)
	expect(
		isRetryableNpmInstallFailure(
			'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
		),
	).toBe(false)
	expect(isRetryableNpmInstallFailure('npm error code EBADDEVENGINES')).toBe(
		false,
	)
	expect(isRetryableNpmInstallFailure('npm error code EINTEGRITY')).toBe(false)
	expect(isRetryableNpmInstallFailure('npm error code E404')).toBe(false)
	expect(
		isRetryableNpmInstallFailure('npm error code ERESOLVE\nnpm error network'),
	).toBe(false)
	expect(
		isRetryableNpmInstallFailure('npm warn ERESOLVE overriding peer'),
	).toBe(false)
	expect(isRetryableNpmInstallFailure('')).toBe(false)
})

test('setup-validate retries npm ci through the pre-install helper', () => {
	expect(setupAction).toContain('node tools/ci/npm-ci-with-retry.ts')
	expect(setupAction).toContain(
		'node tools/ci/npm-ci-with-retry.ts --prefer-online',
	)
	expect(setupAction).not.toMatch(/^\s+npm ci(?: --prefer-online)?$/m)
})

test('spawnNpmCi uses a shell only on Windows so npm.cmd can launch', () => {
	expect(spawnNpmCiShellOption('win32')).toBe(true)
	expect(spawnNpmCiShellOption('linux')).toBe(false)
	expect(spawnNpmCiShellOption('darwin')).toBe(false)
})

test('runNpmCiWithRetry retries ECONNRESET once then succeeds', async () => {
	const sleeps: Array<number> = []
	const logs: Array<string> = []
	const extraArgsSeen: Array<ReadonlyArray<string>> = []
	let attempt = 0
	const result = await runNpmCiWithRetry({
		extraArgs: ['--prefer-online'],
		maxAttempts: 3,
		baseDelayMs: 1_000,
		sleep: async (ms) => {
			sleeps.push(ms)
		},
		log: (line) => {
			logs.push(line)
		},
		run: async (extraArgs) => {
			extraArgsSeen.push(extraArgs)
			attempt += 1
			if (attempt === 1) {
				return { status: 1, output: econnresetLog }
			}
			return { status: 0, output: 'added 1 package' }
		},
	})
	expect(result).toEqual({ status: 0, output: 'added 1 package' })
	expect(attempt).toBe(2)
	expect(sleeps).toEqual([1_000])
	expect(extraArgsSeen).toEqual([['--prefer-online'], ['--prefer-online']])
	expect(logs[0]).toContain('retrying (attempt 2/3)')
})

test('runNpmCiWithRetry does not retry lockfile or engine failures', async () => {
	let attempt = 0
	const result = await runNpmCiWithRetry({
		sleep: async () => {
			throw new Error('must not sleep')
		},
		run: async () => {
			attempt += 1
			return {
				status: 1,
				output:
					'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempt).toBe(1)
})

test('runNpmCiWithRetry returns the last failure after the attempt budget', async () => {
	let attempt = 0
	const result = await runNpmCiWithRetry({
		maxAttempts: 3,
		baseDelayMs: 100,
		sleep: async () => {},
		log: () => {},
		run: async () => {
			attempt += 1
			return { status: 1, output: econnresetLog }
		},
	})
	expect(result.status).toBe(1)
	expect(attempt).toBe(3)
})

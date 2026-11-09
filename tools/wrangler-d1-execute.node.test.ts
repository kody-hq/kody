import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
} from '@kody-internal/shared/d1-retry.ts'
import {
	executeWranglerD1,
	runWranglerD1,
	type WranglerD1SpawnInput,
	type WranglerD1SpawnResult,
} from './wrangler-d1-execute.ts'

const sql = 'SELECT name FROM d1_migrations ORDER BY name;'

function jsonResult(results: Array<Record<string, unknown>>) {
	return JSON.stringify([{ results, success: true }])
}

test('executeWranglerD1 pins mode, config, persist-to, and WRANGLER_LOG', () => {
	const calls: Array<WranglerD1SpawnInput> = []
	const rows = executeWranglerD1({
		binding: 'APP_DB',
		sql,
		mode: '--local',
		config: 'packages/worker/wrangler.jsonc',
		persistTo: '.wrangler/state',
		envFilePath: 'missing.env',
		env: { WRANGLER_LOG: 'warn', OTHER: 'kept' },
		spawnImpl: (input) => {
			calls.push(input)
			return {
				status: 0,
				stdout: jsonResult([{ name: '0001-squashed-init.sql' }]),
				stderr: '',
			}
		},
	})

	expect(rows).toEqual([{ name: '0001-squashed-init.sql' }])
	expect(calls).toHaveLength(1)
	expect(calls[0]?.args).toEqual([
		'./wrangler-env.ts',
		'd1',
		'execute',
		'APP_DB',
		'--json',
		'--command',
		sql,
		'--local',
		'--config',
		'packages/worker/wrangler.jsonc',
		'--persist-to',
		'.wrangler/state',
	])
	expect(calls[0]?.env.WRANGLER_LOG).toBe('log')
	expect(calls[0]?.env.OTHER).toBe('kept')
	expect(calls[0]?.execPath).toBe(process.execPath)
})

test('remote execute omits config and persist-to when the caller does not set them', () => {
	let args: ReadonlyArray<string> = []
	executeWranglerD1({
		binding: 'AUDIT_DB',
		sql: 'SELECT 1;',
		mode: '--remote',
		envFilePath: 'missing.env',
		spawnImpl: (input) => {
			args = input.args
			return { status: 0, stdout: jsonResult([]), stderr: '' }
		},
	})
	expect(args).toEqual([
		'./wrangler-env.ts',
		'd1',
		'execute',
		'AUDIT_DB',
		'--json',
		'--command',
		'SELECT 1;',
		'--remote',
	])
})

test('runWranglerD1 forwards non-execute d1 arguments with the same target flags', () => {
	let args: ReadonlyArray<string> = []
	const result = runWranglerD1(
		{
			mode: '--remote',
			config: 'packages/worker/wrangler.jsonc',
			envFilePath: 'missing.env',
			spawnImpl: (input) => {
				args = input.args
				return { status: 0, stdout: 'bookmark', stderr: '' }
			},
		},
		['time-travel', 'info', 'APP_DB'],
	)
	expect(result).toEqual({ status: 0, stdout: 'bookmark', stderr: '' })
	expect(args).toEqual([
		'./wrangler-env.ts',
		'd1',
		'time-travel',
		'info',
		'APP_DB',
		'--remote',
		'--config',
		'packages/worker/wrangler.jsonc',
	])
})

test('an existing env file is passed to node before wrangler-env', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'kody-d1-env-'))
	const envFilePath = path.join(directory, '.env')
	await writeFile(envFilePath, 'EXAMPLE=1\n')
	try {
		let args: ReadonlyArray<string> = []
		executeWranglerD1({
			binding: 'APP_DB',
			sql: 'SELECT 1;',
			mode: '--local',
			cwd: directory,
			envFilePath,
			spawnImpl: (input) => {
				args = input.args
				return { status: 0, stdout: jsonResult([]), stderr: '' }
			},
		})
		expect(args[0]).toBe(`--env-file=${envFilePath}`)
		expect(args[1]).toBe('./wrangler-env.ts')
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('non-zero exit and bad JSON fail with the SQL and output', () => {
	const failures: Array<[WranglerD1SpawnResult, string]> = [
		[{ status: 2, stdout: '', stderr: 'boom' }, 'exit 2'],
		[{ status: null, stdout: '', stderr: 'spawn ENOENT' }, 'exit null'],
		[{ status: 0, stdout: 'not-json', stderr: '' }, 'Unexpected wrangler'],
		[{ status: 0, stdout: '[]', stderr: '' }, 'output shape'],
		[
			{
				status: 0,
				stdout: JSON.stringify([{ success: true }]),
				stderr: '',
			},
			'output shape',
		],
		[
			{
				status: 0,
				stdout: JSON.stringify([{ results: [], success: false }]),
				stderr: 'd1 said no',
			},
			'success: false',
		],
		[
			{
				status: 0,
				stdout: JSON.stringify([{ results: ['nope'], success: true }]),
				stderr: '',
			},
			'output shape',
		],
	]
	for (const [spawned, needle] of failures) {
		expect(() =>
			executeWranglerD1({
				binding: 'APP_DB',
				sql,
				mode: '--local',
				persistTo: '.wrangler/state',
				envFilePath: 'missing.env',
				spawnImpl: () => spawned,
			}),
		).toThrow(needle)
	}

	try {
		executeWranglerD1({
			binding: 'APP_DB',
			sql,
			mode: '--local',
			envFilePath: 'missing.env',
			spawnImpl: () => ({ status: 1, stdout: '', stderr: 'secret-context' }),
		})
		throw new Error('expected execute to throw')
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		expect(message).toContain(sql)
		expect(message).toContain('secret-context')
	}
})

test('executeWranglerD1 retries SQLITE_BUSY then returns rows', () => {
	const calls: Array<WranglerD1SpawnInput> = []
	const delays: Array<number> = []
	const busy: WranglerD1SpawnResult = {
		status: 1,
		stdout: '',
		stderr: 'database is locked: SQLITE_BUSY (extended: SQLITE_BUSY_RECOVERY)',
	}
	const rows = executeWranglerD1({
		binding: 'APP_DB',
		sql,
		mode: '--local',
		persistTo: '.wrangler/state/e2e',
		envFilePath: 'missing.env',
		sleep: (ms) => delays.push(ms),
		spawnImpl: (input) => {
			calls.push(input)
			if (calls.length === 1) return busy
			return {
				status: 0,
				stdout: jsonResult([{ name: '0001-squashed-init.sql' }]),
				stderr: '',
			}
		},
	})
	expect(rows).toEqual([{ name: '0001-squashed-init.sql' }])
	expect(calls).toHaveLength(2)
	expect(delays).toEqual([d1LockRetryBaseDelayMs])
})

test('executeWranglerD1 does not retry a permanent execute failure', () => {
	let calls = 0
	expect(() =>
		executeWranglerD1({
			binding: 'APP_DB',
			sql,
			mode: '--local',
			envFilePath: 'missing.env',
			sleep: () => {
				throw new Error('sleep should not run')
			},
			spawnImpl: () => {
				calls += 1
				return { status: 1, stdout: '', stderr: 'no such table' }
			},
		}),
	).toThrow('no such table')
	expect(calls).toBe(1)
})

test('executeWranglerD1 does not retry when only the submitted SQL mentions SQLITE_BUSY', () => {
	let calls = 0
	expect(() =>
		executeWranglerD1({
			binding: 'APP_DB',
			sql: "SELECT 'SQLITE_BUSY' AS name;",
			mode: '--local',
			envFilePath: 'missing.env',
			sleep: () => {
				throw new Error('sleep should not run')
			},
			spawnImpl: () => {
				calls += 1
				return { status: 1, stdout: '', stderr: 'no such table' }
			},
		}),
	).toThrow('no such table')
	expect(calls).toBe(1)
})

test('executeWranglerD1 exhausts SQLITE_BUSY retries then throws', () => {
	let calls = 0
	const delays: Array<number> = []
	expect(() =>
		executeWranglerD1({
			binding: 'APP_DB',
			sql,
			mode: '--local',
			envFilePath: 'missing.env',
			sleep: (ms) => delays.push(ms),
			spawnImpl: () => {
				calls += 1
				return {
					status: 1,
					stdout: '',
					stderr: 'database is locked: SQLITE_BUSY',
				}
			},
		}),
	).toThrow('SQLITE_BUSY')
	expect(calls).toBe(d1LockRetryMaxAttempts)
	expect(delays).toEqual(
		Array.from(
			{ length: d1LockRetryMaxAttempts - 1 },
			(_, index) => d1LockRetryBaseDelayMs * 2 ** index,
		),
	)
})

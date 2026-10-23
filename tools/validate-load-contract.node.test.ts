import { expect, test } from 'vitest'
import {
	saturatedSuiteMemoryBytes,
	saturatedSuiteParallelism,
	serialValidateCommand,
	validateConcurrency,
	validateLegsByWeight,
} from './validate-gate.ts'
import { failedValidateLegNames, runValidate } from './run-validate.ts'

/**
 * Small machines run one suite leg and one build leg at a time so those
 * CI-sized legs do not exhaust a 4-core VM.
 */
const GiB = 1024 * 1024 * 1024

test('4-core 16GB gate runs one suite and one build at a time', () => {
	const slots = validateConcurrency({
		availableParallelism: 4,
		totalMemoryBytes: 16 * GiB,
	})
	const grouped = validateLegsByWeight()
	expect(slots.suite).toBe(1)
	expect(slots.build).toBe(1)
	expect(slots.check).toBe(4)
	expect(grouped.suite.length).toBeGreaterThan(1)
	expect(grouped.build.length).toBeGreaterThan(1)
	expect(grouped.suite.map((leg) => leg.name)).toEqual([
		'typecheck',
		'test-node',
		'test-workers',
		'e2e',
		'mcp',
	])
})

test('4 cores stay capped when RAM is large', () => {
	const slots = validateConcurrency({
		availableParallelism: saturatedSuiteParallelism,
		totalMemoryBytes: 64 * GiB,
	})
	expect(slots.suite).toBe(1)
	expect(slots.build).toBe(1)
})

test('8-core machine at the memory floor does not cap pools', () => {
	const slots = validateConcurrency({
		availableParallelism: saturatedSuiteParallelism + 4,
		totalMemoryBytes: saturatedSuiteMemoryBytes,
	})
	expect(slots).toEqual({
		suite: undefined,
		build: undefined,
		check: undefined,
	})
})

test('8 cores under the memory floor still cap suite and build legs', () => {
	const slots = validateConcurrency({
		availableParallelism: 8,
		totalMemoryBytes: saturatedSuiteMemoryBytes - 1,
	})
	expect(slots.suite).toBe(1)
	expect(slots.build).toBe(1)
	expect(slots.check).toBe(8)
})

test('small machine skips the startup-time check after a suite failure', async () => {
	const pools: Array<{
		names: Array<string>
		maxProcesses: number | undefined
	}> = []
	let serialRan = false
	const lines: Array<string> = []
	const status = await runValidate({
		availableParallelism: 4,
		totalMemoryBytes: 16 * GiB,
		log: (line) => {
			lines.push(line)
		},
		runPool: async (pool) => {
			pools.push({
				names: pool.legs.map((leg) => leg.name),
				maxProcesses: pool.maxProcesses,
			})
			const failed = pool.legs.some((leg) => leg.name === 'typecheck')
			return { ok: !failed, failed: failed ? ['typecheck'] : [] }
		},
		runSerial: async () => {
			serialRan = true
			return 0
		},
	})
	expect(status).toBe(1)
	expect(serialRan).toBe(false)
	expect(lines.at(-1)).toBe('validate: failed legs: typecheck')
	expect(pools).toEqual([
		{
			names: ['typecheck', 'test-node', 'test-workers', 'e2e', 'mcp'],
			maxProcesses: 1,
		},
		{
			names: [
				'backup-build',
				'status-build',
				'nx-cache-build',
				'jobs-build',
				'highlight-build',
				'push-queue-build',
				'api-build',
				'api-docs-build',
				'runtime-build',
				'platform-build',
				'startup',
				'knip',
				'cli',
			],
			maxProcesses: 1,
		},
		{
			names: pools[2]?.names,
			maxProcesses: 4,
		},
	])
	expect(pools[2]?.names).toContain('format')
	expect(pools[2]?.names).not.toContain('typecheck')
	expect(pools[2]?.names).not.toContain('knip')
})

test('a passing small-machine gate still runs the startup-time check', async () => {
	const serial: Array<string> = []
	const status = await runValidate({
		availableParallelism: 4,
		totalMemoryBytes: 16 * GiB,
		log: () => {},
		runPool: async () => ({ ok: true, failed: [] }),
		runSerial: async (command) => {
			serial.push(command)
			return 0
		},
	})
	expect(status).toBe(0)
	expect(serial).toEqual([serialValidateCommand])
})

test('failed pool events name the legs that exited non-zero', () => {
	expect(
		failedValidateLegNames([
			{ exitCode: 0, command: { name: 'format' } },
			{ exitCode: 1, command: { name: 'typecheck' } },
		]),
	).toEqual(['typecheck'])
	expect(() => failedValidateLegNames('nope')).toThrow(/close-event list/)
	expect(
		failedValidateLegNames([
			{ exitCode: null, command: { name: 'typecheck' } },
		]),
	).toEqual(['typecheck'])
	expect(failedValidateLegNames([{ exitCode: 0 }])).toEqual(['validate-pool'])
})

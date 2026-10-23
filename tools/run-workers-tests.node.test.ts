import { expect, test } from 'vitest'
import { workersUnitTestArgs } from './run-workers-tests.ts'

test('local Workers suites are unsharded; CI shards use the Vitest CLI', () => {
	expect(workersUnitTestArgs(undefined)).toEqual([
		'run',
		'--project',
		'workers-unit',
	])
	expect(workersUnitTestArgs('')).toEqual(workersUnitTestArgs(undefined))
	expect(workersUnitTestArgs('2/2')).toEqual([
		'run',
		'--project',
		'workers-unit',
		'--shard',
		'2/2',
	])
	expect(() => workersUnitTestArgs('3/2')).toThrow('Invalid CI shard')
})

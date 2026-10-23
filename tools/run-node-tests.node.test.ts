import { expect, test } from 'vitest'
import { nodeUnitTestArgs } from './run-node-tests.ts'

test('local Node suites are unsharded; CI shards use the Vitest CLI', () => {
	expect(nodeUnitTestArgs(undefined)).toEqual(['run', '--project', 'node-unit'])
	expect(nodeUnitTestArgs('')).toEqual(nodeUnitTestArgs(undefined))
	expect(nodeUnitTestArgs('2/2')).toEqual([
		'run',
		'--project',
		'node-unit',
		'--shard',
		'2/2',
	])
	expect(() => nodeUnitTestArgs('3/2')).toThrow('Invalid CI shard')
})

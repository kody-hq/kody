import { expect, test } from 'vitest'
import { parseCiShard } from './ci-shard.ts'

test('local runs are unsharded and CI shards are validated', () => {
	expect(parseCiShard(undefined)).toBeUndefined()
	expect(parseCiShard('')).toBeUndefined()
	expect(parseCiShard('2/6')).toEqual({ current: 2, total: 6 })
	expect(parseCiShard('1/1')).toEqual({ current: 1, total: 1 })
})

test.each(['0/6', '7/6', '1/0', '-1/2', '1.5/2', '2', '1/2/3', 'a/b'])(
	'rejects invalid shard %s',
	(value) => {
		expect(() => parseCiShard(value)).toThrow('Invalid CI shard')
	},
)

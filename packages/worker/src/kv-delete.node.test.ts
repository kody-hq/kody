import { expect, test } from 'vitest'
import { deleteKvKeys } from './kv-delete.ts'

test('deleteKvKeys deletes every key with bounded parallelism', async () => {
	const keys = Array.from({ length: 60 }, (_, index) => `key-${index}`)
	const deleted: Array<string> = []
	let active = 0
	let maxActive = 0
	const kv = {
		async delete(key: string) {
			active += 1
			maxActive = Math.max(maxActive, active)
			await new Promise((resolve) => setTimeout(resolve, 1))
			deleted.push(key)
			active -= 1
		},
	} as KVNamespace

	await deleteKvKeys(kv, keys)

	expect(deleted.sort()).toEqual(keys.sort())
	expect(maxActive).toBeGreaterThan(1)
	expect(maxActive).toBeLessThanOrEqual(25)
})

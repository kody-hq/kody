/**
 * Key-value contract for `packageStorage()`. Hosted (the StorageRunner Durable
 * Object) and local (`kody dev`, the same StorageRunner on the local workers)
 * both run these steps in order against a fresh bucket, so prefix listing,
 * clear, overwrite and delete behave the same in both places.
 */

export type StorageKvContractEntry = { key: string; value: unknown }

export type StorageKvContractDriver = {
	get: (key: string) => Promise<unknown>
	set: (key: string, value: unknown) => Promise<void>
	/** Whether a value was removed. */
	delete: (key: string) => Promise<boolean>
	list: (input?: { prefix?: string }) => Promise<Array<StorageKvContractEntry>>
	clear: () => Promise<void>
}

export type StorageKvContractStep =
	| { op: 'set'; key: string; value: unknown }
	| { op: 'get'; key: string; expect: unknown }
	| { op: 'delete'; key: string; expect: boolean }
	| { op: 'list'; prefix?: string; expect: Array<StorageKvContractEntry> }
	| { op: 'clear' }

export const storageKvContractSteps: Array<StorageKvContractStep> = [
	{ op: 'list', expect: [] },
	{ op: 'get', key: 'missing', expect: null },
	{ op: 'set', key: 'notes/2', value: [1, 2, 3] },
	{ op: 'set', key: 'notes/1', value: { text: 'first', done: false } },
	{ op: 'set', key: 'alpha', value: 'one' },
	{ op: 'set', key: 'notesx', value: 7 },
	{ op: 'get', key: 'notes/1', expect: { text: 'first', done: false } },
	{
		op: 'list',
		prefix: 'notes/',
		expect: [
			{ key: 'notes/1', value: { text: 'first', done: false } },
			{ key: 'notes/2', value: [1, 2, 3] },
		],
	},
	{
		op: 'list',
		expect: [
			{ key: 'alpha', value: 'one' },
			{ key: 'notes/1', value: { text: 'first', done: false } },
			{ key: 'notes/2', value: [1, 2, 3] },
			{ key: 'notesx', value: 7 },
		],
	},
	{ op: 'list', prefix: 'zzz', expect: [] },
	{ op: 'set', key: 'alpha', value: 'uno' },
	{ op: 'get', key: 'alpha', expect: 'uno' },
	{ op: 'delete', key: 'alpha', expect: true },
	{ op: 'delete', key: 'alpha', expect: false },
	{ op: 'get', key: 'alpha', expect: null },
	{ op: 'clear' },
	{ op: 'list', expect: [] },
	{ op: 'get', key: 'notes/1', expect: null },
	{ op: 'set', key: 'after-clear', value: true },
	{ op: 'list', expect: [{ key: 'after-clear', value: true }] },
]

/** Runs every step and returns what each one produced next to what it expects. */
export async function runStorageKvContract(driver: StorageKvContractDriver) {
	const results: Array<{ step: string; actual: unknown; expected: unknown }> =
		[]
	for (const [index, step] of storageKvContractSteps.entries()) {
		const label = `${index}: ${step.op}${'key' in step ? ` ${step.key}` : ''}${'prefix' in step && step.prefix !== undefined ? ` prefix=${step.prefix}` : ''}`
		switch (step.op) {
			case 'set':
				await driver.set(step.key, step.value)
				break
			case 'clear':
				await driver.clear()
				break
			case 'get':
				results.push({
					step: label,
					actual: await driver.get(step.key),
					expected: step.expect,
				})
				break
			case 'delete':
				results.push({
					step: label,
					actual: await driver.delete(step.key),
					expected: step.expect,
				})
				break
			case 'list':
				results.push({
					step: label,
					actual: await driver.list(
						step.prefix === undefined ? undefined : { prefix: step.prefix },
					),
					expected: step.expect,
				})
				break
		}
	}
	return results
}

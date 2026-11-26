import { mapWithConcurrency } from './concurrency.ts'

const kvDeleteConcurrency = 25

export async function deleteKvKeys(
	kv: KVNamespace,
	keys: ReadonlyArray<string>,
) {
	await mapWithConcurrency(keys, kvDeleteConcurrency, async (key) => {
		await kv.delete(key)
	})
}

export async function deleteKvKeysByPrefix(input: {
	kv: KVNamespace
	prefix: string
	afterPageDeleted?: (keys: ReadonlyArray<string>) => void
}) {
	let deleted = 0
	let cursor: string | undefined
	do {
		const page = await input.kv.list({ prefix: input.prefix, cursor })
		const keys = page.keys.map((key) => key.name)
		const outOfScope = keys.find((key) => !key.startsWith(input.prefix))
		if (outOfScope) {
			throw new Error(`KV listing returned out-of-scope key: ${outOfScope}`)
		}
		await deleteKvKeys(input.kv, keys)
		input.afterPageDeleted?.(keys)
		deleted += keys.length
		cursor = page.list_complete ? undefined : page.cursor
	} while (cursor)
	return deleted
}

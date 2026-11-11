import { expect, test } from 'vitest'
import {
	readApiRequestProgress,
	recordApiRequestProgress,
	runWithApiRequestProgress,
} from './request-progress.ts'

function createKv() {
	const store = new Map<string, string>()
	const kv = {
		async put(key: string, value: string) {
			store.set(key, value)
		},
		async get(key: string, type?: string) {
			const value = store.get(key)
			if (value === undefined) return null
			return type === 'json' ? JSON.parse(value) : value
		},
	}
	return { store, env: { BUNDLE_ARTIFACTS_KV: kv } as unknown as Env }
}

const progress = {
	packageName: '@danj/audible',
	fileCount: 178,
	totalBytes: 1_960_000,
	maxFiles: 2_000,
	maxTotalBytes: 32 * 1024 * 1024,
}

test('reads back the last step a request recorded', async () => {
	const { env } = createKv()
	await runWithApiRequestProgress(
		{ env, requestId: 'a58d7375e847dfaf' },
		async () => {
			await recordApiRequestProgress({ ...progress, step: 'checks' })
			await recordApiRequestProgress({
				...progress,
				step: 'artifact_reuse_scan',
			})
		},
	)
	expect(
		await readApiRequestProgress({ env, requestId: 'a58d7375e847dfaf' }),
	).toEqual({ ...progress, step: 'artifact_reuse_scan' })
	expect(await readApiRequestProgress({ env, requestId: 'other' })).toBeNull()
})

test('records nothing outside an API request or for an unsafe request id', async () => {
	const { env, store } = createKv()
	await recordApiRequestProgress({ ...progress, step: 'checks' })
	await runWithApiRequestProgress(
		{ env, requestId: 'not a ray id: x' },
		async () => {
			await recordApiRequestProgress({ ...progress, step: 'checks' })
		},
	)
	await runWithApiRequestProgress({ env, requestId: null }, async () => {
		await recordApiRequestProgress({ ...progress, step: 'checks' })
	})
	expect(store.size).toBe(0)
})

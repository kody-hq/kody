import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	MemoryBucket,
	backupError,
} from './backup-control-plane-test-support.ts'
import { retryingR2Bucket } from './r2-retry.ts'

const internalError = () =>
	new Error('put: We encountered an internal error. Please try again. (10001)')

function flakyBucket(failures: Array<() => Error>) {
	const memory = new MemoryBucket()
	let calls = 0
	const bucket = {
		async put(key: string, value: ReadableStream | string) {
			calls += 1
			const failure = failures.shift()
			if (failure) throw failure()
			return memory.put(key, value)
		},
		async head(key: string) {
			calls += 1
			const failure = failures.shift()
			if (failure) throw failure()
			return memory.head(key)
		},
	} as unknown as R2Bucket
	return {
		memory,
		bucket: retryingR2Bucket(bucket, { baseDelayMs: 0 }),
		calls: () => calls,
	}
}

test('a transient R2 10001 is retried and the put then succeeds', async () => {
	const flaky = flakyBucket([internalError])
	const result = await flaky.bucket.put('daily/full/k', 'body')
	assert.ok(result)
	assert.equal(flaky.calls(), 2)
	assert.equal(await (await flaky.memory.get('daily/full/k'))?.text(), 'body')
})

test('a persistent R2 platform error surfaces as r2-platform-error after the bounded attempts', async () => {
	const flaky = flakyBucket([
		internalError,
		() => new Error('head: Service is temporarily unavailable. (10043)'),
		internalError,
		internalError,
	])
	await assert.rejects(flaky.bucket.head('daily/full/k'), (error: unknown) => {
		assert.ok(backupError('r2-platform-error', true)(error))
		assert.match(
			(error as Error).message,
			/after 3 attempts: put: .*\(10001\)$/,
		)
		return true
	})
	assert.equal(flaky.calls(), 3)
})

test('non-retryable R2 and logical errors are not retried', async () => {
	for (const failure of [
		() => new Error('put: The object is locked by the bucket policy. (10069)'),
		() => new Error('simulated logical failure'),
	]) {
		const flaky = flakyBucket([failure])
		await assert.rejects(flaky.bucket.put('daily/full/k', 'body'), (error) => {
			assert.equal((error as Error).message, failure().message)
			return true
		})
		assert.equal(flaky.calls(), 1)
	}
})

test('a streamed put is not replayed after a transient error', async () => {
	const flaky = flakyBucket([internalError])
	await assert.rejects(
		flaky.bucket.put('daily/full/k', new Response('body').body!),
		/\(10001\)$/,
	)
	assert.equal(flaky.calls(), 1)
})

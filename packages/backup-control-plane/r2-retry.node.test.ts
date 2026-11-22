import assert from 'node:assert/strict'

import { backupR2RetryMaxAttempts } from '@kody-internal/shared/backup-r2-retry.ts'
import { test, vi } from 'vitest'

import {
	MemoryBucket,
	backupError,
} from './backup-control-plane-test-support.ts'
import { BackupError } from './backup-policy.ts'
import { retryingR2Bucket } from './r2-retry.ts'

const internalError = () =>
	new Error('put: We encountered an internal error. Please try again. (10001)')

function flakyBucket(
	failures: Array<() => Error>,
	options: { baseDelayMs?: number } = { baseDelayMs: 0 },
) {
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
		bucket: retryingR2Bucket(bucket, options),
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
		() => new Error('head: Service is temporarily unavailable. (10043)'),
		...Array.from({ length: backupR2RetryMaxAttempts }, () => internalError),
	])
	await assert.rejects(flaky.bucket.head('daily/full/k'), (error: unknown) => {
		assert.ok(backupError('r2-platform-error', true)(error))
		assert.match(
			(error as Error).message,
			new RegExp(
				`after ${backupR2RetryMaxAttempts} attempts: put: .*\\(10001\\)$`,
			),
		)
		return true
	})
	assert.equal(flaky.calls(), backupR2RetryMaxAttempts)
})

test('the default schedule rides out a multi-second R2 internal-error burst on head', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
	try {
		const flaky = flakyBucket(
			Array.from({ length: backupR2RetryMaxAttempts - 1 }, () => internalError),
			{},
		)
		await flaky.memory.put('daily/full/k', 'body')
		const startedAt = Date.now()
		const head = flaky.bucket.head('daily/full/k')
		await vi.runAllTimersAsync()
		assert.equal((await head)?.key, 'daily/full/k')
		assert.equal(flaky.calls(), backupR2RetryMaxAttempts)
		// Equal jitter floors the five waits at 125 + 250 + 500 + 1000 + 2000 ms.
		assert.ok(Date.now() - startedAt >= 3875)
	} finally {
		vi.useRealTimers()
	}
})

test('non-retryable R2 and logical errors are not retried', async () => {
	for (const failure of [
		() => new Error('put: The object is locked by the bucket policy. (10069)'),
		() => new Error('simulated logical failure'),
		() =>
			new Error(
				'Too many API requests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits',
			),
		() =>
			new BackupError('r2-call-budget-exhausted', 'R2 call budget is spent'),
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

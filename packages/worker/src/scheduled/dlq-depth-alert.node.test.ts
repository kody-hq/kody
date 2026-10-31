import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	checkDlqDepthAndAlert,
	classifyDlqDepth,
	dlqDepthAlertKvKeyPrefix,
	dlqDepthSustainedMs,
	productionDeadLetterQueueNames,
} from './dlq-depth-alert.ts'

const mocks = vi.hoisted(() => ({
	rawRequest: vi.fn(),
	captureMessage: vi.fn(),
	setFingerprint: vi.fn(),
}))

vi.mock('@sentry/cloudflare', () => ({
	captureMessage: mocks.captureMessage,
	withScope: (callback: (scope: unknown) => void) =>
		callback({
			setLevel() {},
			setTag() {},
			setContext() {},
			setFingerprint: mocks.setFingerprint,
		}),
}))

vi.mock('#mcp/cloudflare/cloudflare-rest-client.ts', () => {
	class CloudflareApiError extends Error {
		readonly status: number
		constructor(message: string, options: { status: number }) {
			super(message)
			this.name = 'CloudflareApiError'
			this.status = options.status
		}
	}
	return {
		CloudflareApiError,
		createCloudflareRestClient: () => ({ rawRequest: mocks.rawRequest }),
	}
})

const now = new Date('2026-10-16T12:00:00.000Z')
const stuckQueue = 'kody-webhook-dispatch-dlq'
type Sample = {
	backlogCount: number
	oldestMessageTimestampMs: number | null
	status?: number
}

function memoryKv() {
	const values = new Map<string, string>()
	return {
		values,
		kv: {
			get: async (key: string) => values.get(key) ?? null,
			put: async (key: string, value: string) => {
				values.set(key, value)
			},
			delete: async (key: string) => {
				values.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

function productionEnv(kv: KVNamespace) {
	return {
		SENTRY_ENVIRONMENT: 'production',
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: kv,
	}
}

function installQueues(samples: Record<string, Sample> = {}) {
	mocks.rawRequest.mockImplementation(async (input: { path: string }) => {
		if (!input.path.endsWith('/metrics')) {
			return {
				status: 200,
				body: {
					success: true,
					result: productionDeadLetterQueueNames.map((name) => ({
						queue_id: `id-${name}`,
						queue_name: name,
					})),
					result_info: { total_pages: 1 },
				},
			}
		}
		const queueId = input.path.split('/').at(-2) ?? ''
		const queueName = queueId.slice('id-'.length)
		const sample = samples[queueName] ?? {
			backlogCount: 0,
			oldestMessageTimestampMs: null,
		}
		if (sample.status != null && sample.status >= 400) {
			return {
				status: sample.status,
				body: {
					success: false,
					errors: [{ message: 'metrics unavailable' }],
				},
			}
		}
		return {
			status: 200,
			body: {
				success: true,
				result: {
					backlog_count: sample.backlogCount,
					backlog_bytes: 128,
					oldest_message_timestamp_ms: sample.oldestMessageTimestampMs ?? 0,
				},
			},
		}
	})
}

test('depth is sustained only after the backlog has aged past 15 minutes', () => {
	const oldest = now.getTime() - dlqDepthSustainedMs
	expect(
		classifyDlqDepth({
			backlogCount: 0,
			oldestMessageTimestampMs: oldest - 60_000,
			now,
			sinceMs: null,
		}).kind,
	).toBe('healthy')
	expect(
		classifyDlqDepth({
			backlogCount: 2,
			oldestMessageTimestampMs: oldest,
			now,
			sinceMs: null,
		}).kind,
	).toBe('pending')
	expect(
		classifyDlqDepth({
			backlogCount: 2,
			oldestMessageTimestampMs: oldest - 1,
			now,
			sinceMs: null,
		}).kind,
	).toBe('sustained')
	expect(
		classifyDlqDepth({
			backlogCount: 1,
			oldestMessageTimestampMs: null,
			now,
			sinceMs: now.getTime() - dlqDepthSustainedMs,
		}).kind,
	).toBe('pending')
	expect(
		classifyDlqDepth({
			backlogCount: 1,
			oldestMessageTimestampMs: null,
			now,
			sinceMs: now.getTime() - dlqDepthSustainedMs - 1,
		}).kind,
	).toBe('sustained')
})

test('a stuck production DLQ pages once, stays quiet on cooldown, and pages again after it drains', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv, values } = memoryKv()
	const env = productionEnv(kv)
	installQueues({
		[stuckQueue]: {
			backlogCount: 3,
			oldestMessageTimestampMs: now.getTime() - 16 * 60_000,
		},
	})

	const first = await checkDlqDepthAndAlert({ env, now })
	expect(first).toMatchObject({ status: 'checked', alerted: 1, sustained: 1 })
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain(
		'Dead-letter queue kody-webhook-dispatch-dlq still has 3 unacknowledged messages after 16 minutes.',
	)
	expect(mocks.setFingerprint).toHaveBeenCalledWith(['dlq-depth', stuckQueue])
	expect(consoleWarn).toHaveBeenCalledWith(
		'dlq-depth-alerted',
		expect.objectContaining({ queueName: stuckQueue, backlogCount: 3 }),
	)

	mocks.captureMessage.mockClear()
	const cooled = await checkDlqDepthAndAlert({
		env,
		now: new Date(now.getTime() + 5 * 60_000),
	})
	expect(cooled).toMatchObject({ status: 'checked', alerted: 0, cooldown: 1 })
	expect(mocks.captureMessage).not.toHaveBeenCalled()

	installQueues()
	const drained = await checkDlqDepthAndAlert({
		env,
		now: new Date(now.getTime() + 10 * 60_000),
	})
	expect(drained).toMatchObject({
		status: 'checked',
		healthy: productionDeadLetterQueueNames.length,
		alerted: 0,
	})
	expect(values.size).toBe(0)

	installQueues({
		[stuckQueue]: {
			backlogCount: 1,
			oldestMessageTimestampMs: now.getTime() + 10 * 60_000 - 60_000,
		},
	})
	const young = await checkDlqDepthAndAlert({
		env,
		now: new Date(now.getTime() + 10 * 60_000),
	})
	expect(young).toMatchObject({ status: 'checked', pending: 1, alerted: 0 })
	expect(mocks.captureMessage).not.toHaveBeenCalled()

	installQueues({
		[stuckQueue]: {
			backlogCount: 1,
			oldestMessageTimestampMs: now.getTime() + 30 * 60_000 - 16 * 60_000,
		},
	})
	const again = await checkDlqDepthAndAlert({
		env,
		now: new Date(now.getTime() + 30 * 60_000),
	})
	expect(again).toMatchObject({ status: 'checked', alerted: 1 })
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain(
		'1 unacknowledged message',
	)
})

test('an unknown oldest timestamp keeps the nonempty episode clock, and a valid timestamp still wins', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv } = memoryKv()
	const env = productionEnv(kv)
	installQueues({
		[stuckQueue]: { backlogCount: 2, oldestMessageTimestampMs: null },
	})
	const first = await checkDlqDepthAndAlert({ env, now })
	expect(first).toMatchObject({ status: 'checked', pending: 1, alerted: 0 })

	installQueues({
		[stuckQueue]: {
			backlogCount: 2,
			oldestMessageTimestampMs: now.getTime() + 60_000,
		},
	})
	const youngTimestamp = await checkDlqDepthAndAlert({
		env,
		now: new Date(now.getTime() + 2 * 60_000),
	})
	expect(youngTimestamp).toMatchObject({
		status: 'checked',
		pending: 1,
		alerted: 0,
	})
	expect(mocks.captureMessage).not.toHaveBeenCalled()

	installQueues({
		[stuckQueue]: { backlogCount: 2, oldestMessageTimestampMs: null },
	})
	const resumed = await checkDlqDepthAndAlert({
		env,
		now: new Date(now.getTime() + 16 * 60_000),
	})
	expect(resumed).toMatchObject({ status: 'checked', alerted: 1, sustained: 1 })
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain('after 16 minutes')
})

test('a missing oldest timestamp starts the 15 minute clock on the first non-zero sample', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv, values } = memoryKv()
	const env = productionEnv(kv)
	installQueues({
		[stuckQueue]: { backlogCount: 1, oldestMessageTimestampMs: null },
	})

	const first = await checkDlqDepthAndAlert({ env, now })
	expect(first).toMatchObject({ status: 'checked', pending: 1, alerted: 0 })
	expect(mocks.captureMessage).not.toHaveBeenCalled()
	const stored = values.get(`${dlqDepthAlertKvKeyPrefix}${stuckQueue}`)
	expect(stored).toContain(String(now.getTime()))

	const later = await checkDlqDepthAndAlert({
		env,
		now: new Date(now.getTime() + dlqDepthSustainedMs + 1),
	})
	expect(later).toMatchObject({ status: 'checked', alerted: 1, sustained: 1 })
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain(stuckQueue)
})

test('a cooldown write failure does not page that queue', async () => {
	const { kv } = memoryKv()
	const failingKv = {
		get: kv.get.bind(kv),
		put: async () => {
			throw new Error('kv down')
		},
		delete: kv.delete.bind(kv),
	} as unknown as KVNamespace
	installQueues({
		[stuckQueue]: {
			backlogCount: 3,
			oldestMessageTimestampMs: now.getTime() - 16 * 60_000,
		},
	})
	await expect(
		checkDlqDepthAndAlert({ env: productionEnv(failingKv), now }),
	).rejects.toThrow(/kody-webhook-dispatch-dlq \(state write failed\)/)
	expect(mocks.captureMessage).not.toHaveBeenCalled()
})

test('one unread queue fails the lane after a sibling stuck queue has already paged', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv } = memoryKv()
	installQueues({
		[stuckQueue]: {
			backlogCount: 2,
			oldestMessageTimestampMs: now.getTime() - 20 * 60_000,
		},
		'kody-email-delivery-dlq': {
			backlogCount: 0,
			oldestMessageTimestampMs: null,
			status: 403,
		},
	})
	await expect(
		checkDlqDepthAndAlert({ env: productionEnv(kv), now }),
	).rejects.toThrow(/kody-email-delivery-dlq/)
	expect(mocks.captureMessage).toHaveBeenCalledTimes(1)
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain(stuckQueue)
})

test('non-production and missing Cloudflare credentials do not report an empty DLQ', async () => {
	const { kv } = memoryKv()
	installQueues({
		[stuckQueue]: {
			backlogCount: 4,
			oldestMessageTimestampMs: now.getTime() - 60 * 60_000,
		},
	})
	await expect(
		checkDlqDepthAndAlert({
			env: {
				...productionEnv(kv),
				SENTRY_ENVIRONMENT: 'preview',
			},
			now,
		}),
	).resolves.toEqual({ status: 'skipped', reason: 'non_production' })
	await expect(
		checkDlqDepthAndAlert({
			env: {
				...productionEnv(kv),
				WRANGLER_IS_LOCAL_DEV: 'true',
			},
			now,
		}),
	).resolves.toEqual({ status: 'skipped', reason: 'non_production' })
	await expect(
		checkDlqDepthAndAlert({
			env: { ...productionEnv(kv), CLOUDFLARE_API_TOKEN: '  ' },
			now,
		}),
	).rejects.toThrow(/CLOUDFLARE_API_TOKEN/)
	expect(mocks.rawRequest).not.toHaveBeenCalled()
	expect(mocks.captureMessage).not.toHaveBeenCalled()
})

test('parked dead-letter messages keep the queue on the page after the consumer acks them', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.captureMessage.mockClear()
	const { kv } = memoryKv()
	const parkedQueue = 'kody-platform-feedback-dispatch-dlq'
	const appDb = {
		prepare: () => ({
			all: async () => ({
				results: [
					{
						dead_letter_queue: parkedQueue,
						count: 1,
						oldest_enqueued_at_ms: now.getTime() - 60 * 60_000,
					},
				],
			}),
		}),
	} as unknown as D1Database
	installQueues()
	const result = await checkDlqDepthAndAlert({
		env: { ...productionEnv(kv), APP_DB: appDb },
		now,
	})
	expect(result).toMatchObject({ status: 'checked', sustained: 1, alerted: 1 })
	expect(mocks.setFingerprint).toHaveBeenLastCalledWith([
		'dlq-depth',
		parkedQueue,
	])
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain(
		`Dead-letter queue ${parkedQueue} still has 1 unacknowledged message (1 parked for admin replay, ack, or purge) after 60 minutes.`,
	)
})

test('a failed parked-message read fails the check instead of reporting healthy', async () => {
	const { kv } = memoryKv()
	const appDb = {
		prepare: () => ({
			all: async () => {
				throw new Error('D1 unavailable')
			},
		}),
	} as unknown as D1Database
	installQueues()
	await expect(
		checkDlqDepthAndAlert({
			env: { ...productionEnv(kv), APP_DB: appDb },
			now,
		}),
	).rejects.toThrow('parked dead-letter messages (D1 unavailable)')
})

test('a Cloudflare 5xx that recovers on retry reads the queue normally', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv } = memoryKv()
	installQueues({
		[stuckQueue]: {
			backlogCount: 2,
			oldestMessageTimestampMs: now.getTime() - 20 * 60_000,
		},
	})
	const healthy = mocks.rawRequest.getMockImplementation()
	let failed = false
	mocks.rawRequest.mockImplementation(async (input: { path: string }) => {
		if (!failed && input.path.endsWith(`id-${stuckQueue}/metrics`)) {
			failed = true
			return { status: 500, body: { success: false, errors: [] } }
		}
		return await healthy?.(input)
	})
	const result = await checkDlqDepthAndAlert({
		env: productionEnv(kv),
		now,
		upstreamRetryDelaysMs: [0, 0],
	})
	expect(result).toMatchObject({
		status: 'checked',
		alerted: 1,
		upstreamUnavailable: 0,
	})
	expect(mocks.captureMessage).toHaveBeenCalledOnce()
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain(stuckQueue)
})

test('a Cloudflare 5xx that outlasts retries warns on one issue instead of failing the lane', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv } = memoryKv()
	installQueues({
		[stuckQueue]: {
			backlogCount: 2,
			oldestMessageTimestampMs: now.getTime() - 20 * 60_000,
		},
		'kody-email-delivery-dlq': {
			backlogCount: 0,
			oldestMessageTimestampMs: null,
			status: 500,
		},
	})
	const result = await checkDlqDepthAndAlert({
		env: productionEnv(kv),
		now,
		upstreamRetryDelaysMs: [0, 0],
	})
	expect(result).toMatchObject({
		status: 'checked',
		alerted: 1,
		upstreamUnavailable: 1,
	})
	const metricsCalls = mocks.rawRequest.mock.calls.filter(([request]) =>
		(request as { path: string }).path.endsWith(
			'id-kody-email-delivery-dlq/metrics',
		),
	)
	expect(metricsCalls).toHaveLength(3)
	expect(mocks.captureMessage).toHaveBeenCalledTimes(2)
	expect(mocks.captureMessage.mock.calls[1]?.[0]).toContain(
		'kody-email-delivery-dlq (Failed to read Cloudflare Queue metrics (500)',
	)
	expect(mocks.setFingerprint).toHaveBeenLastCalledWith([
		'dlq-depth-alert',
		'cloudflare-upstream',
	])
})

test('a Cloudflare 5xx on the queue list warns and skips the tick', async () => {
	consoleWarn.mockImplementation(() => {})
	const { kv } = memoryKv()
	mocks.rawRequest.mockResolvedValue({
		status: 500,
		body: { success: false, errors: [] },
	})
	await expect(
		checkDlqDepthAndAlert({
			env: productionEnv(kv),
			now,
			upstreamRetryDelaysMs: [0, 0],
		}),
	).resolves.toEqual({ status: 'upstream_unavailable', reason: 'queue_list' })
	expect(mocks.rawRequest).toHaveBeenCalledTimes(3)
	expect(mocks.captureMessage).toHaveBeenCalledOnce()
	expect(mocks.captureMessage.mock.calls[0]?.[0]).toContain(
		'queue list (Failed to list Cloudflare Queues (500).)',
	)
})

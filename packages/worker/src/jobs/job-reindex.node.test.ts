import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
} from '#worker/d1-retry.ts'
import { type JobRecord } from './types.ts'

const mockModule = vi.hoisted(() => ({
	embedTextForVectorize: vi.fn(),
	embedTextsForVectorize: vi.fn(),
	getCapabilityVectorIndex: vi.fn(),
	isCapabilitySearchOffline: vi.fn(),
	listJobRowsPage: vi.fn(),
}))

vi.mock('#worker/vectorize/embedding.ts', () => ({
	embedTextForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextForVectorize(...args),
	embedTextsForVectorize: (...args: Array<unknown>) =>
		mockModule.embedTextsForVectorize(...args),
	getCapabilityVectorIndex: (...args: Array<unknown>) =>
		mockModule.getCapabilityVectorIndex(...args),
	isCapabilitySearchOffline: (...args: Array<unknown>) =>
		mockModule.isCapabilitySearchOffline(...args),
}))

vi.mock('@kody-internal/shared/jobs/repo.ts', () => ({
	listJobRowsPage: (...args: Array<unknown>) =>
		mockModule.listJobRowsPage(...args),
}))

const { reindexJobVectors } = await import('./job-reindex.ts')

const textEncoder = new TextEncoder()

function byteLength(value: string) {
	return textEncoder.encode(value).length
}

function resetMocks() {
	mockModule.embedTextsForVectorize.mockReset()
	mockModule.getCapabilityVectorIndex.mockReset()
	mockModule.isCapabilitySearchOffline.mockReset()
	mockModule.listJobRowsPage.mockReset()
}

function buildJobRow(id: string, userId = 'user-1') {
	const record: JobRecord = {
		version: 1,
		id,
		userId: ownerIdFromStored(userId),
		name: `Job ${id}`,
		sourceId: 'source-1',
		publishedCommit: null,
		storageId: `job:${id}`,
		schedule: { type: 'interval', every: '1h' },
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		expiresAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		nextRunAt: '2026-01-01T00:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	return { id, user_id: userId, record }
}

test('job reindex keeps package job vector ids under the Vectorize limit', async () => {
	resetMocks()
	const rawJobId =
		'package-job:b2fda105-005a-4e2b-9f22-1513b6752da2:event-runner'
	const vectorId = jobVectorId(rawJobId)
	const upsert = vi.fn(async () => {})
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.4, 0.5, 0.6]])
	mockModule.listJobRowsPage.mockResolvedValue([buildJobRow(rawJobId)])

	await expect(reindexJobVectors({ APP_DB: {} } as Env)).resolves.toEqual({
		upserted: 1,
		complete: true,
		afterId: null,
	})

	expect(byteLength(`job_${rawJobId}`)).toBeGreaterThan(64)
	expect(byteLength(vectorId)).toBeLessThanOrEqual(64)
	expect(upsert).toHaveBeenCalledWith([
		{
			id: vectorId,
			values: [0.4, 0.5, 0.6],
			namespace: 'user-1',
			metadata: { kind: 'job', userId: ownerIdFromStored('user-1') },
		},
	])
})

test('job reindex walks keyset pages and merges the page results', async () => {
	resetMocks()
	const upsert = vi.fn(async (_vectors: Array<{ id: string }>) => {})
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.embedTextsForVectorize.mockImplementation(
		async (_env: unknown, texts: Array<string>) => texts.map(() => [0.1]),
	)
	// The first page fills the requested limit, forcing a second page fetch.
	mockModule.listJobRowsPage.mockImplementationOnce(
		async (_db: unknown, input: { afterId: string | null; limit: number }) =>
			Array.from({ length: input.limit }, (_, index) =>
				buildJobRow(`job-${String(index).padStart(4, '0')}`),
			),
	)
	mockModule.listJobRowsPage.mockImplementationOnce(async () => [
		buildJobRow('job-last'),
	])

	await expect(reindexJobVectors({ APP_DB: {} } as Env)).resolves.toEqual({
		upserted: 201,
		complete: true,
		afterId: null,
	})

	expect(mockModule.listJobRowsPage).toHaveBeenCalledTimes(2)
	expect(mockModule.listJobRowsPage).toHaveBeenNthCalledWith(
		1,
		expect.anything(),
		{ afterId: null, limit: 200 },
	)
	expect(mockModule.listJobRowsPage).toHaveBeenNthCalledWith(
		2,
		expect.anything(),
		{ afterId: 'job-0199', limit: 200 },
	)
	const upsertedIds = upsert.mock.calls.flatMap(([vectors]) =>
		vectors.map((vector) => vector.id),
	)
	expect(upsertedIds).toHaveLength(201)
	expect(new Set(upsertedIds).size).toBe(201)
})

test('job reindex retries transient D1 export page errors then surfaces exhaustion', async () => {
	resetMocks()
	const upsert = vi.fn()
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.embedTextsForVectorize.mockResolvedValue([[0.1]])
	mockModule.listJobRowsPage
		.mockRejectedValueOnce(
			new Error('D1_ERROR: Currently processing a long-running export.'),
		)
		.mockResolvedValueOnce([buildJobRow('job-1')])

	vi.useFakeTimers()
	try {
		const recoverPromise = reindexJobVectors({ APP_DB: {} } as Env)
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(recoverPromise).resolves.toEqual({
			upserted: 1,
			complete: true,
			afterId: null,
		})
	} finally {
		vi.useRealTimers()
	}
	expect(mockModule.listJobRowsPage).toHaveBeenCalledTimes(2)
	expect(upsert).toHaveBeenCalledTimes(1)

	resetMocks()
	mockModule.getCapabilityVectorIndex.mockReturnValue({ upsert: vi.fn() })
	mockModule.isCapabilitySearchOffline.mockReturnValue(false)
	mockModule.listJobRowsPage.mockRejectedValue(
		new Error('D1_ERROR: Currently processing a long-running export.'),
	)

	vi.useFakeTimers()
	try {
		const exhaustedPromise = reindexJobVectors({ APP_DB: {} } as Env)
		// Attach before advancing timers so the rejection is not unhandled.
		// oxlint-disable-next-line vitest/valid-expect
		const expectation = expect(exhaustedPromise).rejects.toThrow(
			'Currently processing a long-running export',
		)
		for (let attempt = 1; attempt < d1LockRetryMaxAttempts; attempt++) {
			await vi.advanceTimersByTimeAsync(
				d1LockRetryBaseDelayMs * 2 ** (attempt - 1),
			)
		}
		await expectation
	} finally {
		vi.useRealTimers()
	}

	expect(mockModule.listJobRowsPage).toHaveBeenCalledTimes(
		d1LockRetryMaxAttempts,
	)
})

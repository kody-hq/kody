import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'
import type * as StorageBucketsService from '#worker/storage-buckets/service.ts'

const mockModule = vi.hoisted(() => ({
	listUserStorageBucketEstimates: vi.fn<
		typeof StorageBucketsService.listUserStorageBucketEstimates
	>(async () => [
		{ storageId: 'bucket-a', kind: 'unknown', estimatedBytes: null },
		{ storageId: 'bucket-b', kind: 'unknown', estimatedBytes: null },
	]),
	readStorageBytesFromUserMeter: vi.fn<
		typeof EntitlementsService.readStorageBytesFromUserMeter
	>(async () => 0),
	registerStorageBucket: vi.fn(),
	recordStorageBucketEstimate: vi.fn(),
	maybeRefreshStorageBucketEstimate: vi.fn(),
	getEstimatedBytes: vi.fn(async () => ({ estimatedBytes: 64 })),
	sqlQuery: vi.fn(
		async (input: {
			query: string
			params?: Array<unknown>
			writable?: boolean
		}) => ({
			columns: [],
			rows: [],
			rowCount: 0,
			rowsRead: 0,
			rowsWritten: input.writable ? 1 : 0,
			truncated: false,
		}),
	),
}))

vi.mock('#worker/storage-buckets/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StorageBucketsService>()
	return {
		...actual,
		listUserStorageBucketEstimates: (
			...args: Parameters<
				typeof StorageBucketsService.listUserStorageBucketEstimates
			>
		) => mockModule.listUserStorageBucketEstimates(...args),
		registerStorageBucket: (...args: Array<unknown>) =>
			mockModule.registerStorageBucket(...args),
		recordStorageBucketEstimate: (...args: Array<unknown>) =>
			mockModule.recordStorageBucketEstimate(...args),
		maybeRefreshStorageBucketEstimate: (...args: Array<unknown>) =>
			mockModule.maybeRefreshStorageBucketEstimate(...args),
		flushStorageBucketRegistrationsForTests: async () => undefined,
		clearStorageBucketRegistrationDedupeForTests: () => undefined,
		listPlatformStorageBuckets: async () => [],
	}
})

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementsService>()
	return {
		...actual,
		readStorageBytesFromUserMeter: (
			...args: Parameters<
				typeof EntitlementsService.readStorageBytesFromUserMeter
			>
		) => mockModule.readStorageBytesFromUserMeter(...args),
	}
})

const {
	assertStorageRunnerWriteWithinEntitlement,
	createStorageBytesEntitlementRunCache,
	createStorageKodyTools,
	isReadOnlyStorageSqlQuery,
	isStorageSqlReturningMutation,
	isStorageSqlWrite,
	readOnlyStorageSqlDeniedMessage,
	storageEstimateReadRetryDelaysMs,
} = await import('#worker/storage-runner.ts')

function createEstimateEnv() {
	return {
		APP_DB: {
			prepare() {
				throw new Error('APP_DB should not be queried when email is absent')
			},
		},
		STORAGE_RUNNER: {
			idFromName: (name: string) => name,
			get: () => ({
				getEstimatedBytes: () => mockModule.getEstimatedBytes(),
				sqlQuery: (input: {
					query: string
					params?: Array<unknown>
					writable?: boolean
				}) => mockModule.sqlQuery(input),
				getValue: async ({ key }: { key: string }) => ({
					key,
					value: null,
				}),
				setValue: async ({ key }: { key: string }) => ({
					ok: true as const,
					key,
				}),
				deleteValue: async () => ({
					ok: true as const,
					key: 'x',
					deleted: true,
				}),
				clearStorage: async () => ({ ok: true as const }),
				listValues: async () => ({
					entries: [],
					estimatedBytes: 0,
					truncated: false,
					nextStartAfter: null,
					pageSize: 50,
				}),
			}),
		},
	} as unknown as Env
}

function clearCalls() {
	for (const mock of [
		mockModule.getEstimatedBytes,
		mockModule.listUserStorageBucketEstimates,
		mockModule.recordStorageBucketEstimate,
		mockModule.maybeRefreshStorageBucketEstimate,
		mockModule.sqlQuery,
	]) {
		mock.mockClear()
	}
}

function storageTools(writable: boolean) {
	return createStorageKodyTools({
		env: createEstimateEnv(),
		userId: ownerIdFromStored('user-1'),
		email: null,
		storageId: 'package:skills',
		writable,
	})
}

function assertWrite(
	storageId: string,
	options: {
		env?: Env
		requested?: number
		cache?: ReturnType<typeof createStorageBytesEntitlementRunCache>
	} = {},
) {
	return assertStorageRunnerWriteWithinEntitlement({
		env: options.env ?? createEstimateEnv(),
		userId: ownerIdFromStored('user-1'),
		email: null,
		storageId,
		requested: options.requested ?? 1,
		cache: options.cache,
	})
}

function fakeTimers() {
	vi.useFakeTimers()
	return {
		[Symbol.dispose]: () => {
			vi.useRealTimers()
		},
	}
}

test('writable storageSql skips read-only fan-out and enforces mutating entitlement', async () => {
	const readOnlyCases: Array<[string, boolean]> = [
		['SELECT 1', true],
		['  explain query plan select 1', true],
		['PRAGMA table_info(skills)', true],
		['CREATE TABLE skills (id TEXT)', false],
		['SELECT 1; CREATE TABLE skills (id TEXT)', false],
		['', false],
	]
	expect(
		readOnlyCases.filter(
			([query, want]) => isReadOnlyStorageSqlQuery(query) !== want,
		),
	).toEqual([])
	const returningMutationCases: Array<[string, boolean]> = [
		['INSERT INTO t VALUES (1)', true],
		[
			'WITH s AS (SELECT 1 AS i) INSERT INTO t SELECT i FROM s RETURNING i',
			true,
		],
		[
			'WITH recursive seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 10) SELECT i FROM seq',
			false,
		],
		['SELECT 1', false],
		["WITH c AS (SELECT 'insert' AS label) SELECT label FROM c", false],
		['WITH c AS (SELECT 1) /* insert */ SELECT 1', false],
		['CREATE TABLE snapshot AS SELECT * FROM source', false],
	]
	const writeCases: Array<[string, boolean]> = [
		['CREATE TABLE snapshot AS SELECT * FROM source', true],
		['DROP TABLE snapshot', true],
		["WITH c AS (SELECT 'insert' AS label) SELECT label FROM c", false],
		['WITH s AS (SELECT 1 AS i) INSERT INTO t SELECT i FROM s', true],
		['SELECT created FROM t', false],
		['WITH create AS (SELECT 1) SELECT * FROM create', false],
		['WITH drop AS (SELECT 1 AS alter) SELECT alter FROM drop', false],
	]
	expect(
		returningMutationCases.filter(
			([query, want]) => isStorageSqlReturningMutation(query) !== want,
		),
	).toEqual([])
	expect(
		writeCases.filter(([query, want]) => isStorageSqlWrite(query) !== want),
	).toEqual([])

	clearCalls()
	const tools = storageTools(true)
	await expect(
		tools.storageSql({
			query: 'SELECT id FROM skills',
			params: [],
			writable: true,
		}),
	).resolves.toMatchObject({ rowCount: 0 })
	expect(mockModule.listUserStorageBucketEstimates).not.toHaveBeenCalled()
	expect(mockModule.getEstimatedBytes).not.toHaveBeenCalled()
	expect(mockModule.maybeRefreshStorageBucketEstimate).not.toHaveBeenCalled()

	await expect(
		tools.storageSql({
			query: 'CREATE TABLE IF NOT EXISTS skills (id TEXT)',
			params: [],
			writable: true,
		}),
	).resolves.toMatchObject({ rowsWritten: 1 })
	expect(mockModule.listUserStorageBucketEstimates).toHaveBeenCalledTimes(1)
	// Inventoried buckets without stored estimates plus the
	// not-yet-registered target id.
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(3)
	expect(mockModule.recordStorageBucketEstimate).toHaveBeenCalledTimes(3)
	expect(mockModule.maybeRefreshStorageBucketEstimate).toHaveBeenCalledTimes(1)

	clearCalls()
	await expect(
		storageTools(false).storageSql({
			query: 'create table if not exists notes (name text)',
		}),
	).rejects.toThrow(readOnlyStorageSqlDeniedMessage)
	expect(mockModule.sqlQuery).not.toHaveBeenCalled()

	clearCalls()
	mockModule.listUserStorageBucketEstimates.mockResolvedValueOnce([
		{ storageId: 'bucket-a', kind: 'unknown', estimatedBytes: 100 },
		{ storageId: 'bucket-b', kind: 'unknown', estimatedBytes: 200 },
		{ storageId: 'package:skills', kind: 'unknown', estimatedBytes: 999 },
	])
	await expect(assertWrite('package:skills')).resolves.toBeUndefined()
	// Only the bucket being written is probed live; peers use stored estimates.
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(1)
	expect(mockModule.recordStorageBucketEstimate).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: ownerIdFromStored('user-1'),
		storageId: 'package:skills',
		estimatedBytes: 64,
	})

	clearCalls()
	const freeStorageBytes = planLimits.free.maxStorageBytes
	mockModule.listUserStorageBucketEstimates.mockResolvedValueOnce([
		{
			storageId: 'bucket-a',
			kind: 'unknown',
			estimatedBytes: freeStorageBytes,
		},
	])
	const denied = await assertWrite('package:skills').then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(denied.details).toMatchObject({
		resource: 'storage_bytes',
		limit: freeStorageBytes,
		current: freeStorageBytes + 64,
	})
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(1)
})

test('entitlement run cache pays the fan-out once across mutating writes', async () => {
	const cache = createStorageBytesEntitlementRunCache()
	const env = createEstimateEnv()
	for (let write = 0; write < 3; write += 1) {
		await assertWrite('package:skills', { env, requested: 10, cache })
	}

	expect(mockModule.listUserStorageBucketEstimates).toHaveBeenCalledTimes(1)
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(3)
	expect(cache.reservedBytes).toBe(30)
})

test('entitlement run cache drops a rejected baseline so later writes retry', async () => {
	mockModule.listUserStorageBucketEstimates.mockResolvedValue([
		{ storageId: 'bucket-a', kind: 'unknown', estimatedBytes: null },
	])
	// Exhaust the whole retry policy so the baseline read fails closed.
	for (
		let attempt = 0;
		attempt <= storageEstimateReadRetryDelaysMs.length;
		attempt += 1
	) {
		mockModule.getEstimatedBytes.mockRejectedValueOnce(
			new Error('transient estimate failure'),
		)
	}
	mockModule.getEstimatedBytes.mockResolvedValue({ estimatedBytes: 64 })
	const cache = createStorageBytesEntitlementRunCache()
	const env = createEstimateEnv()

	{
		using _timers = fakeTimers()
		const first = assertWrite('bucket-a', { env, cache })
		// Attach before advancing timers so the rejection is not unhandled.
		// oxlint-disable-next-line vitest/valid-expect
		const expectation = expect(first).rejects.toThrow(/could not be read/)
		await vi.advanceTimersByTimeAsync(
			storageEstimateReadRetryDelaysMs.reduce(
				(total, delay) => total + delay,
				0,
			),
		)
		await expectation
	}
	expect(cache.baseline).toBeNull()

	await expect(assertWrite('bucket-a', { env, cache })).resolves.toBeUndefined()
	expect(cache.reservedBytes).toBe(1)
})

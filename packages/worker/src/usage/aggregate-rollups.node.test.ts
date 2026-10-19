import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi, type Mock } from 'vitest'
import {
	aggregateUsageRollups,
	analyticsEngineSqlRetryMaxAttempts,
	buildDynamicWorkerInvokeReuseQuery,
	buildDynamicWorkerReuseRatioQuery,
	buildMonthToDateAggregateQuery,
	resolveUsageEventsDataset,
	shouldRunUsageAggregationCron,
} from './aggregate-rollups.ts'

type BoundStatement = { sql: string; params: Array<unknown> }

type RollupKeyRow = { user_id: string; metric: string; month: string }
type EmailUsageRow = {
	user_id: string
	metric: string
	month: string
	event_count: number
	error_count: number
	caught_count?: number
	total_duration_ms: number
	total_cpu_ms: number
	total_bytes: number
}

function createFakeDb(
	input: {
		existingRollups?: Array<RollupKeyRow>
		emailUsageRows?: Array<EmailUsageRow>
		systemEmailUsageRows?: Array<EmailUsageRow>
		liveUserIds?: Array<string>
		liveOrgIds?: Array<string>
	} = {},
) {
	const rollups = input.existingRollups?.map((row) => ({ ...row })) ?? []
	const batches: Array<Array<BoundStatement>> = []
	const deletes: Array<BoundStatement> = []
	const selects: Array<BoundStatement> = []
	const removeRollups = (matches: (row: RollupKeyRow) => boolean) => {
		const before = rollups.length
		rollups.splice(0, rollups.length, ...rollups.filter((row) => !matches(row)))
		return { meta: { changes: before - rollups.length } }
	}
	const db = {
		prepare(sql: string) {
			return {
				async first() {
					if (sql.includes('FROM system_email_graph_authority')) {
						return {
							authority: 'dedicated',
							graph_mismatch_count: 0,
							provider_link_count: 0,
						}
					}
					if (sql.includes('AS unsupported')) return { unsupported: 0 }
					throw new Error(`Unsupported first query: ${sql}`)
				},
				bind(...params: Array<unknown>) {
					return {
						sql,
						params,
						async all() {
							if (sql.includes('SELECT stable_user_id FROM users')) {
								const allowed = new Set(input.liveUserIds ?? params.map(String))
								return {
									results: params
										.map(String)
										.filter((userId) => allowed.has(userId))
										.map((stable_user_id) => ({ stable_user_id })),
								}
							}
							if (sql.includes('SELECT id FROM orgs')) {
								const allowed = new Set(input.liveOrgIds ?? [])
								return {
									results: params
										.map(String)
										.filter((orgId) => allowed.has(orgId))
										.map((id) => ({ id })),
								}
							}
							if (sql.includes('FROM email_delivery_events event')) {
								selects.push({ sql, params })
								return { results: input.emailUsageRows ?? [] }
							}
							if (sql.includes('FROM system_email_delivery_events')) {
								selects.push({ sql, params })
								return { results: input.systemEmailUsageRows ?? [] }
							}
							if (!sql.includes('SELECT user_id, metric FROM usage_rollups')) {
								throw new Error(`Unsupported all query: ${sql}`)
							}
							return {
								results: rollups
									.filter((row) => row.month === params[0])
									.map(({ user_id, metric }) => ({ user_id, metric })),
							}
						},
						async run() {
							if (sql.startsWith('UPDATE email_delivery_events')) {
								return { meta: { changes: 0 } }
							}
							if (!sql.startsWith('DELETE FROM usage_rollups')) {
								throw new Error(`Unsupported run query: ${sql}`)
							}
							deletes.push({ sql, params })
							if (sql.includes('NOT EXISTS')) {
								const months = new Set(params.slice(0, 2))
								const liveUsers = input.liveUserIds
								const liveOrgs = input.liveOrgIds
								return removeRollups(
									(row) =>
										months.has(row.month) &&
										row.user_id !== 'system:email' &&
										(liveUsers != null || liveOrgs != null) &&
										!liveUsers?.includes(row.user_id) &&
										!liveOrgs?.includes(row.user_id),
								)
							}
							const pairs = new Set<string>()
							for (let index = 1; index < params.length; index += 2) {
								pairs.add(`${params[index]}:${params[index + 1]}`)
							}
							return removeRollups(
								(row) =>
									row.month === params[0] &&
									pairs.has(`${row.user_id}:${row.metric}`),
							)
						},
					}
				},
			}
		},
		async batch(statements: Array<BoundStatement>) {
			batches.push(statements)
			return []
		},
	} as unknown as D1Database
	return { db, batches, deletes, selects, rollups }
}

const staleDeletes = (deletes: Array<BoundStatement>) =>
	deletes.filter(
		(statement) => !statement.sql.includes(`user_id != 'system:email'`),
	)

function createAggregationEnv(db: D1Database) {
	return {
		USAGE_EVENTS: { writeDataPoint() {} },
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'account-1',
		CLOUDFLARE_API_TOKEN: 'token-1',
	}
}

const midJuly = new Date('2026-07-15T10:00:00.000Z')

function aggregate(db: D1Database, now = midJuly) {
	return aggregateUsageRollups(createAggregationEnv(db), now)
}

function stubFetch<T extends Mock>(fetchMock: T) {
	vi.stubGlobal('fetch', fetchMock)
	return Object.assign(fetchMock, {
		[Symbol.dispose]: () => vi.unstubAllGlobals(),
	})
}

/** Replies in order and repeats the last reply for any extra calls. */
function fetchReplying(...replies: Array<{ status?: number; body: unknown }>) {
	let index = 0
	return stubFetch(
		vi.fn(async (_url: string, _init?: RequestInit) => {
			const { status = 200, body } =
				replies[Math.min(index++, replies.length - 1)]!
			return new Response(
				typeof body === 'string' ? body : JSON.stringify(body),
				{ status },
			)
		}),
	)
}

const empty = { body: { data: [] } }
const dataReply = (...data: Array<unknown>) => ({ body: { data } })

function aeRow(
	user_id: string,
	metric = 'execute',
	counts: Partial<EmailUsageRow> = {},
) {
	return {
		user_id,
		metric,
		event_count: 1,
		error_count: 0,
		caught_count: 0,
		total_duration_ms: 0,
		total_cpu_ms: 0,
		total_bytes: 0,
		...counts,
	}
}

const emailRow = (
	user_id: string,
	counts: Partial<EmailUsageRow> = {},
): EmailUsageRow => ({
	...aeRow(user_id, 'email_received', counts),
	month: '2026-07',
})

const missingFrom = (text: string, needles: Array<string>) =>
	needles.filter((needle) => !text.includes(needle))

test('shouldRunUsageAggregationCron gates to the top of each hour', () => {
	const cases: Array<[string, boolean]> = [
		['2026-07-05T10:00:30.000Z', true],
		['2026-07-05T10:30:00.000Z', false],
		['2026-07-05T10:59:00.000Z', false],
	]
	expect(
		cases.map(([iso]) => shouldRunUsageAggregationCron(new Date(iso))),
	).toEqual(cases.map(([, want]) => want))
})

test('resolveUsageEventsDataset picks the preview dataset only for preview', () => {
	expect(
		[
			{},
			{ SENTRY_ENVIRONMENT: 'production' },
			{ SENTRY_ENVIRONMENT: 'preview' },
		].map(resolveUsageEventsDataset),
	).toEqual([
		'kody_usage_events',
		'kody_usage_events',
		'kody_usage_events_preview',
	])
})

test('aggregateUsageRollups no-ops when the binding or credentials are missing', async () => {
	using fetchMock = fetchReplying(empty)
	const { db, batches, deletes } = createFakeDb()
	const usageEvents = { writeDataPoint() {} }

	for (const env of [
		{ APP_DB: db },
		{ APP_DB: db, USAGE_EVENTS: usageEvents },
		{
			APP_DB: db,
			USAGE_EVENTS: usageEvents,
			CLOUDFLARE_ACCOUNT_ID: 'account-1',
		},
		{ APP_DB: db, USAGE_EVENTS: usageEvents, CLOUDFLARE_API_TOKEN: 'token-1' },
	]) {
		await expect(aggregateUsageRollups(env, new Date())).resolves.toEqual({
			skipped: true,
			reason: 'missing-analytics-config',
		})
	}
	expect(fetchMock).not.toHaveBeenCalled()
	expect(batches).toHaveLength(0)
	expect(deletes).toHaveLength(0)
})

test('aggregateUsageRollups merges current and previous Analytics months with durable inbound usage', async () => {
	using fetchMock = fetchReplying(
		dataReply(
			aeRow('user-a', 'execute', {
				event_count: 12,
				error_count: 2,
				total_duration_ms: 3456.7,
				total_bytes: 1024,
			}),
			aeRow('user-a', 'package_static_call', {
				event_count: 20,
				error_count: 1,
				caught_count: 9,
				total_duration_ms: 40,
			}),
			// The SQL API may serialize aggregates as strings.
			{
				user_id: ownerIdFromStored('user-b'),
				metric: 'email_send',
				event_count: '3',
				error_count: '0',
				caught_count: '0',
				total_duration_ms: '0',
				total_cpu_ms: '0',
				total_bytes: '2048',
			},
			// Rows without an owning user or metric are never upserted.
			aeRow(''),
		),
		dataReply(
			aeRow('user-c', 'email_received', {
				event_count: 5,
				error_count: 2,
				total_duration_ms: 100,
				total_bytes: 1000,
			}),
		),
	)
	const { db, batches, selects } = createFakeDb({
		systemEmailUsageRows: [
			emailRow('system:email', {
				event_count: 2,
				total_duration_ms: 50,
				total_bytes: 4096,
			}),
		],
	})
	const now = new Date('2026-07-01T00:00:30.000Z')

	await expect(aggregate(db, now)).resolves.toEqual({
		skipped: false,
		month: '2026-07',
		upsertedRows: 5,
		deletedRows: 0,
		users: 4,
	})

	expect(fetchMock).toHaveBeenCalledTimes(2)
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
	expect(url).toBe(
		'https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql',
	)
	expect(init.method).toBe('POST')
	expect((init.headers as Record<string, string>)['authorization']).toBe(
		'Bearer token-1',
	)
	// A hung SQL API must abort instead of stalling the scheduled lane.
	expect(init.signal).toBeInstanceOf(AbortSignal)
	expect(
		missingFrom(String(init.body), [
			'FROM kody_usage_events',
			// Half-open month bounds: a lower bound alone would let events stamped
			// into a later month (clock skew, backdated writes) inflate this month.
			`timestamp >= toDateTime('2026-07-01 00:00:00')`,
			`timestamp < toDateTime('2026-08-01 00:00:00')`,
			// Sampling-correct aggregates: counts and sums weight by _sample_interval.
			"blob2 IN ('durable_object_gb_seconds', 'durable_object_rows_read', 'durable_object_platform_rows_read')",
			'double3 > 0',
			'AS event_count',
			`blob4 = 'error'`,
			'AS error_count',
			`blob4 = 'caught'`,
			'AS caught_count',
			'sum(double1 * _sample_interval) AS total_duration_ms',
			'GROUP BY blob1, blob2',
		]),
	).toEqual([])
	expect(
		missingFrom(String(fetchMock.mock.calls[1]![1]?.body), [
			`timestamp >= toDateTime('2026-06-01 00:00:00')`,
			`timestamp < toDateTime('2026-07-01 00:00:00')`,
		]),
	).toEqual([])

	const inboundSql = selects[0]?.sql ?? ''
	expect(inboundSql).not.toContain('JOIN email_messages')
	expect(inboundSql).not.toContain('json_extract')
	expect(
		missingFrom(inboundSql, [
			'usage_effect_recorded_at IS NOT NULL',
			'usage_month IN (?, ?)',
		]),
	).toEqual([])
	expect(selects[0]?.params).toEqual([
		'system:email',
		'cloudflare-email-routing',
		'2026-07',
		'2026-06',
	])

	expect(batches).toHaveLength(1)
	const statements = batches[0] ?? []
	expect(statements[0]?.sql).toContain('ON CONFLICT (user_id, metric, month)')
	expect(statements[0]?.sql).toContain('event_count = excluded.event_count')
	expect(statements[0]?.sql).not.toContain('event_count + ')
	const stamp = now.toISOString()
	expect(statements.map((statement) => statement.params)).toEqual([
		['user-a', 'execute', '2026-07', 12, 2, 0, 3457, 0, 1024, stamp],
		['user-a', 'package_static_call', '2026-07', 20, 1, 9, 40, 0, 0, stamp],
		['user-b', 'email_send', '2026-07', 3, 0, 0, 0, 0, 2048, stamp],
		['user-c', 'email_received', '2026-06', 5, 2, 0, 100, 0, 1000, stamp],
		['system:email', 'email_received', '2026-07', 2, 0, 0, 50, 0, 4096, stamp],
	])
})

test('aggregateUsageRollups honors CLOUDFLARE_API_BASE_URL and the preview dataset', async () => {
	using fetchMock = fetchReplying(empty)
	const { db, batches } = createFakeDb()

	const result = await aggregateUsageRollups(
		{
			...createAggregationEnv(db),
			CLOUDFLARE_API_BASE_URL: 'https://cloudflare-mock.local/',
			SENTRY_ENVIRONMENT: 'preview',
		},
		new Date('2026-12-15T10:00:00.000Z'),
	)

	expect(result).toEqual({
		skipped: false,
		month: '2026-12',
		upsertedRows: 0,
		deletedRows: 0,
		users: 0,
	})
	const [url, init] = fetchMock.mock.calls[0]!
	expect(url).toBe(
		'https://cloudflare-mock.local/client/v4/accounts/account-1/analytics_engine/sql',
	)
	expect(
		missingFrom(String(init?.body), [
			'FROM kody_usage_events_preview',
			// The upper bound rolls over the UTC year boundary.
			`timestamp >= toDateTime('2026-12-01 00:00:00')`,
			`timestamp < toDateTime('2027-01-01 00:00:00')`,
		]),
	).toEqual([])
	expect(batches).toHaveLength(0)
})

test('hourly aggregation keeps live team org rollups and drops deleted orgs', async () => {
	using _fetch = fetchReplying(
		dataReply(
			aeRow('org-team', 'dynamic_worker_day', { event_count: 351 }),
			aeRow('user-personal', 'dynamic_worker_day', { event_count: 351 }),
			aeRow('org-overlap', 'dynamic_worker_day', { event_count: 351 }),
			aeRow('org-deleted', 'dynamic_worker_day', { event_count: 400 }),
		),
		empty,
	)
	const { db, batches, deletes, rollups } = createFakeDb({
		liveUserIds: ['user-personal', 'org-overlap'],
		liveOrgIds: ['org-team', 'org-overlap'],
		existingRollups: [
			{
				user_id: ownerIdFromStored('org-team'),
				metric: 'dynamic_worker_day',
				month: '2026-07',
			},
			{
				user_id: ownerIdFromStored('org-deleted'),
				metric: 'dynamic_worker_day',
				month: '2026-07',
			},
		],
	})

	await expect(aggregate(db)).resolves.toMatchObject({
		upsertedRows: 3,
		users: 3,
	})
	expect(batches[0]?.map((statement) => statement.params[0]).sort()).toEqual([
		'org-overlap',
		'org-team',
		'user-personal',
	])
	expect(batches[0]?.[0]?.sql).toContain('FROM orgs')
	expect(
		deletes.some(
			(statement) =>
				statement.sql.includes('NOT EXISTS') &&
				statement.sql.includes('FROM orgs'),
		),
	).toBe(true)
	expect(rollups.map((row) => row.user_id)).toEqual(['org-team'])
})

test('hourly aggregation cannot recreate rollups for deleting or deleted users', async () => {
	using _fetch = fetchReplying(
		dataReply(
			...['user-live', 'user-deleting', 'user-deleted'].map((id) => aeRow(id)),
		),
		empty,
	)
	const { db, batches, rollups } = createFakeDb({
		liveUserIds: ['user-live'],
		existingRollups: [
			{
				user_id: ownerIdFromStored('user-deleting'),
				metric: 'execute',
				month: '2026-07',
			},
			{
				user_id: ownerIdFromStored('user-deleted'),
				metric: 'execute',
				month: '2026-07',
			},
		],
		emailUsageRows: [
			emailRow('user-deleting', { total_duration_ms: 1, total_bytes: 10 }),
		],
	})

	await expect(aggregate(db)).resolves.toMatchObject({
		upsertedRows: 1,
		deletedRows: 2,
		users: 1,
	})
	expect(batches[0]?.map((statement) => statement.params[0])).toEqual([
		'user-live',
	])
	expect(rollups).toEqual([])
})

test('aggregateUsageRollups deletes current-month rows absent from the Analytics Engine result', async () => {
	using _fetch = fetchReplying(
		dataReply(aeRow('user-a', 'execute', { event_count: 5 })),
		empty,
	)
	const { db, batches, deletes, rollups } = createFakeDb({
		existingRollups: [
			// Present in the AE result: updated, never deleted.
			{
				user_id: ownerIdFromStored('user-a'),
				metric: 'execute',
				month: '2026-07',
			},
			// Absent from the AE result (for example a straggler from a
			// direct D1 upsert whose AE data point was lost): deleted.
			{
				user_id: ownerIdFromStored('user-a'),
				metric: 'job_run',
				month: '2026-07',
			},
			{
				user_id: ownerIdFromStored('user-b'),
				metric: 'execute',
				month: '2026-07',
			},
			// Other months are never touched, even for stale pairs.
			{
				user_id: ownerIdFromStored('user-a'),
				metric: 'job_run',
				month: '2026-06',
			},
		],
	})

	await expect(aggregate(db)).resolves.toEqual({
		skipped: false,
		month: '2026-07',
		upsertedRows: 1,
		deletedRows: 2,
		users: 1,
	})
	// The present pair went through the upsert batch, not the delete.
	expect(batches[0]?.[0]?.params?.slice(0, 3)).toEqual([
		'user-a',
		'execute',
		'2026-07',
	])
	const stale = staleDeletes(deletes)
	expect(stale).toHaveLength(1)
	expect(stale[0]?.sql).toContain('DELETE FROM usage_rollups WHERE month = ?')
	expect(stale[0]?.params).toEqual([
		'2026-07',
		'user-a',
		'job_run',
		'user-b',
		'execute',
	])
	expect(rollups).toEqual([
		{
			user_id: ownerIdFromStored('user-a'),
			metric: 'execute',
			month: '2026-07',
		},
		{
			user_id: ownerIdFromStored('user-a'),
			metric: 'job_run',
			month: '2026-06',
		},
	])
})

test('aggregateUsageRollups chunks stale-row deletes under the bind-parameter cap', async () => {
	using _fetch = fetchReplying(dataReply(aeRow('user-live')), empty)
	const { db, deletes, rollups } = createFakeDb({
		existingRollups: Array.from({ length: 120 }, (_, index) => ({
			user_id: `stale-user-${index}`,
			metric: 'execute',
			month: '2026-07',
		})),
	})

	await expect(aggregate(db)).resolves.toMatchObject({
		upsertedRows: 1,
		deletedRows: 120,
	})
	// 49 pairs per statement: 1 month param + 2 per pair = 99 binds max.
	expect(
		staleDeletes(deletes).map((statement) => statement.params.length),
	).toEqual([99, 99, 45])
	expect(rollups).toEqual([])
})

test('aggregateUsageRollups keeps existing rollups when the Analytics Engine result is empty', async () => {
	// An empty result is more likely ingestion lag or dataset
	// misconfiguration than a real event-free month; the stale-row
	// cleanup must not wipe the month's counters.
	using _fetch = fetchReplying(empty)
	const existingRollups = [
		{
			user_id: ownerIdFromStored('user-a'),
			metric: 'execute',
			month: '2026-07',
		},
		{
			user_id: ownerIdFromStored('user-b'),
			metric: 'job_run',
			month: '2026-07',
		},
	]
	const { db, batches, deletes, rollups } = createFakeDb({
		existingRollups,
		emailUsageRows: [
			emailRow('user-a', { total_duration_ms: 10, total_bytes: 128 }),
		],
	})

	await expect(aggregate(db)).resolves.toEqual({
		skipped: false,
		month: '2026-07',
		upsertedRows: 0,
		deletedRows: 0,
		users: 0,
	})
	expect(staleDeletes(deletes)).toHaveLength(0)
	expect(batches).toHaveLength(0)
	expect(rollups).toEqual(existingRollups)
})

test('aggregateUsageRollups batches large result sets and throws on SQL API errors', async () => {
	const { db, batches } = createFakeDb()
	{
		using _fetch = fetchReplying(
			dataReply(
				...Array.from({ length: 120 }, (_, index) => aeRow(`user-${index}`)),
			),
			empty,
		)
		await expect(aggregate(db)).resolves.toMatchObject({
			upsertedRows: 120,
			users: 120,
		})
		expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20])
	}

	using _fetch = fetchReplying(
		{ status: 400, body: 'query error: unknown table' },
		empty,
	)
	await expect(aggregate(db)).rejects.toThrow(
		'Analytics Engine SQL query failed (400)',
	)
})

test('aggregateUsageRollups surfaces a timed-out Analytics Engine fetch as an error', async () => {
	// AbortSignal.timeout rejects the fetch with a TimeoutError DOMException;
	// it must propagate through the same error path as a failed query.
	using _fetch = stubFetch(
		vi.fn(async () => {
			throw new DOMException('The operation timed out.', 'TimeoutError')
		}),
	)
	const { db, batches } = createFakeDb()

	await expect(aggregate(db)).rejects.toThrow('timed out')
	expect(batches).toHaveLength(0)
})

test('aggregateUsageRollups retries transient Analytics Engine SQL failures and fails closed', async () => {
	const serverError = { status: 500, body: 'Internal server error' }
	{
		using retryThenOk = fetchReplying(serverError, empty)
		const { db, batches } = createFakeDb()
		await expect(aggregate(db)).resolves.toMatchObject({
			skipped: false,
			upsertedRows: 0,
		})
		expect(retryThenOk).toHaveBeenCalledTimes(3)
		expect(batches).toHaveLength(0)
	}
	{
		using persistent500 = fetchReplying(serverError)
		const { db, batches } = createFakeDb()
		await expect(aggregate(db)).rejects.toThrow(
			'Analytics Engine SQL query failed (500)',
		)
		expect(persistent500.mock.calls.length).toBeGreaterThanOrEqual(
			analyticsEngineSqlRetryMaxAttempts,
		)
		expect(batches).toHaveLength(0)
	}

	using clientError = fetchReplying({
		status: 400,
		body: 'query error: unknown table',
	})
	const { db, batches } = createFakeDb()
	await expect(aggregate(db)).rejects.toThrow(
		'Analytics Engine SQL query failed (400)',
	)
	// Both month queries may start in parallel, but neither retries a 400.
	expect(clientError.mock.calls.length).toBeLessThanOrEqual(2)
	expect(batches).toHaveLength(0)
})

const septemberBounds = {
	monthStart: '2026-09-01 00:00:00',
	nextMonthStart: '2026-10-01 00:00:00',
}

test('buildDynamicWorkerInvokeReuseQuery groups hits and misses by surface', () => {
	expect(
		missingFrom(
			buildDynamicWorkerInvokeReuseQuery('kody_usage_events', septemberBounds),
			[
				"blob2 = 'dynamic_worker_invoke'",
				'blob8',
				'AS cache_reuse',
				'AS surface',
				'sum(double1 * _sample_interval) / sum(_sample_interval) AS avg_duration_ms',
				'sum(double4 * _sample_interval) / sum(_sample_interval) AS avg_code_chars',
				'sum(double5 * _sample_interval) / sum(_sample_interval) AS avg_params_chars',
			],
		),
	).toEqual([])
})

test('buildDynamicWorkerReuseRatioQuery compares unique days to invokes and execute', () => {
	expect(
		missingFrom(
			buildDynamicWorkerReuseRatioQuery('kody_usage_events', septemberBounds),
			[
				"blob2 = 'dynamic_worker_day'",
				"blob2 = 'dynamic_worker_invoke'",
				"blob2 = 'execute'",
				"blob8 = 'hit'",
				"blob8 = 'miss'",
				'AS unique_worker_days',
				'AS execute_calls',
			],
		),
	).toEqual([])
})

test('buildMonthToDateAggregateQuery keeps every if() branch a Float so Analytics Engine accepts it', () => {
	const query = buildMonthToDateAggregateQuery(
		'kody_usage_events',
		septemberBounds,
	)
	// Analytics Engine returns HTTP 422 for `if(cond, double3, 1)` (Double vs
	// Integer branches), which fails the whole hourly recompute.
	const integerBranchLines = query
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^\d+,?$/.test(line))
	expect(integerBranchLines).toEqual([])
	expect(query).not.toMatch(/,\s*\d+\s*[,)]/)
	expect(
		missingFrom(query, [
			'AND double3 > 0, double3, 1.0)',
			'1.0),\n\t\t\t0.0\n',
			', 0.0, double3)',
		]),
	).toEqual([])
})

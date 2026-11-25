import { expect, test } from 'vitest'
import {
	buildD1ReplicaReadDataPoint,
	buildD1ReplicaReadTotalsQuery,
	parseD1ReplicaReadColos,
	parseD1ReplicaReadTotals,
	resolveD1ReplicaReadEventsDataset,
} from '#worker/d1-replica-read-events.ts'

test('a point carries outcome classes and the colo only', () => {
	expect(
		buildD1ReplicaReadDataPoint({
			retry: 'read_failed',
			status: 500,
			documentFailed: true,
			colo: 'LHR',
		}),
	).toEqual({ blobs: ['read_failed', '5xx', 'error', 'LHR'], doubles: [1] })
	expect(
		buildD1ReplicaReadDataPoint({ status: 200, documentFailed: false }),
	).toEqual({ blobs: ['none', 'ok', 'ok', ''], doubles: [1] })
})

test('the totals query counts sampled points over a bounded window', () => {
	const query = buildD1ReplicaReadTotalsQuery({
		dataset: resolveD1ReplicaReadEventsDataset({}),
		windowStart: new Date('2026-11-24T23:45:00Z'),
		windowEnd: new Date('2026-11-25T00:00:00Z'),
	})
	expect(query).toContain('FROM kody_d1_replica_read_events\n')
	expect(query).toContain('SUM(_sample_interval) AS replica_reads')
	expect(query).toContain("timestamp >= toDateTime('2026-11-24 23:45:00')")
	expect(query).toContain("timestamp < toDateTime('2026-11-25 00:00:00')")
	expect(
		resolveD1ReplicaReadEventsDataset({ SENTRY_ENVIRONMENT: 'preview' }),
	).toBe('kody_d1_replica_read_events_preview')
})

test('parsing tolerates strings, nulls, and empty results', () => {
	expect(
		parseD1ReplicaReadTotals([
			{ replica_reads: '1200', retries: 30, read_failures: null },
		]),
	).toEqual({
		replicaReads: 1200,
		retries: 30,
		writeRetries: 0,
		readFailures: 0,
		failedResponses: 0,
		document500s: 0,
	})
	expect(parseD1ReplicaReadTotals([]).replicaReads).toBe(0)
	expect(
		parseD1ReplicaReadColos([
			{ colo: 'DFW', retries: '4', failed_responses: 1 },
			{ colo: '', retries: 2, failed_responses: 0 },
		]),
	).toEqual([{ colo: 'DFW', retries: 4, failedResponses: 1 }])
})

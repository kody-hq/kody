import { expect, test } from 'vitest'
import { type RunRecord } from '#worker/run-records/types.ts'
import { formatRunRecord } from './shared.ts'

function run(overrides: Partial<RunRecord>): RunRecord {
	return {
		id: 'run-1',
		surface: 'execute',
		status: 'success',
		name: null,
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-01-01T00:00:00.000Z',
		finishedAt: '2026-01-01T00:00:01.000Z',
		durationMs: 1000,
		errorName: null,
		errorMessage: null,
		errorTriage: null,
		triageNote: null,
		triagedAt: null,
		triagedBy: null,
		startedBy: null,
		metadata: {},
		logCount: 0,
		...overrides,
	}
}

test('runGet adds ranOn to execute runs in the execute response shape', () => {
	expect(formatRunRecord(run({})).metadata.ranOn).toEqual({
		kind: 'cloud',
		id: 'cloud',
		name: 'Kody cloud',
		attempts: [],
		fellBackToCloud: false,
	})
	const executionContext = {
		id: 'ec_box',
		name: 'build-box',
		yours: true,
		attempts: [{ target: 'ec_box', name: 'build-box', outcome: 'ran' }],
		fellBackToCloud: false,
	}
	const formatted = formatRunRecord(run({ metadata: { executionContext } }))
	expect(formatted.metadata).toEqual({
		executionContext,
		ranOn: { kind: 'context', ...executionContext },
	})
	const skipped = {
		id: null,
		name: null,
		attempts: [
			{
				target: 'ec_box',
				name: 'build-box',
				outcome: 'skipped',
				reason: 'no_lan',
			},
		],
		fellBackToCloud: true,
	}
	expect(
		formatRunRecord(run({ metadata: { executionContext: skipped } })).metadata
			.ranOn,
	).toEqual({
		kind: 'cloud',
		id: 'cloud',
		name: 'Kody cloud',
		attempts: skipped.attempts,
		fellBackToCloud: true,
	})
	expect(
		formatRunRecord(run({ surface: 'job', metadata: {} })).metadata,
	).toEqual({})
})

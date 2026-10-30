import { expect, test } from 'vitest'
import { contextRunRecordFromHistory } from './service.ts'
import { type RunHistoryRow } from './session-do.ts'

function row(overrides: Partial<RunHistoryRow>): RunHistoryRow {
	return {
		runId: 'run_1',
		requester: { userId: 'user_1', handle: 'someone' },
		runOrgId: 'org_1',
		dispatchedAt: '2026-01-02T03:04:00.000Z',
		startedAt: '2026-01-02T03:04:01.000Z',
		endedAt: '2026-01-02T03:04:03.000Z',
		durationMs: 2000,
		outcome: 'failed',
		cancelReason: null,
		failureReason: 'credential_unavailable',
		errorSummary: 'Credential "example" is not available here.',
		fallback: { position: 1 },
		...overrides,
	}
}

test('a failed, lost or cancelled context run becomes an error run record with its reason', () => {
	const failed = contextRunRecordFromHistory({
		ecid: 'ec_example',
		name: 'build-box',
		row: row({}),
	})
	expect(failed).toMatchObject({
		id: 'run_1',
		surface: 'execute',
		status: 'error',
		startedAt: '2026-01-02T03:04:01.000Z',
		finishedAt: '2026-01-02T03:04:03.000Z',
		durationMs: 2000,
		errorName: 'ExecutionContextRunFailed',
		errorMessage: 'Credential "example" is not available here.',
		logCount: 0,
		metadata: {
			recordSource: 'execution_context_history',
			executionContext: {
				id: 'ec_example',
				name: 'build-box',
				outcome: 'failed',
				failureReason: 'credential_unavailable',
			},
		},
	})
	expect(
		contextRunRecordFromHistory({
			ecid: 'ec_example',
			name: 'build-box',
			row: row({
				outcome: 'lost',
				failureReason: 'execution_context_lost',
				errorSummary: 'The execution context disconnected.',
			}),
		}),
	).toMatchObject({ status: 'error', errorName: 'ExecutionContextLost' })
	expect(
		contextRunRecordFromHistory({
			ecid: 'ec_example',
			name: 'build-box',
			row: row({
				outcome: 'cancelled',
				cancelReason: 'caller_cancelled',
				failureReason: 'caller_cancelled',
				errorSummary: 'The run was cancelled (caller_cancelled).',
			}),
		}),
	).toMatchObject({
		status: 'error',
		errorName: 'ExecutionContextRunCancelled',
		errorMessage: 'The run was cancelled (caller_cancelled).',
	})
})

test('succeeded and in-flight context runs carry no error', () => {
	expect(
		contextRunRecordFromHistory({
			ecid: 'ec_example',
			name: 'build-box',
			row: row({
				outcome: 'succeeded',
				failureReason: null,
				errorSummary: null,
			}),
		}),
	).toMatchObject({ status: 'success', errorName: null, errorMessage: null })
	expect(
		contextRunRecordFromHistory({
			ecid: 'ec_example',
			name: 'build-box',
			row: row({
				outcome: null,
				endedAt: null,
				durationMs: null,
				failureReason: null,
				errorSummary: null,
			}),
		}),
	).toMatchObject({ status: 'running', errorName: null })
})
